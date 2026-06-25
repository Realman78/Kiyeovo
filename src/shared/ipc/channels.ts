export const IPC_CHANNELS = {
  // Password/Authentication
  PASSWORD_REQUEST: 'password:request',
  PASSWORD_RESPONSE: 'password:response',

  // Initialization status
  INIT_STATUS: 'init:status',
  INIT_COMPLETE: 'init:complete',
  INIT_ERROR: 'init:error',
  INIT_STATE: 'init:state',
  INIT_START: 'init:start',

  // DHT connection status
  DHT_CONNECTION_STATUS: 'dht:connectionStatus',
  GET_DHT_CONNECTION_STATUS: 'dht:getConnectionStatus',
  WAKE_RECOVERY_STARTED: 'power:wakeRecoveryStarted',
  WAKE_RECOVERY_RECONNECT_SETTLED: 'power:wakeRecoveryReconnectSettled',

  // OS-level network connectivity (is there a real, non-virtual interface up)
  GET_NETWORK_CONNECTED: 'network:getConnected',
  // Renderer tells core that OS connectivity returned, to reconnect immediately
  NOTIFY_NETWORK_RECONNECTED: 'network:reconnected',
  // Per-node liveness probe (pings configured bootstrap/relay addresses)
  GET_NODES_LIVENESS: 'network:getNodesLiveness',

  // Register
  REGISTER_REQUEST: 'register:request',
  GET_USER_STATE: 'user:getState',
  GET_LAST_USERNAME: 'user:getLastUsername',
  ATTEMPT_AUTO_REGISTER: 'user:attemptAutoRegister',
  GET_AUTO_REGISTER: 'user:getAutoRegister',
  SET_AUTO_REGISTER: 'user:setAutoRegister',
  UNREGISTER_REQUEST: 'user:unregister',

  // Restore username
  RESTORE_USERNAME: 'restoreUsername:request',

  // Send message
  SEND_MESSAGE_REQUEST: 'sendMessage:request',
  CHECK_OFFLINE_CAPACITY: 'offlineSend:checkCapacity',
  REQUEST_OFFLINE_INBOX_RECOVERY: 'offlineSend:requestRecovery',
  RETRY_OFFLINE_SEND: 'offlineSend:retry',
  GET_OFFLINE_INBOX_CAPACITY: 'offlineInbox:getCapacity',

  // Key exchange events
  KEY_EXCHANGE_SENT: 'keyExchange:sent',
  KEY_EXCHANGE_FAILED: 'keyExchange:failed',

  // Contact request events
  CONTACT_REQUEST_RECEIVED: 'contactRequest:received',
  CONTACT_REQUEST_CANCELLED: 'contactRequest:cancelled',
  ACCEPT_CONTACT_REQUEST: 'contactRequest:accept',
  REJECT_CONTACT_REQUEST: 'contactRequest:reject',

  // Chat events
  CHAT_CREATED: 'chat:created',
  GET_CHATS: 'chats:get',
  GET_CHAT: 'chat:get',
  SEARCH_CHATS: 'chats:search',

  // Message events
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_SEND_STATE_CHANGED: 'message:sendStateChanged',
  OFFLINE_INBOX_CAPACITY_CHANGED: 'offlineInbox:capacityChanged',

  // Call signaling
  CALL_START: 'call:start',
  CALL_ACCEPT: 'call:accept',
  CALL_REJECT: 'call:reject',
  CALL_HANGUP: 'call:hangup',
  CALL_SIGNAL_SEND: 'call:signalSend',
  CALL_INCOMING: 'call:incoming',
  CALL_SIGNAL_RECEIVED: 'call:signalReceived',
  CALL_STATE_CHANGED: 'call:stateChanged',
  CALL_ERROR: 'call:error',
  GROUP_CALL_START: 'groupCall:start',
  GROUP_CALL_JOIN: 'groupCall:join',
  GROUP_CALL_LEAVE: 'groupCall:leave',
  GROUP_CALL_WRITER_RECOVERY_FALLBACK: 'groupCall:writerRecoveryFallback',
  GROUP_CALL_PAIR_SIGNAL_SEND: 'groupCall:pairSignalSend',
  GROUP_CALL_CONTROL_SIGNAL_RECEIVED: 'groupCall:controlSignalReceived',
  GROUP_CALL_PAIR_SIGNAL_RECEIVED: 'groupCall:pairSignalReceived',
  GROUP_CALL_STATE_CHANGED: 'groupCall:stateChanged',
  GROUP_CALL_ERROR: 'groupCall:error',
  GET_SCREEN_SHARE_SUPPORT: 'call:getScreenShareSupport',
  SCREEN_SHARE_SOURCE_REQUEST: 'screenShare:sourceRequest',
  SCREEN_SHARE_SOURCE_SELECT: 'screenShare:sourceSelect',

  // Bootstrap nodes
  BOOTSTRAP_NODES: 'bootstrap:nodes',
  GET_BOOTSTRAP_NODES: 'bootstrap:getNodes',
  RETRY_BOOTSTRAP: 'bootstrap:retry',
  RETRY_RELAYS: 'relay:retry',
  GET_RELAY_STATUS: 'relay:getStatus',
  ADD_RELAY_NODE: 'relay:addNode',
  REMOVE_RELAY_NODE: 'relay:removeNode',
  ADD_BOOTSTRAP_NODE: 'bootstrap:addNode',
  REMOVE_BOOTSTRAP_NODE: 'bootstrap:removeNode',
  REORDER_BOOTSTRAP_NODES: 'bootstrap:reorder',
  REORDER_RELAY_NODES: 'relay:reorder',

  // Contact attempts
  GET_CONTACT_ATTEMPTS: 'contactAttempts:get',

  // Trusted user import/export
  IMPORT_TRUSTED_USER: 'trustedUser:import',
  EXPORT_PROFILE: 'profile:export',
  CHECK_TRUSTED_SECRET_REUSE: 'profile:checkSharedSecretReuse',

  // File dialogs
  SHOW_OPEN_DIALOG: 'dialog:showOpen',
  SHOW_SAVE_DIALOG: 'dialog:showSave',

  // Messages
  GET_MESSAGES: 'messages:get',
  GET_MESSAGE_JUMP_WINDOW: 'messages:getJumpWindow',
  GET_MESSAGE_PREVIEW_BY_CID: 'messages:getPreviewByCid',
  DELETE_MESSAGES_FOR_ME: 'messages:deleteForMe',
  SEARCH_CHAT_MESSAGES: 'messages:searchInChat',

  // Offline messages
  CHECK_OFFLINE_MESSAGES: 'offlineMessages:check',
  CHECK_OFFLINE_MESSAGES_FOR_CHAT: 'offlineMessages:checkForChat',
  CHECK_GROUP_OFFLINE_MESSAGES: 'groupOfflineMessages:check',
  CHECK_GROUP_OFFLINE_MESSAGES_FOR_CHAT: 'groupOfflineMessages:checkForChat',
  OFFLINE_MESSAGES_FETCH_START: 'offlineMessages:fetchStart',
  OFFLINE_MESSAGES_FETCH_COMPLETE: 'offlineMessages:fetchComplete',

  // Pending key exchange events
  CANCEL_PENDING_KEY_EXCHANGE: 'pendingKeyExchange:cancel',

  // Notifications
  SHOW_NOTIFICATION: 'notification:show',
  NOTIFICATION_CLICKED: 'notification:clicked',
  IS_WINDOW_FOCUSED: 'window:isFocused',
  FOCUS_WINDOW: 'window:focus',

  // Chat settings
  TOGGLE_CHAT_MUTE: 'chat:toggleMute',
  BLOCK_USER: 'user:block',
  UNBLOCK_USER: 'user:unblock',
  IS_USER_BLOCKED: 'user:isBlocked',
  GET_USER_INFO: 'user:getInfo',
  DELETE_ALL_MESSAGES: 'chat:deleteAllMessages',
  DELETE_CHAT: 'chat:delete',
  DELETE_CHAT_AND_USER: 'chat:deleteChatAndUser',
  UPDATE_USERNAME: 'chat:updateUsername',

  // App settings
  GET_NOTIFICATIONS_ENABLED: 'settings:getNotificationsEnabled',
  SET_NOTIFICATIONS_ENABLED: 'settings:setNotificationsEnabled',
  GET_NETWORK_MODE: 'settings:getNetworkMode',
  SET_NETWORK_MODE: 'settings:setNetworkMode',
  GET_INITIAL_SETUP_STATUS: 'settings:getInitialSetupStatus',
  SET_INITIAL_SETUP_STATUS: 'settings:setInitialSetupStatus',
  NOTIFICATIONS_ENABLED_CHANGED: 'settings:notificationsEnabledChanged',
  GET_DOWNLOADS_DIR: 'settings:getDownloadsDir',
  SET_DOWNLOADS_DIR: 'settings:setDownloadsDir',
  GET_TOR_SETTINGS: 'settings:getTorSettings',
  SET_TOR_SETTINGS: 'settings:setTorSettings',
  GET_APP_CONFIG: 'settings:getAppConfig',
  SET_APP_CONFIG: 'settings:setAppConfig',
  GET_ICE_SERVERS: 'settings:getIceServers',
  SET_ICE_SERVERS: 'settings:setIceServers',
  GET_MISSING_ICE_WARNING_ACKNOWLEDGED: 'settings:getMissingIceWarningAcknowledged',
  SET_MISSING_ICE_WARNING_ACKNOWLEDGED: 'settings:setMissingIceWarningAcknowledged',
  RESTART_APP: 'app:restart',
  QUIT_APP: 'app:quit',
  DELETE_ACCOUNT_AND_DATA: 'app:deleteAccountAndData',
  BACKUP_DATABASE: 'app:backupDatabase',
  RESTORE_DATABASE: 'app:restoreDatabase',
  RESTORE_DATABASE_FROM_FILE: 'app:restoreDatabaseFromFile',
  GET_FILE_METADATA: 'file:getMetadata',

  // File transfer
  SEND_FILE_REQUEST: 'file:send',
  ACCEPT_FILE: 'file:accept',
  REJECT_FILE: 'file:reject',
  CANCEL_FILE_DOWNLOAD: 'file:cancelDownload',
  GET_PENDING_FILES: 'file:getPending',
  OPEN_FILE_LOCATION: 'file:openLocation',

  // File transfer events
  FILE_TRANSFER_PROGRESS: 'file:progress',
  FILE_TRANSFER_COMPLETE: 'file:complete',
  FILE_TRANSFER_FAILED: 'file:failed',
  OUTGOING_FILE_OFFER_PENDING: 'file:outgoingOfferPending',
  PENDING_FILE_RECEIVED: 'file:pendingReceived',

  // Group chats
  GET_CONTACTS: 'group:getContacts',
  CREATE_GROUP: 'group:create',
  INVITE_USERS_TO_GROUP: 'group:inviteUsers',
  REINVITE_USER_TO_GROUP: 'group:reinviteUser',
  SEND_GROUP_MESSAGE_REQUEST: 'group:sendMessage',
  RETRY_GROUP_OFFLINE_BACKUP: 'group:retryOfflineBackup',
  GET_GROUP_MEMBERS: 'group:getMembers',
  GET_GROUP_INVITES: 'group:getInvites',
  RESPOND_TO_GROUP_INVITE: 'group:respondToInvite',
  REQUEST_GROUP_UPDATE: 'group:requestUpdate',
  LEAVE_GROUP: 'group:leave',
  DISBAND_GROUP: 'group:disband',
  KICK_GROUP_MEMBER: 'group:kickMember',
  GET_SUBSCRIBED_TOPICS: 'group:getSubscribedTopics',
  GROUP_CHAT_ACTIVATED: 'group:chatActivated',
  GROUP_MEMBERS_UPDATED: 'group:membersUpdated',
} as const;
