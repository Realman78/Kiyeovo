import type {
  AppConfig,
  BootstrapRetryResponse,
  CallErrorEvent,
  CallActionResponse,
  CallIncomingEvent,
  CallSignalOutgoingInput,
  CallSignalReceivedEvent,
  CallStateChangedEvent,
  ChatCreatedEvent,
  ConnectionNodesResponse,
  NodesLivenessResponse,
  ContactRequestCancelledEvent,
  ContactRequestEvent,
  FileTransferCompleteEvent,
  FileTransferFailedEvent,
  FileTransferProgressEvent,
  GroupCallControlSignalReceivedEvent,
  GroupCallErrorEvent,
  GroupCallPairSignalOutgoingInput,
  GroupCallPairSignalReceivedEvent,
  GroupCallStateChangedEvent,
  GroupChatActivatedEvent,
  GroupMembersUpdatedEvent,
  GroupOfflineGapWarning,
  IceServerConfig,
  IceServersResponse,
  InitStatus,
  KeyExchangeEvent,
  KeyExchangeFailedEvent,
  MessageReceivedEvent,
  MessageSendStateChangedEvent,
  NetworkMode,
  OfflineInboxCapacityChangedEvent,
  OfflineInboxCapacitySnapshot,
  OutgoingFileOfferPendingEvent,
  PasswordRequest,
  PendingFileReceivedEvent,
  RelayRetryResponse,
  SendMessageResponse,
} from '../core/types.js';
import type { Chat, Message, PinnedMessagePreview } from '../core/db/database.js';

export type Unsubscribe = () => void;
export type InitialSetupStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

export type KiyeovoChatListItem = Chat & {
  group_creator_username?: string;
  last_inbound_activity_timestamp?: Date;
};

export type KiyeovoChatDetails = Chat & {
  username?: string;
  other_peer_id?: string;
  group_creator_username?: string;
  last_message_content?: string;
  last_message_timestamp?: Date;
  last_inbound_activity_timestamp?: Date;
  last_message_sender?: string;
  updated_at?: Date;
};

export type KiyeovoMessage = Message & {
  sender_username?: string;
};

export type DeleteMessagesLatestRemaining = {
  content: string;
  timestamp: number;
  clientMsgId: string | null;
};

export type ChatMessageSearchResult = {
  id: string;
  clientMsgId: string | null;
  content: string;
  fileName: string | null;
  messageType: 'text' | 'file' | 'image' | 'system';
  senderPeerId: string;
  timestamp: number;
};

export type ChatMessageSearchCursor = {
  timestamp: number;
  rowid: number;
};

export type ChatMessageSearchResponse = {
  results: ChatMessageSearchResult[];
  total: number;
  snapshotMaxRowid: number;
  nextCursor: ChatMessageSearchCursor | null;
};

export type MessageJumpWindowResponse = {
  status: 'loaded' | 'too_deep' | 'not_found';
  messages: KiyeovoMessage[];
  hasMoreOlder: boolean;
};

export type ScreenShareSupportResponse = {
  success: boolean;
  supported: boolean;
  message: string;
  error: string | null;
};

export type ScreenShareSource = {
  id: string;
  name: string;
  sourceType: 'screen' | 'window';
  thumbnailDataUrl: string | null;
  displayId: string | null;
};

export type ScreenShareSourceRequest = {
  requestId: string;
  sources: ScreenShareSource[];
};

export type WakeRecoveryStartedEvent = {
  token: number;
  deadlineAt: number;
  trigger: string;
};

export type WakeRecoveryReconnectSettledEvent = {
  token: number;
};

export type GroupCallActionResult = {
  success: boolean;
  error: string | null;
  reason?: string;
  outcome?: 'created' | 'existing';
  callId?: string;
};

export interface KiyeovoAPI {
  getAppConfig: () => Promise<{ success: boolean; config: AppConfig; error: string | null }>;
  setAppConfig: (config: AppConfig) => Promise<{ success: boolean; error: string | null }>;

  onPasswordRequest: (callback: (request: PasswordRequest) => void) => Unsubscribe;
  submitPassword: (password: string, rememberMe: boolean, useRecoveryPhrase?: boolean) => void;

  onInitStatus: (callback: (status: InitStatus) => void) => Unsubscribe;
  onInitComplete: (callback: () => void) => Unsubscribe;
  onInitError: (callback: (error: string) => void) => Unsubscribe;
  getInitState: () => Promise<{
    initialized: boolean;
    initStarted: boolean;
    requiresNetworkModeSelection: boolean;
    status: InitStatus | null;
    error: string | null;
    pendingPasswordRequest?: PasswordRequest | null;
  }>;
  startInitialization: () => Promise<{ success: boolean; error: string | null }>;

