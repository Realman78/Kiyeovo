import { createHash, randomBytes, randomUUID } from 'crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { ed25519 } from '@noble/curves/ed25519';
import type { ChatNode, MessageReceivedEvent, SendMessageResponse, StrippedMessage } from '../../types.js';
import {
  GROUP_HEARTBEAT_MAX_AGE_MS,
  GROUP_GOSSIPSUB_HEARTBEAT_MIN_INTERVAL_MS,
  GROUP_GOSSIPSUB_HEARTBEAT_MAX_INTERVAL_MS,
  GROUP_MESSAGE_MAX_AGE_MS,
  GROUP_MESSAGE_MAX_FUTURE_SKEW_MS,
  GROUP_OFFLINE_BACKSTOP_COALESCE_WINDOW_MS,
  GROUP_OFFLINE_MESSAGE_TTL_MS,
  GROUP_OLD_TOPIC_SUBSCRIPTION_GRACE_MS,
  GROUP_PUBLISH_RETRYABLE_ERROR,
  GROUP_PUBLISH_RETRY_DELAY_MS,
  GROUP_TOPIC_RECONCILE_INTERVAL,
  getNetworkModeRuntime,
} from '../../constants.js';
import type { ChatDatabase } from '../../db/database.js';
import type { EncryptedUserIdentity } from '../../identity/encrypted-user-identity.js';
import {
  GroupMessageType,
  type GroupChatMessage,
  type GroupContentMessage,
  type GroupHeartbeatMessage,
} from '../types.js';
import { isGroupCallHintSystemPayload } from '../../lib/group-call-signaling.js';
import {
  dispatchEnvelope,
  encodeApplicationEnvelope,
  isValidCid,
} from '../../protocol/message-envelope.js';
import type {
  ApplicationMessageSendResult,
  InboundApplicationMessageContext,
  InboundApplicationMessageHandler,
  SendApplicationMessageRequest,
} from '../../protocol/application-message.js';
import { toBase64Url } from '../../utils/miscellaneous.js';
import { errStr, generalErrorHandler } from '../../utils/general-error.js';
import { GroupOfflineManager } from './group-offline-manager.js';
import { computeJitteredHeartbeatDelayMs } from '../../lib/heartbeat-jitter.js';
import { log } from '../../../shared/logger.js';

export const GROUP_OFFLINE_BACKUP_FAILED_MARKER = 'no online peers and offline backup failed';

interface GroupMessagingDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  myUsername: string;
  onMessageReceived: (data: MessageReceivedEvent) => void;
  onApplicationMessage: InboundApplicationMessageHandler;
  groupOfflineManager: GroupOfflineManager;
  nudgeGroupRefetch?: (peerId: string, groupId: string) => void;
}

interface GroupContext {
  groupId: string;
  chatId: number;
  keyVersion: number;
  groupKey: Uint8Array;
  topic: string;
}

interface GroupGraceContext extends GroupContext {
  expiresAt: number;
}

export class GroupMessaging {
  private readonly deps: GroupMessagingDeps;
  private readonly buildPubsubTopic: (topic: string) => string;
  private readonly groupTopics = new Map<string, string>();
  private readonly groupGraceContexts = new Map<string, GroupGraceContext[]>();
  private readonly graceTopicTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private peerConnectDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private reconcileInFlight = false;
  private heartbeatInFlight = false;
  private readonly pendingOfflineBackups = new Map<string, GroupContentMessage>();
  private readonly rekeyContextMissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Task C: backstop (redundant, live-delivered) offline-bucket writes are
  // coalesced per own-bucket-key instead of written on every send. Sole-
  // delivery writes (no online peers) are untouched and stay immediate.
  private readonly pendingBackstopBuckets = new Map<string, Set<string>>();
  private readonly backstopFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly onPubsubMessage = (evt: CustomEvent<unknown>): void => {
    void this.handleIncomingPubsubEvent(evt.detail);
  };

  private readonly onPeerConnect = (): void => {
    this.scheduleReconcile(2000);
  };

