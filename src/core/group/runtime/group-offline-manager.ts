import { ed25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { gzip, gunzip, gzipSync } from 'zlib';
import { promisify } from 'util';
import type { QueryEvent } from '@libp2p/kad-dht';
import type { ChatNode, GroupOfflineGapWarning, MessageReceivedEvent } from '../../types.js';
import type { ChatDatabase, Chat, User } from '../../db/database.js';
import type { EncryptedUserIdentity } from '../../identity/encrypted-user-identity.js';
import {
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  GROUP_MESSAGE_MAX_FUTURE_SKEW_MS,
  GROUP_MAX_MESSAGES_PER_SENDER,
  GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES,
  GROUP_OFFLINE_LOCAL_CACHE_TTL_MS,
  GROUP_OFFLINE_MESSAGE_TTL_MS,
  GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
  GROUP_OFFLINE_STORE_MAX_DECOMPRESSED_BYTES,
  GROUP_ROTATION_GRACE_WINDOW_MS,
  getNetworkModeRuntime,
  GROUP_MISSING_USED_UNTIL_SCAN_EPOCH_CAP,
  OFFLINE_BUCKET_SCAN_PACING_BUDGET_MS,
  OFFLINE_BUCKET_SCAN_PACING_MIN_BUCKET_COUNT,
} from '../../constants.js';
import {
  type GroupContentMessage,
  type GroupInfoVersioned,
  type GroupInfoVersionedMetadata,
  type GroupOfflineSignedPayload,
  type GroupOfflineStore,
  GroupMessageType,
} from '../types.js';
import { isGroupCallHintSystemPayload } from '../../lib/group-call-signaling.js';
import { dispatchEnvelope, isValidCid } from '../../protocol/message-envelope.js';
import type {
  InboundApplicationMessageContext,
  InboundApplicationMessageHandler,
} from '../../protocol/application-message.js';
import { toBase64Url } from '../../utils/miscellaneous.js';
import { errStr, generalErrorHandler } from '../../utils/general-error.js';
import { shuffleAndPaceExecute, shuffleCopy } from '../../lib/bucket-scan-pacing.js';
import { log } from '../../../shared/logger.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface GroupOfflineManagerDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  onMessageReceived: (data: MessageReceivedEvent) => void;
  onApplicationMessage: InboundApplicationMessageHandler;
  onGroupCallHint?: (data: { groupId: string; senderPeerId: string; timestamp: number }) => void | Promise<void>;
  onOfflineInboxCapacityChanged?: (chatId: number) => void;
  // Forces an immediate reconnect when a DHT write hits dead connections.
  // Resolves true if a live DHT path exists afterwards.
  requestReconnect?: () => Promise<boolean>;
}

interface GroupOfflineVersionMeta {
  members: string[];
  senderSeqBoundaries: Record<string, number>;
}

interface CachedVersionMetaEntry {
  value: GroupOfflineVersionMeta;
  cachedAt: number;
}

interface GroupChatCheckResult {
  processed: boolean;
  completed: boolean;
  unreadAdded: number;
  gapWarnings: GroupOfflineGapWarning[];
  // sender-store fetches paced for this chat
  bucketsScanned: number;
  pacingSpreadMs: number;
}

interface EpochSkipDecision {
  skip: boolean;
  reason: string;
}

interface EpochPruneDecision {
  prune: boolean;
  reason: string;
}

export type GroupOfflineCheckMode = 'periodic' | 'nudge';

export interface GroupOfflineCheckOptions {
  mode?: GroupOfflineCheckMode;
  // bucket-store fetches for this call are NOT shuffled/paced even in 'periodic' mode
  immediate?: boolean;
}

export interface GroupOfflineCheckResult {
  checkedChatIds: number[];
  failedChatIds: number[];
  unreadFromChats: Map<number, number>;
  gapWarnings: GroupOfflineGapWarning[];
}

export interface GroupOfflineBucketUsage {
  messageCountUsed: number;
  messageCountLimit: number;
  compressedBytesUsed: number;
  compressedBytesLimit: number;
  fullnessRatio: number;
}

export class GroupOfflineManager {
  private readonly deps: GroupOfflineManagerDeps;
  private readonly networkMode: string;
  private readonly groupOfflineBucketPrefix: string;
  private readonly groupInfoVersionPrefix: string;
  private readonly bucketMutationQueues = new Map<string, Promise<void>>();
  private readonly versionMetaCache = new Map<string, CachedVersionMetaEntry>();
  private readonly groupCheckInFlight = new Map<string, Promise<GroupChatCheckResult>>();
  private offlineCheckRunCounter = 0;

  // Upper bound for a single group offline DHT op (put/get). Without it a stale
  // or slow peer can keep a send stuck on "sending..." until the underlying
  // query gives up on its own (~tens of seconds). A timeout here is not fatal:
  // a connectivity-shaped failure triggers an immediate reconnect + one retry,
  // so fast mode can run tighter than the direct path (a healthy put completes
  // in well under a second) to keep the spinner short. Anonymous (Tor) keeps a
  // larger budget for its higher baseline latency.
  private static readonly DHT_OP_TIMEOUT_FAST_MS = 10_000;
  private static readonly DHT_OP_TIMEOUT_ANONYMOUS_MS = 30_000;

  constructor(deps: GroupOfflineManagerDeps) {
    this.deps = deps;
    const runtime = getNetworkModeRuntime(this.deps.database.getSessionNetworkMode());
    this.networkMode = runtime.mode;
    this.groupOfflineBucketPrefix = runtime.config.dhtNamespaces.groupOffline;
    this.groupInfoVersionPrefix = runtime.config.dhtNamespaces.groupInfoVersion;
  }

  private notifyOfflineInboxCapacityChanged(chatId: number): void {
    this.deps.onOfflineInboxCapacityChanged?.(chatId);
  }

  private notifyGroupInboxCapacityChangedByGroupId(groupId: string): void {
    const chat = this.deps.database.getChatByGroupId(groupId);
    if (chat) {
      this.notifyOfflineInboxCapacityChanged(chat.id);
    }
  }

  getOwnBucketKey(groupId: string, keyVersion: number): string {
    const ownPubKeyBase64url = toBase64Url(this.deps.userIdentity.signingPublicKey);
    return `${this.groupOfflineBucketPrefix}/${groupId}/${keyVersion}/${ownPubKeyBase64url}`;
  }

  getLocalBucketUsage(bucketKey: string): GroupOfflineBucketUsage {
    const local = this.deps.database.getGroupOfflineSentMessages(bucketKey);
    const {
      messages,
    } = this.normalizeStoreMessages(
      this.filterLiveMessages(local.messages),
      bucketKey,
      'Snapshot overflow',
    );

    if (messages.length === 0) {
      return {
        messageCountUsed: 0,
        messageCountLimit: GROUP_MAX_MESSAGES_PER_SENDER,
        compressedBytesUsed: 0,
        compressedBytesLimit: GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
        fullnessRatio: 0,
      };
    }

    const highestSeq = messages.reduce((max, message) => Math.max(max, message.seq), 0);
    const { signedStore } = this.buildSignedStore(messages, bucketKey, local.version, highestSeq);
    const compressedBytesUsed = gzipSync(Buffer.from(JSON.stringify(signedStore), 'utf8')).length;
    const countRatio = messages.length / GROUP_MAX_MESSAGES_PER_SENDER;
    const sizeRatio = compressedBytesUsed / GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES;

    return {
      messageCountUsed: messages.length,
      messageCountLimit: GROUP_MAX_MESSAGES_PER_SENDER,
      compressedBytesUsed,
      compressedBytesLimit: GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
      fullnessRatio: Math.max(countRatio, sizeRatio),
    };
  }