  onDHTConnectionStatus: (callback: (status: { connected: boolean | null }) => void) => Unsubscribe;
  getDHTConnectionStatus: () => Promise<{ success: boolean; connected: boolean | null; error: string | null }>;
  onWakeRecoveryStarted: (callback: (data: WakeRecoveryStartedEvent) => void) => Unsubscribe;
  onWakeRecoveryReconnectSettled: (callback: (data: WakeRecoveryReconnectSettledEvent) => void) => Unsubscribe;
  // OS-level connectivity: true if a real (non-virtual, non-internal) network interface is up.
  isNetworkConnected: () => Promise<{ connected: boolean }>;
  // Notify core that OS connectivity just returned, to trigger an immediate DHT reconnect.
  notifyNetworkReconnected: () => Promise<void>;
  // Liveness probe for the given node addresses (pings each); fills in dialog status.
  getNodesLiveness: (addresses: string[]) => Promise<NodesLivenessResponse>;
  getNetworkMode: () => Promise<{ success: boolean; mode: NetworkMode; error: string | null }>;
  setNetworkMode: (mode: NetworkMode) => Promise<{ success: boolean; error: string | null }>;
  getInitialSetupStatus: () => Promise<{
    success: boolean;
    status: InitialSetupStatus;
    error: string | null;
  }>;
  setInitialSetupStatus: (status: InitialSetupStatus) => Promise<{
    success: boolean;
    error: string | null;
  }>;

