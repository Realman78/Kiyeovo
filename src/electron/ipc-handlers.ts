import type { BrowserWindow, SaveDialogOptions } from 'electron';
import { app, clipboard, dialog, nativeImage, Notification, shell } from 'electron';
import {
  IPC_CHANNELS,
  type P2PCore,
  type ChatNode,
  type AppConfig,
  type NetworkMode,
  type CallSignalOutgoingInput,
  type GroupCallPairSignalOutgoingInput,
  type BootstrapRetryResponse,
  type ConnectionNodeStatus,
  type ConnectionNodesResponse,
  type NodesLivenessResponse,
  type RelayRetryResponse,
  type IceServerConfig,
  type IceServerType,
  type IceServersResponse,
} from '../core/index.js';
import { CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES, DEFAULT_NETWORK_MODE, FAST_MISSING_ICE_WARNING_ACKNOWLEDGED_SETTING_KEY, FAST_RELAY_MULTIADDRS_SETTING_KEY, FILE_OFFER_RATE_LIMIT, KEY_EXCHANGE_RATE_LIMIT_DEFAULT, MAX_FILE_SIZE, MAX_PENDING_FILES_PER_PEER, MAX_PENDING_FILES_TOTAL, NETWORK_MODE_ONBOARDED_SETTING_KEY, OFFLINE_MESSAGE_LIMIT, SILENT_REJECTION_THRESHOLD_GLOBAL, SILENT_REJECTION_THRESHOLD_PER_PEER, NETWORK_MODES, WEBRTC_ICE_SERVERS_SETTING_KEY, getInitialSetupStatusSettingKey, getTorConfig, isNetworkMode } from '../core/constants.js';
import { validateMessageLength, validateUsername } from '../core/utils/validators.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { OfflineMessageManager } from '../core/direct/offline-message-manager.js';
import { ProfileManager } from '../core/identity/profile-manager.js';
import { GroupCreator } from '../core/group/control/group-creator.js';
import { GroupResponder } from '../core/group/control/group-responder.js';
import {
  getConfiguredFastRelayAddrs,
  getFastRelayStatusSnapshot,
  normalizeFastRelayAddressList,
  serializeFastRelayAddressList,
} from '../core/network/node-relays.js';
import { DEFAULT_WEBRTC_ICE_SERVERS } from '../core/network/default-infrastructure.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { basename, join } from 'path';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'fs/promises';
import { log } from '../shared/logger.js';
import { isImageFile } from '../shared/file-types.js';
import { errStr } from '../core/utils/general-error.js';
import { ChatDatabase } from '../core/db/database.js';
import type { PendingFileInboxSnapshot } from '../core/types.js';
import { isNetworkConnected } from './network-connectivity.js';
import { scheduleAppRelaunch } from './relaunch.js';
import { createTrustedIpcMainHandle, type IpcMainHandleRegistrar } from './trusted-ipc.js';
import { mintMediaToken } from './app-protocol.js';
import { prepareTextUpload } from './text-upload.js';
import {
  createDebouncedInvoker,
  resolveCompletedImageMedia,
  resolveOpenFileLocationPath,
  resolveUploadsDirectory,
  validateUploadImageFileName,
} from './ipc-handler-helpers.js';
import {
  grantDialogPath,
  resolveDialogGrantedFileMetadata,
  resolveGrantedDialogPath,
} from './dialog-path-grants.js';
import { getDefaultDownloadsDirectory, writeFileWithCopySuffix } from '../core/lib/file-storage.js';
import type { InitialSetupStatus, SaveTextUploadResponse } from '../shared/kiyeovo-api.js';

