import { app, BrowserWindow, ipcMain, Menu, powerMonitor, session } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { isDev } from './util.js';
import {
  initializeP2PCore,
  InitStatus,
  IPC_CHANNELS,
  KeyExchangeEvent,
  type P2PCore,
  type ContactRequestEvent,
  type ContactRequestCancelledEvent,
  type ChatCreatedEvent,
  type KeyExchangeFailedEvent,
  type MessageReceivedEvent,
  type MessageSendStateChangedEvent,
  type OfflineInboxCapacityChangedEvent,
  type FileTransferProgressEvent,
  type FileTransferCompleteEvent,
  type FileTransferFailedEvent,
  type OutgoingFileOfferPendingEvent,
  type OutgoingFileOfferTerminalEvent,
  type PendingFileReceivedEvent,
  type GroupChatActivatedEvent,
  type GroupMembersUpdatedEvent,
  type TorConfig,
  type PasswordRequest,
  type CallIncomingEvent,
  type CallSignalReceivedEvent,
  type CallStateChangedEvent,
  type CallErrorEvent,
  type GroupCallControlSignalReceivedEvent,
  type GroupCallPairSignalReceivedEvent,
  type GroupCallStateChangedEvent,
  type GroupCallErrorEvent,
} from '../core/index.js';
import { DEFAULT_NETWORK_MODE, NETWORK_MODE_ONBOARDED_SETTING_KEY } from '../core/constants.js';
import { ensureAppDataDir } from '../core/utils/miscellaneous.js';
import { requestPasswordFromUI } from './password-prompt.js';
import { setupIPCHandlers } from './ipc-handlers.js';
import { TorManager, getTorBinaryPath, BUNDLED_TOR_SOCKS_PORT } from '../core/transport/tor-manager.js';
import { ChatDatabase } from '../core/db/database.js';
import type { NetworkMode } from '../core/types.js';
import { isDebugModeEnabled, log } from '../shared/logger.js';
import { errStr } from '../core/utils/general-error.js';
import { scheduleAppRelaunch } from './relaunch.js';
import { createTrustedIpcMainHandle } from './trusted-ipc.js';
import { applyWindowSecurityPolicies } from './window-security.js';
import { applySessionSecurityPolicies } from './session-security.js';
import { setupDisplayMediaPicker } from './display-media-picker.js';
import { DEV_SERVER_URL } from './constants.js';
import {
  getPackagedAppEntryUrl,
  registerAppProtocolHandler,
  registerMediaProtocolHandler,
  registerProtocolSchemes,
} from './app-protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temporary diagnostic: prefix all main-process console output with a timestamp. 
function installLogTimestamps(): void {
  if (!isDebugModeEnabled()) {
    return;
  }
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const ts = (): string => {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  console.log = (...args: unknown[]) => orig.log(`[${ts()}]`, ...args);
  console.warn = (...args: unknown[]) => orig.warn(`[${ts()}]`, ...args);
  console.error = (...args: unknown[]) => orig.error(`[${ts()}]`, ...args);
}
installLogTimestamps();

let mainWindow: BrowserWindow | null = null;
let p2pCore: P2PCore | null = null;
let wakeRecoverySeq = 0;
let torManager: TorManager | null = null;
let lastInitStatus: InitStatus | null = null;
let initError: string | null = null;
let isCoreInitialized = false;
let hasStartedInitialization = false;
let requiresNetworkModeSelection = false;
let pendingPasswordRequest: PasswordRequest | null = null;

registerProtocolSchemes();

// Enforce single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  log('[Electron] Another instance is already running. Exiting.');
  app.quit();
} else {
  // Focus existing window when second instance is attempted
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

// Window bounds persistence
interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function getWindowBoundsPath(): string {
  const dataDir = ensureAppDataDir();
  return path.join(dataDir, 'window-bounds.json');
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const boundsPath = getWindowBoundsPath();
    if (fs.existsSync(boundsPath)) {
      const data = fs.readFileSync(boundsPath, 'utf-8');
      return JSON.parse(data) as WindowBounds;
    }
  } catch (error) {
    console.error('[Electron] Failed to load window bounds:', error);
  }
  return null;
}

function saveWindowBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const data: WindowBounds = {
      ...bounds,
      isMaximized: win.isMaximized()
    };
    fs.writeFileSync(getWindowBoundsPath(), JSON.stringify(data));
  } catch (error) {
    console.error('[Electron] Failed to save window bounds:', error);
  }
}

function setupMinimalMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'quit' as const }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTextContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.length > 0;
    if (!params.isEditable && !hasSelection) {
      return;
    }

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      template.push(
        { role: 'undo' as const, enabled: params.editFlags.canUndo },
        { role: 'redo' as const, enabled: params.editFlags.canRedo },
        { type: 'separator' as const },
        { role: 'cut' as const, enabled: params.editFlags.canCut },
        { role: 'copy' as const, enabled: params.editFlags.canCopy },
        { role: 'paste' as const, enabled: params.editFlags.canPaste },
        { type: 'separator' as const },
        { role: 'selectAll' as const, enabled: params.editFlags.canSelectAll },
      );
    } else {
      template.push(
        { role: 'copy' as const, enabled: params.editFlags.canCopy || hasSelection },
        { type: 'separator' as const },
        { role: 'selectAll' as const },
      );
    }

    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function getWindowBrandingForMode(mode: NetworkMode): { title: string; icon: string } {
  const iconsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '..', '..', 'resources', 'icons');

  const fastIconPath = path.join(iconsDir, 'app-icon.png');
  if (mode !== 'anonymous') {
    return {
      title: 'Kiyeovo',
      icon: fastIconPath,
    };
  }

  const anonymousIconPath = path.join(iconsDir, 'app-icon-anonymous.png');
  return {
    title: 'Kiyeovo (anonymous)',
    icon: fs.existsSync(anonymousIconPath) ? anonymousIconPath : fastIconPath,
  };
}

function createMainWindow() {
  const savedBounds = loadWindowBounds();
  const startupNetworkMode = readPersistedNetworkMode();
  const branding = getWindowBrandingForMode(startupNetworkMode);
  const isDevelopment = isDev();
  const appEntryUrl = isDevelopment ? DEV_SERVER_URL : getPackagedAppEntryUrl();

  const win = new BrowserWindow({
    // Use saved bounds if available, otherwise Electron will use defaults (centered)
    ...(savedBounds && {
      width: savedBounds.width,
      height: savedBounds.height,
      x: savedBounds.x,
      y: savedBounds.y,
    }),
    minWidth: 880,
    minHeight: 600,
    autoHideMenuBar: true,
    title: branding.title,
    icon: branding.icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      autoplayPolicy: 'no-user-gesture-required',
    }
  });

  // Keep dock/taskbar branding aligned with the current network mode.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(branding.icon);
  }
  if (process.platform === 'linux') {
    // Some Linux DEs ignore constructor icon unless applied after creation.
    win.setIcon(branding.icon);
  }

  const enforceWindowTitle = () => {
    if (!win.isDestroyed()) {
      win.setTitle(branding.title);
    }
  };

  // Prevent renderer HTML <title> updates from overriding mode-aware native window title.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    enforceWindowTitle();
  });
  win.webContents.on('did-finish-load', enforceWindowTitle);
  applyWindowSecurityPolicies(win, { appEntryUrl, isDevelopment });
  setupTextContextMenu(win);

  // Restore maximized state or maximize on first run
  if (savedBounds?.isMaximized || !savedBounds) {
    win.maximize();
  }

  // Save bounds when window is resized, moved, or closed
  win.on('resize', () => saveWindowBounds(win));
  win.on('move', () => saveWindowBounds(win));
  win.on('close', () => saveWindowBounds(win));

  // Load UI
  if (isDevelopment) {
    win.loadURL(DEV_SERVER_URL);
    win.webContents.openDevTools(); // Auto-open DevTools in development
  } else {
    win.loadURL(appEntryUrl);
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function sendInitStatus(message: string, stage: InitStatus['stage']) {
  lastInitStatus = { message, stage };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.INIT_STATUS, { message, stage });
  }
}

function sendDHTConnectionStatus(status: { connected: boolean | null }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Sending DHT connection status: ${status.connected}`);
    log(`[DHT-STATUS][ELECTRON][EMIT] connected=${status.connected}`);
    mainWindow.webContents.send(IPC_CHANNELS.DHT_CONNECTION_STATUS, status);
  }
}

function sendWakeRecoveryStarted(data: { token: number; deadlineAt: number; trigger: string }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.WAKE_RECOVERY_STARTED, data);
  }
}

function sendWakeRecoveryReconnectSettled(data: { token: number }) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.WAKE_RECOVERY_RECONNECT_SETTLED, data);
  }
}

function sendKeyExchangeSent(data: KeyExchangeEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Key exchange sent to ${data.username}`);
    mainWindow.webContents.send(IPC_CHANNELS.KEY_EXCHANGE_SENT, data);
  }
}

