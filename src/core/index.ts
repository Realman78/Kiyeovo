import * as path from 'path';
import dotenv from 'dotenv';
import {
  createChatNode,
  connectToBootstrap,
  dialConfiguredFastRelays,
  getBootstrapPeerIdsForCurrentMode,
  getBootstrapRetryTimeoutMs,
} from './network/node-setup.js';
import { UsernameRegistry } from './username/username-registry.js';
import { MessageHandler } from './lib/message-handler.js';
import { GroupCallOrchestrator } from './lib/group-call-orchestrator.js';
import { CallActivityRegistry } from './lib/call-activity-registry.js';
import { EncryptedUserIdentity } from './identity/encrypted-user-identity.js';
import { ChatDatabase } from './db/database.js';
import { createNetworkHealthMonitor } from './network/network-health.js';
import { createReconnectController } from './network/reconnect-controller.js';
import { startFastRelayKeepAlive } from './network/relay-keepalive.js';
import { DATABASE_CLEANUP_INTERVAL, getNetworkModeConfig, MAX_BOOTSTRAP_NODES_FAST, MAX_BOOTSTRAP_NODES_TOR, POST_RECONNECT_RECENT_ACTIVITY_WINDOW_MS, POST_RECONNECT_RECENT_GROUP_CAP, SECOND } from './constants.js';
import type {
  ChatNode,
  ContactRequestEvent,
  ContactRequestCancelledEvent,
  KeyExchangeEvent,
  PasswordResponse,
  ChatCreatedEvent,
  KeyExchangeFailedEvent,
  MessageReceivedEvent,
  MessageSendStateChangedEvent,
  OfflineInboxCapacityChangedEvent,
  FileTransferProgressEvent,
  FileTransferCompleteEvent,
  FileTransferFailedEvent,
  OutgoingFileOfferPendingEvent,
  OutgoingFileOfferTerminalEvent,
  PendingFileReceivedEvent,
  PendingFileOfferDeferredEvent,
  GroupChatActivatedEvent,
  GroupMembersUpdatedEvent,
  NetworkMode,
  CallIncomingEvent,
  CallSignalReceivedEvent,
  CallStateChangedEvent,
  CallErrorEvent,
  BootstrapConnectResult,
  GroupCallControlSignalReceivedEvent,
  GroupCallPairSignalReceivedEvent,
  GroupCallStateChangedEvent,
  GroupCallErrorEvent,
} from './types.js';
import type { DhtStatusCheckSource } from './network/network-health.js';

dotenv.config();

export interface P2PCore {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  usernameRegistry: UsernameRegistry;
  messageHandler: MessageHandler;
  groupCallOrchestrator: GroupCallOrchestrator;
  networkMode: NetworkMode;
  getCurrentDhtStatus: () => boolean | null;
  // Force a close-all + redial reconnect. Used on OS wake from sleep
  requestImmediateReconnect: () => Promise<boolean>;
  retryBootstrap: () => Promise<BootstrapConnectResult>;
  retryRelays: () => Promise<{ attempted: number; connected: number }>;
  cleanup: () => Promise<void>;
}

export interface TorConfig {
  enabled: boolean;
  socksPort: number;
  onionAddress: string | null; // null means Tor is disabled or not yet started
}

