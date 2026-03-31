import type { MultiaddrConnection, PeerId, PeerInfo } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { KadDHT } from '@libp2p/kad-dht';
import type { Identify } from '@libp2p/identify';
import type { Ping } from '@libp2p/ping';
import type { GossipSub } from '@chainsafe/libp2p-gossipsub';
import type { Stream } from '@libp2p/interface';
import type { Connection } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';

// Core libp2p node with services
export interface ChatNode extends Libp2p {
  services: {
    dht: KadDHT
    identify: Identify
    ping: Ping
    pubsub: GossipSub
  }
}

export type NetworkMode = 'fast' | 'anonymous';

// Chat message structure
export interface ChatMessage {
  from: string
  content: string
  timestamp: number
}

export interface SendMessageResponse {
  success: boolean;
  message?: StrippedMessage | null;
  messageSentStatus: 'online' | 'offline' | null;
  error: string | null;
  warning?: string | null;
  offlineBackupRetry?: {
    chatId: number;
    messageId: string;
  } | null;
}

// We dont have to send sender info because we have it in the chat state
export interface StrippedMessage {
  chatId: number;
  messageId: string;
  content: string;
  timestamp: number;
  messageType: 'text' | 'file' | 'image' | 'system';
}

// Stream handler context
export interface StreamContext {
  stream: Stream
  connection: Connection
}

// Application error types
export interface ChatError extends Error {
  code?: string
  details?: any
}

// Network configuration
export interface NetworkConfig {
  readonly CHAT_PROTOCOL: string
  readonly DHT_PROTOCOL: string
  readonly DEFAULT_LISTEN_ADDRESS: string
  readonly BOOTSTRAP_PORT: number
  readonly BOOTSTRAP_LISTEN_ADDRESS: string
  readonly K_BUCKET_SIZE: number
  readonly PREFIX_LENGTH: number
  readonly REREGISTRATION_INTERVAL: number
  readonly PEER_DISCOVERY_INTERVAL: number
  readonly GREETING_DELAY: number
  readonly NETWORK_CHECK_DELAY: number
  readonly MESSAGE_TIMEOUT: number
  readonly PROMPT_DEFAULT: string
}

// Peer discovery event
export interface PeerConnectEvent {
  detail: PeerId
}

// Configuration constants type
export interface NetworkConfig {
  readonly CHAT_PROTOCOL: string
  readonly DHT_PROTOCOL: string
  readonly DEFAULT_LISTEN_ADDRESS: string
  readonly BOOTSTRAP_PORT: number
  readonly BOOTSTRAP_LISTEN_ADDRESS: string
  readonly K_BUCKET_SIZE: number
  readonly PREFIX_LENGTH: number
  readonly REREGISTRATION_INTERVAL: number
  readonly PEER_DISCOVERY_INTERVAL: number
  readonly GREETING_DELAY: number
  readonly NETWORK_CHECK_DELAY: number
  readonly MESSAGE_TIMEOUT: number
  readonly PROMPT_DEFAULT: string
}

// Command constants
export interface CommandConstants {
  // Core commands
  readonly PEERS: string;
  readonly REGISTER: string;
  readonly AUTO_REGISTER: string;
  readonly SEND: string;
  readonly SEND_FILE: string;
  readonly WHOAMI: string;
  readonly PING: string;
  readonly STATUS: string;
  readonly HELP: string;
  readonly HISTORY: string;
  readonly OFFLINE: string;
  // Backup commands
  readonly BACKUP: string;
  readonly RESTORE: string;
  readonly BACKUPS: string;
  // Profile export/import commands
  readonly EXPORT_PROFILE: string;
  readonly TRUST_USER: string;
  // Group commands
  readonly CREATE_GROUP: string;
  readonly SEND_GROUP: string;
  readonly GROUP_HISTORY: string;
  readonly NOTIFICATIONS: string;
  readonly ACCEPT: string;
  readonly REJECT: string;
  readonly CHECK_ROTATIONS: string;
  // Contact authorization commands
  readonly SET_CONTACT_MODE: string;
  readonly ACCEPT_USER: string;
  readonly REJECT_USER: string;
  readonly PENDING_CONTACTS: string;
  readonly CONTACT_LOG: string;
  readonly BLOCK_USER: string;
  readonly UNBLOCK_USER: string;
  readonly BLOCKED_USERS: string;
  // File management commands
  readonly ACCEPT_FILE: string;
  readonly REJECT_FILE: string;
  readonly PENDING_FILES: string;
  // User settings commands
  readonly SET_KEY_EXCHANGE_RATE_LIMIT: string;
}