  constructor(deps: GroupMessagingDeps) {
    this.deps = deps;
    this.buildPubsubTopic = getNetworkModeRuntime(this.deps.database.getSessionNetworkMode()).buildPubsubTopic;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.recoverPendingOfflineBackups();
    this.deps.node.services.pubsub.addEventListener('message', this.onPubsubMessage as EventListener);
    this.deps.node.addEventListener('peer:connect', this.onPeerConnect as EventListener);
    void this.reconcileSubscriptions();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileSubscriptions();
    }, GROUP_TOPIC_RECONCILE_INTERVAL);
    this.scheduleNextHeartbeat();
  }

  // Jittered, self-re-arming heartbeat: each tick draws a fresh random delay
  // for the NEXT tick instead of reusing one fixed period (see
  // computeJitteredHeartbeatDelayMs). A plain setInterval(..., FIXED_MS) is a
  // metronome an observer can fingerprint; redrawing per tick avoids that
  // while the upper bound keeps gossipsub mesh warming intact.
  private scheduleNextHeartbeat(): void {
    if (!this.started) return;
    const delay = computeJitteredHeartbeatDelayMs(
      GROUP_GOSSIPSUB_HEARTBEAT_MIN_INTERVAL_MS,
      GROUP_GOSSIPSUB_HEARTBEAT_MAX_INTERVAL_MS,
    );
    this.heartbeatTimer = setTimeout(() => {
      void this.publishHeartbeats().finally(() => {
        this.scheduleNextHeartbeat();
      });
    }, delay);
  }

  async cleanup(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    this.deps.node.services.pubsub.removeEventListener('message', this.onPubsubMessage as EventListener);
    this.deps.node.removeEventListener('peer:connect', this.onPeerConnect as EventListener);

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.peerConnectDebounceTimer) {
      clearTimeout(this.peerConnectDebounceTimer);
      this.peerConnectDebounceTimer = null;
    }
    for (const timer of this.graceTopicTimers.values()) {
      clearTimeout(timer);
    }
    this.graceTopicTimers.clear();
    for (const timer of this.rekeyContextMissTimers.values()) {
      clearTimeout(timer);
    }
    this.rekeyContextMissTimers.clear();

    const topicsToUnsubscribe = new Set<string>();
    for (const topic of this.groupTopics.values()) {
      topicsToUnsubscribe.add(topic);
    }
    for (const contexts of this.groupGraceContexts.values()) {
      for (const context of contexts) {
        topicsToUnsubscribe.add(context.topic);
      }
    }

    for (const topic of topicsToUnsubscribe) {
      this.unsubscribeTopic(topic, 'cleanup');
    }
    this.groupTopics.clear();
    this.groupGraceContexts.clear();

    // App quit: any coalesced backstop write still waiting out its window
    // must land now rather than being silently dropped (its durable row
    // already survives a crash, but a clean quit should not leave the DHT
    // copy stale for up to GROUP_OFFLINE_BACKSTOP_COALESCE_WINDOW_MS after
    // the process is gone).
    await this.flushAllBackstopBuckets('shutdown');
  }

  subscribeToGroupTopic(groupId: string): void {
    const ctx = this.resolveActiveGroupContext(groupId);
    this.ensureTopicSubscription(ctx);
  }

  deactivateGroup(groupId: string): void {
    this.clearGraceContextsForGroup(groupId);
    const currentTopic = this.groupTopics.get(groupId);
    if (!currentTopic) return;
    this.groupTopics.delete(groupId);
    this.unsubscribeTopicIfUnused(currentTopic);
  }

  registerGraceContextForEpoch(groupId: string, keyVersion: number): void {
    const chat = this.deps.database.getChatByGroupId(groupId);
    if (!chat) return;

    const keyBase64 = this.deps.database.getGroupKeyForEpoch(groupId, keyVersion);
    if (!keyBase64) {
      log(
        `[GROUP-MSG][GRACE][REGISTER][SKIP] group=${groupId} keyVersion=${keyVersion} reason=missing_key`,
      );
      return;
    }

    const keyBytes = Buffer.from(keyBase64, 'base64');
    if (keyBytes.length !== 32) {
      log(
        `[GROUP-MSG][GRACE][REGISTER][SKIP] group=${groupId} keyVersion=${keyVersion} reason=invalid_key_length`,
      );
      return;
    }

    const topic = this.deriveTopic(groupId, keyBytes);
    const ctx: GroupContext = {
      groupId,
      chatId: chat.id,
      keyVersion,
      groupKey: keyBytes,
      topic,
    };

    this.addGraceContext(ctx);
    this.subscribeTopic(
      topic,
      `pre-rotation-grace group=${groupId} keyVersion=${keyVersion}`,
      true,
    );
    log(
      `[GROUP-MSG][GRACE][REGISTER] group=${groupId} keyVersion=${keyVersion} topic=${topic.slice(0, 16)}...`,
    );
  }

  async reconcileSubscriptions(): Promise<void> {
    if (this.reconcileInFlight) return;
    this.reconcileInFlight = true;

    try {
      const expectedByGroup = new Map<string, string>();
      const chats = this.deps.database.getAllGroupChats();

      for (const chat of chats) {
        if (!chat.group_id) continue;
        if (chat.status !== 'active') continue;
        if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') continue;
        if ((chat.key_version ?? 0) <= 0) continue;

        const keyBase64 = this.deps.database.getGroupKeyForEpoch(chat.group_id, chat.key_version);
        if (!keyBase64) continue;

        const keyBytes = Buffer.from(keyBase64, 'base64');
        if (keyBytes.length !== 32) continue;

        const topic = this.deriveTopic(chat.group_id, keyBytes);
        const ctx: GroupContext = {
          groupId: chat.group_id,
          chatId: chat.id,
          keyVersion: chat.key_version,
          groupKey: keyBytes,
          topic,
        };
        expectedByGroup.set(chat.group_id, topic);
        this.ensureTopicSubscription(ctx);
      }

      for (const [groupId, existingTopic] of this.groupTopics.entries()) {
        if (expectedByGroup.has(groupId)) continue;
        this.unsubscribeTopic(existingTopic, `reconcile-remove-group:${groupId}`);
        this.clearGraceContextsForGroup(groupId);
        this.groupTopics.delete(groupId);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, '[GROUP-MSG] Failed to reconcile topic subscriptions');
    } finally {
      this.reconcileInFlight = false;
    }
  }

  async sendGroupMessage(
    groupId: string,
    content: string,
    options?: { rekeyRetryHint?: boolean; replyToCid?: string }
  ): Promise<SendMessageResponse> {
    const messageId = randomUUID();
    const replyToCid = isValidCid(options?.replyToCid) ? options.replyToCid : undefined;
    const result = await this.sendApplicationMessage(groupId, {
      message: {
        cid: messageId,
        kind: 'text',
        payload: {
          text: content,
          ...(replyToCid ? { reply_to: replyToCid } : {}),
        },
      },
      persistence: {
        owner: 'transport',
        content,
        messageType: 'text',
        ...(replyToCid ? { replyToCid } : {}),
      },
      ...(options?.rekeyRetryHint !== undefined
        ? { rekeyRetryHint: options.rekeyRetryHint }
        : {}),
    });

    const strippedMessage: StrippedMessage = {
      chatId: result.chatId,
      messageId,
      content,
      timestamp: result.timestamp,
      messageType: 'text',
      clientMsgId: messageId,
      replyToClientId: replyToCid,
    };
    return {
      success: true,
      message: strippedMessage,
      messageSentStatus: result.messageSentStatus,
      error: null,
      warning: result.warning,
      offlineBackupRetry: result.offlineBackupRetry,
    };
  }

  async sendApplicationMessage(
    groupId: string,
    request: SendApplicationMessageRequest,
  ): Promise<ApplicationMessageSendResult> {
    const ctx = this.resolveActiveGroupContext(groupId);
    const participants = this.deps.database.getChatParticipants(ctx.chatId);
    const hasRecipient = participants.some((participant) => participant.peer_id !== this.deps.myPeerId);
    if (!hasRecipient) {
      throw new Error('Cannot send message: group has no other members');
    }
    if (
      request.persistence.owner === 'caller'
      && !this.deps.database.messageExistsInChat(ctx.chatId, request.message.cid)
    ) {
      throw new Error('Caller-owned application message row was not persisted before send');
    }
    this.ensureTopicSubscription(ctx);

    const participantPeers = participants.map((participant) => participant.peer_id);
    const connectedPeers = this.deps.node.getPeers().map((peerId) => peerId.toString());
    log(
      `[GROUP-MSG][SEND][CTX] group=${groupId.slice(0, 8)} keyVersion=${ctx.keyVersion} ` +
      `topic=${ctx.topic.slice(0, 16)}... participants=${participantPeers.map((p) => p.slice(-8)).join(',') || 'none'} ` +
      `connectedPeers=${connectedPeers.map((p) => p.slice(-8)).join(',') || 'none'}`
    );

    const messageId = request.message.cid;
    const envelopeBody = encodeApplicationEnvelope(request.message);

    const nonce = randomBytes(24);
    const encryptedContent = this.encryptContent(envelopeBody, ctx.groupKey, nonce);

    const seq = this.deps.database.getNextSeqAndIncrement(groupId, ctx.keyVersion);
    const timestamp = Date.now();

    const unsignedMessage: Omit<GroupContentMessage, 'signature'> = {
      type: GroupMessageType.GROUP_MESSAGE,
      groupId,
      keyVersion: ctx.keyVersion,
      senderPeerId: this.deps.myPeerId,
      messageId,
      seq,
      encryptedContent,
      nonce: Buffer.from(nonce).toString('base64'),
      timestamp,
      messageType: 'text',
    };

    const signedMessage: GroupChatMessage = {
      ...unsignedMessage,
      signature: this.sign(unsignedMessage),
    };

    const payloadBytes = new TextEncoder().encode(JSON.stringify(signedMessage));
    const publishStartedAt = Date.now();
    const published = await this.publishWithRetry(ctx, payloadBytes);
    const publishMs = Date.now() - publishStartedAt;

    let warning = published ? null : 'No online group peers subscribed; queued for offline delivery.';
    let offlineBackupRetry: { chatId: number; messageId: string } | null = null;

    if (published) {
      // Live delivery already reached at least one subscriber, so this bucket
      // write is a redundant "backstop" for members who are offline/lagging —
      // not the only delivery path. Coalesce it into the batched write
      // (Task C) instead of writing on every send. The durable queue write
      // happens synchronously below, before any delay, so a crash can't lose
      // it; a genuine flush failure later still surfaces the same
      // "Retry offline backup" UX as before (see flushBackstopBucket).
      try {
        const bucketKey = this.deps.groupOfflineManager.getOwnBucketKey(groupId, ctx.keyVersion);
        this.queueBackstopWrite(bucketKey, ctx.chatId, signedMessage);
      } catch (error: unknown) {
        const errorText = errStr(error);
        warning = `Message delivered online, but offline group backup failed: ${errorText}`;
        if (request.persistence.owner !== 'none') {
          offlineBackupRetry = { chatId: ctx.chatId, messageId: signedMessage.messageId };
          this.pendingOfflineBackups.set(signedMessage.messageId, signedMessage);
          this.deps.database.upsertPendingGroupOfflineBackup({
            messageId: signedMessage.messageId,
            chatId: ctx.chatId,
            groupId,
            payload: JSON.stringify(signedMessage),
            kind: 'failed_retry',
          });
        }
        console.warn(`[GROUP-OFFLINE] ${warning}`);
      }
    } else {
      // Sole-delivery: no online peers were reachable, so this bucket write
      // is the ONLY way any member gets the message. Stays synchronous and
      // immediate — unchanged from before Task C.
      try {
        log(
          `[GROUP-MSG][SEND][OFFLINE_BACKUP][START] group=${groupId.slice(0, 8)} ` +
          `msgId=${signedMessage.messageId} keyVersion=${ctx.keyVersion}`,
        );
        await this.deps.groupOfflineManager.storeGroupMessage(signedMessage);
        this.pendingOfflineBackups.delete(signedMessage.messageId);
        this.deps.database.deletePendingGroupOfflineBackup(signedMessage.messageId);

        if (request.rekeyRetryHint) {
          participants
            .filter(p => p.peer_id !== this.deps.myPeerId)
            .forEach((p) => this.deps.nudgeGroupRefetch?.(p.peer_id, groupId))
        }
      } catch (error: unknown) {
        const errorText = errStr(error);
        throw new Error(`Failed to deliver group message: ${GROUP_OFFLINE_BACKUP_FAILED_MARKER}: ${errorText}`);
      }
    }

    if (request.persistence.owner === 'transport') {
      await this.deps.database.createMessage({
        id: messageId,
        chat_id: ctx.chatId,
        sender_peer_id: this.deps.myPeerId,
        content: request.persistence.content,
        message_type: request.persistence.messageType,
        timestamp: new Date(timestamp),
        client_msg_id: messageId,
        reply_to_client_id: request.persistence.replyToCid ?? null,
      });

      this.deps.onMessageReceived({
        chatId: ctx.chatId,
        messageId,
        content: request.persistence.content,
        senderPeerId: this.deps.myPeerId,
        senderUsername: this.deps.myUsername,
        timestamp,
        messageSentStatus: published ? 'online' : 'offline',
        messageType: request.persistence.messageType,
        clientMsgId: messageId,
        replyToClientId: request.persistence.replyToCid,
      });
    }
    this.deps.database.updateMemberSeq(groupId, ctx.keyVersion, this.deps.myPeerId, seq);

    // Delivered online but the DHT backup failed → persist a distinct failed
    // state on the row so the "Retry offline backup" affordance shows and survives
    // restart (the message itself was delivered; this is backup-only, manual retry).
    if (offlineBackupRetry) {
      this.deps.database.updateMessageSendState(signedMessage.messageId, 'failed', 'offline_backup');
    }

    const response: ApplicationMessageSendResult = {
      chatId: ctx.chatId,
      messageId,
      timestamp,
      messageSentStatus: published ? 'online' : 'offline',
      warning,
      offlineBackupRetry,
    };

    log(`[GROUP-MSG][SEND] ${groupId} done publishMs=${publishMs} ${published ? 'online' : 'offline'}`);

    return response;
  }

  async storeHiddenSystemMessage(groupId: string, content: string): Promise<void> {
    const ctx = this.resolveActiveGroupContext(groupId);
    const seq = this.deps.database.getNextSeqAndIncrement(groupId, ctx.keyVersion);
    const timestamp = Date.now();
    const nonce = randomBytes(24);
    const encryptedContent = this.encryptContent(content, ctx.groupKey, nonce);

    const unsignedMessage: Omit<GroupContentMessage, 'signature'> = {
      type: GroupMessageType.GROUP_MESSAGE,
      groupId,
      keyVersion: ctx.keyVersion,
      senderPeerId: this.deps.myPeerId,
      messageId: randomUUID(),
      seq,
      encryptedContent,
      nonce: Buffer.from(nonce).toString('base64'),
      timestamp,
      messageType: 'system',
    };

    const signedMessage: GroupChatMessage = {
      ...unsignedMessage,
      signature: this.sign(unsignedMessage),
    };

    await this.deps.groupOfflineManager.storeGroupMessage(signedMessage);
    log(
      `[GROUP-MSG][SYSTEM][OFFLINE_ONLY] group=${groupId.slice(0, 8)} msgId=${signedMessage.messageId} seq=${seq}`,
    );
  }

  async storeGroupCallHintMessage(groupId: string): Promise<void> {
    const ctx = this.resolveActiveGroupContext(groupId);
    if (this.hasLiveGroupCallHintInLocalMirror(ctx)) {
      log(
        `[GROUP-CALL][HINT][STORE_SKIP] group=${groupId.slice(0, 8)} epoch=${ctx.keyVersion}`,
      );
      return;
    }

    await this.storeHiddenSystemMessage(groupId, JSON.stringify({
      type: 'GROUP_CALL_HINT',
      groupId,
    }));
  }

  async retryOfflineBackup(chatId: number, messageId: string): Promise<void> {
    const pending = this.pendingOfflineBackups.get(messageId);
    if (!pending) {
      throw new Error('No pending offline backup found for this message');
    }

    const chat = this.deps.database.getChatByIdWithUsernameAndLastMsg(chatId, this.deps.myPeerId);
    if (!chat || chat.type !== 'group' || !chat.group_id) {
      throw new Error('Invalid group chat for offline backup retry');
    }
    if (pending.groupId !== chat.group_id) {
      throw new Error('Offline backup retry chat/group mismatch');
    }

    await this.deps.groupOfflineManager.storeGroupMessage(pending);
    this.pendingOfflineBackups.delete(messageId);
    this.deps.database.deletePendingGroupOfflineBackup(messageId);
    this.deps.database.updateMessageSendState(messageId, null);
  }

  discardDeletedMessageRetryState(messageIds: string[]): void {
    for (const messageId of messageIds) {
      this.pendingOfflineBackups.delete(messageId);
    }
  }

  /**
   * On startup, rehydrate persisted pending backups from `pending_group_offline_backups`.
   * The table serves two distinct purposes, distinguished by `kind`:
   *  - 'failed_retry': published online, but the DHT backup write itself failed
   *    before app-close. Rehydrated into the in-memory map so `retryOfflineBackup`
   *    works again; no auto-retry, the "Retry offline backup" button + failed
   *    row is the deliberate UX and the user re-stores manually.
   *  - 'coalescing': a backstop write (Task C) that was durably queued but had
   *    not yet reached its coalescing window's flush when the app closed
   *    (i.e. an unclean shutdown — a clean quit already flushes these in
   *    cleanup()). These are not failures and must not surface a "failed" UI
   *    state; they are simply flushed now instead of waiting out a window
   *    that will never otherwise re-arm (no in-memory timer survives restart).
   */
  private recoverPendingOfflineBackups(): void {
    const rows = this.deps.database.getAllPendingGroupOfflineBackups();
    if (rows.length === 0) return;

    const coalescingByBucket = new Map<string, string[]>();
    for (const row of rows) {
      if (row.kind === 'coalescing') {
        try {
          const message = JSON.parse(row.payload) as GroupContentMessage;
          const bucketKey = this.deps.groupOfflineManager.getOwnBucketKey(message.groupId, message.keyVersion);
          const messageIds = coalescingByBucket.get(bucketKey) ?? [];
          messageIds.push(row.message_id);
          coalescingByBucket.set(bucketKey, messageIds);
        } catch (error: unknown) {
          log(`[GROUP-OFFLINE][RECOVER] failed to rehydrate coalescing msgId=${row.message_id}: ${errStr(error)}`);
        }
        continue;
      }

      try {
        this.pendingOfflineBackups.set(row.message_id, JSON.parse(row.payload) as GroupContentMessage);
      } catch (error: unknown) {
        log(`[GROUP-OFFLINE][RECOVER] failed to rehydrate msgId=${row.message_id}: ${errStr(error)}`);
      }
    }

    if (coalescingByBucket.size > 0) {
      log(
        `[GROUP-OFFLINE][BACKSTOP][RECOVER] buckets=${coalescingByBucket.size} ` +
        `reason=unflushed_at_prior_shutdown; flushing now`,
      );
      for (const [bucketKey, messageIds] of coalescingByBucket) {
        this.pendingBackstopBuckets.set(bucketKey, new Set(messageIds));
        void this.flushBackstopBucket(bucketKey).catch((error: unknown) => {
          generalErrorHandler(error, '[GROUP-OFFLINE] Startup backstop flush failed for a recovered bucket');
        });
      }
    }

    log(`[GROUP-OFFLINE][RECOVER] rehydrated ${this.pendingOfflineBackups.size} pending backup(s) for manual retry`);
  }

  /**
   * Queue a live-delivered ("backstop") message's offline-bucket write for
   * coalesced, batched delivery instead of writing it immediately. Persists
   * the payload durably FIRST (so a crash mid-window loses nothing on
   * restart), then arms a flush timer only for the first message to join an
   * otherwise-empty window — later arrivals in the same window just join the
   * batch the already-armed timer will pick up, bounding the added delay at
   * GROUP_OFFLINE_BACKSTOP_COALESCE_WINDOW_MS regardless of send volume.
   */
  private queueBackstopWrite(bucketKey: string, chatId: number, message: GroupContentMessage): void {
    this.deps.database.upsertPendingGroupOfflineBackup({
      messageId: message.messageId,
      chatId,
      groupId: message.groupId,
      payload: JSON.stringify(message),
      kind: 'coalescing',
    });

    let queued = this.pendingBackstopBuckets.get(bucketKey);
    if (!queued) {
      queued = new Set<string>();
      this.pendingBackstopBuckets.set(bucketKey, queued);
    }
    queued.add(message.messageId);

    if (this.backstopFlushTimers.has(bucketKey)) {
      log(
        `[GROUP-OFFLINE][BACKSTOP][QUEUE] bucket=*${bucketKey.slice(-12)} msgId=${message.messageId} ` +
        `pending=${queued.size} reason=window_already_armed`,
      );
      return;
    }

    const timer = setTimeout(() => {
      this.backstopFlushTimers.delete(bucketKey);
      void this.flushBackstopBucket(bucketKey).catch((error: unknown) => {
        generalErrorHandler(error, '[GROUP-OFFLINE] Backstop coalesced flush failed');
      });
    }, GROUP_OFFLINE_BACKSTOP_COALESCE_WINDOW_MS);
    this.backstopFlushTimers.set(bucketKey, timer);
    log(
      `[GROUP-OFFLINE][BACKSTOP][QUEUE] bucket=*${bucketKey.slice(-12)} msgId=${message.messageId} pending=1 ` +
      `windowMs=${GROUP_OFFLINE_BACKSTOP_COALESCE_WINDOW_MS} reason=window_armed`,
    );
  }

  /**
   * Flush a bucket's coalesced batch in a single DHT put. On success the
   * durable rows are cleared. On genuine failure, falls back to exactly the
   * pre-existing "backup failed after online delivery" UX for each affected
   * message (durable row kept + reclassified, message row marked
   * failed/offline_backup, manual "Retry offline backup" available) — the
   * same outcome the old immediate-write path produced on a failed put.
   */
  private async flushBackstopBucket(bucketKey: string): Promise<void> {
    const queued = this.pendingBackstopBuckets.get(bucketKey);
    if (!queued || queued.size === 0) return;
    this.pendingBackstopBuckets.delete(bucketKey);

    const messageIds = new Set(queued);
    const rows = this.deps.database.getAllPendingGroupOfflineBackups()
      .filter((row) => messageIds.has(row.message_id) && row.kind === 'coalescing');
    if (rows.length === 0) return;

    // Only rows that parse successfully participate below (an unparseable
    // payload is dropped + its durable row removed immediately — it can
    // never become writable, so keeping it around would wedge the batch).
    const messages: GroupContentMessage[] = [];
    const parsedRows: typeof rows = [];
    for (const row of rows) {
      try {
        messages.push(JSON.parse(row.payload) as GroupContentMessage);
        parsedRows.push(row);
      } catch (error: unknown) {
        log(`[GROUP-OFFLINE][BACKSTOP][FLUSH][DROP] msgId=${row.message_id} reason=payload_parse_failed: ${errStr(error)}`);
        this.deps.database.deletePendingGroupOfflineBackup(row.message_id);
      }
    }
    if (messages.length === 0) return;

    try {
      await this.deps.groupOfflineManager.storeGroupMessages(messages);
      for (const row of parsedRows) {
        this.deps.database.deletePendingGroupOfflineBackup(row.message_id);
      }
      log(`[GROUP-OFFLINE][BACKSTOP][FLUSH][DONE] bucket=*${bucketKey.slice(-12)} count=${messages.length}`);
    } catch (error: unknown) {
      const errorText = errStr(error);
      console.warn(
        `[GROUP-OFFLINE] Backstop coalesced write failed bucket=*${bucketKey.slice(-12)} count=${messages.length}: ${errorText}`,
      );
      for (const row of parsedRows) {
        const message = messages.find((m) => m.messageId === row.message_id);
        if (!message) continue;
        this.pendingOfflineBackups.set(row.message_id, message);
        this.deps.database.upsertPendingGroupOfflineBackup({
          messageId: row.message_id,
          chatId: row.chat_id,
          groupId: row.group_id,
          payload: row.payload,
          kind: 'failed_retry',
        });
        this.deps.database.updateMessageSendState(row.message_id, 'failed', 'offline_backup');
      }
    }
  }

  /** Flush every currently-pending backstop bucket (used on app quit). */
  private async flushAllBackstopBuckets(reason: string): Promise<void> {
    const bucketKeys = new Set<string>([
      ...this.pendingBackstopBuckets.keys(),
      ...this.backstopFlushTimers.keys(),
    ]);
    if (bucketKeys.size === 0) return;

    log(`[GROUP-OFFLINE][BACKSTOP][FLUSH][ALL] reason=${reason} buckets=${bucketKeys.size}`);
    for (const timer of this.backstopFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.backstopFlushTimers.clear();

    await Promise.all(
      Array.from(bucketKeys).map((bucketKey) => this.flushBackstopBucket(bucketKey).catch((error: unknown) => {
        generalErrorHandler(error, `[GROUP-OFFLINE] ${reason} backstop flush failed for a bucket`);
      })),
    );
  }

  /**
   * Rotation-triggered flush: the offline bucket is epoch-scoped, so a
   * backstop write still waiting out its coalescing window when the group
   * rotates to a new epoch must land in ITS (the old) epoch's bucket before
   * the old epoch is torn down. Called for both self-initiated rotations
   * (creator, via onRegisterPrevEpochGrace) and rotations learned from an
   * incoming GROUP_STATE_UPDATE (existing member). A no-op when nothing is
   * pending for that epoch's bucket. The GROUP_ROTATION_GRACE_WINDOW_MS
   * (60s) old-epoch grace period comfortably covers the coalescing window
   * (20s) even without this hook; this makes the guarantee explicit instead
   * of relying on that margin.
   */
  flushBackstopForEpoch(groupId: string, keyVersion: number): void {
    const bucketKey = this.deps.groupOfflineManager.getOwnBucketKey(groupId, keyVersion);
    const timer = this.backstopFlushTimers.get(bucketKey);
    if (!timer && !this.pendingBackstopBuckets.has(bucketKey)) return;

    if (timer) {
      clearTimeout(timer);
      this.backstopFlushTimers.delete(bucketKey);
    }
    log(
      `[GROUP-OFFLINE][BACKSTOP][FLUSH][ROTATION] group=${groupId.slice(0, 8)} keyVersion=${keyVersion} ` +
      `bucket=*${bucketKey.slice(-12)}`,
    );
    void this.flushBackstopBucket(bucketKey).catch((error: unknown) => {
      generalErrorHandler(error, `[GROUP-OFFLINE] Rotation-triggered backstop flush failed for group=${groupId}`);
    });
  }

  private scheduleReconcile(delayMs: number): void {
    if (this.peerConnectDebounceTimer) {
      clearTimeout(this.peerConnectDebounceTimer);
    }
    this.peerConnectDebounceTimer = setTimeout(() => {
      this.peerConnectDebounceTimer = null;
      void this.reconcileSubscriptions();
    }, delayMs);
  }

  private ensureTopicSubscription(ctx: GroupContext): void {
    const existingTopic = this.groupTopics.get(ctx.groupId);
    if (existingTopic && existingTopic !== ctx.topic) {
      const oldCtx = this.resolveStoredGroupContextByTopic(ctx.groupId, existingTopic);
      if (oldCtx) {
        this.addGraceContext(oldCtx);
      } else {
        // If we can't resolve old context metadata, avoid holding a stale subscription forever.
        this.unsubscribeTopic(existingTopic, `topic-switch-no-old-context group=${ctx.groupId}`);
      }
    }

    this.subscribeTopic(ctx.topic, `ensure group=${ctx.groupId} keyVersion=${ctx.keyVersion}`, true);

    this.groupTopics.set(ctx.groupId, ctx.topic);
  }

  private addGraceContext(ctx: GroupContext): void {
    const now = Date.now();
    const expiresAt = now + GROUP_OLD_TOPIC_SUBSCRIPTION_GRACE_MS;
    const existing = this.groupGraceContexts.get(ctx.groupId) ?? [];

    const filtered = existing.filter((entry) => entry.keyVersion !== ctx.keyVersion);
    filtered.push({ ...ctx, expiresAt });
    this.groupGraceContexts.set(ctx.groupId, filtered);

    const timerKey = `${ctx.groupId}:${ctx.keyVersion}`;
    const existingTimer = this.graceTopicTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      this.graceTopicTimers.delete(timerKey);
      this.expireGraceContext(ctx.groupId, ctx.keyVersion);
    }, GROUP_OLD_TOPIC_SUBSCRIPTION_GRACE_MS);
    this.graceTopicTimers.set(timerKey, timer);

      log(
        `[GROUP-MSG] Keeping previous topic for grace window group=${ctx.groupId} keyVersion=${ctx.keyVersion} ` +
        `graceMs=${GROUP_OLD_TOPIC_SUBSCRIPTION_GRACE_MS}`,
      );
  }

  private expireGraceContext(groupId: string, keyVersion: number): void {
    const existing = this.groupGraceContexts.get(groupId);
    if (!existing) return;

    const target = existing.find((entry) => entry.keyVersion === keyVersion);
    const remaining = existing.filter((entry) => entry.keyVersion !== keyVersion);
    if (remaining.length > 0) {
      this.groupGraceContexts.set(groupId, remaining);
    } else {
      this.groupGraceContexts.delete(groupId);
    }

    if (!target) return;
    this.unsubscribeTopicIfUnused(target.topic);
  }

  private clearGraceContextsForGroup(groupId: string): void {
    const existing = this.groupGraceContexts.get(groupId);
    if (!existing) return;

    for (const context of existing) {
      const timerKey = `${groupId}:${context.keyVersion}`;
      const timer = this.graceTopicTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.graceTopicTimers.delete(timerKey);
      }
      this.unsubscribeTopicIfUnused(context.topic);
    }
    this.groupGraceContexts.delete(groupId);
  }

  private scheduleRekeyContextMissOfflineCheck(groupId: string, chatId: number, messageId: string): void {
    if (this.rekeyContextMissTimers.has(groupId)) {
      log(
        `[GROUP-MSG][REKEY-FETCH][SKIP] group=${groupId} chatId=${chatId} reason=already_scheduled msgId=${messageId}`,
      );
      return;
    }

    const delayMs = 10_000;
    log(
      `[GROUP-MSG][REKEY-FETCH][SCHEDULE] group=${groupId} chatId=${chatId} delayMs=${delayMs} msgId=${messageId}`,
    );
    const timer = setTimeout(() => {
      this.rekeyContextMissTimers.delete(groupId);
      void (async () => {
        const startedAt = Date.now();
        try {
          const result = await this.deps.groupOfflineManager.checkGroupOfflineMessages([chatId], { mode: 'nudge' });
          const unread = Array.from(result.unreadFromChats.values()).reduce((sum, count) => sum + count, 0);
          log(
            `[GROUP-MSG][REKEY-FETCH][DONE] group=${groupId} chatId=${chatId} checked=${result.checkedChatIds.length} unread=${unread} took=${Date.now() - startedAt}ms`,
          );
        } catch (error: unknown) {
          console.warn(
            `[GROUP-MSG][REKEY-FETCH][FAIL] group=${groupId} chatId=${chatId} reason=${errStr(error)}`,
          );
        }
      })();
    }, delayMs);
    this.rekeyContextMissTimers.set(groupId, timer);
  }

  private unsubscribeTopicIfUnused(topic: string): void {
    const inCurrent = Array.from(this.groupTopics.values()).includes(topic);
    if (inCurrent) return;

    const inGrace = Array.from(this.groupGraceContexts.values())
      .some((entries) => entries.some((entry) => entry.topic === topic && entry.expiresAt > Date.now()));
    if (inGrace) return;

    this.unsubscribeTopic(topic, 'unused-topic-expired');
  }

  private subscribeTopic(topic: string, reason: string, throwOnError = false): void {
    const shortTopic = `${topic.slice(0, 16)}...`;
    const currentlySubscribed = this.deps.node.services.pubsub.getTopics().includes(topic);
    if (currentlySubscribed) {
      log(`[GROUP-TOPIC][SUBSCRIBE][SKIP_ALREADY] reason=${reason} topic=${shortTopic}`);
      return;
    }

    log(`[GROUP-TOPIC][SUBSCRIBE][ATTEMPT] reason=${reason} topic=${shortTopic}`);
    try {
      this.deps.node.services.pubsub.subscribe(topic);
      const isNowSubscribed = this.deps.node.services.pubsub.getTopics().includes(topic);
      if (isNowSubscribed) {
        log(`[GROUP-TOPIC][SUBSCRIBE][SUCCESS] reason=${reason} topic=${shortTopic}`);
      } else {
        console.warn(`[GROUP-TOPIC][SUBSCRIBE][UNKNOWN] reason=${reason} topic=${shortTopic} state=not_listed_after_subscribe`);
      }
    } catch (error: unknown) {
      console.error(`[GROUP-TOPIC][SUBSCRIBE][FAIL] reason=${reason} topic=${shortTopic} error=${errStr(error)}`);
      if (throwOnError) {
        throw error;
      }
    }
  }

  private unsubscribeTopic(topic: string, reason: string): void {
    const shortTopic = `${topic.slice(0, 16)}...`;
    const currentlySubscribed = this.deps.node.services.pubsub.getTopics().includes(topic);
    if (!currentlySubscribed) {
      log(`[GROUP-TOPIC][UNSUBSCRIBE][SKIP_NOT_SUBSCRIBED] reason=${reason} topic=${shortTopic}`);
      return;
    }

    log(`[GROUP-TOPIC][UNSUBSCRIBE][ATTEMPT] reason=${reason} topic=${shortTopic}`);
    try {
      this.deps.node.services.pubsub.unsubscribe(topic);
      const stillSubscribed = this.deps.node.services.pubsub.getTopics().includes(topic);
      if (!stillSubscribed) {
        log(`[GROUP-TOPIC][UNSUBSCRIBE][SUCCESS] reason=${reason} topic=${shortTopic}`);
      } else {
        console.warn(`[GROUP-TOPIC][UNSUBSCRIBE][UNKNOWN] reason=${reason} topic=${shortTopic} state=still_listed_after_unsubscribe`);
      }
    } catch (error: unknown) {
      console.error(`[GROUP-TOPIC][UNSUBSCRIBE][FAIL] reason=${reason} topic=${shortTopic} error=${errStr(error)}`);
    }
  }

  private resolveStoredGroupContextByTopic(groupId: string, topic: string): GroupContext | null {
    const chat = this.deps.database.getChatByGroupId(groupId);
    if (!chat) return null;

    const history = this.deps.database.getGroupKeyHistory(groupId)
      .sort((a, b) => b.key_version - a.key_version);

    for (const epoch of history) {
      const keyBase64 = this.deps.database.getGroupKeyForEpoch(groupId, epoch.key_version);
      if (!keyBase64) continue;
      const keyBytes = Buffer.from(keyBase64, 'base64');
      if (keyBytes.length !== 32) continue;
      const derivedTopic = this.deriveTopic(groupId, keyBytes);
      if (derivedTopic !== topic) continue;

      return {
        groupId,
        chatId: chat.id,
        keyVersion: epoch.key_version,
        groupKey: keyBytes,
        topic: derivedTopic,
      };
    }

    return null;
  }

  private async publishWithRetry(ctx: GroupContext, payload: Uint8Array): Promise<boolean> {
    try {
      await this.publish(ctx.topic, payload);
      log(`[GROUP-MSG][PUBLISH] group=${ctx.groupId.slice(0, 8)} attempt=1 ok`);
      return true;
    } catch (firstError: unknown) {
      if (!this.isRetryablePublishError(firstError)) {
        log(`[GROUP-MSG][PUBLISH] group=${ctx.groupId.slice(0, 8)} attempt=1 fail_non_retryable`);
        throw firstError;
      }
      console.warn(`[GROUP-MSG] Retrying publish for group=${ctx.groupId} after error: `, firstError);
    }

    this.ensureTopicSubscription(ctx);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, GROUP_PUBLISH_RETRY_DELAY_MS);
    });
    try {
      await this.publish(ctx.topic, payload);
      log(`[GROUP-MSG][PUBLISH] group=${ctx.groupId.slice(0, 8)} attempt=2 ok`);
      return true;
    } catch (secondError: unknown) {
      if (this.isRetryablePublishError(secondError)) {
        console.warn(`[GROUP-MSG] Falling back to offline delivery for group=${ctx.groupId}`);
        return false;
      }
      log(`[GROUP-MSG][PUBLISH] group=${ctx.groupId.slice(0, 8)} attempt=2 fail_non_retryable`);
      throw secondError;
    }
  }

  private isRetryablePublishError(error: unknown): boolean {
    return errStr(error).includes(GROUP_PUBLISH_RETRYABLE_ERROR);
  }

  private async publishHeartbeats(): Promise<void> {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const groupIds = Array.from(this.groupTopics.keys());
      await Promise.allSettled(
        groupIds.map(async (groupId) => {
          await this.sendHeartbeat(groupId);
        }),
      );
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async sendHeartbeat(groupId: string): Promise<void> {
    const ctx = this.resolveActiveGroupContext(groupId);
    this.ensureTopicSubscription(ctx);

    const heartbeat: Omit<GroupHeartbeatMessage, 'signature'> = {
      type: GroupMessageType.GROUP_MESSAGE,
      groupId,
      keyVersion: ctx.keyVersion,
      senderPeerId: this.deps.myPeerId,
      messageId: randomUUID(),
      timestamp: Date.now(),
      messageType: 'heartbeat',
    };
    const signedHeartbeat: GroupChatMessage = {
      ...heartbeat,
      signature: this.sign(heartbeat),
    };

    const payload = new TextEncoder().encode(JSON.stringify(signedHeartbeat));
    try {
      await this.publish(ctx.topic, payload);
    } catch {
      // Keep-alive is best effort.
    }
  }

  private async publish(topic: string, payload: Uint8Array): Promise<void> {
    const result = await this.deps.node.services.pubsub.publish(topic, payload);
    const recipients = result.recipients ?? [];
    const remoteRecipients = recipients.filter((peerId) => peerId.toString() !== this.deps.myPeerId);

    if (remoteRecipients.length === 0) {
      throw new Error(GROUP_PUBLISH_RETRYABLE_ERROR);
    }
  }

  private resolveActiveGroupContext(groupId: string): GroupContext {
    const chat = this.deps.database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);
    if (chat.status !== 'active' || chat.group_status !== 'active') {
      throw new Error(`Group ${groupId} is not active`);
    }
    if ((chat.key_version ?? 0) <= 0) {
      throw new Error(`Group ${groupId} has no active key version`);
    }

    const keyBase64 = this.deps.database.getGroupKeyForEpoch(groupId, chat.key_version);
    if (!keyBase64) {
      throw new Error(`Missing key material for group ${groupId} v${chat.key_version}`);
    }

    const keyBytes = Buffer.from(keyBase64, 'base64');
    if (keyBytes.length !== 32) {
      throw new Error(`Invalid group key length for ${groupId} v${chat.key_version}`);
    }

    return {
      groupId,
      chatId: chat.id,
      keyVersion: chat.key_version,
      groupKey: keyBytes,
      topic: this.deriveTopic(groupId, keyBytes),
    };
  }

  private resolveIncomingGroupContext(groupId: string, keyVersion: number, incomingTopic: string): GroupContext | null {
    const chat = this.deps.database.getChatByGroupId(groupId);
    if (!chat) return null;
    if (chat.status !== 'active') return null;
    if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') return null;

    if (chat.key_version === keyVersion) {
      const keyBase64 = this.deps.database.getGroupKeyForEpoch(groupId, keyVersion);
      if (!keyBase64) return null;

      const keyBytes = Buffer.from(keyBase64, 'base64');
      if (keyBytes.length !== 32) return null;

      const expectedTopic = this.deriveTopic(groupId, keyBytes);
      if (expectedTopic !== incomingTopic) return null;

      return {
        groupId,
        chatId: chat.id,
        keyVersion,
        groupKey: keyBytes,
        topic: expectedTopic,
      };
    }

    const graceContexts = this.groupGraceContexts.get(groupId) ?? [];
    const now = Date.now();
    const liveGrace = graceContexts.filter((entry) => entry.expiresAt > now);
    if (liveGrace.length !== graceContexts.length) {
      if (liveGrace.length > 0) {
        this.groupGraceContexts.set(groupId, liveGrace);
      } else {
        this.groupGraceContexts.delete(groupId);
      }
    }

    const graceMatch = liveGrace.find(
      (entry) => entry.keyVersion === keyVersion && entry.topic === incomingTopic,
    );
    if (!graceMatch) return null;
    return {
      groupId,
      chatId: chat.id,
      keyVersion: graceMatch.keyVersion,
      groupKey: graceMatch.groupKey,
      topic: graceMatch.topic,
    };
  }

  private deriveTopic(groupId: string, groupKey: Uint8Array): string {
    const keyHash = createHash('sha256').update(groupKey).digest('hex');
    const rawTopic = createHash('sha256').update(groupId + keyHash).digest('hex');
    return this.buildPubsubTopic(rawTopic);
  }

  private sign(payload: Omit<GroupChatMessage, 'signature'>): string {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signatureBytes = ed25519.sign(payloadBytes, this.deps.userIdentity.signingPrivateKey);
    return Buffer.from(signatureBytes).toString('base64');
  }

  private verifySignature(message: GroupChatMessage, signingPubKeyBase64: string): boolean {
    try {
      const { signature, ...payload } = message;
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes = Buffer.from(signature, 'base64');
      const pubKeyBytes = Buffer.from(signingPubKeyBase64, 'base64');
      return ed25519.verify(sigBytes, payloadBytes, pubKeyBytes);
    } catch {
      return false;
    }
  }

  private encryptContent(content: string, key: Uint8Array, nonce: Uint8Array): string {
    const bytes = new TextEncoder().encode(content);
    const cipher = xchacha20poly1305(key, nonce);
    const encrypted = cipher.encrypt(bytes);
    return Buffer.from(encrypted).toString('base64');
  }

  private decryptContent(encryptedContent: string, key: Uint8Array, nonceBase64: string): string {
    const nonce = Buffer.from(nonceBase64, 'base64');
    const encryptedBytes = Buffer.from(encryptedContent, 'base64');
    const cipher = xchacha20poly1305(key, nonce);
    const decrypted = cipher.decrypt(encryptedBytes);
    return new TextDecoder().decode(decrypted);
  }

  private hasLiveGroupCallHintInLocalMirror(ctx: GroupContext): boolean {
    const ownPubKeyBase64url = toBase64Url(this.deps.userIdentity.signingPublicKey);
    const bucketKey = `${getNetworkModeRuntime(this.deps.database.getSessionNetworkMode()).config.dhtNamespaces.groupOffline}/${ctx.groupId}/${ctx.keyVersion}/${ownPubKeyBase64url}`;
    const local = this.deps.database.getGroupOfflineSentMessages(bucketKey);
    const cutoff = Date.now() - GROUP_OFFLINE_MESSAGE_TTL_MS;
    const maxAllowedTimestamp = Date.now() + GROUP_MESSAGE_MAX_FUTURE_SKEW_MS;

    return local.messages.some((message) => {
      if (
        message.messageType !== 'system'
        || message.timestamp < cutoff
        || message.timestamp > maxAllowedTimestamp
      ) {
        return false;
      }

      try {
        const content = this.decryptContent(message.encryptedContent, ctx.groupKey, message.nonce);
        const parsed = JSON.parse(content);
        return isGroupCallHintSystemPayload(parsed) && parsed.groupId === ctx.groupId;
      } catch {
        return false;
      }
    });
  }

  private async handleIncomingPubsubEvent(detail: unknown): Promise<void> {
    try {
      if (!detail || typeof detail !== 'object') return;
      const maybe = detail as { topic?: unknown; data?: unknown };
      if (typeof maybe.topic !== 'string') return;
      if (!(maybe.data instanceof Uint8Array)) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(maybe.data));
      } catch {
        return;
      }

      if (!this.isGroupChatMessage(parsed)) return;
      if (parsed.type !== GroupMessageType.GROUP_MESSAGE) return;
      const topicShort = `${maybe.topic.slice(0, 16)}...`;
      const msgTag =
        `group=${parsed.groupId} keyVersion=${parsed.keyVersion} msgId=${parsed.messageId} ` +
        `sender=${parsed.senderPeerId.slice(-8)} seq=${parsed.messageType === 'heartbeat' ? 'n/a' : parsed.seq} topic=${topicShort}`;
      log(`[GROUP-MSG][IN][RAW] ${msgTag}`);

      if (!this.hasValidTimestamp(parsed)) {
        log(`[GROUP-MSG][IN][DROP] reason=invalid_timestamp ${msgTag} now=${Date.now()} msgTs=${parsed.timestamp}`);
        return;
      }
      // emitSelf can deliver our own publish back; local message is already inserted on send.
      if (parsed.senderPeerId === this.deps.myPeerId) {
        log(`[GROUP-MSG][IN][DROP] reason=self_echo ${msgTag}`);
        return;
      }

      const ctx = this.resolveIncomingGroupContext(parsed.groupId, parsed.keyVersion, maybe.topic);
      if (!ctx) {
        const chat = this.deps.database.getChatByGroupId(parsed.groupId);
        log(
          `[GROUP-MSG][IN][DROP] reason=context_miss ${msgTag} ` +
          `chatExists=${!!chat} chatStatus=${chat?.status ?? 'n/a'} groupStatus=${chat?.group_status ?? 'n/a'} ` +
          `chatKeyVersion=${chat?.key_version ?? 'n/a'}`,
        );
        if (chat?.group_status === 'rekeying') {
          this.scheduleRekeyContextMissOfflineCheck(parsed.groupId, chat.id, parsed.messageId);
        }
        return;
      }

      const participants = this.deps.database.getChatParticipants(ctx.chatId);
      if (!participants.some(p => p.peer_id === parsed.senderPeerId)) {
        log(
          `[GROUP-MSG][IN][DROP] reason=sender_not_participant ${msgTag} chatId=${ctx.chatId} participants=${participants.length}`,
        );
        return;
      }

      const sender = this.deps.database.getUserByPeerId(parsed.senderPeerId);
      if (!sender) {
        log(`[GROUP-MSG][IN][DROP] reason=unknown_sender ${msgTag}`);
        return;
      }
      if (!this.verifySignature(parsed, sender.signing_public_key)) {
        log(`[GROUP-MSG][IN][DROP] reason=bad_signature ${msgTag}`);
        return;
      }

      if (parsed.messageType === 'heartbeat') {
        log(`[GROUP-MSG][IN][SKIP] reason=heartbeat ${msgTag}`);
        return;
      }

      const highestSeenSeq = this.deps.database.getMemberSeq(parsed.groupId, parsed.keyVersion, parsed.senderPeerId);
      if (parsed.seq <= highestSeenSeq) {
        log(
          `[GROUP-MSG][IN][DROP] reason=seq_not_new ${msgTag} highestSeenSeq=${highestSeenSeq}`,
        );
        return;
      }

      const decrypted = this.decryptContent(parsed.encryptedContent, ctx.groupKey, parsed.nonce);
      let inserted = false;
      if (parsed.messageType === 'system') {
        ({ inserted } = await this.deps.database.tryCreateMessage({
          id: parsed.messageId,
          chat_id: ctx.chatId,
          sender_peer_id: parsed.senderPeerId,
          content: decrypted,
          message_type: 'system',
          timestamp: new Date(parsed.timestamp),
          client_msg_id: parsed.messageId,
          reply_to_client_id: null,
        }, { dedupe: 'any' }));
        if (inserted) {
          this.deps.onMessageReceived({
            chatId: ctx.chatId,
            messageId: parsed.messageId,
            content: decrypted,
            senderPeerId: parsed.senderPeerId,
            senderUsername: sender.username,
            timestamp: parsed.timestamp,
            messageSentStatus: 'online',
            messageType: 'system',
            clientMsgId: parsed.messageId,
          });
        }
      } else {
        const routeNonText = (
          message: InboundApplicationMessageContext['message'],
        ): boolean | Promise<boolean> => this.deps.onApplicationMessage({
          message,
          chatId: ctx.chatId,
          senderPeerId: parsed.senderPeerId,
          senderUsername: sender.username,
          timestamp: parsed.timestamp,
          transportMessageId: parsed.messageId,
          route: 'group_realtime',
        });
        const dispatched = await dispatchEnvelope(decrypted, {
          text: async ({ payload }) => {
            const result = await this.deps.database.tryCreateMessage({
              id: parsed.messageId,
              chat_id: ctx.chatId,
              sender_peer_id: parsed.senderPeerId,
              content: payload.text,
              message_type: 'text',
              timestamp: new Date(parsed.timestamp),
              client_msg_id: parsed.messageId,
              reply_to_client_id: payload.reply_to ?? null,
            }, { dedupe: 'any' });
            if (result.inserted) {
              this.deps.onMessageReceived({
                chatId: ctx.chatId,
                messageId: parsed.messageId,
                content: payload.text,
                senderPeerId: parsed.senderPeerId,
                senderUsername: sender.username,
                timestamp: parsed.timestamp,
                messageSentStatus: 'online',
                messageType: 'text',
                clientMsgId: parsed.messageId,
                replyToClientId: payload.reply_to,
              });
            }
            return result.inserted;
          },
          file_offer: routeNonText,
          file_offer_cancel: routeNonText,
          file_offer_nack: routeNonText,
        }, { expectedCid: parsed.messageId });
        // TEMP_LOG: temporary group application-message dispatch diagnostics; remove after Phase 2a delivery debugging.
        log(
          `[TEMP_LOG][APP-MESSAGE][GROUP][DISPATCH] ${msgTag} status=${dispatched.status} `
          + `value=${dispatched.status === 'handled' ? String(dispatched.value) : 'n/a'}`
          + `${dispatched.status === 'unhandled' ? ` kind=${dispatched.message.kind}` : ''}`
          + `${dispatched.status === 'rejected' ? ` reason=${dispatched.reason}` : ''}`,
        );
        inserted = dispatched.status === 'handled' && dispatched.value;
        if (dispatched.status === 'rejected') {
          log(`[APP-MESSAGE][GROUP][DROP] ${msgTag} reason=${dispatched.reason}`);
        } else if (dispatched.status === 'unhandled') {
          log(`[APP-MESSAGE][GROUP][DROP] ${msgTag} reason=unhandled_kind kind=${dispatched.message.kind}`);
        }
      }

      // Cursor/seq must advance even for a deduped duplicate (idempotent), or we'd
      // reprocess it forever. Only the "received" event is gated on `inserted`.
      this.deps.database.updateMemberSeq(parsed.groupId, parsed.keyVersion, parsed.senderPeerId, parsed.seq);

      if (!inserted) {
        log(`[GROUP-MSG][IN][SKIP] reason=not_inserted ${msgTag}`);
        return;
      }

      log(`[GROUP-MSG][IN][APPLY] ${msgTag} chatId=${ctx.chatId}`);
    } catch (error: unknown) {
      generalErrorHandler(error, '[GROUP-MSG] Failed to handle incoming pubsub message');
    }
  }

  private isGroupChatMessage(value: unknown): value is GroupChatMessage {
    if (!value || typeof value !== 'object') return false;
    const msg = value as Record<string, unknown>;
    const hasCommonFields = (
      msg.type === GroupMessageType.GROUP_MESSAGE &&
      typeof msg.groupId === 'string' &&
      typeof msg.keyVersion === 'number' &&
      Number.isInteger(msg.keyVersion) &&
      msg.keyVersion > 0 &&
      typeof msg.senderPeerId === 'string' &&
      isValidCid(msg.messageId) &&
      typeof msg.timestamp === 'number' &&
      typeof msg.messageType === 'string' &&
      (msg.messageType === 'text' || msg.messageType === 'system' || msg.messageType === 'heartbeat') &&
      typeof msg.signature === 'string'
    );
    if (!hasCommonFields) return false;

    if (msg.messageType === 'heartbeat') {
      return !('seq' in msg) && !('encryptedContent' in msg) && !('nonce' in msg);
    }

    return (
      typeof msg.seq === 'number' &&
      Number.isInteger(msg.seq) &&
      msg.seq > 0 &&
      typeof msg.encryptedContent === 'string' &&
      typeof msg.nonce === 'string'
    );
  }

  private hasValidTimestamp(message: GroupChatMessage): boolean {
    const now = Date.now();
    if (message.timestamp > now + GROUP_MESSAGE_MAX_FUTURE_SKEW_MS) {
      return false;
    }
    if (message.messageType === 'heartbeat') {
      return message.timestamp >= now - GROUP_HEARTBEAT_MAX_AGE_MS;
    }
    return message.timestamp >= now - GROUP_MESSAGE_MAX_AGE_MS;
  }
}