export interface P2PCoreConfig {
  dataDir: string;
  port: number;
  torConfig?: TorConfig;
  passwordPrompt: (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => Promise<PasswordResponse>;
  onStatus: (message: string, stage: 'tor' | 'database' | 'identity' | 'node' | 'registry' | 'messaging' | 'complete' | 'peerId') => void;
  onDHTConnectionStatus: (status: { connected: boolean | null }) => void;
  onKeyExchangeSent: (data: KeyExchangeEvent) => void;
  onContactRequestReceived: (data: ContactRequestEvent) => void;
  onContactRequestCancelled: (data: ContactRequestCancelledEvent) => void;
  onChatCreated: (data: ChatCreatedEvent) => void;
  onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void;
  onMessageReceived: (data: MessageReceivedEvent) => void;
  onMessageSendStateChanged: (data: MessageSendStateChangedEvent) => void;
  onOfflineInboxCapacityChanged: (data: OfflineInboxCapacityChangedEvent) => void;
  onBootstrapNodes: (nodes: string[]) => void;
  onRestoreUsername: (username: string) => void;
  onFileTransferProgress: (data: FileTransferProgressEvent) => void;
  onFileTransferComplete: (data: FileTransferCompleteEvent) => void;
  onFileTransferFailed: (data: FileTransferFailedEvent) => void;
  onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void;
  onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => void;
  onPendingFileReceived: (data: PendingFileReceivedEvent) => void;
  onPendingFileOfferDeferred: (data: PendingFileOfferDeferredEvent) => void;
  onGroupChatActivated: (data: GroupChatActivatedEvent) => void;
  onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => void;
  onOfflineMessagesFetchComplete: (chatIds: number[]) => void;
  onCallIncoming: (data: CallIncomingEvent) => void;
  onCallSignalReceived: (data: CallSignalReceivedEvent) => void;
  onCallStateChanged: (data: CallStateChangedEvent) => void;
  onCallError: (data: CallErrorEvent) => void;
  onGroupCallControlSignalReceived: (data: GroupCallControlSignalReceivedEvent) => void;
  onGroupCallPairSignalReceived: (data: GroupCallPairSignalReceivedEvent) => void;
  onGroupCallStateChanged: (data: GroupCallStateChangedEvent) => void;
  onGroupCallError: (data: GroupCallErrorEvent) => void;
}

/**
 * Initialize the P2P core (libp2p node, database, identity, messaging)
 * This is the main entry point for the Kiyeovo P2P functionality
 */
export async function initializeP2PCore(config: P2PCoreConfig): Promise<P2PCore> {
  const {
    onStatus,
    onDHTConnectionStatus,
    onKeyExchangeSent,
    onContactRequestReceived,
    onContactRequestCancelled,
    onChatCreated,
    onKeyExchangeFailed,
    onMessageReceived,
    onMessageSendStateChanged,
    onOfflineInboxCapacityChanged,
    onRestoreUsername,
    onFileTransferProgress,
    onFileTransferComplete,
    onFileTransferFailed,
    onOutgoingFileOfferPending,
    onOutgoingFileOfferTerminal,
    onPendingFileReceived,
    onPendingFileOfferDeferred,
    onGroupChatActivated,
    onGroupMembersUpdated,
    onOfflineMessagesFetchComplete,
    onCallIncoming,
    onCallSignalReceived,
    onCallStateChanged,
    onCallError,
    onGroupCallControlSignalReceived,
    onGroupCallPairSignalReceived,
    onGroupCallStateChanged,
    onGroupCallError,
  } = config;

  const sendStatus = (message: string, stage: any) => {
    console.log(`[Core] ${message}`);
    onStatus(message, stage);
  };

  const sendDHTConnectionStatus = (status: { connected: boolean | null }) => {
    onDHTConnectionStatus(status);
  };

  const sendKeyExchangeSent = (data: KeyExchangeEvent) => {
    onKeyExchangeSent(data);
  };

  const sendChatCreated = (data: ChatCreatedEvent) => {
    onChatCreated(data);
  };

  const sendContactRequestCancelled = (data: ContactRequestCancelledEvent) => {
    onContactRequestCancelled(data);
  };

  const sendKeyExchangeFailed = (data: KeyExchangeFailedEvent) => {
    onKeyExchangeFailed(data);
  };

  const sendMessageReceived = (data: MessageReceivedEvent) => {
    onMessageReceived(data);
  };

  const sendMessageSendStateChanged = (data: MessageSendStateChangedEvent) => {
    onMessageSendStateChanged(data);
  };

  const sendOfflineInboxCapacityChanged = (data: OfflineInboxCapacityChangedEvent) => {
    onOfflineInboxCapacityChanged(data);
  };

  const sendRestoreUsername = (username: string) => {
    onRestoreUsername(username);
  };

  sendStatus(`Starting Kiyeovo P2P node on port ${config.port}...`, 'database');

  // Initialize database
  const dbPath = path.join(config.dataDir, 'chat.db');
  const database = new ChatDatabase(dbPath);
  sendStatus(`Database initialized at: ${dbPath}`, 'database');

  const networkMode = database.getSessionNetworkMode();
  sendStatus(`Loaded network mode: ${networkMode}`, 'database');

  // Store Tor configuration in database for node-setup to read
  if (config.torConfig) {
    database.setSetting('tor_socks_port', config.torConfig.socksPort.toString());
    if (config.torConfig.onionAddress) {
      // Store onion host; node-setup constructs full announce multiaddr later.
      database.setSetting('tor_onion_address', config.torConfig.onionAddress);
    }
  }

  // Load or create encrypted user identity
  sendStatus('Loading user identity...', 'identity');
  const userIdentity = await EncryptedUserIdentity.loadOrCreateEncryptedForMode(
    database,
    networkMode,
    config.passwordPrompt,
    sendStatus
  );
  sendStatus('User identity loaded', 'identity');

  // Create libp2p node
  sendStatus('Creating libp2p node...', 'node');
  const node = await createChatNode(config.port, userIdentity, database);
  sendStatus(`Peer started. Peer ID: ${node.peerId.toString()}`, 'node');
  sendStatus(node.peerId.toString(), 'peerId');

  node.getMultiaddrs().forEach(addr => {
    console.log(`[Core] Listening on: ${addr.toString()}`);
  });

  // Connect to bootstrap nodes
  sendStatus('Connecting to bootstrap nodes...', 'node');
  const startupBootstrapResult = await connectToBootstrap(node, database);
  console.log(`[Core] Startup bootstrap status=${startupBootstrapResult.status} connected=${startupBootstrapResult.connectedCount}/${startupBootstrapResult.targetConnectionCount} attempts=${startupBootstrapResult.attempts.length}`,);

  // Start periodic DHT connection status checker
  let dhtStatusCheckInFlight: Promise<void> | null = null;
  let dhtStatusActiveCheckId: number | null = null;
  let dhtStatusActiveStartedAt = 0;
  let dhtStatusCheckSeq = 0;
  let currentDhtConnected: boolean | null = null;
  let currentDhtReason: string | null = null;
  const DHT_PING_PROBE_TIMEOUT_MS = 6_000;
  const DHT_PING_PROBE_HARD_TIMEOUT_MS = 7_000;
  const activeDhtProtocol = getNetworkModeConfig(networkMode).dhtProtocol;
  const emitDhtStatus = (connected: boolean | null, reason: string) => {
    const peerCount = node.getConnections().length;
    if (currentDhtConnected !== connected || currentDhtReason !== reason) {
      console.log(
        `[DHT-STATUS][CORE][EMIT] connected=${String(connected)} reason=${reason} peerCount=${peerCount}`,
      );
    }
    currentDhtConnected = connected;
    currentDhtReason = reason;
    sendDHTConnectionStatus({ connected });

    // Fire post-reconnect hooks on the next "we're healthy" emit after a
    // destructive reconnect was marked
    if (connected === true && reconnectController.consumeCatchupNeeded()) {
      reconnectController.fireReconnectSucceededHandlers();
    }
  };

  const getConnectedBootstrapConnections = (
    connectionsToCheck: ReturnType<typeof node.getConnections>,
  ): ReturnType<typeof node.getConnections> => {
    const bootstrapPeerIds = getBootstrapPeerIdsForCurrentMode(database, node.peerId.toString());
    return connectionsToCheck.filter((conn) => bootstrapPeerIds.has(conn.remotePeer.toString()));
  };

  const networkHealth = createNetworkHealthMonitor({
    activeDhtProtocol,
    getConnectedBootstrapConnections,
    node,
    pingProbeHardTimeoutMs: DHT_PING_PROBE_HARD_TIMEOUT_MS,
    pingProbeTimeoutMs: DHT_PING_PROBE_TIMEOUT_MS,
  });

  const reconnectController = createReconnectController();

  // Drop stale connections, re-dial bootstrap, and verify DHT liveness. Shared
  // by the periodic health gate and on-demand (send-triggered) reconnects
  const performReconnect = async (): Promise<boolean> => {
    let succeeded = false;
    try {
      reconnectController.markCatchupNeeded();
      console.log('[Core] All sampled connections appear stale; closing and reconnecting...');
      const staleConnections = node.getConnections();
      if (staleConnections.length > 0) {
        await Promise.allSettled(staleConnections.map(conn => conn.close()));
      }

      const reconnectBootstrapResult = await connectToBootstrap(node, database);
      console.log(
        `[Core] Reconnect bootstrap status=${reconnectBootstrapResult.status} connected=${reconnectBootstrapResult.connectedCount}/${reconnectBootstrapResult.targetConnectionCount} attempts=${reconnectBootstrapResult.attempts.length}`,
      );

      // Verify immediately after reconnect attempt so UI state is up to date
      const dhtAfterReconnect = await networkHealth.getDhtCapableConnections();
      const aliveAfterReconnect = await networkHealth.probeAnyAliveConnection(dhtAfterReconnect, {
        probeSource: 'dht',
      });
      const liveCount = aliveAfterReconnect ? dhtAfterReconnect.length : 0;
      emitDhtStatus(liveCount > 0, 'post_reconnect_dht_probe');
      succeeded = liveCount > 0;
      if (succeeded) {
        reconnectController.resetProbeFailures();
      }
      return succeeded;
    } finally {
      // A reconnect that established no connectivity (zero peers, or it threw)
      // must not hold the full anti-thrash cooldown
      if (!succeeded) {
        reconnectController.noteFailedReconnect();
      }
      reconnectController.finishReconnect();
    }
  };

  // On-demand reconnect: callers (e.g. a group offline write that reached zero
  // peers) have direct evidence the connections are dead, so reconnect now
  // instead of waiting for the periodic probe to trip the failure threshold
  const requestImmediateReconnect = async (): Promise<boolean> => {
    if (reconnectController.tryBeginImmediateReconnect()) {
      return performReconnect();
    }
    // Cooldown active or a reconnect already running: don't stack another
    await dhtStatusCheckInFlight?.catch(() => { });
    const dhtConns = await networkHealth.getDhtCapableConnections();
    return networkHealth.probeAnyAliveConnection(dhtConns, { probeSource: 'dht' });
  };

  const checkDHTStatus = async (source: DhtStatusCheckSource = 'timer_30s') => {
    if (dhtStatusCheckInFlight) {
      const ageMs = dhtStatusActiveStartedAt > 0 ? Date.now() - dhtStatusActiveStartedAt : -1;
      const staleInFlight = dhtStatusActiveCheckId === null || ageMs < 0 || ageMs > 90_000;
      if (staleInFlight) {
        console.warn(
          `[DHT-STATUS][CORE][CHECK][RESET] reason=stale_in_flight source=${source} activeId=${String(dhtStatusActiveCheckId)} ageMs=${ageMs}`,
        );
        dhtStatusCheckInFlight = null;
        dhtStatusActiveCheckId = null;
        dhtStatusActiveStartedAt = 0;
      } else {
        return dhtStatusCheckInFlight;
      }
    }

    const checkId = ++dhtStatusCheckSeq;
    dhtStatusActiveCheckId = checkId;
    dhtStatusActiveStartedAt = Date.now();

    dhtStatusCheckInFlight = (async () => {
      try {
        const suppressNegativeStatusDuringBootstrapRetry = reconnectController.shouldSuppressNegativeStatusDuringBootstrapRetry(source);
        const allConnections = node.getConnections();

        const healthEvaluation = await networkHealth.evaluateStatus(allConnections, source, {
          suppressNegativeStatusDuringBootstrapRetry,
        });

        emitDhtStatus(healthEvaluation.status, healthEvaluation.reason);

        if (healthEvaluation.status === true) {
          return;
        }

        if (!reconnectController.recordHealthStatus(healthEvaluation.status)) {
          return;
        }

        if (!reconnectController.tryBeginReconnect()) {
          return;
        }

        await performReconnect();
        return;
      } catch (error) {
        console.error('[Core] Failed to check peer count:', error);
        emitDhtStatus(false, 'check_exception');
      } finally {
        dhtStatusCheckInFlight = null;
        dhtStatusActiveCheckId = null;
        dhtStatusActiveStartedAt = 0;
      }
    })();

    return dhtStatusCheckInFlight;
  };

  // Send initial status immediately
  await checkDHTStatus('startup');

  setTimeout(() => {
    void checkDHTStatus('timer_5s');
  }, 5 * SECOND);

  // Then check periodically
  const dhtStatusInterval = setInterval(() => {
    void checkDHTStatus('timer_30s');
  }, 30 * SECOND);
  const relayKeepAlive = startFastRelayKeepAlive(node, database);

  // Initialize username registry
  sendStatus('Initializing username registry...', 'registry');
  const usernameRegistry = new UsernameRegistry(node, database);
  await usernameRegistry.initialize(userIdentity, sendRestoreUsername);

  // Initialize message handler
  sendStatus('Initializing message handler...', 'messaging');

  const sendContactRequestReceived = (data: ContactRequestEvent) => {
    onContactRequestReceived(data);
  };

  const sendFileTransferProgress = (data: FileTransferProgressEvent) => {
    onFileTransferProgress(data);
  };

  const sendFileTransferComplete = (data: FileTransferCompleteEvent) => {
    onFileTransferComplete(data);
  };

  const sendFileTransferFailed = (data: FileTransferFailedEvent) => {
    onFileTransferFailed(data);
  };

  const sendOutgoingFileOfferPending = (data: OutgoingFileOfferPendingEvent) => {
    onOutgoingFileOfferPending(data);
  };

  const sendOutgoingFileOfferTerminal = (data: OutgoingFileOfferTerminalEvent) => {
    onOutgoingFileOfferTerminal(data);
  };

  const sendPendingFileReceived = (data: PendingFileReceivedEvent) => {
    onPendingFileReceived(data);
  };

  const sendPendingFileOfferDeferred = (data: PendingFileOfferDeferredEvent) => {
    onPendingFileOfferDeferred(data);
  };

  let groupCallOrchestrator: GroupCallOrchestrator | null = null;

  const sendGroupChatActivated = (data: GroupChatActivatedEvent) => {
    void groupCallOrchestrator?.handleGroupChatActivated(data.chatId);
    onGroupChatActivated(data);
  };

  const sendGroupMembersUpdated = (data: GroupMembersUpdatedEvent) => {
    groupCallOrchestrator?.handleGroupMembersUpdated(data);
    onGroupMembersUpdated(data);
  };

  const sendOfflineMessagesFetchComplete = (chatIds: number[]) => {
    onOfflineMessagesFetchComplete(chatIds);
  };

  const sendCallIncoming = (data: CallIncomingEvent) => {
    onCallIncoming(data);
  };

  const sendCallSignalReceived = (data: CallSignalReceivedEvent) => {
    onCallSignalReceived(data);
  };

  const sendCallStateChanged = (data: CallStateChangedEvent) => {
    onCallStateChanged(data);
  };

  const sendCallError = (data: CallErrorEvent) => {
    onCallError(data);
  };

  const sendGroupCallControlSignalReceived = (data: GroupCallControlSignalReceivedEvent) => {
    onGroupCallControlSignalReceived(data);
  };

  const sendGroupCallPairSignalReceived = (data: GroupCallPairSignalReceivedEvent) => {
    console.log(
      `[GROUP-CALL][PAIR][FORWARD] type=${data.signal.type} from=${data.signal.fromPeerId.slice(-8)} to=${data.signal.toPeerId.slice(-8)} call=${data.signal.callId.slice(0, 8)} receivedAt=${data.receivedAt}`,
    );
    onGroupCallPairSignalReceived(data);
  };

  const sendGroupCallStateChanged = (data: GroupCallStateChangedEvent) => {
    onGroupCallStateChanged(data);
  };

  const sendGroupCallError = (data: GroupCallErrorEvent) => {
    onGroupCallError(data);
  };

  const callActivityRegistry = new CallActivityRegistry();
  groupCallOrchestrator = new GroupCallOrchestrator({
    node,
    database,
    userIdentity,
    callActivityRegistry,
    requestImmediateReconnect,
    onControlSignalReceived: sendGroupCallControlSignalReceived,
    onPairSignalReceived: sendGroupCallPairSignalReceived,
    onStateChanged: sendGroupCallStateChanged,
    onError: sendGroupCallError,
  });

  const messageHandler = new MessageHandler(
    node,
    usernameRegistry,
    database,
    sendKeyExchangeSent,
    sendContactRequestReceived,
    sendContactRequestCancelled,
    sendChatCreated,
    sendKeyExchangeFailed,
    sendMessageReceived,
    sendFileTransferProgress,
    sendFileTransferComplete,
    sendFileTransferFailed,
    sendOutgoingFileOfferPending,
    sendOutgoingFileOfferTerminal,
    sendPendingFileReceived,
    sendPendingFileOfferDeferred,
    sendGroupChatActivated,
    sendGroupMembersUpdated,
    sendOfflineMessagesFetchComplete,
    sendCallIncoming,
    sendCallSignalReceived,
    sendCallStateChanged,
    sendCallError,
    callActivityRegistry,
    groupCallOrchestrator,
  );

  messageHandler.setRequestReconnect(requestImmediateReconnect);
  messageHandler.setMessageSendStateEmitter(sendMessageSendStateChanged);
  messageHandler.setOfflineInboxCapacityChangedEmitter(sendOfflineInboxCapacityChanged);

  // After a destructive reconnect succeeds, start a group offline-message check
  reconnectController.onReconnectSucceeded(() => {
    const since = Date.now() - POST_RECONNECT_RECENT_ACTIVITY_WINDOW_MS;
    const callChatId = groupCallOrchestrator.getActiveCallChatId();
    void messageHandler.checkRecentlyActiveGroupOfflineMessages(
      since,
      POST_RECONNECT_RECENT_GROUP_CAP,
      callChatId !== null ? [callChatId] : undefined,
    );
  });

  groupCallOrchestrator.setDurableHintStorage((groupId: string) => messageHandler.storeGroupCallHint(groupId));
  messageHandler.setGroupCallHintHandler((groupId: string) => {
    void groupCallOrchestrator.handleDurableHint(groupId);
  });

  // Start periodic database cleanup
  const cleanupInterval = setInterval(() => {
    database.runCleanupTasks();
  }, DATABASE_CLEANUP_INTERVAL);

  // Run cleanup once on startup
  database.runCleanupTasks();

  sendStatus('P2P Core initialized successfully', 'complete');

  // Return core instance with cleanup function
  return {
    node,
    database,
    userIdentity,
    usernameRegistry,
    messageHandler,
    groupCallOrchestrator,
    networkMode,
    getCurrentDhtStatus: () => {
      return currentDhtConnected;
    },
    requestImmediateReconnect,
    retryBootstrap: async () => {
      if (reconnectController.isReconnectInProgress()) {
        console.log('[Core] Reconnect already in progress, ignoring manual retry');
        return {
          status: 'retry_in_progress',
          connectedAddresses: [],
          connectedPeerIds: [],
          connectedCount: 0,
          targetConnectionCount: database.getSessionNetworkMode() === 'anonymous' ? MAX_BOOTSTRAP_NODES_TOR : MAX_BOOTSTRAP_NODES_FAST,
          targetReached: false,
          attempts: [],
        } satisfies BootstrapConnectResult;
      }
      const currentNetworkMode = database.getSessionNetworkMode();
      const retryBootstrapTimeoutMs = getBootstrapRetryTimeoutMs(currentNetworkMode);
      console.log('[Core] Retrying bootstrap connection...');
      reconnectController.beginBootstrapRetry();
      emitDhtStatus(null, 'bootstrap_retry_in_progress');

      const retryAbortController = new AbortController();
      const timeoutId = setTimeout(() => retryAbortController.abort(), retryBootstrapTimeoutMs);
      let bootstrapRetryResult: BootstrapConnectResult;
      try {
        bootstrapRetryResult = await connectToBootstrap(node, database, { signal: retryAbortController.signal });
      } catch (error) {
        throw error;
      } finally {
        reconnectController.endBootstrapRetry();
        clearTimeout(timeoutId);
      }

      if (bootstrapRetryResult.connectedCount > 0) {
        emitDhtStatus(null, 'bootstrap_retry_warmup');
        // Give fresh bootstrap connections time to complete identify/DHT warm-up before probing them.
        reconnectController.schedulePostRetryVerify(currentNetworkMode, () => {
          void checkDHTStatus('post_retry_verify');
        });
      } else {
        emitDhtStatus(false, 'bootstrap_retry_failed');
      }

      return bootstrapRetryResult;
    },
    retryRelays: async () => {
      const result = await dialConfiguredFastRelays(node, database);
      return { attempted: result.attempted, connected: result.connected };
    },
    cleanup: async () => {
      console.log('[Core] Shutting down...');
      try {
        await relayKeepAlive.stop();
        groupCallOrchestrator.cleanup();
        await messageHandler.cleanup();
        reconnectController.clearPostRetryVerifyTimeout();
        clearInterval(cleanupInterval);
        clearInterval(dhtStatusInterval);
        database.close();
        await node.stop();
        console.log('[Core] Shutdown complete');
      } catch (error) {
        console.error('[Core] Error during shutdown:', error);
        throw error;
      }
    }
  };
}

export * from './types.js';
export * from './constants.js';