// Error constants
export interface ErrorConstants {
  readonly USERNAME_TAKEN: string
  readonly USERNAME_NOT_FOUND: string
  readonly USERNAME_LOOKUP_FAILED: string
  readonly MESSAGE_TIMEOUT: string
  readonly CONNECTION_FAILED: string
  readonly NO_PEERS_FOUND: string
}

export interface UserRegistration {
  peerID: string
  timestamp: number
  username: string
  kind?: 'active' | 'released'
  signingPublicKey: string  // Ed25519 for signature verification
  offlinePublicKey: string // RSA for offline message encryption
  signature: string
}

// Message handling types
export interface ConversationSession {
  peerId: string
  ephemeralPrivateKey: Uint8Array
  ephemeralPublicKey: Uint8Array
  sendingKey: Uint8Array
  receivingKey: Uint8Array
  messageCount: number
  lastUsed: number
  lastRotated?: number
}

export interface PendingKeyExchange {
  timestamp: number
  ephemeralPrivateKey: Uint8Array
  ephemeralPublicKey: Uint8Array
}

export interface PendingAcceptance {
  resolve: (accepted: boolean) => void
  reject: (error: Error) => void
  timestamp: number
  receivedAt: number
  expiresAt: number
  username: string
  peerId?: string
  messageBody: string
}

export interface EncryptedMessage {
  type: 'encrypted' | 'key_exchange'
  content: string // Encrypted content, or key_exchange subtype marker for key exchange messages
  encryptedMessageBody?: string // RSA/hybrid encrypted initial message body (base64)
  encryptedMessageBodyType?: 'encrypted' | 'hybrid'
  encryptedMessageBodyKey?: string // hybrid only: RSA-encrypted AES key (base64)
  encryptedMessageBodyIv?: string // hybrid only: AES-GCM IV (base64)
  linkIntent?: 'initial' | 'resume'
  linkDecision?: 'accepted' | 'reset_required'
  nonce?: string // For encrypted messages
  senderPublicKey?: string // Sender's encryption public key
  ephemeralPublicKey?: string // For key exchange
  timestamp: number
  senderUsername: string // Username of sender
  offline_ack_timestamp?: number // ACK for offline messages we've read from sender's bucket
}

export interface AuthenticatedEncryptedMessage extends EncryptedMessage {
  signature?: string // Digital signature for authentication
}

export interface StreamHandlerContext {
  stream: Stream
  connection: Connection
}

// Offline message signed payload (what gets signed for DHT validation)
export interface OfflineSignedPayload {
  content_hash: string       // SHA256 of encrypted content (base64)
  sender_info_hash: string   // SHA256 of encrypted sender info (base64)
  timestamp: number
  bucket_key: string         // Full bucket key for binding
}

// Offline message types
export interface OfflineMessage {
  id: string // UUID to prevent duplicates
  encrypted_sender_info: string // RSA-encrypted JSON: {peer_id: string, username: string}
  bucket_key?: string // For internal tracking during retrieval
  content: string // RSA-encrypted ('encrypted') or AES-GCM ciphertext+authTag ('hybrid')
  signature: string // Ed25519 signature over signed_payload (base64)
  signed_payload: OfflineSignedPayload // The payload that was signed (for verification)
  message_type: 'encrypted' | 'hybrid'
  encrypted_aes_key?: string // hybrid only: RSA-encrypted 32-byte AES key (base64)
  aes_iv?: string            // hybrid only: 12-byte AES-GCM IV (base64)
  timestamp: number
  expires_at: number // TTL
}

// Decrypted sender info structure
export interface OfflineSenderInfo {
  peer_id: string
  username: string
  offline_ack_timestamp?: number // ACK for messages we've read from this peer's bucket
}

