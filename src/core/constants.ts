import type { CommandConstants, ErrorConstants, NetworkMode } from './types.js';

/*
 * Network mode constants and mode-specific identifiers.
 */

export const NETWORK_MODES = {
  FAST: 'fast',
  ANONYMOUS: 'anonymous',
} as const;

export const DEFAULT_NETWORK_MODE: NetworkMode = NETWORK_MODES.FAST;
export const NETWORK_MODE_SETTING_KEY = 'network_mode';
export const NETWORK_MODE_ONBOARDED_SETTING_KEY = 'network_mode_onboarded';
export const FAST_RELAY_MULTIADDRS_SETTING_KEY = 'fast_relay_multiaddrs';
export const FAST_RELAY_MULTIADDRS_INITIALIZED_SETTING_KEY = 'fast_relay_multiaddrs_initialized';
export const WEBRTC_ICE_SERVERS_SETTING_KEY = 'webrtc_ice_servers';
export const FAST_MISSING_ICE_WARNING_ACKNOWLEDGED_SETTING_KEY = 'setup_missing_ice_warning_acknowledged_fast';
// Persisted "one-time" flag for the predefined-nodes sunset notice: once the
// user dismisses the shutdown notice it is never shown again.
export const PREDEFINED_NODES_SUNSET_DISMISSED_SETTING_KEY = 'predefined_nodes_sunset_dismissed';

/*
 * System tray behavior settings (Windows/Linux). Read/written pre-login via
 * withSettingsDatabase() since they must be available before the identity is
 * unlocked (e.g. hiding to tray from the lock/password screen).
 */
export const CLOSE_TO_TRAY_SETTING_KEY = 'close_to_tray_enabled';
export const MINIMIZE_TO_TRAY_SETTING_KEY = 'minimize_to_tray_enabled';
// One-time "still running in the tray" OS notification, shown at most once ever.
export const TRAY_BACKGROUND_NOTICE_SHOWN_SETTING_KEY = 'tray_background_notice_shown';

export type ModeNamespaceKind =
  | 'offline'
  | 'username'
  | 'groupOffline'
  | 'groupInfoLatest'
  | 'groupInfoVersion';

export interface NetworkModeConfig {
  protocolName: string;
  chatProtocol: string;
  callSignalProtocol: string;
  bootstrapProtocol: string;
  fileTransferProtocol: string;
  bucketNudgeProtocol: string;
  dhtProtocol: string;
  dhtNamespaces: Record<ModeNamespaceKind, string>;
  pubsubTopicPrefix: string;
}

export interface NetworkModeRuntime {
  mode: NetworkMode;
  config: NetworkModeConfig;
  dhtNamespaceNames: ReturnType<typeof getDhtNamespaceNamesForMode>;
  dhtKeyPrefixes: ReturnType<typeof getDhtKeyPrefixesForMode>;
  buildDhtKey: (kind: ModeNamespaceKind, ...parts: Array<string | number>) => string;
  buildPubsubTopic: (topic: string) => string;
}

function buildModeConfig(baseProtocol: string, namespacePrefix: string, topicPrefix: string): NetworkModeConfig {
  return {
    protocolName: baseProtocol,
    chatProtocol: `${baseProtocol}/chat`,
    callSignalProtocol: `${baseProtocol}/call-signal`,
    bootstrapProtocol: `${baseProtocol}/bootstrap`,
    fileTransferProtocol: `${baseProtocol}/file-transfer`,
    bucketNudgeProtocol: `${baseProtocol}/bucket-nudge`,
    dhtProtocol: `${baseProtocol}/dht`,
    dhtNamespaces: {
      offline: `${namespacePrefix}-offline`,
      username: `${namespacePrefix}-username`,
      groupOffline: `${namespacePrefix}-group-offline`,
      groupInfoLatest: `${namespacePrefix}-group-info-latest`,
      groupInfoVersion: `${namespacePrefix}-group-info-v`,
    },
    pubsubTopicPrefix: topicPrefix,
  };
}