function requestAppRestart(): void {
  scheduleAppRelaunch();
  (app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested = true;
  app.quit();
}

function withSettingsDatabase<T>(getP2PCore: () => P2PCore | null, run: (db: ChatDatabase) => T): T {
  const p2pCore = getP2PCore();
  if (p2pCore) {
    return run(p2pCore.database);
  }

  const dbPath = join(ensureAppDataDir(), 'chat.db');
  const tempDb = new ChatDatabase(dbPath);
  try {
    return run(tempDb);
  } finally {
    tempDb.close();
  }
}

function getConfiguredMaxFileSize(db: ChatDatabase): number {
  const configured = Number.parseInt(db.getSetting('max_file_size') || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : MAX_FILE_SIZE;
}

async function writeUploadAtomically(
  uploadsDir: string,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  return writeFileWithCopySuffix(uploadsDir, fileName, bytes);
}

async function getFlatDirectorySize(directoryPath: string): Promise<number> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => (await stat(join(directoryPath, entry.name))).size),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

function normalizeAddressList(addresses: string[]): string[] {
  return Array.from(
    new Set(
      addresses
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

const ICE_SERVER_TYPES: IceServerType[] = ['stun', 'turn', 'turns'];
const INITIAL_SETUP_STATUSES: InitialSetupStatus[] = [
  'not_started',
  'in_progress',
  'completed',
  'skipped',
];
const SCREEN_SHARE_UNSUPPORTED_MESSAGE = 'Screen sharing is not supported yet';

function isScreenShareSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

function isIceServerType(value: string): value is IceServerType {
  return ICE_SERVER_TYPES.includes(value as IceServerType);
}

function isInitialSetupStatus(value: unknown): value is InitialSetupStatus {
  return typeof value === 'string'
    && INITIAL_SETUP_STATUSES.includes(value as InitialSetupStatus);
}

function inferIceServerType(url: string): IceServerType | null {
  const normalizedUrl = url.trim().toLowerCase();
  if (normalizedUrl.startsWith('stun:')) return 'stun';
  if (normalizedUrl.startsWith('turns:')) return 'turns';
  if (normalizedUrl.startsWith('turn:')) return 'turn';
  return null;
}

function buildDefaultIceServerConfigs(): IceServerConfig[] {
  let nextIndex = 0;

  return DEFAULT_WEBRTC_ICE_SERVERS.flatMap((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

    return urls.flatMap((url) => {
      const type = inferIceServerType(url);
      if (!type) {
        console.warn(`[IPC] Skipping default ICE server with unsupported URL: ${url}`);
        return [];
      }

      const config: IceServerConfig = {
        id: `default-${nextIndex++}`,
        type,
        url,
      };

      if (type !== 'stun') {
        if (server.username) {
          config.username = server.username;
        }
        if (server.credential) {
          config.credential = server.credential;
        }
      }

      return [config];
    });
  });
}

function normalizeIceServers(servers: IceServerConfig[]): IceServerConfig[] {
  const normalized: IceServerConfig[] = [];
  const seen = new Set<string>();

  for (const [index, server] of servers.entries()) {
    const typeValue = typeof server.type === 'string' ? server.type.trim().toLowerCase() : '';
    if (!isIceServerType(typeValue)) {
      throw new Error(`Invalid ICE server type at position ${index + 1}`);
    }

    const url = typeof server.url === 'string' ? server.url.trim() : '';
    if (!url) {
      throw new Error(`ICE server URL is required at position ${index + 1}`);
    }

    const inferredType = inferIceServerType(url);
    if (inferredType !== typeValue) {
      throw new Error(
        typeValue === 'stun'
          ? `STUN server URL must start with stun: (${url})`
          : `${typeValue.toUpperCase()} server URL must start with ${typeValue}: (${url})`,
      );
    }

    const id = typeof server.id === 'string' && server.id.trim()
      ? server.id.trim()
      : `ice-${index + 1}`;

    if (typeValue === 'stun') {
      const dedupeKey = `${typeValue}|${url.toLowerCase()}`;
      if (seen.has(dedupeKey)) {
        throw new Error(`Duplicate ICE server: ${url}`);
      }
      seen.add(dedupeKey);
      normalized.push({ id, type: typeValue, url });
      continue;
    }

    const username = typeof server.username === 'string' ? server.username.trim() : '';
    const credential = typeof server.credential === 'string' ? server.credential.trim() : '';
    if (!username || !credential) {
      throw new Error(`TURN server credentials are required for ${url}`);
    }

    const dedupeKey = `${typeValue}|${url.toLowerCase()}|${username}`;
    if (seen.has(dedupeKey)) {
      throw new Error(`Duplicate ICE server: ${url}`);
    }
    seen.add(dedupeKey);
    normalized.push({ id, type: typeValue, url, username, credential });
  }

  return normalized;
}

function getConfiguredIceServers(database: ChatDatabase): IceServerConfig[] {
  const raw = database.getSetting(WEBRTC_ICE_SERVERS_SETTING_KEY);
  if (raw === null) {
    return buildDefaultIceServerConfigs();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('ICE server setting is not a list');
    }

    return normalizeIceServers(parsed as IceServerConfig[]);
  } catch (error) {
    console.warn(`[IPC] Falling back to default ICE servers: ${errStr(error)}`);
    return buildDefaultIceServerConfigs();
  }
}

const NODE_LIVENESS_PING_TIMEOUT_FAST_MS = 2_000;
const NODE_LIVENESS_PING_TIMEOUT_ANONYMOUS_MS = 6_000;
// Debounce window for auto-reconnect after a bootstrap add: consecutive adds
// coalesce into one retry that fires ~1s after the last add.
const BOOTSTRAP_ADD_RETRY_DEBOUNCE_MS = 1000;

function getNodeLivenessPingTimeoutMs(mode: NetworkMode): number {
  return mode === NETWORK_MODES.ANONYMOUS
    ? NODE_LIVENESS_PING_TIMEOUT_ANONYMOUS_MS
    : NODE_LIVENESS_PING_TIMEOUT_FAST_MS;
}

// True only if we have a connection to this peer AND it answers a ping
async function isPeerReachable(node: ChatNode, peerIdStr: string | null, pingTimeoutMs: number): Promise<boolean> {
  if (!peerIdStr) {
    return false;
  }
  const hasConnection = node.getConnections().some((conn) => conn.remotePeer.toString() === peerIdStr);
  if (!hasConnection) {
    return false;
  }
  try {
    const peerId = peerIdFromString(peerIdStr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (node.services as any).ping.ping(peerId, { signal: AbortSignal.timeout(pingTimeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Setup all IPC handlers for communication between renderer and main process
 */
export function setupIPCHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null,
  getMainWindow: () => BrowserWindow | null
): void {
  const trustedIpcMain = createTrustedIpcMainHandle(ipcMain, getMainWindow);

  // Registration handlers
  setupRegistrationHandlers(trustedIpcMain, getP2PCore);

  // Messaging handlers
  setupMessagingHandlers(trustedIpcMain, getP2PCore);

  // Call signaling handlers
  setupCallHandlers(trustedIpcMain, getP2PCore);
  setupGroupCallHandlers(trustedIpcMain, getP2PCore);

  // Contact request handlers
  setupContactRequestHandlers(trustedIpcMain, getP2PCore, getMainWindow);

  // Bootstrap node handlers
  setupBootstrapHandlers(trustedIpcMain, getP2PCore);

  // Contact attempt handlers
  setupContactAttemptHandlers(trustedIpcMain, getP2PCore);

  // Trusted user import/export handlers
  setupTrustedUserHandlers(trustedIpcMain, getP2PCore);

  // File dialog handlers
  setupFileDialogHandlers(trustedIpcMain);

  // Capability-gated local media handlers
  setupMediaHandlers(trustedIpcMain, getP2PCore);

  // Persistent pasted-image storage
  setupUploadHandlers(trustedIpcMain, getP2PCore);

  // Chat handlers
  setupChatHandlers(trustedIpcMain, getP2PCore);

  // Message handlers
  setupMessageHandlers(trustedIpcMain, getP2PCore);

  // Pending key exchange handlers
  setupPendingKeyExchangeHandlers(trustedIpcMain, getP2PCore);

  // Offline message handlers
  setupOfflineMessageHandlers(trustedIpcMain, getP2PCore);

  // Notification handlers
  setupNotificationHandlers(trustedIpcMain, getMainWindow);

  // Chat settings handlers
  setupChatSettingsHandlers(trustedIpcMain, getP2PCore, getMainWindow);

  // File transfer handlers
  setupFileTransferHandlers(trustedIpcMain, getP2PCore);

  // Group chat handlers
  setupGroupHandlers(trustedIpcMain, getP2PCore);

  // App handlers
  setupAppHandlers(trustedIpcMain, getP2PCore);
}

/**
 * Username registration handlers
 */
function setupRegistrationHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.REGISTER_REQUEST, async (_event, username: string, rememberMe: boolean) => {
    try {
      log(`[IPC] Registering username: ${username} with rememberMe: ${rememberMe}`);
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Registering username: ${username}`);
      const success = await p2pCore.usernameRegistry.register(username, false, rememberMe);

      if (success) {
        log(`[IPC] Successfully registered username: ${username}`);
        return { success: true };
      } else {
        return { success: false, error: 'Failed to register username. Network may be unreachable.' };
      }
    } catch (error) {
      console.error('[IPC] Registration failed:', error);
      return { success: false, error: errStr(error, 'Unknown error') };
    }
  });

  // Get current user state (username, registration status)
  ipcMain.handle(IPC_CHANNELS.GET_USER_STATE, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { peerId: null, username: null, isRegistered: false };
      }

      const peerId = p2pCore.node.peerId.toString();
      const username = p2pCore.usernameRegistry.getCurrentUsername();
      return { 
        peerId,
        username: username || null, 
        isRegistered: !!username 
      };
    } catch (error) {
      console.error('[IPC] Failed to get user state:', error);
      return { peerId: null, username: null, isRegistered: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_LAST_USERNAME, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { username: null };
      }
      const peerId = p2pCore.node.peerId.toString();
      const username = p2pCore.database.getLastUsername(peerId);
      return { username: username ?? null };
    } catch (error) {
      console.error('[IPC] Failed to get last username:', error);
      return { username: null };
    }
  });

  ipcMain.handle(IPC_CHANNELS.ATTEMPT_AUTO_REGISTER, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, username: null, error: 'P2P core not initialized' };
      }
      const username = await p2pCore.usernameRegistry.attemptAutoRegister();
      if (username) {
        return { success: true, username };
      }
      return { success: false, username: null };
    } catch (error) {
      console.error('[IPC] Failed to attempt auto-register:', error);
      return { success: false, username: null, error: errStr(error, 'Failed to auto-register') };
    }
  });

  // Unregister
  ipcMain.handle(IPC_CHANNELS.UNREGISTER_REQUEST, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { usernameUnregistered: false, peerIdUnregistered: false };
      }

      const result = await p2pCore.usernameRegistry.unregister();
      return result;
    } catch (error) {
      console.error('[IPC] Failed to unregister:', error);
      return { usernameUnregistered: false, peerIdUnregistered: false };
    }
  });
  // Get auto-register setting
  ipcMain.handle(IPC_CHANNELS.GET_AUTO_REGISTER, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { autoRegister: false };
      }

      const mode = p2pCore.database.getSessionNetworkMode();
      const setting = p2pCore.database.getSetting(`auto_register_${mode}`);
      // Default ON when the user has never set a preference
      return { autoRegister: setting !== 'never' };
    } catch (error) {
      console.error('[IPC] Failed to get auto-register setting:', error);
      return { autoRegister: false };
    }
  });

  // Set auto-register setting
  ipcMain.handle(IPC_CHANNELS.SET_AUTO_REGISTER, async (_event, enabled: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const mode = p2pCore.database.getSessionNetworkMode();
      p2pCore.database.setSetting(`auto_register_${mode}`, enabled ? 'true' : 'never');
      log(`[IPC] Auto-register setting updated to: ${enabled} (mode=${mode})`);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to set auto-register:', error);
      return { success: false, error: errStr(error, 'Failed to set auto-register') };
    }
  });
}

/**
 * Message sending handlers
 */
function setupMessagingHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.SEND_MESSAGE_REQUEST, async (_event, identifier: string, message: string, replyToCid?: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, messageSentStatus: null, error: 'P2P core not initialized' };
      }

      log(`[IPC] Sending message to ${identifier}: ${message}`);

      // Check if identifier is a valid peer ID or username
      try {
        peerIdFromString(identifier);
        log(`[IPC] Identifier is a peer ID`);
      } catch {
        // Not a peer ID, check if it's a valid username
        if (!validateUsername(identifier)) {
          return { success: false, messageSentStatus: null, error: 'Invalid username or peer ID' };
        }
        log(`[IPC] Identifier is a username`);
      }

      if (!validateMessageLength(message)) {
        return { success: false, messageSentStatus: null, error: 'Message too long' };
      }

      log(`[IPC] Sending message to ${identifier}: ${message}`);

      const response = await p2pCore.messageHandler.sendMessage(identifier, message, replyToCid);
      log(`[IPC] Message sent response: ${JSON.stringify(response)}`);

      if (response.success) {
        return {
          success: true,
          messageSentStatus: response.messageSentStatus,
          error: null,
          message: response.message,
          localSendState: response.localSendState,
        };
      }
      return {
        success: false,
        messageSentStatus: null,
        error: response.error ?? 'Failed to send message',
        ...(response.connectivityFailure
          ? { connectivityFailure: response.connectivityFailure }
          : {}),
      };
    } catch (error) {
      console.error('[IPC] Failed to send message:', error);
      return { success: false, messageSentStatus: null, error: errStr(error, "Failed to send message") };
    }
  });

  // Fast pre-send capacity check so the renderer can refuse (toast + keep draft)
  // before creating an optimistic row when the offline bucket is full.
  ipcMain.handle(IPC_CHANNELS.CHECK_OFFLINE_CAPACITY, async (_event, peerId: string, additional?: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { hasRoom: true };
      }
      return { hasRoom: p2pCore.messageHandler.checkOfflineCapacity(peerId, additional ?? 0) };
    } catch (error) {
      console.error('[IPC] checkOfflineCapacity failed:', error);
      return { hasRoom: true };
    }
  });

  ipcMain.handle(IPC_CHANNELS.REQUEST_OFFLINE_INBOX_RECOVERY, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { started: false };
      }
      return { started: p2pCore.messageHandler.requestDirectOfflineInboxRecovery(peerId) };
    } catch (error) {
      console.error('[IPC] requestOfflineInboxRecovery failed:', error);
      return { started: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_OFFLINE_INBOX_CAPACITY, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, snapshot: null, error: 'P2P core not initialized' };
      }
      return {
        success: true,
        snapshot: p2pCore.messageHandler.getOfflineInboxCapacity(chatId),
        error: null,
      };
    } catch (error) {
      console.error('[IPC] getOfflineInboxCapacity failed:', error);
      return {
        success: false,
        snapshot: null,
        error: errStr(error, 'Failed to fetch offline inbox capacity'),
      };
    }
  });

  // Manual retry of a failed 1:1 offline send.
  ipcMain.handle(IPC_CHANNELS.RETRY_OFFLINE_SEND, async (_event, messageId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      p2pCore.messageHandler.retryOfflineSend(messageId);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] retryOfflineSend failed:', error);
      return { success: false, error: errStr(error, 'Failed to retry offline send') };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SEND_GROUP_MESSAGE_REQUEST,
    async (
      _event,
      chatId: number,
      message: string,
      options?: { rekeyRetryHint?: boolean; replyToCid?: string }
    ) => {
    const startedAt = Date.now();
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, messageSentStatus: null, error: 'P2P core not initialized' };
      }

      if (!Number.isInteger(chatId) || chatId <= 0) {
        return { success: false, messageSentStatus: null, error: 'Invalid group chat ID' };
      }
      if (!validateMessageLength(message)) {
        return { success: false, messageSentStatus: null, error: 'Message too long' };
      }

      log('sending group message', chatId, message);
      const response = await p2pCore.messageHandler.sendGroupMessage(chatId, message, options);
      log(
        `[IPC][TIMING][GROUP-SEND] done chatId=${chatId} success=${response.success} ` +
        `status=${response.messageSentStatus ?? 'none'} took=${Date.now() - startedAt}ms`
      );
      if (response.success) {
        return {
          success: true,
          messageSentStatus: response.messageSentStatus,
          error: null,
          message: response.message,
          warning: response.warning ?? null,
          offlineBackupRetry: response.offlineBackupRetry ?? null,
        };
      }
      return {
        success: false,
        messageSentStatus: null,
        error: response.error ?? 'Failed to send group message',
        ...(response.connectivityFailure
          ? { connectivityFailure: response.connectivityFailure }
          : {}),
      };
    } catch (error) {
      log(`[IPC][TIMING][GROUP-SEND] failed chatId=${chatId} took=${Date.now() - startedAt}ms`);
      console.error('[IPC] Failed to send group message:', error);
      return { success: false, messageSentStatus: null, error: errStr(error, 'Failed to send group message') };
    }
    }
  );
}

function setupCallHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_SCREEN_SHARE_SUPPORT, async () => {
    const supported = isScreenShareSupported();
    return {
      success: true,
      supported,
      message: supported ? 'Screen sharing is available' : SCREEN_SHARE_UNSUPPORTED_MESSAGE,
      error: null,
    };
  });

  ipcMain.handle(IPC_CHANNELS.CALL_START, async (_event, peerId: string, callId: string, offerSdp: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.messageHandler.startCall(peerId, callId, offerSdp);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to start call') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CALL_ACCEPT, async (_event, peerId: string, callId: string, answerSdp: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.messageHandler.acceptCall(peerId, callId, answerSdp);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to accept call') };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.CALL_REJECT,
    async (_event, peerId: string, callId: string, reason?: 'rejected' | 'timeout' | 'offline' | 'policy') => {
      try {
        const p2pCore = getP2PCore();
        if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
        return await p2pCore.messageHandler.rejectCall(peerId, callId, reason ?? 'rejected');
      } catch (error) {
        return { success: false, error: errStr(error, 'Failed to reject call') };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.CALL_HANGUP,
    async (_event, peerId: string, callId: string, reason?: 'hangup' | 'disconnect' | 'failed') => {
      try {
        const p2pCore = getP2PCore();
        if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
        return await p2pCore.messageHandler.hangupCall(peerId, callId, reason ?? 'hangup');
      } catch (error) {
        return { success: false, error: errStr(error, 'Failed to hang up call') };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.CALL_SIGNAL_SEND, async (_event, signal: CallSignalOutgoingInput) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.messageHandler.sendCallSignal(signal);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to send call signal') };
    }
  });
}

function setupGroupCallHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null,
): void {
  ipcMain.handle(IPC_CHANNELS.GROUP_CALL_START, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.groupCallOrchestrator.startGroupCall(chatId);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to start group call') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GROUP_CALL_JOIN, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.groupCallOrchestrator.joinGroupCall(chatId);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to join group call') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GROUP_CALL_LEAVE, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.groupCallOrchestrator.leaveGroupCall(chatId);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to leave group call') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GROUP_CALL_WRITER_RECOVERY_FALLBACK, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.groupCallOrchestrator.fallbackWriterRecovery(chatId);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to recover group call writer session') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GROUP_CALL_PAIR_SIGNAL_SEND, async (_event, signal: GroupCallPairSignalOutgoingInput) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) return { success: false, error: 'P2P core not initialized' };
      return await p2pCore.groupCallOrchestrator.sendPairSignal(signal);
    } catch (error) {
      return { success: false, error: errStr(error, 'Failed to send group call pair signal') };
    }
  });
}

function notifyGroupCallPeerBlocked(
  getMainWindow: () => BrowserWindow | null,
  peerId: string
): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.GROUP_CALL_PEER_BLOCKED, peerId);
  }
}

/**
 * Contact request handlers
 */
function setupContactRequestHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC_CHANNELS.ACCEPT_CONTACT_REQUEST, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      const currentUsername = p2pCore.usernameRegistry.getCurrentUsername();
      if (!currentUsername) {
        return { success: false, error: 'Finish registration first, then accept this contact request.' };
      }

      log(`[IPC] Accepting contact request from peer: ${peerId}`);
      p2pCore.messageHandler.getKeyExchange().acceptPendingContact(peerId);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to accept contact request:', error);
      return { success: false, error: errStr(error, 'Failed to accept contact request') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.REJECT_CONTACT_REQUEST, async (_event, peerId: string, block: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Rejecting contact request from peer: ${peerId}`);
      const keyExchange = p2pCore.messageHandler.getKeyExchange();
      const pending = keyExchange.getPendingAcceptanceByPeerId(peerId);

      if (pending) {
        keyExchange.rejectPendingContact(peerId);
      } else {
        log(`[IPC] No active pending contact request for ${peerId}; treating as already rejected`);
      }

      // Idempotent local cleanup: always clear any in-memory/db residue.
      keyExchange.deletePendingAcceptanceByPeerId(peerId);
      p2pCore.database.deleteContactAttemptsByPeerId(peerId);

      if (block) {
        const knownUsername = pending?.username ?? p2pCore.database.getUserByPeerId(peerId)?.username ?? null;
        p2pCore.database.blockPeer(peerId, knownUsername, 'Rejected contact request');
        await p2pCore.messageHandler.teardownBlockedPeer(peerId);
        notifyGroupCallPeerBlocked(getMainWindow, peerId);
        log(`Rejected and blocked ${knownUsername ?? peerId}`);
      } else {
        log(`Rejected contact request from ${pending?.username ?? peerId}`);
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to reject contact request:', error);
      return { success: false, error: errStr(error, 'Failed to reject contact request') };
    }
  });
}

/**
 * Bootstrap node management handlers
 */
function setupBootstrapHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  const failConnectionNodesResponse = (error: string): ConnectionNodesResponse => ({
    success: false,
    nodes: [],
    error,
  });

  const failBootstrapRetryResponse = (error: string): BootstrapRetryResponse => ({
    success: false,
    result: null,
    error,
  });

  const failRelayRetryResponse = (error: string): RelayRetryResponse => ({
    success: false,
    attempted: 0,
    connected: 0,
    error,
  });

  // Auto-reconnect after a bootstrap add. Debounced 1s and coalesced so a burst
  // of adds produces a SINGLE dial against the complete list (not a first dial
  // against a partial list that visibly fails mid-typing). The target p2pCore is
  // resolved at fire time — if it was torn down (shutdown / network-mode
  // relaunch) between the add and the debounce firing, the run is skipped
  // silently. retryBootstrap() is single-flight: it refuses to run when a
  // reconnect is already in progress and returns a 'retry_in_progress' result,
  // which we only log — the periodic health-check reconnect re-reads the full
  // bootstrap list from the DB, so the freshly added address is never lost.
  // ('aborted' is distinct: the dial itself timed out mid-flight.)
  const bootstrapAddRetry = createDebouncedInvoker({
    delayMs: BOOTSTRAP_ADD_RETRY_DEBOUNCE_MS,
    resolveTarget: getP2PCore,
    run: async (p2pCore) => {
      try {
        const result = await p2pCore.retryBootstrap();
        if (result.status === 'retry_in_progress') {
          log('[IPC] Bootstrap add auto-retry skipped (a reconnect is already in progress); periodic checker will pick up the new address');
        } else if (result.status === 'aborted') {
          log('[IPC] Bootstrap add auto-retry aborted (dial timed out mid-flight); periodic checker will pick up the new address');
        } else {
          log(`[IPC] Bootstrap add auto-retry complete status=${result.status} connected=${result.connectedCount}`);
        }
      } catch (retryError) {
        // Non-fatal: node is persisted and can be applied via manual retry later.
        console.warn(`[IPC] Bootstrap add auto-retry failed: ${errStr(retryError)}`);
      }
    },
    onError: (retryError) => {
      console.warn(`[IPC] Bootstrap add auto-retry failed: ${errStr(retryError)}`);
    },
  });

  // Get current DHT connection status snapshot
  ipcMain.handle(IPC_CHANNELS.GET_DHT_CONNECTION_STATUS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, connected: null as boolean | null, error: 'P2P core not initialized' };
      }

      const connected = p2pCore.getCurrentDhtStatus();
      return { success: true, connected, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get DHT connection status:', error);
      return {
        success: false,
        connected: null as boolean | null,
        error: errStr(error, 'Failed to get DHT connection status'),
      };
    }
  });

  // OS-level network connectivity snapshot
  ipcMain.handle(IPC_CHANNELS.GET_NETWORK_CONNECTED, async () => {
    return { connected: isNetworkConnected() };
  });

  // OS connectivity just returned: reconnect to the DHT now instead of waiting 
  ipcMain.handle(IPC_CHANNELS.NOTIFY_NETWORK_RECONNECTED, async () => {
    const p2pCore = getP2PCore();
    if (!p2pCore) {
      return;
    }
    log('[IPC] OS connectivity returned — requesting immediate DHT reconnect');
    void p2pCore.requestImmediateReconnect().catch((error) => {
      console.warn('[IPC] Network-return reconnect failed:', errStr(error));
    });
  });

  // Per-node liveness probe: pings each address (short timeout, never dials)
  ipcMain.handle(IPC_CHANNELS.GET_NODES_LIVENESS, async (_event, addresses: string[]) => {
    const p2pCore = getP2PCore();
    if (!p2pCore) {
      return { statuses: [] } satisfies NodesLivenessResponse;
    }
    const pingTimeoutMs = getNodeLivenessPingTimeoutMs(p2pCore.database.getSessionNetworkMode());
    const statuses = await Promise.all((addresses ?? []).map(async (address) => {
      let peerIdStr: string | null = null;
      try {
        peerIdStr = multiaddr(address).getPeerId();
      } catch {
        peerIdStr = null;
      }
      return { address, connected: await isPeerReachable(p2pCore.node, peerIdStr, pingTimeoutMs) };
    }));
    return { statuses } satisfies NodesLivenessResponse;
  });

  // Get bootstrap nodes from database
  ipcMain.handle(IPC_CHANNELS.GET_BOOTSTRAP_NODES, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return failConnectionNodesResponse('P2P core not initialized');
      }

      log('[IPC] Fetching bootstrap nodes from database...');
      const dbNodes = p2pCore.database.getBootstrapNodes();
      // Fast: addresses only. Status is left null ("checking") and filled in by the
      // separate liveness probe, so the slow ping never blocks the list from loading.
      const nodes: ConnectionNodeStatus[] = dbNodes.map((node) => ({
        address: node.address,
        connected: null,
      }));
      log(`[IPC] Found ${nodes.length} bootstrap nodes`);

      return { success: true, nodes, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get bootstrap nodes:', error);
      return failConnectionNodesResponse(errStr(error, 'Failed to get bootstrap nodes'));
    }
  });

  // Retry bootstrap connection
  ipcMain.handle(IPC_CHANNELS.RETRY_BOOTSTRAP, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return failBootstrapRetryResponse('P2P core not initialized');
      }

      log('[IPC] Retrying bootstrap connection...');
      const result = await p2pCore.retryBootstrap();
      log(`[DHT-STATUS][IPC][RETRY_BOOTSTRAP] complete peerCount=${p2pCore.node.getConnections().length}`);
      log(`[IPC] Bootstrap retry complete status=${result.status}`);

      return { success: true, result, error: null };
    } catch (error) {
      console.error('[IPC] Failed to retry bootstrap:', error);
      return failBootstrapRetryResponse(errStr(error, 'Failed to retry bootstrap connection'));
    }
  });

  // Retry relay reservations (Fast mode)
  ipcMain.handle(IPC_CHANNELS.RETRY_RELAYS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return failRelayRetryResponse('P2P core not initialized');
      }

      if (p2pCore.networkMode !== NETWORK_MODES.FAST) {
        return failRelayRetryResponse('Relay retry is available only in Fast mode');
      }

      log('[IPC] Retrying relay reservations...');
      const result = await p2pCore.retryRelays();
      log(`[IPC] Relay retry complete connected=${result.connected}/${result.attempted}`);
      return { success: true, attempted: result.attempted, connected: result.connected, error: null };
    } catch (error) {
      console.error('[IPC] Failed to retry relay reservations:', error);
      return failRelayRetryResponse(errStr(error, 'Failed to retry relay reservations'));
    }
  });

  // Get relay connectivity status (Fast mode relay list + current connected state)
  ipcMain.handle(IPC_CHANNELS.GET_RELAY_STATUS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return failConnectionNodesResponse('P2P core not initialized');
      }

      if (p2pCore.networkMode !== NETWORK_MODES.FAST) {
        return { success: true, nodes: [], error: null };
      }

      const snapshot = getFastRelayStatusSnapshot(p2pCore.node, p2pCore.database);
      // Fast: addresses only, status left null. Liveness is filled in by the probe.
      const nodes: ConnectionNodeStatus[] = snapshot.nodes.map((node) => ({
        address: node.address,
        connected: null,
      }));

      return { success: true, nodes, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get relay status:', error);
      return failConnectionNodesResponse(errStr(error, 'Failed to get relay status'));
    }
  });

  // Add relay node
  ipcMain.handle(IPC_CHANNELS.ADD_RELAY_NODE, async (_event, address: string) => {
    try {
      const p2pCore = getP2PCore();
      const normalized = address.trim();
      if (!normalized) {
        return { success: false, error: 'Relay address cannot be empty' };
      }

      let ma: ReturnType<typeof multiaddr>;
      try {
        ma = multiaddr(normalized);
      } catch {
        return { success: false, error: 'Enter a valid multiaddress, e.g. /ip4/1.2.3.4/tcp/4002/p2p/12D3Koo…' };
      }
      if (!ma.getPeerId()) {
        return { success: false, error: 'Relay multiaddr must include /p2p/<peerId>' };
      }

      withSettingsDatabase(getP2PCore, (db) => {
        const existing = [...getConfiguredFastRelayAddrs(db).addresses];

        if (existing.includes(normalized)) {
          throw new Error('Relay node already exists');
        }

        existing.push(normalized);
        db.setSetting(FAST_RELAY_MULTIADDRS_SETTING_KEY, serializeFastRelayAddressList(existing));
      });

      if (p2pCore && p2pCore.networkMode === NETWORK_MODES.FAST) {
        try {
          const relayRetry = await p2pCore.retryRelays();
          log(
            `[IPC] Relay add auto-apply complete connected=${relayRetry.connected}/${relayRetry.attempted}`,
          );
        } catch (retryError) {
          // Non-fatal: node is persisted and can be applied via manual retry later.
          console.warn(`[IPC] Relay add auto-apply failed: ${errStr(retryError)}`);
        }
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to add relay node:', error);
      return { success: false, error: errStr(error, 'Failed to add relay node') };
    }
  });

  // Remove relay node
  ipcMain.handle(IPC_CHANNELS.REMOVE_RELAY_NODE, async (_event, address: string) => {
    try {
      const normalized = address.trim();
      if (!normalized) {
        return { success: false, error: 'Relay address cannot be empty' };
      }

      withSettingsDatabase(getP2PCore, (db) => {
        const existing = getConfiguredFastRelayAddrs(db).addresses;
        const next = existing.filter((entry) => entry !== normalized);
        db.setSetting(FAST_RELAY_MULTIADDRS_SETTING_KEY, serializeFastRelayAddressList(next));
      });

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to remove relay node:', error);
      return { success: false, error: errStr(error, 'Failed to remove relay node') };
    }
  });

  // Reorder relay nodes
  ipcMain.handle(IPC_CHANNELS.REORDER_RELAY_NODES, async (_event, addresses: string[]) => {
    try {
      withSettingsDatabase(getP2PCore, (db) => {
        const incoming = normalizeFastRelayAddressList(addresses);
        const existing = getConfiguredFastRelayAddrs(db).addresses;
        const existingSet = new Set(existing);

        if (incoming.length !== existingSet.size || incoming.some((address) => !existingSet.has(address))) {
          throw new Error('Invalid relay reorder payload');
        }

        for (const address of incoming) {
          const ma = multiaddr(address);
          if (!ma.getPeerId()) {
            throw new Error(`Relay multiaddr must include /p2p/<peerId>: ${address}`);
          }
        }

        db.setSetting(FAST_RELAY_MULTIADDRS_SETTING_KEY, serializeFastRelayAddressList(incoming));
      });

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to reorder relay nodes:', error);
      return { success: false, error: errStr(error, 'Failed to reorder relay nodes') };
    }
  });

  // Add bootstrap node
  ipcMain.handle(IPC_CHANNELS.ADD_BOOTSTRAP_NODE, async (_event, address: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const normalized = address.trim();
      if (!normalized) {
        return { success: false, error: 'Bootstrap address cannot be empty' };
      }

      let ma: ReturnType<typeof multiaddr>;
      try {
        ma = multiaddr(normalized);
      } catch {
        return { success: false, error: 'Enter a valid multiaddress, e.g. /ip4/1.2.3.4/tcp/4001/p2p/12D3Koo…' };
      }
      if (!ma.getPeerId()) {
        return { success: false, error: 'Bootstrap multiaddr must include /p2p/<peerId>' };
      }

      log(`[IPC] Adding bootstrap node: ${normalized}`);
      p2pCore.database.addBootstrapNode(normalized);
      log('[IPC] Bootstrap node added');

      // Best-effort: schedule a debounced reconnect so the new server is dialed
      // automatically. Fires ~1s after the LAST add (see bootstrapAddRetry). We
      // return success immediately without awaiting the retry — the DB write is
      // the source of truth and the retry must never fail the add response.
      bootstrapAddRetry.schedule();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to add bootstrap node:', error);
      return { success: false, error: errStr(error, 'Failed to add bootstrap node') };
    }
  });

  // Remove bootstrap node
  ipcMain.handle(IPC_CHANNELS.REMOVE_BOOTSTRAP_NODE, async (_event, address: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Removing bootstrap node: ${address}`);
      p2pCore.database.removeBootstrapNode(address);
      log('[IPC] Bootstrap node removed');

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to remove bootstrap node:', error);
      return { success: false, error: errStr(error, 'Failed to remove bootstrap node') };
    }
  });

  // Reorder bootstrap nodes
  ipcMain.handle(IPC_CHANNELS.REORDER_BOOTSTRAP_NODES, async (_event, addresses: string[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const incoming = normalizeAddressList(addresses);
      const existing = p2pCore.database.getBootstrapNodes().map((node) => node.address);
      const existingSet = new Set(existing);
      if (incoming.length !== existingSet.size || incoming.some((address) => !existingSet.has(address))) {
        return { success: false, error: 'Invalid bootstrap reorder payload' };
      }

      p2pCore.database.reorderBootstrapNodes(incoming);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to reorder bootstrap nodes:', error);
      return { success: false, error: errStr(error, 'Failed to reorder bootstrap nodes') };
    }
  });
}

// Contact attempt handlers
function setupContactAttemptHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_CONTACT_ATTEMPTS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, contactAttempts: [], error: 'P2P core not initialized' };
      }

      log('[IPC] Fetching contact attempts from database...');
      const pendingAcceptances = p2pCore.messageHandler.getKeyExchange().getPendingAcceptances();

      const contactAttempts = pendingAcceptances.map(attempt => ({
        peerId: attempt.peerId,
        username: attempt.username,
        message: "Contact request",
        messageBody: attempt.messageBody,
        receivedAt: attempt.receivedAt,
        expiresAt: attempt.expiresAt
      }));

      log(`[IPC] Found ${contactAttempts.length} contact attempts`);

      return { success: true, contactAttempts, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get contact attempts:', error);
      return { success: false, contactAttempts: [], error: errStr(error, 'Failed to get contact attempts') };
    }
  });
}

/**
 * Trusted user import handlers
 */
function setupTrustedUserHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.IMPORT_TRUSTED_USER, async (_event, filePath: string, password: string, customName?: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Importing trusted user from: ${filePath}`);
      const myPeerId = p2pCore.userIdentity.id;

      const result = await ProfileManager.importTrustedUser(
        filePath,
        password,
        myPeerId,
        p2pCore.database,
        customName
      );

      if (result.success) {
        log(`[IPC] Successfully imported trusted user: ${result.username}`);
      } else {
        console.error(`[IPC] Failed to import trusted user: ${result.error}`);
      }

      return result;
    } catch (error) {
      console.error('[IPC] Failed to import trusted user:', error);
      return {
        success: false,
        error: errStr(error, 'Failed to import trusted user')
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_PROFILE, async (_event, password: string, sharedSecret: string, filename: string, label: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const registeredUsername = p2pCore.usernameRegistry.getCurrentUsername();
      const trimmedLabel = typeof label === 'string' ? label.trim() : '';
      const resolvedLabel = trimmedLabel || (registeredUsername ?? '');
      if (!resolvedLabel) {
        return { success: false, error: 'A display label is required' };
      }
      if (resolvedLabel.length < 2 || resolvedLabel.length > 64) {
        return { success: false, error: 'Display label must be between 2 and 64 characters' };
      }

      // The destination path comes from the renderer's native save dialog
      const trimmedFilename = typeof filename === 'string' ? filename.trim() : '';
      if (!trimmedFilename) {
        return { success: false, error: 'A file path is required' };
      }
      const resolvedFilename = trimmedFilename.toLowerCase().endsWith('.kiyeovo')
        ? trimmedFilename
        : `${trimmedFilename}.kiyeovo`;

      const myPeerId = p2pCore.userIdentity.id;

      log(`[IPC] Exporting profile to: ${resolvedFilename}`);

      const result = await ProfileManager.exportProfileDesktop(
        p2pCore.userIdentity,
        resolvedLabel,
        myPeerId,
        resolvedFilename,
        password,
        sharedSecret
      );

      if (result.success) {
        log(`[IPC] Successfully exported profile to: ${filename}`);
      } else {
        console.error(`[IPC] Failed to export profile: ${result.error}`);
      }

      return result;
    } catch (error) {
      console.error('[IPC] Failed to export profile:', error);
      return {
        success: false,
        error: errStr(error, 'Failed to export profile')
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHECK_TRUSTED_SECRET_REUSE, async (_event, sharedSecret: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, isReused: false, count: 0, error: 'P2P core not initialized' };
      }

      const normalizedSecret = typeof sharedSecret === 'string' ? sharedSecret.trim() : '';
      if (!normalizedSecret) {
        return { success: false, isReused: false, count: 0, error: 'Shared secret is required' };
      }

      const count = p2pCore.database.countTrustedDirectChatsByOfflineSecret(normalizedSecret);
      return { success: true, isReused: count > 0, count, error: null };
    } catch (error) {
      console.error('[IPC] Failed to check shared secret reuse:', error);
      return {
        success: false,
        isReused: false,
        count: 0,
        error: errStr(error, 'Failed to check shared secret reuse'),
      };
    }
  });
}