// Store signed payload - the bucket owner signs the entire store state
export interface StoreSignedPayload {
  message_ids: string[]
  version: number
  timestamp: number
  bucket_key: string
}

export interface OfflineMessageStore {
  messages: OfflineMessage[]
  last_updated: number
  version: number // for conflict resolution
  store_signature: string           // Ed25519 signature over store_signed_payload
  store_signed_payload: StoreSignedPayload  // The payload that was signed
}

// File Transfer Types
export type FileTransferStatus =
  | 'pending'
  | 'connecting'
  | 'awaiting_acceptance'
  | 'incoming_pending_user'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'rejected';

export interface FileOffer {
  type: 'file_offer'
  fileId: string
  filename: string
  mimeType: string
  size: number
  checksum: string      // BLAKE3 of full file
  totalChunks: number
  timestamp?: number
  expiresAt?: number
  signature?: string
}

export interface FileOfferResponse {
  type: 'file_offer_response'
  fileId: string
  accepted: boolean
  reason?: string
}

export interface FileChunk {
  type: 'file_chunk'
  fileId: string
  index: number
  nonce: string         // base64
  data: string          // base64 encrypted
  hash: string          // BLAKE3 of plaintext chunk
}

export interface FileTransferConfirm {
  type: 'file_transfer_confirm'
  fileId: string
  success: boolean
  error?: string
}

export type FileTransferMessage = FileOffer | FileOfferResponse | FileChunk | FileTransferConfirm

export type ContactMode = 'active' | 'silent' | 'block'

export type MessageToVerify = {
  type: 'key_exchange';
  content:
    'key_exchange_init' |
    'key_exchange_response' |
    'key_exchange_rejected' |
    'key_exchange_confirmed' |
    'key_exchange_cancelled' |
    'key_rotation' |
    'key_rotation_response';
  ephemeralPublicKey: string;
  senderUsername: string;
  timestamp: number;
  encryptedMessageBody?: string;
  encryptedMessageBodyType?: 'encrypted' | 'hybrid';
  encryptedMessageBodyKey?: string;
  encryptedMessageBodyIv?: string;
  linkIntent?: 'initial' | 'resume';
  linkDecision?: 'accepted' | 'reset_required';
}

// User Profile Export/Import
export interface UserProfilePlaintext {
  version: number;
  username: string;
  peerId: string;
  signingPublicKey: string;
  offlinePublicKey: string;
  notificationsPublicKey: string;
  defaultInboxKey: string;
  createdAt: number;
  signature: string;
}

export interface EncryptedUserProfile {
  version: number;
  salt: string;
  nonce: string;
  encryptedData: string;
}

export interface ConnectionGater {
  /**
   * denyDialPeer tests whether we're permitted to Dial the
   * specified peer.
   *
   * This is called by the dialer.connectToPeer implementation before
   * dialling a peer.
   *
   * Return true to prevent dialing the passed peer.
   */
  denyDialPeer?(peerId: PeerId): Promise<boolean> | boolean

  /**
   * denyDialMultiaddr tests whether we're permitted to dial the specified
   * multiaddr.
   *
   * This is called by the connection manager - if the peer id of the remote
   * node is known it will be present in the multiaddr.
   *
   * Return true to prevent dialing the passed peer on the passed multiaddr.
   */
  denyDialMultiaddr?(multiaddr: Multiaddr): Promise<boolean> | boolean

  /**
   * denyInboundConnection tests whether an incipient inbound connection is allowed.
   *
   * This is called by the upgrader, or by the transport directly (e.g. QUIC,
   * Bluetooth), straight after it has accepted a connection from its socket.
   *
   * Return true to deny the incoming passed connection.
   */
  denyInboundConnection?(maConn: MultiaddrConnection): Promise<boolean> | boolean