  async storeGroupMessage(message: GroupContentMessage): Promise<void> {
    const bucketKey = this.getOwnBucketKey(message.groupId, message.keyVersion);
    const queuedAt = Date.now();
    const bucketTag = bucketKey.slice(-12);
    log(
      `[GROUP-OFFLINE][STORE][ENQUEUE] group=${message.groupId.slice(0, 8)} keyVersion=${message.keyVersion} ` +
      `msgId=${message.messageId} seq=${message.seq} bucket=*${bucketTag}`,
    );

    await this.withBucketMutationLock(bucketKey, async () => {
      const lockAcquiredAt = Date.now();
      const lockWaitMs = lockAcquiredAt - queuedAt;
      if (lockWaitMs > 2000) {
        console.warn(
          `[GROUP-OFFLINE][STORE][LOCK_WAIT_SLOW] group=${message.groupId.slice(0, 8)} ` +
          `msgId=${message.messageId} bucket=*${bucketTag} lockWaitMs=${lockWaitMs}`,
        );
      } else {
        log(
          `[GROUP-OFFLINE][STORE][LOCK_ACQUIRED] group=${message.groupId.slice(0, 8)} ` +
          `msgId=${message.messageId} bucket=*${bucketTag} lockWaitMs=${lockWaitMs}`,
        );
      }

      try {
        const local = this.deps.database.getGroupOfflineSentMessages(bucketKey);
        const {
          messages: normalizedExistingMessages,
          trimmedCount: localTrimmedCount,
        } = this.normalizeStoreMessages(
          this.filterLiveMessages(local.messages),
          bucketKey,
          'Local mirror overflow',
        );

        const offlineMessageId = message.messageId;
        if (normalizedExistingMessages.some(m => m.messageId === offlineMessageId)) {
          if (localTrimmedCount > 0) {
            const { signedStore, version } = this.buildSignedStore(
              normalizedExistingMessages,
              bucketKey,
              local.version,
              message.seq,
            );
            await this.putStore(bucketKey, signedStore);
            this.deps.database.saveGroupOfflineSentMessages(bucketKey, normalizedExistingMessages, version);
            this.notifyGroupInboxCapacityChangedByGroupId(message.groupId);
          }
          return;
        }

        const { messages: nextMessages } = this.normalizeStoreMessages(
          [...normalizedExistingMessages, message],
          bucketKey,
          'Bucket overflow',
        );
        const { signedStore, version } = this.buildSignedStore(
          nextMessages,
          bucketKey,
          local.version,
          message.seq,
        );

        try {
          await this.putStore(bucketKey, signedStore);
          this.deps.database.saveGroupOfflineSentMessages(bucketKey, nextMessages, version);
          this.notifyGroupInboxCapacityChangedByGroupId(message.groupId);
          return;
        } catch (firstError: unknown) {
          // Oversized stores cannot be recovered via remote merge.
          if (this.isStoreTooLargeError(firstError)) {
            throw firstError;
          }

          // Connectivity failure: a recovery DHT read would run over the same
          // dead connections and just burn another timeout. Instead, force a
          // reconnect to get fresh peers and retry the write once. The first
          // failure already proved zero peers stored it, so re-putting the same
          // store is safe.
          if (this.isConnectivityFailureError(firstError)) {
            const reconnected = await this.triggerReconnect();
            if (!reconnected) {
              throw firstError;
            }
            await this.putStore(bucketKey, signedStore);
            this.deps.database.saveGroupOfflineSentMessages(bucketKey, nextMessages, version);
            this.notifyGroupInboxCapacityChangedByGroupId(message.groupId);
            return;
          }

          // Recovery path: local version may be stale (restart/cleanup race). Fetch once, merge, retry once.
          const remote = await this.getLatestStore(bucketKey);
          if (!remote) {
            // No remote state discovered -> likely connectivity issue; preserve original error.
            throw firstError;
          }

          const remoteMessages = this.filterLiveMessages(remote.messages);
          const mergedById = new Map<string, GroupContentMessage>();

          for (const msg of remoteMessages) {
            mergedById.set(msg.messageId, msg);
          }
          for (const msg of normalizedExistingMessages) {
            mergedById.set(msg.messageId, msg);
          }
          mergedById.set(offlineMessageId, message);

          const { messages: mergedMessages } = this.normalizeStoreMessages(
            Array.from(mergedById.values()),
            bucketKey,
            'Bucket overflow',
            false,
          );
          const { signedStore: mergedStore, version: mergedVersion } = this.buildSignedStore(
            mergedMessages,
            bucketKey,
            remote.version,
            message.seq,
            remote.highestSeq,
          );
          await this.putStore(bucketKey, mergedStore);
          this.deps.database.saveGroupOfflineSentMessages(bucketKey, mergedMessages, mergedVersion);
          this.notifyGroupInboxCapacityChangedByGroupId(message.groupId);
        }
      } finally {
        const lockHeldMs = Date.now() - lockAcquiredAt;
        if (lockHeldMs > 5000) {
          console.warn(
            `[GROUP-OFFLINE][STORE][LOCK_HELD_SLOW] group=${message.groupId.slice(0, 8)} ` +
            `msgId=${message.messageId} bucket=*${bucketTag} lockHeldMs=${lockHeldMs}`,
          );
        } else {
          log(
            `[GROUP-OFFLINE][STORE][DONE] group=${message.groupId.slice(0, 8)} ` +
            `msgId=${message.messageId} bucket=*${bucketTag} lockHeldMs=${lockHeldMs}`,
          );
        }
      }
    });
  }

  resolveRecentlyActiveGroupChats(sinceMs: number, limit: number): Chat[] {
    return this.deps.database.getRecentlyActiveGroupChats(sinceMs, limit);
  }

  async checkGroupOfflineMessages(chatIds?: number[], options?: GroupOfflineCheckOptions): Promise<GroupOfflineCheckResult> {
    const mode: GroupOfflineCheckMode = options?.mode ?? 'periodic';
    const immediate = options?.immediate === true;
    // bucket-scan pacing only applies to the non-latency-sensitive
    // 'periodic' path (background backstop sweep, reconnect/wake sync)
    const shouldPace = mode === 'periodic' && !immediate;
    const runId = ++this.offlineCheckRunCounter;
    const runStart = Date.now();
    this.pruneLocalCaches();

    const unreadFromChats = new Map<number, number>();
    const gapWarnings: GroupOfflineGapWarning[] = [];
    const checkedChatIds: number[] = [];
    const failedChatIds: number[] = [];
    const resolvedChats = this.resolveTargetChats(chatIds);
    // multi-chat sweep otherwise always visits chats in the same fixed recency order
    const targetChats = shouldPace ? shuffleCopy(resolvedChats) : resolvedChats;
    log(
      `[GROUP-OFFLINE][TIMING][RUN:${runId}] start targetChats=${targetChats.length} ` +
      `chatIds=${targetChats.map((c) => c.id).join(',') || 'none'} mode=${mode} paced=${shouldPace}`
    );

    const checks = await this.runTargetChatChecksWithConcurrency(targetChats, mode, shouldPace, 3);
    let totalBucketsScanned = 0;
    let maxPacingSpreadMs = 0;
    for (const { chat, result, tookMs } of checks) {
      const processed = result.processed;

      if (result.unreadAdded > 0) {
        const prev = unreadFromChats.get(chat.id) ?? 0;
        unreadFromChats.set(chat.id, prev + result.unreadAdded);
      }
      if (result.gapWarnings.length > 0) {
        gapWarnings.push(...result.gapWarnings);
      }
      totalBucketsScanned += result.bucketsScanned;
      maxPacingSpreadMs = Math.max(maxPacingSpreadMs, result.pacingSpreadMs);

      log(
        `[GROUP-OFFLINE][TIMING][RUN:${runId}] chat=${chat.id} processed=${processed} ` +
        `unreadAdded=${result.unreadAdded} took=${tookMs}ms`
      );
      if (processed) {
        checkedChatIds.push(chat.id);
      }
      if (!result.completed) {
        failedChatIds.push(chat.id);
      }
      if (chat.group_status === 'removed' && result.completed) {
        this.deps.database.markRemovedCatchupCompleted(chat.id);
      }
    }

    const totalUnread = Array.from(unreadFromChats.values()).reduce((sum, count) => sum + count, 0);
    log(
      `[GROUP-OFFLINE][TIMING][RUN:${runId}] done checkedChats=${checkedChatIds.length} ` +
      `totalUnread=${totalUnread} gaps=${gapWarnings.length} took=${Date.now() - runStart}ms`
    );
    // measurable recovery-delay cost of the bucket-scan pacing for this sweep
    log(
      `[GROUP-OFFLINE][BUCKET-SCAN][PACING][RUN:${runId}] mode=${mode} paced=${shouldPace} ` +
      `buckets=${totalBucketsScanned} maxSpreadMs=${maxPacingSpreadMs}`
    );

    return {
      checkedChatIds,
      failedChatIds,
      unreadFromChats,
      gapWarnings,
    };
  }

