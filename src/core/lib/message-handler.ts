import { peerIdFromString } from '@libp2p/peer-id';
import type {
  ChatNode,
  StreamHandlerContext,
  AuthenticatedEncryptedMessage,
  OfflineMessage,
  OfflineSenderInfo,
  ConversationSession,
  EncryptedMessage,
  ContactMode,
  KeyExchangeEvent,
  ContactRequestEvent,
  ContactRequestCancelledEvent,
  ChatCreatedEvent,
  KeyExchangeFailedEvent,
  MessageReceivedEvent,
  MessageSendStateChangedEvent,
  MessageConnectivityFailure,
  OfflineInboxCapacityChangedEvent,
  OfflineInboxCapacitySnapshot,
  SendMessageResponse,
  StrippedMessage,
  MessageSentStatus,
  FileTransferProgressEvent,
  FileTransferCompleteEvent,
  FileTransferFailedEvent,
  OutgoingFileOfferPendingEvent,
  OutgoingFileOfferTerminalEvent,
  PendingFileReceivedEvent,
  PendingFileOfferDeferredEvent,
  GroupChatActivatedEvent,
  GroupMembersUpdatedEvent,
  GroupOfflineGapWarning,
  CallIncomingEvent,
  CallSignalReceivedEvent,
  CallStateChangedEvent,
  CallActionFailureReason,
  CallActionResponse,
  CallErrorEvent,
  CallSignalOutgoingInput,
  CallSignalMessage,
  CallSignalType,
  UnsignedCallSignalMessage,
  CallMediaType,
} from '../types.js';
import {
  CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES,
  MESSAGE_TIMEOUT,
  SESSION_MANAGER_CLEANUP_INTERVAL,
  BUCKET_NUDGE_COOLDOWN_MS,
  BUCKET_NUDGE_DIAL_TIMEOUT_MS,
  BUCKET_NUDGE_FETCH_DELAY_MS,
  DIRECT_OFFLINE_REFETCH_DELAY_MS,
  DIRECT_OFFLINE_INBOX_RECOVERY_COOLDOWN_MS,
  DIRECT_OFFLINE_INBOX_RECOVERY_RECHECK_DELAY_MS,
  BUCKET_NUDGE_RETRY_DELAY_MS,
  GROUP_ACK_REPUBLISH_STARTUP_DELAY,
  GROUP_ACK_REPUBLISH_INTERVAL,
  GROUP_ACK_REPUBLISH_JITTER,
  GROUP_INFO_REPUBLISH_STARTUP_DELAY,
  GROUP_INFO_REPUBLISH_INTERVAL,
  GROUP_INFO_REPUBLISH_JITTER,
  GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS,
  OFFLINE_ACK_MAX_FUTURE_SKEW_MS,
  OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS,
  ERRORS,
  getNetworkModeRuntime,
  NETWORK_MODES,
  INBOUND_STREAM_READ_TIMEOUT_MS,
  MAX_BUCKET_NUDGE_ENVELOPE_BYTES,
  MAX_CALL_SIGNAL_ENVELOPE_BYTES,
  MAX_CHAT_ENVELOPE_BYTES,
  MAX_INBOUND_STREAMS_BUCKET_NUDGE,
  MAX_INBOUND_STREAMS_CALL_SIGNAL,
  MAX_INBOUND_STREAMS_CHAT,
  MAX_UNAUTH_KEY_EXCHANGE_GLOBAL,
  MAX_UNAUTH_KEY_EXCHANGE_PER_PEER,
  RESUME_RELAY_GRACE_MS,
  RESUME_RELAY_READY_WAIT_MS,
  RESUME_RELAY_READY_POLL_MS,
} from '../constants.js';
import { triggerFastRelayRefresh } from '../network/relay-keepalive.js';
import { SessionManager } from '../direct/session-manager.js';
import { LeasePool } from './lease-pool.js';
import { MessageEncryption } from '../direct/message-encryption.js';
import {
  dispatchEnvelope,
  encodeApplicationEnvelope,
  encodeEnvelope,
  isValidCid,
} from '../protocol/message-envelope.js';
import type {
  ApplicationMessageSendResult,
  InboundApplicationMessageContext,
  SendApplicationMessageRequest,
} from '../protocol/application-message.js';
import { PeerConnectionHandler } from '../direct/peer-connection-handler.js';
import { StreamHandler } from '../transport/stream-handler.js';
import { KeyExchange } from '../direct/key-exchange.js';
import { ChatDatabase, User, type PendingOfflineSend } from '../db/database.js';
import { OfflineMessageManager, redactBucketKey } from '../direct/offline-message-manager.js';
import { OfflineSendQueue } from '../direct/offline-send-queue.js';
import { UsernameRegistry } from '../username/username-registry.js';
import { FileHandler } from './file-handler.js';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import { PeerId } from '@libp2p/interface';
import { GroupMessageType } from '../group/types.js';
import { GroupCreator } from '../group/control/group-creator.js';
import { GroupResponder } from '../group/control/group-responder.js';
import {
  GROUP_OFFLINE_BACKUP_FAILED_MARKER,
  GroupMessaging,
} from '../group/runtime/group-messaging.js';
import { GroupOfflineManager } from '../group/runtime/group-offline-manager.js';
import type { GroupOfflineCheckOptions } from '../group/runtime/group-offline-manager.js';
import { GroupAckRepublisher } from '../group/control/group-ack-republisher.js';
import { GroupInfoRepublisher } from '../group/dht/group-info-republisher.js';
import { dialProtocolWithRelayFallback } from '../transport/protocol-dialer.js';
import { STALE_DIAL_ERROR_PATTERN } from '../transport/dial-errors.js';
import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import { OfflineInboxCapacityService } from '../offline/offline-inbox-capacity.js';
import { log } from '../../shared/logger.js';
import { CallActivityRegistry } from './call-activity-registry.js';
import { GroupCallOrchestrator } from './group-call-orchestrator.js';
import { isGroupCallControlSignalMessage, isGroupCallPairSignalMessage } from './group-call-signaling.js';

type OfflineReadBucketInfo = ReturnType<ChatDatabase['getOfflineReadBucketInfo']>[number];
type OfflineReadBucketInfoForChats = ReturnType<ChatDatabase['getOfflineReadBucketInfoForChats']>[number];
type OfflineReadBucketInfoAny = OfflineReadBucketInfo | OfflineReadBucketInfoForChats;
type OfflineCheckResult = { checkedChatIds: number[]; unreadFromChats: Map<number, number> };
const OFFLINE_DHT_UNAVAILABLE_MARKER = 'no DHT connection';
const OFFLINE_DHT_UNAVAILABLE_MARKER_LOWER = OFFLINE_DHT_UNAVAILABLE_MARKER.toLowerCase();

function hasChatId(info: OfflineReadBucketInfoAny): info is OfflineReadBucketInfoForChats {
  return 'chat_id' in info;
}

type BucketNudgePayload =
  | { kind: 'GROUP_REKEY_REFETCH'; groupId: string }
  | { kind: 'DIRECT_SESSION_RESET' }
  | { kind: 'DIRECT_OFFLINE_REFETCH' };

type ActiveCall = {
  callId: string;
  peerId: string;
  direction: 'incoming' | 'outgoing';
  mediaType: CallMediaType;
  state: 'ringing_out' | 'ringing_in' | 'connecting' | 'active';
};

/**
 * Main message handler that orchestrates all message handling components
 */
export class MessageHandler {
  private static readonly OFFLINE_FALLBACK_REGEX = new RegExp(
    `econnrefused|user is offline|all multiaddr dials failed|message timeout|dial timeout|socks|tor transport|enetunreach|no valid addresses|ehostunreach|etimedout|limited connection|no_reservation|no reservation|failed to connect via relay with status|${STALE_DIAL_ERROR_PATTERN}`,
    'i',
  );
  private static readonly GROUP_CONTROL_MAX_RETRIES = 3;
  private static readonly GROUP_CONTROL_RETRY_TTL_MS = 10 * 60 * 1000;
  private static readonly GROUP_CONTROL_RETRY_CACHE_MAX_ENTRIES = 200;
  private static readonly CALL_SIGNAL_TIMEOUT_MS = 5000;
  private static readonly CALL_SIGNAL_MAX_AGE_MS = 5 * 60 * 1000;
  private static readonly CALL_SIGNAL_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
  private static readonly CALL_OFFER_RETRY_DELAY_MS = 2000;
  private static readonly CALL_SIGNAL_DEDUPE_TTL_MS = 10 * 60 * 1000;
  private static readonly CALL_SIGNAL_DEDUPE_MAX_ENTRIES = 1500;
  private static readonly CALL_CONTROL_STALE_TOLERANCE_MS = 2000;
  private static readonly CALL_SHUTDOWN_HANGUP_MAX_WAIT_MS = 1500;
  private static readonly CALL_RING_STALE_TIMEOUT_MS = 35_000;
  private static readonly CALL_PEER_DISCONNECT_GRACE_MS = 30_000;
  private node: ChatNode;
  private usernameRegistry: UsernameRegistry;
  private sessionManager: SessionManager;
  private keyExchange: KeyExchange;
  private fileHandler: FileHandler;
  private database: ChatDatabase;
  private cleanupPeerEvents: (() => void) | null = null;
  private onMessageReceived: (data: MessageReceivedEvent) => void;
  private onGroupChatActivated: (data: GroupChatActivatedEvent) => void;
  private onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void;
  private onOfflineMessagesFetchComplete: ((chatIds: number[]) => void) | undefined;
  private onCallIncoming: (data: CallIncomingEvent) => void;
  private onCallSignalReceived: (data: CallSignalReceivedEvent) => void;
  private onCallStateChanged: (data: CallStateChangedEvent) => void;
  private onCallError: (data: CallErrorEvent) => void;
  private nudgeCooldowns = new Map<string, number>();
  private nudgeTrailingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private nudgeFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private groupNudgeFetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private groupStateCatchupInFlight = new Set<number>();
  private groupStateCatchupPending = new Map<number, { groupId: string; targetKeyVersion: number; reason: string }>();
  private peerActivityCheckCooldowns = new Map<string, number>();
  private groupAckRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckImmediateRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupAckImmediateTargets = new Set<string>();
  private groupInfoRepublishTimer: ReturnType<typeof setTimeout> | null = null;
  private groupInfoStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private groupControlRetryState = new Map<string, { attempts: number; lastSeenAt: number; lastError: string }>();
  private groupStateResyncRequestCooldowns = new Map<string, number>();
  private groupInfoSyncInFlight = new Map<string, Promise<void>>();
  private groupInfoSyncPending = new Set<string>();
  private offlineCheckRunSeq = 0;
  private lastPowerResumeAt = 0;
  // Bounds concurrent unauthenticated first-contact work (read + key-exchange crypto) on
  // /chat from peers with no session/chat; established peers bypass it (contact headroom).
  private unauthKeyExchangeLeases = new LeasePool(
    MAX_UNAUTH_KEY_EXCHANGE_GLOBAL,
    MAX_UNAUTH_KEY_EXCHANGE_PER_PEER,
  );
  // Single-flight for offline checks, keyed by scope
  private offlineCheckInFlight = new Map<string, Promise<OfflineCheckResult>>();
  private offlineCheckPending = new Map<string, Promise<OfflineCheckResult>>();
  private nudgeSendAttemptSeq = 0;
  private groupOfflineManager: GroupOfflineManager;
  private groupMessaging: GroupMessaging;
  private offlineSendQueue: OfflineSendQueue;
  private groupAckRepublisher: GroupAckRepublisher;
  private groupInfoRepublisher: GroupInfoRepublisher;
  private readonly bucketNudgeProtocol: string;
  private readonly chatProtocol: string;
  private readonly callSignalProtocol: string;
  private readonly expectedOfflineBucketPrefix: string;
  private activeCall: ActiveCall | null = null;
  private activeCallLastControlSignalTs: number | null = null;
  private seenCallSignals = new Map<string, number>();
  private activeCallRingWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCallPeerDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private callActivityRegistry: CallActivityRegistry;
  private groupCallOrchestrator: GroupCallOrchestrator | null;
  private groupCallHintHandler: ((groupId: string) => void | Promise<void>) | null = null;
  private requestReconnect: (() => Promise<boolean>) | null = null;
  private emitMessageSendState: (data: MessageSendStateChangedEvent) => void = () => undefined;
  private emitOfflineInboxCapacityChanged: (data: OfflineInboxCapacityChangedEvent) => void = () => undefined;
  private offlineInboxCapacityService: OfflineInboxCapacityService;
  private readonly directOfflineInboxRecoveryInFlight = new Map<string, Promise<void>>();
  private readonly directOfflineInboxRecoveryCooldowns = new Map<string, number>();

  private formatNudgeTarget(payload: BucketNudgePayload): string {
    if (payload.kind === 'GROUP_REKEY_REFETCH') {
      return `group=${payload.groupId.slice(0, 8)}`;
    }
    return `kind=${payload.kind.toLowerCase()}`;
  }

  private getNudgeConnectionSnapshot(peerId: string): {
    totalConnections: number;
    peerConnectionCount: number;
    peerConnectionAddrs: string;
    peerSuffixes: string;
  } {
    const allConnections = this.node.getConnections();
    const peerConnections = allConnections.filter((conn) => conn.remotePeer.toString() === peerId);
    const peerConnectionAddrs = peerConnections
      .map((conn) => conn.remoteAddr.toString())
      .join(',') || 'none';
    const peerSuffixes = allConnections
      .map((conn) => conn.remotePeer.toString().slice(-8))
      .join(',') || 'none';

    return {
      totalConnections: allConnections.length,
      peerConnectionCount: peerConnections.length,
      peerConnectionAddrs,
      peerSuffixes,
    };
  }