export const NETWORK_MODE_CONFIG: Record<NetworkMode, NetworkModeConfig> = {
  fast: buildModeConfig('/kiyeovo-fast/1.0.0', '/kiyeovo-fast', 'kiyeovo-fast'),
  anonymous: buildModeConfig('/kiyeovo/1.0.0', '/kiyeovo', 'kiyeovo'),
};

export function getDhtNamespaceNamesForMode(mode: NetworkMode) {
  const namespaces = getNetworkModeConfig(mode).dhtNamespaces;
  return {
    offline: namespaces.offline.replace(/^\//, ''),
    username: namespaces.username.replace(/^\//, ''),
    groupOffline: namespaces.groupOffline.replace(/^\//, ''),
    groupInfoLatest: namespaces.groupInfoLatest.replace(/^\//, ''),
    groupInfoVersion: namespaces.groupInfoVersion.replace(/^\//, ''),
  } as const;
}

export function getDhtKeyPrefixesForMode(mode: NetworkMode) {
  const namespaces = getNetworkModeConfig(mode).dhtNamespaces;
  return {
    offline: `${namespaces.offline}/`,
    username: `${namespaces.username}/`,
    groupOffline: `${namespaces.groupOffline}/`,
    groupInfoLatest: `${namespaces.groupInfoLatest}/`,
    groupInfoVersion: `${namespaces.groupInfoVersion}/`,
  } as const;
}

export function getNetworkModeConfig(mode: NetworkMode): NetworkModeConfig {
  return NETWORK_MODE_CONFIG[mode];
}

export function isNetworkMode(value: unknown): value is NetworkMode {
  return value === NETWORK_MODES.FAST || value === NETWORK_MODES.ANONYMOUS;
}

export function getInitialSetupStatusSettingKey(mode: NetworkMode): string {
  return `initial_setup_status_${mode}_v1`;
}

export function buildModeDhtKey(mode: NetworkMode, kind: ModeNamespaceKind, ...parts: Array<string | number>): string {
  const namespace = getNetworkModeConfig(mode).dhtNamespaces[kind];
  const suffix = parts
    .map(part => String(part).trim())
    .filter(Boolean)
    .map(part => part.replace(/^\/+|\/+$/g, ''));
  return suffix.length > 0 ? `${namespace}/${suffix.join('/')}` : namespace;
}

export function buildModePubsubTopic(mode: NetworkMode, topic: string): string {
  return `${getNetworkModeConfig(mode).pubsubTopicPrefix}/${topic.replace(/^\/+/, '')}`;
}

export function getNetworkModeRuntime(mode: NetworkMode): NetworkModeRuntime {
  return {
    mode,
    config: getNetworkModeConfig(mode),
    dhtNamespaceNames: getDhtNamespaceNamesForMode(mode),
    dhtKeyPrefixes: getDhtKeyPrefixesForMode(mode),
    buildDhtKey: (kind: ModeNamespaceKind, ...parts: Array<string | number>) =>
      buildModeDhtKey(mode, kind, ...parts),
    buildPubsubTopic: (topic: string) => buildModePubsubTopic(mode, topic),
  };
}

/**
 * Protocol and network constants
 */
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const BUCKET_NUDGE_COOLDOWN_MS = 5 * SECOND;
// Per-stage budget for opening the bucket-nudge stream (both the connection-reuse
// newStream and the fresh dialProtocol fallback). Mode-aware: 5s is fine over a
// warm fast-mode connection, but a cold/slow Tor onion circuit routinely needs
// 10-30s to build — a 5s cap aborts mid-handshake and the nudge's frames can land
// on the recipient long after the sender gave up (a reset the recipient then reads
// as a failure). Anonymous mode matches the codebase's other Tor budgets
// (ANONYMOUS_BOOTSTRAP_ADDRESS_TIMEOUT_MS = 20s, file-pull first-frame anon = 30s).
// Worst case reuse+dial run serially = 2× this, but the send is fire-and-forget
// (see sendBucketNudge) so it blocks nothing user-facing.
export const BUCKET_NUDGE_DIAL_TIMEOUT_FAST_MS = 5 * SECOND;
export const BUCKET_NUDGE_DIAL_TIMEOUT_ANONYMOUS_MS = 20 * SECOND;
export const BUCKET_NUDGE_FETCH_DELAY_MS = 4 * SECOND;
export const DIRECT_OFFLINE_REFETCH_DELAY_MS = 500;
export const DIRECT_OFFLINE_INBOX_RECOVERY_COOLDOWN_MS = 5 * SECOND;
export const DIRECT_OFFLINE_INBOX_RECOVERY_RECHECK_DELAY_MS = 5 * SECOND;
export const BUCKET_NUDGE_RETRY_DELAY_MS = 30 * SECOND;

/**
 * Network configuration
 */
export const DEFAULT_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/0';
export const BOOTSTRAP_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/9000';
export const DEFAULT_LISTEN_PORT = 0; // Random port
export const BOOTSTRAP_PORT = 9000; // Default TCP port for the dedicated bootstrap node

/**
 * DHT settings
 */
export const USERNAME_RECORD_PREFIX = 'kiyeovo-user-';
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_REGEX = /^[A-Za-z0-9_]+$/;
// Username records are small signed JSON blobs; 8 KiB leaves generous headroom
// while rejecting oversized values before JSON parsing.
export const USERNAME_RECORD_MAX_BYTES = 8 * 1024;
export const K_BUCKET_SIZE = 20; // Kademlia bucket size for routing table maintenance
export const PREFIX_LENGTH = 6; // Kademlia routing-table prefix length
export const MDNS_SERVICE_TAG = 'kiyeovo.local';

/**
 * Timing configuration
 */
export const REREGISTRATION_INTERVAL = 5 * MINUTE;  // 5 minutes
// Poll our own publishable addresses this often; re-register once a *changed*
// set has held for REGISTRATION_ADDRESS_STABLE_ROUNDS consecutive polls (so a
// transient relay-handoff blip doesn't publish a half-formed/empty address set).
export const REGISTRATION_ADDRESS_CHECK_INTERVAL = 5 * SECOND;
export const REGISTRATION_ADDRESS_STABLE_ROUNDS = 2;
// After bootstrap connectivity is (re)established, re-publish the username
// registration once, debounced by this delay so a reconnect + post-retry-verify
// burst collapses into a single republish (bootstrap-switch discoverability).
export const BOOTSTRAP_RECONNECT_REPUBLISH_DEBOUNCE_MS = 5 * SECOND; // 5 seconds
export const PEER_DISCOVERY_INTERVAL = 1 * MINUTE;  // 1 minute
export const GREETING_DELAY = 1 * SECOND;           // 1 second
export const NETWORK_CHECK_DELAY = 3 * SECOND;      // 3 seconds
export const MESSAGE_TIMEOUT = 10 * SECOND;         // 10 seconds
export const MAX_KEY_EXCHANGE_AGE = 5 * MINUTE;     // 5 minutes
export const KEY_EXCHANGE_MAX_FUTURE_SKEW_MS = 2 * MINUTE; // 2 minutes
export const USERNAME_MAX_FUTURE_SKEW_MS = 2 * MINUTE;     // 2 minutes
export const ROTATION_COOLDOWN = 30 * SECOND;       // 30 seconds - min time between rotations
export const RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW = 5 * MINUTE; // 5 minutes
/**
 * Other
 */
export const KEY_EXCHANGE_RATE_LIMIT_DEFAULT = 10; // Default max key-exchange attempts per rate-limit window
/**
 * UI constants
 */
export const PROMPT_DEFAULT = '> ';
export const COMMANDS: CommandConstants = {
  // Core commands
  PEERS: 'peers',
  REGISTER: 'register',
  AUTO_REGISTER: 'auto-register',
  SEND: 'send',
  SEND_FILE: 'send-file',
  WHOAMI: 'whoami',
  PING: 'ping',
  STATUS: 'status',
  HELP: 'help',
  HISTORY: 'history',
  OFFLINE: 'offline',
  // Backup commands
  BACKUP: 'backup',
  RESTORE: 'restore',
  BACKUPS: 'backups',
  // Group commands
  CREATE_GROUP: 'create-group',
  SEND_GROUP: 'send-group',
  GROUP_HISTORY: 'group-history',
  NOTIFICATIONS: 'notifications',
  ACCEPT: 'accept',
  REJECT: 'reject',
  CHECK_ROTATIONS: 'check-rotations',
  // Contact authorization commands
  SET_CONTACT_MODE: 'set-contact-mode',
  ACCEPT_USER: 'accept-user',
  REJECT_USER: 'reject-user',
  PENDING_CONTACTS: 'pending-contacts',
  CONTACT_LOG: 'contact-log',
  BLOCK_USER: 'block-user',
  UNBLOCK_USER: 'unblock-user',
  BLOCKED_USERS: 'blocked-users',
  // File transfer commands
  ACCEPT_FILE: 'accept-file',
  REJECT_FILE: 'reject-file',
  PENDING_FILES: 'pending-files',
  // User settings commands
  SET_KEY_EXCHANGE_RATE_LIMIT: 'set-key-exchange-rate-limit',
  // Profile export/import commands
  EXPORT_PROFILE: 'export-profile',
  TRUST_USER: 'trust-user',
} as const;

/**
 * Error messages
 */
export const ERRORS: ErrorConstants = {
  USERNAME_TAKEN: 'Username already taken',
  USERNAME_NOT_FOUND: 'Username not found',
  USERNAME_LOOKUP_FAILED: 'Username lookup failed',
  MESSAGE_TIMEOUT: 'Message timeout',
  CONNECTION_FAILED: 'Connection failed',
  NO_PEERS_FOUND: 'No peers found'
} as const;

/**
 * Static peer ID files
 */
export const BOOTSTRAP_PEER_ID_FILE = './bootstrap-peer-id.bin';

/**
 * Tor configuration constants
 *
 * Bundled Tor uses ports 9550/9551 to avoid conflicts with:
 * - System Tor (9050/9051)
 * - Tor Browser (9150/9151)
 */
export const TOR_CONFIG = {
  // Bundled Tor ports live in transport/tor-manager.ts (BUNDLED_TOR_SOCKS_PORT /
  // BUNDLED_TOR_CONTROL_PORT), the single source of truth used to configure the daemon.

  // Default ports (fallback, or for system Tor)
  DEFAULT_SOCKS_HOST: '127.0.0.1',
  DEFAULT_SOCKS_PORT: 9550,
  DEFAULT_CONNECTION_TIMEOUT: 30 * SECOND, // 30 seconds
  DEFAULT_CIRCUIT_TIMEOUT: 1 * MINUTE,     // 60 seconds
  DEFAULT_MAX_RETRIES: 3,
  DEFAULT_HEALTH_CHECK_INTERVAL: 1 * MINUTE, // 60 seconds
  DNS_RESOLUTION_TOR: 'tor',
  DNS_RESOLUTION_SYSTEM: 'system'
} as const;

/**
 * Environment variable helpers for Tor configuration
 */
export const getTorConfig = (): {
  socksHost: string;
  socksPort: number;
  connectionTimeout: number;
  circuitTimeout: number;
  maxRetries: number;
  healthCheckInterval: number;
  dnsResolution: 'tor' | 'system';
} => ({
  socksHost: process.env.TOR_SOCKS_HOST ?? TOR_CONFIG.DEFAULT_SOCKS_HOST,
  socksPort: parseInt(process.env.TOR_SOCKS_PORT ?? TOR_CONFIG.DEFAULT_SOCKS_PORT.toString(), 10),
  connectionTimeout: parseInt(process.env.TOR_CONNECTION_TIMEOUT ?? TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT.toString(), 10),
  circuitTimeout: parseInt(process.env.TOR_CIRCUIT_TIMEOUT ?? TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT.toString(), 10),
  maxRetries: parseInt(process.env.TOR_MAX_RETRIES ?? TOR_CONFIG.DEFAULT_MAX_RETRIES.toString(), 10),
  healthCheckInterval: parseInt(process.env.TOR_HEALTH_CHECK_INTERVAL ?? TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL.toString(), 10),
  dnsResolution: (process.env.TOR_DNS_RESOLUTION as 'tor' | 'system' | undefined) ?? TOR_CONFIG.DNS_RESOLUTION_TOR
});

export const GROUP_DEADLINE = 6 * HOUR; // 6 hours
export const KEY_ROTATION_CHECK_INTERVAL = 10 * MINUTE; // 10 minutes
export const SESSION_MANAGER_CLEANUP_INTERVAL = 1 * MINUTE; // 1 minute
export const KEEP_ALIVE_INTERVAL = 90 * SECOND; // 90 seconds
export const RELAY_KEEP_ALIVE_INTERVAL = KEEP_ALIVE_INTERVAL; // 90 seconds
export const RELAY_KEEP_ALIVE_START_DELAY = 30 * SECOND; // 30 seconds
export const RELAY_KEEP_ALIVE_PING_TIMEOUT = 10 * SECOND; // 10 seconds
// After an OS resume, all connections (incl. the relay reservation) are torn down
// and re-established. A send fired inside this window can otherwise burn its whole
// dial budget on a not-yet-ready relay and get demoted to offline even though the
// peer is online. Sends within RESUME_RELAY_GRACE_MS of a resume wait up to
// RESUME_RELAY_READY_WAIT_MS (polling every RESUME_RELAY_READY_POLL_MS, after
// nudging a refresh) for the relay reservation to return before attempting online.
export const RESUME_RELAY_GRACE_MS = 30 * SECOND;
export const RESUME_RELAY_READY_WAIT_MS = 12 * SECOND;
export const RESUME_RELAY_READY_POLL_MS = 250; // 0.25 seconds
export const OFFLINE_MESSAGE_LIMIT = 50; // 50 messages
export const OFFLINE_MESSAGE_CHECK_INTERVAL = 5 * MINUTE; // 5 minutes
export const KEY_ROTATION_TIMEOUT = 30 * SECOND; // 30 seconds
export const PENDING_KEY_EXCHANGE_EXPIRATION = 5 * MINUTE; // 5 minutes
// Responder-side deadline for the initiator's confirmed/cancelled after the responder sends its
// key-exchange response. This wait covers a full peer-side round-trip: the initiator reads the
// response, verifies its signature (which may fall back to a DHT lookup) and replies. It must
// therefore be on the order of a single inbound-read deadline plus a DHT round-trip, not a few
// seconds — a too-tight bound drops the accepting side's request while the initiator is still
// legitimately verifying. Overridable per-install via KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY.
export const KEY_EXCHANGE_FOLLOWUP_TIMEOUT_FAST_MS = 30 * SECOND;
export const KEY_EXCHANGE_FOLLOWUP_TIMEOUT_ANONYMOUS_MS = 45 * SECOND;
export const KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY = 'key_exchange_followup_timeout_ms';
export const KEY_EXCHANGE_FOLLOWUP_TIMEOUT_MIN_MS = 5 * SECOND;
export const KEY_EXCHANGE_FOLLOWUP_TIMEOUT_MAX_MS = 120 * SECOND;
export const DATABASE_CLEANUP_INTERVAL = 30 * MINUTE; // 30 minutes
export const MAX_MESSAGES_PER_STORE = 41; // Hard cap for one offline DHT store payload (incl. ack reserve)
export const OFFLINE_CONTROL_MESSAGE_RESERVE = 10; // Slots reserved for offline control traffic
export const OFFLINE_ACK_RESERVE = 1; // Slot reserved for a standalone (superseding) offline ACK
// Defensive cap to reject direct offline DHT values before gzip inflation.
export const DIRECT_OFFLINE_STORE_MAX_COMPRESSED_BYTES = 64 * 1024; // 64KB
// Cap on the *decompressed* size so a compression bomb (~1030:1 DEFLATE ratio on
// a 64KB value ≈ 66MB) cannot exhaust memory during gunzip. Real stores are mostly
// incompressible base64 ciphertext, so 2MiB is >30x headroom over any legit store.
export const DIRECT_OFFLINE_STORE_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024; // 2MiB
export const MESSAGE_TTL = 7 * DAY; // 7 days
export const OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS = 2 * MINUTE; // 2 minutes
export const OFFLINE_ACK_MAX_FUTURE_SKEW_MS = 10 * MINUTE; // 10 minutes
export const CRYPTO_TIMEOUT = 1 * MINUTE; // 60 seconds
export const IDENTITY_SCRYPT_N = 2 ** 18; // SET THIS TO 19 OR 20 IF YOU HAVE A MORE POWERFUL PC
export const PROFILE_SCRYPT_N = 2 ** 17; // slightly less because of less sensitive data
/**
 * Other
 */
export const CHUNK_SIZE = 32 * 1024; // 32KB
export const UPLOADS_DIR = 'kiyeovo-uploads';
export const UPLOADS_QUOTA_WARN_BYTES = 100 * 1024 * 1024; // 100MB
export const MAX_FILE_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB for JSON overhead
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB max file size
export const MAX_COPY_ATTEMPTS = 10; // Max number of duplicate filename attempts
export const CHUNK_RECEIVE_TIMEOUT = 30 * MINUTE; // 30 minutes to receive all chunks (legacy, kept for total timeout fallback)
export const CHUNK_IDLE_TIMEOUT = 1 * MINUTE; // 60 seconds - if no chunk received for this long, transfer is stalled
export const FILE_OFFER_RATE_LIMIT = 5; // Max file offers per peer in time window
export const FILE_OFFER_RATE_LIMIT_WINDOW = 1 * MINUTE; // 1 minute
export const MAX_PENDING_FILES_PER_PEER = 5; // Max unanswered file offers per peer
export const MAX_PENDING_FILES_TOTAL = 10; // Max unanswered file offers globally
export const MAX_ACTIVE_FILE_OFFERS_PER_CHAT = 5; // Sender cap: live served-file offers per chat (in-RAM registry)

// Pull-transfer (1d) operational bounds.
export const MAX_CONCURRENT_FILE_SERVES = 15; // Global concurrent serve leases (bound to 10MB MAX_FILE_SIZE → ~150MB RAM)
export const MAX_CONCURRENT_FILE_SERVES_PER_PEER = 5; // …and per peer; matches MAX_ACTIVE_FILE_OFFERS_PER_CHAT so a peer can pull all their offers at once without a gratuitous busy
export const MAX_PREAUTH_STREAMS_GLOBAL = 32; // Concurrent unauthenticated inbound pull streams, globally
export const MAX_PREAUTH_STREAMS_PER_PEER = 2; // …and per peer, so one peer can't consume all handshake capacity
export const FILE_PULL_FIRST_FRAME_TIMEOUT_FAST = 10 * SECOND; // Stream opened but no FilePullInit (fast mode)
export const FILE_PULL_FIRST_FRAME_TIMEOUT_ANON = 30 * SECOND; // …anonymous mode (higher latency)
export const FILE_PULL_AUTH_TIMEOUT_FAST = 10 * SECOND; // FilePullChallenge sent, awaiting FilePullAuth (fast mode)
export const FILE_PULL_AUTH_TIMEOUT_ANON = 30 * SECOND; // …anonymous mode
export const FILE_PULL_CONFIRM_TIMEOUT = 30 * SECOND; // Last chunk sent, awaiting FileTransferConfirm
// Chunk idle (CHUNK_IDLE_TIMEOUT) and total-transfer (CHUNK_RECEIVE_TIMEOUT) bounds are reused.
export const SILENT_REJECTION_THRESHOLD_GLOBAL = 20; // After N global rejections, stop responding (bandwidth optimization)
export const SILENT_REJECTION_THRESHOLD_PER_PEER = 5; // After N rejections to same peer, stop responding (bandwidth optimization)
export const CHATS_TO_CHECK_FOR_OFFLINE_MESSAGES = 10; // Max chats scanned per offline-message check pass
export const INBOUND_STREAM_READ_TIMEOUT_MS = 30 * SECOND; // Default deadline for one inbound JSON stream read
export const MAX_CHAT_ENVELOPE_BYTES = 64 * 1024; // Direct chat envelope cap
export const MAX_CALL_SIGNAL_ENVELOPE_BYTES = 256 * 1024; // WebRTC SDP/ICE signaling envelope cap
export const MAX_KEY_EXCHANGE_ENVELOPE_BYTES = 128 * 1024; // Signed key-exchange envelope cap
export const MAX_BUCKET_NUDGE_ENVELOPE_BYTES = 16 * 1024; // Offline/refetch nudge envelope cap
export const MAX_INBOUND_STREAMS_CHAT = 8; // Per-connection chat protocol streams
export const MAX_INBOUND_STREAMS_BUCKET_NUDGE = 4; // Per-connection offline/refetch nudge streams
export const MAX_INBOUND_STREAMS_CALL_SIGNAL = 8; // Per-connection WebRTC signaling streams
export const MAX_INBOUND_STREAMS_FILE_TRANSFER = 8; // Per-connection file-pull streams
export const MAX_MESSAGE_CONTENT_LENGTH = 2048; // Max direct/group message characters
// Concurrency gate for unauthenticated first-contact work on /chat (inbound read +
// key-exchange crypto from a peer with no session/chat). Established peers bypass it.
export const MAX_UNAUTH_KEY_EXCHANGE_GLOBAL = 16; // Concurrent unauth first-contact handlers, all peers
export const MAX_UNAUTH_KEY_EXCHANGE_PER_PEER = 2; // Concurrent unauth first-contact handlers, one peer

export const CHAT_NODE_MAX_CONNECTIONS = 100;
export const CHAT_NODE_INBOUND_CONNECTION_THRESHOLD_PER_HOST = 5; // New inbound connections per host per second
export const CHAT_NODE_MAX_INCOMING_PENDING_CONNECTIONS = 10; // Parallel inbound upgrades before admission
export const CHAT_NODE_INBOUND_UPGRADE_TIMEOUT_MS = 15 * SECOND;

/**
 * Group chat constants
 */
export const GROUP_INVITE_LIFETIME = 14 * DAY; // 14 days
export const GROUP_MAX_MEMBERS = 10; // Creator-enforced maximum group size
export const GROUP_REINVITE_COOLDOWN_MS = 2 * MINUTE; // 2 minutes
export const GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS = 5 * MINUTE; // 5 minutes
export const GROUP_MAX_MESSAGES_PER_SENDER = OFFLINE_MESSAGE_LIMIT;
export const GROUP_ACK_REPUBLISH_STARTUP_DELAY = 1 * MINUTE; // 60 seconds
export const GROUP_ACK_REPUBLISH_INTERVAL = 30 * MINUTE; // 30 minutes
export const GROUP_ACK_REPUBLISH_JITTER = 5 * MINUTE; // ±5 minutes
export const GROUP_PENDING_ACK_RETIRE_AGE_MS = 14 * DAY; // 14 days
export const GROUP_GOSSIPSUB_HEARTBEAT_INTERVAL = 90 * SECOND; // 90 seconds
export const GROUP_TOPIC_RECONCILE_INTERVAL = 10 * MINUTE; // 10 minutes
export const GROUP_PUBLISH_RETRY_DELAY_MS = 750; // Retry shortly after re-subscribing
export const GROUP_PUBLISH_RETRYABLE_ERROR = 'PublishError.NoPeersSubscribedToTopic';
export const GROUP_ROTATION_IO_CONCURRENCY = 5; // Parallel fan-out limit for rotation-triggered sends
export const GROUP_MESSAGE_MAX_FUTURE_SKEW_MS = 2 * MINUTE; // 2 minutes
export const GROUP_MESSAGE_MAX_AGE_MS = 1 * DAY; // 24 hours
export const GROUP_HEARTBEAT_MAX_AGE_MS = 5 * MINUTE; // 5 minutes
export const GROUP_ROTATION_GRACE_WINDOW_MS = 1 * MINUTE; // 60 seconds - grace period after rotation for late messages
export const GROUP_OLD_TOPIC_SUBSCRIPTION_GRACE_MS = 2 * MINUTE; // 2 minutes - keep previous topic subscribed after rekey
export const GROUP_DHT_REPUBLISH_INTERVAL = 30 * MINUTE; // 30 minutes
export const GROUP_DHT_REPUBLISH_JITTER = 5 * MINUTE; // ±5 minutes
export const GROUP_INFO_REPUBLISH_STARTUP_DELAY = 1 * MINUTE; // 60 seconds
export const GROUP_INFO_REPUBLISH_INTERVAL = 15 * MINUTE; // 15 minutes
export const GROUP_INFO_REPUBLISH_JITTER = 1 * MINUTE; // ±1 minute
export const GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY = 1 * MINUTE; // 1 minute
export const GROUP_INFO_REPUBLISH_RETRY_STEADY_DELAY = 10 * MINUTE; // 10 minutes
export const GROUP_INFO_REPUBLISH_MAX_ATTEMPTS = 20; // Retry cap before falling back to steady republish cadence
// Defensive cap to keep group offline DHT values bounded even when message limit is increased.
export const GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES = 64 * 1024; // 64KB
// Decompressed-size ceiling for group offline stores (see the direct-offline
// counterpart above); rejects gzip bombs before they can exhaust memory.
export const GROUP_OFFLINE_STORE_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024; // 2MiB
// Pre-parse ceiling for the (uncompressed) group-info latest/versioned DHT records.
// These are small signed roster-metadata blobs; 256KiB is generous headroom while
// bounding JSON.parse work on this unauthenticated, network-facing validator path.
export const GROUP_INFO_RECORD_MAX_BYTES = 256 * 1024; // 256KiB
export const GROUP_OFFLINE_LOCAL_CACHE_TTL_MS = 15 * MINUTE; // 15 minutes
export const GROUP_OFFLINE_LOCAL_CACHE_MAX_ENTRIES = 256; // Max cached group offline snapshots
export const GROUP_OFFLINE_CLEANUP_INTERVAL_MS = 30 * MINUTE; // 30 minutes
export const GROUP_OFFLINE_MESSAGE_TTL_MS = MESSAGE_TTL;

export const GROUP_MISSING_USED_UNTIL_SCAN_EPOCH_CAP = 10; // Max historical epochs scanned for missing used-until markers
export const MAX_BOOTSTRAP_NODES_FAST = 3; // Target bootstrap connection count in fast mode
export const MAX_BOOTSTRAP_NODES_TOR = 2; // Target bootstrap connection count in anonymous mode

export const POST_RECONNECT_RECENT_ACTIVITY_WINDOW_MS = 15 * 60_000;
export const POST_RECONNECT_RECENT_GROUP_CAP = 15;