/**
 * File dialog handlers
 */
function setupFileDialogHandlers(ipcMain: IpcMainHandleRegistrar): void {
  ipcMain.handle(IPC_CHANNELS.SHOW_OPEN_DIALOG, async (_event, options: {
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'openDirectory'>;
  }) => {
    try {
      const result = await dialog.showOpenDialog({
        title: options.title || 'Open File',
        properties: options.properties || ['openFile'],
        filters: options.filters || []
      });

      const filePath = result.filePaths[0] || null;
      if (!result.canceled && filePath) {
        grantDialogPath(filePath);
      }

      let mediaToken: string | null = null;
      if (!result.canceled && filePath && isImageFile(filePath)) {
        try {
          const selectedPathStats = await lstat(filePath);
          if (selectedPathStats.isSymbolicLink()) {
            console.warn('[IPC][SECURITY] Refusing media capability for symbolic-link selection');
            return {
              filePath,
              canceled: result.canceled,
              mediaToken: null,
            };
          }
          const canonicalPath = await realpath(filePath);
          const fileStats = await stat(canonicalPath);
          if (fileStats.isFile()) {
            mediaToken = mintMediaToken(canonicalPath);
          }
        } catch (error) {
          console.warn('[IPC] Failed to create selected-image media capability:', error);
        }
      }

      return {
        filePath,
        canceled: result.canceled,
        mediaToken,
      };
    } catch (error) {
      console.error('[IPC] Failed to show open dialog:', error);
      return { filePath: null, canceled: true, mediaToken: null };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHOW_SAVE_DIALOG, async (_event, options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => {
    try {
      const dialogOptions: SaveDialogOptions = {
        title: options.title || 'Save File',
        filters: options.filters || []
      };

      if (options.defaultPath) {
        dialogOptions.defaultPath = options.defaultPath;
      }

      const result = await dialog.showSaveDialog(dialogOptions);
      const filePath = result.filePath || null;
      if (!result.canceled && filePath) {
        grantDialogPath(filePath);
      }

      return {
        filePath,
        canceled: result.canceled
      };
    } catch (error) {
      console.error('[IPC] Failed to show save dialog:', error);
      return { filePath: null, canceled: true };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_FILE_METADATA, async (_event, filePath: string) => {
    try {
      const metadata = await resolveDialogGrantedFileMetadata({ filePath });
      return {
        success: true,
        name: metadata.name,
        size: metadata.size,
        error: null
      };
    } catch (error) {
      console.error('[IPC] Failed to get file metadata:', error);
      return {
        success: false,
        name: null,
        size: null,
        error: errStr(error, 'Failed to get file metadata')
      };
    }
  });
}

function setupMediaHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null,
): void {
  ipcMain.handle(IPC_CHANNELS.REGISTER_MESSAGE_MEDIA, async (_event, messageId: string) => {
    try {
      if (typeof messageId !== 'string' || !messageId.trim()) {
        return { success: false, token: null, error: 'Invalid message ID' };
      }

      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, token: null, error: 'P2P core not initialized' };
      }

      const { canonicalPath } = await resolveCompletedImageMedia(p2pCore.database, messageId);

      return {
        success: true,
        token: mintMediaToken(canonicalPath),
        error: null,
      };
    } catch (error) {
      console.error('[IPC] Failed to register message media:', error);
      return {
        success: false,
        token: null,
        error: errStr(error, 'Failed to register message media'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.COPY_IMAGE_TO_CLIPBOARD, async (_event, messageId: string) => {
    try {
      if (typeof messageId !== 'string' || !messageId.trim()) {
        return { success: false, error: 'Invalid message ID' };
      }

      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const { canonicalPath } = await resolveCompletedImageMedia(p2pCore.database, messageId);
      const image = nativeImage.createFromPath(canonicalPath);
      if (image.isEmpty()) {
        return { success: false, error: 'Image could not be decoded for clipboard' };
      }

      clipboard.writeImage(image);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to copy image to clipboard:', error);
      return {
        success: false,
        error: errStr(error, 'Failed to copy image to clipboard'),
      };
    }
  });
}

function setupUploadHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null,
): void {
  ipcMain.handle(IPC_CHANNELS.SAVE_UPLOAD, async (
    _event,
    bytes: unknown,
    fileName: unknown,
  ) => {
    let savedFilePath: string | null = null;

    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return {
          success: false,
          filePath: null,
          mediaToken: null,
          uploadsDirSizeBytes: 0,
          error: 'P2P core not initialized',
        };
      }

      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        return {
          success: false,
          filePath: null,
          mediaToken: null,
          uploadsDirSizeBytes: 0,
          error: 'Upload bytes are required',
        };
      }

      if (typeof fileName !== 'string' || !fileName.trim()) {
        return {
          success: false,
          filePath: null,
          mediaToken: null,
          uploadsDirSizeBytes: 0,
          error: 'Upload filename is required',
        };
      }

      const validatedFileName = validateUploadImageFileName(fileName);
      if (!validatedFileName.success) {
        return {
          success: false,
          filePath: null,
          mediaToken: null,
          uploadsDirSizeBytes: 0,
          error: validatedFileName.error,
        };
      }
      const sanitizedFileName = validatedFileName.fileName;

      const maxFileSize = getConfiguredMaxFileSize(p2pCore.database);
      if (bytes.byteLength > maxFileSize) {
        return {
          success: false,
          filePath: null,
          mediaToken: null,
          uploadsDirSizeBytes: 0,
          error: `Image exceeds the configured file-size limit (${maxFileSize} bytes)`,
        };
      }

      const uploadsDir = resolveUploadsDirectory(p2pCore.database);
      await mkdir(uploadsDir, { recursive: true });
      savedFilePath = await writeUploadAtomically(
        uploadsDir,
        sanitizedFileName,
        Buffer.from(bytes),
      );

      const uploadsDirSizeBytes = await getFlatDirectorySize(uploadsDir);
      const canonicalPath = await realpath(savedFilePath);
      const savedFileStats = await stat(canonicalPath);
      if (!savedFileStats.isFile()) {
        throw new Error('Saved upload is not a regular file');
      }

      log(`[IPC] Saved pasted image upload: ${sanitizedFileName} (${bytes.byteLength} bytes)`);
      return {
        success: true,
        filePath: savedFilePath,
        mediaToken: mintMediaToken(canonicalPath),
        uploadsDirSizeBytes,
        error: null,
      };
    } catch (error) {
      if (savedFilePath) {
        try {
          await rm(savedFilePath, { force: true });
        } catch (cleanupError) {
          console.error('[IPC] Failed to remove incomplete pasted-image upload:', cleanupError);
        }
      }
      console.error('[IPC] Failed to save pasted-image upload:', error);
      return {
        success: false,
        filePath: null,
        mediaToken: null,
        uploadsDirSizeBytes: 0,
        error: errStr(error, 'Failed to save pasted image'),
      };
    }
  });

  const textUploadFailure = (error: string): SaveTextUploadResponse => ({
    success: false,
    filePath: null,
    fileName: null,
    fileSize: 0,
    uploadsDirSizeBytes: 0,
    error,
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_TEXT_UPLOAD, async (
    _event,
    text: unknown,
    fileName: unknown,
  ): Promise<SaveTextUploadResponse> => {
    let savedFilePath: string | null = null;

    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return textUploadFailure('P2P core not initialized');
      }

      const maxFileSize = getConfiguredMaxFileSize(p2pCore.database);
      const prepared = prepareTextUpload(text, fileName, maxFileSize);
      if (!prepared.success) {
        return textUploadFailure(prepared.error);
      }

      const uploadsDir = resolveUploadsDirectory(p2pCore.database);
      await mkdir(uploadsDir, { recursive: true });
      savedFilePath = await writeUploadAtomically(
        uploadsDir,
        prepared.fileName,
        prepared.bytes,
      );

      const canonicalPath = await realpath(savedFilePath);
      const savedFileStats = await stat(canonicalPath);
      if (!savedFileStats.isFile()) {
        throw new Error('Saved text upload is not a regular file');
      }

      const uploadsDirSizeBytes = await getFlatDirectorySize(uploadsDir);
      const finalFileName = basename(savedFilePath);
      log(`[IPC] Saved generated text upload: ${finalFileName} (${savedFileStats.size} bytes)`);

      return {
        success: true,
        filePath: savedFilePath,
        fileName: finalFileName,
        fileSize: savedFileStats.size,
        uploadsDirSizeBytes,
        error: null,
      };
    } catch (error) {
      if (savedFilePath) {
        try {
          await rm(savedFilePath, { force: true });
        } catch (cleanupError) {
          console.error('[IPC] Failed to remove incomplete text upload:', cleanupError);
        }
      }
      console.error('[IPC] Failed to save generated text upload:', error);
      return textUploadFailure(errStr(error, 'Failed to save generated text'));
    }
  });
}

/**
 * Chat handlers
 */
function setupChatHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_CHATS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, chats: [], error: 'P2P core not initialized' };
      }

      log('[IPC] Fetching chats from database...');
      const myPeerId = p2pCore.userIdentity.id;
      const chats = p2pCore.database.getAllChatsWithUsernameAndLastMsg(myPeerId);
      log(`[IPC] Found ${chats.length} chats`);

      return { success: true, chats, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get chats:', error);
      return { success: false, chats: [], error: errStr(error, 'Failed to get chats') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_CHATS, async (_event, query: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, chatIds: [], error: 'P2P core not initialized' };
      }

      const myPeerId = p2pCore.userIdentity.id;
      const chatIds = p2pCore.database.searchChats(query, myPeerId);
      return { success: true, chatIds, error: null };
    } catch (error) {
      console.error('[IPC] Failed to search chats:', error);
      return { success: false, chatIds: [], error: errStr(error, 'Failed to search chats') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_CHAT, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, chat: null, error: 'P2P core not initialized' };
      }

      log(`[IPC] Fetching chat by ID: ${chatId}`);
      const myPeerId = p2pCore.userIdentity.id;
      const chat = p2pCore.database.getChatByIdWithUsernameAndLastMsg(chatId, myPeerId);

      if (!chat) {
        return { success: false, chat: null, error: 'Chat not found' };
      }

      log(`[IPC] Found chat: ${chat.name}`);
      return { success: true, chat, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get chat:', error);
      return { success: false, chat: null, error: errStr(error, 'Failed to get chat') };
    }
  });
}