function sendContactRequestReceived(data: ContactRequestEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Contact request received from ${data.username}`);
    mainWindow.webContents.send(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, data);
  }
}

function sendContactRequestCancelled(data: ContactRequestCancelledEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Contact request cancelled by ${data.username}`);
    mainWindow.webContents.send(IPC_CHANNELS.CONTACT_REQUEST_CANCELLED, data);
  }
}

function sendBootstrapNodes(nodes: string[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Sending bootstrap nodes: ${nodes}`);
    mainWindow.webContents.send(IPC_CHANNELS.BOOTSTRAP_NODES, nodes);
  }
}

function sendChatCreated(data: ChatCreatedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Chat created for ${data.username} (chatId: ${data.chatId})`);
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_CREATED, data);
  }
}

function sendKeyExchangeFailed(data: KeyExchangeFailedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Key exchange failed with ${data.username}: ${data.error}`);
    mainWindow.webContents.send(IPC_CHANNELS.KEY_EXCHANGE_FAILED, data);
  }
}

function sendMessageReceived(data: MessageReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Message received in chat ${data.chatId} from ${data.senderUsername}`);
    mainWindow.webContents.send(IPC_CHANNELS.MESSAGE_RECEIVED, data);
  }
}

function sendMessageSendStateChanged(data: MessageSendStateChangedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.MESSAGE_SEND_STATE_CHANGED, data);
  }
}

function sendOfflineInboxCapacityChanged(data: OfflineInboxCapacityChangedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.OFFLINE_INBOX_CAPACITY_CHANGED, data);
  }
}

function sendRestoreUsername(username: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Restore username: ${username}`);
    mainWindow.webContents.send(IPC_CHANNELS.RESTORE_USERNAME, username);
  }
}

function sendFileTransferProgress(data: FileTransferProgressEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] File transfer progress: ${data.current}/${data.total} for ${data.filename}`);
    mainWindow.webContents.send(IPC_CHANNELS.FILE_TRANSFER_PROGRESS, data);
  }
}

function sendFileTransferComplete(data: FileTransferCompleteEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] File transfer complete: ${data.filePath}`);
    mainWindow.webContents.send(IPC_CHANNELS.FILE_TRANSFER_COMPLETE, data);
  }
}

function sendFileTransferFailed(data: FileTransferFailedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] File transfer failed: ${data.error}`);
    mainWindow.webContents.send(IPC_CHANNELS.FILE_TRANSFER_FAILED, data);
  }
}

function sendOutgoingFileOfferPending(data: OutgoingFileOfferPendingEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Outgoing file offer pending: ${data.messageId}`);
    mainWindow.webContents.send(IPC_CHANNELS.OUTGOING_FILE_OFFER_PENDING, data);
  }
}

function sendOutgoingFileOfferTerminal(data: OutgoingFileOfferTerminalEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Outgoing file offer terminal: ${data.messageId} status=${data.status}`);
    mainWindow.webContents.send(IPC_CHANNELS.OUTGOING_FILE_OFFER_TERMINAL, data);
  }
}

function sendPendingFileReceived(data: PendingFileReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Pending file received: ${data.filename} from ${data.senderUsername}`);
    mainWindow.webContents.send(IPC_CHANNELS.PENDING_FILE_RECEIVED, data);
  }
}

function sendGroupChatActivated(data: GroupChatActivatedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Group chat activated: chatId=${data.chatId}`);
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_CHAT_ACTIVATED, data);
  }
}

function sendGroupMembersUpdated(data: GroupMembersUpdatedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    log(`[Electron] Group members updated: chatId=${data.chatId}, member=${data.memberPeerId}`);
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_MEMBERS_UPDATED, data);
  }
}

function sendOfflineMessagesFetchComplete(chatIds: number[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, { chatIds });
  }
}

function sendCallIncoming(data: CallIncomingEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.CALL_INCOMING, data);
  }
}

function sendCallSignalReceived(data: CallSignalReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.CALL_SIGNAL_RECEIVED, data);
  }
}

function sendCallStateChanged(data: CallStateChangedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.CALL_STATE_CHANGED, data);
  }
}

function sendCallError(data: CallErrorEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.CALL_ERROR, data);
  }
}

function sendGroupCallControlSignalReceived(data: GroupCallControlSignalReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_CALL_CONTROL_SIGNAL_RECEIVED, data);
  }
}