  private async runTargetChatChecksWithConcurrency(
    chats: Chat[],
    mode: GroupOfflineCheckMode,
    shouldPace: boolean,
    concurrency: number,
  ): Promise<Array<{ chat: Chat; result: GroupChatCheckResult; tookMs: number }>> {
    if (chats.length === 0) return [];

    const workerCount = Math.min(Math.max(1, concurrency), chats.length);
    const results = new Array<{ chat: Chat; result: GroupChatCheckResult; tookMs: number }>(chats.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const current = nextIndex++;
        if (current >= chats.length) return;

        const chat = chats[current];
        if (!chat) continue;
        const startedAt = Date.now();
        try {
          const result = await this.runGroupCheckWithSingleFlight(chat, mode, shouldPace);
          results[current] = { chat, result, tookMs: Date.now() - startedAt };
        } catch (error: unknown) {
          generalErrorHandler(
            error,
            `[GROUP-OFFLINE] Chat check failed chatId=${chat.id} group=${chat.group_id?.slice(0, 8) ?? 'n/a'} mode=${mode}`,
          );
          results[current] = {
            chat,
            result: { processed: false, completed: false, unreadAdded: 0, gapWarnings: [], bucketsScanned: 0, pacingSpreadMs: 0 },
            tookMs: Date.now() - startedAt,
          };
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  private resolveTargetChats(chatIds?: number[]): Chat[] {
    const allowRemovedForExplicitChecks = !!chatIds && chatIds.length > 0;
    const groups = this.deps.database.getAllGroupChats(CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES * 5)
      .filter(c =>
        c.type === 'group'
        && !!c.group_id
        && (
          c.group_status === 'active'
          || c.group_status === 'rekeying'
          || (c.group_status === 'removed' && (allowRemovedForExplicitChecks || c.needs_removed_catchup))
        )
        && (c.key_version ?? 0) > 0,
      );

    if (!chatIds || chatIds.length === 0) {
      return groups
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .slice(0, CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES);
    }

    const wanted = new Set(chatIds);
    return groups.filter(c => wanted.has(c.id));
  }

  private async runGroupCheckWithSingleFlight(chat: Chat, mode: GroupOfflineCheckMode, shouldPace: boolean): Promise<GroupChatCheckResult> {
    if (!chat.group_id) {
      return { processed: false, completed: false, unreadAdded: 0, gapWarnings: [], bucketsScanned: 0, pacingSpreadMs: 0 };
    }

    const inFlightKey = `${chat.group_id}:${mode}:${shouldPace}`;
    const existing = this.groupCheckInFlight.get(inFlightKey);
    if (existing) {
      log(
        `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] reusing in-flight check for group=${chat.group_id.slice(0, 8)} mode=${mode}`
      );
      return existing;
    }

    const checkPromise = this.checkGroupChat(chat, mode, shouldPace)
      .finally(() => {
        if (this.groupCheckInFlight.get(inFlightKey) === checkPromise) {
          this.groupCheckInFlight.delete(inFlightKey);
        }
      });

    this.groupCheckInFlight.set(inFlightKey, checkPromise);
    return checkPromise;
  }

  private async checkGroupChat(
    chat: Chat,
    mode: GroupOfflineCheckMode,
    shouldPace: boolean,
  ): Promise<GroupChatCheckResult> {
    if (!chat.group_id) return { processed: false, completed: false, unreadAdded: 0, gapWarnings: [], bucketsScanned: 0, pacingSpreadMs: 0 };
    const chatStart = Date.now();

    let sawAnyStore = false;
    let epochsProcessed = 0;
    let unreadAdded = 0;
    let bucketsScanned = 0;
    let pacingSpreadMs = 0;
    const gapWarnings: GroupOfflineGapWarning[] = [];
    const history = this.deps.database.getGroupKeyHistory(chat.group_id)
      .filter(h => h.key_version <= (chat.key_version ?? 0))
      .sort((a, b) => a.key_version - b.key_version);
    const scopedHistory = this.selectHistoryForMode(history, chat.key_version ?? 0, mode);
    // Epochs are scanned sequentially below, so a fresh OFFLINE_BUCKET_SCAN_PACING_BUDGET_MS
    // budget per epoch would stack additively (10 eligible epochs could add
    // ~5 minutes). Share one deadline across the whole chat scan instead: each
    // epoch's pacing call gets whatever budget remains, so the total added
    // spread for this chat never exceeds OFFLINE_BUCKET_SCAN_PACING_BUDGET_MS
    // regardless of how many epochs it has to catch up.
    const pacingDeadline = chatStart + OFFLINE_BUCKET_SCAN_PACING_BUDGET_MS;

    for (const epoch of scopedHistory) {
      epochsProcessed++;
      const metaKeyVersion = this.resolveEpochBoundaryMetaVersion(chat, epoch.key_version);
      const versionMeta = await this.getEpochBoundaryMeta(chat, epoch.key_version, metaKeyVersion);
      const skipDecision = this.evaluateEpochSkipDecision(chat, epoch, versionMeta);
      // this is duplicated below, but I'll keep it since I want more aggresive pruning
      if (this.canEpochBePrunedWithoutMeta(chat, epoch)) {
        const pruneDecision = this.evaluateEpochPruneDecision(chat, epoch, versionMeta);
        if (pruneDecision.prune) {
          this.pruneEpochState(chat, epoch, pruneDecision.reason);
          continue;
        }
      }
      if (skipDecision.skip) {
        log(`[GROUP-OFFLINE][SKIP_EPOCH][CHAT:${chat.id}] epoch=${epoch.key_version} reason=${skipDecision.reason}`);
        continue;
      }
      log(`[GROUP-OFFLINE][CHAT:${chat.id}] epoch=${epoch.key_version} scanning`);

      const keyBase64 = this.deps.database.getGroupKeyForEpoch(chat.group_id, epoch.key_version);
      if (!keyBase64) continue;

      const keyBytes = Buffer.from(keyBase64, 'base64');
      if (keyBytes.length !== 32) continue;

      const roster = this.getEpochSenderPeerIds(chat, epoch.key_version, versionMeta);

      const senderDescriptors = roster
        .map((senderPeerId) => {
          const sender = this.deps.database.getUserByPeerId(senderPeerId);
          if (!sender) return null;
          const senderPubKeyBase64url = toBase64Url(Buffer.from(sender.signing_public_key, 'base64'));
          const bucketKey = `${this.groupOfflineBucketPrefix}/${chat.group_id}/${epoch.key_version}/${senderPubKeyBase64url}`;
          return { senderPeerId, sender, bucketKey };
        })
        .filter(item => item !== null)

      const fetchStore = async (desc: typeof senderDescriptors[number]) => ({
        ...desc,
        store: await this.getLatestStore(desc.bucketKey),
      });

      let senderStores: Array<Awaited<ReturnType<typeof fetchStore>>>;
      if (shouldPace) {
        const remainingBudgetMs = Math.max(0, pacingDeadline - Date.now());
        const paced = await shuffleAndPaceExecute(senderDescriptors, fetchStore, {
          totalBudgetMs: remainingBudgetMs,
          minCount: OFFLINE_BUCKET_SCAN_PACING_MIN_BUCKET_COUNT,
        });
        senderStores = paced.results;
        bucketsScanned += paced.bucketCount;
        pacingSpreadMs = Math.max(pacingSpreadMs, paced.totalSpreadMs);
      } else {
        senderStores = await Promise.all(senderDescriptors.map(fetchStore));
        bucketsScanned += senderDescriptors.length;
      }

      for (const { senderPeerId, sender, store } of senderStores) {
        if (!store || store.messages.length === 0) continue;

        sawAnyStore = true;
        const orderedMessages = [...store.messages]
          .sort((a, b) => (a.seq - b.seq) || (a.timestamp - b.timestamp));

        const cursor = this.deps.database.getGroupOfflineCursor(chat.group_id, epoch.key_version, senderPeerId);
        let lastReadTs = cursor?.last_read_timestamp ?? 0;
        let lastReadMessageId = cursor?.last_read_message_id ?? '';
        let highestSeenSeq = this.deps.database.getMemberSeq(chat.group_id, epoch.key_version, senderPeerId);
        const closedEpochSeqCeiling = highestSeenSeq;
        const senderBoundary = versionMeta?.senderSeqBoundaries?.[senderPeerId];
        let deliveredForSender = 0;
        let skippedSeen = 0;
        let skippedInvalidSignature = 0;
        let skippedByBoundary = 0;
        let skippedClosedEpochNoBoundary = 0;
        let repairedLate = 0;

        for (const msg of orderedMessages) {
          const messageId = msg.messageId;
          // Offline parse gate (this path doesn't go through isGroupChatMessage):
          // messageId becomes the indexed client_msg_id / row PK / dedup key, so a
          // malformed one is dropped — it can't be substituted.
          if (!isValidCid(messageId)) {
            console.warn(
              `[GROUP-OFFLINE][DROP] chat=${chat.id} epoch=${epoch.key_version} sender=${senderPeerId.slice(-8)} reason=invalid_message_id`,
            );
            continue;
          }
          if (msg.groupId !== chat.group_id || msg.keyVersion !== epoch.key_version) continue;
          if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) {
            console.warn(
              `[GROUP-OFFLINE][DROP] chat=${chat.id} epoch=${epoch.key_version} sender=${senderPeerId.slice(-8)} ` +
              `msgId=${messageId} reason=invalid_timestamp ts=${String(msg.timestamp)}`,
            );
            continue;
          }
          if (msg.timestamp > Date.now() + GROUP_MESSAGE_MAX_FUTURE_SKEW_MS) {
            console.warn(
              `[GROUP-OFFLINE][DROP] chat=${chat.id} epoch=${epoch.key_version} sender=${senderPeerId.slice(-8)} ` +
              `msgId=${messageId} reason=timestamp_too_far_future ts=${msg.timestamp}`,
            );
            continue;
          }
          if (
            epoch.used_until !== null
            && msg.timestamp > epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS
          ) {
            continue;
          }

          if (senderBoundary !== undefined) {
            if (msg.seq > senderBoundary) {
              skippedByBoundary++;
              continue;
            }
          } else if (epoch.used_until !== null && msg.seq > closedEpochSeqCeiling) {
            // Closed epochs without authoritative sender boundaries fail closed here;
            // roster enumeration and DHT validation remain defense-in-depth.
            skippedClosedEpochNoBoundary++;
            continue;
          }

          if (!this.verifyOfflineMessageSignature(msg, sender.signing_public_key)) {
            skippedInvalidSignature++;
            continue;
          }

          const alreadyPersisted = this.deps.database.messageExistsInChat(chat.id, messageId);

          if (msg.seq <= highestSeenSeq) {
            if (alreadyPersisted) {
              ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));
              skippedSeen++;
              continue;
            }

            // Late-gap repair: this seq is <= highestSeenSeq, but the message payload is missing locally.
            // Persist the missing message, but do NOT change highestSeenSeq.
            try {
              const content = this.decryptContent(msg.encryptedContent, keyBytes, msg.nonce);
              const wasHiddenSystemMessage = await this.handleHiddenSystemMessage({
                chatId: chat.id,
                senderPeerId,
                timestamp: msg.timestamp,
                content,
              });
              if (wasHiddenSystemMessage) {
                ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));
                repairedLate++;
                continue;
              }
              const inserted = await this.persistIncomingGroupContent({
                chat,
                sender,
                message: msg,
                content,
              });
              // Cursor advances regardless; counters/event only when a row was added.
              ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));
              if (inserted) {
                unreadAdded++;
                deliveredForSender++;
                repairedLate++;
              }
            } catch (error: unknown) {
              console.warn(
                `[GROUP-OFFLINE][ANOMALY][CHAT:${chat.id}] epoch=${epoch.key_version} sender=${senderPeerId.slice(-8)} ` +
                `msgId=${messageId} seq=${msg.seq} highestSeenSeq=${highestSeenSeq} reason=seen_seq_but_message_missing`
              );
              generalErrorHandler(error, `[GROUP-OFFLINE] Failed late-gap repair for message ${messageId}`);
            }
            continue;
          }