/**
 * Message handlers
 */
function setupMessageHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.GET_MESSAGES, async (_event, chatId: number, limit?: number, offset?: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, messages: [], error: 'P2P core not initialized' };
      }

      const messages = p2pCore.database.getMessagesByChatId(chatId, limit, offset);
      log(`[IPC] Fetched ${messages.length} messages for chat ${chatId} (limit=${limit ?? 'all'}, offset=${offset ?? 0})`);

      return { success: true, messages, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get messages:', error);
      return { success: false, messages: [], error: errStr(error, 'Failed to get messages') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_MESSAGE_JUMP_WINDOW, async (
    _event,
    chatId: number,
    clientMsgId: string,
  ) => {
    const empty = {
      status: 'not_found' as const,
      messages: [],
      hasMoreOlder: false,
    };
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, ...empty, error: 'P2P core not initialized' };
      }
      if (
        !Number.isInteger(chatId)
        || chatId <= 0
        || typeof clientMsgId !== 'string'
        || clientMsgId.length === 0
      ) {
        return { success: false, ...empty, error: 'Invalid message jump request' };
      }

      const result = p2pCore.database.getMessageJumpWindow(chatId, clientMsgId);
      return {
        success: true,
        status: result.status,
        messages: result.messages,
        hasMoreOlder: result.hasMoreOlder,
        error: null,
      };
    } catch (error) {
      console.error('[IPC] Failed to load message jump window:', error);
      return {
        success: false,
        ...empty,
        error: errStr(error, 'Failed to load message history'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_MESSAGE_PREVIEW_BY_CID, async (_event, chatId: number, clientMsgId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, preview: null, error: 'P2P core not initialized' };
      }
      const preview = p2pCore.database.getMessagePreviewByClientMsgId(chatId, clientMsgId);
      return { success: true, preview, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get message preview by cid:', error);
      return { success: false, preview: null, error: errStr(error, 'Failed to get message preview') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_MESSAGES_FOR_ME, async (_event, chatId: number, messageIds: string[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return {
          success: false,
          deletedCount: 0,
          latestRemaining: null,
          error: 'P2P core not initialized',
        };
      }
      if (!Array.isArray(messageIds)) {
        return {
          success: false,
          deletedCount: 0,
          latestRemaining: null,
          error: 'Invalid message selection',
        };
      }

      const result = p2pCore.database.deleteMessagesForMe(chatId, messageIds);
      p2pCore.messageHandler.discardDeletedMessageRetryState(messageIds);
      log(`[IPC] Deleted ${result.deletedCount} local message row(s) from chat ${chatId}`);
      return {
        success: true,
        deletedCount: result.deletedCount,
        latestRemaining: result.latestRemaining
          ? {
              content: result.latestRemaining.content,
              timestamp: result.latestRemaining.timestamp.getTime(),
              clientMsgId: result.latestRemaining.clientMsgId,
            }
          : null,
        error: null,
      };
    } catch (error) {
      console.error('[IPC] Failed to delete selected messages:', error);
      return {
        success: false,
        deletedCount: 0,
        latestRemaining: null,
        error: errStr(error, 'Failed to delete selected messages'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_MESSAGE_PINNED, async (
    _event,
    chatId: number,
    clientMsgId: string,
    pinned: boolean,
  ) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      if (!Number.isInteger(chatId) || chatId <= 0 || typeof clientMsgId !== 'string' || clientMsgId.length === 0) {
        return { success: false, error: 'Invalid pin request' };
      }

      const matched = p2pCore.database.setMessagePinned(chatId, clientMsgId, !!pinned);
      if (pinned && !matched) {
        return { success: false, error: 'Message not found' };
      }
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set message pin:', error);
      return { success: false, error: errStr(error, 'Failed to pin message') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_PINNED_MESSAGE, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, pinned: null, error: 'P2P core not initialized' };
      }
      const pinned = p2pCore.database.getPinnedMessage(chatId);
      return { success: true, pinned, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get pinned message:', error);
      return { success: false, pinned: null, error: errStr(error, 'Failed to get pinned message') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_CHAT_MESSAGES, async (
    _event,
    chatId: number,
    query: string,
    options?: {
      limit?: number;
      snapshotMaxRowid?: number;
      cursor?: { timestamp: number; rowid: number } | null;
    },
  ) => {
    const empty = { results: [], total: 0, snapshotMaxRowid: 0, nextCursor: null };
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, ...empty, error: 'P2P core not initialized' };
      }
      if (!Number.isInteger(chatId) || chatId <= 0 || typeof query !== 'string') {
        return { success: false, ...empty, error: 'Invalid search request' };
      }

      // Sanitize numeric options so NaN/Infinity/fractional values never reach SQL;
      // the DB layer clamps ranges but should not receive malformed numbers.
      const dbOptions: {
        limit?: number;
        snapshotMaxRowid?: number;
        cursor: { timestamp: number; rowid: number } | null;
      } = {
        cursor: options?.cursor
          && Number.isFinite(options.cursor.timestamp)
          && Number.isInteger(options.cursor.rowid)
          ? { timestamp: options.cursor.timestamp, rowid: options.cursor.rowid }
          : null,
      };
      if (Number.isFinite(options?.limit as number)) {
        dbOptions.limit = Math.trunc(options!.limit as number);
      }
      if (Number.isFinite(options?.snapshotMaxRowid as number)) {
        dbOptions.snapshotMaxRowid = Math.trunc(options!.snapshotMaxRowid as number);
      }

      const result = p2pCore.database.searchChatMessages(chatId, query, dbOptions);
      return {
        success: true,
        results: result.results,
        total: result.total,
        snapshotMaxRowid: result.snapshotMaxRowid,
        nextCursor: result.nextCursor,
        error: null,
      };
    } catch (error) {
      console.error('[IPC] Failed to search chat messages:', error);
      return {
        success: false,
        ...empty,
        error: errStr(error, 'Failed to search messages'),
      };
    }
  });
}

/**
 * Pending key exchange handlers
 */
function setupPendingKeyExchangeHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  ipcMain.handle(IPC_CHANNELS.CANCEL_PENDING_KEY_EXCHANGE, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Cancelling pending key exchange for peer: ${peerId}`);
      const cancelled = await p2pCore.messageHandler.getKeyExchange().cancelPendingKeyExchange(peerId);

      if (!cancelled) {
        return { success: false, error: 'No pending key exchange found' };
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to cancel pending key exchange:', error);
      return { success: false, error: errStr(error, 'Failed to cancel pending key exchange') };
    }
  });
}

/**
 * Generate cache key from chat IDs (sorted for consistency)
 */
function getOfflineCheckCacheKey(chatIds?: number[]): string {
  if (!chatIds || chatIds.length === 0) {
    return '__TOP_10__'; // Sentinel value for "check top 10"
  }
  return chatIds.slice().sort((a, b) => a - b).join(',');
}

/**
 * Offline message handlers
 */
function setupOfflineMessageHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  // Check offline messages for specific chats (or top 10 if no IDs provided)
  ipcMain.handle(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES, async (event, chatIds?: number[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, checkedChatIds: [], error: 'P2P core not initialized' };
      }

      const cacheKey = getOfflineCheckCacheKey(chatIds);

      // Check if there's already an in-flight request for this key
      const inFlightPromise = OfflineMessageManager.inFlightOfflineChecks.get(cacheKey);
      if (inFlightPromise) {
        log('[IPC] Request already in-flight, sharing promise');
        return await inFlightPromise;
      }

      event.sender.send(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_START, { chatIds: chatIds ?? [] });

      // Create and store the promise for this check
      const checkPromise = (async () => {
        try {
          const logMsg = chatIds
            ? `Checking offline messages for ${chatIds.length} specific chats...`
            : 'Checking offline messages for top 10 recent chats...';
          log(`[IPC] ${logMsg}`);

          const {checkedChatIds, unreadFromChats} = await p2pCore.messageHandler.checkOfflineMessages(chatIds);
          log(`[IPC] Offline message check complete - checked ${checkedChatIds.length} chats`);
          log(unreadFromChats);

          event.sender.send(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, { chatIds: checkedChatIds });

          const result = { success: true, checkedChatIds, unreadFromChats, error: null };

          return result;
        } finally {
          // Always clean up the in-flight promise when done
          OfflineMessageManager.inFlightOfflineChecks.delete(cacheKey);
        }
      })();

      // Store the promise before awaiting
      OfflineMessageManager.inFlightOfflineChecks.set(cacheKey, checkPromise);

      return await checkPromise;
    } catch (error) {
      console.error('[IPC] Failed to check offline messages:', error);
      return { success: false, checkedChatIds: [], unreadFromChats: new Map(), error: errStr(error, 'Failed to check offline messages') };
    }
  });

  // Check offline messages for a specific chat
  ipcMain.handle(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES_FOR_CHAT, async (event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, checkedChatIds: [], error: 'P2P core not initialized' };
      }

      const cacheKey = getOfflineCheckCacheKey([chatId]);

      // Check if there's already an in-flight request for this key
      const inFlightPromise = OfflineMessageManager.inFlightOfflineChecks.get(cacheKey);
      if (inFlightPromise) {
        log(`[IPC] Request already in-flight for chat ${chatId}, sharing promise`);
        return await inFlightPromise;
      }

      event.sender.send(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_START, { chatIds: [chatId] });

      // Create and store the promise for this check
      const checkPromise = (async () => {
        try {
          log(`[IPC] Checking offline messages for chat: ${chatId}`);
          const {checkedChatIds, unreadFromChats} = await p2pCore.messageHandler.checkOfflineMessages([chatId]);
          log(`[IPC] Offline message check complete for chat: ${chatId}`);

          event.sender.send(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, { chatIds: checkedChatIds });

          const result = { success: true, checkedChatIds, unreadFromChats, error: null };

          return result;
        } finally {
          // Always clean up the in-flight promise when done
          OfflineMessageManager.inFlightOfflineChecks.delete(cacheKey);
        }
      })();

      // Store the promise before awaiting
      OfflineMessageManager.inFlightOfflineChecks.set(cacheKey, checkPromise);

      return await checkPromise;
    } catch (error) {
      console.error(`[IPC] Failed to check offline messages for chat ${chatId}:`, error);
      return { success: false, checkedChatIds: [], unreadFromChats: new Map(), error: errStr(error, 'Failed to check offline messages') };
    }
  });
}
/**
 * Notification handlers
 */
function setupNotificationHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getMainWindow: () => BrowserWindow | null
): void {
  // Show desktop notification
  ipcMain.handle(IPC_CHANNELS.SHOW_NOTIFICATION, async (_event, options: {
    title: string;
    body: string;
    chatId?: number;
  }) => {
    try {
      const notification = new Notification({
        title: options.title,
        body: options.body,
      });

      // Handle notification click - focus window and navigate to chat
      notification.on('click', () => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          mainWindow.focus();

          // Send chat ID to renderer so it can navigate
          if (options.chatId) {
            mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATION_CLICKED, options.chatId);
          }
        }
      });

      notification.show();
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to show notification:', error);
      return { success: false, error: errStr(error, 'Failed to show notification') };
    }
  });

  // Check if window is focused
  ipcMain.handle(IPC_CHANNELS.IS_WINDOW_FOCUSED, async () => {
    const mainWindow = getMainWindow();
    return { focused: mainWindow?.isFocused() ?? false };
  });

  // Focus window
  ipcMain.handle(IPC_CHANNELS.FOCUS_WINDOW, async () => {
    try {
      const mainWindow = getMainWindow();
      if (mainWindow) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to focus window:', error);
      return { success: false, error: errStr(error, 'Failed to focus window') };
    }
  });
}

/**
 * Chat settings handlers
 */
function setupChatSettingsHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null,
  getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC_CHANNELS.TOGGLE_CHAT_MUTE, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, muted: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Toggling mute for chat: ${chatId}`);
      const muted = p2pCore.database.toggleChatMute(chatId);
      log(`[IPC] Chat ${chatId} muted status: ${muted}`);

      return { success: true, muted, error: null };
    } catch (error) {
      console.error('[IPC] Failed to toggle chat mute:', error);
      return { success: false, muted: false, error: errStr(error, 'Failed to toggle mute') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BLOCK_USER, async (_event, peerId: string, username: string | null, reason: string | null) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Blocking user: ${peerId}`);
      p2pCore.database.blockPeer(peerId, username, reason);
      await p2pCore.messageHandler.teardownBlockedPeer(peerId);
      notifyGroupCallPeerBlocked(getMainWindow, peerId);
      log(`[IPC] User ${peerId} blocked`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to block user:', error);
      return { success: false, error: errStr(error, 'Failed to block user') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UNBLOCK_USER, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Unblocking user: ${peerId}`);
      p2pCore.database.unblockPeer(peerId);
      log(`[IPC] User ${peerId} unblocked`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to unblock user:', error);
      return { success: false, error: errStr(error, 'Failed to unblock user') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.IS_USER_BLOCKED, async (_event, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, blocked: false, error: 'P2P core not initialized' };
      }

      const blocked = p2pCore.database.isBlocked(peerId);
      return { success: true, blocked, error: null };
    } catch (error) {
      console.error('[IPC] Failed to check if user is blocked:', error);
      return { success: false, blocked: false, error: errStr(error, 'Failed to check blocked status') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_USER_INFO, async (_event, peerId: string, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const user = p2pCore.database.getUserByPeerId(peerId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      const chat = p2pCore.database.getChatByIdWithUsernameAndLastMsg(chatId, p2pCore.userIdentity.id);
      const messageCount = p2pCore.database.getMessageCount(chatId);
      const blockedPeers = p2pCore.database.getBlockedPeers();
      const blockedInfo = blockedPeers.find(bp => bp.peer_id === peerId);

      return {
        success: true,
        userInfo: {
          username: user.username,
          peerId: user.peer_id,
          userSince: user.created_at,
          chatCreated: chat?.created_at,
          trustedOutOfBand: chat?.trusted_out_of_band || false,
          messageCount,
          muted: chat?.muted || false,
          blocked: !!blockedInfo,
          blockedAt: blockedInfo?.blocked_at,
          blockReason: blockedInfo?.reason,
        },
        error: null
      };
    } catch (error) {
      console.error('[IPC] Failed to get user info:', error);
      return { success: false, error: errStr(error, 'Failed to get user info') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_ALL_MESSAGES, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Deleting all messages for chat ${chatId}`);
      p2pCore.database.deleteAllMessagesForChat(chatId);
      log(`[IPC] All messages deleted for chat ${chatId}`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete all messages:', error);
      return { success: false, error: errStr(error, 'Failed to delete messages') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_CHAT, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const chat = p2pCore.database.getChatByIdWithUsernameAndLastMsg(chatId, p2pCore.userIdentity.id);
      if (chat?.type === 'group' && chat.group_id) {
        p2pCore.database.removePendingAcksForGroup(chat.group_id);
        p2pCore.database.removeInviteDeliveryAcksForMember(chat.group_id, p2pCore.userIdentity.id);
      }

      p2pCore.database.deleteChat(chatId);
      log(`[IPC] Chat ${chatId} deleted`);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete chat:', error);
      return { success: false, error: errStr(error, 'Failed to delete chat') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_CHAT_AND_USER, async (_event, chatId: number, userPeerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Deleting chat ${chatId}; user is removed only if no chats remain`);
      p2pCore.messageHandler.nudgePeerDirectSessionReset(userPeerId);
      p2pCore.database.deleteChatAndUser(chatId, userPeerId);
      try {
        p2pCore.messageHandler.getKeyExchange().deletePendingAcceptanceByPeerId(userPeerId);
        p2pCore.messageHandler.getSessionManager().clearSession(userPeerId);
        p2pCore.messageHandler.getSessionManager().removePendingKeyExchange(userPeerId);
      } catch (err) {
        console.error('[IPC] Failed to delete in memory data:', err);
      }
      log(`[IPC] Chat ${chatId} deleted`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete chat and user:', error);
      return { success: false, error: errStr(error, 'Failed to delete chat and user') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_USERNAME, async (_event, peerId: string, newUsername: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Updating username for ${peerId} to ${newUsername}`);
      p2pCore.database.updateUsername(peerId, newUsername);
      log(`[IPC] Username updated for ${peerId} to ${newUsername}`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete all messages:', error);
      return { success: false, error: errStr(error, 'Failed to delete messages') };
    }
  });

  // App-level settings
  ipcMain.handle(IPC_CHANNELS.GET_NETWORK_MODE, async () => {
    try {
      const mode = withSettingsDatabase(getP2PCore, (db) => db.getNetworkMode());
      return { success: true, mode, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get network mode:', error);
      return { success: false, mode: DEFAULT_NETWORK_MODE as NetworkMode, error: errStr(error, 'Failed to get network mode') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_NETWORK_MODE, async (_event, mode: NetworkMode) => {
    try {
      if (!isNetworkMode(mode)) {
        return { success: false, error: 'Invalid network mode' };
      }
      withSettingsDatabase(getP2PCore, (db) => {
        db.setNetworkMode(mode);
        db.setSetting(NETWORK_MODE_ONBOARDED_SETTING_KEY, 'true');
      });
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set network mode:', error);
      return { success: false, error: errStr(error, 'Failed to set network mode') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_INITIAL_SETUP_STATUS, async () => {
    try {
      const storedStatus = withSettingsDatabase(
        getP2PCore,
        (db) => db.getSetting(getInitialSetupStatusSettingKey(db.getNetworkMode())),
      );
      const status = isInitialSetupStatus(storedStatus) ? storedStatus : 'not_started';
      return { success: true, status, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get initial setup status:', error);
      return {
        success: false,
        status: 'not_started' as InitialSetupStatus,
        error: errStr(error, 'Failed to get initial setup status'),
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SET_INITIAL_SETUP_STATUS,
    async (_event, status: InitialSetupStatus) => {
      try {
        if (!isInitialSetupStatus(status)) {
          return { success: false, error: 'Invalid initial setup status' };
        }
        withSettingsDatabase(
          getP2PCore,
          (db) => db.setSetting(
            getInitialSetupStatusSettingKey(db.getNetworkMode()),
            status,
          ),
        );
        return { success: true, error: null };
      } catch (error) {
        console.error('[IPC] Failed to set initial setup status:', error);
        return { success: false, error: errStr(error, 'Failed to set initial setup status') };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.GET_NOTIFICATIONS_ENABLED, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, enabled: true, error: 'P2P core not initialized' };
      }

      const value = p2pCore.database.getSetting('notifications_enabled');
      // Default to true if not set
      const enabled = value === null ? true : value === 'true';
      log(`[IPC] Get notifications enabled: ${enabled}`);

      return { success: true, enabled, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get notifications enabled:', error);
      return { success: false, enabled: true, error: errStr(error, 'Failed to get setting') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_NOTIFICATIONS_ENABLED, async (_event, enabled: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Setting notifications enabled: ${enabled}`);
      p2pCore.database.setSetting('notifications_enabled', enabled.toString());
      log(`[IPC] Notifications enabled set to: ${enabled}`);

      // Notify all renderer processes about the change
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATIONS_ENABLED_CHANGED, enabled);
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set notifications enabled:', error);
      return { success: false, error: errStr(error, 'Failed to set setting') };
    }
  });

  // Downloads directory settings
  ipcMain.handle(IPC_CHANNELS.GET_DOWNLOADS_DIR, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, path: null, error: 'P2P core not initialized' };
      }

      const path = p2pCore.database.getSetting('downloads_directory');
      const downloadsPath = path || getDefaultDownloadsDirectory();

      log(`[IPC] Get downloads directory: ${downloadsPath}`);
      return { success: true, path: downloadsPath, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get downloads directory:', error);
      return { success: false, path: null, error: errStr(error, 'Failed to get setting') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_DOWNLOADS_DIR, async (_event, path: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Setting downloads directory: ${path}`);
      p2pCore.database.setSetting('downloads_directory', path);
      log(`[IPC] Downloads directory set to: ${path}`);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set downloads directory:', error);
      return { success: false, error: errStr(error, 'Failed to set setting') };
    }
  });

  // Tor settings
  ipcMain.handle(IPC_CHANNELS.GET_TOR_SETTINGS, async () => {
    try {
      const settings = withSettingsDatabase(getP2PCore, (db) => {
        const get = (key: string) => db.getSetting(key);
        const base = getTorConfig();
        const mode = db.getNetworkMode();
        const enabled = mode === NETWORK_MODES.ANONYMOUS;
        const socksHost = get('tor_socks_host');
        const socksPort = get('tor_socks_port');
        const connectionTimeout = get('tor_connection_timeout');
        const circuitTimeout = get('tor_circuit_timeout');
        const maxRetries = get('tor_max_retries');
        const healthCheckInterval = get('tor_health_check_interval');
        const dnsResolution = get('tor_dns_resolution');

        return {
          enabled: String(enabled),
          socksHost: socksHost ?? base.socksHost,
          socksPort: socksPort ?? String(base.socksPort),
          connectionTimeout: connectionTimeout ?? String(base.connectionTimeout),
          circuitTimeout: circuitTimeout ?? String(base.circuitTimeout),
          maxRetries: maxRetries ?? String(base.maxRetries),
          healthCheckInterval: healthCheckInterval ?? String(base.healthCheckInterval),
          dnsResolution: dnsResolution ?? base.dnsResolution
        };
      });

      return { success: true, settings, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get Tor settings:', error);
      return { success: false, settings: null, error: errStr(error, 'Failed to get Tor settings') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_TOR_SETTINGS, async (_event, settings: {
    enabled?: boolean;
    socksHost: string;
    socksPort: number;
    connectionTimeout: number;
    circuitTimeout: number;
    maxRetries: number;
    healthCheckInterval: number;
    dnsResolution: 'tor' | 'system';
  }) => {
    try {
      withSettingsDatabase(getP2PCore, (db) => {
        db.setSetting('tor_socks_host', settings.socksHost);
        db.setSetting('tor_socks_port', String(settings.socksPort));
        db.setSetting('tor_connection_timeout', String(settings.connectionTimeout));
        db.setSetting('tor_circuit_timeout', String(settings.circuitTimeout));
        db.setSetting('tor_max_retries', String(settings.maxRetries));
        db.setSetting('tor_health_check_interval', String(settings.healthCheckInterval));
        db.setSetting('tor_dns_resolution', settings.dnsResolution);
      });

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set Tor settings:', error);
      return { success: false, error: errStr(error, 'Failed to set Tor settings') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_ICE_SERVERS, async (): Promise<IceServersResponse> => {
    try {
      const servers = withSettingsDatabase(getP2PCore, (db) => getConfiguredIceServers(db));
      return {
        success: true,
        servers,
        error: null,
      };
    } catch (error) {
      console.error('[IPC] Failed to get ICE servers:', error);
      return {
        success: false,
        servers: [],
        error: errStr(error, 'Failed to get ICE servers'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_ICE_SERVERS, async (_event, servers: IceServerConfig[]) => {
    try {
      const normalizedServers = normalizeIceServers(servers);
      withSettingsDatabase(getP2PCore, (db) => {
        db.setSetting(WEBRTC_ICE_SERVERS_SETTING_KEY, JSON.stringify(normalizedServers));
      });

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set ICE servers:', error);
      return { success: false, error: errStr(error, 'Failed to save ICE servers') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_MISSING_ICE_WARNING_ACKNOWLEDGED, async () => {
    try {
      const acknowledged = withSettingsDatabase(
        getP2PCore,
        (db) => db.getSetting(FAST_MISSING_ICE_WARNING_ACKNOWLEDGED_SETTING_KEY) === 'true',
      );
      return { success: true, acknowledged, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get missing ICE warning acknowledgement:', error);
      return {
        success: false,
        acknowledged: false,
        error: errStr(error, 'Failed to get call setup warning preference'),
      };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SET_MISSING_ICE_WARNING_ACKNOWLEDGED,
    async (_event, acknowledged: boolean) => {
      try {
        if (typeof acknowledged !== 'boolean') {
          return { success: false, error: 'Invalid call setup warning preference' };
        }
        withSettingsDatabase(getP2PCore, (db) => {
          db.setSetting(
            FAST_MISSING_ICE_WARNING_ACKNOWLEDGED_SETTING_KEY,
            acknowledged ? 'true' : 'false',
          );
        });
        return { success: true, error: null };
      } catch (error) {
        console.error('[IPC] Failed to set missing ICE warning acknowledgement:', error);
        return {
          success: false,
          error: errStr(error, 'Failed to save call setup warning preference'),
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.GET_APP_CONFIG, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, config: null, error: 'P2P core not initialized' };
      }

      const db = p2pCore.database;
      const get = (key: string, defaultValue: string) => db.getSetting(key) ?? defaultValue;

      const config = {
        chatsToCheckForOfflineMessages: parseInt(get('chats_to_check_for_offline_messages', String(CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES)), 10),
        keyExchangeRateLimit: parseInt(get('key_exchange_rate_limit', String(KEY_EXCHANGE_RATE_LIMIT_DEFAULT)), 10),
        offlineMessageLimit: parseInt(get('offline_message_limit', String(OFFLINE_MESSAGE_LIMIT)), 10),
        maxFileSize: parseInt(get('max_file_size', String(MAX_FILE_SIZE)), 10),
        fileOfferRateLimit: parseInt(get('file_offer_rate_limit', String(FILE_OFFER_RATE_LIMIT)), 10),
        maxPendingFilesPerPeer: parseInt(get('max_pending_files_per_peer', String(MAX_PENDING_FILES_PER_PEER)), 10),
        maxPendingFilesTotal: parseInt(get('max_pending_files_total', String(MAX_PENDING_FILES_TOTAL)), 10),
        silentRejectionThresholdGlobal: parseInt(get('silent_rejection_threshold_global', String(SILENT_REJECTION_THRESHOLD_GLOBAL)), 10),
        silentRejectionThresholdPerPeer: parseInt(get('silent_rejection_threshold_per_peer', String(SILENT_REJECTION_THRESHOLD_PER_PEER)), 10),
      };

      return { success: true, config, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get app config:', error);
      return { success: false, config: null, error: errStr(error, 'Failed to get app config') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SET_APP_CONFIG, async (_event, config: AppConfig) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      // Validate and clamp values to sane ranges
      const validated = {
        chatsToCheckForOfflineMessages: Math.max(1, Math.min(50, config.chatsToCheckForOfflineMessages)),
        keyExchangeRateLimit: Math.max(1, Math.min(100, config.keyExchangeRateLimit)),
        offlineMessageLimit: Math.max(10, Math.min(500, config.offlineMessageLimit)),
        maxFileSize: Math.max(1 * 1024 * 1024, Math.min(512 * 1024 * 1024, config.maxFileSize)),
        fileOfferRateLimit: Math.max(1, Math.min(20, config.fileOfferRateLimit)),
        maxPendingFilesPerPeer: Math.max(1, Math.min(20, config.maxPendingFilesPerPeer)),
        maxPendingFilesTotal: Math.max(1, Math.min(50, config.maxPendingFilesTotal)),
        silentRejectionThresholdGlobal: Math.max(1, Math.min(100, config.silentRejectionThresholdGlobal)),
        silentRejectionThresholdPerPeer: Math.max(1, Math.min(50, config.silentRejectionThresholdPerPeer)),
      };

      const db = p2pCore.database;
      db.setSetting('chats_to_check_for_offline_messages', String(validated.chatsToCheckForOfflineMessages));
      db.setSetting('key_exchange_rate_limit', String(validated.keyExchangeRateLimit));
      db.setSetting('offline_message_limit', String(validated.offlineMessageLimit));
      db.setSetting('max_file_size', String(validated.maxFileSize));
      db.setSetting('file_offer_rate_limit', String(validated.fileOfferRateLimit));
      db.setSetting('max_pending_files_per_peer', String(validated.maxPendingFilesPerPeer));
      db.setSetting('max_pending_files_total', String(validated.maxPendingFilesTotal));
      db.setSetting('silent_rejection_threshold_global', String(validated.silentRejectionThresholdGlobal));
      db.setSetting('silent_rejection_threshold_per_peer', String(validated.silentRejectionThresholdPerPeer));

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to set app config:', error);
      return { success: false, error: errStr(error, 'Failed to set app config') };
    }
  });
}

/**
 * Group chat handlers
 */
function setupGroupHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  const buildGroupCreator = (p2pCore: P2PCore, username: string) => new GroupCreator({
    node: p2pCore.node,
    database: p2pCore.database,
    userIdentity: p2pCore.userIdentity,
    myPeerId: p2pCore.userIdentity.id,
    myUsername: username,
    nudgeGroupRefetch: (peerId, groupId) => p2pCore.messageHandler.nudgePeerGroupRefetch(peerId, groupId),
  });

  ipcMain.handle(IPC_CHANNELS.CHECK_GROUP_OFFLINE_MESSAGES, async (_event, chatIds?: number[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, checkedChatIds: [], failedChatIds: [], unreadFromChats: new Map(), gapWarnings: [], error: 'P2P core not initialized' };
      }

      const result = await p2pCore.messageHandler.checkGroupOfflineMessages(chatIds);
      return { success: true, ...result, error: null };
    } catch (error) {
      console.error('[IPC] Failed to check group offline messages:', error);
      return {
        success: false,
        checkedChatIds: [],
        failedChatIds: [],
        unreadFromChats: new Map(),
        gapWarnings: [],
        error: errStr(error, 'Failed to check group offline messages'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHECK_GROUP_OFFLINE_MESSAGES_FOR_CHAT, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, checkedChatIds: [], failedChatIds: [], unreadFromChats: new Map(), gapWarnings: [], error: 'P2P core not initialized' };
      }

      const result = await p2pCore.messageHandler.checkGroupOfflineMessages([chatId]);
      return { success: true, ...result, error: null };
    } catch (error) {
      console.error('[IPC] Failed to check group offline messages for chat:', error);
      return {
        success: false,
        checkedChatIds: [],
        failedChatIds: [],
        unreadFromChats: new Map(),
        gapWarnings: [],
        error: errStr(error, 'Failed to check group offline messages'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RETRY_GROUP_OFFLINE_BACKUP, async (_event, chatId: number, messageId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      log('retrying group offline backup', chatId, messageId);
      return await p2pCore.messageHandler.retryGroupOfflineBackup(chatId, messageId);
    } catch (error) {
      console.error('[IPC] Failed to retry group offline backup:', error);
      return { success: false, error: errStr(error, 'Failed to retry group offline backup') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_CONTACTS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, contacts: [], error: 'P2P core not initialized' };
      }

      const myPeerId = p2pCore.userIdentity.id;
      // Only return users who have an active direct chat (established pairwise keys)
      const chats = p2pCore.database.getAllChatsWithUsernames(myPeerId);
      const contacts = chats
        .filter(c => c.type === 'direct' && c.status === 'active')
        .map(c => {
          const participants = p2pCore.database.getChatParticipants(c.id);
          const otherParticipant = participants.find(p => p.peer_id !== myPeerId);
          if (!otherParticipant) return null;
          return { peerId: otherParticipant.peer_id, username: c.username || c.name };
        })
        .filter((c): c is { peerId: string; username: string } => c !== null);

      return { success: true, contacts, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get contacts:', error);
      return { success: false, contacts: [], error: errStr(error, 'Failed to get contacts') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.CREATE_GROUP, async (_event, groupName: string, peerIds: string[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, groupId: null, chatId: null, inviteDeliveries: [], error: 'P2P core not initialized' };
      }

      const username = p2pCore.usernameRegistry.getCurrentUsername();
      if (!username) {
        return { success: false, groupId: null, chatId: null, inviteDeliveries: [], error: 'No username registered' };
      }

      // Check for duplicate group name
      const existingGroup = p2pCore.database.getChatByName(groupName.trim(), 'group');
      if (existingGroup) {
        return { success: false, groupId: null, chatId: null, inviteDeliveries: [], error: `A group named "${groupName.trim()}" already exists` };
      }

      const creator = buildGroupCreator(p2pCore, username);

      const createResult = await creator.createGroup(groupName, peerIds);
      const { groupId, inviteDeliveries } = createResult;
      log(`[IPC] Group created: ${groupId}`);

      // Look up the chatId for the newly created group
      const chat = p2pCore.database.getChatByGroupId(groupId);
      const chatId = chat?.id ?? null;

      return { success: true, groupId, chatId, inviteDeliveries, error: null };
    } catch (error) {
      console.error('[IPC] Failed to create group:', error);
      return { success: false, groupId: null, chatId: null, inviteDeliveries: [], error: errStr(error, 'Failed to create group') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INVITE_USERS_TO_GROUP, async (_event, chatId: number, peerIds: string[]) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, inviteDeliveries: [], error: 'P2P core not initialized' };
      }

      const username = p2pCore.usernameRegistry.getCurrentUsername();
      if (!username) {
        return { success: false, inviteDeliveries: [], error: 'No username registered' };
      }

      const creator = buildGroupCreator(p2pCore, username);

      const inviteDeliveries = await creator.inviteUsersToExistingGroup(chatId, peerIds);
      log(`[IPC] Invited users to existing group chat=${chatId}`);
      return { success: true, inviteDeliveries, error: null };
    } catch (error) {
      console.error('[IPC] Failed to invite users to group:', error);
      return { success: false, inviteDeliveries: [], error: errStr(error, 'Failed to invite users to group') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.REINVITE_USER_TO_GROUP, async (_event, chatId: number, peerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, inviteDelivery: null, error: 'P2P core not initialized' };
      }

      const username = p2pCore.usernameRegistry.getCurrentUsername();
      if (!username) {
        return { success: false, inviteDelivery: null, error: 'No username registered' };
      }

      const creator = buildGroupCreator(p2pCore, username);
      const inviteDelivery = await creator.reinviteUserToExistingGroup(chatId, peerId);
      log(`[IPC] Re-invited user ${peerId} for group chat=${chatId}`);
      return { success: true, inviteDelivery, error: null };
    } catch (error) {
      console.error('[IPC] Failed to re-invite user to group:', error);
      return { success: false, inviteDelivery: null, error: errStr(error, 'Failed to re-invite user to group') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_GROUP_MEMBERS, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, members: [], error: 'P2P core not initialized' };
      }

      const myPeerId = p2pCore.userIdentity.id;
      const participants = p2pCore.database.getChatParticipants(chatId);
      const chat = p2pCore.database.getChatByIdWithUsernameAndLastMsg(chatId, myPeerId);
      const groupId = chat?.group_id;

      const pendingAcks = groupId ? p2pCore.database.getPendingAcksForGroup(groupId) : [];

      const members: Array<{ peerId: string; username: string; status: 'pending' | 'accepted' | 'confirmed' }> = [];
      const existingMemberPeerIds = new Set<string>();

      for (const participant of participants) {
        if (participant.peer_id === myPeerId) continue;
        existingMemberPeerIds.add(participant.peer_id);

        const user = p2pCore.database.getUserByPeerId(participant.peer_id);
        const username = user?.username || participant.peer_id;

        // Derive status from pending acks
        const hasInvitePending = pendingAcks.some(
          a => a.target_peer_id === participant.peer_id && a.message_type === 'GROUP_INVITE'
        );
        const hasWelcomePending = pendingAcks.some(
          a => a.target_peer_id === participant.peer_id && a.message_type === 'GROUP_WELCOME'
        );

        let status: 'pending' | 'accepted' | 'confirmed';
        if (hasInvitePending) {
          status = 'pending';
        } else if (hasWelcomePending) {
          status = 'accepted';
        } else {
          status = 'confirmed';
        }

        members.push({ peerId: participant.peer_id, username, status });
      }

      // Also expose invite targets not yet present in chat_participants,
      // so invite dialogs can filter them out up-front.
      for (const pendingAck of pendingAcks) {
        if (pendingAck.message_type !== 'GROUP_INVITE') continue;
        if (pendingAck.target_peer_id === myPeerId) continue;
        if (existingMemberPeerIds.has(pendingAck.target_peer_id)) continue;

        const user = p2pCore.database.getUserByPeerId(pendingAck.target_peer_id);
        members.push({
          peerId: pendingAck.target_peer_id,
          username: user?.username || pendingAck.target_peer_id,
          status: 'pending',
        });
        existingMemberPeerIds.add(pendingAck.target_peer_id);
      }

      return { success: true, members, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get group members:', error);
      return { success: false, members: [], error: errStr(error, 'Failed to get group members') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_GROUP_INVITES, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, invites: [], error: 'P2P core not initialized' };
      }

      const notifications = p2pCore.database.getPendingGroupInvitationNotifications();
      const invites = notifications
        .map(n => {
          try {
            const data = JSON.parse(n.notification_data) as {
              groupId: string;
              groupName: string;
              inviterPeerId: string;
              inviteId: string;
              expiresAt: number;
            };
            const inviter = p2pCore.database.getUserByPeerId(data.inviterPeerId);
            return {
              groupId: data.groupId,
              groupName: data.groupName,
              inviterPeerId: data.inviterPeerId,
              inviterUsername: inviter?.username || data.inviterPeerId,
              inviteId: data.inviteId,
              expiresAt: data.expiresAt,
            };
          } catch {
            return null;
          }
        })
        .filter((inv): inv is NonNullable<typeof inv> => inv !== null);

      return { success: true, invites, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get group invites:', error);
      return { success: false, invites: [], error: errStr(error, 'Failed to get group invites') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RESPOND_TO_GROUP_INVITE, async (_event, groupId: string, accept: boolean) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const username = p2pCore.usernameRegistry.getCurrentUsername();
      if (!username) {
        return { success: false, error: 'No username registered' };
      }

      const responder = new GroupResponder({
        node: p2pCore.node,
        database: p2pCore.database,
        userIdentity: p2pCore.userIdentity,
        myPeerId: p2pCore.userIdentity.id,
        myUsername: username,
        nudgeGroupRefetch: (peerId, groupId) => p2pCore.messageHandler.nudgePeerGroupRefetch(peerId, groupId),
      });

      await responder.respondToInvite(groupId, accept);
      log(`[IPC] Group invite response sent: ${accept ? 'accepted' : 'rejected'} for ${groupId}`);

      if (accept) {
        const acceptedChat = p2pCore.database.getChatByGroupId(groupId);
        const creatorPeerId = acceptedChat?.group_creator_peer_id ?? null;
        const creatorDirectChat = creatorPeerId ? p2pCore.database.getChatByPeerId(creatorPeerId) : null;

        if (creatorPeerId && creatorDirectChat) {
          const runAwaitingActivationFetch = async (phase: 'immediate' | 'retry_15s' | 'retry_60s') => {
            try {
              const beforeStatus = p2pCore.database.getChatByGroupId(groupId)?.group_status ?? 'missing';
              if (beforeStatus !== 'awaiting_activation') {
                log(
                  `[IPC][GROUP_ACCEPT][FETCH][SKIP] group=${groupId} phase=${phase} reason=status_${beforeStatus}`,
                );
                return;
              }

              log(
                `[IPC][GROUP_ACCEPT][FETCH][START] group=${groupId} phase=${phase} directChatId=${creatorDirectChat.id} creator=${creatorPeerId.slice(-8)}`,
              );
              const { checkedChatIds } = await p2pCore.messageHandler.checkOfflineMessages([creatorDirectChat.id]);
              const afterStatus = p2pCore.database.getChatByGroupId(groupId)?.group_status ?? 'missing';
              log(
                `[IPC][GROUP_ACCEPT][FETCH][DONE] group=${groupId} phase=${phase} checked=${checkedChatIds.length} status=${afterStatus}`,
              );
            } catch (error: unknown) {
              console.warn(
                `[IPC][GROUP_ACCEPT][FETCH][FAIL] group=${groupId} phase=${phase} error=${
                  errStr(error)
                }`,
              );
            }
          };

          void runAwaitingActivationFetch('immediate');
          setTimeout(() => {
            void runAwaitingActivationFetch('retry_15s');
          }, 15000);
          setTimeout(() => {
            void runAwaitingActivationFetch('retry_60s');
          }, 60000);
        } else {
          log(
            `[IPC][GROUP_ACCEPT][FETCH][SKIP] group=${groupId} reason=no_creator_direct_chat`,
          );
        }
      }

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to respond to group invite:', error);
      return { success: false, error: errStr(error, 'Failed to respond to group invite') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.REQUEST_GROUP_UPDATE, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      if (!Number.isInteger(chatId) || chatId <= 0) {
        return { success: false, error: 'Invalid group chat ID' };
      }

      await p2pCore.messageHandler.requestGroupUpdate(chatId);
      log(`[IPC] Requested group update for chat: ${chatId}`);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to request group update:', error);
      return { success: false, error: errStr(error, 'Failed to request group update') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LEAVE_GROUP, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      await p2pCore.messageHandler.leaveGroup(chatId);
      log(`[IPC] Left group chat: ${chatId}`);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to leave group:', error);
      return { success: false, error: errStr(error, 'Failed to leave group') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DISBAND_GROUP, async (_event, chatId: number) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      if (!Number.isInteger(chatId) || chatId <= 0) {
        return { success: false, error: 'Invalid group chat ID' };
      }

      await p2pCore.messageHandler.disbandGroup(chatId);
      log(`[IPC] Disbanded group chat: ${chatId}`);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to disband group:', error);
      return { success: false, error: errStr(error, 'Failed to disband group') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.KICK_GROUP_MEMBER, async (_event, chatId: number, targetPeerId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      if (!Number.isInteger(chatId) || chatId <= 0) {
        return { success: false, error: 'Invalid group chat ID' };
      }
      if (!targetPeerId) {
        return { success: false, error: 'Target peer ID is required' };
      }

      await p2pCore.messageHandler.kickGroupMember(chatId, targetPeerId);
      log(`[IPC] Kicked member ${targetPeerId} from group chat: ${chatId}`);
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to kick group member:', error);
      return { success: false, error: errStr(error, 'Failed to kick group member') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_SUBSCRIBED_TOPICS, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, topics: [], error: 'P2P core not initialized' };
      }

      const topics = p2pCore.node.services.pubsub.getTopics();
      log(
        `[GROUP-TOPIC][DEBUG][IPC] SUBSCRIBED_TOPICS count=${topics.length} topics=${topics.join(',') || 'none'}`,
      );
      return { success: true, topics, error: null };
    } catch (error) {
      console.error('[GROUP-TOPIC][DEBUG][IPC] Failed to get subscribed topics:', error);
      return { success: false, topics: [], error: errStr(error, 'Failed to get subscribed topics') };
    }
  });
}

function setupAppHandlers(ipcMain: IpcMainHandleRegistrar, getP2PCore: () => P2PCore | null): void {
  ipcMain.handle(IPC_CHANNELS.RESTART_APP, async () => {
    try {
      requestAppRestart();
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to restart app:', error);
      return { success: false, error: errStr(error, 'Failed to restart app') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.QUIT_APP, async () => {
    try {
      app.quit();
      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to quit app:', error);
      return { success: false, error: errStr(error, 'Failed to quit app') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_ACCOUNT_AND_DATA, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log('[IPC] Deleting all account data...');
      const uploadsDir = resolveUploadsDirectory(p2pCore.database);

      await p2pCore.database.wipeDatabase();

      try {
        await rm(uploadsDir, { recursive: true, force: true });
      } catch (error) {
        const cleanupError = errStr(error, 'Unknown filesystem error');
        console.error('[IPC] Account database was wiped, but pasted-image uploads could not be removed:', error);
        try {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Account deleted with cleanup error',
            message: 'Your account database was deleted, but pasted-image uploads could not be removed.',
            detail: `${uploadsDir}\n\n${cleanupError}`,
            buttons: ['Restart Kiyeovo'],
            defaultId: 0,
            noLink: true,
          });
        } catch (dialogError) {
          console.error('[IPC] Failed to show pasted-image cleanup error dialog:', dialogError);
        } finally {
          requestAppRestart();
        }
        return {
          success: false,
          error: `Account database was wiped, but pasted-image uploads could not be removed: ${cleanupError}`,
        };
      }

      log('[IPC] Database wiped. Restarting app...');

      requestAppRestart();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to delete account:', error);
      return { success: false, error: errStr(error, 'Failed to delete account') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.BACKUP_DATABASE, async (_event, backupPath: string, password: string) => {
    try {
      const grantedBackupPath = resolveGrantedDialogPath(backupPath);
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Backing up database to: ${grantedBackupPath}`);
      await p2pCore.database.backupEncrypted(grantedBackupPath, password);
      log('[IPC] Database backup completed');

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to backup database:', error);
      return { success: false, error: errStr(error, 'Failed to backup database') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RESTORE_DATABASE, async (_event, backupPath: string, password: string) => {
    try {
      const grantedBackupPath = resolveGrantedDialogPath(backupPath);
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Restoring database from: ${grantedBackupPath}`);
      await p2pCore.database.restoreEncrypted(grantedBackupPath, password);

      log('[IPC] Database restored. Restarting app...');

      requestAppRestart();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to restore database:', error);
      return { success: false, error: errStr(error, 'Failed to restore database') };
    }
  });

  ipcMain.handle(IPC_CHANNELS.RESTORE_DATABASE_FROM_FILE, async (_event, backupPath: string, password: string) => {
    try {
      const grantedBackupPath = resolveGrantedDialogPath(backupPath);
      const dataDir = ensureAppDataDir();
      const dbPath = join(dataDir, 'chat.db');

      log(`[IPC] Restoring database (no core) from: ${grantedBackupPath} -> ${dbPath}`);
      await ChatDatabase.restoreEncryptedAtPath(dbPath, grantedBackupPath, password);

      log('[IPC] Database restored. Restarting app...');
      requestAppRestart();

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to restore database from file:', error);
      return { success: false, error: errStr(error, 'Failed to restore database from file') };
    }
  });
}

/**
 * File transfer handlers
 */
function setupFileTransferHandlers(
  ipcMain: IpcMainHandleRegistrar,
  getP2PCore: () => P2PCore | null
): void {
  let pendingFileCapacityRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

  const senderCountDecreased = (before: PendingFileInboxSnapshot, after: PendingFileInboxSnapshot): boolean => {
    for (const beforeSender of before.senders) {
      const afterSender = after.senders.find((sender) => sender.senderPeerId === beforeSender.senderPeerId);
      if ((afterSender?.count ?? 0) < beforeSender.count) {
        return true;
      }
    }
    return false;
  };

  const schedulePendingFileCapacityRecovery = (): void => {
    if (pendingFileCapacityRecoveryTimer) {
      clearTimeout(pendingFileCapacityRecoveryTimer);
    }
    pendingFileCapacityRecoveryTimer = setTimeout(() => {
      pendingFileCapacityRecoveryTimer = null;
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return;
      }
      void (async () => {
        try {
          log('[IPC] Pending file capacity freed; checking group missed messages');
          const result = await p2pCore.messageHandler.checkGroupOfflineMessages();
          log(
            `[IPC] Pending file capacity recovery complete - checked ${result.checkedChatIds.length} group chats`,
          );
        } catch (error) {
          console.error('[IPC] Pending file capacity recovery failed:', error);
        }
      })();
    }, 1000);
  };

  const maybeSchedulePendingFileCapacityRecovery = (
    before: PendingFileInboxSnapshot,
    after: PendingFileInboxSnapshot,
  ): void => {
    if (!(before.full || before.hasFullSender || pendingFileCapacityRecoveryTimer)) {
      return;
    }
    if (after.total < before.total || senderCountDecreased(before, after)) {
      schedulePendingFileCapacityRecovery();
    }
  };

  // Send file
  ipcMain.handle(IPC_CHANNELS.SEND_FILE_REQUEST, async (_event, peerId: string, filePath: string, fileId?: string, replyToCid?: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Sending file ${filePath} to ${peerId}`);

      const user = p2pCore.database.getUserByPeerId(peerId);
      if (!user) {
        return { success: false, error: 'User not found' };
      }

      // Address by peer id, never username — usernames are not unique, so a
      // duplicate contact name can resolve to the wrong peer.
      await p2pCore.messageHandler.getFileHandler().sendFile(peerId, filePath, fileId, replyToCid);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to send file:', error);
      return { success: false, error: errStr(error, 'Failed to send file') };
    }
  });

  // Send file to a group chat
  ipcMain.handle(IPC_CHANNELS.SEND_GROUP_FILE_REQUEST, async (_event, chatId: number, filePath: string, fileId?: string, replyToCid?: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }
      if (!Number.isInteger(chatId) || chatId <= 0) {
        return { success: false, error: 'Invalid group chat' };
      }

      log(`[IPC] Sending file ${filePath} to group chat ${chatId}`);

      await p2pCore.messageHandler.getFileHandler().sendGroupFile(chatId, filePath, fileId, replyToCid);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to send group file:', error);
      return { success: false, error: errStr(error, 'Failed to send group file') };
    }
  });

  // Accept file
  ipcMain.handle(IPC_CHANNELS.ACCEPT_FILE, async (_event, fileId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Accepting file: ${fileId}`);
      const fileHandler = p2pCore.messageHandler.getFileHandler();
      const capacityBefore = fileHandler.getPendingFileInboxSnapshot();
      fileHandler.acceptPendingFile(fileId);
      const capacityAfter = fileHandler.getPendingFileInboxSnapshot();
      maybeSchedulePendingFileCapacityRecovery(capacityBefore, capacityAfter);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to accept file:', error);
      return { success: false, error: errStr(error, 'Failed to accept file') };
    }
  });

  // Reject file
  ipcMain.handle(IPC_CHANNELS.REJECT_FILE, async (_event, fileId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      log(`[IPC] Rejecting file: ${fileId}`);
      const fileHandler = p2pCore.messageHandler.getFileHandler();
      const capacityBefore = fileHandler.getPendingFileInboxSnapshot();
      const rejected = fileHandler.rejectPendingFile(fileId);
      if (!rejected) {
        return { success: false, error: 'Pending file offer not found' };
      }
      const capacityAfter = fileHandler.getPendingFileInboxSnapshot();
      maybeSchedulePendingFileCapacityRecovery(capacityBefore, capacityAfter);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to reject file:', error);
      return { success: false, error: errStr(error, 'Failed to reject file') };
    }
  });

  // Current pending file-offer capacity snapshot
  ipcMain.handle(IPC_CHANNELS.GET_PENDING_FILE_INBOX, async () => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, snapshot: null, error: 'P2P core not initialized' };
      }

      const snapshot = p2pCore.messageHandler.getFileHandler().getPendingFileInboxSnapshot();
      return { success: true, snapshot, error: null };
    } catch (error) {
      console.error('[IPC] Failed to get pending file inbox:', error);
      return { success: false, snapshot: null, error: errStr(error, 'Failed to get pending file inbox') };
    }
  });

  // Cancel active download
  ipcMain.handle(IPC_CHANNELS.CANCEL_FILE_DOWNLOAD, async (_event, fileId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: "P2P core not initialized" };
      }

      const canceled = await p2pCore.messageHandler.getFileHandler().cancelIncomingFileDownload(fileId);
      if (!canceled) {
        return { success: false, error: "No active incoming download found" };
      }

      return { success: true, error: null };
    } catch (error) {
      console.error("[IPC] Failed to cancel file download:", error);
      return { success: false, error: errStr(error, "Failed to cancel file download") };
    }
  });

  // Withdraw an outgoing, still-pending file offer
  ipcMain.handle(IPC_CHANNELS.CANCEL_FILE_OFFER, async (_event, fileId: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: "P2P core not initialized" };
      }

      const cancelled = await p2pCore.messageHandler.getFileHandler().cancelOutgoingFileOffer(fileId);
      if (!cancelled) {
        return { success: false, error: "Active outgoing file offer not found" };
      }

      return { success: true, error: null };
    } catch (error) {
      console.error("[IPC] Failed to cancel file offer:", error);
      return { success: false, error: errStr(error, "Failed to cancel file offer") };
    }
  });

  // Open file location
  ipcMain.handle(IPC_CHANNELS.OPEN_FILE_LOCATION, async (_event, filePath: string) => {
    try {
      const p2pCore = getP2PCore();
      if (!p2pCore) {
        return { success: false, error: 'P2P core not initialized' };
      }

      const fileLocationPath = await resolveOpenFileLocationPath({
        database: p2pCore.database,
        filePath,
        uploadsDir: resolveUploadsDirectory(p2pCore.database),
      });
      log(`[IPC] Opening file location: ${fileLocationPath}`);
      shell.showItemInFolder(fileLocationPath);

      return { success: true, error: null };
    } catch (error) {
      console.error('[IPC] Failed to open file location:', error);
      return { success: false, error: errStr(error, 'Failed to open file location') };
    }
  });
}