function sendGroupCallPairSignalReceived(data: GroupCallPairSignalReceivedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_CALL_PAIR_SIGNAL_RECEIVED, data);
  }
}

function sendGroupCallStateChanged(data: GroupCallStateChangedEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_CALL_STATE_CHANGED, data);
  }
}

function sendGroupCallError(data: GroupCallErrorEvent) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.GROUP_CALL_ERROR, data);
  }
}

function detectRequiresNetworkModeSelection(): boolean {
  try {
    const dbPath = path.join(ensureAppDataDir(), 'chat.db');
    const db = new ChatDatabase(dbPath);
    try {
      // Ensure mode exists (self-heals invalid/missing).
      db.getNetworkMode();
      const onboarded = db.getSetting(NETWORK_MODE_ONBOARDED_SETTING_KEY) === 'true';
      return !onboarded;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[Electron] Failed to check network mode onboarding state:', error);
    // Fail-open to avoid blocking users if settings check fails.
    return false;
  }
}

function readPersistedNetworkMode(): NetworkMode {
  try {
    const dbPath = path.join(ensureAppDataDir(), 'chat.db');
    const db = new ChatDatabase(dbPath);
    try {
      return db.getNetworkMode();
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('[Electron] Failed to read persisted network mode, using default:', error);
    return DEFAULT_NETWORK_MODE;
  }
}

function startP2PInitialization(): void {
  if (hasStartedInitialization || isCoreInitialized) {
    return;
  }
  hasStartedInitialization = true;
  requiresNetworkModeSelection = false;
  void initializeP2PAfterWindow();
}

async function initializeP2PAfterWindow() {
  try {
    if (!mainWindow) {
      throw new Error('Main window not created');
    }

    log('[Electron] Starting P2P initialization...');

    const dataDir = ensureAppDataDir();
    log(`[Electron] Data directory: ${dataDir}`);
    const startupNetworkMode = readPersistedNetworkMode();
    log(`[CONFIG][ELECTRON] startup_mode=${startupNetworkMode}`);
    log(`[CONFIG][ELECTRON] tor_bootstrap=${startupNetworkMode === 'anonymous' ? 'enabled' : 'disabled'}`);

    const libp2pPort = 9001;
    let torConfig: TorConfig | undefined;

    if (startupNetworkMode === 'anonymous') {
      // Start bundled Tor for anonymous mode only.
      sendInitStatus('Starting Tor daemon...', 'tor');
      try {
        const torBinaryPath = getTorBinaryPath(
          process.resourcesPath,
          app.getAppPath(),
          app.isPackaged
        );

        torManager = new TorManager({
          dataDir,
          libp2pPort,
          torBinaryPath,
          onStatus: (message, stage) => {
            log(`[TorManager] ${message}`);
            sendInitStatus(message, 'tor');
          },
        });

        const onionAddress = await torManager.start();
        if (!onionAddress) {
          throw new Error('Tor started without onion address');
        }
        log(`[Electron] Tor started with onion address: ${onionAddress}`);

        torConfig = {
          enabled: true,
          socksPort: BUNDLED_TOR_SOCKS_PORT,
          onionAddress,
        };
      } catch (torError) {
        console.error('[Electron] Failed to start Tor:', torError);
        sendInitStatus('Tor failed to start. Anonymous mode cannot continue.', 'tor');
        if (torManager) {
          try {
            await torManager.stop();
          } catch (stopError) {
            console.error('[Electron] Failed to stop Tor after startup error:', stopError);
          } finally {
            torManager = null;
          }
        }
        throw new Error('Anonymous mode requires Tor startup. Initialization aborted.');
      }
    } else {
      sendInitStatus('Fast mode selected: skipping Tor daemon startup.', 'tor');
    }

    sendInitStatus('Getting data directory...', 'database');

    // Initialize P2P core with custom password prompt
    const p2pCoreConfig = {
      dataDir,
      port: libp2pPort,
      ...(torConfig ? { torConfig } : {}),
      passwordPrompt: async (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => {
        log('[Electron] Requesting password from UI...');
        const response = await requestPasswordFromUI(
          mainWindow!,
          prompt,
          isNew,
          recoveryPhrase,
          prefilledPassword,
          errorMessage,
          cooldownSeconds,
          showRecoveryOption,
          keychainAvailable,
          (request) => {
            pendingPasswordRequest = request;
          }
        );
        return response;
      },
      onStatus: (message: string, stage: InitStatus['stage']) => {
        log(`[Core] ${message}`);
        sendInitStatus(message, stage);
      },
      onDHTConnectionStatus: (status: { connected: boolean | null }) => {
        log(`[Electron] DHT connection status: ${String(status.connected)}`);
        sendDHTConnectionStatus(status);
      },
      onKeyExchangeSent: (data: KeyExchangeEvent) => {
        sendKeyExchangeSent(data);
      },
      onContactRequestReceived: (data: ContactRequestEvent) => {
        sendContactRequestReceived(data);
      },
      onContactRequestCancelled: (data: ContactRequestCancelledEvent) => {
        sendContactRequestCancelled(data);
      },
      onBootstrapNodes: (nodes: string[]) => {
        sendBootstrapNodes(nodes);
      },
      onChatCreated: (data: ChatCreatedEvent) => {
        sendChatCreated(data);
      },
      onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => {
        sendKeyExchangeFailed(data);
      },
      onMessageReceived: (data: MessageReceivedEvent) => {
        sendMessageReceived(data);
      },
      onMessageSendStateChanged: (data: MessageSendStateChangedEvent) => {
        sendMessageSendStateChanged(data);
      },
      onOfflineInboxCapacityChanged: (data: OfflineInboxCapacityChangedEvent) => {
        sendOfflineInboxCapacityChanged(data);
      },
      onRestoreUsername: (username: string) => {
        sendRestoreUsername(username);
      },
      onFileTransferProgress: (data: FileTransferProgressEvent) => {
        sendFileTransferProgress(data);
      },
      onFileTransferComplete: (data: FileTransferCompleteEvent) => {
        sendFileTransferComplete(data);
      },
      onFileTransferFailed: (data: FileTransferFailedEvent) => {
        sendFileTransferFailed(data);
      },
      onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => {
        sendOutgoingFileOfferPending(data);
      },
      onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => {
        sendOutgoingFileOfferTerminal(data);
      },
      onPendingFileReceived: (data: PendingFileReceivedEvent) => {
        sendPendingFileReceived(data);
      },
      onGroupChatActivated: (data: GroupChatActivatedEvent) => {
        sendGroupChatActivated(data);
      },
      onGroupMembersUpdated: (data: GroupMembersUpdatedEvent) => {
        sendGroupMembersUpdated(data);
      },
      onOfflineMessagesFetchComplete: (chatIds: number[]) => {
        sendOfflineMessagesFetchComplete(chatIds);
      },
      onCallIncoming: (data: CallIncomingEvent) => {
        sendCallIncoming(data);
      },
      onCallSignalReceived: (data: CallSignalReceivedEvent) => {
        sendCallSignalReceived(data);
      },
      onCallStateChanged: (data: CallStateChangedEvent) => {
        sendCallStateChanged(data);
      },
      onCallError: (data: CallErrorEvent) => {
        sendCallError(data);
      },
      onGroupCallControlSignalReceived: (data: GroupCallControlSignalReceivedEvent) => {
        sendGroupCallControlSignalReceived(data);
      },
      onGroupCallPairSignalReceived: (data: GroupCallPairSignalReceivedEvent) => {
        sendGroupCallPairSignalReceived(data);
      },
      onGroupCallStateChanged: (data: GroupCallStateChangedEvent) => {
        sendGroupCallStateChanged(data);
      },
      onGroupCallError: (data: GroupCallErrorEvent) => {
        sendGroupCallError(data);
      },
    };
    p2pCore = await initializeP2PCore(p2pCoreConfig);

    log('[Electron] P2P core initialized successfully');
    sendInitStatus('P2P node ready!', 'complete');
    isCoreInitialized = true;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.INIT_COMPLETE);
    }

  } catch (error) {
    console.error('[Electron] Failed to initialize P2P core:', error);
    const errorMessage = errStr(error, 'Unknown error');
    initError = errorMessage;
    hasStartedInitialization = false;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.INIT_ERROR, errorMessage);
    }
  }
}

