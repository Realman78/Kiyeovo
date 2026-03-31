import type {
    ContactRequestEvent,
    ContactRequestCancelledEvent,
    ChatCreatedEvent,
    KeyExchangeFailedEvent,
    InitStatus,
    PasswordRequest,
    MessageReceivedEvent,
    KeyExchangeEvent,
    NetworkMode,
    SendMessageResponse,
    GroupChatActivatedEvent,
    GroupMembersUpdatedEvent,
    GroupOfflineGapWarning,
    CallIncomingEvent,
    CallSignalReceivedEvent,
    CallStateChangedEvent,
    CallErrorEvent,
    CallSignalOutgoingInput,
    AppConfig,
    BootstrapRetryResponse,
    ConnectionNodesResponse,
    RelayRetryResponse,
    IceServerConfig,
    IceServersResponse,
} from './src/core/types';
import type { Chat, Message } from './src/core/db/database';

declare global {
    interface Window {
        kiyeovoAPI: {
            AppConfig: {
                chatsToCheckForOfflineMessages: number;
                keyExchangeRateLimit: number;
                offlineMessageLimit: number;
                maxFileSize: number;
                fileOfferRateLimit: number;
                maxPendingFilesPerPeer: number;
                maxPendingFilesTotal: number;
                silentRejectionThresholdGlobal: number;
                silentRejectionThresholdPerPeer: number;
            };
            getAppConfig: () => Promise<{ success: boolean; config: AppConfig; error: string | null }>;
            setAppConfig: (config: AppConfig) => Promise<{ success: boolean; error: string | null }>;
            // Password authentication
            onPasswordRequest: (callback: (request: PasswordRequest) => void) => () => void;
            submitPassword: (password: string, rememberMe: boolean, useRecoveryPhrase?: boolean) => void;

            // Initialization status
            onInitStatus: (callback: (status: InitStatus) => void) => () => void;
            onInitComplete: (callback: () => void) => () => void;
            onInitError: (callback: (error: string) => void) => () => void;
            getInitState: () => Promise<{ initialized: boolean; initStarted: boolean; requiresNetworkModeSelection: boolean; status: InitStatus | null; error: string | null; pendingPasswordRequest?: PasswordRequest | null }>;
            startInitialization: () => Promise<{ success: boolean; error: string | null }>;

            // DHT connection status
            onDHTConnectionStatus: (callback: (status: { connected: boolean | null }) => void) => () => void;
            getDHTConnectionStatus: () => Promise<{ success: boolean; connected: boolean | null; error: string | null }>;
            getNetworkMode: () => Promise<{ success: boolean; mode: NetworkMode; error: string | null }>;
            setNetworkMode: (mode: NetworkMode) => Promise<{ success: boolean; error: string | null }>;

            // Register
            register: (username: string, rememberMe: boolean) => Promise<{ success: boolean; error?: string }>;
            getUserState: () => Promise<{ peerId: string | null; username: string | null; isRegistered: boolean }>;
            getLastUsername: () => Promise<{ username: string | null }>;
            attemptAutoRegister: () => Promise<{ success: boolean; username: string | null; error?: string }>;
            getAutoRegister: () => Promise<{ autoRegister: boolean }>;
            setAutoRegister: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
            onRestoreUsername: (callback: (username: string) => void) => () => void;
            unregister: () => Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }>;

            // Send message
            sendMessage: (identifier: string, message: string) => Promise<SendMessageResponse>;
            sendGroupMessage: (
                chatId: number,
                message: string,
                options?: { rekeyRetryHint?: boolean }
            ) => Promise<SendMessageResponse>;
            retryGroupOfflineBackup: (chatId: number, messageId: string) => Promise<{ success: boolean; error: string | null }>;

            // Call signaling
            startCall: (
                peerId: string,
                callId: string,
                offerSdp: string,
                mediaType?: 'audio' | 'video',
            ) => Promise<{ success: boolean; error: string | null }>;
            acceptCall: (peerId: string, callId: string, answerSdp: string) => Promise<{ success: boolean; error: string | null }>;
            rejectCall: (
                peerId: string,
                callId: string,
                reason?: 'rejected' | 'timeout' | 'offline' | 'policy'
            ) => Promise<{ success: boolean; error: string | null }>;
            hangupCall: (
                peerId: string,
                callId: string,
                reason?: 'hangup' | 'disconnect' | 'failed'
            ) => Promise<{ success: boolean; error: string | null }>;
            sendCallSignal: (signal: CallSignalOutgoingInput) => Promise<{ success: boolean; error: string | null }>;
            onCallIncoming: (callback: (data: CallIncomingEvent) => void) => () => void;
            onCallSignalReceived: (callback: (data: CallSignalReceivedEvent) => void) => () => void;
            onCallStateChanged: (callback: (data: CallStateChangedEvent) => void) => () => void;
            onCallError: (callback: (data: CallErrorEvent) => void) => () => void;

            // Key exchange events
            onKeyExchangeSent: (callback: (data: KeyExchangeEvent) => void) => () => void;
            onKeyExchangeFailed: (callback: (data: KeyExchangeFailedEvent) => void) => () => void;

            // Contact request events
            onContactRequestReceived: (callback: (data: ContactRequestEvent) => void) => () => void;
            onContactRequestCancelled: (callback: (data: ContactRequestCancelledEvent) => void) => () => void;
            acceptContactRequest: (peerId: string) => Promise<{ success: boolean; error: string | null }>;
            rejectContactRequest: (peerId: string, block: boolean) => Promise<{ success: boolean; error: string | null }>;

            // Bootstrap nodes
            getBootstrapNodes: () => Promise<ConnectionNodesResponse>;
            retryBootstrap: () => Promise<BootstrapRetryResponse>;
            retryRelays: () => Promise<RelayRetryResponse>;
            getRelayStatus: () => Promise<ConnectionNodesResponse>;
            addRelayNode: (address: string) => Promise<{ success: boolean; error: string | null }>;
            removeRelayNode: (address: string) => Promise<{ success: boolean; error: string | null }>;
            addBootstrapNode: (address: string) => Promise<{ success: boolean; error: string | null }>;
            removeBootstrapNode: (address: string) => Promise<{ success: boolean; error: string | null }>;
            reorderBootstrapNodes: (addresses: string[]) => Promise<{ success: boolean; error: string | null }>;
            reorderRelayNodes: (addresses: string[]) => Promise<{ success: boolean; error: string | null }>;
            getIceServers: () => Promise<IceServersResponse>;
            setIceServers: (servers: IceServerConfig[]) => Promise<{ success: boolean; error: string | null }>;

            // Contact attempts
            getContactAttempts: () => Promise<{
                success: boolean;
                contactAttempts: Array<{
                    peerId: string;
                    username: string;
                    message: string;
                    messageBody?: string;
                    receivedAt: number;
                    expiresAt: number;
                }>;
                error: string | null;
            }>;

            // Chat events
            onChatCreated: (callback: (data: ChatCreatedEvent) => void) => () => void;
            onGroupChatActivated: (callback: (data: GroupChatActivatedEvent) => void) => () => void;
            onGroupMembersUpdated: (callback: (data: GroupMembersUpdatedEvent) => void) => () => void;
            getChats: () => Promise<{
                success: boolean;
                chats: Array<Chat & {
                    group_creator_username?: string;
                    last_inbound_activity_timestamp?: Date;
                }>;
                error: string | null
            }>;
            searchChats: (query: string) => Promise<{ success: boolean; chatIds: number[]; error: string | null }>;
            getChatById: (chatId: number) => Promise<{
                success: boolean;
                chat: (Chat & {
                    username?: string;
                    other_peer_id?: string;
                    group_creator_username?: string;
                    last_message_content?: string;
                    last_message_timestamp?: Date;
                    last_inbound_activity_timestamp?: Date;
                    last_message_sender?: string;
                    updated_at?: Date;
                }) | null;
                error: string | null
            }>;
            
            // Message events
            getMessages: (chatId: number, limit?: number, offset?: number) => Promise<{ success: boolean; messages: Array<Message & { sender_username?: string }>; error: string | null }>;
            onMessageReceived: (callback: (data: MessageReceivedEvent) => void) => () => void;

            // Offline message events
            checkOfflineMessages: (chatIds?: number[]) => Promise<{ success: boolean; checkedChatIds: number[]; unreadFromChats: Map<number, number>; error: string | null }>;
            checkOfflineMessagesForChat: (chatId: number) => Promise<{ success: boolean; checkedChatIds: number[]; unreadFromChats: Map<number, number>; error: string | null }>;
            checkGroupOfflineMessages: (chatIds?: number[]) => Promise<{ success: boolean; checkedChatIds: number[]; failedChatIds: number[]; unreadFromChats: Map<number, number>; gapWarnings: GroupOfflineGapWarning[]; error: string | null }>;
            checkGroupOfflineMessagesForChat: (chatId: number) => Promise<{ success: boolean; checkedChatIds: number[]; failedChatIds: number[]; unreadFromChats: Map<number, number>; gapWarnings: GroupOfflineGapWarning[]; error: string | null }>;
            onOfflineMessagesFetchStart: (callback: (data: { chatIds: number[] }) => void) => () => void;
            onOfflineMessagesFetchComplete: (callback: (data: { chatIds: number[] }) => void) => () => void;

            // Pending key exchange events
            cancelPendingKeyExchange: (peerId: string) => Promise<{ success: boolean; error: string | null }>;

            // Trusted user import/export
            importTrustedUser: (
                filePath: string,
                password: string,
                customName?: string
            ) => Promise<{
                success: boolean;
                error?: string;
                fingerprint?: string;
                chatId?: number;
                username?: string;
                peerId?: string;
            }>;

            exportProfile: (
                password: string,
                sharedSecret: string
            ) => Promise<{
                success: boolean;
                error?: string;
                filePath?: string;
                fingerprint?: string;
            }>;
            checkTrustedSecretReuse: (sharedSecret: string) => Promise<{
                success: boolean;
                isReused: boolean;
                count: number;
                error: string | null;
            }>;

            // File dialogs
            showOpenDialog: (options: {
                title?: string;
                filters?: Array<{ name: string; extensions: string[] }>;
                properties?: Array<'openFile' | 'openDirectory'>;
            }) => Promise<{ filePath: string | null; canceled: boolean }>;

            showSaveDialog: (options: {
                title?: string;
                defaultPath?: string;
                filters?: Array<{ name: string; extensions: string[] }>;
            }) => Promise<{ filePath: string | null; canceled: boolean }>;
            getTorSettings: () => Promise<{
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
            }>;
            setTorSettings: (settings: {
                socksHost: string;
                socksPort: number;
                connectionTimeout: number;
                circuitTimeout: number;
                maxRetries: number;
                healthCheckInterval: number;
                dnsResolution: 'tor' | 'system';
            }) => Promise<{ success: boolean; error: string | null }>;
            restartApp: () => Promise<{ success: boolean; error: string | null }>;
            quitApp: () => Promise<{ success: boolean; error: string | null }>;
            deleteAccountAndData: () => Promise<{ success: boolean; error: string | null }>;
            backupDatabase: (backupPath: string) => Promise<{ success: boolean; error: string | null }>;
            restoreDatabase: (backupPath: string) => Promise<{ success: boolean; error: string | null }>;
            restoreDatabaseFromFile: (backupPath: string) => Promise<{ success: boolean; error: string | null }>;
            getFileMetadata: (filePath: string) => Promise<{ success: boolean; name: string | null; size: number | null; error: string | null }>;

            // Notifications
            showNotification: (options: {
                title: string;
                body: string;
                chatId?: number;
            }) => Promise<{ success: boolean; error?: string }>;
            isWindowFocused: () => Promise<{ focused: boolean }>;
            focusWindow: () => Promise<{ success: boolean; error?: string }>;
            onNotificationClicked: (callback: (chatId: number) => void) => () => void;

            // Chat settings
            toggleChatMute: (chatId: number) => Promise<{ success: boolean; muted: boolean; error: string | null }>;
            deleteAllMessages: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
            deleteChat: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
            deleteChatAndUser: (chatId: number, peerId: string) => Promise<{ success: boolean; error: string | null }>;
            updateUsername: (peerId: string, newUsername: string) => Promise<{ success: boolean; error: string | null }>;

            // User blocking
            blockUser: (peerId: string, username: string | null, reason: string | null) => Promise<{ success: boolean; error: string | null }>;
            unblockUser: (peerId: string) => Promise<{ success: boolean; error: string | null }>;
            isUserBlocked: (peerId: string) => Promise<{ success: boolean; blocked: boolean; error: string | null }>;
            getUserInfo: (peerId: string, chatId: number) => Promise<{
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
            }>;

            // App settings
            getNotificationsEnabled: () => Promise<{ success: boolean; enabled: boolean; error: string | null }>;
            setNotificationsEnabled: (enabled: boolean) => Promise<{ success: boolean; error: string | null }>;
            onNotificationsEnabledChanged: (callback: (enabled: boolean) => void) => () => void;
            getDownloadsDir: () => Promise<{ success: boolean; path: string | null; error: string | null }>;
            setDownloadsDir: (path: string) => Promise<{ success: boolean; error: string | null }>;

            // File transfer
            sendFile: (peerId: string, filePath: string, fileId?: string) => Promise<{ success: boolean; error: string | null }>;
            acceptFile: (fileId: string) => Promise<{ success: boolean; error: string | null }>;
            rejectFile: (fileId: string) => Promise<{ success: boolean; error: string | null }>;
            cancelFileDownload: (fileId: string) => Promise<{ success: boolean; error: string | null }>;
            getPendingFiles: () => Promise<{
                success: boolean;
                files: Array<{
                    fileId: string;
                    filename: string;
                    size: number;
                    senderId: string;
                    senderUsername: string;
                    expiresAt: number;
                }>;
                error: string | null;
            }>;
            openFileLocation: (filePath: string) => Promise<{ success: boolean; error: string | null }>;

            // Group chats
            getContacts: () => Promise<{ success: boolean; contacts: Array<{ peerId: string; username: string }>; error: string | null }>;
            createGroup: (groupName: string, peerIds: string[]) => Promise<{
                success: boolean;
                groupId: string | null;
                chatId: number | null;
                inviteDeliveries: Array<{ peerId: string; username: string; status: 'sent' | 'queued_for_retry'; reason?: string }>;
                error: string | null;
            }>;
            inviteUsersToGroup: (chatId: number, peerIds: string[]) => Promise<{
                success: boolean;
                inviteDeliveries: Array<{ peerId: string; username: string; status: 'sent' | 'queued_for_retry'; reason?: string }>;
                error: string | null;
            }>;
            reinviteUserToGroup: (chatId: number, peerId: string) => Promise<{
                success: boolean;
                inviteDelivery: { peerId: string; username: string; status: 'sent' | 'queued_for_retry'; reason?: string } | null;
                error: string | null;
            }>;
            getGroupMembers: (chatId: number) => Promise<{ success: boolean; members: Array<{ peerId: string; username: string; status: 'pending' | 'accepted' | 'confirmed' }>; error: string | null }>;
            getGroupInvites: () => Promise<{ success: boolean; invites: Array<{ groupId: string; groupName: string; inviterPeerId: string; inviterUsername: string; inviteId: string; expiresAt: number }>; error: string | null }>;
            respondToGroupInvite: (groupId: string, accept: boolean) => Promise<{ success: boolean; error: string | null }>;
            requestGroupUpdate: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
            leaveGroup: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
            disbandGroup: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
            kickGroupMember: (chatId: number, targetPeerId: string) => Promise<{ success: boolean; error: string | null }>;
            getSubscribedTopics: () => Promise<{ success: boolean; topics: string[]; error: string | null }>;

            // File transfer events
            onFileTransferProgress: (callback: (data: {
                chatId: number;
                messageId: string;
                current: number;
                total: number;
                filename: string;
                size: number;
            }) => void) => () => void;
            onFileTransferComplete: (callback: (data: {
                chatId: number;
                messageId: string;
                filePath: string;
            }) => void) => () => void;
            onFileTransferFailed: (callback: (data: {
                chatId: number;
                messageId: string;
                error: string;
            }) => void) => () => void;
            onOutgoingFileOfferPending: (callback: (data: {
                chatId: number;
                messageId: string;
                expiresAt: number;
            }) => void) => () => void;
            onPendingFileReceived: (callback: (data: {
                chatId: number;
                fileId: string;
                filename: string;
                size: number;
                senderId: string;
                senderUsername: string;
                expiresAt: number;
            }) => void) => () => void;
        };
    }
}

export {};
