import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc/channels.js';
import type {
    InitStatus,
    KeyExchangeEvent,
    MessageSentStatus,
    PasswordRequest,
    ContactRequestEvent,
    ContactRequestCancelledEvent,
    ChatCreatedEvent,
    KeyExchangeFailedEvent,
    MessageReceivedEvent,
    GroupChatActivatedEvent,
    GroupMembersUpdatedEvent,
    SendMessageResponse,
    GroupOfflineGapWarning,
    CallIncomingEvent,
    CallSignalReceivedEvent,
    CallStateChangedEvent,
    CallErrorEvent,
    CallSignalOutgoingInput,
    BootstrapRetryResponse,
    ConnectionNodesResponse,
    RelayRetryResponse,
    IceServerConfig,
    IceServersResponse,
    NetworkMode,
} from '../core/types.js';
import type { ContactAttempt, Message } from '../core/db/database.js';

contextBridge.exposeInMainWorld('kiyeovoAPI', {
    // Password authentication
    onPasswordRequest: (callback: (request: PasswordRequest) => void) => {
        const listener = (_event: any, request: PasswordRequest) => callback(request);
        ipcRenderer.on(IPC_CHANNELS.PASSWORD_REQUEST, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.PASSWORD_REQUEST, listener);
    },
    submitPassword: (password: string, rememberMe: boolean, useRecoveryPhrase?: boolean) => {
        ipcRenderer.send(IPC_CHANNELS.PASSWORD_RESPONSE, { password, rememberMe, useRecoveryPhrase });
    },

    // Initialization status
    onInitStatus: (callback: (status: InitStatus) => void) => {
        const listener = (_event: any, status: InitStatus) => callback(status);
        ipcRenderer.on(IPC_CHANNELS.INIT_STATUS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INIT_STATUS, listener);
    },
    onInitComplete: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on(IPC_CHANNELS.INIT_COMPLETE, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INIT_COMPLETE, listener);
    },
    onInitError: (callback: (error: string) => void) => {
        const listener = (_event: any, error: string) => callback(error);
        ipcRenderer.on(IPC_CHANNELS.INIT_ERROR, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.INIT_ERROR, listener);
    },
    getInitState: async (): Promise<{ initialized: boolean; initStarted: boolean; requiresNetworkModeSelection: boolean; status: InitStatus | null; error: string | null; pendingPasswordRequest?: PasswordRequest | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.INIT_STATE);
    },
    startInitialization: async (): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.INIT_START);
    },

    // DHT connection status
    onDHTConnectionStatus: (callback: (status: { connected: boolean | null }) => void) => {
        const listener = (_event: any, status: { connected: boolean | null }) => callback(status);
        ipcRenderer.on(IPC_CHANNELS.DHT_CONNECTION_STATUS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.DHT_CONNECTION_STATUS, listener);
    },
    getDHTConnectionStatus: async (): Promise<{ success: boolean; connected: boolean | null; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_DHT_CONNECTION_STATUS);
    },
    getNetworkMode: async (): Promise<{ success: boolean; mode: NetworkMode; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_NETWORK_MODE);
    },
    setNetworkMode: async (mode: NetworkMode): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_NETWORK_MODE, mode);
    },

    register: async (username: string, rememberMe: boolean): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REGISTER_REQUEST, username, rememberMe);
    },

    // Get current user state
    getUserState: async (): Promise<{ peerId: string | null; username: string | null; isRegistered: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_USER_STATE);
    },
    getLastUsername: async (): Promise<{ username: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_LAST_USERNAME);
    },
    attemptAutoRegister: async (): Promise<{ success: boolean; username: string | null; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ATTEMPT_AUTO_REGISTER);
    },

    // Auto-register setting
    getAutoRegister: async (): Promise<{ autoRegister: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_AUTO_REGISTER);
    },
    setAutoRegister: async (enabled: boolean): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_REGISTER, enabled);
    },

    onRestoreUsername: (callback: (username: string) => void) => {
        const listener = (_event: any, username: string) => callback(username);
        ipcRenderer.on(IPC_CHANNELS.RESTORE_USERNAME, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RESTORE_USERNAME, listener);
    },

    unregister: async (): Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.UNREGISTER_REQUEST);
    },

    // Send message
    sendMessage: async (identifier: string, message: string): Promise<{ success: boolean; messageSentStatus: MessageSentStatus; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SEND_MESSAGE_REQUEST, identifier, message);
    },
    sendGroupMessage: async (
        chatId: number,
        message: string,
        options?: { rekeyRetryHint?: boolean }
    ): Promise<SendMessageResponse> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SEND_GROUP_MESSAGE_REQUEST, chatId, message, options);
    },
    retryGroupOfflineBackup: async (chatId: number, messageId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RETRY_GROUP_OFFLINE_BACKUP, chatId, messageId);
    },

    // Call signaling
    startCall: async (
        peerId: string,
        callId: string,
        offerSdp: string,
        mediaType: 'audio' | 'video' = 'audio',
    ): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CALL_START, peerId, callId, offerSdp, mediaType);
    },
    acceptCall: async (peerId: string, callId: string, answerSdp: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CALL_ACCEPT, peerId, callId, answerSdp);
    },
    rejectCall: async (
        peerId: string,
        callId: string,
        reason?: 'rejected' | 'timeout' | 'offline' | 'policy'
    ): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CALL_REJECT, peerId, callId, reason);
    },
    hangupCall: async (
        peerId: string,
        callId: string,
        reason?: 'hangup' | 'disconnect' | 'failed'
    ): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CALL_HANGUP, peerId, callId, reason);
    },
    sendCallSignal: async (signal: CallSignalOutgoingInput): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CALL_SIGNAL_SEND, signal);
    },
    onCallIncoming: (callback: (data: CallIncomingEvent) => void) => {
        const listener = (_event: any, data: CallIncomingEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CALL_INCOMING, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CALL_INCOMING, listener);
    },
    onCallSignalReceived: (callback: (data: CallSignalReceivedEvent) => void) => {
        const listener = (_event: any, data: CallSignalReceivedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CALL_SIGNAL_RECEIVED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CALL_SIGNAL_RECEIVED, listener);
    },
    onCallStateChanged: (callback: (data: CallStateChangedEvent) => void) => {
        const listener = (_event: any, data: CallStateChangedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CALL_STATE_CHANGED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CALL_STATE_CHANGED, listener);
    },
    onCallError: (callback: (data: CallErrorEvent) => void) => {
        const listener = (_event: any, data: CallErrorEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CALL_ERROR, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CALL_ERROR, listener);
    },

    // Key exchange event
    onKeyExchangeSent: (callback: (data: KeyExchangeEvent) => void) => {
        const listener = (_event: any, data: KeyExchangeEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.KEY_EXCHANGE_SENT, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.KEY_EXCHANGE_SENT, listener);
    },

    // Contact request events
    onContactRequestReceived: (callback: (data: ContactRequestEvent) => void) => {
        const listener = (_event: any, data: ContactRequestEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, listener);
    },
    onContactRequestCancelled: (callback: (data: ContactRequestCancelledEvent) => void) => {
        const listener = (_event: any, data: ContactRequestCancelledEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CONTACT_REQUEST_CANCELLED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CONTACT_REQUEST_CANCELLED, listener);
    },
    acceptContactRequest: async (peerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ACCEPT_CONTACT_REQUEST, peerId);
    },
    rejectContactRequest: async (peerId: string, shouldBlock: boolean): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REJECT_CONTACT_REQUEST, peerId, shouldBlock);
    },

    // Bootstrap nodes
    getBootstrapNodes: async (): Promise<ConnectionNodesResponse> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_BOOTSTRAP_NODES);
    },
    retryBootstrap: async (): Promise<BootstrapRetryResponse> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RETRY_BOOTSTRAP);
    },
    retryRelays: async (): Promise<RelayRetryResponse> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RETRY_RELAYS);
    },
    getRelayStatus: async (): Promise<ConnectionNodesResponse> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_RELAY_STATUS);
    },
    addRelayNode: async (address: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ADD_RELAY_NODE, address);
    },
    removeRelayNode: async (address: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REMOVE_RELAY_NODE, address);
    },
    addBootstrapNode: async (address: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ADD_BOOTSTRAP_NODE, address);
    },
    removeBootstrapNode: async (address: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REMOVE_BOOTSTRAP_NODE, address);
    },
    reorderBootstrapNodes: async (addresses: string[]): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REORDER_BOOTSTRAP_NODES, addresses);
    },
    reorderRelayNodes: async (addresses: string[]): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REORDER_RELAY_NODES, addresses);
    },
    getIceServers: async (): Promise<IceServersResponse> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_ICE_SERVERS);
    },
    setIceServers: async (servers: IceServerConfig[]): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_ICE_SERVERS, servers);
    },

    // Contact attempts
    getContactAttempts: async (): Promise<{ success: boolean; contactAttempts: Array<ContactAttempt>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_CONTACT_ATTEMPTS);
    },

    // Trusted user import/export
    importTrustedUser: async (filePath: string, password: string, customName?: string): Promise<{
        success: boolean;
        error?: string;
        fingerprint?: string;
        chatId?: number;
        username?: string;
        peerId?: string;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.IMPORT_TRUSTED_USER, filePath, password, customName);
    },

    exportProfile: async (password: string, sharedSecret: string): Promise<{
        success: boolean;
        error?: string;
        filePath?: string;
        fingerprint?: string;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PROFILE, password, sharedSecret);
    },
    checkTrustedSecretReuse: async (sharedSecret: string): Promise<{
        success: boolean;
        isReused: boolean;
        count: number;
        error: string | null;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CHECK_TRUSTED_SECRET_REUSE, sharedSecret);
    },

    // File dialogs
    showOpenDialog: async (options: {
        title?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
        properties?: Array<'openFile' | 'openDirectory'>;
    }): Promise<{ filePath: string | null; canceled: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SHOW_OPEN_DIALOG, options);
    },
    getFileMetadata: async (filePath: string): Promise<{ success: boolean; name: string | null; size: number | null; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_FILE_METADATA, filePath);
    },

    showSaveDialog: async (options: {
        title?: string;
        defaultPath?: string;
        filters?: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ filePath: string | null; canceled: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SHOW_SAVE_DIALOG, options);
    },

    getTorSettings: async (): Promise<{
        success: boolean;
        settings: {
            enabled: string | null;
            socksHost: string | null;
            socksPort: string | null;
            connectionTimeout: string | null;
            circuitTimeout: string | null;
            maxRetries: string | null;
            healthCheckInterval: string | null;
            dnsResolution: string | null;
        } | null;
        error: string | null;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_TOR_SETTINGS);
    },

    setTorSettings: async (settings: {
        socksHost: string;
        socksPort: number;
        connectionTimeout: number;
        circuitTimeout: number;
        maxRetries: number;
        healthCheckInterval: number;
        dnsResolution: 'tor' | 'system';
    }): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_TOR_SETTINGS, settings);
    },

    getAppConfig: async (): Promise<{
        success: boolean;
        config: {
            chatsToCheckForOfflineMessages: number;
            keyExchangeRateLimit: number;
            offlineMessageLimit: number;
            maxFileSize: number;
            fileOfferRateLimit: number;
            maxPendingFilesPerPeer: number;
            maxPendingFilesTotal: number;
        } | null;
        error: string | null;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_APP_CONFIG);
    },

    setAppConfig: async (config: {
        chatsToCheckForOfflineMessages: number;
        keyExchangeRateLimit: number;
        offlineMessageLimit: number;
        maxFileSize: number;
        fileOfferRateLimit: number;
        maxPendingFilesPerPeer: number;
        maxPendingFilesTotal: number;
    }): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_APP_CONFIG, config);
    },

    restartApp: async (): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RESTART_APP);
    },
    quitApp: async (): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.QUIT_APP);
    },

    deleteAccountAndData: async (): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DELETE_ACCOUNT_AND_DATA);
    },

    backupDatabase: async (backupPath: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.BACKUP_DATABASE, backupPath);
    },

    restoreDatabase: async (backupPath: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RESTORE_DATABASE, backupPath);
    },
    restoreDatabaseFromFile: async (backupPath: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RESTORE_DATABASE_FROM_FILE, backupPath);
    },

    // Chat created event
    onChatCreated: (callback: (data: ChatCreatedEvent) => void) => {
        const listener = (_event: any, data: ChatCreatedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.CHAT_CREATED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_CREATED, listener);
    },

    // Group chat activated event (GROUP_WELCOME processed successfully on receiver side)
    onGroupChatActivated: (callback: (data: GroupChatActivatedEvent) => void) => {
        const listener = (_event: any, data: GroupChatActivatedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.GROUP_CHAT_ACTIVATED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.GROUP_CHAT_ACTIVATED, listener);
    },
    onGroupMembersUpdated: (callback: (data: GroupMembersUpdatedEvent) => void) => {
        const listener = (_event: any, data: GroupMembersUpdatedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.GROUP_MEMBERS_UPDATED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.GROUP_MEMBERS_UPDATED, listener);
    },

    onKeyExchangeFailed: (callback: (data: KeyExchangeFailedEvent) => void) => {
        const listener = (_event: any, data: KeyExchangeFailedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.KEY_EXCHANGE_FAILED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.KEY_EXCHANGE_FAILED, listener);
    },

    onMessageReceived: (callback: (data: MessageReceivedEvent) => void) => {
        const listener = (_event: any, data: MessageReceivedEvent) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.MESSAGE_RECEIVED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MESSAGE_RECEIVED, listener);
    },

    // Chats
    getChats: async (): Promise<{ success: boolean; chats: Array<any>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_CHATS);
    },
    getChatById: async (chatId: number): Promise<{ success: boolean; chat: any | null; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_CHAT, chatId);
    },
    searchChats: async (query: string): Promise<{ success: boolean; chatIds: number[]; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_CHATS, query);
    },

    // Messages
    getMessages: async (chatId: number, limit?: number, offset?: number): Promise<{ success: boolean; messages: Array<Message>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_MESSAGES, chatId, limit, offset);
    },

    // Pending key exchange events
    cancelPendingKeyExchange: async (peerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CANCEL_PENDING_KEY_EXCHANGE, peerId);
    },

    // Offline messages
    checkOfflineMessages: async (chatIds?: number[]): Promise<{ success: boolean; checkedChatIds: number[]; unreadFromChats: Map<number, number>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES, chatIds);
    },
    checkOfflineMessagesForChat: async (chatId: number): Promise<{ success: boolean; checkedChatIds: number[]; unreadFromChats: Map<number, number>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES_FOR_CHAT, chatId);
    },
    checkGroupOfflineMessages: async (chatIds?: number[]): Promise<{ success: boolean; checkedChatIds: number[]; failedChatIds: number[]; unreadFromChats: Map<number, number>; gapWarnings: GroupOfflineGapWarning[]; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CHECK_GROUP_OFFLINE_MESSAGES, chatIds);
    },
    checkGroupOfflineMessagesForChat: async (chatId: number): Promise<{ success: boolean; checkedChatIds: number[]; failedChatIds: number[]; unreadFromChats: Map<number, number>; gapWarnings: GroupOfflineGapWarning[]; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CHECK_GROUP_OFFLINE_MESSAGES_FOR_CHAT, chatId);
    },
    onOfflineMessagesFetchStart: (callback: (data: { chatIds: number[] }) => void) => {
        const listener = (_event: any, data: { chatIds: number[] }) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_START, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_START, listener);
    },
    onOfflineMessagesFetchComplete: (callback: (data: { chatIds: number[] }) => void) => {
        const listener = (_event: any, data: { chatIds: number[] }) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, listener);
    },

    // Notifications
    showNotification: async (options: { title: string; body: string; chatId?: number }): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SHOW_NOTIFICATION, options);
    },
    isWindowFocused: async (): Promise<{ focused: boolean }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.IS_WINDOW_FOCUSED);
    },
    focusWindow: async (): Promise<{ success: boolean; error?: string }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.FOCUS_WINDOW);
    },
    onNotificationClicked: (callback: (chatId: number) => void) => {
        const listener = (_event: any, chatId: number) => callback(chatId);
        ipcRenderer.on('notification:clicked', listener);
        return () => ipcRenderer.removeListener('notification:clicked', listener);
    },

    // Chat settings
    toggleChatMute: async (chatId: number): Promise<{ success: boolean; muted: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_CHAT_MUTE, chatId);
    },

    // User blocking
    blockUser: async (peerId: string, username: string | null, reason: string | null): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.BLOCK_USER, peerId, username, reason);
    },
    unblockUser: async (peerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.UNBLOCK_USER, peerId);
    },
    isUserBlocked: async (peerId: string): Promise<{ success: boolean; blocked: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.IS_USER_BLOCKED, peerId);
    },
    getUserInfo: async (peerId: string, chatId: number): Promise<{
        success: boolean;
        userInfo?: {
            username: string;
            peerId: string;
            userSince: Date;
            chatCreated?: Date;
            trustedOutOfBand: boolean;
            messageCount: number;
            muted: boolean;
            blocked: boolean;
            blockedAt?: Date;
            blockReason?: string | null;
        };
        error: string | null
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_USER_INFO, peerId, chatId);
    },

    // Chat operations
    deleteAllMessages: async (chatId: number): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DELETE_ALL_MESSAGES, chatId);
    },
    deleteChat: async (chatId: number): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DELETE_CHAT, chatId);
    },
    deleteChatAndUser: async (chatId: number, userPeerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DELETE_CHAT_AND_USER, chatId, userPeerId);
    },
    updateUsername: async (peerId: string, newUsername: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_USERNAME, peerId, newUsername);
    },

    // App settings
    getNotificationsEnabled: async (): Promise<{ success: boolean; enabled: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_NOTIFICATIONS_ENABLED);
    },
    setNotificationsEnabled: async (enabled: boolean): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_NOTIFICATIONS_ENABLED, enabled);
    },
    onNotificationsEnabledChanged: (callback: (enabled: boolean) => void) => {
        const listener = (_event: any, enabled: boolean) => callback(enabled);
        ipcRenderer.on(IPC_CHANNELS.NOTIFICATIONS_ENABLED_CHANGED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATIONS_ENABLED_CHANGED, listener);
    },
    getDownloadsDir: async (): Promise<{ success: boolean; path: string | null; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_DOWNLOADS_DIR);
    },
    setDownloadsDir: async (path: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SET_DOWNLOADS_DIR, path);
    },

    // File transfer
    sendFile: async (peerId: string, filePath: string, fileId?: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.SEND_FILE_REQUEST, peerId, filePath, fileId);
    },
    acceptFile: async (fileId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.ACCEPT_FILE, fileId);
    },
    rejectFile: async (fileId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REJECT_FILE, fileId);
    },
    cancelFileDownload: async (fileId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CANCEL_FILE_DOWNLOAD, fileId);
    },
    getPendingFiles: async (): Promise<{ success: boolean; files: Array<{ fileId: string; filename: string; size: number; senderId: string; senderUsername: string }>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_PENDING_FILES);
    },
    openFileLocation: async (filePath: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_LOCATION, filePath);
    },

    // Group chats
    getContacts: async (): Promise<{ success: boolean; contacts: Array<{ peerId: string; username: string }>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_CONTACTS);
    },
    createGroup: async (groupName: string, peerIds: string[]): Promise<{
        success: boolean;
        groupId: string | null;
        chatId: number | null;
        inviteDeliveries: Array<{ peerId: string; username: string; status: 'sent' | 'queued_for_retry'; reason?: string }>;
        error: string | null;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.CREATE_GROUP, groupName, peerIds);
    },
    inviteUsersToGroup: async (chatId: number, peerIds: string[]): Promise<{
        success: boolean;
        inviteDeliveries: Array<{ peerId: string; username: string; status: 'sent' | 'queued_for_retry'; reason?: string }>;
        error: string | null;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.INVITE_USERS_TO_GROUP, chatId, peerIds);
    },
    reinviteUserToGroup: async (chatId: number, peerId: string): Promise<{
        success: boolean;
        inviteDelivery: { peerId: string; username: string; status: 'sent' | 'queued_for_retry'; reason?: string } | null;
        error: string | null;
    }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REINVITE_USER_TO_GROUP, chatId, peerId);
    },
    getGroupMembers: async (chatId: number): Promise<{ success: boolean; members: Array<{ peerId: string; username: string; status: 'pending' | 'accepted' | 'confirmed' }>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_GROUP_MEMBERS, chatId);
    },
    getGroupInvites: async (): Promise<{ success: boolean; invites: Array<{ groupId: string; groupName: string; inviterPeerId: string; inviterUsername: string; inviteId: string; expiresAt: number }>; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_GROUP_INVITES);
    },
    respondToGroupInvite: async (groupId: string, accept: boolean): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.RESPOND_TO_GROUP_INVITE, groupId, accept);
    },
    requestGroupUpdate: async (chatId: number): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.REQUEST_GROUP_UPDATE, chatId);
    },
    leaveGroup: async (chatId: number): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.LEAVE_GROUP, chatId);
    },
    disbandGroup: async (chatId: number): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.DISBAND_GROUP, chatId);
    },
    kickGroupMember: async (chatId: number, targetPeerId: string): Promise<{ success: boolean; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.KICK_GROUP_MEMBER, chatId, targetPeerId);
    },
    getSubscribedTopics: async (): Promise<{ success: boolean; topics: string[]; error: string | null }> => {
        return ipcRenderer.invoke(IPC_CHANNELS.GET_SUBSCRIBED_TOPICS);
    },

    // File transfer events
    onFileTransferProgress: (callback: (data: any) => void) => {
        const listener = (_event: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.FILE_TRANSFER_PROGRESS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_TRANSFER_PROGRESS, listener);
    },
    onFileTransferComplete: (callback: (data: any) => void) => {
        const listener = (_event: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.FILE_TRANSFER_COMPLETE, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_TRANSFER_COMPLETE, listener);
    },
    onFileTransferFailed: (callback: (data: any) => void) => {
        const listener = (_event: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.FILE_TRANSFER_FAILED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_TRANSFER_FAILED, listener);
    },
    onOutgoingFileOfferPending: (callback: (data: any) => void) => {
        const listener = (_event: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.OUTGOING_FILE_OFFER_PENDING, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.OUTGOING_FILE_OFFER_PENDING, listener);
    },
    onPendingFileReceived: (callback: (data: any) => void) => {
        const listener = (_event: any, data: any) => callback(data);
        ipcRenderer.on(IPC_CHANNELS.PENDING_FILE_RECEIVED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.PENDING_FILE_RECEIVED, listener);
    },
});