async function initializeApp() {
  try {
    log('[Electron] Starting Kiyeovo...');
    const trustedIpcMain = createTrustedIpcMainHandle(ipcMain, () => mainWindow);
    const isDevelopment = isDev();
    const appEntryUrl = isDevelopment ? DEV_SERVER_URL : getPackagedAppEntryUrl();

    // Setup minimal menu (keeps keyboard shortcuts working)
    setupMinimalMenu();

    if (!isDevelopment) {
      registerAppProtocolHandler();
    }
    registerMediaProtocolHandler();

    const displayMediaPicker = setupDisplayMediaPicker(trustedIpcMain, () => mainWindow);

    applySessionSecurityPolicies(session.defaultSession, {
      appEntryUrl,
      isDevelopment,
      getMainWindow: () => mainWindow,
      selectDisplayMediaSource: displayMediaPicker.selectDisplayMediaSource,
    });

    // Setup IPC handlers
    setupIPCHandlers(ipcMain, () => p2pCore, () => mainWindow);
    log('[Electron] IPC handlers registered');

    // OS wake/unlock
    const handlePowerResume = (trigger: string) => {
      if (!p2pCore) {
        return;
      }
      p2pCore.messageHandler.notePowerResume();
      const token = ++wakeRecoverySeq;
      sendWakeRecoveryStarted({
        token,
        deadlineAt: Date.now() + 30_000,
        trigger,
      });
      log(`[Electron][POWER] ${trigger} - forcing immediate reconnect`);
      void p2pCore.requestImmediateReconnect()
        .catch((error) => {
          console.warn(`[Electron][POWER] reconnect after ${trigger} failed:`, errStr(error));
        })
        .finally(() => {
          sendWakeRecoveryReconnectSettled({ token });
        });
    };
    powerMonitor.on('resume', () => handlePowerResume('resume'));
    powerMonitor.on('unlock-screen', () => handlePowerResume('unlock-screen'));
    trustedIpcMain.handle(IPC_CHANNELS.INIT_STATE, () => {
      return {
        initialized: isCoreInitialized,
        initStarted: hasStartedInitialization,
        requiresNetworkModeSelection,
        status: lastInitStatus,
        error: initError,
        pendingPasswordRequest,
      };
    });
    trustedIpcMain.handle(IPC_CHANNELS.INIT_START, async () => {
      try {
        if (isCoreInitialized) {
          return { success: true, error: null };
        }
        if (!mainWindow || mainWindow.isDestroyed()) {
          return { success: false, error: 'Main window not ready' };
        }
        startP2PInitialization();
        return { success: true, error: null };
      } catch (error) {
        return { success: false, error: errStr(error, 'Failed to start initialization') };
      }
    });

    // Create window first
    mainWindow = createMainWindow();
    log('[Electron] Main window created');

    // Wait for the window to be ready
    mainWindow.webContents.once('did-finish-load', () => {
      requiresNetworkModeSelection = detectRequiresNetworkModeSelection();
      if (requiresNetworkModeSelection) {
        log('[Electron] Window loaded, waiting for network mode selection before initialization...');
        sendInitStatus('Select Fast or Anonymous mode to continue', 'database');
        return;
      }
      log('[Electron] Window loaded, starting P2P initialization...');
      startP2PInitialization();
    });
    mainWindow.webContents.on('did-finish-load', () => {
      if (pendingPasswordRequest && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.PASSWORD_REQUEST, pendingPasswordRequest);
      }
    });

  } catch (error) {
    console.error('[Electron] Failed to initialize application:', error);
    app.quit();
  }
}