          const expectedSeq = highestSeenSeq + 1;
          let shouldWarnForGap = msg.seq > expectedSeq && msg.messageType !== 'system';
          if (shouldWarnForGap) {
            try {
              const gapContent = this.decryptContent(msg.encryptedContent, keyBytes, msg.nonce);
              shouldWarnForGap = !isGroupCallHintSystemPayload(this.parseHiddenSystemPayload(gapContent));
            } catch {
              shouldWarnForGap = true;
            }
          }
          if (shouldWarnForGap) {
            gapWarnings.push({
              chatId: chat.id,
              groupId: chat.group_id,
              keyVersion: epoch.key_version,
              senderPeerId,
              expectedSeq,
              actualSeq: msg.seq,
            });
          }

          try {
            if (!alreadyPersisted) {
              const content = this.decryptContent(msg.encryptedContent, keyBytes, msg.nonce);
              const wasHiddenSystemMessage = await this.handleHiddenSystemMessage({
                chatId: chat.id,
                senderPeerId,
                timestamp: msg.timestamp,
                content,
              });
              if (wasHiddenSystemMessage) {
                highestSeenSeq = msg.seq;
                ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));
                continue;
              }
              const inserted = await this.persistIncomingGroupContent({
                chat,
                sender,
                message: msg,
                content,
              });

