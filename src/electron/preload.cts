import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc/channels.js';
import type { KiyeovoAPI, Unsubscribe } from '../shared/kiyeovo-api.js';

function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function subscribeVoid(channel: string, callback: () => void): Unsubscribe {
  const listener = () => callback();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function invoke(channel: string, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...args);
}

function send(channel: string, ...args: unknown[]) {
  ipcRenderer.send(channel, ...args);
}

const kiyeovoAPI: KiyeovoAPI = {
  getAppConfig: () => invoke(IPC_CHANNELS.GET_APP_CONFIG),
  setAppConfig: (config) => invoke(IPC_CHANNELS.SET_APP_CONFIG, config),

  onPasswordRequest: (callback) => subscribe(IPC_CHANNELS.PASSWORD_REQUEST, callback),
  submitPassword: (password, rememberMe, useRecoveryPhrase) => {
    send(IPC_CHANNELS.PASSWORD_RESPONSE, { password, rememberMe, useRecoveryPhrase });
  },

  onInitStatus: (callback) => subscribe(IPC_CHANNELS.INIT_STATUS, callback),
  onInitComplete: (callback) => subscribeVoid(IPC_CHANNELS.INIT_COMPLETE, callback),
  onInitError: (callback) => subscribe(IPC_CHANNELS.INIT_ERROR, callback),
  getInitState: () => invoke(IPC_CHANNELS.INIT_STATE),
  startInitialization: () => invoke(IPC_CHANNELS.INIT_START),

  onDHTConnectionStatus: (callback) => subscribe(IPC_CHANNELS.DHT_CONNECTION_STATUS, callback),
  getDHTConnectionStatus: () => invoke(IPC_CHANNELS.GET_DHT_CONNECTION_STATUS),
  onWakeRecoveryStarted: (callback) => subscribe(IPC_CHANNELS.WAKE_RECOVERY_STARTED, callback),
  onWakeRecoveryReconnectSettled: (callback) => subscribe(IPC_CHANNELS.WAKE_RECOVERY_RECONNECT_SETTLED, callback),
  isNetworkConnected: () => invoke(IPC_CHANNELS.GET_NETWORK_CONNECTED),
  notifyNetworkReconnected: () => invoke(IPC_CHANNELS.NOTIFY_NETWORK_RECONNECTED),
  getNodesLiveness: (addresses) => invoke(IPC_CHANNELS.GET_NODES_LIVENESS, addresses),
  getNetworkMode: () => invoke(IPC_CHANNELS.GET_NETWORK_MODE),
  setNetworkMode: (mode) => invoke(IPC_CHANNELS.SET_NETWORK_MODE, mode),
  getInitialSetupStatus: () => invoke(IPC_CHANNELS.GET_INITIAL_SETUP_STATUS),
  setInitialSetupStatus: (status) => invoke(IPC_CHANNELS.SET_INITIAL_SETUP_STATUS, status),

  register: (username, rememberMe) => invoke(IPC_CHANNELS.REGISTER_REQUEST, username, rememberMe),
  getUserState: () => invoke(IPC_CHANNELS.GET_USER_STATE),
  getLastUsername: () => invoke(IPC_CHANNELS.GET_LAST_USERNAME),
  attemptAutoRegister: () => invoke(IPC_CHANNELS.ATTEMPT_AUTO_REGISTER),
  getAutoRegister: () => invoke(IPC_CHANNELS.GET_AUTO_REGISTER),
  setAutoRegister: (enabled) => invoke(IPC_CHANNELS.SET_AUTO_REGISTER, enabled),
  onRestoreUsername: (callback) => subscribe(IPC_CHANNELS.RESTORE_USERNAME, callback),
  unregister: () => invoke(IPC_CHANNELS.UNREGISTER_REQUEST),

  sendMessage: (identifier, message, replyToCid) => invoke(IPC_CHANNELS.SEND_MESSAGE_REQUEST, identifier, message, replyToCid),
  checkOfflineCapacity: (peerId, additional) => invoke(IPC_CHANNELS.CHECK_OFFLINE_CAPACITY, peerId, additional),
  requestOfflineInboxRecovery: (peerId) => invoke(IPC_CHANNELS.REQUEST_OFFLINE_INBOX_RECOVERY, peerId),
  getOfflineInboxCapacity: (chatId) => invoke(IPC_CHANNELS.GET_OFFLINE_INBOX_CAPACITY, chatId),
  retryOfflineSend: (messageId) => invoke(IPC_CHANNELS.RETRY_OFFLINE_SEND, messageId),
  sendGroupMessage: (chatId, message, options) => invoke(IPC_CHANNELS.SEND_GROUP_MESSAGE_REQUEST, chatId, message, options),
  retryGroupOfflineBackup: (chatId, messageId) => invoke(IPC_CHANNELS.RETRY_GROUP_OFFLINE_BACKUP, chatId, messageId),

  startCall: (peerId, callId, offerSdp) => invoke(IPC_CHANNELS.CALL_START, peerId, callId, offerSdp),
  acceptCall: (peerId, callId, answerSdp) => invoke(IPC_CHANNELS.CALL_ACCEPT, peerId, callId, answerSdp),
  rejectCall: (peerId, callId, reason) => invoke(IPC_CHANNELS.CALL_REJECT, peerId, callId, reason),
  hangupCall: (peerId, callId, reason) => invoke(IPC_CHANNELS.CALL_HANGUP, peerId, callId, reason),
  sendCallSignal: (signal) => invoke(IPC_CHANNELS.CALL_SIGNAL_SEND, signal),
  startGroupCall: (chatId) => invoke(IPC_CHANNELS.GROUP_CALL_START, chatId),
  joinGroupCall: (chatId) => invoke(IPC_CHANNELS.GROUP_CALL_JOIN, chatId),
  leaveGroupCall: (chatId) => invoke(IPC_CHANNELS.GROUP_CALL_LEAVE, chatId),
  fallbackGroupCallWriterRecovery: (chatId) => invoke(IPC_CHANNELS.GROUP_CALL_WRITER_RECOVERY_FALLBACK, chatId),
  sendGroupCallPairSignal: (signal) => invoke(IPC_CHANNELS.GROUP_CALL_PAIR_SIGNAL_SEND, signal),
  getScreenShareSupport: () => invoke(IPC_CHANNELS.GET_SCREEN_SHARE_SUPPORT),
  onScreenShareSourceRequest: (callback) => subscribe(IPC_CHANNELS.SCREEN_SHARE_SOURCE_REQUEST, callback),
  selectScreenShareSource: (requestId, sourceId) => invoke(IPC_CHANNELS.SCREEN_SHARE_SOURCE_SELECT, requestId, sourceId),
  onCallIncoming: (callback) => subscribe(IPC_CHANNELS.CALL_INCOMING, callback),
  onCallSignalReceived: (callback) => subscribe(IPC_CHANNELS.CALL_SIGNAL_RECEIVED, callback),
  onCallStateChanged: (callback) => subscribe(IPC_CHANNELS.CALL_STATE_CHANGED, callback),
  onCallError: (callback) => subscribe(IPC_CHANNELS.CALL_ERROR, callback),
  onGroupCallControlSignalReceived: (callback) => subscribe(IPC_CHANNELS.GROUP_CALL_CONTROL_SIGNAL_RECEIVED, callback),
  onGroupCallPairSignalReceived: (callback) => subscribe(IPC_CHANNELS.GROUP_CALL_PAIR_SIGNAL_RECEIVED, callback),
  onGroupCallStateChanged: (callback) => subscribe(IPC_CHANNELS.GROUP_CALL_STATE_CHANGED, callback),
  onGroupCallPeerBlocked: (callback) => subscribe(IPC_CHANNELS.GROUP_CALL_PEER_BLOCKED, callback),
  onGroupCallError: (callback) => subscribe(IPC_CHANNELS.GROUP_CALL_ERROR, callback),

  onKeyExchangeSent: (callback) => subscribe(IPC_CHANNELS.KEY_EXCHANGE_SENT, callback),
  onKeyExchangeFailed: (callback) => subscribe(IPC_CHANNELS.KEY_EXCHANGE_FAILED, callback),

  onContactRequestReceived: (callback) => subscribe(IPC_CHANNELS.CONTACT_REQUEST_RECEIVED, callback),
  onContactRequestCancelled: (callback) => subscribe(IPC_CHANNELS.CONTACT_REQUEST_CANCELLED, callback),
  acceptContactRequest: (peerId) => invoke(IPC_CHANNELS.ACCEPT_CONTACT_REQUEST, peerId),
  rejectContactRequest: (peerId, block) => invoke(IPC_CHANNELS.REJECT_CONTACT_REQUEST, peerId, block),

  getBootstrapNodes: () => invoke(IPC_CHANNELS.GET_BOOTSTRAP_NODES),
  retryBootstrap: () => invoke(IPC_CHANNELS.RETRY_BOOTSTRAP),
  retryRelays: () => invoke(IPC_CHANNELS.RETRY_RELAYS),
  getRelayStatus: () => invoke(IPC_CHANNELS.GET_RELAY_STATUS),
  addRelayNode: (address) => invoke(IPC_CHANNELS.ADD_RELAY_NODE, address),
  removeRelayNode: (address) => invoke(IPC_CHANNELS.REMOVE_RELAY_NODE, address),
  addBootstrapNode: (address) => invoke(IPC_CHANNELS.ADD_BOOTSTRAP_NODE, address),
  removeBootstrapNode: (address) => invoke(IPC_CHANNELS.REMOVE_BOOTSTRAP_NODE, address),
  reorderBootstrapNodes: (addresses) => invoke(IPC_CHANNELS.REORDER_BOOTSTRAP_NODES, addresses),
  reorderRelayNodes: (addresses) => invoke(IPC_CHANNELS.REORDER_RELAY_NODES, addresses),
  getIceServers: () => invoke(IPC_CHANNELS.GET_ICE_SERVERS),
  setIceServers: (servers) => invoke(IPC_CHANNELS.SET_ICE_SERVERS, servers),
  getMissingIceWarningAcknowledged: () => invoke(IPC_CHANNELS.GET_MISSING_ICE_WARNING_ACKNOWLEDGED),
  setMissingIceWarningAcknowledged: (acknowledged) => invoke(
    IPC_CHANNELS.SET_MISSING_ICE_WARNING_ACKNOWLEDGED,
    acknowledged,
  ),
  getPredefinedNodesSunsetDismissed: () => invoke(IPC_CHANNELS.GET_PREDEFINED_NODES_SUNSET_DISMISSED),
  setPredefinedNodesSunsetDismissed: (dismissed) => invoke(
    IPC_CHANNELS.SET_PREDEFINED_NODES_SUNSET_DISMISSED,
    dismissed,
  ),

  getContactAttempts: () => invoke(IPC_CHANNELS.GET_CONTACT_ATTEMPTS),

  onChatCreated: (callback) => subscribe(IPC_CHANNELS.CHAT_CREATED, callback),
  onGroupChatActivated: (callback) => subscribe(IPC_CHANNELS.GROUP_CHAT_ACTIVATED, callback),
  onGroupMembersUpdated: (callback) => subscribe(IPC_CHANNELS.GROUP_MEMBERS_UPDATED, callback),
  getChats: () => invoke(IPC_CHANNELS.GET_CHATS),
  searchChats: (query) => invoke(IPC_CHANNELS.SEARCH_CHATS, query),
  getChatById: (chatId) => invoke(IPC_CHANNELS.GET_CHAT, chatId),

  getMessages: (chatId, limit, offset) => invoke(IPC_CHANNELS.GET_MESSAGES, chatId, limit, offset),
  getMessageJumpWindow: (chatId, clientMsgId) => invoke(IPC_CHANNELS.GET_MESSAGE_JUMP_WINDOW, chatId, clientMsgId),
  getMessagePreviewByCid: (chatId, clientMsgId) => invoke(IPC_CHANNELS.GET_MESSAGE_PREVIEW_BY_CID, chatId, clientMsgId),
  deleteMessagesForMe: (chatId, messageIds) => invoke(IPC_CHANNELS.DELETE_MESSAGES_FOR_ME, chatId, messageIds),
  searchChatMessages: (chatId, query, options) => invoke(IPC_CHANNELS.SEARCH_CHAT_MESSAGES, chatId, query, options),
  setMessagePinned: (chatId, clientMsgId, pinned) => invoke(IPC_CHANNELS.SET_MESSAGE_PINNED, chatId, clientMsgId, pinned),
  getPinnedMessage: (chatId) => invoke(IPC_CHANNELS.GET_PINNED_MESSAGE, chatId),
  onMessageReceived: (callback) => subscribe(IPC_CHANNELS.MESSAGE_RECEIVED, callback),
  onMessageSendStateChanged: (callback) => subscribe(IPC_CHANNELS.MESSAGE_SEND_STATE_CHANGED, callback),
  onOfflineInboxCapacityChanged: (callback) => subscribe(IPC_CHANNELS.OFFLINE_INBOX_CAPACITY_CHANGED, callback),

  checkOfflineMessages: (chatIds) => invoke(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES, chatIds),
  checkOfflineMessagesForChat: (chatId) => invoke(IPC_CHANNELS.CHECK_OFFLINE_MESSAGES_FOR_CHAT, chatId),
  checkGroupOfflineMessages: (chatIds) => invoke(IPC_CHANNELS.CHECK_GROUP_OFFLINE_MESSAGES, chatIds),
  checkGroupOfflineMessagesForChat: (chatId) => invoke(IPC_CHANNELS.CHECK_GROUP_OFFLINE_MESSAGES_FOR_CHAT, chatId),
  onOfflineMessagesFetchStart: (callback) => subscribe(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_START, callback),
  onOfflineMessagesFetchComplete: (callback) => subscribe(IPC_CHANNELS.OFFLINE_MESSAGES_FETCH_COMPLETE, callback),

  cancelPendingKeyExchange: (peerId) => invoke(IPC_CHANNELS.CANCEL_PENDING_KEY_EXCHANGE, peerId),

  importTrustedUser: (filePath, password, customName) => invoke(IPC_CHANNELS.IMPORT_TRUSTED_USER, filePath, password, customName),
  exportProfile: (password, sharedSecret, filename, label) => invoke(IPC_CHANNELS.EXPORT_PROFILE, password, sharedSecret, filename, label),
  checkTrustedSecretReuse: (sharedSecret) => invoke(IPC_CHANNELS.CHECK_TRUSTED_SECRET_REUSE, sharedSecret),

  showOpenDialog: (options) => invoke(IPC_CHANNELS.SHOW_OPEN_DIALOG, options),
  showSaveDialog: (options) => invoke(IPC_CHANNELS.SHOW_SAVE_DIALOG, options),
  getFileMetadata: (filePath) => invoke(IPC_CHANNELS.GET_FILE_METADATA, filePath),
  registerMessageMedia: (messageId) => invoke(IPC_CHANNELS.REGISTER_MESSAGE_MEDIA, messageId),
  copyImageToClipboard: (messageId) => invoke(IPC_CHANNELS.COPY_IMAGE_TO_CLIPBOARD, messageId),
  saveUpload: (bytes, fileName) => invoke(IPC_CHANNELS.SAVE_UPLOAD, bytes, fileName),
  saveTextUpload: (text, fileName) => invoke(IPC_CHANNELS.SAVE_TEXT_UPLOAD, text, fileName),
  saveVoiceNoteUpload: (bytes, fileName, durationMs) => invoke(IPC_CHANNELS.SAVE_VOICE_NOTE_UPLOAD, bytes, fileName, durationMs),
  registerVoiceNoteMedia: (messageId) => invoke(IPC_CHANNELS.REGISTER_VOICE_NOTE_MEDIA, messageId),
  getTorSettings: () => invoke(IPC_CHANNELS.GET_TOR_SETTINGS),
  setTorSettings: (settings) => invoke(IPC_CHANNELS.SET_TOR_SETTINGS, settings),
  getCloseToTrayEnabled: () => invoke(IPC_CHANNELS.GET_CLOSE_TO_TRAY_ENABLED),
  setCloseToTrayEnabled: (enabled) => invoke(IPC_CHANNELS.SET_CLOSE_TO_TRAY_ENABLED, enabled),
  getMinimizeToTrayEnabled: () => invoke(IPC_CHANNELS.GET_MINIMIZE_TO_TRAY_ENABLED),
  setMinimizeToTrayEnabled: (enabled) => invoke(IPC_CHANNELS.SET_MINIMIZE_TO_TRAY_ENABLED, enabled),
  getLaunchOnLoginEnabled: () => invoke(IPC_CHANNELS.GET_LAUNCH_ON_LOGIN_ENABLED),
  setLaunchOnLoginEnabled: (enabled) => invoke(IPC_CHANNELS.SET_LAUNCH_ON_LOGIN_ENABLED, enabled),

  restartApp: () => invoke(IPC_CHANNELS.RESTART_APP),
  quitApp: () => invoke(IPC_CHANNELS.QUIT_APP),
  deleteAccountAndData: () => invoke(IPC_CHANNELS.DELETE_ACCOUNT_AND_DATA),
  backupDatabase: (backupPath, password) => invoke(IPC_CHANNELS.BACKUP_DATABASE, backupPath, password),
  restoreDatabase: (backupPath, password) => invoke(IPC_CHANNELS.RESTORE_DATABASE, backupPath, password),
  restoreDatabaseFromFile: (backupPath, password) => invoke(IPC_CHANNELS.RESTORE_DATABASE_FROM_FILE, backupPath, password),

  showNotification: (options) => invoke(IPC_CHANNELS.SHOW_NOTIFICATION, options),
  isWindowFocused: () => invoke(IPC_CHANNELS.IS_WINDOW_FOCUSED),
  focusWindow: () => invoke(IPC_CHANNELS.FOCUS_WINDOW),
  onNotificationClicked: (callback) => subscribe(IPC_CHANNELS.NOTIFICATION_CLICKED, callback),

  toggleChatMute: (chatId) => invoke(IPC_CHANNELS.TOGGLE_CHAT_MUTE, chatId),
  deleteAllMessages: (chatId) => invoke(IPC_CHANNELS.DELETE_ALL_MESSAGES, chatId),
  deleteChat: (chatId) => invoke(IPC_CHANNELS.DELETE_CHAT, chatId),
  deleteChatAndUser: (chatId, peerId) => invoke(IPC_CHANNELS.DELETE_CHAT_AND_USER, chatId, peerId),
  updateUsername: (peerId, newUsername) => invoke(IPC_CHANNELS.UPDATE_USERNAME, peerId, newUsername),

  blockUser: (peerId, username, reason) => invoke(IPC_CHANNELS.BLOCK_USER, peerId, username, reason),
  unblockUser: (peerId) => invoke(IPC_CHANNELS.UNBLOCK_USER, peerId),
  isUserBlocked: (peerId) => invoke(IPC_CHANNELS.IS_USER_BLOCKED, peerId),
  getUserInfo: (peerId, chatId) => invoke(IPC_CHANNELS.GET_USER_INFO, peerId, chatId),

  getNotificationsEnabled: () => invoke(IPC_CHANNELS.GET_NOTIFICATIONS_ENABLED),
  setNotificationsEnabled: (enabled) => invoke(IPC_CHANNELS.SET_NOTIFICATIONS_ENABLED, enabled),
  onNotificationsEnabledChanged: (callback) => subscribe(IPC_CHANNELS.NOTIFICATIONS_ENABLED_CHANGED, callback),
  getDownloadsDir: () => invoke(IPC_CHANNELS.GET_DOWNLOADS_DIR),
  setDownloadsDir: (path) => invoke(IPC_CHANNELS.SET_DOWNLOADS_DIR, path),

  sendFile: (peerId, filePath, fileId, replyToCid, voiceNoteDurationMs) => invoke(IPC_CHANNELS.SEND_FILE_REQUEST, peerId, filePath, fileId, replyToCid, voiceNoteDurationMs),
  sendGroupFile: (chatId, filePath, fileId, replyToCid, voiceNoteDurationMs) => invoke(IPC_CHANNELS.SEND_GROUP_FILE_REQUEST, chatId, filePath, fileId, replyToCid, voiceNoteDurationMs),
  acceptFile: (fileId) => invoke(IPC_CHANNELS.ACCEPT_FILE, fileId),
  rejectFile: (fileId) => invoke(IPC_CHANNELS.REJECT_FILE, fileId),
  getPendingFileInbox: () => invoke(IPC_CHANNELS.GET_PENDING_FILE_INBOX),
  cancelFileDownload: (fileId) => invoke(IPC_CHANNELS.CANCEL_FILE_DOWNLOAD, fileId),
  cancelFileOffer: (fileId) => invoke(IPC_CHANNELS.CANCEL_FILE_OFFER, fileId),
  openFileLocation: (filePath) => invoke(IPC_CHANNELS.OPEN_FILE_LOCATION, filePath),
  onFileTransferProgress: (callback) => subscribe(IPC_CHANNELS.FILE_TRANSFER_PROGRESS, callback),
  onFileTransferComplete: (callback) => subscribe(IPC_CHANNELS.FILE_TRANSFER_COMPLETE, callback),
  onFileTransferFailed: (callback) => subscribe(IPC_CHANNELS.FILE_TRANSFER_FAILED, callback),
  onOutgoingFileOfferPending: (callback) => subscribe(IPC_CHANNELS.OUTGOING_FILE_OFFER_PENDING, callback),
  onOutgoingFileOfferTerminal: (callback) => subscribe(IPC_CHANNELS.OUTGOING_FILE_OFFER_TERMINAL, callback),
  onPendingFileReceived: (callback) => subscribe(IPC_CHANNELS.PENDING_FILE_RECEIVED, callback),
  onPendingFileOfferDeferred: (callback) => subscribe(IPC_CHANNELS.PENDING_FILE_OFFER_DEFERRED, callback),

  getContacts: () => invoke(IPC_CHANNELS.GET_CONTACTS),
  createGroup: (groupName, peerIds) => invoke(IPC_CHANNELS.CREATE_GROUP, groupName, peerIds),
  inviteUsersToGroup: (chatId, peerIds) => invoke(IPC_CHANNELS.INVITE_USERS_TO_GROUP, chatId, peerIds),
  reinviteUserToGroup: (chatId, peerId) => invoke(IPC_CHANNELS.REINVITE_USER_TO_GROUP, chatId, peerId),
  getGroupMembers: (chatId) => invoke(IPC_CHANNELS.GET_GROUP_MEMBERS, chatId),
  getGroupInvites: () => invoke(IPC_CHANNELS.GET_GROUP_INVITES),
  respondToGroupInvite: (groupId, accept) => invoke(IPC_CHANNELS.RESPOND_TO_GROUP_INVITE, groupId, accept),
  requestGroupUpdate: (chatId) => invoke(IPC_CHANNELS.REQUEST_GROUP_UPDATE, chatId),
  leaveGroup: (chatId) => invoke(IPC_CHANNELS.LEAVE_GROUP, chatId),
  disbandGroup: (chatId) => invoke(IPC_CHANNELS.DISBAND_GROUP, chatId),
  kickGroupMember: (chatId, targetPeerId) => invoke(IPC_CHANNELS.KICK_GROUP_MEMBER, chatId, targetPeerId),
  getSubscribedTopics: () => invoke(IPC_CHANNELS.GET_SUBSCRIBED_TOPICS),
};

contextBridge.exposeInMainWorld('kiyeovoAPI', Object.freeze(kiyeovoAPI));