  constructor(
    node: ChatNode,
    usernameRegistry: UsernameRegistry,
    database: ChatDatabase,
    onKeyExchangeSent: (data: KeyExchangeEvent) => void,
    onContactRequestReceived: (data: ContactRequestEvent) => void,
    onContactRequestCancelled: (data: ContactRequestCancelledEvent) => void,
    onChatCreated: (data: ChatCreatedEvent) => void,
    onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void,
    onMessageReceived: (data: MessageReceivedEvent) => void,
    onFileTransferProgress: (data: FileTransferProgressEvent) => void,
    onFileTransferComplete: (data: FileTransferCompleteEvent) => void,
    onFileTransferFailed: (data: FileTransferFailedEvent) => void,
    onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void,
    onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => void,
    onPendingFileReceived: (data: PendingFileReceivedEvent) => void,
    onPendingFileOfferDeferred: (data: PendingFileOfferDeferredEvent) => void,
    onGroupChatActivated: (data: GroupChatActivatedEvent) => void,
    onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void,
    onOfflineMessagesFetchComplete?: (chatIds: number[]) => void,
    onCallIncoming?: (data: CallIncomingEvent) => void,
    onCallSignalReceived?: (data: CallSignalReceivedEvent) => void,
    onCallStateChanged?: (data: CallStateChangedEvent) => void,
    onCallError?: (data: CallErrorEvent) => void,
    callActivityRegistry?: CallActivityRegistry,
    groupCallOrchestrator?: GroupCallOrchestrator,
  ) {
    this.node = node;
    this.usernameRegistry = usernameRegistry;
    this.database = database;
    this.sessionManager = new SessionManager();
    this.onMessageReceived = onMessageReceived;
    this.onGroupChatActivated = onGroupChatActivated;
    this.onGroupMembersUpdated = onGroupMembersUpdated;
    this.onOfflineMessagesFetchComplete = onOfflineMessagesFetchComplete;
    this.onCallIncoming = onCallIncoming ?? (() => undefined);
    this.onCallSignalReceived = onCallSignalReceived ?? (() => undefined);
    this.onCallStateChanged = onCallStateChanged ?? (() => undefined);
    this.onCallError = onCallError ?? (() => undefined);
    this.callActivityRegistry = callActivityRegistry ?? new CallActivityRegistry();
    this.groupCallOrchestrator = groupCallOrchestrator ?? null;
    this.keyExchange = new KeyExchange(
      node,
      usernameRegistry,
      this.sessionManager,
      database,
      onKeyExchangeSent,
      onContactRequestReceived,
      onContactRequestCancelled,
      onChatCreated,
      onKeyExchangeFailed,
      this.handleDirectLinkReset.bind(this)
    );
    this.fileHandler = new FileHandler(
      node,
      this,
      database,
      onFileTransferProgress,
      onFileTransferComplete,
      onFileTransferFailed,
      onOutgoingFileOfferPending,
      onOutgoingFileOfferTerminal,
      onPendingFileReceived,
      onPendingFileOfferDeferred,
    );
    const sessionNetworkMode = database.getSessionNetworkMode();
    const modeConfig = getNetworkModeRuntime(sessionNetworkMode).config;
    this.bucketNudgeProtocol = modeConfig.bucketNudgeProtocol;
    this.chatProtocol = modeConfig.chatProtocol;
    this.callSignalProtocol = modeConfig.callSignalProtocol;
    this.expectedOfflineBucketPrefix = `${modeConfig.dhtNamespaces.offline}/`;
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }
    this.groupOfflineManager = new GroupOfflineManager({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId: this.node.peerId.toString(),
      onMessageReceived: this.onMessageReceived,
      onApplicationMessage: this.handleIncomingApplicationMessage.bind(this),
      onGroupCallHint: async ({ groupId }) => {
        await this.groupCallHintHandler?.(groupId);
      },
      onOfflineInboxCapacityChanged: (chatId) => this.notifyOfflineInboxCapacityChanged(chatId),
      // Closes over `this` so it picks up the handler set after construction.
      requestReconnect: async () => (await this.requestReconnect?.()) ?? false,
    });
    this.offlineInboxCapacityService = new OfflineInboxCapacityService({
      database: this.database,
      keyExchange: this.keyExchange,
      groupOfflineManager: this.groupOfflineManager,
      myPeerId: this.node.peerId.toString(),
    });
    this.groupMessaging = new GroupMessaging({
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId: this.node.peerId.toString(),
      myUsername: this.database.getUserByPeerId(this.node.peerId.toString())?.username || `user_${this.node.peerId.toString().slice(-8)}`,
      onMessageReceived: this.onMessageReceived,
      onApplicationMessage: this.handleIncomingApplicationMessage.bind(this),
      groupOfflineManager: this.groupOfflineManager,
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });
    this.groupAckRepublisher = new GroupAckRepublisher({
      node: this.node,
      database: this.database,
      networkMode: sessionNetworkMode,
      usernameRegistry: this.usernameRegistry,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onOfflineInboxCapacityChanged: (chatId) => this.notifyOfflineInboxCapacityChanged(chatId),
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    });
    this.groupInfoRepublisher = new GroupInfoRepublisher({
      node: this.node,
      database: this.database,
      networkMode: sessionNetworkMode,
    });
    this.offlineSendQueue = new OfflineSendQueue({
      node: this.node,
      database: this.database,
      buildOfflineMessage: (row) => this.buildOfflineMessageForQueue(row),
      getSigningKey: () => {
        const identity = this.usernameRegistry.getUserIdentity();
        if (!identity) {
          throw new Error('User identity unavailable for offline send');
        }
        return identity.signingPrivateKey;
      },
      emitSendState: (data) => this.notifyMessageSendState(data),
      emitInboxCapacityChanged: (chatId) => this.notifyOfflineInboxCapacityChanged(chatId),
    });
    // No auto-resume: surface anything interrupted mid-flight as failed (manual retry).
    this.offlineSendQueue.recoverOnStartup();
    const recoveredRekeying = this.database.recoverRekeyingGroupsOnStartup();
    if (recoveredRekeying > 0) {
      console.warn(
        `[GROUP] Recovered ${recoveredRekeying} group chat(s) stuck in rekeying state on startup`,
      );
    }
    this.setupProtocolHandler();
    this.groupMessaging.start();
    this.cleanupPeerEvents = PeerConnectionHandler.setupPeerEvents(node, this.sessionManager, {
      onPeerConnect: (peerId) => {
        this.handlePeerConnectForActiveCall(peerId);
        // Now reachable: flush any ACK we owe this peer (retry path for a failed
        // earlier ACK; also clears their bucket promptly once we reconnect).
        void this.flushPendingOfflineAck(peerId);
        // And if we have messages waiting for them, nudge them to fetch + ACK now.
        this.nudgeForPendingOfflineMessages(peerId);
      },
      onPeerDisconnect: (peerId) => this.handlePeerDisconnectForActiveCall(peerId),
    });
    this.startSessionCleanup();
    this.startGroupAckRepublisher();
    this.startGroupInfoRepublisher();
  }

  // Get configuration value from database with fallback to constant
  private getChatsToCheckForOfflineMessages(): number {
    const setting = this.database.getSetting('chats_to_check_for_offline_messages');
    return setting ? parseInt(setting, 10) : CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES;
  }

  public nudgePeerGroupRefetch(peerId: string, groupId: string): void {
    this.sendBucketNudge(peerId, { kind: 'GROUP_REKEY_REFETCH', groupId }, `group:${peerId}:${groupId}`);
  }

  public nudgePeerDirectSessionReset(peerId: string): void {
    this.sendBucketNudge(peerId, { kind: 'DIRECT_SESSION_RESET' }, `direct-reset:${peerId}`);
  }

  // On connecting to a peer nudge them to fetch now 
  private nudgeForPendingOfflineMessages(peerId: string): void {
    const bucketSecret = this.database.getOfflineBucketSecretByPeerId(peerId);
    if (!bucketSecret) {
      return;
    }
    const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);
    const storedCount = OfflineMessageManager.liveBucketMessageCount(this.database, writeBucketKey);
    const pendingCount = this.database.countActivePendingOfflineSendsByBucket(writeBucketKey);
    const hasLiveEntries = OfflineMessageManager.hasLiveBucketEntries(this.database, writeBucketKey);
    // TEMP_LOG: diagnose whether the peer connected before the offline queue had
    // actually flushed a message into the sender-side local bucket mirror.
    log(
      `[TEMP_LOG][OFFLINE][NUDGE][DECIDE] peer=${peerId.slice(-8)} bucket=*${writeBucketKey.slice(-12)} stored=${storedCount} pending=${pendingCount} willNudge=${hasLiveEntries}`,
    );
    if (hasLiveEntries) {
      this.sendBucketNudge(peerId, { kind: 'DIRECT_OFFLINE_REFETCH' }, `direct-offline:${peerId}`);
    }
  }

  setGroupCallHintHandler(handler: ((groupId: string) => void | Promise<void>) | null): void {
    this.groupCallHintHandler = handler;
  }

  setRequestReconnect(handler: (() => Promise<boolean>) | null): void {
    this.requestReconnect = handler;
  }

  setMessageSendStateEmitter(emit: (data: MessageSendStateChangedEvent) => void): void {
    this.emitMessageSendState = emit;
  }

  setOfflineInboxCapacityChangedEmitter(emit: (data: OfflineInboxCapacityChangedEvent) => void): void {
    this.emitOfflineInboxCapacityChanged = emit;
  }

  /** Report an outbound message's send-state transition to the renderer. */
  notifyMessageSendState(data: MessageSendStateChangedEvent): void {
    this.emitMessageSendState(data);
  }

  notifyOfflineInboxCapacityChanged(chatId: number): void {
    this.emitOfflineInboxCapacityChanged({ chatId });
  }

  private notifyOfflineInboxCapacityChangedForPeer(peerId: string): void {
    const chat = this.database.getChatByPeerId(peerId);
    if (chat) {
      // TEMP_LOG: trace sender-side capacity refreshes while debugging stale direct counts.
      log(`[TEMP_LOG][OFFLINE][CAPACITY][EMIT] peer=${peerId.slice(-8)} chatId=${chat.id}`);
      this.notifyOfflineInboxCapacityChanged(chat.id);
    }
  }

  requestDirectOfflineInboxRecovery(peerId: string): boolean {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat || chat.type !== 'direct') {
      log(`[OFFLINE][RECOVERY][SKIP] peer=${peerId.slice(-8)} reason=no_direct_chat`);
      return false;
    }

    const existing = this.directOfflineInboxRecoveryInFlight.get(peerId);
    if (existing) {
      log(`[OFFLINE][RECOVERY][SKIP] peer=${peerId.slice(-8)} reason=in_flight`);
      return false;
    }

    const now = Date.now();
    const lastStartedAt = this.directOfflineInboxRecoveryCooldowns.get(peerId) ?? 0;
    if (now - lastStartedAt < DIRECT_OFFLINE_INBOX_RECOVERY_COOLDOWN_MS) {
      log(
        `[OFFLINE][RECOVERY][SKIP] peer=${peerId.slice(-8)} reason=cooldown remainingMs=${DIRECT_OFFLINE_INBOX_RECOVERY_COOLDOWN_MS - (now - lastStartedAt)}`,
      );
      return false;
    }

    this.directOfflineInboxRecoveryCooldowns.set(peerId, now);
    const recovery = this.runDirectOfflineInboxRecovery(peerId, chat.id)
      .catch((error: unknown) => {
        generalErrorHandler(error, `[OFFLINE][RECOVERY] failed for peer=${peerId.slice(-8)}`);
      })
      .finally(() => {
        if (this.directOfflineInboxRecoveryInFlight.get(peerId) === recovery) {
          this.directOfflineInboxRecoveryInFlight.delete(peerId);
        }
      });
    this.directOfflineInboxRecoveryInFlight.set(peerId, recovery);
    return true;
  }

  private async runDirectOfflineInboxRecovery(peerId: string, chatId: number): Promise<void> {
    log(`[OFFLINE][RECOVERY][START] peer=${peerId.slice(-8)} chatId=${chatId}`);
    this.notifyOfflineInboxCapacityChanged(chatId);

    if (this.checkOfflineCapacity(peerId)) {
      log(`[OFFLINE][RECOVERY][DONE] peer=${peerId.slice(-8)} chatId=${chatId} cleared=true stage=precheck`);
      return;
    }

    await this.checkOfflineMessages([chatId]);
    if (this.checkOfflineCapacity(peerId)) {
      log(`[OFFLINE][RECOVERY][DONE] peer=${peerId.slice(-8)} chatId=${chatId} cleared=true stage=initial_fetch`);
      this.notifyOfflineInboxCapacityChanged(chatId);
      return;
    }

    const reconnectSettled = await (this.requestReconnect?.() ?? Promise.resolve(false));
    log(
      `[OFFLINE][RECOVERY][RECONNECT] peer=${peerId.slice(-8)} chatId=${chatId} success=${String(reconnectSettled)}`,
    );

    this.sendBucketNudge(
      peerId,
      { kind: 'DIRECT_OFFLINE_REFETCH' },
      `direct-offline-recovery:${peerId}`,
      { allowDialWithoutConnection: true },
    );

    await new Promise((resolve) => setTimeout(resolve, DIRECT_OFFLINE_INBOX_RECOVERY_RECHECK_DELAY_MS));
    await this.checkOfflineMessages([chatId]);
    const cleared = this.checkOfflineCapacity(peerId);
    log(
      `[OFFLINE][RECOVERY][DONE] peer=${peerId.slice(-8)} chatId=${chatId} cleared=${String(cleared)} stage=final_fetch`,
    );
    this.notifyOfflineInboxCapacityChanged(chatId);
  }

  getOfflineInboxCapacity(chatId: number): OfflineInboxCapacitySnapshot | null {
    return this.offlineInboxCapacityService.getSnapshot(chatId);
  }

  private createGroupResponderDeps(
    userIdentity: EncryptedUserIdentity,
    myPeerId: string,
    myUsername: string,
  ) {
    return {
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupChatActivated: this.onGroupChatActivated,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      onOfflineInboxCapacityChanged: (chatId: number) => this.notifyOfflineInboxCapacityChanged(chatId),
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
    };
  }

  private createGroupCreatorDeps(
    userIdentity: EncryptedUserIdentity,
    myPeerId: string,
    myUsername: string,
  ) {
    return {
      node: this.node,
      database: this.database,
      userIdentity,
      myPeerId,
      myUsername,
      onGroupMembersUpdated: this.onGroupMembersUpdated,
      onMessageReceived: this.onMessageReceived,
      onOfflineInboxCapacityChanged: (chatId: number) => this.notifyOfflineInboxCapacityChanged(chatId),
      nudgeGroupRefetch: this.nudgePeerGroupRefetch.bind(this),
      onRegisterPrevEpochGrace: (groupId: string, keyVersion: number) => {
        this.groupMessaging.registerGraceContextForEpoch(groupId, keyVersion);
      },
    };
  }

  async storeGroupCallHint(groupId: string): Promise<void> {
    await this.groupMessaging.storeGroupCallHintMessage(groupId);
  }

  private sendBucketNudge(
    peerId: string,
    payload: BucketNudgePayload,
    cooldownKey: string,
    options?: { allowDialWithoutConnection?: boolean },
  ): void {
    const attemptId = ++this.nudgeSendAttemptSeq;
    const startSnapshot = this.getNudgeConnectionSnapshot(peerId);
    const allowDialWithoutConnection = options?.allowDialWithoutConnection === true;
    log(
      `[NUDGE][SEND][START] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
      `cooldownKey=${cooldownKey} totalConnections=${startSnapshot.totalConnections} ` +
      `peerConnections=${startSnapshot.peerConnectionCount} peerConnAddrs=${startSnapshot.peerConnectionAddrs} ` +
      `allowDialWithoutConnection=${String(allowDialWithoutConnection)}`,
    );

    // Default behavior: do not force-dial just to send a nudge.
    const hasActiveConnection = startSnapshot.peerConnectionCount > 0;
    if (!hasActiveConnection && !allowDialWithoutConnection) {
      log(
        `[NUDGE][SKIP_NO_CONN] peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
        `reason=no_active_connection attempt=${attemptId} totalConnections=${startSnapshot.totalConnections} ` +
        `connectedPeers=${startSnapshot.peerSuffixes}`,
      );
      return;
    }

    const now = Date.now();
    const last = this.nudgeCooldowns.get(cooldownKey) ?? 0;
    const elapsed = now - last;

    if (elapsed < BUCKET_NUDGE_COOLDOWN_MS) {
      const remaining = BUCKET_NUDGE_COOLDOWN_MS - elapsed;
      if (!this.nudgeTrailingTimers.has(cooldownKey)) {
        const timer = setTimeout(() => {
          this.nudgeTrailingTimers.delete(cooldownKey);
          this.sendBucketNudge(peerId, payload, cooldownKey, options);
        }, remaining);
        this.nudgeTrailingTimers.set(cooldownKey, timer);
      }
      log(
        `[NUDGE][COOLDOWN] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
        `elapsed=${elapsed} remaining=${remaining} cooldownMs=${BUCKET_NUDGE_COOLDOWN_MS}`,
      );
      return;
    }
    this.nudgeCooldowns.set(cooldownKey, now);

    void (async () => {
      const dialStartedAt = Date.now();
      try {
        let stream: Awaited<ReturnType<ChatNode['dialProtocol']>> | null = null;
        let streamSource: 'reuse' | 'dial' = 'dial';
        const peerConnections = this.node
          .getConnections()
          .filter((conn) => conn.remotePeer.toString() === peerId);

        for (const conn of peerConnections) {
          if (conn.status !== 'open') {
            log(
              `[NUDGE][STREAM][REUSE_SKIP] attempt=${attemptId} peer=${peerId.slice(-8)} ` +
              `connId=${conn.id} status=${conn.status}`,
            );
            continue;
          }

          const openStartedAt = Date.now();
          try {
            log(
              `[NUDGE][STREAM][REUSE_TRY] attempt=${attemptId} peer=${peerId.slice(-8)} ` +
              `connId=${conn.id} remoteAddr=${conn.remoteAddr.toString()} protocol=${this.bucketNudgeProtocol}`,
            );
            stream = await conn.newStream(this.bucketNudgeProtocol, {
              signal: AbortSignal.timeout(BUCKET_NUDGE_DIAL_TIMEOUT_MS),
              runOnLimitedConnection: true,
            });
            streamSource = 'reuse';
            log(
              `[NUDGE][STREAM][REUSE_OK] attempt=${attemptId} peer=${peerId.slice(-8)} ` +
              `connId=${conn.id} openMs=${Date.now() - openStartedAt}`,
            );
            break;
          } catch (error: unknown) {
            const reason = errStr(error);
            const errorName = error instanceof Error ? error.name : 'UnknownError';
            log(
              `[NUDGE][STREAM][REUSE_FAIL] attempt=${attemptId} peer=${peerId.slice(-8)} ` +
              `connId=${conn.id} openMs=${Date.now() - openStartedAt} reason=${reason} errorName=${errorName}`,
            );
          }
        }

        if (stream === null) {
          const targetPeerId = peerIdFromString(peerId);
          log(
            `[NUDGE][DIAL][START] attempt=${attemptId} peer=${peerId.slice(-8)} protocol=${this.bucketNudgeProtocol} ` +
            `timeoutMs=${BUCKET_NUDGE_DIAL_TIMEOUT_MS}`,
          );
          stream = await this.node.dialProtocol(targetPeerId, this.bucketNudgeProtocol, {
            signal: AbortSignal.timeout(BUCKET_NUDGE_DIAL_TIMEOUT_MS),
            runOnLimitedConnection: true,
          });
          const dialMs = Date.now() - dialStartedAt;
          const postDialSnapshot = this.getNudgeConnectionSnapshot(peerId);
          log(
            `[NUDGE][DIAL][OK] attempt=${attemptId} peer=${peerId.slice(-8)} dialMs=${dialMs} ` +
            `totalConnections=${postDialSnapshot.totalConnections} ` +
            `peerConnections=${postDialSnapshot.peerConnectionCount} peerConnAddrs=${postDialSnapshot.peerConnectionAddrs}`,
          );
        } else {
          const postReuseSnapshot = this.getNudgeConnectionSnapshot(peerId);
          log(
            `[NUDGE][DIAL][SKIP_REUSE] attempt=${attemptId} peer=${peerId.slice(-8)} ` +
            `totalConnections=${postReuseSnapshot.totalConnections} ` +
            `peerConnections=${postReuseSnapshot.peerConnectionCount} peerConnAddrs=${postReuseSnapshot.peerConnectionAddrs}`,
          );
        }

        const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
        const sinkStartedAt = Date.now();
        await stream.sink([payloadBytes]);
        const sinkMs = Date.now() - sinkStartedAt;
        log(
          `[NUDGE][WRITE][OK] attempt=${attemptId} peer=${peerId.slice(-8)} source=${streamSource} bytes=${payloadBytes.length} sinkMs=${sinkMs}`,
        );

        const closeStartedAt = Date.now();
        await stream.close();
        const closeMs = Date.now() - closeStartedAt;
        const totalMs = Date.now() - dialStartedAt;
        log(
          `[NUDGE][SEND][OK] attempt=${attemptId} peer=${peerId.slice(-8)} source=${streamSource} ${this.formatNudgeTarget(payload)} ` +
          `totalMs=${totalMs} closeMs=${closeMs}`,
        );
      } catch (error: unknown) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        const errorCode = typeof (error as { code?: unknown })?.code === 'string'
          ? (error as { code: string }).code
          : 'n/a';
        const elapsedMs = Date.now() - dialStartedAt;
        const failSnapshot = this.getNudgeConnectionSnapshot(peerId);
        log(
          `[NUDGE][SEND_FAIL] attempt=${attemptId} peer=${peerId.slice(-8)} ${this.formatNudgeTarget(payload)} ` +
          `reason=${errStr(error)} errorName=${errorName} errorCode=${errorCode} elapsedMs=${elapsedMs} ` +
          `totalConnections=${failSnapshot.totalConnections} peerConnections=${failSnapshot.peerConnectionCount} ` +
          `peerConnAddrs=${failSnapshot.peerConnectionAddrs}`,
        );
        // Best-effort — peer offline or unreachable, offline bucket still delivers
      }
    })();
  }

  /**
   * Sets up the chat protocol handler for incoming messages
   */
  private setupProtocolHandler(): void {
    void this.node.handle(this.bucketNudgeProtocol, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      const recvStartedAt = Date.now();
      log(
        `[NUDGE][RECV][IN] from=${remoteId.slice(-8)} protocol=${this.bucketNudgeProtocol} ` +
        `totalConnections=${this.node.getConnections().length}`,
      );
      try {
        if (this.database.isBlocked(remoteId)) return;
        if (!this.isKnownNudgeSender(remoteId)) {
          log(`[NUDGE] Ignoring nudge from unknown peer ${remoteId.slice(-8)}`);
          return;
        }

        const nudgePayload = await this.readBucketNudgePayload(stream);
        log(
          `[NUDGE][RECV][PAYLOAD] from=${remoteId.slice(-8)} payload=${nudgePayload ? JSON.stringify(nudgePayload) : 'null'} ` +
          `readMs=${Date.now() - recvStartedAt}`,
        );
        await this.routeBucketNudge(remoteId, nudgePayload);
      } catch (error: unknown) {
        generalErrorHandler(error, `[NUDGE] Failed to process nudge from ${remoteId.slice(-8)}`);
      } finally {
        try {
          await stream.close();
          log(
            `[NUDGE][RECV][DONE] from=${remoteId.slice(-8)} totalMs=${Date.now() - recvStartedAt}`,
          );
        } catch {
          // Best-effort close.
        }
      }
    }, {
      runOnLimitedConnection: true,
      maxInboundStreams: MAX_INBOUND_STREAMS_BUCKET_NUDGE,
    });

    void this.node.handle(this.chatProtocol, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      // Immediately check if the user is blocked
      try {
        if (this.database.isBlocked(remoteId)) {
          return;
        }
      } catch (e) {
        generalErrorHandler(e, `Error checking if user is blocked`);
        return;
      }
      StreamHandler.logIncomingConnection(remoteId, this.chatProtocol);

      // Bound unauthenticated first-contact work (the inbound read + key-exchange crypto)
      // from strangers with a global + per-peer concurrency gate. Established peers — an
      // active session or an existing direct chat — bypass it, so an inbound flood from
      // fresh peerIds can't starve real contacts of their first-contact/rotation streams.
      const isEstablishedPeer =
        Boolean(this.sessionManager.getSession(remoteId)) ||
        Boolean(this.database.getChatByPeerId(remoteId));
      const unauthLease = isEstablishedPeer ? null : this.unauthKeyExchangeLeases.tryAcquire(remoteId);
      if (!isEstablishedPeer && !unauthLease) {
        console.warn(`[CHAT][THROTTLE] peer=${remoteId.slice(-8)} reason=unauth_capacity_reached`);
        try { stream.abort(new Error('chat handshake capacity reached')); } catch { /* best-effort */ }
        return;
      }

      try {
        const message = await StreamHandler.readMessageFromStream<EncryptedMessage>(stream, {
          maxBytes: MAX_CHAT_ENVELOPE_BYTES,
          timeoutMs: INBOUND_STREAM_READ_TIMEOUT_MS,
        });
        StreamHandler.logReceivedMessage(message);

        if (MessageEncryption.isKeyExchange(message)) {
          const hadUserAtStart = !!this.database.getUserByPeerId(remoteId);
          await this.keyExchange.handleKeyExchange(
            remoteId,
            message as AuthenticatedEncryptedMessage,
            stream,
            () => unauthLease?.release(),
          );
          this.reactivateRetiredPendingAcksForPeer(remoteId);
          // Fallback B only for initial handshake from an existing known contact.
          if (message.content === 'key_exchange_init' && hadUserAtStart) {
            this.schedulePeerActivityOfflineCheck(remoteId);
          }
          return;
        }

        const session = this.sessionManager.getSession(remoteId);
        if (!session) {
          console.warn(`[MESSAGE] Dropping message from ${remoteId.slice(-8)} because no active session was found`);
          return;
        }
        const decryptedContent = MessageEncryption.decryptMessage(message, session);
        this.reactivateRetiredPendingAcksForPeer(remoteId);

        // Process ACK if included - clear acknowledged messages from our bucket
        if (message.offline_ack_timestamp) {
          log(`Clearing acknowledged messages up to ${message.offline_ack_timestamp}`);
          await this.processOfflineAck(remoteId, message.offline_ack_timestamp);
        }

        // Standalone ACK: the ACK was processed above; do not deliver/save it.
        if (message.ack_only) {
          log(`[OFFLINE-ACK][IN][ONLINE] from=${remoteId.slice(-8)} ts=${message.offline_ack_timestamp}`);
          return;
        }

        const sender = this.database.getUserByPeerId(remoteId);
        await this.dispatchIncomingDirectApplicationMessage({
          plaintext: decryptedContent,
          senderPeerId: remoteId,
          senderUsername: sender?.username || 'Unknown',
          timestamp: Date.now(),
          messageSentStatus: 'online',
          transportMessageId: crypto.randomUUID(),
        });
        this.sessionManager.incrementMessageCount(remoteId);
        this.sessionManager.updateSessionUsage(remoteId);
      } catch (error: unknown) {
        generalErrorHandler(error, `Error handling message from ${remoteId}`);
      } finally {
        unauthLease?.release();
      }
    }, {
      runOnLimitedConnection: true,
      maxInboundStreams: MAX_INBOUND_STREAMS_CHAT,
    });

    void this.node.handle(this.callSignalProtocol, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      try {
        if (this.database.isBlocked(remoteId)) return;

        const signal = await StreamHandler.readMessageFromStream<CallSignalMessage>(stream, {
          maxBytes: MAX_CALL_SIGNAL_ENVELOPE_BYTES,
          timeoutMs: INBOUND_STREAM_READ_TIMEOUT_MS,
        });
        await this.handleIncomingCallSignal(remoteId, signal);
      } catch (error: unknown) {
        generalErrorHandler(error, `Error handling call signal from ${remoteId}`);
      } finally {
        try {
          await stream.close();
        } catch {
          // Best-effort close.
        }
      }
    }, {
      runOnLimitedConnection: true,
      maxInboundStreams: MAX_INBOUND_STREAMS_CALL_SIGNAL,
    });
  }

  private isKnownNudgeSender(remoteId: string): boolean {
    const hasDirectChat = this.database.getChatByPeerId(remoteId) !== null;
    const knownUser = this.database.getUserByPeerId(remoteId) !== null;
    return hasDirectChat || knownUser;
  }

  private emitCallError(error: string, details?: { peerId?: string; callId?: string; code?: string }): void {
    const payload: CallErrorEvent = {
      error,
      timestamp: Date.now(),
    };
    if (details?.peerId) payload.peerId = details.peerId;
    if (details?.callId) payload.callId = details.callId;
    if (details?.code) payload.code = details.code;
    this.onCallError(payload);
  }

  private setActiveCall(activeCall: ActiveCall): void {
    const isSameCall = this.activeCall
      && this.activeCall.callId === activeCall.callId
      && this.activeCall.peerId === activeCall.peerId;
    if (!isSameCall) {
      this.activeCallLastControlSignalTs = null;
    }
    this.activeCall = activeCall;
    this.callActivityRegistry.setDirectCall({
      callId: activeCall.callId,
      peerId: activeCall.peerId,
    });
    this.scheduleCallRingWatchdog(activeCall);
    this.onCallStateChanged({
      callId: activeCall.callId,
      peerId: activeCall.peerId,
      state: activeCall.state,
      direction: activeCall.direction,
      mediaType: activeCall.mediaType,
      timestamp: Date.now(),
    });
  }

  private clearActiveCall(reason: string): void {
    if (!this.activeCall) return;
    const previous = this.activeCall;
    this.activeCall = null;
    this.callActivityRegistry.setDirectCall(null);
    this.activeCallLastControlSignalTs = null;
    this.clearCallRingWatchdog();
    this.clearActiveCallPeerDisconnectTimer();
    this.onCallStateChanged({
      callId: previous.callId,
      peerId: previous.peerId,
      state: 'ended',
      direction: previous.direction,
      mediaType: previous.mediaType,
      reason,
      timestamp: Date.now(),
    });
  }

  private clearCallRingWatchdog(): void {
    if (!this.activeCallRingWatchdogTimer) return;
    clearTimeout(this.activeCallRingWatchdogTimer);
    this.activeCallRingWatchdogTimer = null;
  }

  private clearActiveCallPeerDisconnectTimer(): void {
    if (!this.activeCallPeerDisconnectTimer) return;
    clearTimeout(this.activeCallPeerDisconnectTimer);
    this.activeCallPeerDisconnectTimer = null;
  }

  private handlePeerConnectForActiveCall(peerId: string): void {
    if (!this.activeCall || this.activeCall.peerId !== peerId) return;
    this.clearActiveCallPeerDisconnectTimer();
  }

  private handlePeerDisconnectForActiveCall(peerId: string): void {
    if (!this.activeCall || this.activeCall.peerId !== peerId) return;

    this.clearActiveCallPeerDisconnectTimer();
    const expectedCallId = this.activeCall.callId;
    this.activeCallPeerDisconnectTimer = setTimeout(() => {
      this.activeCallPeerDisconnectTimer = null;
      if (!this.activeCall) return;
      if (this.activeCall.peerId !== peerId || this.activeCall.callId !== expectedCallId) return;
      if (this.hasActiveConnectionToPeer(peerId)) return;
      console.warn(
        `[CALL] Clearing stale active call after peer disconnect grace peer=${peerId.slice(-8)} callId=${expectedCallId.slice(0, 8)}`,
      );
      this.clearActiveCall('disconnect');
    }, MessageHandler.CALL_PEER_DISCONNECT_GRACE_MS);
  }

  private scheduleCallRingWatchdog(activeCall: ActiveCall): void {
    this.clearCallRingWatchdog();

    if (activeCall.state !== 'ringing_out' && activeCall.state !== 'ringing_in') {
      return;
    }

    const expectedCallId = activeCall.callId;
    const expectedPeerId = activeCall.peerId;
    this.activeCallRingWatchdogTimer = setTimeout(() => {
      this.activeCallRingWatchdogTimer = null;
      const current = this.activeCall;
      if (!current) return;
      if (current.callId !== expectedCallId || current.peerId !== expectedPeerId) return;
      if (current.state !== 'ringing_out' && current.state !== 'ringing_in') return;

      console.warn(
        '[CALL] Clearing stale ringing call peer=' + expectedPeerId.slice(-8)
        + ' callId=' + expectedCallId.slice(0, 8)
        + ' state=' + current.state,
      );
      this.clearActiveCall('timeout');
    }, MessageHandler.CALL_RING_STALE_TIMEOUT_MS);
  }


  private hasActiveConnectionToPeer(peerId: string): boolean {
    return this.node
      .getConnections()
      .some((conn) => conn.remotePeer.toString() === peerId && conn.status === 'open');
  }

  private isActiveCallMatch(peerId: string, callId: string): boolean {
    return !!this.activeCall
      && this.activeCall.peerId === peerId
      && this.activeCall.callId === callId;
  }

  private makeCallSignalDedupeKey(remoteId: string, signal: CallSignalMessage): string {
    return `${remoteId}:${signal.callId}:${signal.type}:${signal.signature}`;
  }

  private pruneSeenCallSignals(now: number): void {
    const cutoff = now - MessageHandler.CALL_SIGNAL_DEDUPE_TTL_MS;
    for (const [key, seenAt] of this.seenCallSignals.entries()) {
      if (seenAt < cutoff) {
        this.seenCallSignals.delete(key);
      }
    }

    if (this.seenCallSignals.size <= MessageHandler.CALL_SIGNAL_DEDUPE_MAX_ENTRIES) {
      return;
    }

    const ordered = Array.from(this.seenCallSignals.entries()).sort((a, b) => a[1] - b[1]);
    const toDrop = this.seenCallSignals.size - MessageHandler.CALL_SIGNAL_DEDUPE_MAX_ENTRIES;
    for (let i = 0; i < toDrop; i += 1) {
      const entry = ordered[i];
      if (!entry) break;
      this.seenCallSignals.delete(entry[0]);
    }
  }

  private hasSeenCallSignal(remoteId: string, signal: CallSignalMessage, now: number): boolean {
    this.pruneSeenCallSignals(now);
    const key = this.makeCallSignalDedupeKey(remoteId, signal);
    if (this.seenCallSignals.has(key)) {
      return true;
    }
    this.seenCallSignals.set(key, now);
    return false;
  }

  private ensureFastModeForCalls(): void {
    const mode = this.database.getSessionNetworkMode();
    if (mode !== 'fast') {
      throw new Error('Calls are currently available only in Fast mode');
    }
  }

  private ensureDirectCallContact(peerId: string): void {
    if (this.database.isBlocked(peerId)) {
      throw new Error('Peer is blocked');
    }
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) {
      throw new Error('Calls are available only for direct contacts');
    }
    const user = this.database.getUserByPeerId(peerId);
    if (!user) {
      throw new Error('Peer not found');
    }
  }

  private isCallSignalType(value: unknown): value is CallSignalType {
    return value === 'CALL_OFFER'
      || value === 'CALL_ANSWER'
      || value === 'CALL_ICE'
      || value === 'CALL_REJECT'
      || value === 'CALL_END'
      || value === 'CALL_BUSY'
      || value === 'CALL_CAMERA_STARTED'
      || value === 'CALL_CAMERA_STOPPED'
      || value === 'CALL_SCREEN_SHARE_STARTED'
      || value === 'CALL_SCREEN_SHARE_STOPPED';
  }

  private isCallSignalMessage(value: unknown): value is CallSignalMessage {
    if (!value || typeof value !== 'object') return false;
    const signal = value as Record<string, unknown>;
    if (!this.isCallSignalType(signal.type)) return false;
    if (typeof signal.callId !== 'string' || !signal.callId) return false;
    if (typeof signal.fromPeerId !== 'string' || !signal.fromPeerId) return false;
    if (typeof signal.toPeerId !== 'string' || !signal.toPeerId) return false;
    if (!Number.isFinite(signal.timestamp) || Number(signal.timestamp) <= 0) return false;
    if (typeof signal.signature !== 'string' || !signal.signature) return false;

    switch (signal.type) {
      case 'CALL_OFFER':
        return typeof signal.offerSdp === 'string'
          && signal.offerSdp.length > 0
          && signal.mediaType === 'audio';
      case 'CALL_ANSWER':
        return typeof signal.answerSdp === 'string' && signal.answerSdp.length > 0;
      case 'CALL_ICE':
        return typeof signal.candidate === 'string'
          && (signal.sdpMid === null || typeof signal.sdpMid === 'string')
          && (signal.sdpMLineIndex === null || Number.isInteger(signal.sdpMLineIndex))
          && (signal.usernameFragment === null || typeof signal.usernameFragment === 'string');
      case 'CALL_REJECT':
        return signal.reason === 'rejected'
          || signal.reason === 'timeout'
          || signal.reason === 'offline'
          || signal.reason === 'policy';
      case 'CALL_END':
        return signal.reason === 'hangup'
          || signal.reason === 'disconnect'
          || signal.reason === 'failed';
      case 'CALL_BUSY':
        return signal.reason === 'busy';
      case 'CALL_CAMERA_STARTED':
      case 'CALL_CAMERA_STOPPED':
        return true;
      case 'CALL_SCREEN_SHARE_STARTED':
        return true;
      case 'CALL_SCREEN_SHARE_STOPPED':
        return signal.reason === undefined
          || signal.reason === 'manual'
          || signal.reason === 'track-ended'
          || signal.reason === 'call-ended'
          || signal.reason === 'failed';
      default:
        return false;
    }
  }

  private toUnsignedCallSignalPayload(
    signal: UnsignedCallSignalMessage
  ): Record<string, unknown> {
    const common = {
      type: signal.type,
      callId: signal.callId,
      fromPeerId: signal.fromPeerId,
      toPeerId: signal.toPeerId,
      timestamp: signal.timestamp,
    };

    switch (signal.type) {
      case 'CALL_OFFER':
        return { ...common, offerSdp: signal.offerSdp, mediaType: signal.mediaType };
      case 'CALL_ANSWER':
        return { ...common, answerSdp: signal.answerSdp };
      case 'CALL_ICE':
        return {
          ...common,
          candidate: signal.candidate,
          sdpMid: signal.sdpMid,
          sdpMLineIndex: signal.sdpMLineIndex,
          usernameFragment: signal.usernameFragment,
        };
      case 'CALL_REJECT':
      case 'CALL_END':
      case 'CALL_BUSY':
        return { ...common, reason: signal.reason };
      case 'CALL_CAMERA_STARTED':
      case 'CALL_CAMERA_STOPPED':
      case 'CALL_SCREEN_SHARE_STARTED':
        return common;
      case 'CALL_SCREEN_SHARE_STOPPED':
        return signal.reason ? { ...common, reason: signal.reason } : common;
      default:
        return common;
    }
  }

  private buildSignedCallSignal(input: CallSignalOutgoingInput): CallSignalMessage {
    this.ensureFastModeForCalls();
    this.ensureDirectCallContact(input.toPeerId);

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity unavailable');
    }
    const fromPeerId = this.node.peerId.toString();
    const timestamp = input.timestamp ?? Date.now();

    let unsignedSignal: UnsignedCallSignalMessage;
    switch (input.type) {
      case 'CALL_OFFER':
        unsignedSignal = {
          type: 'CALL_OFFER',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          offerSdp: input.offerSdp,
          mediaType: input.mediaType,
        };
        break;
      case 'CALL_ANSWER':
        unsignedSignal = {
          type: 'CALL_ANSWER',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          answerSdp: input.answerSdp,
        };
        break;
      case 'CALL_ICE':
        unsignedSignal = {
          type: 'CALL_ICE',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          candidate: input.candidate,
          sdpMid: input.sdpMid,
          sdpMLineIndex: input.sdpMLineIndex,
          usernameFragment: input.usernameFragment,
        };
        break;
      case 'CALL_REJECT':
        unsignedSignal = {
          type: 'CALL_REJECT',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          reason: input.reason,
        };
        break;
      case 'CALL_END':
        unsignedSignal = {
          type: 'CALL_END',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          reason: input.reason,
        };
        break;
      case 'CALL_BUSY':
        unsignedSignal = {
          type: 'CALL_BUSY',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          reason: input.reason,
        };
        break;
      case 'CALL_CAMERA_STARTED':
        unsignedSignal = {
          type: 'CALL_CAMERA_STARTED',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
        };
        break;
      case 'CALL_CAMERA_STOPPED':
        unsignedSignal = {
          type: 'CALL_CAMERA_STOPPED',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
        };
        break;
      case 'CALL_SCREEN_SHARE_STARTED':
        unsignedSignal = {
          type: 'CALL_SCREEN_SHARE_STARTED',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
        };
        break;
      case 'CALL_SCREEN_SHARE_STOPPED':
        unsignedSignal = input.reason ? {
          type: 'CALL_SCREEN_SHARE_STOPPED',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
          reason: input.reason,
        } : {
          type: 'CALL_SCREEN_SHARE_STOPPED',
          callId: input.callId,
          fromPeerId,
          toPeerId: input.toPeerId,
          timestamp,
        };
        break;
      default:
        throw new Error('Unsupported call signal type');
    }

    const signatureBytes = userIdentity.sign(JSON.stringify(this.toUnsignedCallSignalPayload(unsignedSignal)));
    const signature = Buffer.from(signatureBytes).toString('base64');
    return { ...unsignedSignal, signature };
  }

  private withCallSignalTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Call signal timeout'));
      }, MessageHandler.CALL_SIGNAL_TIMEOUT_MS);

      operation
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private async openCallSignalStream(targetPeerId: string): Promise<Awaited<ReturnType<ChatNode['dialProtocol']>>> {
    const connections = this.node
      .getConnections()
      .filter(conn => conn.remotePeer.toString() === targetPeerId && conn.status === 'open');

    for (const conn of connections) {
      try {
        return await conn.newStream(this.callSignalProtocol, {
          signal: AbortSignal.timeout(MessageHandler.CALL_SIGNAL_TIMEOUT_MS),
          runOnLimitedConnection: true,
        });
      } catch {
        // Try next connection, then fallback dial.
      }
    }

    return dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId: peerIdFromString(targetPeerId),
      protocol: this.callSignalProtocol,
      context: 'call_signal',
    });
  }

  private async sendSignedCallSignal(signal: CallSignalMessage): Promise<void> {
    const sendOnce = async () => {
      const stream = await this.openCallSignalStream(signal.toPeerId);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(signal));
      await stream.sink([payloadBytes]);
      await stream.close();
    };

    if (signal.type !== 'CALL_OFFER') {
      await this.withCallSignalTimeout(sendOnce());
      return;
    }

    try {
      await this.withCallSignalTimeout(sendOnce());
    } catch {
      await new Promise(resolve => setTimeout(resolve, MessageHandler.CALL_OFFER_RETRY_DELAY_MS));
      await this.withCallSignalTimeout(sendOnce());
    }
  }

  private classifyCallSendFailure(error: unknown): CallActionFailureReason | undefined {
    const errorText = errStr(error).toLowerCase();
    return MessageHandler.OFFLINE_FALLBACK_REGEX.test(errorText)
      ? 'peer_unreachable'
      : undefined;
  }

  private verifyIncomingCallSignal(remoteId: string, signal: CallSignalMessage): { valid: boolean; error?: string } {
    try {
      this.ensureFastModeForCalls();
      this.ensureDirectCallContact(remoteId);
    } catch (error: unknown) {
      return { valid: false, error: errStr(error) };
    }

    if (signal.fromPeerId !== remoteId) {
      return { valid: false, error: 'Sender peer mismatch' };
    }

    const myPeerId = this.node.peerId.toString();
    if (signal.toPeerId !== myPeerId) {
      return { valid: false, error: 'Call signal target mismatch' };
    }

    const now = Date.now();
    if (signal.timestamp > now + MessageHandler.CALL_SIGNAL_MAX_FUTURE_SKEW_MS) {
      return { valid: false, error: 'Call signal is future-dated' };
    }
    if (now - signal.timestamp > MessageHandler.CALL_SIGNAL_MAX_AGE_MS) {
      return { valid: false, error: 'Call signal is too old' };
    }

    const sender = this.database.getUserByPeerId(remoteId);
    if (!sender?.signing_public_key) {
      return { valid: false, error: 'Unknown sender for call signal' };
    }

    const { signature, ...unsignedSignal } = signal;
    const signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
      signature,
      this.toUnsignedCallSignalPayload(unsignedSignal),
      sender.signing_public_key,
    );
    if (!signatureValid) {
      return { valid: false, error: 'Invalid call signal signature' };
    }

    return { valid: true };
  }

  private async handleIncomingCallSignal(remoteId: string, unknownSignal: unknown): Promise<void> {
    if (this.groupCallOrchestrator && isGroupCallControlSignalMessage(unknownSignal)) {
      await this.groupCallOrchestrator.handleIncomingControlSignal(remoteId, unknownSignal);
      return;
    }

    if (this.groupCallOrchestrator && isGroupCallPairSignalMessage(unknownSignal)) {
      await this.groupCallOrchestrator.handleIncomingPairSignal(remoteId, unknownSignal);
      return;
    }

    if (!this.isCallSignalMessage(unknownSignal)) {
      this.emitCallError('Malformed call signal payload', { peerId: remoteId, code: 'CALL_MALFORMED' });
      return;
    }
    const signal = unknownSignal;
    const validation = this.verifyIncomingCallSignal(remoteId, signal);
    if (!validation.valid) {
      console.warn(`[CALL] Dropping signal from ${remoteId.slice(-8)}: ${validation.error}`);
      this.emitCallError(validation.error ?? 'Call signal validation failed', {
        peerId: remoteId,
        callId: signal.callId,
        code: 'CALL_INVALID',
      });
      return;
    }

    const now = Date.now();
    if (this.hasSeenCallSignal(remoteId, signal, now)) {
      log(
        `[CALL] Dropping duplicate signal type=${signal.type} peer=${remoteId.slice(-8)} callId=${signal.callId.slice(0, 8)} reason=duplicate_signature`,
      );
      return;
    }

    if (signal.type === 'CALL_OFFER') {
      if (this.isActiveCallMatch(remoteId, signal.callId)) {
        // Offer retry/duplicate for the same ringing call.
        return;
      }

      if (this.callActivityRegistry.hasGroupCall()) {
        try {
          await this.sendCallSignal({
            type: 'CALL_BUSY',
            callId: signal.callId,
            toPeerId: remoteId,
            reason: 'busy',
          });
        } catch (error: unknown) {
          generalErrorHandler(error, '[CALL] Failed to send busy response while group call is active');
        }
        return;
      }

      // Same peer dialing with a fresh callId means their previous call state
      // is gone (e.g., they force-quit and reopened). Clear the stale entry
      // and accept the new offer instead of replying busy to ourselves.
      if (this.activeCall && this.activeCall.peerId === remoteId) {
        console.warn(
          `[CALL] Replacing stale active call after fresh offer from same peer peer=${remoteId.slice(-8)} oldCallId=${this.activeCall.callId.slice(0, 8)} newCallId=${signal.callId.slice(0, 8)}`,
        );
        this.clearActiveCall('disconnect');
      }

      const hasDifferentActiveCall = this.activeCall
        && (this.activeCall.callId !== signal.callId || this.activeCall.peerId !== remoteId);
      if (hasDifferentActiveCall) {
        try {
          await this.sendCallSignal({
            type: 'CALL_BUSY',
            callId: signal.callId,
            toPeerId: remoteId,
            reason: 'busy',
          });
        } catch (error: unknown) {
          generalErrorHandler(error, '[CALL] Failed to send busy response');
        }
        return;
      }

      this.setActiveCall({
        callId: signal.callId,
        peerId: remoteId,
        direction: 'incoming',
        mediaType: signal.mediaType,
        state: 'ringing_in',
      });
      this.onCallIncoming({ signal, receivedAt: Date.now() });
      return;
    }

    if (!this.isActiveCallMatch(remoteId, signal.callId)) {
      log(
        `[CALL] Dropping stale signal type=${signal.type} peer=${remoteId.slice(-8)} callId=${signal.callId.slice(0, 8)} reason=active_call_mismatch`,
      );
      return;
    }

    const isControlSignal = signal.type === 'CALL_ANSWER'
      || signal.type === 'CALL_REJECT'
      || signal.type === 'CALL_END'
      || signal.type === 'CALL_BUSY';

    if (
      isControlSignal
      && this.activeCallLastControlSignalTs !== null
      && signal.timestamp + MessageHandler.CALL_CONTROL_STALE_TOLERANCE_MS < this.activeCallLastControlSignalTs
    ) {
      log(
        `[CALL] Dropping stale signal type=${signal.type} peer=${remoteId.slice(-8)} callId=${signal.callId.slice(0, 8)} ` +
        `reason=timestamp_regression ts=${signal.timestamp} lastTs=${this.activeCallLastControlSignalTs}`,
      );
      return;
    }

    if (signal.type === 'CALL_ANSWER') {
      if (!this.activeCall || this.activeCall.direction !== 'outgoing') {
        log(
          `[CALL] Dropping answer from ${remoteId.slice(-8)} callId=${signal.callId.slice(0, 8)} reason=unexpected_direction`,
        );
        return;
      }
      if (this.activeCall.state !== 'ringing_out' && this.activeCall.state !== 'connecting') {
        log(
          `[CALL] Dropping answer from ${remoteId.slice(-8)} callId=${signal.callId.slice(0, 8)} reason=invalid_state state=${this.activeCall.state}`,
        );
        return;
      }

      this.activeCallLastControlSignalTs = Math.max(this.activeCallLastControlSignalTs ?? 0, signal.timestamp);
      this.onCallSignalReceived({ signal, receivedAt: Date.now() });
      this.setActiveCall({
        callId: signal.callId,
        peerId: remoteId,
        direction: this.activeCall?.direction ?? 'outgoing',
        mediaType: this.activeCall?.mediaType ?? 'audio',
        state: 'connecting',
      });
      return;
    }

    this.onCallSignalReceived({ signal, receivedAt: Date.now() });

    if (signal.type === 'CALL_REJECT' || signal.type === 'CALL_END' || signal.type === 'CALL_BUSY') {
      this.activeCallLastControlSignalTs = Math.max(this.activeCallLastControlSignalTs ?? 0, signal.timestamp);
      this.clearActiveCall(signal.reason);
    }
  }

  async sendCallSignal(input: CallSignalOutgoingInput): Promise<CallActionResponse> {
    try {
      const signedSignal = this.buildSignedCallSignal(input);
      await this.sendSignedCallSignal(signedSignal);
      return { success: true, error: null };
    } catch (error: unknown) {
      const message = errStr(error);
      const failureReason = this.classifyCallSendFailure(error);
      return {
        success: false,
        error: message,
        ...(failureReason ? { failureReason } : {}),
      };
    }
  }

  async startCall(
    peerId: string,
    callId: string,
    offerSdp: string,
  ): Promise<CallActionResponse> {
    try {
      this.ensureFastModeForCalls();
      this.ensureDirectCallContact(peerId);
    } catch (error: unknown) {
      return { success: false, error: errStr(error) };
    }

    const gate = this.callActivityRegistry.canUseDirectCall({ callId, peerId });
    if (!gate.allowed) {
      return { success: false, error: gate.error };
    }

    if (this.activeCall && (this.activeCall.callId !== callId || this.activeCall.peerId !== peerId)) {
      return { success: false, error: 'Another call is already in progress' };
    }

    if (!this.hasActiveConnectionToPeer(peerId)) {
      return {
        success: false,
        error: 'Peer appears offline/unreachable right now',
        failureReason: 'peer_unreachable',
      };
    }

    const sent = await this.sendCallSignal({
      type: 'CALL_OFFER',
      callId,
      toPeerId: peerId,
      offerSdp,
      mediaType: 'audio',
    });
    if (!sent.success) return sent;

    this.setActiveCall({
      callId,
      peerId,
      direction: 'outgoing',
      mediaType: 'audio',
      state: 'ringing_out',
    });
    return { success: true, error: null };
  }

  async acceptCall(
    peerId: string,
    callId: string,
    answerSdp: string,
  ): Promise<CallActionResponse> {
    const sent = await this.sendCallSignal({
      type: 'CALL_ANSWER',
      callId,
      toPeerId: peerId,
      answerSdp,
    });
    if (!sent.success) return sent;

    this.setActiveCall({
      callId,
      peerId,
      direction: 'incoming',
      mediaType: this.activeCall?.mediaType ?? 'audio',
      state: 'connecting',
    });
    return { success: true, error: null };
  }

  async rejectCall(
    peerId: string,
    callId: string,
    reason: 'rejected' | 'timeout' | 'offline' | 'policy' = 'rejected',
  ): Promise<CallActionResponse> {
    if (this.isActiveCallMatch(peerId, callId)) {
      this.clearActiveCall(reason);
    }
    const sent = await this.sendCallSignal({
      type: 'CALL_REJECT',
      callId,
      toPeerId: peerId,
      reason,
    });
    if (!sent.success) return sent;
    return { success: true, error: null };
  }

  async hangupCall(
    peerId: string,
    callId: string,
    reason: 'hangup' | 'disconnect' | 'failed' = 'hangup',
  ): Promise<CallActionResponse> {
    if (this.isActiveCallMatch(peerId, callId)) {
      this.clearActiveCall(reason);
    }
    const sent = await this.sendCallSignal({
      type: 'CALL_END',
      callId,
      toPeerId: peerId,
      reason,
    });
    if (!sent.success) return sent;
    return { success: true, error: null };
  }

  async teardownBlockedPeer(peerId: string): Promise<void> {
    const activeCall = this.activeCall?.peerId === peerId
      ? { callId: this.activeCall.callId }
      : null;

    if (activeCall) {
      try {
        const result = await this.hangupCall(peerId, activeCall.callId, 'hangup');
        if (!result.success) {
          console.warn(
            `[BLOCK] Active call teardown signal failed peer=${peerId.slice(-8)} call=${activeCall.callId.slice(0, 8)} reason=${result.error ?? 'unknown'}`,
          );
        }
      } catch (error: unknown) {
        console.warn(
          `[BLOCK] Active call teardown threw peer=${peerId.slice(-8)} call=${activeCall.callId.slice(0, 8)} reason=${errStr(error)}`,
        );
      } finally {
        if (this.isActiveCallMatch(peerId, activeCall.callId)) {
          this.clearActiveCall('hangup');
        }
      }
    }

    try {
      this.sessionManager.removePendingKeyExchange(peerId);
      this.sessionManager.clearSession(peerId);
    } catch (error: unknown) {
      console.warn(`[BLOCK] Failed to clear session for peer=${peerId.slice(-8)} reason=${errStr(error)}`);
    }

    try {
      await this.closePeerConnections(peerId, 'block');
    } catch (error: unknown) {
      console.warn(`[BLOCK] Failed to close peer connections for peer=${peerId.slice(-8)} reason=${errStr(error)}`);
    }
  }

  private async routeBucketNudge(remoteId: string, nudgePayload: BucketNudgePayload | null): Promise<void> {
    if (!nudgePayload) {
      log(`[NUDGE] Ignoring non-group nudge from ${remoteId.slice(-8)}`);
      return;
    }

    if (nudgePayload.kind === 'DIRECT_SESSION_RESET') {
      this.handleDirectSessionResetNudge(remoteId);
      return;
    }

    if (nudgePayload.kind === 'DIRECT_OFFLINE_REFETCH') {
      // TEMP_LOG: trace the prompt-refetch path that should cause the recipient to ACK.
      log(`[TEMP_LOG][OFFLINE][NUDGE][DIRECT_REFETCH] from=${remoteId.slice(-8)}`);
      this.scheduleDirectOfflineRefetchCheck(remoteId);
      return;
    }

    if (nudgePayload.kind === 'GROUP_REKEY_REFETCH') {
      this.handleGroupRefetchNudge(remoteId, nudgePayload.groupId);
      return;
    }
  }

  private handleDirectSessionResetNudge(remoteId: string): void {
    const directChat = this.database.getChatByPeerId(remoteId);
    if (!directChat) {
      log(`[NUDGE] Received direct-session-reset from ${remoteId.slice(-8)} but no direct chat exists, ignoring`);
      return;
    }

    this.keyExchange.deletePendingAcceptanceByPeerId(remoteId);
    this.sessionManager.removePendingKeyExchange(remoteId);
    this.sessionManager.clearSession(remoteId);
    log(`[NUDGE] Applied direct-session-reset from ${remoteId.slice(-8)} (chatId=${directChat.id})`);
  }

  private handleGroupRefetchNudge(remoteId: string, groupId: string): void {
    const groupChat = this.database.getChatByGroupId(groupId);
    const directChat = this.database.getChatByPeerId(remoteId);

    if (!groupChat) {
      if (directChat) {
        log(`[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for unknown group=${groupId.slice(0, 8)}, triggering direct offline check for chat ${directChat.id}`);
        this.scheduleNudgeOfflineCheck(remoteId, directChat.id);
        return;
      }

      log(`[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for unknown group=${groupId.slice(0, 8)}, ignoring`);
      return;
    }

    if (!this.isGroupRefetchNudgeSenderEligible(remoteId, groupChat.id, groupId)) {
      log(`[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for group=${groupId.slice(0, 8)} but sender is neither participant nor pending_invitee, ignoring`);
      return;
    }

    if (directChat) {
      log(`[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)} for group=${groupId.slice(0, 8)}, scheduling direct offline check for chat ${directChat.id}`);
      this.scheduleNudgeOfflineCheck(remoteId, directChat.id);
    }

    log(`[NUDGE] Received group-refetch nudge from ${remoteId.slice(-8)}, scheduling group check for chat ${groupChat.id}`);
    this.scheduleGroupNudgeOfflineCheck(remoteId, groupChat.id, groupId);
  }

  private isGroupRefetchNudgeSenderEligible(remoteId: string, groupChatId: number, groupId: string): boolean {
    const isParticipant = this.database.getChatParticipants(groupChatId).some((p) => p.peer_id === remoteId);
    const hasPendingInvite = this.database.getPendingAcksForGroup(groupId).some(
      (ack) => ack.message_type === 'GROUP_INVITE' && ack.target_peer_id === remoteId,
    );
    return isParticipant || hasPendingInvite;
  }

  private scheduleNudgeOfflineCheck(remoteId: string, chatId: number): void {
    const existingTimer = this.nudgeFetchTimers.get(remoteId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.nudgeFetchTimers.delete(remoteId);
      void this.runNudgeOfflineCheck(remoteId, chatId, false, true);
    }, BUCKET_NUDGE_FETCH_DELAY_MS);

    this.nudgeFetchTimers.set(remoteId, timer);
  }

  private scheduleDirectOfflineRefetchCheck(peerId: string): void {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) return;

    const existingTimer = this.nudgeFetchTimers.get(peerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.nudgeFetchTimers.delete(peerId);
      void this.runNudgeOfflineCheck(peerId, chat.id, false, false);
    }, DIRECT_OFFLINE_REFETCH_DELAY_MS);

    this.nudgeFetchTimers.set(peerId, timer);
  }

  private scheduleGroupNudgeOfflineCheck(remoteId: string, chatId: number, groupId: string): void {
    const key = `${remoteId}:${groupId}`;
    const existingTimer = this.groupNudgeFetchTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.groupNudgeFetchTimers.delete(key);
      void this.runGroupNudgeOfflineCheck(remoteId, chatId, groupId, false, true);
    }, BUCKET_NUDGE_FETCH_DELAY_MS);

    this.groupNudgeFetchTimers.set(key, timer);
  }

  private async runNudgeOfflineCheck(remoteId: string, chatId: number, isRetry: boolean, allowRetry: boolean): Promise<void> {
    try {
      const beforeTimestamp = this.database.getOfflineLastReadTimestampByPeerId(remoteId);
      log(`[NUDGE][CHECK][START] peer=${remoteId.slice(-8)} chatId=${chatId} isRetry=${isRetry} allowRetry=${allowRetry} beforeTs=${beforeTimestamp}`);
      const { checkedChatIds } = await this.checkOfflineMessages([chatId]);
      const afterTimestamp = this.database.getOfflineLastReadTimestampByPeerId(remoteId);
      const hasNewData = afterTimestamp > beforeTimestamp;
      log(`[NUDGE][CHECK][DONE] peer=${remoteId.slice(-8)} chatId=${chatId} isRetry=${isRetry} checkedChats=${checkedChatIds.length} beforeTs=${beforeTimestamp} afterTs=${afterTimestamp} hasNewData=${hasNewData}`);

      if (checkedChatIds.length > 0 && hasNewData) {
        this.onOfflineMessagesFetchComplete?.(checkedChatIds);
      }

      if (!isRetry && allowRetry && !hasNewData) {
        setTimeout(() => {
          log(`[NUDGE][CHECK][RETRY_SCHEDULED] peer=${remoteId.slice(-8)} chatId=${chatId} retryInMs=${BUCKET_NUDGE_RETRY_DELAY_MS}`);
          void this.runNudgeOfflineCheck(remoteId, chatId, true, allowRetry);
        }, BUCKET_NUDGE_RETRY_DELAY_MS);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[NUDGE] Failed offline bucket check for ${remoteId.slice(-8)}`);
    }
  }

  private async runGroupNudgeOfflineCheck(
    remoteId: string,
    chatId: number,
    groupId: string,
    isRetry: boolean,
    allowRetry: boolean
  ): Promise<void> {
    try {
      log(
        `[NUDGE][GROUP-CHECK][START] peer=${remoteId.slice(-8)} chatId=${chatId} group=${groupId.slice(0, 8)} ` +
        `isRetry=${isRetry} allowRetry=${allowRetry}`,
      );
      const { checkedChatIds, unreadFromChats } = await this.checkGroupOfflineMessages([chatId], { mode: 'nudge' });
      const unread = unreadFromChats.get(chatId) ?? 0;
      const hasNewData = unread > 0;
      log(
        `[NUDGE][GROUP-CHECK][DONE] peer=${remoteId.slice(-8)} chatId=${chatId} group=${groupId.slice(0, 8)} ` +
        `isRetry=${isRetry} checkedChats=${checkedChatIds.length} unread=${unread} hasNewData=${hasNewData}`,
      );

      if (checkedChatIds.length > 0 && hasNewData) {
        this.onOfflineMessagesFetchComplete?.(checkedChatIds);
      }

      if (!isRetry && allowRetry && !hasNewData) {
        setTimeout(() => {
          log(
            `[NUDGE][GROUP-CHECK][RETRY_SCHEDULED] peer=${remoteId.slice(-8)} chatId=${chatId} group=${groupId.slice(0, 8)} ` +
            `retryInMs=${BUCKET_NUDGE_RETRY_DELAY_MS}`,
          );
          void this.runGroupNudgeOfflineCheck(remoteId, chatId, groupId, true, allowRetry);
        }, BUCKET_NUDGE_RETRY_DELAY_MS);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[NUDGE] Failed group offline bucket check for ${remoteId.slice(-8)} group=${groupId.slice(0, 8)}`);
    }
  }

  private scheduleGroupStateUpdateCatchup(chatId: number, groupId: string, reason: string): void {
    const targetKeyVersion = this.database.getChatByGroupId(groupId)?.key_version ?? 0;
    const pending = this.groupStateCatchupPending.get(chatId);
    if (!pending || targetKeyVersion >= pending.targetKeyVersion) {
      this.groupStateCatchupPending.set(chatId, { groupId, targetKeyVersion, reason });
    }

    if (this.groupStateCatchupInFlight.has(chatId)) {
      log(
        `[GROUP-OFFLINE][STATE-CATCHUP][QUEUED] chatId=${chatId} group=${groupId.slice(0, 8)} ` +
        `reason=in_flight trigger=${reason} targetKeyVersion=${targetKeyVersion}`,
      );
      return;
    }

    void this.runQueuedGroupStateCatchup(chatId);
  }

  private handleDirectLinkReset(peerId: string): void {
    const myPeerId = this.node.peerId.toString();
    const userIdentity = this.usernameRegistry.getUserIdentity();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const creator = userIdentity
      ? new GroupCreator(this.createGroupCreatorDeps(userIdentity, myPeerId, myUsername))
      : null;
    const groupChats = this.database.getAllGroupChats();

    for (const chat of groupChats) {
      if (!chat.group_id) continue;

      const isParticipant = this.database
        .getChatParticipants(chat.id)
        .some((participant) => participant.peer_id === peerId);
      const hasPendingInvite = this.database
        .getPendingAcksForGroup(chat.group_id)
        .some((pending) => pending.message_type === 'GROUP_INVITE' && pending.target_peer_id === peerId);
      if (!isParticipant && !hasPendingInvite) continue;

      if (chat.group_creator_peer_id === myPeerId) {
        if (hasPendingInvite && creator) {
          log(
            `[DIRECT-RESET][INVITE_REPUBLISH] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=creator_local`,
          );
          void creator.republishPendingInvitesForPeer(chat.group_id, peerId).then((count) => {
            if (count > 0) {
              log(
                `[DIRECT-RESET][INVITE_REPUBLISH][DONE] peer=${peerId.slice(-8)} group=${chat.group_id?.slice(0, 8)} count=${count}`,
              );
            }
          }).catch((error: unknown) => {
            generalErrorHandler(
              error,
              `[DIRECT-RESET] Failed invite re-publish peer=${peerId.slice(-8)} group=${chat.group_id?.slice(0, 8)}`,
            );
          });
        }

        if (!isParticipant) continue;

        log(
          `[DIRECT-RESET][STATE_RESYNC] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=creator_local`,
        );
        if (!creator) {
          console.warn(
            `[DIRECT-RESET][STATE_RESYNC][SKIP] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=missing_identity`,
          );
        } else {
          void creator.resendCurrentStateToPeer(chat.group_id, peerId, 'direct_link_reset').catch((error: unknown) => {
            generalErrorHandler(
              error,
              `[DIRECT-RESET] Failed creator state resync peer=${peerId.slice(-8)} group=${chat.group_id?.slice(0, 8)}`,
            );
          });
        }
      }

      if (chat.group_creator_peer_id === peerId) {
        log(
          `[DIRECT-RESET][CATCHUP] peer=${peerId.slice(-8)} group=${chat.group_id.slice(0, 8)} reason=creator_remote`,
        );
        this.scheduleGroupStateUpdateCatchup(chat.id, chat.group_id, 'direct_link_reset');
      }
    }
  }

  private scheduleCreatorGroupCatchupForPeer(peerId: string, reason: string): void {
    const groupChats = this.database.getAllGroupChats();
    for (const chat of groupChats) {
      if (!chat.group_id) continue;
      if (chat.group_creator_peer_id !== peerId) continue;
      log(
        `[GROUP-OFFLINE][STATE-CATCHUP][RELINK] peer=${peerId.slice(-8)} chatId=${chat.id} group=${chat.group_id.slice(0, 8)} reason=${reason}`,
      );
      this.scheduleGroupStateUpdateCatchup(chat.id, chat.group_id, reason);
    }
  }

  private async runQueuedGroupStateCatchup(chatId: number): Promise<void> {
    while (true) {
      const pending = this.groupStateCatchupPending.get(chatId);
      if (!pending) {
        return;
      }
      this.groupStateCatchupPending.delete(chatId);

      const { groupId, reason, targetKeyVersion } = pending;
      const preCheckVersion = this.database.getChatByGroupId(groupId)?.key_version ?? targetKeyVersion;
      this.groupStateCatchupInFlight.add(chatId);
      const startedAt = Date.now();

      try {
        log(
          `[GROUP-OFFLINE][STATE-CATCHUP][START] chatId=${chatId} group=${groupId.slice(0, 8)} ` +
          `trigger=${reason} targetKeyVersion=${targetKeyVersion} preCheckVersion=${preCheckVersion}`,
        );
        const { checkedChatIds, unreadFromChats, gapWarnings } = await this.checkGroupOfflineMessages([chatId], { mode: 'nudge' });
        const unread = unreadFromChats.get(chatId) ?? 0;
        log(
          `[GROUP-OFFLINE][STATE-CATCHUP][DONE] chatId=${chatId} group=${groupId.slice(0, 8)} ` +
          `checked=${checkedChatIds.length} unread=${unread} gaps=${gapWarnings.length} took=${Date.now() - startedAt}ms`,
        );
        if (checkedChatIds.length > 0 && unread > 0) {
          this.onOfflineMessagesFetchComplete?.(checkedChatIds);
        }
      } catch (error: unknown) {
        generalErrorHandler(error, `[GROUP-OFFLINE] State-update catch-up failed for chat ${chatId}`);
      } finally {
        this.groupStateCatchupInFlight.delete(chatId);
      }

      const postCheckVersion = this.database.getChatByGroupId(groupId)?.key_version ?? preCheckVersion;
      if (postCheckVersion > preCheckVersion && !this.groupStateCatchupPending.has(chatId)) {
        this.groupStateCatchupPending.set(chatId, {
          groupId,
          reason: 'version_advanced_during_catchup',
          targetKeyVersion: postCheckVersion,
        });
      }
    }
  }

  private async readBucketNudgePayload(stream: StreamHandlerContext['stream']): Promise<BucketNudgePayload | null> {
    let parsed: { kind?: string; groupId?: string };
    try {
      parsed = await StreamHandler.readMessageFromStream<{ kind?: string; groupId?: string }>(stream, {
        maxBytes: MAX_BUCKET_NUDGE_ENVELOPE_BYTES,
        timeoutMs: INBOUND_STREAM_READ_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        // Ignore empty or invalid payloads and treat as plain nudges.
        return null;
      }
      throw error;
    }

    if (parsed.kind === 'DIRECT_SESSION_RESET') {
      return { kind: 'DIRECT_SESSION_RESET' };
    }
    if (parsed.kind === 'DIRECT_OFFLINE_REFETCH') {
      return { kind: 'DIRECT_OFFLINE_REFETCH' };
    }
    if (parsed.kind === 'GROUP_REKEY_REFETCH' && typeof parsed.groupId === 'string' && parsed.groupId.length > 0) {
      return { kind: 'GROUP_REKEY_REFETCH', groupId: parsed.groupId };
    }
    return null;
  }

  private schedulePeerActivityOfflineCheck(peerId: string): void {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) return;

    const last = this.peerActivityCheckCooldowns.get(peerId) ?? 0;
    if (Date.now() - last < BUCKET_NUDGE_COOLDOWN_MS) {
      return;
    }
    this.peerActivityCheckCooldowns.set(peerId, Date.now());

    // If a nudge/activity check is already queued for this peer, do not reset it.
    if (this.nudgeFetchTimers.has(peerId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.nudgeFetchTimers.delete(peerId);
      // Fallback B is a single extra check on key-exchange activity (no retry).
      void this.runNudgeOfflineCheck(peerId, chat.id, false, false);
    }, BUCKET_NUDGE_FETCH_DELAY_MS);

    this.nudgeFetchTimers.set(peerId, timer);
  }

  private startSessionCleanup(): void {
    setInterval(() => {
      if (this.sessionManager.getSessionsLength() !== 0) {
        this.sessionManager.cleanupExpiredSessions();
      }
      if (this.sessionManager.getPendingKeyExchangesLength() !== 0) {
        this.sessionManager.cleanupExpiredPendingKX();
      }
    }, SESSION_MANAGER_CLEANUP_INTERVAL);
  }

  private startGroupAckRepublisher(): void {
    if (this.groupAckStartupTimer) {
      clearTimeout(this.groupAckStartupTimer);
    }
    this.groupAckStartupTimer = setTimeout(() => {
      this.groupAckStartupTimer = null;
      void this.runGroupAckRepublishCycle();
      this.scheduleNextGroupAckRepublish();
    }, GROUP_ACK_REPUBLISH_STARTUP_DELAY);
  }

  private scheduleNextGroupAckRepublish(): void {
    if (this.groupAckRepublishTimer) {
      clearTimeout(this.groupAckRepublishTimer);
    }
    const jitter = (Math.random() * 2 - 1) * GROUP_ACK_REPUBLISH_JITTER;
    const delay = Math.max(1000, GROUP_ACK_REPUBLISH_INTERVAL + jitter);
    this.groupAckRepublishTimer = setTimeout(() => {
      void this.runGroupAckRepublishCycle();
      this.scheduleNextGroupAckRepublish();
    }, delay);
  }

  private scheduleImmediateGroupAckRepublish(): void {
    if (this.groupAckImmediateRepublishTimer) return;

    this.groupAckImmediateRepublishTimer = setTimeout(() => {
      this.groupAckImmediateRepublishTimer = null;
      void this.flushImmediateGroupAckRepublishQueue();
    }, 1000);
  }

  private enqueueImmediateGroupAckRepublish(peerId: string): void {
    this.groupAckImmediateTargets.add(peerId);
    this.scheduleImmediateGroupAckRepublish();
  }

  private async flushImmediateGroupAckRepublishQueue(): Promise<void> {
    const targets = Array.from(this.groupAckImmediateTargets);
    this.groupAckImmediateTargets.clear();
    if (targets.length === 0) return;

    const ran = await this.groupAckRepublisher.runCycleForTargets(targets);
    if (!ran) {
      for (const target of targets) {
        this.groupAckImmediateTargets.add(target);
      }
    }
    if (this.groupAckImmediateTargets.size > 0) {
      this.scheduleImmediateGroupAckRepublish();
    }
  }

  private async runGroupAckRepublishCycle(): Promise<void> {
    await this.groupAckRepublisher.runCycle();
  }

  private startGroupInfoRepublisher(): void {
    if (this.groupInfoStartupTimer) {
      clearTimeout(this.groupInfoStartupTimer);
    }
    this.groupInfoStartupTimer = setTimeout(() => {
      this.groupInfoStartupTimer = null;
      void this.runGroupInfoRepublishCycle();
      this.scheduleNextGroupInfoRepublish();
    }, GROUP_INFO_REPUBLISH_STARTUP_DELAY);
  }

  private scheduleNextGroupInfoRepublish(): void {
    if (this.groupInfoRepublishTimer) {
      clearTimeout(this.groupInfoRepublishTimer);
    }
    const jitter = (Math.random() * 2 - 1) * GROUP_INFO_REPUBLISH_JITTER;
    const delay = Math.max(1000, GROUP_INFO_REPUBLISH_INTERVAL + jitter);
    this.groupInfoRepublishTimer = setTimeout(() => {
      void this.runGroupInfoRepublishCycle();
      this.scheduleNextGroupInfoRepublish();
    }, delay);
  }

  private async runGroupInfoRepublishCycle(): Promise<void> {
    await this.groupInfoRepublisher.runCycle();
  }

  private async logPeerDialDiagnostics(targetPeerId: PeerId, context: string): Promise<void> {
    const targetPeerIdStr = targetPeerId.toString();
    const activeConnections = this.node
      .getConnections()
      .filter((conn) => conn.remotePeer.toString() === targetPeerIdStr)
      .map((conn) => conn.remoteAddr.toString());

    let knownAddrs: string[] = [];
    try {
      const peerData = await this.node.peerStore.get(targetPeerId);
      knownAddrs = (peerData.addresses ?? []).map((entry) => entry.multiaddr.toString());
    } catch {
      // Peer may not exist in peer store yet.
    }

    log(
      `[DIAL][${context}] target=${targetPeerIdStr} ` +
      `knownAddrs=${knownAddrs.length > 0 ? knownAddrs.join(',') : 'none'} ` +
      `activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'}`
    );
  }

  /**
   * Ensures a user exists and has an active session with key rotation handling.
   */
  async ensureUserSession(
    targetUsernameOrPeerId: string,
    message: string,
    isFileTransfer = false,
    initialUser?: User | null
  ): Promise<{
    user: User
    session: ConversationSession
    peerId: PeerId
    keyExchangeOccurred: boolean
  }> {
    const { user, targetPeerId, keyExchangeOccurred: initialKeyExchangeOccurred } =
      await this.resolveUserAndPeerForSession(targetUsernameOrPeerId, message, isFileTransfer, initialUser);
    let resolvedUser = user;
    let keyExchangeOccurred = initialKeyExchangeOccurred;

    const upgradedUser = await this.maybeUpgradeTrustedOutOfBandChat(
      targetPeerId,
      targetUsernameOrPeerId,
      message,
    );
    if (upgradedUser) {
      resolvedUser = upgradedUser;
      keyExchangeOccurred = true;
    }

    if (this.database.isBlocked(targetPeerId.toString())) {
      throw new Error('User is blocked. Cannot send messages.');
    }

    const {
      session: ensuredSession,
      keyExchangeOccurred: sessionKeyExchangeOccurred,
    } = await this.ensureConversationSession(targetPeerId, targetUsernameOrPeerId, message);
    let session = ensuredSession;
    if (sessionKeyExchangeOccurred) {
      keyExchangeOccurred = true;
    }
    this.assertNoPendingSessionRotation(targetPeerId);
    session = await this.rotateSessionIfNeeded(session, targetPeerId, targetUsernameOrPeerId);

    return { user: resolvedUser, session, peerId: targetPeerId, keyExchangeOccurred };
  }

  private async resolveUserAndPeerForSession(
    targetUsernameOrPeerId: string,
    message: string,
    isFileTransfer: boolean,
    initialUser?: User | null,
  ): Promise<{ user: User; targetPeerId: PeerId; keyExchangeOccurred: boolean }> {
    const initialUserProvided = initialUser !== undefined;
    let user: User | null;
    if (initialUserProvided) {
      user = initialUser;
    } else {
      const dbUser = this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
      user = dbUser && this.database.getChatByPeerId(dbUser.peer_id) ? dbUser : null;
    }

    if (user) {
      return {
        user,
        targetPeerId: peerIdFromString(user.peer_id),
        keyExchangeOccurred: false,
      };
    }

    if (isFileTransfer) {
      throw new Error('Cannot send file as first message. Send a text message first.');
    }

    const { targetPeerId, resolvedOfflinePublicKey } = await this.resolveUserRegistrationForSession(targetUsernameOrPeerId);
    const exchangedUser = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message, {
      recipientOfflinePublicKey: resolvedOfflinePublicKey,
    });
    if (!exchangedUser) {
      throw new Error('Key exchange failed');
    }

    return {
      user: exchangedUser,
      targetPeerId,
      keyExchangeOccurred: true,
    };
  }

  private async resolveUserRegistrationForSession(
    targetUsernameOrPeerId: string,
  ): Promise<{ targetPeerId: PeerId; resolvedOfflinePublicKey: string }> {
    try {
      let isPeerId = false;
      try { peerIdFromString(targetUsernameOrPeerId); isPeerId = true; } catch { /* username */ }
      const userRegistration = isPeerId
        ? await this.usernameRegistry.lookupByPeerId(targetUsernameOrPeerId)
        : await this.usernameRegistry.lookup(targetUsernameOrPeerId);
      return {
        targetPeerId: peerIdFromString(userRegistration.peerID),
        resolvedOfflinePublicKey: userRegistration.offlinePublicKey,
      };
    } catch (lookupErr: unknown) {
      const lookupErrorText = errStr(lookupErr);
      if (lookupErrorText === ERRORS.USERNAME_NOT_FOUND || lookupErrorText === 'Peer ID not found in DHT') {
        throw new Error(`User '${targetUsernameOrPeerId}' not found`);
      }
      throw new Error(`Failed to resolve user '${targetUsernameOrPeerId}': ${lookupErrorText}`);
    }
  }

  private async maybeUpgradeTrustedOutOfBandChat(
    targetPeerId: PeerId,
    targetUsernameOrPeerId: string,
    message: string,
  ): Promise<User | null> {
    const chat = this.database.getChatByPeerId(targetPeerId.toString());
    if (!chat?.trusted_out_of_band) return null;

    try {
      log(`Chat with ${targetUsernameOrPeerId} was established out-of-band. Upgrading to full key exchange if user is online...`);
      const exchangedUser = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message);
      if (exchangedUser) {
        log(`Upgraded to stronger encryption with ECDH-derived keys`);
        return exchangedUser;
      }

      console.warn(`Key exchange upgrade failed, falling back to out-of-band keys`);
      return null;
    } catch (err: unknown) {
      const errorText = errStr(err).toLowerCase();
      log(errorText);
      if (errorText.includes('all multiaddr dials failed')) {
        throw new Error('Trusted user is offline. Cannot upgrade. Sending offline message.');
      }
      throw err;
    }
  }

  private async ensureConversationSession(
    targetPeerId: PeerId,
    targetUsernameOrPeerId: string,
    message: string,
  ): Promise<{ session: ConversationSession; keyExchangeOccurred: boolean }> {
    const targetPeerIdStr = targetPeerId.toString();
    let session = this.sessionManager.getSession(targetPeerIdStr);
    if (session) {
      return { session, keyExchangeOccurred: false };
    }

    log(`No session found, initiating key exchange with ${targetUsernameOrPeerId}`);

    try {
      const exchangedUser = await this.keyExchange.initiateKeyExchange(targetPeerId, targetUsernameOrPeerId, message);
      if (!exchangedUser) {
        throw new Error('Key exchange failed');
      }

      session = this.sessionManager.getSession(targetPeerIdStr);
      if (!session) {
        throw new Error('Key exchange succeeded but session not created');
      }

      return { session, keyExchangeOccurred: true };
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'KEY_EXCHANGE_CANCELLED') {
        throw error;
      }
      throw error;
    }
  }

  private assertNoPendingSessionRotation(targetPeerId: PeerId): void {
    const hasPendingRotation = this.keyExchange.hasPendingRotation(targetPeerId.toString());
    if (hasPendingRotation) {
      throw new Error('Key rotation in progress - please wait and try again');
    }
  }

  private async rotateSessionIfNeeded(
    session: ConversationSession,
    targetPeerId: PeerId,
    targetUsernameOrPeerId: string,
  ): Promise<ConversationSession> {
    if (session.messageCount < this.keyExchange.getKeyRotationThreshold()) {
      return session;
    }

    log(`Rotating keys for ${targetUsernameOrPeerId} (${session.messageCount} messages sent)`);
    const succeeded = await this.keyExchange.rotateSessionKeys(targetPeerId);
    if (succeeded) {
      const rotatedSession = this.sessionManager.getSession(targetPeerId.toString());
      if (!rotatedSession) {
        throw new Error('Key rotation succeeded but session not found');
      }
      return rotatedSession;
    }

    this.sessionManager.clearSession(targetPeerId.toString());
    throw new Error('Key rotation failed - session cleared. Please try sending your message again.');
  }

  private getSendMessageErrorText(error: unknown): string {
    return errStr(error).toLowerCase();
  }

  private classifyMessageConnectivityFailure(
    primaryError: unknown,
    fallbackError?: unknown,
  ): MessageConnectivityFailure | undefined {
    const primaryErrorText = this.getSendMessageErrorText(primaryError);
    const fallbackErrorText = fallbackError
      ? this.getSendMessageErrorText(fallbackError)
      : '';
    const bootstrapMissing = this.database.getBootstrapNodes().length === 0;
    const noNetworkConnections = this.node.getConnections().length === 0;
    const peerReachabilityFailure = this.shouldFallbackOfflineSend(primaryErrorText);
    const dhtUnavailable = fallbackErrorText.includes(OFFLINE_DHT_UNAVAILABLE_MARKER_LOWER)
      || primaryErrorText.includes(OFFLINE_DHT_UNAVAILABLE_MARKER_LOWER);
    const groupNetworkFailure = primaryErrorText.includes(
      GROUP_OFFLINE_BACKUP_FAILED_MARKER,
    );

    if (
      bootstrapMissing
      && (
        dhtUnavailable
        || (noNetworkConnections && (peerReachabilityFailure || groupNetworkFailure))
      )
    ) {
      return 'bootstrap_unavailable';
    }

    if (peerReachabilityFailure) {
      return 'peer_unreachable';
    }

    return undefined;
  }

  private shouldFallbackOfflineSend(errorText: string): boolean {
    return MessageHandler.OFFLINE_FALLBACK_REGEX.test(errorText);
  }

  private async closePeerConnections(peerId: string, context: string): Promise<void> {
    const connections = this.node.getConnections().filter(
      conn => conn.remotePeer.toString() === peerId,
    );
    if (connections.length === 0) {
      return;
    }

    log(`[CONNECTION][PRUNE] closing ${connections.length} connection(s) to ${peerId.slice(0, 8)} context=${context}`);
    const closeResults = await Promise.allSettled(connections.map(conn => conn.close()));
    const failed = closeResults.filter((result) => result.status === 'rejected');
    if (failed.length > 0) {
      console.warn(
        `[CONNECTION][PRUNE] failed to close ${failed.length}/${connections.length} connection(s) to ${peerId.slice(0, 8)} context=${context}`,
      );
    }
  }

  /**
   * Close any connections we still hold to a peer that just failed to receive a
   * message within the send budget. When a peer goes away abruptly (e.g. laptop
   * lid closed), its TCP connection lingers in the connection manager as
   * "connected" until libp2p detects it's dead — so every follow-up send keeps
   * taking the synchronous online path and blocks for MESSAGE_TIMEOUT before
   * falling back. Pruning here flips the peer to disconnected immediately, so
   * (a) subsequent sends take the fast non-blocking offline path, and (b) the
   * offline DHT PUT is less likely to route through the dead peer.
   */
  private async pruneUnreachablePeerConnections(peerId: string): Promise<void> {
    await this.closePeerConnections(peerId, 'offline-send-failure');
  }

  private async storeOfflineMessageFallback(
    targetUsernameOrPeerId: string,
    message: string,
    user: User | null,
    outbound: { cid: string; replyToCid: string | undefined; transportBody: string },
  ): Promise<SendMessageResponse> {
    log(`Trying to send offline message to ${targetUsernameOrPeerId}`);

    if (this.node.getConnections().length === 0) {
      throw new Error(`Offline delivery unavailable: ${OFFLINE_DHT_UNAVAILABLE_MARKER}`);
    }

    const fallbackUser = user ?? this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId) ?? null;
    if (!fallbackUser) {
      throw new Error('User not found in database');
    }

    // Treat any lingering connection to this peer as dead and prune it
    await this.pruneUnreachablePeerConnections(fallbackUser.peer_id);

    const bucketSecret = this.database.getOfflineBucketSecretByPeerId(fallbackUser.peer_id);
    if (!bucketSecret) {
      const error = this.database.getChatByPeerId(fallbackUser.peer_id)
        ? 'Offline fallback unavailable right now'
        : 'Direct channel not established yet';
      throw new Error(error);
    }

    const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);
    const strippedMessage = await this.storeOfflineMessageDB(fallbackUser, writeBucketKey, message, outbound);
    log(`Peer likely offline; stored message for ${targetUsernameOrPeerId} as offline.`);
    return { success: true, messageSentStatus: 'offline', message: strippedMessage, error: null };
  }

  private async handleSendMessageFailure(
    targetUsernameOrPeerId: string,
    message: string,
    user: User | null,
    error: unknown,
    outbound: { cid: string; replyToCid: string | undefined; transportBody: string },
  ): Promise<SendMessageResponse> {
    const errorText = this.getSendMessageErrorText(error);
    log('sendMessage errorText:', errorText);

    if (this.shouldFallbackOfflineSend(errorText)) {
      return this.storeOfflineMessageFallback(targetUsernameOrPeerId, message, user, outbound);
    }

    if (errorText.includes("username not found")) {
      return { success: false, messageSentStatus: null, error: `User ${targetUsernameOrPeerId} not found` };
    }

    log(`Offline message fallback failed`);
    throw error;
  }

  /**
   * Capacity gate for the renderer's pre-send check. True = the send is allowed.
   * Only gates sends that would actually go to the offline bucket — a peer we're
   * currently connected to receives a realtime message regardless of how full
   * their offline mailbox is, so connected peers (and new contacts) are never
   * blocked.
   */
  checkOfflineCapacity(peerId: string, additional = 0): boolean {
    const connected = this.node.getConnections().some(conn => conn.remotePeer.toString() === peerId);
    if (connected) {
      return true; // goes online → offline bucket is irrelevant
    }
    const secret = this.database.getOfflineBucketSecretByPeerId(peerId);
    if (!secret) {
      return true; // not offline-capable (new contact) → no offline gate
    }
    // `additional` counts the caller's in-flight burst (optimistic rows not yet
    // persisted in the queue), so a fast burst doesn't all pass a stale pre-check.
    return this.offlineSendQueue.hasCapacity(this.keyExchange.constructWriteBucketKey(secret), additional);
  }

  /** Manual retry of a failed offline send (the queue requeues + reflushes). */
  retryOfflineSend(messageId: string): void {
    this.offlineSendQueue.retry(messageId);
  }

  // Dial + encrypt + write a direct (online) message. Shared by the synchronous
  // send path and the non-blocking background delivery.
  private async writeMessageOnline(
    targetPeerId: PeerId,
    message: string,
    session: ConversationSession,
    ackTimestamp?: number,
  ): Promise<void> {
    await this.logPeerDialDiagnostics(targetPeerId, 'send_message_online');
    const stream = await dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId,
      protocol: this.chatProtocol,
      context: 'send_message_online',
    });

    const myPeerId = this.node.peerId.toString();
    const myUsername = this.database.getUserByPeerId(myPeerId)?.username || `user_${myPeerId.slice(-8)}`;

    const encryptedMessage = MessageEncryption.encryptMessage(message, session);
    encryptedMessage.senderUsername = myUsername;
    if (ackTimestamp !== undefined) {
      encryptedMessage.offline_ack_timestamp = ackTimestamp;
    }

    await StreamHandler.writeMessageToStream(stream, encryptedMessage);

    this.sessionManager.incrementMessageCount(targetPeerId.toString());
    this.sessionManager.updateSessionUsage(targetPeerId.toString());
  }

  /**
   * Non-blocking send for a known, currently-unconnected, offline-capable contact.
   * Persists the message + queue row atomically, returns immediately with a
   * `sending` marker, then drives delivery in the background: try online first,
   * fall back to the batched offline queue. (Connected peers and new contacts use
   * the synchronous sendMessage path.)
   */
  private startNonBlockingOfflineSend(
    user: User,
    message: string,
    bucketSecret: string,
    outbound: { cid: string; replyToCid: string | undefined; transportBody: string },
  ): SendMessageResponse {
    const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);
    const chat = this.database.getChatByPeerId(user.peer_id);
    if (!chat) {
      return { success: false, messageSentStatus: null, error: 'Chat not found' };
    }
    const messageId = crypto.randomUUID();
    const now = Date.now();
    // Atomic gate: capacity check + both inserts in one transaction. Returns false
    // (and writes nothing) when the bucket is full — no concurrent overfill.
    // The DB row keeps the plain body + shared cid; the queued payload is the
    // envelope, so the flush encrypts what the recipient will decode.
    const inserted = this.database.createMessageWithPendingOfflineSend(
      {
        id: messageId,
        chat_id: chat.id,
        sender_peer_id: this.node.peerId.toString(),
        content: message,
        message_type: 'text',
        timestamp: new Date(now),
        local_send_state: 'sending',
        client_msg_id: outbound.cid,
        reply_to_client_id: outbound.replyToCid ?? null,
      },
      { peerId: user.peer_id, bucketKey: writeBucketKey, content: outbound.transportBody, createdAt: now },
      this.offlineSendQueue.capacityLimit(),
    );
    if (!inserted) {
      return { success: false, messageSentStatus: null, error: 'OFFLINE_BUCKET_FULL' };
    }
    // TEMP_LOG: show the queued-but-not-yet-flushed state that can race with a
    // peer reconnect and the connect-time refetch nudge.
    log(
      `[TEMP_LOG][OFFLINE][QUEUE][ENQUEUE] peer=${user.peer_id.slice(-8)} chatId=${chat.id} messageId=${messageId.slice(0, 8)} bucket=*${writeBucketKey.slice(-12)} pending=${this.database.countActivePendingOfflineSendsByBucket(writeBucketKey)}`,
    );
    this.notifyOfflineInboxCapacityChanged(chat.id);
    const strippedMessage: StrippedMessage = {
      chatId: chat.id,
      messageId,
      content: message,
      timestamp: now,
      messageType: 'text',
      clientMsgId: outbound.cid,
      replyToClientId: outbound.replyToCid,
    };
    void this.deliverNotConnectedInBackground(user, message, messageId, chat.id, writeBucketKey, outbound.transportBody);
    return { success: true, messageSentStatus: null, error: null, message: strippedMessage, localSendState: 'sending' };
  }

  notePowerResume(): void {
    this.lastPowerResumeAt = Date.now();
  }

  /** True once the node holds at least one relay-circuit reservation. */
  private isRelayReady(): boolean {
    return this.node.getMultiaddrs().some(addr => addr.toString().includes('/p2p-circuit'));
  }

  private async awaitRelayReadyAfterResume(): Promise<void> {
    if (this.database.getSessionNetworkMode() !== NETWORK_MODES.FAST) {
      return;
    }
    const sinceResumeMs = Date.now() - this.lastPowerResumeAt;
    if (sinceResumeMs > RESUME_RELAY_GRACE_MS || this.isRelayReady()) {
      return;
    }
    log(
      `[OFFLINE-SEND][RESUME] relay not ready ${sinceResumeMs}ms after resume; ` +
      `nudging refresh and waiting up to ${RESUME_RELAY_READY_WAIT_MS}ms`,
    );
    try {
      await triggerFastRelayRefresh();
    } catch (error: unknown) {
      log(`[OFFLINE-SEND][RESUME] relay refresh failed: ${errStr(error)}`);
    }
    const deadline = Date.now() + RESUME_RELAY_READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.isRelayReady()) {
        log(`[OFFLINE-SEND][RESUME] relay ready after ${Date.now() - (deadline - RESUME_RELAY_READY_WAIT_MS)}ms; attempting online`);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>(resolve => setTimeout(resolve, RESUME_RELAY_READY_POLL_MS));
    }
    log(`[OFFLINE-SEND][RESUME] relay still not ready after ${RESUME_RELAY_READY_WAIT_MS}ms; proceeding (likely offline fallback)`);
  }

  private async deliverNotConnectedInBackground(
    user: User,
    message: string,
    messageId: string,
    chatId: number,
    writeBucketKey: string,
    transportBody: string,
  ): Promise<void> {
    // Phase 1: attempt realtime delivery. ONLY failures here mean "peer offline →
    // queue it". Bookkeeping after a successful send is deliberately outside this
    // try, so a settle error can't enqueue a duplicate offline copy of a message
    // that was already delivered online.
    let online: { targetPeerId: PeerId; keyExchangeOccurred: boolean; ackTimestamp: number | undefined };
    try {
      await this.awaitRelayReadyAfterResume();
      const { session, peerId: targetPeerId, keyExchangeOccurred } = await this.ensureUserSession(
        user.peer_id, message, false, user,
      );
      const lastRead = this.database.getOfflineLastReadTimestampByPeerId(targetPeerId.toString());
      const lastAck = this.database.getOfflineLastAckSentByPeerId(targetPeerId.toString());
      const shouldSendAck = lastRead > lastAck;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => { reject(new Error('Message timeout')); }, MESSAGE_TIMEOUT)
      );
      await Promise.race([
        // Online attempt ships the envelope (so a recipient who happens to be
        // reachable persists the same cid); ensureUserSession above still uses the
        // plain text for session/relink resolution, mirroring the online path.
        this.writeMessageOnline(targetPeerId, transportBody, session, shouldSendAck ? lastRead : undefined),
        timeoutPromise,
      ]);
      online = { targetPeerId, keyExchangeOccurred, ackTimestamp: shouldSendAck ? lastRead : undefined };
    } catch (err: unknown) {
      // Peer offline / dial / key-exchange failed → hand to the batched offline queue.
      log(`[OFFLINE-SEND][BG] online attempt failed, queueing offline messageId=${messageId.slice(0, 8)} reason=${errStr(err)}`);
      void this.offlineSendQueue.flushBucket(writeBucketKey);
      return;
    }

    // Phase 2: delivered online — settle bookkeeping. Errors here must NOT fall
    // back to offline (the message is already delivered); just log.
    try {
      if (online.ackTimestamp !== undefined) {
        this.database.updateOfflineLastAckSentByPeerId(online.targetPeerId.toString(), online.ackTimestamp);
      }
      this.database.settlePendingOfflineSendsDelivered([messageId]);
      this.notifyOfflineInboxCapacityChanged(chatId);
      this.notifyMessageSendState({ messageId, chatId, outcome: 'delivered', messageSentStatus: 'online' });
      if (online.keyExchangeOccurred) {
        this.schedulePeerActivityOfflineCheck(online.targetPeerId.toString());
      }
      log(`[OFFLINE-SEND][BG] delivered online messageId=${messageId.slice(0, 8)}`);
    } catch (settleErr: unknown) {
      generalErrorHandler(settleErr, `[OFFLINE-SEND][BG] delivered online but settle failed messageId=${messageId.slice(0, 8)}`);
    }
  }

  async sendApplicationMessage(
    destination: { type: 'direct'; peerId: string } | { type: 'group'; groupId: string },
    request: SendApplicationMessageRequest,
  ): Promise<ApplicationMessageSendResult> {
    if (destination.type === 'group') {
      return this.groupMessaging.sendApplicationMessage(destination.groupId, request);
    }
    return this.sendDirectApplicationMessage(destination.peerId, request);
  }

  private async sendDirectApplicationMessage(
    peerId: string,
    request: SendApplicationMessageRequest,
  ): Promise<ApplicationMessageSendResult> {
    const user = this.database.getUserByPeerId(peerId);
    const chat = this.database.getChatByPeerId(peerId);
    if (!user || !chat || chat.type !== 'direct') {
      throw new Error('Direct application messages require an established direct chat');
    }
    if (
      request.persistence.owner === 'caller'
      && !this.database.messageExistsInChat(chat.id, request.message.cid)
    ) {
      throw new Error('Caller-owned application message row was not persisted before send');
    }

    const transportBody = encodeApplicationEnvelope(request.message);
    let messageSentStatus: 'online' | 'offline';
    try {
      const { session, peerId: targetPeerId } = await this.ensureUserSession(
        peerId,
        '',
        true,
        user,
      );
      const lastRead = this.database.getOfflineLastReadTimestampByPeerId(peerId);
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(peerId);
      const ackTimestamp = lastRead > lastAckSent ? lastRead : undefined;
      await Promise.race([
        this.writeMessageOnline(targetPeerId, transportBody, session, ackTimestamp),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Message timeout')), MESSAGE_TIMEOUT);
        }),
      ]);
      if (ackTimestamp !== undefined) {
        this.database.updateOfflineLastAckSentByPeerId(peerId, ackTimestamp);
      }
      messageSentStatus = 'online';
    } catch (error: unknown) {
      const errorText = this.getSendMessageErrorText(error);
      if (!this.shouldFallbackOfflineSend(errorText)) {
        throw error;
      }
      messageSentStatus = await this.storeDirectApplicationMessageOffline(
        user,
        transportBody,
        request.message.cid,
      );
    }

    const timestamp = Date.now();
    await this.persistTransportOwnedDirectApplicationMessage(
      chat.id,
      request,
      messageSentStatus,
      timestamp,
    );
    return {
      chatId: chat.id,
      messageId: request.message.cid,
      timestamp,
      messageSentStatus,
      warning: null,
      offlineBackupRetry: null,
    };
  }

  private async storeDirectApplicationMessageOffline(
    user: User,
    transportBody: string,
    messageId: string,
  ): Promise<'offline'> {
    if (this.node.getConnections().length === 0) {
      throw new Error(`Offline delivery unavailable: ${OFFLINE_DHT_UNAVAILABLE_MARKER}`);
    }
    const bucketSecret = this.database.getOfflineBucketSecretByPeerId(user.peer_id);
    if (!bucketSecret) {
      throw new Error('Offline fallback unavailable right now');
    }
    const identity = this.usernameRegistry.getUserIdentity();
    if (!identity) {
      throw new Error('User identity not available');
    }

    await this.pruneUnreachablePeerConnections(user.peer_id);
    const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);
    const myPeerId = this.node.peerId.toString();
    const myUsername = this.database.getUserByPeerId(myPeerId)?.username || `user_${myPeerId.slice(-8)}`;
    const lastRead = this.database.getOfflineLastReadTimestampByPeerId(user.peer_id);
    const lastAckSent = this.database.getOfflineLastAckSentByPeerId(user.peer_id);
    const ackTimestamp = lastRead > lastAckSent ? lastRead : undefined;
    const offlineMessage = OfflineMessageManager.createOfflineMessage(
      myPeerId,
      myUsername,
      transportBody,
      Buffer.from(user.offline_public_key, 'base64').toString(),
      identity.signingPrivateKey,
      writeBucketKey,
      ackTimestamp,
      messageId,
    );
    await OfflineMessageManager.storeOfflineMessage(
      this.node,
      writeBucketKey,
      offlineMessage,
      identity.signingPrivateKey,
      this.database,
      { category: 'regular' },
    );
    if (ackTimestamp !== undefined) {
      this.database.updateOfflineLastAckSentByPeerId(user.peer_id, ackTimestamp);
    }
    this.notifyOfflineInboxCapacityChangedForPeer(user.peer_id);
    return 'offline';
  }

  private async persistTransportOwnedDirectApplicationMessage(
    chatId: number,
    request: SendApplicationMessageRequest,
    messageSentStatus: 'online' | 'offline',
    timestamp: number,
  ): Promise<void> {
    if (request.persistence.owner === 'caller') {
      return;
    }
    if (request.persistence.owner === 'none') {
      return;
    }

    await this.database.createMessage({
      id: request.message.cid,
      chat_id: chatId,
      sender_peer_id: this.node.peerId.toString(),
      content: request.persistence.content,
      message_type: request.persistence.messageType,
      timestamp: new Date(timestamp),
      client_msg_id: request.message.cid,
      reply_to_client_id: request.persistence.replyToCid ?? null,
    });

    const myPeerId = this.node.peerId.toString();
    const senderUsername = this.database.getUserByPeerId(myPeerId)?.username || `user_${myPeerId.slice(-8)}`;
    this.onMessageReceived({
      chatId,
      messageId: request.message.cid,
      content: request.persistence.content,
      senderPeerId: myPeerId,
      senderUsername,
      timestamp,
      messageSentStatus,
      messageType: request.persistence.messageType,
      clientMsgId: request.message.cid,
      replyToClientId: request.persistence.replyToCid,
    });
  }

  async sendMessage(targetUsernameOrPeerId: string, message: string, replyToCid?: string): Promise<SendMessageResponse> {
    let user: User | null = null;
    // Reply feature: mint the cross-peer cid + build the transport envelope ONCE so
    // every delivery path (online, non-blocking offline queue, synchronous offline
    // fallback) ships the same cid; the recipient persists it as client_msg_id. We
    // store only the plain body locally. Declared before the try so the offline
    // fallback in `catch` can reuse the same cid.
    const cid = crypto.randomUUID();
    const normalizedReplyToCid = isValidCid(replyToCid) ? replyToCid : undefined;
    const transportBody = encodeEnvelope({ cid, text: message, replyToCid: normalizedReplyToCid });
    const outbound = { cid, replyToCid: normalizedReplyToCid, transportBody };
    try {
      const dbUser = this.database.getUserByPeerIdThenUsername(targetUsernameOrPeerId);
      const initialUser = dbUser && this.database.getChatByPeerId(dbUser.peer_id) ? dbUser : null;
      const hadUserAtStart = !!initialUser;

      // Non-blocking offline path: a known contact we're not currently connected
      // to, for which we hold the offline bucket secret. Returns immediately with
      // a `sending` marker and delivers in the background (online attempt, then
      // batched offline queue). Connected peers and new contacts fall through to
      // the synchronous flow below.
      if (initialUser) {
        const connected = this.node.getConnections().some(conn => conn.remotePeer.toString() === initialUser.peer_id);
        const bucketSecret = this.database.getOfflineBucketSecretByPeerId(initialUser.peer_id);
        if (!connected && bucketSecret) {
          return this.startNonBlockingOfflineSend(initialUser, message, bucketSecret, outbound);
        }
      }

      const hadConnectionBefore = initialUser
        ? this.node.getConnections().some(conn => conn.remotePeer.toString() === initialUser.peer_id)
        : false;

      const { user: resolvedUser, session, peerId: targetPeerId, keyExchangeOccurred } = await this.ensureUserSession(
        targetUsernameOrPeerId,
        message,
        false,
        initialUser
      );
      user = resolvedUser;

      if (keyExchangeOccurred && !hadUserAtStart) {
        this.scheduleCreatorGroupCatchupForPeer(targetPeerId.toString(), 'direct_relink_creator');
      }

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(targetPeerId.toString());
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(targetPeerId.toString());
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => { reject(new Error('Message timeout')); }, MESSAGE_TIMEOUT)
      );

      const res = await Promise.race([
        this.writeMessageOnline(
          targetPeerId, transportBody, session, shouldSendAck ? lastReadTimestamp : undefined,
        ).then(() => true),
        timeoutPromise,
      ]);
      if (res) {
        const strippedMessage = await this.saveMessageToDatabase(targetPeerId.toString(), message, 'online', { cid, replyToCid: normalizedReplyToCid });
        // Update ACK sent timestamp if we included an ACK
        if (shouldSendAck) {
          this.database.updateOfflineLastAckSentByPeerId(targetPeerId.toString(), lastReadTimestamp);
        }

        // Fallback B:
        // only after key exchange with an already-known contact and only if no connection existed
        // before this send (meaning connected-only BUCKET_NUDGE path could not have helped).
        if (keyExchangeOccurred && hadUserAtStart && !hadConnectionBefore) {
          this.schedulePeerActivityOfflineCheck(targetPeerId.toString());
        }

        log(`Encrypted message sent to ${targetUsernameOrPeerId}`);
        return { success: true, messageSentStatus: 'online', error: null, message: strippedMessage };
      }
      return { success: false, messageSentStatus: null, error: 'Failed to send message - timed out' };
    } catch (err: unknown) {
      // Silently handle cancelled key exchanges - user intentionally cancelled
      if (err instanceof Error && err.message === 'KEY_EXCHANGE_CANCELLED') {
        log(`Message not sent - key exchange was cancelled by user`);
        return { success: true, messageSentStatus: null, error: null };
      }

      console.error(`Failed to send message to ${targetUsernameOrPeerId}: ${errStr(err)}`);
      try {
        return await this.handleSendMessageFailure(targetUsernameOrPeerId, message, user, err, outbound);
      } catch (offlineErr: unknown) {
        generalErrorHandler(offlineErr, `Failed to send message`);
        const connectivityFailure = this.classifyMessageConnectivityFailure(err, offlineErr);
        return {
          success: false, messageSentStatus: null, error: 'Failed to send message: ' + (
            errStr(offlineErr)),
          ...(connectivityFailure ? { connectivityFailure } : {}),
        };
      }
    }
  }

  async sendGroupMessage(
    chatId: number,
    message: string,
    options?: { rekeyRetryHint?: boolean; replyToCid?: string }
  ): Promise<SendMessageResponse> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      return { success: false, messageSentStatus: null, error: 'Group chat not found' };
    }
    if (chat.type !== 'group') {
      return { success: false, messageSentStatus: null, error: 'Chat is not a group chat' };
    }
    if (!chat.group_id) {
      return { success: false, messageSentStatus: null, error: 'Group ID missing for chat' };
    }

    try {
      return await this.groupMessaging.sendGroupMessage(chat.group_id, message, options);
    } catch (error: unknown) {
      const connectivityFailure = this.classifyMessageConnectivityFailure(error);
      return {
        success: false,
        messageSentStatus: null,
        error: errStr(error),
        ...(connectivityFailure ? { connectivityFailure } : {}),
      };
    }
  }

  async leaveGroup(chatId: number): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

    if (this.groupCallOrchestrator?.hasActiveCall()) {
      const leaveCallResult = await this.groupCallOrchestrator.leaveGroupCall(chatId);
      if (!leaveCallResult.success && leaveCallResult.error !== 'No active group call') {
        console.warn(
          `[GROUP-CALL][LEAVE_GROUP][WARN] chat=${chatId} reason=${leaveCallResult.error ?? 'unknown'}`,
        );
      }
    }

    const responder = new GroupResponder(this.createGroupResponderDeps(userIdentity, myPeerId, myUsername));

    await responder.leaveGroup(chat.group_id);
    this.groupMessaging.deactivateGroup(chat.group_id);
  }

  async kickGroupMember(chatId: number, targetPeerId: string): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }
    if (!targetPeerId) {
      throw new Error('Target peer ID is required');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const creator = new GroupCreator(this.createGroupCreatorDeps(userIdentity, myPeerId, myUsername));

    await creator.kickMember(chat.group_id, targetPeerId);

    const refreshed = this.database.getChatByGroupId(chat.group_id);
    if (refreshed?.group_status === 'active' && (refreshed.key_version ?? 0) > 0) {
      this.groupMessaging.subscribeToGroupTopic(chat.group_id)
    }
  }

  async disbandGroup(chatId: number): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const creator = new GroupCreator(this.createGroupCreatorDeps(userIdentity, myPeerId, myUsername));

    await creator.disbandGroup(chat.group_id);
    this.groupMessaging.deactivateGroup(chat.group_id);
  }

  async requestGroupUpdate(chatId: number): Promise<void> {
    const chat = this.database.getChatByIdWithUsernameAndLastMsg(chatId, this.node.peerId.toString());
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }
    if (chat.group_creator_peer_id === this.node.peerId.toString()) {
      throw new Error('Group creator cannot request group update');
    }

    const status = chat.group_status;
    if (status === 'left' || status === 'removed' || status === 'disbanded') {
      throw new Error(`Cannot request group update while group status is ${status}`);
    }

    const previousKeyVersion = chat.key_version ?? 0;
    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) {
      throw new Error('Group creator is unknown');
    }

    // Prefetch creator direct bucket first so any already-pending control updates are applied.
    const creatorDirectChat = this.database.getChatByPeerId(creatorPeerId);
    if (creatorDirectChat) {
      log(
        `[GROUP][RESYNC_REQ][PREFETCH][START] group=${chat.group_id} creator=${creatorPeerId.slice(-8)} ` +
        `directChatId=${creatorDirectChat.id} prevKeyVersion=${previousKeyVersion}`,
      );
      await this.checkOfflineMessages([creatorDirectChat.id]);
      const refreshed = this.database.getChatByGroupId(chat.group_id);
      const refreshedKeyVersion = refreshed?.key_version ?? previousKeyVersion;
      if (refreshedKeyVersion > previousKeyVersion) {
        log(
          `[GROUP][RESYNC_REQ][PREFETCH][SKIP_SEND] group=${chat.group_id} creator=${creatorPeerId.slice(-8)} ` +
          `prevKeyVersion=${previousKeyVersion} refreshedKeyVersion=${refreshedKeyVersion}`,
        );
        return;
      }
      log(
        `[GROUP][RESYNC_REQ][PREFETCH][DONE] group=${chat.group_id} creator=${creatorPeerId.slice(-8)} ` +
        `prevKeyVersion=${previousKeyVersion} refreshedKeyVersion=${refreshedKeyVersion}`,
      );
    } else {
      log(
        `[GROUP][RESYNC_REQ][PREFETCH][SKIP] group=${chat.group_id} creator=${creatorPeerId.slice(-8)} reason=no_direct_chat`,
      );
    }

    const now = Date.now();
    this.pruneGroupStateResyncRequestCooldowns(now);
    const lastRequestAt = this.groupStateResyncRequestCooldowns.get(chat.group_id) ?? 0;
    const elapsed = now - lastRequestAt;
    if (elapsed < GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS - elapsed) / 1000);
      throw new Error(`Please wait ${waitSeconds}s before requesting another group update`);
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const responder = new GroupResponder(this.createGroupResponderDeps(userIdentity, myPeerId, myUsername));

    await responder.requestGroupStateResync(chat.group_id);
    this.groupStateResyncRequestCooldowns.set(chat.group_id, now);
  }

  private pruneGroupStateResyncRequestCooldowns(now: number): void {
    const maxAgeMs = GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS * 4;
    for (const [groupId, timestamp] of this.groupStateResyncRequestCooldowns.entries()) {
      if (now - timestamp > maxAgeMs) {
        this.groupStateResyncRequestCooldowns.delete(groupId);
      }
    }
  }

  async retryGroupOfflineBackup(chatId: number, messageId: string): Promise<{ success: boolean; error: string | null }> {
    try {
      await this.groupMessaging.retryOfflineBackup(chatId, messageId);
      return { success: true, error: null };
    } catch (error: unknown) {
      return {
        success: false,
        error: errStr(error),
      };
    }
  }

  discardDeletedMessageRetryState(messageIds: string[]): void {
    this.groupMessaging.discardDeletedMessageRetryState(messageIds);
  }

  async checkGroupOfflineMessages(chatIds?: number[], options?: GroupOfflineCheckOptions): Promise<{
    checkedChatIds: number[];
    failedChatIds: number[];
    unreadFromChats: Map<number, number>;
    gapWarnings: GroupOfflineGapWarning[];
  }> {
    try {
      return await this.groupOfflineManager.checkGroupOfflineMessages(chatIds, options);
    } catch (error: unknown) {
      generalErrorHandler(error, '[GROUP-OFFLINE] Failed to check group offline messages');
      return { checkedChatIds: [], failedChatIds: [], unreadFromChats: new Map(), gapWarnings: [] };
    }
  }

  async checkRecentlyActiveGroupOfflineMessages(
    sinceMs: number,
    limit: number,
    alwaysIncludeChatIds?: number[],
  ): Promise<void> {
    try {
      const recent = this.groupOfflineManager.resolveRecentlyActiveGroupChats(sinceMs, limit);
      const chatIds = new Set<number>(recent.map(c => c.id));
      if (alwaysIncludeChatIds) {
        for (const id of alwaysIncludeChatIds) {
          chatIds.add(id);
        }
      }
      if (chatIds.size === 0) {
        return;
      }
      await this.groupOfflineManager.checkGroupOfflineMessages([...chatIds]);
    } catch (error: unknown) {
      generalErrorHandler(error, '[GROUP-OFFLINE] Failed to check recently active group offline messages');
    }
  }

  /**
   * Build the signed OfflineMessage for a queued send. Deterministic from the
   * row (stable id + timestamp) so a retry rebuilds an equivalent message the
   * recipient dedupes by id. No ACK piggyback here — that would make rebuilds
   * non-idempotent (the ack timestamp changes between attempts).
   */
  private buildOfflineMessageForQueue(row: PendingOfflineSend): OfflineMessage {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }
    const recipient = this.database.getUserByPeerId(row.peer_id);
    if (!recipient?.offline_public_key) {
      throw new Error(`No offline public key for ${row.peer_id}`);
    }
    const myPeerId = this.node.peerId.toString();
    const myUsername = this.database.getUserByPeerId(myPeerId)?.username || `user_${myPeerId.slice(-8)}`;
    return OfflineMessageManager.createOfflineMessage(
      myPeerId,
      myUsername,
      row.content,
      Buffer.from(recipient.offline_public_key, 'base64').toString(),
      userIdentity.signingPrivateKey,
      row.bucket_key,
      undefined,
      row.message_id,
      row.created_at,
    );
  }

  private async storeOfflineMessageDB(
    user: User,
    writeBucketKey: string,
    message: string,
    outbound: { cid: string; replyToCid: string | undefined; transportBody: string },
  ): Promise<StrippedMessage> {
    try {
      const userIdentity = this.usernameRegistry.getUserIdentity();
      if (!userIdentity) throw new Error('User identity not available');

      // Get last registered username or generate fallback
      const myPeerId = this.node.peerId.toString();
      const myUser = this.database.getUserByPeerId(myPeerId);
      const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

      // Check if we need to send an ACK for offline messages we've read
      const lastReadTimestamp = this.database.getOfflineLastReadTimestampByPeerId(user.peer_id);
      const lastAckSent = this.database.getOfflineLastAckSentByPeerId(user.peer_id);
      const shouldSendAck = lastReadTimestamp > lastAckSent;

      // The DHT payload is the envelope (recipient decodes cid + reply ref).
      const offlineMessage = OfflineMessageManager.createOfflineMessage(
        this.node.peerId.toString(),
        myUsername,
        outbound.transportBody,
        Buffer.from(user.offline_public_key, 'base64').toString(),
        userIdentity.signingPrivateKey,
        writeBucketKey,
        shouldSendAck ? lastReadTimestamp : undefined
      );

      // Store in DHT at our WRITE bucket
      await OfflineMessageManager.storeOfflineMessage(
        this.node,
        writeBucketKey,
        offlineMessage,
        userIdentity.signingPrivateKey,
        this.database,
        { category: 'regular' },
      );
      log(`Stored encrypted offline message for ${user.username}`);

      // Update ACK sent timestamp if we included an ACK
      if (shouldSendAck) {
        this.database.updateOfflineLastAckSentByPeerId(user.peer_id, lastReadTimestamp);
      }

      const strippedMessage = await this.saveMessageToDatabase(user.peer_id, message, 'offline', { cid: outbound.cid, replyToCid: outbound.replyToCid });
      this.notifyOfflineInboxCapacityChanged(strippedMessage.chatId);
      log(`Saved offline message to sender's database`);
      return strippedMessage;
    } catch (error: unknown) {
      generalErrorHandler(error);
      throw error;
    }
  }

  private async saveMessageToDatabase(
    peerId: string,
    message: string,
    messageSentStatus: MessageSentStatus,
    // Reply feature: the shared cross-peer id and reply ref for this outbound copy.
    // Omitted by paths that don't carry an envelope yet (offline) — then
    // `client_msg_id` defaults to the row id (see database.createMessage).
    meta?: { cid?: string | undefined; replyToCid?: string | undefined },
  ): Promise<StrippedMessage> {
    const chat = this.database.getChatByPeerId(peerId);
    if (!chat) {
      console.error(`[MESSAGE] Chat missing while saving outbound message for peer=${peerId.slice(-8)}`);
      throw new Error('Chat not found');
    }

    const timestamp = new Date();
    const rowId = crypto.randomUUID();
    const messageId = await this.database.createMessage({
      id: rowId,
      chat_id: chat.id,
      sender_peer_id: this.node.peerId.toString(),
      content: message,
      message_type: 'text',
      timestamp,
      client_msg_id: meta?.cid,
      reply_to_client_id: meta?.replyToCid ?? null,
    });
    log(`Saved message with ID: ${messageId}`);

    // The shared cid: explicit when provided (online), else the row id (which is
    // what createMessage stored as client_msg_id by default).
    const clientMsgId = meta?.cid ?? rowId;

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

    this.onMessageReceived({
      messageId,
      chatId: chat.id,
      senderPeerId: this.node.peerId.toString(),
      senderUsername: myUsername,
      content: message,
      timestamp: timestamp.getTime(),
      messageSentStatus,
      clientMsgId,
      replyToClientId: meta?.replyToCid,
    });

    return {
      chatId: chat.id,
      messageId,
      content: message,
      timestamp: timestamp.getTime(),
      messageType: 'text',
      clientMsgId,
      replyToClientId: meta?.replyToCid,
    };
  }

  // Check offline messages (direct)
  private async performOfflineMessageCheck(chatIds?: number[]): Promise<{ checkedChatIds: number[], unreadFromChats: Map<number, number> }> {
    const runId = ++this.offlineCheckRunSeq;
    log(chatIds
      ? `Checking for offline messages in ${chatIds.length} chat${chatIds.length > 1 ? 's' : ''}...`
      : "Checking for offline direct messages (top 10)...");
    log(
      `[OFFLINE][CHECK][START] run=${runId} scope=${chatIds ? `chat_ids:${chatIds.join(',')}` : 'default'}`,
    );

    const bucketInfoList: OfflineReadBucketInfoAny[] = chatIds
      ? this.database.getOfflineReadBucketInfoForChats(chatIds)
      : this.database.getOfflineReadBucketInfo(this.getChatsToCheckForOfflineMessages());

    if (bucketInfoList.length === 0) {
      log('No chats found for offline message check');
      log(`[OFFLINE][CHECK][DONE] run=${runId} checkedChats=0 fetchedMessages=0 processedMessages=0`);
      return { checkedChatIds: [], unreadFromChats: new Map() };
    }

    const readBuckets: Array<{ chatId?: number; key: string; peerPubKey: string; peerId: string; lastReadTimestamp: number }> = [];
    const checkedChats: number[] = [];

    for (const info of bucketInfoList) {
      const readBucketKey = this.keyExchange.constructReadBucketKey(
        info.offline_bucket_secret,
        info.signing_public_key
      );
      if (!readBucketKey.startsWith(this.expectedOfflineBucketPrefix)) {
        const chatIdForLog = hasChatId(info) ? String(info.chat_id) : 'n/a';
        console.warn(
          `[MODE-GUARD][REJECT][offline_lookup] run=${runId} chatId=${chatIdForLog} peer=${info.peer_id} ` +
          `reason=bucket_prefix_mismatch expectedPrefix=${this.expectedOfflineBucketPrefix} got=${redactBucketKey(readBucketKey)}`
        );
        continue;
      }

      const chatId = hasChatId(info) ? info.chat_id : undefined;

      const bucket = {
        key: readBucketKey,
        peerPubKey: info.signing_public_key,
        peerId: info.peer_id,
        lastReadTimestamp: info.offline_last_read_timestamp,
        ...(chatId !== undefined && { chatId })
      };

      readBuckets.push(bucket);

      if (chatId !== undefined) {
        checkedChats.push(chatId);
      }
    }

    const bucketKeys = readBuckets.map(b => b.key);
    log(
      `[OFFLINE][CHECK][BUCKETS] run=${runId} count=${readBuckets.length} peers=${readBuckets.map(b => b.peerId.slice(-8)).join(',')}`,
    );
    const store = await OfflineMessageManager.getOfflineMessages(this.node, bucketKeys);

    if (store.messages.length === 0) {
      log('No offline direct messages found');
      log(
        `[OFFLINE][CHECK][DONE] run=${runId} checkedChats=${checkedChats.length} fetchedMessages=0 processedMessages=0`,
      );
      return { checkedChatIds: checkedChats, unreadFromChats: new Map() };
    }

    log(`Found ${store.messages.length} offline direct message(s)`);

    // extract unique messages per bucket
    const byBucket = new Map<string, number>();
    const uniquePerBucket = new Map<string, Set<string>>();

    for (const msg of store.messages) {
      const bucket = msg.bucket_key ?? 'unknown';
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
      if (!uniquePerBucket.has(bucket)) {
        uniquePerBucket.set(bucket, new Set());
      }
      uniquePerBucket.get(bucket)!.add(msg.id);
    }

    // Track max timestamp per peer to update after processing
    const maxTimestampPerPeer: Map<string, number> = new Map();
    let processedCount = 0;
    const deferredGroupInfoSyncGroups = new Set<string>();

    const unreadFromChats: Map<number, number> = new Map();
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error("No user identity available")
    }

    for (const msg of store.messages) {
      if (!msg.bucket_key) continue;
      try {
        const bucketInfo = readBuckets.find(b => b.key === msg.bucket_key);
        if (!bucketInfo) {
          log(`Skipping message - unknown bucket key`);
          continue;
        }

        if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) {
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=timestamp_invalid msgTs=${msg.timestamp}`,
          );
          continue;
        }
        if (msg.timestamp > Date.now() + OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS) {
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=timestamp_too_far_future msgTs=${msg.timestamp}`,
          );
          continue;
        }

        // Skip messages we've already processed (based on last read timestamp)
        if (msg.timestamp <= bucketInfo.lastReadTimestamp) {
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=timestamp_leq_last_read msgTs=${msg.timestamp} lastReadTs=${bucketInfo.lastReadTimestamp}`,
          );
          continue;
        }

        const isSignatureValid = OfflineMessageManager.verifyOfflineMessageSignature(
          msg,
          bucketInfo.peerPubKey,
          msg.bucket_key
        );

        if (!isSignatureValid) {
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=signature_invalid`,
          );
          continue;
        }

        // Decrypt sender info to get username for display
        const senderInfo = MessageEncryption.decryptSenderInfo(msg, userIdentity.offlinePrivateKey);
        if (!senderInfo) {
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} reason=sender_info_decrypt_failed`,
          );
          continue;
        }

        // Skip messages sent by ourselves (shouldn't happen)
        if (senderInfo.peer_id === this.node.peerId.toString()) {
          log(`[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} reason=own_message`);
          continue;
        }
        if (senderInfo.peer_id !== bucketInfo.peerId) {
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} reason=sender_peer_mismatch sender=${senderInfo.peer_id.slice(-8)} bucketPeer=${bucketInfo.peerId.slice(-8)}`,
          );
          continue;
        }
        this.reactivateRetiredPendingAcksForPeer(senderInfo.peer_id);

        // Process ACK if included - prune acknowledged messages from our local sent store.
        if (senderInfo.offline_ack_timestamp) {
          // eslint-disable-next-line no-await-in-loop
          await this.processOfflineAck(senderInfo.peer_id, senderInfo.offline_ack_timestamp);
        }

        // Standalone ACK: the ACK was processed above. Do NOT deliver it and do NOT
        // advance maxTimestampPerPeer — advancing our lastReadTs here would make us
        // ACK back, producing an infinite ACK ping-pong.
        if (msg.signed_payload?.ack_only === true) {
          log(`[OFFLINE-ACK][IN][OFFLINE] run=${runId} from=${senderInfo.peer_id.slice(-8)} ts=${senderInfo.offline_ack_timestamp}`);
          continue;
        }

        // Decrypt message content early so we can inspect its type
        let decryptedContent = msg.content;
        if (msg.message_type === 'encrypted' || msg.message_type === 'hybrid') {
          decryptedContent = MessageEncryption.decryptOfflineMessage(msg, userIdentity.offlinePrivateKey);
        }

        // Check if this is a group control message - should we await this or let it process in bg?
        // eslint-disable-next-line no-await-in-loop
        const groupResult = await this.tryRouteGroupControlMessage(
          decryptedContent,
          senderInfo,
          deferredGroupInfoSyncGroups,
        );
        if (groupResult === 'retry') {
          log(
            `[OFFLINE][MSG][GROUP] run=${runId} msgId=${msg.id} from=${senderInfo.username} result=retry`,
          );
          continue;
        }
        if (groupResult === 'handled') {
          // Advance timestamp so we don't re-process
          const currentMax = maxTimestampPerPeer.get(bucketInfo.peerId) ?? 0;
          if (msg.timestamp > currentMax) {
            maxTimestampPerPeer.set(bucketInfo.peerId, msg.timestamp);
          }
          log(
            `[OFFLINE][MSG][GROUP] run=${runId} msgId=${msg.id} from=${senderInfo.username} result=handled`,
          );
          continue;
        }

        // 'not_group': fall through to regular message handling
        if (this.database.messageExists(msg.id)) {
          const persistedMax = maxTimestampPerPeer.get(bucketInfo.peerId) ?? 0;
          if (msg.timestamp > persistedMax) {
            maxTimestampPerPeer.set(bucketInfo.peerId, msg.timestamp);
          }
          log(
            `[OFFLINE][MSG][SKIP] run=${runId} msgId=${msg.id} peer=${bucketInfo.peerId.slice(-8)} reason=already_persisted`,
          );
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const { chatId: msgChatId, inserted } = await this.saveOfflineMessageToDatabase(msg, senderInfo, decryptedContent);
        if (inserted) {
          const unreadCount = unreadFromChats.get(msgChatId) ?? 0;
          unreadFromChats.set(msgChatId, unreadCount + 1);
          processedCount++;
        }

        // Track max timestamp for this peer
        const currentMax = maxTimestampPerPeer.get(bucketInfo.peerId) ?? 0;
        if (msg.timestamp > currentMax) {
          maxTimestampPerPeer.set(bucketInfo.peerId, msg.timestamp);
        }

        log(
          `[OFFLINE][MSG][TEXT] run=${runId} msgId=${msg.id} from=${senderInfo.peer_id.slice(-8)} result=${inserted ? 'inserted' : 'duplicate'}`,
        );
      } catch (error: unknown) {
        generalErrorHandler(error, `Failed to process offline message`);
      }
    }

    for (const groupId of deferredGroupInfoSyncGroups) {
      this.scheduleDeferredGroupInfoSync(groupId);
    }

    // Update last read timestamp for each peer
    for (const [peerId, maxTimestamp] of maxTimestampPerPeer.entries()) {
      this.database.updateOfflineLastReadTimestampByPeerId(peerId, maxTimestamp);
      log(`[OFFLINE][PROCESS] run=${runId} updatedLastRead peer=${peerId.slice(-8)} ts=${maxTimestamp}`);
      // We owe this peer an ACK now (read advanced). Fire-and-forget; a failure
      // leaves lastAckSent behind so it retries on the next read / peer-connect.
      void this.flushPendingOfflineAck(peerId);
    }

    if (processedCount > 0) {
      log(`Processed ${processedCount} new offline direct messages`);
    }
    log(
      `[OFFLINE][CHECK][DONE] run=${runId} checkedChats=${checkedChats.length} fetchedMessages=${store.messages.length} processedMessages=${processedCount} updatedPeers=${maxTimestampPerPeer.size}`,
    );

    return { checkedChatIds: checkedChats, unreadFromChats: unreadFromChats };
  }

  async checkOfflineMessages(chatIds?: number[]): Promise<OfflineCheckResult> {
    const scopeKey = chatIds && chatIds.length > 0
      ? [...chatIds].sort((a, b) => a - b).join(',')
      : 'default';

    const inFlight = this.offlineCheckInFlight.get(scopeKey);
    if (!inFlight) {
      return this.runGuardedOfflineCheck(scopeKey, chatIds);
    }

    // A run for this scope is already in flight
    let pending = this.offlineCheckPending.get(scopeKey);
    if (!pending) {
      pending = inFlight
        .catch(() => undefined)
        .then(() => {
          this.offlineCheckPending.delete(scopeKey);
          return this.runGuardedOfflineCheck(scopeKey, chatIds);
        });
      this.offlineCheckPending.set(scopeKey, pending);
    }
    log(`[OFFLINE][CHECK][COALESCE] scope=${scopeKey}`);
    return pending;
  }

  private runGuardedOfflineCheck(scopeKey: string, chatIds?: number[]): Promise<OfflineCheckResult> {
    const run = (async (): Promise<OfflineCheckResult> => {
      try {
        return await this.performOfflineMessageCheck(chatIds);
      } catch (error: unknown) {
        generalErrorHandler(error);
        return { checkedChatIds: [], unreadFromChats: new Map() };
      }
    })();
    this.offlineCheckInFlight.set(scopeKey, run);
    void run.finally(() => {
      // Only clear if we're still the registered run
      if (this.offlineCheckInFlight.get(scopeKey) === run) {
        this.offlineCheckInFlight.delete(scopeKey);
      }
    });
    return run;
  }

  private reactivateRetiredPendingAcksForPeer(peerId: string): void {
    const reactivatedCount = this.database.reactivateRetiredPendingAcksForTarget(peerId);
    if (reactivatedCount > 0) {
      log(
        `[GROUP-ACK][REACTIVATE] peer=${peerId.slice(-8)} count=${reactivatedCount}`,
      );
      this.enqueueImmediateGroupAckRepublish(peerId);
    }
  }

  private scheduleDeferredGroupInfoSync(groupId: string): void {
    if (!groupId) return;

    if (this.groupInfoSyncInFlight.has(groupId)) {
      this.groupInfoSyncPending.add(groupId);
      log(
        `[GROUP-INFO][SYNC][DEFER] group=${groupId} reason=in_flight`,
      );
      return;
    }

    const syncPromise = this.runDeferredGroupInfoSync(groupId)
      .catch((error: unknown) => {
        generalErrorHandler(error, `[GROUP-INFO][SYNC] Deferred sync failed for group=${groupId}`);
      })
      .finally(() => {
        this.groupInfoSyncInFlight.delete(groupId);
        if (this.groupInfoSyncPending.delete(groupId)) {
          this.scheduleDeferredGroupInfoSync(groupId);
        }
      });

    this.groupInfoSyncInFlight.set(groupId, syncPromise);
  }

  private async runDeferredGroupInfoSync(groupId: string): Promise<void> {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;
    const responder = new GroupResponder(this.createGroupResponderDeps(userIdentity, myPeerId, myUsername));

    await responder.syncGroupInfoForLocalChat(groupId);
  }

  /**
   * If we owe a peer an offline ACK (we've read past what we've acknowledged),
   * send a standalone ACK and advance lastAckSent — but only on success, and
   * monotonically, so a failure retries on the next trigger.
   */
  async flushPendingOfflineAck(peerId: string): Promise<void> {
    try {
      const lastRead = this.database.getOfflineLastReadTimestampByPeerId(peerId);
      const lastAck = this.database.getOfflineLastAckSentByPeerId(peerId);
      // TEMP_LOG: show when a recipient owes a direct offline ACK after reading.
      log(
        `[TEMP_LOG][OFFLINE][ACK][FLUSH] peer=${peerId.slice(-8)} lastRead=${lastRead} lastAck=${lastAck} action=${lastRead <= lastAck ? 'skip' : 'send'}`,
      );
      if (lastRead <= lastAck) {
        return;
      }
      const sent = await this.sendStandaloneOfflineAck(peerId, lastRead);
      if (sent) {
        const current = this.database.getOfflineLastAckSentByPeerId(peerId);
        if (lastRead > current) {
          this.database.updateOfflineLastAckSentByPeerId(peerId, lastRead);
        }
        log(`[OFFLINE-ACK][SENT] peer=${peerId.slice(-8)} ts=${lastRead}`);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, `[OFFLINE-ACK] flush failed peer=${peerId.slice(-8)}`);
    }
  }

  /**
   * Send a standalone ACK (offline_ack_timestamp, no content): online over an
   * existing session if connected, else durably queued into our write-bucket for
   * the peer. Returns true only if the ACK was actually delivered/persisted.
   */
  private async sendStandaloneOfflineAck(peerId: string, ackTimestamp: number): Promise<boolean> {
    const recipient = this.database.getUserByPeerId(peerId);
    if (!recipient?.offline_public_key) {
      // TEMP_LOG: missing recipient/offline key prevents ACK creation entirely.
      log(`[TEMP_LOG][OFFLINE][ACK][SEND][SKIP] peer=${peerId.slice(-8)} reason=missing_recipient_or_offline_key`);
      return false;
    }
    const myPeerId = this.node.peerId.toString();
    const myUsername = this.database.getUserByPeerId(myPeerId)?.username || `user_${myPeerId.slice(-8)}`;

    // Fast path: online ACK over an existing session (no key exchange).
    const session = this.sessionManager.getSession(peerId);
    const connected = this.node.getConnections().some(conn => conn.remotePeer.toString() === peerId);
    // TEMP_LOG: show which ACK transport path we're about to try.
    log(
      `[TEMP_LOG][OFFLINE][ACK][SEND][START] peer=${peerId.slice(-8)} ackTs=${ackTimestamp} connected=${connected} hasSession=${!!session}`,
    );
    if (connected && session) {
      try {
        const ackMessage = MessageEncryption.encryptMessage('', session);
        ackMessage.senderUsername = myUsername;
        ackMessage.offline_ack_timestamp = ackTimestamp;
        ackMessage.ack_only = true;
        const stream = await dialProtocolWithRelayFallback({
          node: this.node,
          database: this.database,
          targetPeerId: peerIdFromString(peerId),
          protocol: this.chatProtocol,
          context: 'offline_ack',
        });
        await StreamHandler.writeMessageToStream(stream, ackMessage);
        // TEMP_LOG: online ACK reached the live stream path.
        log(`[TEMP_LOG][OFFLINE][ACK][SEND][ONLINE_OK] peer=${peerId.slice(-8)} ackTs=${ackTimestamp}`);
        return true;
      } catch (error: unknown) {
        log(`[OFFLINE-ACK] online ack failed, falling back to offline peer=${peerId.slice(-8)} reason=${errStr(error)}`);
      }
    }

    // Durable path: offline-queued ACK.
    const bucketSecret = this.database.getOfflineBucketSecretByPeerId(peerId);
    if (!bucketSecret) {
      // TEMP_LOG: without the shared bucket secret we cannot queue a durable ACK.
      log(`[TEMP_LOG][OFFLINE][ACK][SEND][SKIP] peer=${peerId.slice(-8)} reason=missing_bucket_secret`);
      return false;
    }
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      // TEMP_LOG: identity loss would prevent signing the durable ACK.
      log(`[TEMP_LOG][OFFLINE][ACK][SEND][SKIP] peer=${peerId.slice(-8)} reason=missing_user_identity`);
      return false;
    }
    try {
      const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);
      const ackOfflineMsg = OfflineMessageManager.createOfflineMessage(
        myPeerId,
        myUsername,
        '',
        Buffer.from(recipient.offline_public_key, 'base64').toString(),
        userIdentity.signingPrivateKey,
        writeBucketKey,
        ackTimestamp,
        undefined,
        undefined,
        true,
      );
      await OfflineMessageManager.storeOfflineAck(
        this.node, writeBucketKey, ackOfflineMsg, userIdentity.signingPrivateKey, this.database,
      );
      // TEMP_LOG: offline ACK was durably written into our write bucket for the peer.
      log(
        `[TEMP_LOG][OFFLINE][ACK][SEND][OFFLINE_OK] peer=${peerId.slice(-8)} ackTs=${ackTimestamp} bucket=*${writeBucketKey.slice(-12)}`,
      );
      this.sendBucketNudge(peerId, { kind: 'DIRECT_OFFLINE_REFETCH' }, `direct-offline:${peerId}`);
      this.notifyOfflineInboxCapacityChangedForPeer(peerId);
      return true;
    } catch (error: unknown) {
      log(`[OFFLINE-ACK] offline ack failed peer=${peerId.slice(-8)} reason=${errStr(error)}`);
      return false;
    }
  }

  // Process an ACK from a peer - clear acknowledged messages from our bucket.
  private async processOfflineAck(peerId: string, ackTimestamp: number): Promise<void> {
    try {
      if (!Number.isFinite(ackTimestamp) || ackTimestamp <= 0) {
        log(`[OFFLINE][ACK_CLEAR][SKIP] peer=${peerId.slice(-8)} reason=invalid_ack_timestamp ackTs=${ackTimestamp}`);
        return;
      }
      const maxAllowedAckTs = Date.now() + OFFLINE_ACK_MAX_FUTURE_SKEW_MS;
      if (ackTimestamp > maxAllowedAckTs) {
        log(
          `[OFFLINE][ACK_CLEAR][SKIP] peer=${peerId.slice(-8)} reason=ack_too_far_future ackTs=${ackTimestamp} maxAllowed=${maxAllowedAckTs}`,
        );
        return;
      }

      const userIdentity = this.usernameRegistry.getUserIdentity();
      if (!userIdentity) {
        log('Cannot process ACK - no user identity');
        return;
      }

      // Get the bucket key for messages we sent to this peer
      const bucketSecret = this.database.getOfflineBucketSecretByPeerId(peerId);
      if (!bucketSecret) {
        log('Cannot process ACK - no bucket secret found');
        return;
      }

      const writeBucketKey = this.keyExchange.constructWriteBucketKey(bucketSecret);
      const beforeMessages = this.database.getOfflineSentMessages(writeBucketKey).messages.length;

      // Clear acknowledged messages from our local sent store.
      // Pruned state is published on the next outbound write to this bucket.
      await OfflineMessageManager.clearAcknowledgedMessages(
        writeBucketKey,
        ackTimestamp,
        this.database
      );
      const afterMessages = this.database.getOfflineSentMessages(writeBucketKey).messages.length;
      // TEMP_LOG: show whether processing the ACK actually shrank the sender-side mirror.
      log(
        `[TEMP_LOG][OFFLINE][ACK][PROCESS] peer=${peerId.slice(-8)} ackTs=${ackTimestamp} bucket=*${writeBucketKey.slice(-12)} before=${beforeMessages} after=${afterMessages}`,
      );
      this.notifyOfflineInboxCapacityChangedForPeer(peerId);

      log(`Processed ACK from ${peerId} - cleared messages up to ${ackTimestamp}`);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to process offline ACK');
    }
  }

  /**
   * Save an offline message to the database.
   * Note: Signature verification is already done in performOfflineMessageCheck before calling this.
   *
   * TODO: Consider yielding offline messages as they're processed for real-time UI updates.
   * Current approach: UI refreshes all chats after batch completes (simple but less efficient).
   * Future optimization: Return message summaries per chat and emit batched events to avoid
   * re-fetching all chats from database.
   */
  private async saveOfflineMessageToDatabase(
    msg: OfflineMessage,
    senderInfo: OfflineSenderInfo,
    decryptedContent: string,
  ): Promise<{ chatId: number; inserted: boolean }> {
    log(`Processing offline message from ${senderInfo.username} (${senderInfo.peer_id})`);
    return this.dispatchIncomingDirectApplicationMessage({
      plaintext: decryptedContent,
      senderPeerId: senderInfo.peer_id,
      senderUsername: senderInfo.username,
      timestamp: msg.timestamp,
      messageSentStatus: 'offline',
      transportMessageId: msg.id,
    });
  }

  private async dispatchIncomingDirectApplicationMessage(input: {
    plaintext: string;
    senderPeerId: string;
    senderUsername: string;
    timestamp: number;
    messageSentStatus: MessageSentStatus;
    transportMessageId: string;
  }): Promise<{ chatId: number; inserted: boolean }> {
    const chat = this.database.getChatByPeerId(input.senderPeerId);
    if (!chat) {
      throw new Error('Chat not found');
    }

    const routeNonText = (
      message: InboundApplicationMessageContext['message'],
    ): boolean | Promise<boolean> => this.handleIncomingApplicationMessage({
      message,
      chatId: chat.id,
      senderPeerId: input.senderPeerId,
      senderUsername: input.senderUsername,
      timestamp: input.timestamp,
      transportMessageId: input.transportMessageId,
      route: input.messageSentStatus === 'online' ? 'direct_online' : 'direct_offline',
    });
    const dispatched = await dispatchEnvelope(input.plaintext, {
      text: async ({ cid, payload }) => {
        const clientMsgId = cid;
        const { inserted } = await this.database.tryCreateMessage({
          id: input.transportMessageId,
          chat_id: chat.id,
          sender_peer_id: input.senderPeerId,
          content: payload.text,
          message_type: 'text',
          timestamp: new Date(input.timestamp),
          client_msg_id: clientMsgId,
          reply_to_client_id: payload.reply_to ?? null,
        });

        if (!inserted) {
          log(`Skipped duplicate message cid=${clientMsgId.slice(0, 8)} from ${input.senderPeerId.slice(-8)}`);
          return false;
        }

        this.onMessageReceived({
          chatId: chat.id,
          messageId: input.transportMessageId,
          content: payload.text,
          senderPeerId: input.senderPeerId,
          senderUsername: input.senderUsername,
          timestamp: input.timestamp,
          messageSentStatus: input.messageSentStatus,
          clientMsgId,
          replyToClientId: payload.reply_to,
        });
        return true;
      },
      file_offer: routeNonText,
      file_offer_cancel: routeNonText,
      file_offer_nack: routeNonText,
    });

    if (dispatched.status === 'handled') {
      return { chatId: chat.id, inserted: dispatched.value };
    }
    if (dispatched.status === 'rejected') {
      log(
        `[APP-MESSAGE][DIRECT][DROP] from=${input.senderPeerId.slice(-8)} ` +
        `transportId=${input.transportMessageId} reason=${dispatched.reason}`,
      );
    } else {
      log(
        `[APP-MESSAGE][DIRECT][DROP] from=${input.senderPeerId.slice(-8)} ` +
        `transportId=${input.transportMessageId} reason=unhandled_kind kind=${dispatched.message.kind}`,
      );
    }
    return { chatId: chat.id, inserted: false };
  }

  private handleIncomingApplicationMessage(
    context: InboundApplicationMessageContext,
  ): Promise<boolean> {
    return this.fileHandler.handleApplicationMessage(context);
  }

  private async endActiveCallForShutdown(): Promise<void> {
    if (!this.activeCall) return;
    const { peerId, callId } = this.activeCall;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<{ success: boolean; error: string | null }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({ success: false, error: 'Shutdown hangup timeout' });
        }, MessageHandler.CALL_SHUTDOWN_HANGUP_MAX_WAIT_MS);
      });
      const result = await Promise.race([
        this.sendCallSignal({
          type: 'CALL_END',
          callId,
          toPeerId: peerId,
          reason: 'disconnect',
        }),
        timeoutPromise,
      ]);
      if (!result.success) {
        console.warn(
          `[CALL] Failed to send shutdown hangup peer=${peerId.slice(-8)} callId=${callId.slice(0, 8)}: ${result.error ?? 'unknown error'}`,
        );
      }
    } catch (error: unknown) {
      console.warn(
        `[CALL] Unexpected error during shutdown hangup peer=${peerId.slice(-8)} callId=${callId.slice(0, 8)}: ${errStr(error)
        }`,
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.clearActiveCall('disconnect');
    }
  }

  async cleanup(): Promise<void> {
    await this.endActiveCallForShutdown();
    await this.fileHandler.cleanup(); // drains in-flight serves before the DB is closed
    this.groupMessaging.cleanup();

    if (this.groupAckStartupTimer) {
      clearTimeout(this.groupAckStartupTimer);
      this.groupAckStartupTimer = null;
    }
    if (this.groupAckRepublishTimer) {
      clearTimeout(this.groupAckRepublishTimer);
      this.groupAckRepublishTimer = null;
    }
    if (this.groupInfoStartupTimer) {
      clearTimeout(this.groupInfoStartupTimer);
      this.groupInfoStartupTimer = null;
    }
    if (this.groupInfoRepublishTimer) {
      clearTimeout(this.groupInfoRepublishTimer);
      this.groupInfoRepublishTimer = null;
    }
    for (const timer of this.nudgeFetchTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.groupNudgeFetchTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.nudgeTrailingTimers.values()) {
      clearTimeout(timer);
    }
    this.nudgeTrailingTimers.clear();
    this.nudgeFetchTimers.clear();
    this.groupNudgeFetchTimers.clear();
    this.groupStateCatchupInFlight.clear();
    this.groupStateCatchupPending.clear();
    this.peerActivityCheckCooldowns.clear();
    this.groupInfoSyncInFlight.clear();
    this.groupInfoSyncPending.clear();
    this.offlineCheckInFlight.clear();
    this.offlineCheckPending.clear();
    this.clearCallRingWatchdog();
    this.clearActiveCallPeerDisconnectTimer();
    this.activeCall = null;
    this.activeCallLastControlSignalTs = null;
    this.seenCallSignals.clear();

    if (this.cleanupPeerEvents) {
      this.cleanupPeerEvents();
    }
    this.sessionManager.clearAll();
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getUserIdentity() {
    return this.usernameRegistry.getUserIdentity();
  }

  getKeyExchange(): KeyExchange {
    return this.keyExchange;
  }

  getFileHandler(): FileHandler {
    return this.fileHandler;
  }

  /**
   * Attempts to parse decrypted content as a group control message
   * Returns 'handled' if processed OK, 'retry' if it was a group message but failed (no timestamp advance),
   * or 'not_group' if this is a regular text message.
   */
  private async tryRouteGroupControlMessage(
    decryptedContent: string,
    senderInfo: OfflineSenderInfo,
    deferredGroupInfoSyncGroups: Set<string>,
  ): Promise<'handled' | 'retry' | 'not_group'> {
    let parsed: { type?: string };
    try {
      parsed = JSON.parse(decryptedContent);
    } catch {
      return 'not_group';
    }

    if (!parsed || typeof parsed.type !== 'string') return 'not_group';

    const type = parsed.type;

    // Check if this is a known group message type
    const groupTypes = Object.values(GroupMessageType) as string[];
    if (!groupTypes.includes(type)) return 'not_group';
    const groupMeta = this.describeParsedGroupMessage(parsed as Record<string, unknown>);
    log(
      `[GROUP][TRACE][ROUTE][IN] from=${senderInfo.username} ${groupMeta}`,
    );

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      log(`[GROUP] Cannot route group message — no user identity, will retry`);
      return 'retry';
    }

    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = myUser?.username || `user_${myPeerId.slice(-8)}`;

    try {
      const responder = new GroupResponder(this.createGroupResponderDeps(userIdentity, myPeerId, myUsername));
      const creator = new GroupCreator(this.createGroupCreatorDeps(userIdentity, myPeerId, myUsername));
      const groupId = (parsed as { groupId: string }).groupId;

      switch (type) {
        // --- Messages handled by GroupResponder (we are the invitee) ---
        case GroupMessageType.GROUP_INVITE: {
          await responder.handleGroupInvite(parsed as any);
          log(`[GROUP] Processed GROUP_INVITE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_INVITE_RESPONSE_ACK: {
          responder.handleInviteResponseAck(parsed as any);
          log(`[GROUP] Processed GROUP_INVITE_RESPONSE_ACK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_WELCOME: {
          await responder.handleGroupWelcome(parsed as any);
          deferredGroupInfoSyncGroups.add(groupId);
          this.groupMessaging.subscribeToGroupTopic(groupId)
          log(`[GROUP] Processed GROUP_WELCOME from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_STATE_UPDATE: {
          const beforeUpdateChat = this.database.getChatByGroupId(groupId);
          const previousKeyVersion = beforeUpdateChat?.key_version ?? 0;
          const previousGroupStatus = beforeUpdateChat?.group_status ?? null;
          await responder.handleGroupStateUpdate(parsed as any);

          const updatedChat = this.database.getChatByGroupId(groupId);
          const keyVersionAdvanced = (updatedChat?.key_version ?? 0) > previousKeyVersion;
          const becameRemoved = updatedChat?.group_status === 'removed';
          if (updatedChat && (keyVersionAdvanced || becameRemoved || previousGroupStatus === 'rekeying')) {
            const trigger = keyVersionAdvanced
              ? 'key_version_advanced'
              : becameRemoved
                ? 'became_removed'
                : 'was_rekeying';
            this.scheduleGroupStateUpdateCatchup(updatedChat.id, groupId, trigger);
          }
          if (['removed', 'left', 'disbanded'].includes(updatedChat?.group_status || '')) {
            this.groupMessaging.deactivateGroup(groupId);
          } else {
            this.groupMessaging.subscribeToGroupTopic(groupId)
            deferredGroupInfoSyncGroups.add(groupId);
          }
          log(`[GROUP] Processed GROUP_STATE_UPDATE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_KICK: {
          const removedSelf = await responder.handleGroupKick(parsed as any);
          if (removedSelf) {
            this.groupMessaging.deactivateGroup(groupId);
          }
          log(`[GROUP] Processed GROUP_KICK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_DISBAND: {
          const disbandApplied = await responder.handleGroupDisband(parsed as any);
          if (disbandApplied) {
            this.groupMessaging.deactivateGroup(groupId);
          }
          log(`[GROUP] Processed GROUP_DISBAND from ${senderInfo.username}`);
          break;
        }

        // --- Messages handled by GroupCreator (we are the creator) ---
        case GroupMessageType.GROUP_INVITE_RESPONSE: {
          await creator.processInviteResponse(parsed as any);
          const chat = this.database.getChatByGroupId(groupId);
          if (chat?.group_status === 'active' && (chat.key_version ?? 0) > 0) {
            this.groupMessaging.subscribeToGroupTopic(groupId)
          }
          log(`[GROUP] Processed GROUP_INVITE_RESPONSE from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_LEAVE_REQUEST: {
          await creator.processLeaveRequest(parsed as any, senderInfo.peer_id);
          const chat = this.database.getChatByGroupId(groupId);
          if (chat?.group_status === 'active' && (chat.key_version ?? 0) > 0) {
            this.groupMessaging.subscribeToGroupTopic(groupId)
          }
          log(`[GROUP] Processed GROUP_LEAVE_REQUEST from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_STATE_RESYNC_REQUEST: {
          await creator.processStateResyncRequest(parsed as any, senderInfo.peer_id);
          log(`[GROUP] Processed GROUP_STATE_RESYNC_REQUEST from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_INVITE_DELIVERED_ACK: {
          await creator.handleInviteDeliveredAck(parsed as any, senderInfo.peer_id);
          log(`[GROUP] Processed GROUP_INVITE_DELIVERED_ACK from ${senderInfo.username}`);
          break;
        }
        case GroupMessageType.GROUP_CONTROL_ACK: {
          await creator.handleControlAck(parsed as any, senderInfo.peer_id);
          log(`[GROUP] Processed GROUP_CONTROL_ACK from ${senderInfo.username}`);
          break;
        }

        case GroupMessageType.GROUP_MESSAGE:
          log(`[GROUP] Received ${type} from ${senderInfo.username}`);
          break;

        default:
          log(`[GROUP] Unknown group message type: ${type}`);
          return 'retry';
      }
      this.clearGroupControlRetryState(senderInfo.peer_id, parsed as Record<string, unknown>);
    } catch (error: unknown) {
      const errorText = errStr(error);
      if (this.isPermanentGroupControlError(errorText)) {
        this.clearGroupControlRetryState(senderInfo.peer_id, parsed as Record<string, unknown>);
        console.warn(
          `[GROUP][TRACE][ROUTE][DROP_PERMANENT] from=${senderInfo.peer_id.slice(-8)} ${groupMeta} reason=${errorText}`,
        );
        return 'handled';
      }

      const attempts = this.bumpGroupControlRetryAttempt(senderInfo.peer_id, parsed as Record<string, unknown>, errorText);
      if (attempts >= MessageHandler.GROUP_CONTROL_MAX_RETRIES) {
        this.clearGroupControlRetryState(senderInfo.peer_id, parsed as Record<string, unknown>);
        console.warn(
          `[GROUP][TRACE][ROUTE][DROP_MAX_RETRIES] from=${senderInfo.peer_id.slice(-8)} ${groupMeta} attempts=${attempts} reason=${errorText}`,
        );
        return 'handled';
      }

      generalErrorHandler(error, `[GROUP] Error handling ${type} from ${senderInfo.username}; retry ${attempts}/${MessageHandler.GROUP_CONTROL_MAX_RETRIES}`);
      return 'retry'; // Transient failure — retry a bounded number of times
    }
    log(
      `[GROUP][TRACE][ROUTE][DONE] from=${senderInfo.peer_id.slice(-8)} ${groupMeta} result=handled`,
    );

    return 'handled';
  }

  private describeParsedGroupMessage(parsed: Record<string, unknown>): string {
    const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
    const groupId = typeof parsed.groupId === 'string' ? parsed.groupId : 'n/a';
    const inviteId = typeof parsed.inviteId === 'string' ? parsed.inviteId : 'n/a';
    const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : 'n/a';
    const ackedMessageId = typeof parsed.ackedMessageId === 'string' ? parsed.ackedMessageId : 'n/a';
    const ackId = typeof parsed.ackId === 'string' ? parsed.ackId : 'n/a';
    return `type=${type} group=${groupId} inviteId=${inviteId} msgId=${messageId} ackedMsgId=${ackedMessageId} ackId=${ackId}`;
  }

  private buildGroupControlRetryKey(senderPeerId: string, parsed: Record<string, unknown>): string {
    const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
    const groupId = typeof parsed.groupId === 'string' ? parsed.groupId : 'n/a';
    const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : '';
    const inviteId = typeof parsed.inviteId === 'string' ? parsed.inviteId : '';
    const ackId = typeof parsed.ackId === 'string' ? parsed.ackId : '';
    const ackedMessageId = typeof parsed.ackedMessageId === 'string' ? parsed.ackedMessageId : '';
    const fallbackId = typeof parsed.timestamp === 'number' ? String(parsed.timestamp) : 'n/a';
    const id = messageId || ackId || inviteId || ackedMessageId || fallbackId;
    return `${senderPeerId}|${type}|${groupId}|${id}`;
  }

  private bumpGroupControlRetryAttempt(senderPeerId: string, parsed: Record<string, unknown>, errorText: string): number {
    this.pruneGroupControlRetryState();
    const key = this.buildGroupControlRetryKey(senderPeerId, parsed);
    const prev = this.groupControlRetryState.get(key);
    const attempts = (prev?.attempts ?? 0) + 1;
    this.groupControlRetryState.set(key, {
      attempts,
      lastSeenAt: Date.now(),
      lastError: errorText,
    });
    return attempts;
  }

  private clearGroupControlRetryState(senderPeerId: string, parsed: Record<string, unknown>): void {
    const key = this.buildGroupControlRetryKey(senderPeerId, parsed);
    this.groupControlRetryState.delete(key);
  }

  private pruneGroupControlRetryState(): void {
    if (this.groupControlRetryState.size === 0) return;
    const now = Date.now();
    for (const [key, value] of this.groupControlRetryState.entries()) {
      if (now - value.lastSeenAt > MessageHandler.GROUP_CONTROL_RETRY_TTL_MS) {
        this.groupControlRetryState.delete(key);
      }
    }
    if (this.groupControlRetryState.size <= MessageHandler.GROUP_CONTROL_RETRY_CACHE_MAX_ENTRIES) {
      return;
    }
    // Defensive cap in case of abuse.
    const entries = Array.from(this.groupControlRetryState.entries())
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    const overflow = this.groupControlRetryState.size - MessageHandler.GROUP_CONTROL_RETRY_CACHE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i++) {
      const entry = entries[i];
      if (!entry) break;
      this.groupControlRetryState.delete(entry[0]);
    }
  }

  private isPermanentGroupControlError(errorText: string): boolean {
    const normalized = errorText.toLowerCase();
    return (
      normalized.includes('signature verification failed')
      || normalized.includes('missing signature')
      || normalized.includes('invalid signature')
      || normalized.includes('invalid timestamp')
      || normalized.includes('timestamp invalid')
      || normalized.includes('timestamp too far in future')
      || normalized.includes('cannot read properties of undefined')
      || normalized.includes('cannot destructure property')
    );
  }
} 