  register: (username: string, rememberMe: boolean) => Promise<{ success: boolean; error?: string }>;
  getUserState: () => Promise<{ peerId: string | null; username: string | null; isRegistered: boolean }>;
  getLastUsername: () => Promise<{ username: string | null }>;
  attemptAutoRegister: () => Promise<{ success: boolean; username: string | null; error?: string }>;
  getAutoRegister: () => Promise<{ autoRegister: boolean }>;
  setAutoRegister: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  onRestoreUsername: (callback: (username: string) => void) => Unsubscribe;
  unregister: () => Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }>;

  sendMessage: (identifier: string, message: string, replyToCid?: string) => Promise<SendMessageResponse>;
  checkOfflineCapacity: (peerId: string, additional?: number) => Promise<{ hasRoom: boolean }>;
  requestOfflineInboxRecovery: (peerId: string) => Promise<{ started: boolean }>;
  getOfflineInboxCapacity: (chatId: number) => Promise<{
    success: boolean;
    snapshot: OfflineInboxCapacitySnapshot | null;
    error: string | null;
  }>;
  retryOfflineSend: (messageId: string) => Promise<{ success: boolean; error: string | null }>;
  sendGroupMessage: (
    chatId: number,
    message: string,
    options?: { rekeyRetryHint?: boolean; replyToCid?: string },
  ) => Promise<SendMessageResponse>;
  retryGroupOfflineBackup: (chatId: number, messageId: string) => Promise<{ success: boolean; error: string | null }>;

  startCall: (
    peerId: string,
    callId: string,
    offerSdp: string,
  ) => Promise<CallActionResponse>;
  acceptCall: (peerId: string, callId: string, answerSdp: string) => Promise<CallActionResponse>;
  rejectCall: (
    peerId: string,
    callId: string,
    reason?: 'rejected' | 'timeout' | 'offline' | 'policy',
  ) => Promise<CallActionResponse>;
  hangupCall: (
    peerId: string,
    callId: string,
    reason?: 'hangup' | 'disconnect' | 'failed',
  ) => Promise<CallActionResponse>;
  sendCallSignal: (signal: CallSignalOutgoingInput) => Promise<CallActionResponse>;
  startGroupCall: (chatId: number) => Promise<GroupCallActionResult>;
  joinGroupCall: (chatId: number) => Promise<GroupCallActionResult>;
  leaveGroupCall: (chatId: number) => Promise<GroupCallActionResult>;
  fallbackGroupCallWriterRecovery: (chatId: number) => Promise<GroupCallActionResult>;
  sendGroupCallPairSignal: (signal: GroupCallPairSignalOutgoingInput) => Promise<{ success: boolean; error: string | null }>;
  getScreenShareSupport: () => Promise<ScreenShareSupportResponse>;
  onScreenShareSourceRequest: (callback: (request: ScreenShareSourceRequest) => void) => Unsubscribe;
  selectScreenShareSource: (requestId: string, sourceId: string | null) => Promise<{ success: boolean; error: string | null }>;
  onCallIncoming: (callback: (data: CallIncomingEvent) => void) => Unsubscribe;
  onCallSignalReceived: (callback: (data: CallSignalReceivedEvent) => void) => Unsubscribe;
  onCallStateChanged: (callback: (data: CallStateChangedEvent) => void) => Unsubscribe;
  onCallError: (callback: (data: CallErrorEvent) => void) => Unsubscribe;
  onGroupCallControlSignalReceived: (callback: (data: GroupCallControlSignalReceivedEvent) => void) => Unsubscribe;
  onGroupCallPairSignalReceived: (callback: (data: GroupCallPairSignalReceivedEvent) => void) => Unsubscribe;
  onGroupCallStateChanged: (callback: (data: GroupCallStateChangedEvent) => void) => Unsubscribe;
  onGroupCallError: (callback: (data: GroupCallErrorEvent) => void) => Unsubscribe;

  onKeyExchangeSent: (callback: (data: KeyExchangeEvent) => void) => Unsubscribe;
  onKeyExchangeFailed: (callback: (data: KeyExchangeFailedEvent) => void) => Unsubscribe;

  onContactRequestReceived: (callback: (data: ContactRequestEvent) => void) => Unsubscribe;
  onContactRequestCancelled: (callback: (data: ContactRequestCancelledEvent) => void) => Unsubscribe;
  acceptContactRequest: (peerId: string) => Promise<{ success: boolean; error: string | null }>;
  rejectContactRequest: (peerId: string, block: boolean) => Promise<{ success: boolean; error: string | null }>;

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
  getMissingIceWarningAcknowledged: () => Promise<{
    success: boolean;
    acknowledged: boolean;
    error: string | null;
  }>;
  setMissingIceWarningAcknowledged: (acknowledged: boolean) => Promise<{
    success: boolean;
    error: string | null;
  }>;

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

  onChatCreated: (callback: (data: ChatCreatedEvent) => void) => Unsubscribe;
  onGroupChatActivated: (callback: (data: GroupChatActivatedEvent) => void) => Unsubscribe;
  onGroupMembersUpdated: (callback: (data: GroupMembersUpdatedEvent) => void) => Unsubscribe;
  getChats: () => Promise<{
    success: boolean;
    chats: KiyeovoChatListItem[];
    error: string | null;
  }>;
  searchChats: (query: string) => Promise<{ success: boolean; chatIds: number[]; error: string | null }>;
  getChatById: (chatId: number) => Promise<{
    success: boolean;
    chat: KiyeovoChatDetails | null;
    error: string | null;
  }>;

  getMessages: (chatId: number, limit?: number, offset?: number) => Promise<{
    success: boolean;
    messages: KiyeovoMessage[];
    error: string | null;
  }>;
  getMessageJumpWindow: (chatId: number, clientMsgId: string) => Promise<{
    success: boolean;
    status: MessageJumpWindowResponse['status'];
    messages: KiyeovoMessage[];
    hasMoreOlder: boolean;
    error: string | null;
  }>;
  getMessagePreviewByCid: (chatId: number, clientMsgId: string) => Promise<{
    success: boolean;
    preview: {
      senderPeerId: string;
      senderUsername: string | undefined;
      content: string;
      messageType: 'text' | 'file' | 'image' | 'system';
      fileName: string | undefined;
    } | null;
    error: string | null;
  }>;
  deleteMessagesForMe: (chatId: number, messageIds: string[]) => Promise<{
    success: boolean;
    deletedCount: number;
    latestRemaining: DeleteMessagesLatestRemaining | null;
    error: string | null;
  }>;
  setMessagePinned: (chatId: number, clientMsgId: string, pinned: boolean) => Promise<{
    success: boolean;
    error: string | null;
  }>;
  getPinnedMessage: (chatId: number) => Promise<{
    success: boolean;
    pinned: PinnedMessagePreview | null;
    error: string | null;
  }>;
  searchChatMessages: (
    chatId: number,
    query: string,
    options?: { limit?: number; snapshotMaxRowid?: number; cursor?: ChatMessageSearchCursor | null },
  ) => Promise<{
    success: boolean;
    results: ChatMessageSearchResult[];
    total: number;
    snapshotMaxRowid: number;
    nextCursor: ChatMessageSearchCursor | null;
    error: string | null;
  }>;
  onMessageReceived: (callback: (data: MessageReceivedEvent) => void) => Unsubscribe;
  onMessageSendStateChanged: (callback: (data: MessageSendStateChangedEvent) => void) => Unsubscribe;
  onOfflineInboxCapacityChanged: (callback: (data: OfflineInboxCapacityChangedEvent) => void) => Unsubscribe;

  checkOfflineMessages: (chatIds?: number[]) => Promise<{
    success: boolean;
    checkedChatIds: number[];
    unreadFromChats: Map<number, number>;
    error: string | null;
  }>;
  checkOfflineMessagesForChat: (chatId: number) => Promise<{
    success: boolean;
    checkedChatIds: number[];
    unreadFromChats: Map<number, number>;
    error: string | null;
  }>;
  checkGroupOfflineMessages: (chatIds?: number[]) => Promise<{
    success: boolean;
    checkedChatIds: number[];
    failedChatIds: number[];
    unreadFromChats: Map<number, number>;
    gapWarnings: GroupOfflineGapWarning[];
    error: string | null;
  }>;
  checkGroupOfflineMessagesForChat: (chatId: number) => Promise<{
    success: boolean;
    checkedChatIds: number[];
    failedChatIds: number[];
    unreadFromChats: Map<number, number>;
    gapWarnings: GroupOfflineGapWarning[];
    error: string | null;
  }>;
  onOfflineMessagesFetchStart: (callback: (data: { chatIds: number[] }) => void) => Unsubscribe;
  onOfflineMessagesFetchComplete: (callback: (data: { chatIds: number[] }) => void) => Unsubscribe;

  cancelPendingKeyExchange: (peerId: string) => Promise<{ success: boolean; error: string | null }>;

  importTrustedUser: (
    filePath: string,
    password: string,
    customName?: string,
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
    sharedSecret: string,
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

  showOpenDialog: (options: {
    title?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'openDirectory'>;
  }) => Promise<{ filePath: string | null; canceled: boolean; mediaToken: string | null }>;
  showSaveDialog: (options: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ filePath: string | null; canceled: boolean }>;
  getFileMetadata: (filePath: string) => Promise<{ success: boolean; name: string | null; size: number | null; error: string | null }>;

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

  showNotification: (options: {
    title: string;
    body: string;
    chatId?: number;
  }) => Promise<{ success: boolean; error?: string }>;
  isWindowFocused: () => Promise<{ focused: boolean }>;
  focusWindow: () => Promise<{ success: boolean; error?: string }>;
  onNotificationClicked: (callback: (chatId: number) => void) => Unsubscribe;

  toggleChatMute: (chatId: number) => Promise<{ success: boolean; muted: boolean; error: string | null }>;
  deleteAllMessages: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
  deleteChat: (chatId: number) => Promise<{ success: boolean; error: string | null }>;
  deleteChatAndUser: (chatId: number, peerId: string) => Promise<{ success: boolean; error: string | null }>;
  updateUsername: (peerId: string, newUsername: string) => Promise<{ success: boolean; error: string | null }>;

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
    error: string | null;
  }>;

  getNotificationsEnabled: () => Promise<{ success: boolean; enabled: boolean; error: string | null }>;
  setNotificationsEnabled: (enabled: boolean) => Promise<{ success: boolean; error: string | null }>;
  onNotificationsEnabledChanged: (callback: (enabled: boolean) => void) => Unsubscribe;
  getDownloadsDir: () => Promise<{ success: boolean; path: string | null; error: string | null }>;
  setDownloadsDir: (path: string) => Promise<{ success: boolean; error: string | null }>;

  registerMessageMedia: (messageId: string) => Promise<{
    success: boolean;
    token: string | null;
    error: string | null;
  }>;
  saveUpload: (
    bytes: Uint8Array,
    fileName: string,
  ) => Promise<{
    success: boolean;
    filePath: string | null;
    mediaToken: string | null;
    uploadsDirSizeBytes: number;
    error: string | null;
  }>;
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
  onFileTransferProgress: (callback: (data: FileTransferProgressEvent) => void) => Unsubscribe;
  onFileTransferComplete: (callback: (data: FileTransferCompleteEvent) => void) => Unsubscribe;
  onFileTransferFailed: (callback: (data: FileTransferFailedEvent) => void) => Unsubscribe;
  onOutgoingFileOfferPending: (callback: (data: OutgoingFileOfferPendingEvent) => void) => Unsubscribe;
  onPendingFileReceived: (callback: (data: PendingFileReceivedEvent) => void) => Unsubscribe;

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
}