app.whenReady().then(async () => {
  await initializeApp();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Handle app activation (macOS)
app.on('activate', () => {
  if (mainWindow === null && p2pCore !== null) {
    mainWindow = createMainWindow();
  }
});

// Graceful shutdown
app.on('before-quit', async (event) => {
  if (p2pCore || torManager) {
    event.preventDefault();

    // Shutdown P2P core first
    if (p2pCore) {
      log('[Electron] Shutting down P2P core...');
      try {
        await p2pCore.cleanup();
        log('[Electron] P2P core shutdown complete');
      } catch (error) {
        console.error('[Electron] Error during P2P shutdown:', error);
      } finally {
        p2pCore = null;
      }
    }

    // Then shutdown Tor
    if (torManager) {
      log('[Electron] Shutting down Tor daemon...');
      try {
        await torManager.stop();
        log('[Electron] Tor daemon shutdown complete');
      } catch (error) {
        console.error('[Electron] Error during Tor shutdown:', error);
      } finally {
        torManager = null;
      }
    }

    const restartRequested = Boolean((app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested);
    if (restartRequested) {
      (app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested = false;
      scheduleAppRelaunch();
    }

    app.exit(0);
    return;
  }

  const restartRequested = Boolean((app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested);
  if (restartRequested) {
    (app as typeof app & { __kiyeovoRestartRequested?: boolean }).__kiyeovoRestartRequested = false;
    scheduleAppRelaunch();
    app.exit(0);
    return;
  }
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('[Electron] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error: Error) => {
  console.error('[Electron] Uncaught Exception:', error);
});