  /**
   * denyOutboundConnection tests whether an incipient outbound connection is allowed.
   *
   * This is called by the upgrader, or by the transport directly (e.g. QUIC,
   * Bluetooth), straight after it has created a connection with its socket.
   *
   * Return true to deny the incoming passed connection.
   */
  denyOutboundConnection?(peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> | boolean

  /**
   * denyInboundEncryptedConnection tests whether a given connection, now encrypted,
   * is allowed.
   *
   * This is called by the upgrader, after it has performed the security
   * handshake, and before it negotiates the muxer, or by the directly by the
   * transport, at the exact same checkpoint.
   *
   * Return true to deny the passed secured connection.
   */
  denyInboundEncryptedConnection?(peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> | boolean

  /**
   * denyOutboundEncryptedConnection tests whether a given connection, now encrypted,
   * is allowed.
   *
   * This is called by the upgrader, after it has performed the security
   * handshake, and before it negotiates the muxer, or by the directly by the
   * transport, at the exact same checkpoint.
   *
   * Return true to deny the passed secured connection.
   */
  denyOutboundEncryptedConnection?(peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> | boolean

  /**
   * denyInboundUpgradedConnection tests whether a fully capable connection is allowed.
   *
   * This is called after encryption has been negotiated and the connection has been
   * multiplexed, if a multiplexer is configured.
   *
   * Return true to deny the passed upgraded connection.
   */
  denyInboundUpgradedConnection?(peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> | boolean

  /**
   * denyOutboundUpgradedConnection tests whether a fully capable connection is allowed.
   *
   * This is called after encryption has been negotiated and the connection has been
   * multiplexed, if a multiplexer is configured.
   *
   * Return true to deny the passed upgraded connection.
   */
  denyOutboundUpgradedConnection?(peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> | boolean

  /**
   * denyInboundRelayReservation tests whether a remote peer is allowed make a
   * relay reservation on this node.
   *
   * Return true to deny the relay reservation.
   */
  denyInboundRelayReservation?(source: PeerId): Promise<boolean> | boolean

  /**
   * denyOutboundRelayedConnection tests whether a remote peer is allowed to open a relayed
   * connection to the destination node.
   *
   * This is invoked on the relay server when a source client with a reservation instructs
   * the server to relay a connection to a destination peer.
   *
   * Return true to deny the relayed connection.
   */
  denyOutboundRelayedConnection?(source: PeerId, destination: PeerId): Promise<boolean> | boolean

  /**
   * denyInboundRelayedConnection tests whether a remote peer is allowed to open a relayed
   * connection to this node.
   *
   * This is invoked on the relay client when a remote relay has received an instruction to
   * relay a connection to the client.
   *
   * Return true to deny the relayed connection.
   */
  denyInboundRelayedConnection?(relay: PeerId, remotePeer: PeerId): Promise<boolean> | boolean

  /**
   * Used by the address book to filter passed addresses.
   *
   * Return true to allow storing the passed multiaddr for the passed peer.
   */
  filterMultiaddrForPeer?(peer: PeerId, multiaddr: Multiaddr): Promise<boolean> | boolean
}

/**
 * IPC channel names for Electron IPC communication
 */
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
  NOTIFICATIONS_ENABLED_CHANGED: 'settings:notificationsEnabledChanged',
  GET_DOWNLOADS_DIR: 'settings:getDownloadsDir',
  SET_DOWNLOADS_DIR: 'settings:setDownloadsDir',
  GET_TOR_SETTINGS: 'settings:getTorSettings',
  SET_TOR_SETTINGS: 'settings:setTorSettings',
  GET_APP_CONFIG: 'settings:getAppConfig',
  SET_APP_CONFIG: 'settings:setAppConfig',
  GET_ICE_SERVERS: 'settings:getIceServers',
  SET_ICE_SERVERS: 'settings:setIceServers',
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

  // Tor status
  TOR_STATUS: 'tor:status',
  GET_TOR_STATUS: 'tor:getStatus',

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

export interface PasswordRequest {
  prompt: string;
  isNewPassword?: boolean;
  recoveryPhrase?: string;
  prefilledPassword?: string;
  errorMessage?: string;
  cooldownSeconds?: number;
  cooldownUntil?: number;
  showRecoveryOption?: boolean;
  keychainAvailable?: boolean;
}

export interface PasswordResponse {
  password: string;
  rememberMe: boolean;
  useRecoveryPhrase?: boolean;
}

export interface InitStatus {
  message: string;
  stage: 'tor' | 'database' | 'identity' | 'node' | 'registry' | 'messaging' | 'complete' | 'peerId';
}

export interface TorStatus {
  isRunning: boolean;
  onionAddress: string | null;
  socksPort: number;
  controlPort: number;
  bootstrapProgress: number;
}

export interface KeyExchangeEvent {
  username: string;
  peerId: string;
  messageContent?: string;
  expiresAt: number;
}

export interface ContactRequestEvent {
  peerId: string;
  username: string;
  message: string;
  messageBody?: string;
  receivedAt: number;
  expiresAt: number;
}

export interface ContactRequestCancelledEvent {
  peerId: string;
  username: string;
}

export interface ChatCreatedEvent {
  chatId: number;
  peerId: string;
  username: string;
}

export interface GroupChatActivatedEvent {
  chatId: number;
}

export interface GroupMembersUpdatedEvent {
  chatId: number;
  groupId: string;
  memberPeerId: string;
}

export interface GroupOfflineGapWarning {
  chatId: number;
  groupId: string;
  keyVersion: number;
  senderPeerId: string;
  expectedSeq: number;
  actualSeq: number;
}

export interface AppConfig {
  // Basic settings
  chatsToCheckForOfflineMessages: number;
  keyExchangeRateLimit: number;
  offlineMessageLimit: number;

  // Advanced settings
  maxFileSize: number; // in bytes
  fileOfferRateLimit: number;
  maxPendingFilesPerPeer: number;
  maxPendingFilesTotal: number;
  silentRejectionThresholdGlobal: number;
  silentRejectionThresholdPerPeer: number;
}

export type IceServerType = 'stun' | 'turn' | 'turns';

export interface IceServerConfig {
  id: string;
  type: IceServerType;
  url: string;
  username?: string;
  credential?: string;
}

export type IceServersResponse = {
  success: boolean;
  servers: IceServerConfig[];
  error: string | null;
};

export interface KeyExchangeFailedEvent {
  peerId: string;
  username: string;
  error: string;
}

export interface MessageReceivedEvent {
  chatId: number;
  messageId: string;
  content: string;
  senderPeerId: string;
  senderUsername: string;
  timestamp: number;
  eventTimestamp?: number;
  messageSentStatus: MessageSentStatus;
  messageType?: 'text' | 'file' | 'image' | 'system';
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  transferStatus?: FileTransferStatus;
  transferProgress?: number;
  transferError?: string;
}

export type MessageSentStatus = 'online' | 'offline' | null;

export interface FileTransferProgressEvent {
  chatId: number;
  messageId: string;
  current: number;
  total: number;
  filename: string;
  size: number;
}

export interface FileTransferCompleteEvent {
  chatId: number;
  messageId: string;
  filePath: string;
}

export interface FileTransferFailedEvent {
  chatId: number;
  messageId: string;
  error: string;
}

export interface OutgoingFileOfferPendingEvent {
  chatId: number;
  messageId: string;
  expiresAt: number;
}

export interface PendingFileReceivedEvent {
  chatId: number;
  fileId: string;
  filename: string;
  size: number;
  senderId: string;
  senderUsername: string;
  expiresAt: number;
}

export type CallSignalType =
  | 'CALL_OFFER'
  | 'CALL_ANSWER'
  | 'CALL_ICE'
  | 'CALL_REJECT'
  | 'CALL_END'
  | 'CALL_BUSY';

export type CallMediaType = 'audio' | 'video';

type BaseCallSignal = {
  type: CallSignalType;
  callId: string;
  fromPeerId: string;
  toPeerId: string;
  timestamp: number;
  signature: string;
};

export type CallOfferSignal = BaseCallSignal & {
  type: 'CALL_OFFER';
  offerSdp: string;
  mediaType: CallMediaType;
};

export type CallAnswerSignal = BaseCallSignal & {
  type: 'CALL_ANSWER';
  answerSdp: string;
};

export type CallIceSignal = BaseCallSignal & {
  type: 'CALL_ICE';
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
};

export type CallRejectSignal = BaseCallSignal & {
  type: 'CALL_REJECT';
  reason: 'rejected' | 'timeout' | 'offline' | 'policy';
};

export type CallEndSignal = BaseCallSignal & {
  type: 'CALL_END';
  reason: 'hangup' | 'disconnect' | 'failed';
};

export type CallBusySignal = BaseCallSignal & {
  type: 'CALL_BUSY';
  reason: 'busy';
};

export type CallSignalMessage =
  | CallOfferSignal
  | CallAnswerSignal
  | CallIceSignal
  | CallRejectSignal
  | CallEndSignal
  | CallBusySignal;

export type UnsignedCallSignalMessage =
  | Omit<CallOfferSignal, 'signature'>
  | Omit<CallAnswerSignal, 'signature'>
  | Omit<CallIceSignal, 'signature'>
  | Omit<CallRejectSignal, 'signature'>
  | Omit<CallEndSignal, 'signature'>
  | Omit<CallBusySignal, 'signature'>;

export type CallSignalOutgoingInput =
  | {
    type: 'CALL_OFFER';
    callId: string;
    toPeerId: string;
    offerSdp: string;
    mediaType: CallMediaType;
    timestamp?: number;
  }
  | {
    type: 'CALL_ANSWER';
    callId: string;
    toPeerId: string;
    answerSdp: string;
    timestamp?: number;
  }
  | {
    type: 'CALL_ICE';
    callId: string;
    toPeerId: string;
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;
    timestamp?: number;
  }
  | {
    type: 'CALL_REJECT';
    callId: string;
    toPeerId: string;
    reason: 'rejected' | 'timeout' | 'offline' | 'policy';
    timestamp?: number;
  }
  | {
    type: 'CALL_END';
    callId: string;
    toPeerId: string;
    reason: 'hangup' | 'disconnect' | 'failed';
    timestamp?: number;
  }
  | {
    type: 'CALL_BUSY';
    callId: string;
    toPeerId: string;
    reason: 'busy';
    timestamp?: number;
  };

export interface CallIncomingEvent {
  signal: CallOfferSignal;
  receivedAt: number;
}

export interface CallSignalReceivedEvent {
  signal: Exclude<CallSignalMessage, CallOfferSignal>;
  receivedAt: number;
}

export interface CallStateChangedEvent {
  callId: string;
  peerId: string;
  state: 'idle' | 'ringing_out' | 'ringing_in' | 'connecting' | 'active' | 'ended';
  direction: 'incoming' | 'outgoing';
  mediaType?: CallMediaType;
  reason?: string;
  timestamp: number;
}

export interface CallErrorEvent {
  error: string;
  peerId?: string;
  callId?: string;
  code?: string;
  timestamp: number;
}


export type DhtAdmissionApi = {
  routingTable: { size: number };
  onPeerConnect: (peerData: PeerInfo) => Promise<void>;
};

export type BootstrapConnectOptions = {
  signal?: AbortSignal;
};

export type BootstrapAddressResolution = {
  networkMode: NetworkMode;
  addresses: string[];
};

export type BootstrapAttempt = {
  address: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};

export type BootstrapConnection = {
  address: string;
  remotePeer: PeerId | undefined;
};

export type BootstrapConnectResult = {
  status: 'connected' | 'all_failed' | 'no_candidates' | 'aborted';
  connectedAddresses: string[];
  connectedPeerIds: string[];
  connectedCount: number;
  targetConnectionCount: number;
  targetReached: boolean;
  attempts: BootstrapAttempt[];
};

export type ConnectionNodeStatus = {
  address: string;
  connected: boolean;
};

export type ConnectionNodesResponse = {
  success: boolean;
  nodes: ConnectionNodeStatus[];
  error: string | null;
};

export type BootstrapRetryResponse = {
  success: boolean;
  result: BootstrapConnectResult | null;
  error: string | null;
};

export type RelayRetryResponse = {
  success: boolean;
  attempted: number;
  connected: number;
  error: string | null;
};

export type TorBootstrapTarget = {
  host: string;
  port: number;
};