              // Counters/event only when a row was actually added (a concurrent gossip
              // delivery may have inserted it first); seq/cursor advance below regardless.
              if (inserted) {
                unreadAdded++;
                deliveredForSender++;
              }
            }

            highestSeenSeq = msg.seq;
            this.deps.database.updateMemberSeq(chat.group_id, epoch.key_version, senderPeerId, msg.seq);
            ({ lastReadTs, lastReadMessageId } = this.advanceCursor(lastReadTs, lastReadMessageId, msg));
          } catch (error: unknown) {
            console.error(
              `[GROUP-OFFLINE][ANOMALY][CHAT:${chat.id}] epoch=${epoch.key_version} sender=${senderPeerId.slice(-8)} ` +
              `msgId=${messageId} seq=${msg.seq} reason=persist_failed_after_seq_advance`
            );
            generalErrorHandler(error, `[GROUP-OFFLINE] Failed to process message ${messageId}`);
          }
        }

        this.deps.database.upsertGroupOfflineCursor(
          chat.group_id,
          epoch.key_version,
          senderPeerId,
          lastReadTs,
          lastReadMessageId,
        );
        log(
          `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] epoch=${epoch.key_version} sender=${sender.username} ` +
          `bucketMessages=${orderedMessages.length} delivered=${deliveredForSender} skippedSeen=${skippedSeen} ` +
          `repairedLate=${repairedLate} skippedBoundary=${skippedByBoundary} ` +
          `skippedClosedEpochNoBoundary=${skippedClosedEpochNoBoundary} skippedSig=${skippedInvalidSignature} `
        );
      }

      log(
        `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] epoch=${epoch.key_version} ` +
        `senderBuckets=${senderStores.length} `
      );

      if (this.canEpochBePrunedWithoutMeta(chat, epoch)) {
        const pruneDecision = this.evaluateEpochPruneDecision(chat, epoch, versionMeta);
        if (pruneDecision.prune) {
          this.pruneEpochState(chat, epoch, pruneDecision.reason);
        }
      }
    }

    log(
      `[GROUP-OFFLINE][TIMING][CHAT:${chat.id}] done epochs=${epochsProcessed} ` +
      `sawAnyStore=${sawAnyStore} totalMs=${Date.now() - chatStart}ms`
    );
    log(
      `[GROUP-OFFLINE][BUCKET-SCAN][PACING][CHAT:${chat.id}] paced=${shouldPace} ` +
      `buckets=${bucketsScanned} spreadMs=${pacingSpreadMs}`
    );

    return {
      processed: sawAnyStore,
      completed: true,
      unreadAdded,
      gapWarnings,
      bucketsScanned,
      pacingSpreadMs,
    };
  }

  private async persistIncomingGroupContent(input: {
    chat: Chat;
    sender: User;
    message: GroupContentMessage;
    content: string;
  }): Promise<boolean> {
    const { chat, sender, message, content } = input;
    if (message.messageType === 'system') {
      const { inserted } = await this.deps.database.tryCreateMessage({
        id: message.messageId,
        chat_id: chat.id,
        sender_peer_id: message.senderPeerId,
        content,
        message_type: 'system',
        timestamp: new Date(message.timestamp),
        client_msg_id: message.messageId,
        reply_to_client_id: null,
      }, { dedupe: 'any' });
      if (inserted) {
        this.deps.onMessageReceived({
          chatId: chat.id,
          messageId: message.messageId,
          content,
          senderPeerId: message.senderPeerId,
          senderUsername: sender.username,
          timestamp: message.timestamp,
          messageSentStatus: 'offline',
          messageType: 'system',
          clientMsgId: message.messageId,
        });
      }
      return inserted;
    }

    const routeNonText = (
      applicationMessage: InboundApplicationMessageContext['message'],
    ): boolean | Promise<boolean> => this.deps.onApplicationMessage({
      message: applicationMessage,
      chatId: chat.id,
      senderPeerId: message.senderPeerId,
      senderUsername: sender.username,
      timestamp: message.timestamp,
      transportMessageId: message.messageId,
      route: 'group_offline',
    });
    const dispatched = await dispatchEnvelope(content, {
      text: async ({ payload }) => {
        const { inserted } = await this.deps.database.tryCreateMessage({
          id: message.messageId,
          chat_id: chat.id,
          sender_peer_id: message.senderPeerId,
          content: payload.text,
          message_type: 'text',
          timestamp: new Date(message.timestamp),
          client_msg_id: message.messageId,
          reply_to_client_id: payload.reply_to ?? null,
        }, { dedupe: 'any' });
        if (inserted) {
          this.deps.onMessageReceived({
            chatId: chat.id,
            messageId: message.messageId,
            content: payload.text,
            senderPeerId: message.senderPeerId,
            senderUsername: sender.username,
            timestamp: message.timestamp,
            messageSentStatus: 'offline',
            messageType: 'text',
            clientMsgId: message.messageId,
            replyToClientId: payload.reply_to,
          });
        }
        return inserted;
      },
      file_offer: routeNonText,
      file_offer_cancel: routeNonText,
      file_offer_nack: routeNonText,
    }, { expectedCid: message.messageId });

    // TEMP_LOG: temporary group offline application-message dispatch diagnostics; remove after Phase 2a delivery debugging.
    log(
      `[TEMP_LOG][APP-MESSAGE][GROUP-OFFLINE][DISPATCH] group=${message.groupId.slice(0, 8)} `
      + `msgId=${message.messageId} sender=${message.senderPeerId.slice(-8)} status=${dispatched.status} `
      + `value=${dispatched.status === 'handled' ? String(dispatched.value) : 'n/a'}`
      + `${dispatched.status === 'unhandled' ? ` kind=${dispatched.message.kind}` : ''}`
      + `${dispatched.status === 'rejected' ? ` reason=${dispatched.reason}` : ''}`,
    );

    if (dispatched.status === 'handled') {
      return dispatched.value;
    }
    if (dispatched.status === 'rejected') {
      log(
        `[APP-MESSAGE][GROUP-OFFLINE][DROP] group=${message.groupId.slice(0, 8)} ` +
        `msgId=${message.messageId} reason=${dispatched.reason}`,
      );
    } else {
      log(
        `[APP-MESSAGE][GROUP-OFFLINE][DROP] group=${message.groupId.slice(0, 8)} ` +
        `msgId=${message.messageId} reason=unhandled_kind kind=${dispatched.message.kind}`,
      );
    }
    return false;
  }

  private async handleHiddenSystemMessage(input: {
    chatId: number;
    senderPeerId: string;
    timestamp: number;
    content: string;
  }): Promise<boolean> {
    const parsed = this.parseHiddenSystemPayload(input.content);
    if (!isGroupCallHintSystemPayload(parsed)) {
      return false;
    }

    try {
      await this.deps.onGroupCallHint?.({
        groupId: parsed.groupId,
        senderPeerId: input.senderPeerId,
        timestamp: input.timestamp,
      });
    } catch (error: unknown) {
      console.warn(
        `[GROUP-OFFLINE][SYSTEM][GROUP_CALL_HINT][WARN] group=${parsed.groupId.slice(0, 8)} sender=${input.senderPeerId.slice(-8)} reason=${errStr(error)}`,
      );
    }
    log(
      `[GROUP-OFFLINE][SYSTEM][GROUP_CALL_HINT] chat=${input.chatId} group=${parsed.groupId.slice(0, 8)} sender=${input.senderPeerId.slice(-8)}`,
    );
    return true;
  }

  private parseHiddenSystemPayload(content: string): unknown {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private selectHistoryForMode(
    history: Array<{ key_version: number; used_until: number | null }>,
    currentKeyVersion: number,
    mode: GroupOfflineCheckMode,
  ): Array<{ key_version: number; used_until: number | null }> {
    if (mode !== 'nudge') return history;
    if (history.length === 0) return history;

    const selected = new Set<number>();
    const currentEpoch = history.find((epoch) => epoch.key_version === currentKeyVersion) ?? history[history.length - 1];
    if (currentEpoch) {
      selected.add(currentEpoch.key_version);
    }

    const previousEpoch = [...history]
      .reverse()
      .find((epoch) => epoch.key_version < (currentEpoch?.key_version ?? currentKeyVersion));
    if (previousEpoch && this.isEpochEligibleForNudge(previousEpoch)) {
      selected.add(previousEpoch.key_version);
    }

    return history.filter((epoch) => selected.has(epoch.key_version));
  }

  private isEpochEligibleForNudge(epoch: { key_version: number; used_until: number | null }): boolean {
    if (epoch.used_until === null) return true;
    return Date.now() < epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS;
  }

  private async getVersionMeta(chat: Chat, keyVersion: number): Promise<GroupOfflineVersionMeta | null> {
    if (!chat.group_id || !chat.group_creator_peer_id) return null;

    const cacheKey = `${chat.group_id}:${keyVersion}`;
    const cached = this.versionMetaCache.get(cacheKey);
    if (cached) {
      return cached.value;
    }

    let creatorPubBytes: Uint8Array | null = null;
    if (chat.group_creator_peer_id === this.deps.myPeerId) {
      creatorPubBytes = this.deps.userIdentity.signingPublicKey;
    } else {
      const creator = this.deps.database.getUserByPeerId(chat.group_creator_peer_id);
      if (creator) {
        creatorPubBytes = Buffer.from(creator.signing_public_key, 'base64');
      }
    }
    if (!creatorPubBytes) return null;
    const metadataKeyBase64 = this.deps.database.getGroupInfoMetadataKeyForEpoch(chat.group_id, keyVersion);
    if (!metadataKeyBase64) {
      log(
        `[GROUP-OFFLINE][TIMING][META] group=${chat.group_id.slice(0, 8)} keyVersion=${keyVersion} ` +
        `hasMeta=false reason=missing_local_metadata_key`
      );
      return null;
    }
    const metadataKeyBytes = Buffer.from(metadataKeyBase64, 'base64');
    if (metadataKeyBytes.length !== 32) {
      log(
        `[GROUP-OFFLINE][TIMING][META] group=${chat.group_id.slice(0, 8)} keyVersion=${keyVersion} ` +
        `hasMeta=false reason=invalid_local_metadata_key`
      );
      return null;
    }

    const creatorPubKeyBase64url = toBase64Url(creatorPubBytes);
    const dhtKey = `${this.groupInfoVersionPrefix}/${chat.group_id}/${creatorPubKeyBase64url}/${keyVersion}`;
    const keyBytes = new TextEncoder().encode(dhtKey);

    let decryptedMeta: GroupOfflineVersionMeta | null = null;

    try {
      for await (const event of this.deps.node.services.dht.get(keyBytes) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || event.value.length === 0) continue;
        try {
          const candidate = JSON.parse(new TextDecoder().decode(event.value)) as GroupInfoVersioned;
          if (candidate.groupId !== chat.group_id || candidate.version !== keyVersion) continue;
          if (!this.verifyGroupInfoVersionSignature(candidate, creatorPubBytes)) continue;
          const decrypted = this.decryptGroupInfoVersionedMetadata(candidate, metadataKeyBytes);
          if (!decrypted) continue;
          decryptedMeta = decrypted;
          break;
        } catch {
          continue;
        }
      }
    } catch {
      log(
        `[GROUP-OFFLINE][TIMING][META] group=${chat.group_id.slice(0, 8)} keyVersion=${keyVersion} ` +
        `hasMeta=false reason=dht_get_failed`
      );
      return null;
    }

    if (!decryptedMeta) {
      log(
        `[GROUP-OFFLINE][TIMING][META] group=${chat.group_id.slice(0, 8)} keyVersion=${keyVersion} ` +
        `hasMeta=false reason=no_valid_decryptable_record`
      );
      return null;
    }
    const value = decryptedMeta;
    this.versionMetaCache.set(cacheKey, { value, cachedAt: Date.now() });
    log(
      `[GROUP-OFFLINE][TIMING][META] group=${chat.group_id.slice(0, 8)} keyVersion=${keyVersion} ` +
      `hasMeta=true members=${value.members.length} boundaries=${Object.keys(value.senderSeqBoundaries).length}`
    );
    this.pruneLocalCaches();
    return value;
  }

  private verifyGroupInfoVersionSignature(record: GroupInfoVersioned, creatorPubKey: Uint8Array): boolean {
    try {
      const { creatorSignature, ...payload } = record;
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes = Buffer.from(creatorSignature, 'base64');
      return ed25519.verify(sigBytes, payloadBytes, creatorPubKey);
    } catch {
      return false;
    }
  }

  private decryptGroupInfoVersionedMetadata(
    record: GroupInfoVersioned,
    metadataKey: Uint8Array,
  ): GroupOfflineVersionMeta | null {
    try {
      const nonce = Buffer.from(record.encryptedMetadataNonce, 'base64');
      if (nonce.length !== 24) return null;
      const encrypted = Buffer.from(record.encryptedMetadata, 'base64');
      const cipher = xchacha20poly1305(metadataKey, nonce);
      const decrypted = cipher.decrypt(encrypted);
      const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as GroupInfoVersionedMetadata;
      if (!Array.isArray(parsed.members)) return null;
      if (!parsed.senderSeqBoundaries || typeof parsed.senderSeqBoundaries !== 'object') return null;
      const members = parsed.members.filter((peerId): peerId is string => typeof peerId === 'string');
      const senderSeqBoundaries: Record<string, number> = {};
      for (const [peerId, value] of Object.entries(parsed.senderSeqBoundaries)) {
        if (typeof peerId !== 'string') continue;
        if (!Number.isFinite(value)) continue;
        senderSeqBoundaries[peerId] = Math.max(0, Math.floor(value));
      }
      return { members, senderSeqBoundaries };
    } catch {
      return null;
    }
  }

  private normalizeStoreMessages(
    messages: GroupContentMessage[],
    bucketKey: string,
    overflowLabel: string,
    logOverflow = true,
  ): { messages: GroupContentMessage[]; trimmedCount: number } {
    const sortedMessages = [...messages]
      .sort((a, b) => (a.seq - b.seq) || (a.timestamp - b.timestamp));

    if (sortedMessages.length <= GROUP_MAX_MESSAGES_PER_SENDER) {
      return { messages: sortedMessages, trimmedCount: 0 };
    }

    const overflow = sortedMessages.length - GROUP_MAX_MESSAGES_PER_SENDER;
    const trimmedMessages = sortedMessages.slice(overflow);
    if (logOverflow) {
      console.warn(
        `[GROUP-OFFLINE] ${overflowLabel} trimmed ${overflow} oldest message(s) for ${bucketKey.slice(0, 48)}...`,
      );
    }
    return { messages: trimmedMessages, trimmedCount: overflow };
  }

  private buildSignedStore(
    messages: GroupContentMessage[],
    bucketKey: string,
    baseVersion: number,
    fallbackSeq: number,
    minimumHighestSeq = 0,
  ): { signedStore: GroupOfflineStore; version: number } {
    const version = baseVersion + 1;
    const highestSeq = Math.max(
      minimumHighestSeq,
      fallbackSeq,
      ...messages.map((m) => m.seq),
    );
    const signedStore = this.signStore(messages, highestSeq, version, bucketKey);
    return { signedStore, version };
  }

  private signStore(
    messages: GroupContentMessage[],
    highestSeq: number,
    version: number,
    bucketKey: string,
  ): GroupOfflineStore {
    const timestamp = Date.now();
    const storeSignedPayload: GroupOfflineSignedPayload = {
      messageIds: messages.map(m => m.messageId),
      highestSeq,
      version,
      timestamp,
      bucketKey,
    };

    const payloadBytes = new TextEncoder().encode(JSON.stringify(storeSignedPayload));
    const signature = ed25519.sign(payloadBytes, this.deps.userIdentity.signingPrivateKey);

    return {
      messages,
      highestSeq,
      lastUpdated: timestamp,
      version,
      storeSignature: Buffer.from(signature).toString('base64'),
      storeSignedPayload,
    };
  }

  private async getLatestStore(bucketKey: string): Promise<GroupOfflineStore | null> {
    log('checking bucket', bucketKey);
    const startedAt = Date.now();

    const key = new TextEncoder().encode(bucketKey);
    let best: GroupOfflineStore | null = null;
    let valueEvents = 0;

    log('fetching store from dht', bucketKey);

    try {
      for await (const event of this.deps.node.services.dht.get(key, {
        signal: AbortSignal.timeout(this.dhtOpTimeoutMs()),
      }) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || event.value.length === 0) continue;
        valueEvents++;
        try {
          const decompressed = await gunzipAsync(Buffer.from(event.value), { maxOutputLength: GROUP_OFFLINE_STORE_MAX_DECOMPRESSED_BYTES });
          const store = JSON.parse(decompressed.toString('utf8')) as GroupOfflineStore;
          if (
            !best
            || store.version > best.version
            || (store.version === best.version && store.lastUpdated > best.lastUpdated)
          ) {
            best = store;
          }
        } catch {
          continue;
        }
      }
    } catch {
      log(
        `[GROUP-OFFLINE][TIMING][STORE] bucket=*${bucketKey.slice(-10)} cacheHit=false dhtError=true ` +
        `valueEvents=${valueEvents} took=${Date.now() - startedAt}ms`
      );
      return null;
    }

    log(
      `[GROUP-OFFLINE][TIMING][STORE] bucket=*${bucketKey.slice(-10)} cacheHit=false hasStore=${!!best} ` +
      `valueEvents=${valueEvents} took=${Date.now() - startedAt}ms`
    );
    return best;
  }

  private dhtOpTimeoutMs(): number {
    return this.networkMode === 'anonymous'
      ? GroupOfflineManager.DHT_OP_TIMEOUT_ANONYMOUS_MS
      : GroupOfflineManager.DHT_OP_TIMEOUT_FAST_MS;
  }

  private async putStore(bucketKey: string, store: GroupOfflineStore): Promise<void> {
    const startedAt = Date.now();
    const bucketTag = bucketKey.slice(-12);
    const key = new TextEncoder().encode(bucketKey);
    const payload = Buffer.from(JSON.stringify(store), 'utf8');
    const compressed = await gzipAsync(payload);

    if (compressed.length > GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES) {
      throw new Error(
        `Group offline store too large (${compressed.length}B > ${GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES}B)`,
      );
    }

    let successCount = 0;
    let eventCount = 0;
    let queryErrorCount = 0;
    let firstPeerResponseAt: number | null = null;

    try {
      for await (const event of this.deps.node.services.dht.put(key, compressed, {
        signal: AbortSignal.timeout(this.dhtOpTimeoutMs()),
      }) as AsyncIterable<QueryEvent>) {
        eventCount++;
        if (event.name === 'PEER_RESPONSE') {
          successCount++;
          if (firstPeerResponseAt === null) {
            firstPeerResponseAt = Date.now();
          }
        } else if (event.name === 'QUERY_ERROR') {
          queryErrorCount++;
        }
      }
    } catch (error: unknown) {
      // Timeout (or abort) reaching the rest of the peers. If at least one peer
      // already stored the record, the message is on the DHT, so let it count
      // as success instead of forcing the caller into recovery/offline-failure.
      // A timeout with zero successful peers is a real failure and rethrows.
      const isTimeout = error instanceof Error
        && (error.name === 'AbortError' || error.name === 'TimeoutError');
      if (!isTimeout || successCount === 0) {
        throw error;
      }
    }
    const totalPutMs = Date.now() - startedAt;
    const firstPeerMs = firstPeerResponseAt === null ? -1 : firstPeerResponseAt - startedAt;
    const tailAfterFirstSuccessMs = firstPeerResponseAt === null ? -1 : totalPutMs - firstPeerMs;
    const timingMsg =
      `[GROUP-OFFLINE][TIMING][PUT] bucket=*${bucketTag} storeVersion=${store.version} ` +
      `events=${eventCount} peerResponses=${successCount} queryErrors=${queryErrorCount} ` +
      `firstPeerMs=${firstPeerMs} tailAfterFirstSuccessMs=${tailAfterFirstSuccessMs} totalPutMs=${totalPutMs}`;

    if (totalPutMs > 5000 || (firstPeerResponseAt !== null && tailAfterFirstSuccessMs > 2000)) {
      console.warn(timingMsg);
    } else {
      log(timingMsg);
    }

    if (successCount === 0) {
      throw new Error('Failed to store group offline message: no successful DHT peers');
    }
  }

  private isStoreTooLargeError(error: unknown): boolean {
    return errStr(error).includes('store too large');
  }

  // A DHT write that reached zero peers, or aborted/timed out against stale
  // connections. Distinguished from version-conflict failures (which warrant a
  // remote read + merge) because reading the DHT can't succeed here either.
  private isConnectivityFailureError(error: unknown): boolean {
    const errorText = errStr(error).toLowerCase();
    return (
      errorText.includes('no successful dht peers')
      || errorText.includes('all peers unreachable')
      || errorText.includes('timed out')
      || errorText.includes('aborted')
      || errorText.includes('no connected peers')
    );
  }

  private async triggerReconnect(): Promise<boolean> {
    if (!this.deps.requestReconnect) {
      return false;
    }
    try {
      return await this.deps.requestReconnect();
    } catch {
      return false;
    }
  }

  private decryptContent(encryptedContent: string, key: Uint8Array, nonceBase64: string): string {
    const nonce = Buffer.from(nonceBase64, 'base64');
    const encryptedBytes = Buffer.from(encryptedContent, 'base64');
    const cipher = xchacha20poly1305(key, nonce);
    const decrypted = cipher.decrypt(encryptedBytes);
    return new TextDecoder().decode(decrypted);
  }

  private async withBucketMutationLock<T>(bucketKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.bucketMutationQueues.get(bucketKey) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    this.bucketMutationQueues.set(bucketKey, previous.catch(() => undefined).then(() => current));
    await previous.catch(() => undefined);

    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.bucketMutationQueues.get(bucketKey) === current) {
        this.bucketMutationQueues.delete(bucketKey);
      }
    }
  }

  private evaluateEpochSkipDecision(
    chat: Chat,
    epoch: { key_version: number; used_until: number | null },
    versionMeta: GroupOfflineVersionMeta | null,
  ): EpochSkipDecision {
    if (!chat.group_id) return { skip: false, reason: 'no_group' };
    const currentKeyVersion = chat.key_version ?? 0;
    if (epoch.key_version >= currentKeyVersion) {
      return { skip: false, reason: 'active_or_future_epoch' };
    }
    if (
      currentKeyVersion > 0
      && epoch.key_version <= (currentKeyVersion - GROUP_MISSING_USED_UNTIL_SCAN_EPOCH_CAP)
    ) {
      return { skip: true, reason: 'epoch_depth_cap' };
    }
    if (epoch.used_until === null) {
      return { skip: false, reason: 'missing_used_until' };
    }
    const threshold = epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS;
    if (Date.now() < threshold) return { skip: false, reason: 'within_grace_window' };

    const senderPeerIds = this.getEpochSenderPeerIds(chat, epoch.key_version, versionMeta);
    if (senderPeerIds.length === 0) {
      return { skip: true, reason: 'no_expected_senders' };
    }

    const boundaries = versionMeta?.senderSeqBoundaries ?? {};
    const hasAllBoundaries = senderPeerIds.every((peerId) => boundaries[peerId] !== undefined);
    if (hasAllBoundaries) {
      const consumedByBoundaries = senderPeerIds.every((peerId) => {
        const boundary = boundaries[peerId] as number;
        const seen = this.deps.database.getMemberSeq(chat.group_id!, epoch.key_version, peerId);
        return seen >= boundary;
      });
      return consumedByBoundaries
        ? { skip: true, reason: 'boundaries_consumed' }
        : { skip: false, reason: 'boundaries_not_consumed' };
    }

    const cursors = this.deps.database.getGroupOfflineCursors(chat.group_id, epoch.key_version);
    if (cursors.length === 0) return { skip: false, reason: 'no_cursors' };
    if (cursors.length < senderPeerIds.length) return { skip: false, reason: 'partial_cursors' };
    const consumedByCursorFallback = cursors.every((cursor) => cursor.last_read_timestamp >= threshold);
    return consumedByCursorFallback
      ? { skip: true, reason: 'cursor_threshold_met' }
      : { skip: false, reason: 'cursor_threshold_not_met' };
  }

  private getEpochSenderPeerIds(
    chat: Chat,
    keyVersion: number,
    versionMeta: GroupOfflineVersionMeta | null,
  ): string[] {
    const participants = this.deps.database
      .getChatParticipants(chat.id)
      .map((p) => p.peer_id)
      .filter((peerId) => peerId !== this.deps.myPeerId);
    const localKnownSenders = this.getLocalKnownEpochSenders(chat, keyVersion);

    if (versionMeta) {
      const boundaries = versionMeta.senderSeqBoundaries ?? {};
      const boundarySenders = Object.keys(boundaries)
        .filter((peerId) => peerId !== this.deps.myPeerId);
      if (boundarySenders.length > 0) {
        return [...new Set([...boundarySenders, ...localKnownSenders])];
      }
    }

    if (localKnownSenders.length > 0) {
      return localKnownSenders;
    }

    // Metadata unavailable: fallback to participant roster to avoid losing messages.
    // This is broader, but safe.
    return participants;
  }

  private resolveEpochBoundaryMetaVersion(chat: Chat, epochKeyVersion: number): number | null {
    const currentKeyVersion = chat.key_version ?? 0;
    if (epochKeyVersion >= currentKeyVersion) {
      return null;
    }
    const candidate = epochKeyVersion + 1;
    return candidate <= currentKeyVersion ? candidate : null;
  }

  private async getEpochBoundaryMeta(
    chat: Chat,
    epochKeyVersion: number,
    metaKeyVersion: number | null,
  ): Promise<GroupOfflineVersionMeta | null> {
    if (!chat.group_id) return null;

    const localBoundaries = this.deps.database.getGroupEpochBoundaries(chat.group_id, epochKeyVersion);
    if (Object.keys(localBoundaries).length > 0) {
      return {
        members: [],
        senderSeqBoundaries: localBoundaries,
      };
    }

    if (metaKeyVersion === null) {
      return null;
    }

    return this.getVersionMeta(chat, metaKeyVersion);
  }

  private getLocalKnownEpochSenders(chat: Chat, keyVersion: number): string[] {
    if (!chat.group_id) return [];

    const fromSeqs = Object.keys(this.deps.database.getAllMemberSeqs(chat.group_id, keyVersion));
    const fromCursors = this.deps.database
      .getGroupOfflineCursors(chat.group_id, keyVersion)
      .map((cursor) => cursor.sender_peer_id);

    return [...new Set([...fromSeqs, ...fromCursors])]
      .filter((peerId) => peerId !== this.deps.myPeerId);
  }

  private verifyOfflineMessageSignature(msg: GroupContentMessage, signingPubKeyBase64: string): boolean {
    try {
      const unsignedMessage: Omit<GroupContentMessage, 'signature'> = {
        type: msg.type ?? GroupMessageType.GROUP_MESSAGE,
        groupId: msg.groupId,
        keyVersion: msg.keyVersion,
        senderPeerId: msg.senderPeerId,
        messageId: msg.messageId,
        seq: msg.seq,
        encryptedContent: msg.encryptedContent,
        nonce: msg.nonce,
        timestamp: msg.timestamp,
        messageType: msg.messageType ?? 'text',
      };
      const payloadBytes = new TextEncoder().encode(JSON.stringify(unsignedMessage));
      const sigBytes = Buffer.from(msg.signature, 'base64');
      const pubKeyBytes = Buffer.from(signingPubKeyBase64, 'base64');
      return ed25519.verify(sigBytes, payloadBytes, pubKeyBytes);
    } catch {
      return false;
    }
  }

  private advanceCursor(
    lastReadTs: number,
    lastReadMessageId: string,
    msg: GroupContentMessage,
  ): { lastReadTs: number; lastReadMessageId: string } {
    const msgId = msg.messageId;
    if (
      msg.timestamp > lastReadTs
      || (msg.timestamp === lastReadTs && msgId !== lastReadMessageId)
    ) {
      return { lastReadTs: msg.timestamp, lastReadMessageId: msgId };
    }
    return { lastReadTs, lastReadMessageId };
  }

  private filterLiveMessages(messages: GroupContentMessage[]): GroupContentMessage[] {
    const now = Date.now()
    const cutoff = now - GROUP_OFFLINE_MESSAGE_TTL_MS;
    const maxAllowedTimestamp = now + GROUP_MESSAGE_MAX_FUTURE_SKEW_MS;
    return messages.filter((msg) => msg.timestamp >= cutoff && msg.timestamp <= maxAllowedTimestamp);
  }

  // Prune in-memory version metadata cache.
  private pruneLocalCaches(): void {
    const now = Date.now();
    for (const [metaKey, entry] of this.versionMetaCache.entries()) {
      if (now - entry.cachedAt > GROUP_OFFLINE_LOCAL_CACHE_TTL_MS) {
        this.versionMetaCache.delete(metaKey);
      }
    }

    while (this.versionMetaCache.size > GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES) {
      const oldest = this.versionMetaCache.keys().next().value;
      if (!oldest) break;
      this.versionMetaCache.delete(oldest);
    }
  }

  private pruneEpochState(
    chat: Chat,
    epoch: { key_version: number; used_until: number | null },
    reason: string,
  ): void {
    if (!chat.group_id) return;

    this.deps.database.deleteGroupOfflineCursorsForEpoch(chat.group_id, epoch.key_version);
    this.deps.database.deleteGroupKeyHistoryForEpoch(chat.group_id, epoch.key_version);
    this.deps.database.deleteGroupSenderSeqForEpoch(chat.group_id, epoch.key_version);
    this.deps.database.deleteGroupMemberSeqsForEpoch(chat.group_id, epoch.key_version);

    const epochMetaCacheKey = `${chat.group_id}:${epoch.key_version}`;
    this.versionMetaCache.delete(epochMetaCacheKey);
    const successorMetaCacheKey = `${chat.group_id}:${epoch.key_version + 1}`;
    this.versionMetaCache.delete(successorMetaCacheKey);

    const bucketPrefix = `${this.groupOfflineBucketPrefix}/${chat.group_id}/${epoch.key_version}/`;
    this.deps.database.deleteGroupOfflineSentMessagesByPrefix(bucketPrefix);
    this.notifyOfflineInboxCapacityChanged(chat.id);
    log(
      `[GROUP-OFFLINE][TIMING][PRUNE][CHAT:${chat.id}] epoch=${epoch.key_version} action=pruned reason=${reason}`
    );
  }

  private canEpochBePrunedWithoutMeta(
    chat: Chat,
    epoch: { key_version: number; used_until: number | null },
  ): boolean {
    const currentKeyVersion = chat.key_version ?? 0;
    if (epoch.key_version >= currentKeyVersion) return false;
    if (
      currentKeyVersion > 0
      && epoch.key_version <= (currentKeyVersion - GROUP_MISSING_USED_UNTIL_SCAN_EPOCH_CAP)
    ) {
      return true;
    }
    if (epoch.used_until === null) return false;

    const threshold = epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS;
    return Date.now() >= threshold;
  }

  private evaluateEpochPruneDecision(
    chat: Chat,
    epoch: { key_version: number; used_until: number | null },
    versionMeta: GroupOfflineVersionMeta | null,
  ): EpochPruneDecision {
    if (!chat.group_id) return { prune: false, reason: 'no_group' };
    const currentKeyVersion = chat.key_version ?? 0;
    if (epoch.key_version >= currentKeyVersion) return { prune: false, reason: 'active_or_future_epoch' };
    if (
      currentKeyVersion > 0
      && epoch.key_version <= (currentKeyVersion - GROUP_MISSING_USED_UNTIL_SCAN_EPOCH_CAP)
    ) {
      return { prune: true, reason: 'epoch_depth_cap' };
    }
    if (epoch.used_until === null) return { prune: false, reason: 'missing_used_until' };

    const threshold = epoch.used_until + GROUP_ROTATION_GRACE_WINDOW_MS;
    if (Date.now() < threshold) return { prune: false, reason: 'within_grace_window' };

    const senderPeerIds = this.getEpochSenderPeerIds(chat, epoch.key_version, versionMeta);
    if (senderPeerIds.length === 0) return { prune: true, reason: 'no_expected_senders' };

    const boundaries = versionMeta?.senderSeqBoundaries ?? {};
    const hasAllBoundaries = senderPeerIds.every((peerId) => boundaries[peerId] !== undefined);
    if (!hasAllBoundaries) return { prune: false, reason: 'missing_boundaries' };

    const consumedByBoundaries = senderPeerIds.every((peerId) => {
      const boundary = boundaries[peerId] as number;
      const seen = this.deps.database.getMemberSeq(chat.group_id!, epoch.key_version, peerId);
      return seen >= boundary;
    });
    return consumedByBoundaries
      ? { prune: true, reason: 'boundaries_consumed' }
      : { prune: false, reason: 'boundaries_not_consumed' };
  }
}
