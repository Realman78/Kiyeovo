/* eslint-disable @typescript-eslint/no-explicit-any */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { chmod, readFile, rename, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import { gcm } from '@noble/ciphers/aes';
import { scrypt } from '@noble/hashes/scrypt';
import { randomBytes } from '@noble/hashes/utils';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import type {
    FileTransferStatus,
    NetworkMode,
    OfflineMessage,
    PendingFileInboxSnapshot,
} from '../types.js';
import type { AckMessageType, GroupContentMessage, GroupStatus } from '../group/types.js';
import { assertGroupTransition, isGroupStatus } from '../group/runtime/group-state-machine.js';
import { DEFAULT_BOOTSTRAP_NODES, DEFAULT_FAST_RELAY_MULTIADDRS } from '../network/default-infrastructure.js';
import { log } from '../../shared/logger.js';
import {
    DEFAULT_NETWORK_MODE,
    FAST_RELAY_MULTIADDRS_INITIALIZED_SETTING_KEY,
    FAST_RELAY_MULTIADDRS_SETTING_KEY,
    NETWORK_MODES,
    NETWORK_MODE_SETTING_KEY,
    PENDING_KEY_EXCHANGE_EXPIRATION,
    MESSAGE_TTL,
    PROFILE_SCRYPT_N,
    getNetworkModeRuntime,
    isNetworkMode,
} from '../constants.js';

/** Conversation-search tuning. */
const MAX_SEARCH_QUERY_LENGTH = 256;
const DEFAULT_SEARCH_PAGE_SIZE = 20;
const MAX_SEARCH_PAGE_SIZE = 50;
const MESSAGE_JUMP_CONTEXT_SIZE = 20;
const MAX_MESSAGE_JUMP_WINDOW_SIZE = 200;

interface DatabaseBackupScryptParams {
    N: number;
    r: number;
    p: number;
    dkLen: number;
}

interface DatabaseBackupHeader {
    magic: string;
    version: number;
    kdf: 'scrypt';
    scrypt: DatabaseBackupScryptParams;
    cipher: 'AES-256-GCM';
    salt: string;
    nonce: string;
    encoding: 'base64';
}

type DatabaseSidecarSuffix = '' | '-wal' | '-shm';

interface DatabaseSwapBackupFile {
    livePath: string;
    backupPath: string;
}

const DATABASE_BACKUP_MAGIC = 'KIYEOVO-DB-BACKUP';
const DATABASE_BACKUP_VERSION = 1;
const DATABASE_BACKUP_HEADER_MAX_BYTES = 4096;
const DATABASE_BACKUP_MIN_PASSWORD_LENGTH = 12;
const DATABASE_BACKUP_SCRYPT_PARAMS: DatabaseBackupScryptParams = {
    N: PROFILE_SCRYPT_N,
    r: 8,
    p: 1,
    dkLen: 32,
};
const DATABASE_BACKUP_REQUIRED_TABLES = ['users', 'chats', 'messages', 'settings'] as const;
const DATABASE_SIDECAR_SUFFIXES: DatabaseSidecarSuffix[] = ['', '-wal', '-shm'];
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Escape LIKE wildcards so a 1-2 char fallback query matches literally. */
function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ChatMessageSearchResult {
    id: string;
    clientMsgId: string | null;
    content: string;
    fileName: string | null;
    messageType: 'text' | 'file' | 'image' | 'system';
    senderPeerId: string;
    timestamp: number; // epoch ms
}

export interface ChatMessageSearchCursor {
    timestamp: number; // epoch ms of the last returned row
    rowid: number;     // tiebreaker for equal timestamps
}

export interface ChatMessageSearchResponse {
    results: ChatMessageSearchResult[];
    total: number;
    snapshotMaxRowid: number;
    nextCursor: ChatMessageSearchCursor | null;
}

export interface MessageJumpWindowResponse {
    status: 'loaded' | 'too_deep' | 'not_found';
    messages: Array<Message & { sender_username?: string | undefined }>;
    hasMoreOlder: boolean;
}

export interface User {
    network_mode: NetworkMode
    peer_id: string
    signing_public_key: string
    offline_public_key: string
    signature: string
    username: string
    created_at: Date
    updated_at: Date
}

export interface Notification {
    id: string
    notification_type: 'group_invitation'
    notification_data: string // JSON string
    bucket_key: string
    network_mode: NetworkMode
    status?: 'pending' | 'accepted' | 'rejected' | 'expired' // Only for group_invitation
    created_at: Date
}

export type PendingGroupInvitationNotification = Notification & {
    notification_type: 'group_invitation'
    status: 'pending'
}

export interface Chat {
    id: number
    network_mode: NetworkMode
    type: 'direct' | 'group'
    name: string
    created_by: string
    offline_bucket_secret: string // Shared secret part of bucket key (full key constructed with peer pubkey)
    notifications_bucket_key: string
    group_id?: string // UUID for group chats
    group_key?: string
    permanent_key?: string
    status: 'active' | 'pending'
    offline_last_read_timestamp: number // Last read timestamp for offline messages (prevents re-reading)
    offline_last_ack_sent: number // Last ACK timestamp we sent to this peer (to avoid sending redundant ACKs)
    trusted_out_of_band: boolean // Whether chat was established via out-of-band profile import (uses default inbox)
    muted: boolean // Whether notifications and sounds are muted for this chat
    key_version: number
    group_creator_peer_id?: string
    group_info_dht_key?: string
    group_status?: string // GroupStatus from group/types.ts
    needs_removed_catchup?: boolean
    removed_at?: number | null
    last_known_active_call_id?: string | null
    last_known_active_call_seen_at?: number | null
    created_at: Date
    updated_at: Date
}

export interface ChatParticipant {
    chat_id: number
    peer_id: string
    role: 'admin' | 'member'
    joined_at: Date
}

export interface Message {
    id: string // UUID for deduplication
    chat_id: number
    sender_peer_id: string
    content: string // Encrypted
    message_type: 'text' | 'file' | 'image' | 'system'
    timestamp: Date
    event_timestamp?: Date | null
    created_at: Date
    // same value on both sender and recipient
    client_msg_id?: string | undefined
    // The `client_msg_id` (cid) this message replies to, if any.
    reply_to_client_id?: string | null
    file_name?: string
    file_size?: number
    file_path?: string
    file_offer_id?: string
    file_checksum?: string
    file_total_chunks?: number
    file_protocol_version?: number
    file_group_download_total?: number
    file_group_download_completed?: number
    transfer_status?: FileTransferStatus
    transfer_progress?: number
    transfer_error?: string
    // Local outbound send lifecycle for optimistic UI / offline-send queue
    local_send_state?: 'queued' | 'sending' | 'failed' | null
    failed_reason?: string | null
    // Absolute ms timestamp before which a failed send may not be retried
    // (e.g. group-rekey cooldown). Persisted so the block survives a restart.
    retry_after_ts?: number | null
    // Local-only pin. NULL = not pinned
    pinned_at?: number | null
}

export interface PinnedMessagePreview {
    clientMsgId: string
    senderPeerId: string
    senderUsername: string | undefined
    content: string
    messageType: 'text' | 'file' | 'image' | 'system'
    fileName: string | undefined
}

export interface DeleteMessagesForMeResult {
    deletedCount: number
    latestRemaining: {
        content: string
        timestamp: Date
        clientMsgId: string | null
    } | null
}

// A 1:1 message awaiting an offline DHT write (durable background-send queue).
export interface PendingOfflineSend {
    message_id: string
    chat_id: number
    peer_id: string
    bucket_key: string
    content: string
    created_at: number
    status: 'queued' | 'failed'
    attempts: number
    last_error: string | null
}

export interface EncryptedUserIdentityDb {
    id: number
    network_mode: NetworkMode
    identity_kind: 'primary' | 'recovery'
    peer_id: string
    encrypted_data: Buffer  // The encrypted JSON blob (stored as BLOB)
    salt: Buffer            // Scrypt salt (stored as BLOB)
    nonce: Buffer           // AES-GCM nonce (stored as BLOB)
    created_at: Date
}

export interface ContactAttempt {
    id: number
    network_mode: NetworkMode
    sender_peer_id: string
    sender_username: string
    message: string
    message_body: string
    timestamp: number
    created_at: Date
}

export interface BlockedPeer {
    network_mode: NetworkMode
    peer_id: string
    username: string | null
    blocked_at: Date
    reason: string | null
}

export interface FailedKeyExchange {
    id: number
    network_mode: NetworkMode
    target_peer_id: string
    target_username: string
    timestamp: number
    content: string
    reason: string
    created_at: Date
}

export interface KeyChangeEvent {
    id: number
    network_mode: NetworkMode
    peer_id: string
    username: string
    old_signing_key: string
    new_signing_key: string
    source: string
    created_at: Date
}

export interface OfflineSentMessages {
    bucket_key: string
    messages: OfflineMessage[]
    version: number
    updated_at: Date
}

export type OfflineMessageCategory = 'regular' | 'control' | 'ack';

export interface OfflineSentMessageCategoryEntry {
    bucket_key: string
    message_id: string
    category: OfflineMessageCategory
    updated_at: string
}

export interface LoginAttempt {
    id: number
    network_mode: NetworkMode
    peer_id: string
    attempt_count: number
    last_attempt_at: Date
    cooldown_until: Date | null
    created_at: Date
}

export interface BootstrapNode {
    id: number
    address: string
    network_mode: NetworkMode
    created_at: Date
    updated_at: Date
}

export interface GroupKeyHistory {
    group_id: string
    key_version: number
    encrypted_key: string
    group_info_metadata_key: string
    state_hash: string | null
    used_until: number | null
    created_at: string
}

export interface GroupOfflineCursor {
    group_id: string
    key_version: number
    sender_peer_id: string
    last_read_timestamp: number
    last_read_message_id: string
    updated_at: string
}

export interface GroupPendingAck {
    group_id: string
    target_peer_id: string
    network_mode: NetworkMode
    message_type: AckMessageType
    message_payload: string
    status: 'active' | 'retired'
    created_at: string
    last_published_at: string
}

export interface GroupPendingInfoPublish {
    group_id: string
    key_version: number
    network_mode: NetworkMode
    versioned_dht_key: string
    versioned_payload: string
    latest_dht_key: string
    latest_payload: string
    attempts: number
    next_retry_at: number
    last_error: string | null
    created_at: string
    updated_at: string
}

export interface GroupInviteDeliveryAck {
    group_id: string
    target_peer_id: string
    invite_id: string
    network_mode: NetworkMode
    created_at: string
}

export interface GroupSenderSeq {
    group_id: string
    key_version: number
    next_seq: number
}

export interface GroupEpochBoundary {
    group_id: string
    key_version: number
    sender_peer_id: string
    boundary_seq: number
    source: string
    updated_at: string
}

export class ChatDatabase {
    private db: Database.Database;
    private dbPath: string;
    private readonly sessionNetworkMode: NetworkMode;

    constructor(dbPath: string) {
        this.dbPath = dbPath;

        try {
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = new Database(dbPath);

            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = 10000');
            this.db.pragma('temp_store = memory');
            this.db.pragma('mmap_size = 268435456'); // 256MB
            this.db.pragma('busy_timeout = 5000'); // 5 second timeout
            this.db.pragma('foreign_keys = ON');

            this.initializeTables();
            this.sessionNetworkMode = this.getNetworkMode();
            this.createIndexes();
            this.ensureMessageSearchIndex();

            this.checkIntegrity();
        } catch (error) {
            generalErrorHandler(error);
            throw error;
        }
    }

    private mapChatRow(row: any): Chat {
        const mode = isNetworkMode(row.network_mode) ? row.network_mode : DEFAULT_NETWORK_MODE;
        return {
            ...row,
            network_mode: mode,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
            trusted_out_of_band: Boolean(row.trusted_out_of_band),
            muted: Boolean(row.muted),
            key_version: row.key_version ?? 0,
            needs_removed_catchup: Boolean(row.needs_removed_catchup),
            removed_at: row.removed_at ?? null,
            last_known_active_call_id: row.last_known_active_call_id ?? null,
            last_known_active_call_seen_at: row.last_known_active_call_seen_at ?? null,
        };
    }

    private initializeTables(): void {
        // Enable WAL mode for better concurrent access
        this.db.pragma('journal_mode = WAL');

        // Users table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                peer_id TEXT NOT NULL,
                signing_public_key TEXT NOT NULL,
                offline_public_key TEXT NOT NULL DEFAULT '',
                signature TEXT NOT NULL,
                username TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(network_mode, peer_id)
            )
        `);

        // Chats table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK(type IN ('direct','group')),
                created_by TEXT NOT NULL,
                offline_bucket_secret TEXT NOT NULL,
                notifications_bucket_key TEXT NOT NULL,
                group_id TEXT,
                group_key TEXT,
                permanent_key TEXT,
                status TEXT NOT NULL CHECK(status IN ('active', 'pending')),
                offline_last_read_timestamp INTEGER DEFAULT 0,
                offline_last_ack_sent INTEGER DEFAULT 0,
                trusted_out_of_band INTEGER DEFAULT 0,
                muted INTEGER DEFAULT 0,
                key_version INTEGER DEFAULT 0,
                group_creator_peer_id TEXT,
                group_info_dht_key TEXT,
                group_status TEXT,
                needs_removed_catchup INTEGER NOT NULL DEFAULT 0,
                removed_at INTEGER,
                last_known_active_call_id TEXT,
                last_known_active_call_seen_at INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this.ensureChatsRemovedCatchupColumns();
        this.ensureChatsLastKnownActiveCallColumns();


        // Messages table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY NOT NULL,
                chat_id INTEGER NOT NULL,
                sender_peer_id TEXT NOT NULL,
                content TEXT NOT NULL, -- Decrypted content stored in plaintext (relies on OS disk encryption for at-rest protection)
                message_type TEXT NOT NULL CHECK(message_type IN ('text', 'file', 'image', 'system')),
                file_name TEXT,
                file_size INTEGER,
                file_path TEXT,
                file_offer_id TEXT,
                file_checksum TEXT,
                file_total_chunks INTEGER,
                file_protocol_version INTEGER,
                file_group_download_total INTEGER,
                file_group_download_completed INTEGER,
                transfer_status TEXT,
                transfer_progress INTEGER,
                transfer_error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                event_timestamp DATETIME,
                FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
            )
        `);
        this.ensureEventTimestampColumn();
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS file_offer_cancellation_tombstones (
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}',
                offer_id TEXT NOT NULL,
                sender_peer_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                PRIMARY KEY (network_mode, offer_id, sender_peer_id)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS encrypted_user_identities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                identity_kind TEXT NOT NULL CHECK(identity_kind IN ('primary','recovery')),
                peer_id TEXT NOT NULL,
                encrypted_data BLOB NOT NULL,
                salt BLOB NOT NULL,
                nonce BLOB NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(network_mode, identity_kind)
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id INTEGER NOT NULL,
                peer_id TEXT NOT NULL,
                role TEXT DEFAULT 'member',
                joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (chat_id, peer_id),
                FOREIGN KEY (chat_id) REFERENCES chats (id) ON DELETE CASCADE
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY NOT NULL,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                notification_type TEXT NOT NULL CHECK(notification_type IN ('group_invitation')),
                notification_data TEXT NOT NULL, -- JSON string
                bucket_key TEXT NOT NULL,
                status TEXT CHECK(status IN ('pending', 'accepted', 'rejected', 'expired')), -- Only for group invitations
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                read BOOLEAN DEFAULT FALSE
            )
        `);

        // Contact attempts log table (for silent mode)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS contact_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                sender_peer_id TEXT NOT NULL,
                sender_username TEXT NOT NULL,
                message TEXT NOT NULL,
                message_body TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Blocked peers table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS blocked_peers (
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                peer_id TEXT NOT NULL,
                username TEXT,
                blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                reason TEXT,
                PRIMARY KEY (network_mode, peer_id)
            )
        `);

        // Failed key exchanges table (for sender-side rate limiting)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS failed_key_exchanges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                target_peer_id TEXT NOT NULL,
                target_username TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                content TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Audit trail for observed contact signing-key changes.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS key_change_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                peer_id TEXT NOT NULL,
                username TEXT NOT NULL,
                old_signing_key TEXT NOT NULL,
                new_signing_key TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Settings table (for local preferences like contact_mode)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY NOT NULL,
                value TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Initialize default contact_mode setting if not exists
        const contactModeSetting = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('contact_mode');
        if (!contactModeSetting) {
            this.db.prepare(`INSERT INTO settings (key, value) VALUES ('contact_mode', 'active')`).run();
        }

        // Initialize default network mode setting if not exists (U1).
        const networkModeSetting = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(NETWORK_MODE_SETTING_KEY);
        if (!networkModeSetting) {
            this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(NETWORK_MODE_SETTING_KEY, DEFAULT_NETWORK_MODE);
        }

        // Initialize default fast relays once. Users can later edit/clear via settings UI.
        const fastRelayInitialized = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(FAST_RELAY_MULTIADDRS_INITIALIZED_SETTING_KEY);
        if (!fastRelayInitialized) {
            this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
                FAST_RELAY_MULTIADDRS_SETTING_KEY,
                DEFAULT_FAST_RELAY_MULTIADDRS.join(',')
            );
            this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
                FAST_RELAY_MULTIADDRS_INITIALIZED_SETTING_KEY,
                'true'
            );
        }

        // Offline sent messages table (local cache of messages we've sent to DHT)
        // This eliminates the need to query DHT before writing
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS offline_sent_messages (
                bucket_key TEXT PRIMARY KEY NOT NULL,
                messages TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS offline_sent_message_categories (
                bucket_key TEXT NOT NULL,
                message_id TEXT NOT NULL,
                category TEXT NOT NULL CHECK(category IN ('regular', 'control', 'ack')),
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (bucket_key, message_id)
            )
        `);

        // Durable queue of 1:1 messages awaiting an offline DHT write. The
        // background flush worker batches all 'queued' rows for a bucket into one
        // PUT. 'failed' rows wait for a manual retry (give-up threshold = 0).
        // message_id is the chat message id (shared with the UI row).
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pending_offline_sends (
                message_id TEXT PRIMARY KEY NOT NULL,
                chat_id INTEGER NOT NULL,
                peer_id TEXT NOT NULL,
                bucket_key TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            )
        `);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_offline_sends_bucket ON pending_offline_sends(bucket_key, status)`);

        // Durable mirror of group messages that were published online but whose
        // offline DHT backup failed — so an app-close mid-backup doesn't lose them.
        // payload is the serialized GroupContentMessage; retried on startup.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pending_group_offline_backups (
                message_id TEXT PRIMARY KEY NOT NULL,
                chat_id INTEGER NOT NULL,
                group_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        `);

        // Group offline sent messages table (local cache of messages we've sent to group DHT buckets)
        // Allows optimistic local append/write without pre-read DHT GET.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_offline_sent_messages (
                bucket_key TEXT PRIMARY KEY NOT NULL,
                messages TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Login attempts table (for progressive cooldown on failed password attempts)
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                peer_id TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_attempt_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                cooldown_until DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(network_mode, peer_id)
            )
        `);

        // Bootstrap nodes table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS bootstrap_nodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT NOT NULL,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(address, network_mode)
            )
        `);

        this.ensureColumnExists('bootstrap_nodes', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');

        // Initialize default bootstrap nodes (only once, even if user deletes them later)
        const bootstrapInitialized = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('bootstrap_nodes_initialized');
        if (!bootstrapInitialized) {
            for (let i = 0; i < DEFAULT_BOOTSTRAP_NODES.length; i++) {
                const node = DEFAULT_BOOTSTRAP_NODES[i]!;
                const mode = node.includes('/onion')
                    ? NETWORK_MODES.ANONYMOUS
                    : NETWORK_MODES.FAST;
                this.db.prepare('INSERT INTO bootstrap_nodes (address, network_mode, sort_order) VALUES (?, ?, ?)').run(node, mode, i);
            }
            this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('bootstrap_nodes_initialized', 'true');
        }

        // Group key history — stores encrypted group keys per epoch for decrypting old messages
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_key_history (
                group_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                encrypted_key TEXT NOT NULL,
                group_info_metadata_key TEXT NOT NULL,
                state_hash TEXT,
                used_until INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, key_version)
            )
        `);

        // Group offline cursors — tracks last-read position per sender per group
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_offline_cursors (
                group_id TEXT NOT NULL,
                key_version INTEGER NOT NULL DEFAULT 1,
                sender_peer_id TEXT NOT NULL,
                last_read_timestamp INTEGER NOT NULL DEFAULT 0,
                last_read_message_id TEXT NOT NULL DEFAULT '',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, key_version, sender_peer_id)
            )
        `);

        // Group pending ACKs — tracks key-bearing control messages awaiting ACK for re-publish
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_pending_acks (
                group_id TEXT NOT NULL,
                target_peer_id TEXT NOT NULL,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                message_type TEXT NOT NULL CHECK(message_type IN ('GROUP_INVITE', 'GROUP_INVITE_RESPONSE', 'GROUP_WELCOME', 'GROUP_STATE_UPDATE', 'GROUP_KICK', 'GROUP_DISBAND')),
                message_payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retired')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, target_peer_id, message_type, network_mode)
            )
        `);

        // Group info pending publishes — retries for versioned/latest DHT records
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_pending_info_publishes (
                group_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                versioned_dht_key TEXT NOT NULL,
                versioned_payload TEXT NOT NULL,
                latest_dht_key TEXT NOT NULL,
                latest_payload TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at INTEGER NOT NULL,
                last_error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, key_version, network_mode)
            )
        `);

        // Group invite delivery ACKs — recipient confirmed invite was received.
        // Used to stop invite re-publishing while still keeping invite pending row
        // for later response validation.
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_invite_delivery_acks (
                group_id TEXT NOT NULL,
                target_peer_id TEXT NOT NULL,
                invite_id TEXT NOT NULL,
                network_mode TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}' CHECK(network_mode IN ('${NETWORK_MODES.FAST}','${NETWORK_MODES.ANONYMOUS}')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, target_peer_id, invite_id, network_mode)
            )
        `);

        // Group sender sequence — tracks sender's own monotonic seq per group per keyVersion
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_sender_seq (
                group_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                next_seq INTEGER NOT NULL DEFAULT 1,
                PRIMARY KEY (group_id, key_version)
            )
        `);

        // Group member seq — tracks highest observed seq from each member per group per keyVersion
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_member_seq (
                group_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                sender_peer_id TEXT NOT NULL,
                highest_seq INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (group_id, key_version, sender_peer_id)
            )
        `);

        // Group epoch boundaries — finalized sender seq cutoffs for a closed key epoch
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS group_epoch_boundaries (
                group_id TEXT NOT NULL,
                key_version INTEGER NOT NULL,
                sender_peer_id TEXT NOT NULL,
                boundary_seq INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL DEFAULT 'local_rotation',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, key_version, sender_peer_id)
            )
        `);

        this.ensureModeScopedColumns();
    }

    private createIndexes(): void {
        // Indexes for better query performance
        this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_peer_id ON messages (sender_peer_id);
      CREATE INDEX IF NOT EXISTS idx_messages_file_offer_id ON messages (file_offer_id);
      CREATE INDEX IF NOT EXISTS idx_file_offer_cancel_tombstones_expires ON file_offer_cancellation_tombstones (expires_at);
      CREATE INDEX IF NOT EXISTS idx_users_mode_username ON users (network_mode, username);
      CREATE INDEX IF NOT EXISTS idx_users_mode_peer_id ON users (network_mode, peer_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unique_mode_peer ON users(network_mode, peer_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_encrypted_identities_unique_mode_kind ON encrypted_user_identities(network_mode, identity_kind);
      CREATE INDEX IF NOT EXISTS idx_participants_peer ON chat_participants(peer_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(chat_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_client_msg ON messages(chat_id, client_msg_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_mode_created_at ON notifications(network_mode, created_at DESC);

      -- Indexes for cleanup queries
      CREATE INDEX IF NOT EXISTS idx_failed_key_exchanges_timestamp ON failed_key_exchanges(timestamp);
      CREATE INDEX IF NOT EXISTS idx_failed_key_exchanges_mode_timestamp ON failed_key_exchanges(network_mode, timestamp);
      CREATE INDEX IF NOT EXISTS idx_key_change_events_mode_peer_created ON key_change_events(network_mode, peer_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_attempts_mode_created_at ON contact_attempts(network_mode, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_blocked_peers_mode_blocked_at ON blocked_peers(network_mode, blocked_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_login_attempts_unique_mode_peer ON login_attempts(network_mode, peer_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_mode_status_created ON notifications(network_mode, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_offline_sent_message_categories_bucket ON offline_sent_message_categories(bucket_key, category);

      -- Group indexes
      CREATE INDEX IF NOT EXISTS idx_group_key_history_group ON group_key_history(group_id);
      CREATE INDEX IF NOT EXISTS idx_group_pending_acks_group_mode ON group_pending_acks(group_id, network_mode);
      CREATE INDEX IF NOT EXISTS idx_group_pending_acks_mode_status_created ON group_pending_acks(network_mode, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_group_pending_info_mode_next_retry ON group_pending_info_publishes(network_mode, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_group_invite_delivery_acks_group_mode ON group_invite_delivery_acks(group_id, network_mode);
      CREATE INDEX IF NOT EXISTS idx_chats_group_id_mode ON chats(group_id, network_mode);
      CREATE INDEX IF NOT EXISTS idx_chats_mode_updated ON chats(network_mode, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bootstrap_nodes_mode ON bootstrap_nodes(network_mode);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bootstrap_nodes_unique_addr_mode ON bootstrap_nodes(address, network_mode);
        `);
    }

    /**
     * Full-text search index over message text + filenames, backing conversation
     * search. External-content FTS5 (no duplicated content column) keyed on the
     * messages table's integer rowid, with the `trigram` tokenizer so MATCH does
     * case-insensitive *substring* search (incl. inside filenames like
     * `report_2024.pdf`). System messages are indexed too but excluded at query
     * time. Triggers keep it in sync; the UPDATE trigger is scoped to the two
     * indexed columns + a value-change guard so routine writes
     * (transfer_status/local_send_state/read receipts) never churn the index.
     */
    private ensureMessageSearchIndex(): void {
        const alreadyExists = this.db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'`
        ).get();

        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
                content,
                file_name,
                content='messages',
                content_rowid='rowid',
                tokenize='trigram'
            );

            CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
                INSERT INTO messages_fts(rowid, content, file_name)
                VALUES (new.rowid, new.content, new.file_name);
            END;

            CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content, file_name)
                VALUES ('delete', old.rowid, old.content, old.file_name);
            END;

            CREATE TRIGGER IF NOT EXISTS messages_fts_au
                AFTER UPDATE OF content, file_name ON messages
                WHEN old.content IS NOT new.content OR old.file_name IS NOT new.file_name
            BEGIN
                INSERT INTO messages_fts(messages_fts, rowid, content, file_name)
                VALUES ('delete', old.rowid, old.content, old.file_name);
                INSERT INTO messages_fts(rowid, content, file_name)
                VALUES (new.rowid, new.content, new.file_name);
            END;
        `);

        // First-time creation only: backfill existing rows from the content table.
        // On later launches the triggers have kept the index current, so we skip
        // the (potentially large) rebuild.
        if (!alreadyExists) {
            this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
        }
    }

    private ensureEventTimestampColumn(): void {
        try {
            this.db.exec('ALTER TABLE messages ADD COLUMN event_timestamp DATETIME');
        } catch (error) {
            if (!errStr(error).toLowerCase().includes('duplicate column name')) {
                throw error;
            }
        }
    }

    private ensureChatsRemovedCatchupColumns(): void {
        try {
            this.db.exec('ALTER TABLE chats ADD COLUMN needs_removed_catchup INTEGER NOT NULL DEFAULT 0');
        } catch (error) {
            if (!errStr(error).toLowerCase().includes('duplicate column name')) {
                throw error;
            }
        }

        try {
            this.db.exec('ALTER TABLE chats ADD COLUMN removed_at INTEGER');
        } catch (error) {
            if (!errStr(error).toLowerCase().includes('duplicate column name')) {
                throw error;
            }
        }
    }

    private ensureChatsLastKnownActiveCallColumns(): void {
        try {
            this.db.exec('ALTER TABLE chats ADD COLUMN last_known_active_call_id TEXT');
        } catch (error) {
            if (!errStr(error).toLowerCase().includes('duplicate column name')) {
                throw error;
            }
        }

        try {
            this.db.exec('ALTER TABLE chats ADD COLUMN last_known_active_call_seen_at INTEGER');
        } catch (error) {
            if (!errStr(error).toLowerCase().includes('duplicate column name')) {
                throw error;
            }
        }
    }

    private ensureModeScopedColumns(): void {
        this.ensureColumnExists('users', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('chats', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('notifications', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('bootstrap_nodes', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('group_pending_acks', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('group_pending_acks', 'status', `TEXT NOT NULL DEFAULT 'active'`);
        this.ensureColumnExists('group_pending_info_publishes', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('group_invite_delivery_acks', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('encrypted_user_identities', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('encrypted_user_identities', 'identity_kind', `TEXT NOT NULL DEFAULT 'primary'`);
        this.ensureColumnExists('group_key_history', 'group_info_metadata_key', "TEXT NOT NULL DEFAULT ''");
        this.ensureColumnExists('contact_attempts', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('blocked_peers', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('failed_key_exchanges', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('key_change_events', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('login_attempts', 'network_mode', `TEXT NOT NULL DEFAULT '${DEFAULT_NETWORK_MODE}'`);
        this.ensureColumnExists('messages', 'local_send_state', 'TEXT');
        this.ensureColumnExists('messages', 'failed_reason', 'TEXT');
        this.ensureColumnExists('messages', 'retry_after_ts', 'INTEGER');
        // Pin feature: local-only pinned marker
        this.ensureColumnExists('messages', 'pinned_at', 'INTEGER');
        // Reply feature: cross-peer stable id + reply reference
        this.ensureColumnExists('messages', 'client_msg_id', 'TEXT');
        this.ensureColumnExists('messages', 'reply_to_client_id', 'TEXT');
        this.ensureColumnExists('messages', 'file_offer_id', 'TEXT');
        this.ensureColumnExists('messages', 'file_checksum', 'TEXT');
        this.ensureColumnExists('messages', 'file_total_chunks', 'INTEGER');
        this.ensureColumnExists('messages', 'file_protocol_version', 'INTEGER');
        this.ensureColumnExists('messages', 'file_group_download_total', 'INTEGER');
        this.ensureColumnExists('messages', 'file_group_download_completed', 'INTEGER');
        this.db.prepare(`UPDATE messages SET client_msg_id = id WHERE client_msg_id IS NULL`).run();
        this.db.prepare(`UPDATE bootstrap_nodes SET network_mode = ? WHERE address LIKE '%/onion%'`).run(NETWORK_MODES.ANONYMOUS);
        this.db.prepare(`UPDATE bootstrap_nodes SET network_mode = ? WHERE address NOT LIKE '%/onion%'`).run(NETWORK_MODES.FAST);
    }

    private ensureColumnExists(table: string, column: string, definition: string): void {
        try {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        } catch (error) {
            if (!errStr(error).toLowerCase().includes('duplicate column name')) {
                throw error;
            }
        }
    }

    private getActiveNetworkMode(mode?: NetworkMode): NetworkMode {
        return mode ?? this.sessionNetworkMode;
    }

    // Helper method to retry database operations
    private async retryOperation<T>(operation: () => T, maxRetries: number = 3, delay: number = 100): Promise<T> {
        let lastError: any;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return operation();
            } catch (error: any) {
                lastError = error;
                // If it's a database locked error, wait and retry
                if (error.code === 'SQLITE_BUSY' || error.message.includes('database is locked')) {
                    log(`Database locked, retrying... (attempt ${attempt}/${maxRetries})`);
                    // Try to reconnect on the second attempt
                    if (attempt === 2) {
                        try {
                            this.reconnect();
                        } catch (reconnectError) {
                            console.error('Failed to reconnect:', reconnectError);
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, delay * attempt));
                    continue;
                }
                // For other errors, don't retry
                throw error;
            }
        }
        throw lastError;
    }

    // Encrypted user identity operations
    createEncryptedUserIdentityForMode(
        mode: NetworkMode,
        identityKind: 'primary' | 'recovery',
        encryptedUserIdentity: Omit<EncryptedUserIdentityDb, 'id' | 'created_at' | 'network_mode' | 'identity_kind'>
    ): void {
        try {
            const stmt = this.db.prepare(
                `INSERT INTO encrypted_user_identities (network_mode, identity_kind, peer_id, encrypted_data, salt, nonce)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(network_mode, identity_kind) DO UPDATE SET
                   peer_id = excluded.peer_id,
                   encrypted_data = excluded.encrypted_data,
                   salt = excluded.salt,
                   nonce = excluded.nonce`
            );
            stmt.run(
                mode,
                identityKind,
                encryptedUserIdentity.peer_id,
                encryptedUserIdentity.encrypted_data,
                encryptedUserIdentity.salt,
                encryptedUserIdentity.nonce
            );
        } catch (error) {
            generalErrorHandler(error);
        }
    }

    getEncryptedUserIdentityForMode(
        mode: NetworkMode,
        identityKind: 'primary' | 'recovery'
    ): EncryptedUserIdentityDb | null {
        const stmt = this.db.prepare(
            'SELECT * FROM encrypted_user_identities WHERE network_mode = ? AND identity_kind = ? LIMIT 1'
        );
        const row = stmt.get(mode, identityKind) as any;
        return row ? {
            id: row.id,
            network_mode: row.network_mode,
            identity_kind: row.identity_kind,
            peer_id: row.peer_id,
            encrypted_data: row.encrypted_data,
            salt: row.salt,
            nonce: row.nonce,
            created_at: new Date(row.created_at)
        } : null;
    }

    // Kept only for targeted recovery lookups.
    getEncryptedUserIdentityByPeerId(peerId: string, mode?: NetworkMode): EncryptedUserIdentityDb | null {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare(
            'SELECT * FROM encrypted_user_identities WHERE peer_id = ? AND network_mode = ? LIMIT 1'
        );
        const row = stmt.get(peerId, activeMode) as any;
        return row ? {
            id: row.id,
            network_mode: row.network_mode,
            identity_kind: row.identity_kind,
            peer_id: row.peer_id,
            encrypted_data: row.encrypted_data,
            salt: row.salt,
            nonce: row.nonce,
            created_at: new Date(row.created_at)
        } : null;
    }

    // User operations
    private insertUser(
        user: Omit<User, 'created_at' | 'updated_at' | 'network_mode'>,
        mode: NetworkMode
    ): string {
        const stmt = this.db.prepare(`
            INSERT INTO users (network_mode, peer_id, signing_public_key, offline_public_key, signature, username)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(network_mode, peer_id) DO UPDATE SET
                signing_public_key = excluded.signing_public_key,
                offline_public_key = excluded.offline_public_key,
                signature = excluded.signature,
                username = excluded.username,
                updated_at = CURRENT_TIMESTAMP
        `);

        try {
            stmt.run(mode, user.peer_id, user.signing_public_key, user.offline_public_key, user.signature, user.username);
            return user.peer_id;
        } catch (error: any) {
            console.error('Error creating user:', error);
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                return user.peer_id;
            }
            throw error;
        }
    }

    async createUser(
        user: Omit<User, 'created_at' | 'updated_at' | 'network_mode'> & { network_mode?: NetworkMode }
    ): Promise<string> {
        const mode = this.getActiveNetworkMode(user.network_mode);
        return this.retryOperation(() => this.insertUser(user, mode));
    }

    updateUserKeys(
        user: Omit<User, 'username' | 'created_at' | 'updated_at' | 'network_mode'> & { network_mode?: NetworkMode }
    ): void {
        const mode = this.getActiveNetworkMode(user.network_mode);
        const stmt = this.db.prepare(
            'UPDATE users SET signing_public_key = ?, offline_public_key = ?, signature = ? WHERE peer_id = ? AND network_mode = ?'
        );
        stmt.run(user.signing_public_key, user.offline_public_key, user.signature, user.peer_id, mode);
        log(`Updated user keys for ${user.peer_id}`);
    }

    updateUsername(peerId: string, username: string, mode?: NetworkMode): void {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('UPDATE users SET username = ? WHERE peer_id = ? AND network_mode = ?');
        stmt.run(username, peerId, activeMode);
        log(`Updated username for ${peerId} to ${username}`);
    }

    getUserByUsername(username: string, mode?: NetworkMode): User | null {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT * FROM users WHERE username = ? AND network_mode = ?');
        const row = stmt.get(username, activeMode) as any;

        if (!row) return null;

        return {
            network_mode: row.network_mode,
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getUserByPeerId(peerId: string, mode?: NetworkMode): User | null {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT * FROM users WHERE peer_id = ? AND network_mode = ?');
        const row = stmt.get(peerId, activeMode) as any;

        if (!row) return null;

        return {
            network_mode: row.network_mode,
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getUserByPeerIdOrUsername(peerIdOrUsername: string, mode?: NetworkMode): User | null {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT * FROM users WHERE network_mode = ? AND (peer_id = ? OR username = ?)');
        const row = stmt.get(activeMode, peerIdOrUsername, peerIdOrUsername) as any;

        if (!row) return null;

        return {
            network_mode: row.network_mode,
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getUserByPeerIdThenUsername(peerIdOrUsername: string, mode?: NetworkMode): User | null {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT * FROM users WHERE peer_id = ? AND network_mode = ?');
        let row = stmt.get(peerIdOrUsername, activeMode) as any;
        if (!row) {
            row = this.getUserByUsername(peerIdOrUsername, activeMode) as any;
        }

        if (!row) return null;

        return {
            network_mode: row.network_mode,
            peer_id: row.peer_id,
            signing_public_key: row.signing_public_key,
            offline_public_key: row.offline_public_key || '',
            signature: row.signature,
            username: row.username,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at)
        };
    }

    getLastUsername(peerId: string, mode?: NetworkMode): string | null {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT username FROM users WHERE peer_id = ? AND network_mode = ? AND username IS NOT NULL');
        const row = stmt.get(peerId, activeMode) as { username: string } | undefined;
        return row?.username ?? null;
    }

    getUsersPeerIds(usernamesOrPeerIds: string[], mode?: NetworkMode): string[] {
        const activeMode = this.getActiveNetworkMode(mode);
        const placeholders = usernamesOrPeerIds.map(() => '?').join(',');
        const stmt = this.db.prepare(
            `SELECT DISTINCT peer_id FROM users WHERE network_mode = ? AND (username IN (${placeholders}) OR peer_id IN (${placeholders}))`
        );
        const rows = stmt.all(activeMode, ...usernamesOrPeerIds, ...usernamesOrPeerIds) as { peer_id: string }[];
        return rows.map((row: { peer_id: string }) => row.peer_id);
    }

    getUsernamesForPeerIds(peerIds: string[], mode?: NetworkMode): Map<string, string> {
        if (peerIds.length === 0) return new Map();
        const activeMode = this.getActiveNetworkMode(mode);
        const placeholders = peerIds.map(() => '?').join(',');
        const stmt = this.db.prepare(`SELECT peer_id, username FROM users WHERE network_mode = ? AND peer_id IN (${placeholders})`);
        const rows = stmt.all(activeMode, ...peerIds) as { peer_id: string, username: string }[];
        return new Map(rows.map(row => [row.peer_id, row.username]));
    }

    getAllUsers(mode?: NetworkMode): User[] {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT * FROM users WHERE network_mode = ? ORDER BY username');
        return (stmt.all(activeMode) as any[]).map(row => ({
            ...row,
            network_mode: row.network_mode,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
        }));
    }

    deleteUserByPeerId(peerId: string, mode?: NetworkMode): void {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('DELETE FROM users WHERE peer_id = ? AND network_mode = ?');
        stmt.run(peerId, activeMode);
    }

    // Legacy helper kept for one-time diagnostics; use mode-scoped methods above.
    getAllUsersAcrossModes(): User[] {
        const stmt = this.db.prepare('SELECT * FROM users ORDER BY network_mode, username');
        return (stmt.all() as any[]).map(row => ({
            ...row,
            network_mode: row.network_mode,
            created_at: new Date(row.created_at),
            updated_at: new Date(row.updated_at),
        }));
    }

    // Generic settings operations
    setSetting(key: string, value: string): void {
        const stmt = this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
        stmt.run(key, value);
    }

    getSetting(key: string): string | null {
        const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
        const row = stmt.get(key) as { value: string } | undefined;
        return row?.value ?? null;
    }

    getContactMode(): 'active' | 'silent' | 'block' {
        const value = this.getSetting('contact_mode');
        return (value as 'active' | 'silent' | 'block') || 'active';
    }

    setNetworkMode(mode: NetworkMode): void {
        if (!isNetworkMode(mode)) {
            throw new Error(`Invalid network mode: ${mode}`);
        }
        this.setSetting(NETWORK_MODE_SETTING_KEY, mode);
    }

    getNetworkMode(): NetworkMode {
        const value = this.getSetting(NETWORK_MODE_SETTING_KEY);
        if (isNetworkMode(value)) return value;

        // Self-heal invalid/missing value to default.
        this.setSetting(NETWORK_MODE_SETTING_KEY, DEFAULT_NETWORK_MODE);
        return DEFAULT_NETWORK_MODE;
    }

    getSessionNetworkMode(): NetworkMode {
        return this.sessionNetworkMode;
    }

    // Contact attempt operations (silent mode logging)
    logContactAttempt(attempt: Omit<ContactAttempt, 'id' | 'created_at' | 'network_mode'>): number {
        const stmt = this.db.prepare(`
            INSERT INTO contact_attempts (network_mode, sender_peer_id, sender_username, message, message_body, timestamp)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            this.getActiveNetworkMode(),
            attempt.sender_peer_id,
            attempt.sender_username,
            attempt.message,
            attempt.message_body,
            attempt.timestamp
        );

        // FIFO cap at 1000 entries - delete oldest if limit exceeded
        const deleteOldStmt = this.db.prepare(`
            DELETE FROM contact_attempts
            WHERE id IN (
                SELECT id FROM contact_attempts
                WHERE network_mode = ?
                ORDER BY timestamp DESC
                LIMIT -1 OFFSET 1000
            )
        `);
        deleteOldStmt.run(this.getActiveNetworkMode());

        return result.lastInsertRowid as number;
    }

    getActiveContactAttempts(): ContactAttempt[] {
        // Active are the ones who are not older than PENDING_KEY_EXCHANGE_EXPIRATION (2 minutes)
        return this.getContactAttempts().filter(attempt => attempt.timestamp > Date.now() - PENDING_KEY_EXCHANGE_EXPIRATION);
    }

    getContactAttempts(limit: number = 50, page: number = 1): ContactAttempt[] {
        const stmt = this.db.prepare('SELECT * FROM contact_attempts WHERE network_mode = ? ORDER BY created_at DESC LIMIT ? OFFSET ?');
        const rows = stmt.all(this.getActiveNetworkMode(), limit, (page - 1) * limit) as any[];
        return rows.map(row => ({
            id: row.id,
            network_mode: row.network_mode,
            sender_peer_id: row.sender_peer_id,
            sender_username: row.sender_username,
            message: row.message,
            message_body: row.message_body,
            timestamp: row.timestamp,
            created_at: new Date(row.created_at)
        }));
    }

    getContactAttemptsByPeerId(peerId: string): ContactAttempt[] {
        const stmt = this.db.prepare('SELECT * FROM contact_attempts WHERE sender_peer_id = ? AND network_mode = ?');
        const rows = stmt.all(peerId, this.getActiveNetworkMode()) as any[];
        return rows.map(row => ({
            id: row.id,
            network_mode: row.network_mode,
            sender_peer_id: row.sender_peer_id,
            sender_username: row.sender_username,
            message: row.message,
            message_body: row.message_body,
            timestamp: row.timestamp,
            created_at: new Date(row.created_at)
        }));
    }

    deleteContactAttempt(id: number): void {
        const stmt = this.db.prepare('DELETE FROM contact_attempts WHERE id = ? AND network_mode = ?');
        stmt.run(id, this.getActiveNetworkMode());
    }

    // Blocked peer operations
    blockPeer(peerId: string, username: string | null = null, reason: string | null = null): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO blocked_peers (network_mode, peer_id, username, reason)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(this.getActiveNetworkMode(), peerId, username, reason);
    }

    unblockPeer(peerId: string): void {
        const stmt = this.db.prepare('DELETE FROM blocked_peers WHERE peer_id = ? AND network_mode = ?');
        stmt.run(peerId, this.getActiveNetworkMode());
    }

    isBlocked(peerId: string): boolean {
        const stmt = this.db.prepare('SELECT 1 FROM blocked_peers WHERE peer_id = ? AND network_mode = ?');
        const row = stmt.get(peerId, this.getActiveNetworkMode());
        return row !== undefined;
    }

    getBlockedPeers(limit: number = 1000): BlockedPeer[] {
        const stmt = this.db.prepare('SELECT * FROM blocked_peers WHERE network_mode = ? ORDER BY blocked_at DESC LIMIT ?');
        const rows = stmt.all(this.getActiveNetworkMode(), limit) as any[];
        return rows.map(row => ({
            network_mode: row.network_mode,
            peer_id: row.peer_id,
            username: row.username,
            blocked_at: new Date(row.blocked_at),
            reason: row.reason
        }));
    }

    // Failed key exchange operations (sender-side rate limiting)
    logFailedKeyExchange(targetPeerId: string, targetUsername: string, content: string, reason: string): void {
        const stmt = this.db.prepare(`
            INSERT INTO failed_key_exchanges (network_mode, target_peer_id, target_username, timestamp, content, reason)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(this.getActiveNetworkMode(), targetPeerId, targetUsername, Date.now(), content, reason);
    }

    getRecentFailedKeyExchange(targetPeerId: string, withinMinutes: number = 5): FailedKeyExchange | null {
        const cutoffTime = Date.now() - (withinMinutes * 60 * 1000);
        const stmt = this.db.prepare(`
            SELECT * FROM failed_key_exchanges
            WHERE target_peer_id = ? AND timestamp > ? AND network_mode = ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        const row = stmt.get(targetPeerId, cutoffTime, this.getActiveNetworkMode()) as FailedKeyExchange;
        if (!row) return null;
        return {
            id: row.id,
            network_mode: row.network_mode,
            target_peer_id: row.target_peer_id,
            target_username: row.target_username,
            timestamp: row.timestamp,
            content: row.content,
            reason: row.reason,
            created_at: new Date(row.created_at)
        };
    }

    cleanupOldFailedKeyExchanges(olderThanMinutes: number = 60): void {
        const cutoffTime = Date.now() - (olderThanMinutes * 60 * 1000);
        const stmt = this.db.prepare('DELETE FROM failed_key_exchanges WHERE timestamp < ? AND network_mode = ?');
        const result = stmt.run(cutoffTime, this.getActiveNetworkMode());
        if (result.changes > 0) {
            log(`[CLEANUP] Removed ${result.changes} old failed key exchange records`);
        }
    }

    // Signing-key change audit operations
    recordKeyChangeEvent(
        event: Omit<KeyChangeEvent, 'id' | 'created_at' | 'network_mode'> & { network_mode?: NetworkMode }
    ): void {
        const mode = this.getActiveNetworkMode(event.network_mode);
        const stmt = this.db.prepare(`
            INSERT INTO key_change_events (
                network_mode,
                peer_id,
                username,
                old_signing_key,
                new_signing_key,
                source
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(mode, event.peer_id, event.username, event.old_signing_key, event.new_signing_key, event.source);
    }

    getKeyChangeEvents(peerId: string, mode?: NetworkMode): KeyChangeEvent[] {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare(`
            SELECT * FROM key_change_events
            WHERE peer_id = ? AND network_mode = ?
            ORDER BY created_at DESC, id DESC
        `);
        const rows = stmt.all(peerId, activeMode) as any[];
        return rows.map(row => ({
            id: row.id,
            network_mode: row.network_mode,
            peer_id: row.peer_id,
            username: row.username,
            old_signing_key: row.old_signing_key,
            new_signing_key: row.new_signing_key,
            source: row.source,
            created_at: new Date(row.created_at)
        }));
    }

    cleanupExpiredNotifications(olderThanDays: number = 30): void {
        const cutoffTime = new Date(Date.now() - (olderThanDays * 24 * 60 * 60 * 1000)).toISOString();
        const stmt = this.db.prepare(`DELETE FROM notifications WHERE network_mode = ? AND status IN ('accepted', 'rejected', 'expired') AND created_at < ?`);
        const result = stmt.run(this.getActiveNetworkMode(), cutoffTime);
        if (result.changes > 0) {
            log(`[CLEANUP] Removed ${result.changes} old notification records`);
        }
    }

    runCleanupTasks(): void {
        this.cleanupOldFailedKeyExchanges(60); // Remove failed attempts older than 1 hour
        this.cleanupExpiredNotifications(30); // Remove old processed notifications after 30 days
    }

    // Chat operations
    private assertUserExists(peerId: string, mode: NetworkMode): void {
        const user = this.db
            .prepare('SELECT peer_id FROM users WHERE peer_id = ? AND network_mode = ?')
            .get(peerId, mode);
        if (!user) {
            throw new Error(`User with peer_id '${peerId}' not found in database`);
        }
    }

    private insertChatWithParticipants(
        chat: Omit<Chat, 'id' | 'updated_at' | 'network_mode'> & { participants: string[] },
        mode: NetworkMode
    ): number {
        const stmt = this.db.prepare(`
            INSERT INTO chats (network_mode, created_by, type, name, offline_bucket_secret, notifications_bucket_key, status, group_id, group_key, permanent_key, trusted_out_of_band, group_creator_peer_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const createdAt = chat.created_at instanceof Date ? chat.created_at.toISOString() : chat.created_at;
        const result = stmt.run(
            mode,
            chat.created_by,
            chat.type,
            chat.type === 'group' ? chat.name : chat.created_by,
            chat.offline_bucket_secret,
            chat.notifications_bucket_key,
            chat.status ?? (chat.type === 'group' ? 'pending' : 'active'),
            chat.type === 'group' && chat?.group_id ? chat.group_id : null,
            chat.type === 'group' && chat?.group_key ? chat.group_key : null,
            chat.type === 'group' && chat?.permanent_key ? chat.permanent_key : null,
            chat.trusted_out_of_band ? 1 : 0,
            chat.group_creator_peer_id ?? null,
            createdAt,
            createdAt
        );
        const chatId = result.lastInsertRowid as number;

        const participantStmt = this.db.prepare('INSERT INTO chat_participants (chat_id, peer_id, role) VALUES (?, ?, ?)');
        for (const participant of chat.participants) {
            participantStmt.run(chatId, participant, chat.created_by === participant ? 'admin' : 'member');
        }

        return chatId;
    }

    async createChat(chat: Omit<Chat, 'id' | 'updated_at' | 'network_mode'> & { participants: string[] }): Promise<number> {
        return this.retryOperation(() => {
            log(`Creating chat: created_by=${chat.created_by}, participants=${chat.participants}`);
            const mode = this.getActiveNetworkMode();
            this.assertUserExists(chat.created_by, mode);

            const transaction = this.db.transaction(() => this.insertChatWithParticipants(chat, mode));
            const chatId = transaction();

            log(`Created chat with ID: ${chatId}`);
            return chatId;
        });
    }

    async createTrustedDirectContact(
        user: Omit<User, 'created_at' | 'updated_at' | 'network_mode'> & { network_mode?: NetworkMode },
        chat: Omit<Chat, 'id' | 'updated_at' | 'network_mode'> & { participants: string[] }
    ): Promise<number> {
        const mode = this.getActiveNetworkMode(user.network_mode);
        return this.retryOperation(() => {
            log(`Creating trusted direct contact: created_by=${chat.created_by}, contact=${user.peer_id}, participants=${chat.participants}`);
            const transaction = this.db.transaction(() => {
                this.assertUserExists(chat.created_by, mode);
                this.insertUser(user, mode);
                return this.insertChatWithParticipants(chat, mode);
            });
            const chatId = transaction();

            log(`Created trusted direct contact chat with ID: ${chatId}`);
            return chatId;
        });
    }

    getAllChats(): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            WHERE network_mode = ?
            ORDER BY updated_at DESC
        `);
        const rows = stmt.all(this.getActiveNetworkMode()) as any[];

        if (!rows) return [];
        return rows.map(row => this.mapChatRow(row));
    }

    getAllChatsWithUsernames(myPeerId: string): Array<Chat & { username?: string }> {
        const stmt = this.db.prepare(`
            SELECT
                c.*,
                u.username
            FROM chats c
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id AND c.type = 'direct' AND cp.peer_id != ?
            LEFT JOIN users u ON cp.peer_id = u.peer_id AND u.network_mode = c.network_mode
            WHERE c.network_mode = ?
            ORDER BY c.updated_at DESC
        `);
        const rows = stmt.all(myPeerId, this.getActiveNetworkMode()) as any[];

        if (!rows) return [];
        return rows.map(row => ({
            ...this.mapChatRow(row),
            username: row.username || undefined
        }));
    }

    searchChats(query: string, myPeerId: string): number[] {
        const pattern = `%${query}%`;
        const mode = this.getActiveNetworkMode();
        const stmt = this.db.prepare(`
            SELECT DISTINCT c.id FROM chats c
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id AND c.type = 'direct' AND cp.peer_id != ?
            LEFT JOIN users u ON cp.peer_id = u.peer_id AND u.network_mode = c.network_mode
            WHERE c.network_mode = ? AND (
                -- Direct chat: match other party's username or peerId
                (c.type = 'direct' AND (u.username LIKE ? OR cp.peer_id LIKE ?))
                OR
                -- Group chat: match group name
                (c.type = 'group' AND c.name LIKE ?)
                OR
                -- Group chat: match any participant's username or peerId
                (c.type = 'group' AND c.id IN (
                    SELECT gcp.chat_id FROM chat_participants gcp
                    LEFT JOIN users gu ON gcp.peer_id = gu.peer_id AND gu.network_mode = ?
                    WHERE gcp.peer_id != ? AND (gu.username LIKE ? OR gcp.peer_id LIKE ?)
                ))
            )
        `);
        const rows = stmt.all(myPeerId, mode, pattern, pattern, pattern, mode, myPeerId, pattern, pattern) as { id: number }[];
        return rows.map(row => row.id);
    }

    getAllChatsWithUsernameAndLastMsg(myPeerId: string): Array<Chat & {
        username?: string | undefined;
        group_creator_username?: string | undefined;
        other_peer_id?: string | undefined;
        last_message_content?: string | undefined;
        last_message_timestamp?: Date | undefined;
        last_inbound_activity_timestamp?: Date | undefined;
        last_message_sender?: string | undefined;
        blocked?: boolean | undefined;
    }> {
        const stmt = this.db.prepare(`
            SELECT
                c.*,
                u.username,
                creator_u.username as group_creator_username,
                cp.peer_id as other_peer_id,
                last_msg.content as last_message_content,
                last_msg.timestamp as last_message_timestamp,
                inbound_activity.last_inbound_activity_timestamp as last_inbound_activity_timestamp,
                last_msg.sender_peer_id as last_message_sender,
                CASE WHEN bp.peer_id IS NOT NULL THEN 1 ELSE 0 END as blocked
            FROM chats c
            LEFT JOIN (
                SELECT
                    m.chat_id,
                    MAX(m.timestamp) as last_inbound_activity_timestamp
                FROM messages m
                JOIN chats c2 ON c2.id = m.chat_id
                WHERE c2.type = 'direct'
                  AND c2.network_mode = ?
                  AND m.sender_peer_id != ?
                GROUP BY m.chat_id
            ) inbound_activity ON inbound_activity.chat_id = c.id
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id AND c.type = 'direct' AND cp.peer_id != ?
            LEFT JOIN users u ON cp.peer_id = u.peer_id AND u.network_mode = c.network_mode
            LEFT JOIN users creator_u ON c.type = 'group' AND creator_u.peer_id = c.group_creator_peer_id AND creator_u.network_mode = c.network_mode
            LEFT JOIN blocked_peers bp ON cp.peer_id = bp.peer_id AND bp.network_mode = c.network_mode
            LEFT JOIN messages last_msg ON last_msg.id = (
                SELECT id FROM messages
                WHERE chat_id = c.id
                  AND local_send_state IS NULL
                ORDER BY timestamp DESC
                LIMIT 1
            )
            WHERE c.network_mode = ?
            ORDER BY c.updated_at DESC
        `);
        const mode = this.getActiveNetworkMode();
        const rows = stmt.all(mode, myPeerId, myPeerId, mode) as any[];

        if (!rows) return [];
        return rows.map(row => ({
            ...this.mapChatRow(row),
            username: row.username || undefined,
            group_creator_username: row.group_creator_username || undefined,
            other_peer_id: row.other_peer_id || undefined,
            last_message_content: row.last_message_content || undefined,
            last_message_timestamp: row.last_message_timestamp ? new Date(row.last_message_timestamp) : undefined,
            last_inbound_activity_timestamp: row.last_inbound_activity_timestamp ? new Date(row.last_inbound_activity_timestamp) : undefined,
            last_message_sender: row.last_message_sender || undefined,
            blocked: Boolean(row.blocked)
        }));
    }

    getChatByIdWithUsernameAndLastMsg(chatId: number, myPeerId: string): (Chat & {
        username?: string | undefined;
        group_creator_username?: string | undefined;
        other_peer_id?: string | undefined;
        last_message_content?: string | undefined;
        last_message_timestamp?: Date | undefined;
        last_inbound_activity_timestamp?: Date | undefined;
        last_message_sender?: string | undefined;
        blocked?: boolean | undefined;
    }) | null {
        const stmt = this.db.prepare(`
            SELECT
                c.*,
                u.username,
                creator_u.username as group_creator_username,
                cp.peer_id as other_peer_id,
                last_msg.content as last_message_content,
                last_msg.timestamp as last_message_timestamp,
                inbound_activity.last_inbound_activity_timestamp as last_inbound_activity_timestamp,
                last_msg.sender_peer_id as last_message_sender,
                CASE WHEN bp.peer_id IS NOT NULL THEN 1 ELSE 0 END as blocked
            FROM chats c
            LEFT JOIN (
                SELECT
                    m.chat_id,
                    MAX(m.timestamp) as last_inbound_activity_timestamp
                FROM messages m
                JOIN chats c2 ON c2.id = m.chat_id
                WHERE c2.type = 'direct'
                  AND c2.network_mode = ?
                  AND m.sender_peer_id != ?
                GROUP BY m.chat_id
            ) inbound_activity ON inbound_activity.chat_id = c.id
            LEFT JOIN chat_participants cp ON c.id = cp.chat_id AND c.type = 'direct' AND cp.peer_id != ?
            LEFT JOIN users u ON cp.peer_id = u.peer_id AND u.network_mode = c.network_mode
            LEFT JOIN users creator_u ON c.type = 'group' AND creator_u.peer_id = c.group_creator_peer_id AND creator_u.network_mode = c.network_mode
            LEFT JOIN blocked_peers bp ON cp.peer_id = bp.peer_id AND bp.network_mode = c.network_mode
            LEFT JOIN messages last_msg ON last_msg.id = (
                SELECT id FROM messages
                WHERE chat_id = c.id
                  AND local_send_state IS NULL
                ORDER BY timestamp DESC
                LIMIT 1
            )
            WHERE c.id = ? AND c.network_mode = ?
        `);
        const mode = this.getActiveNetworkMode();
        const row = stmt.get(mode, myPeerId, myPeerId, chatId, mode) as any;

        if (!row) return null;
        return {
            ...this.mapChatRow(row),
            username: row.username || undefined,
            group_creator_username: row.group_creator_username || undefined,
            other_peer_id: row.other_peer_id || undefined,
            last_message_content: row.last_message_content || undefined,
            last_message_timestamp: row.last_message_timestamp ? new Date(row.last_message_timestamp) : undefined,
            last_inbound_activity_timestamp: row.last_inbound_activity_timestamp ? new Date(row.last_inbound_activity_timestamp) : undefined,
            last_message_sender: row.last_message_sender || undefined,
            blocked: Boolean(row.blocked)
        };
    }

    getChats(chatIds: number[], mode?: NetworkMode): Chat[] {
        if (chatIds.length === 0) return [];
        const stmt = this.db.prepare(`SELECT * FROM chats WHERE id IN (${chatIds.map(() => '?').join(',')}) AND network_mode = ?`);
        const rows = stmt.all(...chatIds, this.getActiveNetworkMode(mode)) as any[];

        if (!rows) return [];
        return rows.map(row => this.mapChatRow(row));
    }

    getChatByName(name: string, type: 'direct' | 'group' = 'group'): Chat | null {
        const stmt = this.db.prepare('SELECT * FROM chats WHERE name = ? AND type = ? AND network_mode = ?');
        const row = stmt.get(name, type, this.getActiveNetworkMode()) as any;

        if (!row) return null;

        return this.mapChatRow(row);
    }

    getChatByGroupId(groupId: string, mode?: NetworkMode): Chat | null {
        const stmt = this.db.prepare('SELECT * FROM chats WHERE group_id = ? AND network_mode = ?');
        const row = stmt.get(groupId, this.getActiveNetworkMode(mode)) as any;

        if (!row) return null;

        return this.mapChatRow(row);
    }

    deleteChatById(chatId: number): void {
        const stmt = this.db.prepare('DELETE FROM chats WHERE id = ?');
        stmt.run(chatId);
    }

    deleteChatByGroupId(groupId: string): void {
        const stmt = this.db.prepare('DELETE FROM chats WHERE group_id = ? AND network_mode = ?');
        stmt.run(groupId, this.getActiveNetworkMode());
    }

    getAllGroupChats(limit: number = 1000): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            WHERE type = 'group' AND network_mode = ?
            ORDER BY updated_at DESC
            LIMIT ?
        `);
        const rows = stmt.all(this.getActiveNetworkMode(), limit) as any[];

        if (!rows) return [];

        return rows.map(row => this.mapChatRow(row));
    }

    getRecentlyActiveGroupChats(sinceMs: number, limit: number): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            WHERE type = 'group'
              AND network_mode = ?
              AND datetime(updated_at) > datetime(?)
              AND group_id IS NOT NULL
              AND key_version > 0
              AND (
                group_status IN ('active', 'rekeying')
                OR (group_status = 'removed' AND needs_removed_catchup = 1)
              )
            ORDER BY datetime(updated_at) DESC
            LIMIT ?
        `);
        const sinceIso = new Date(sinceMs).toISOString();
        const rows = stmt.all(this.getActiveNetworkMode(), sinceIso, limit) as any[];

        if (!rows) return [];

        return rows.map(row => this.mapChatRow(row));
    }

    getAllPendingGroupChatsCreatedByMe(myPeerId: string, limit: number = 100): Chat[] {
        const stmt = this.db.prepare(`
            SELECT * FROM chats
            WHERE type = 'group' AND status = 'pending' AND created_by = ? AND network_mode = ?
            ORDER BY created_at DESC
            LIMIT ?
        `);
        const rows = stmt.all(myPeerId, this.getActiveNetworkMode(), limit) as any[];

        if (!rows) return [];

        return rows.map(row => this.mapChatRow(row));
    }

    /**
     * Update group permanent key and participants after key rotation
     * Also updates status to 'active'
     */
    updateGroupPermanentKey(chatId: number, permanentKey: string, participants: string[], adminPeerId: string): void {
        const updateChatStmt = this.db.prepare(`
            UPDATE chats
            SET permanent_key = ?, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `);
        updateChatStmt.run(permanentKey, chatId);

        // Delete existing participants
        const deleteParticipantsStmt = this.db.prepare('DELETE FROM chat_participants WHERE chat_id = ?');
        deleteParticipantsStmt.run(chatId);

        // Insert new participants
        for (const peerId of participants) {
            const role = peerId === adminPeerId ? 'admin' : 'member';
            const insertParticipantStmt = this.db.prepare(`
                INSERT INTO chat_participants (chat_id, peer_id, role, joined_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `);
            insertParticipantStmt.run(chatId, peerId, role);
        }

        log(`Updated group permanent key and ${participants.length} participants for chat ${chatId}`);
    }

    getChatParticipants(chatId: number): ChatParticipant[] {
        const stmt = this.db.prepare('SELECT * FROM chat_participants WHERE chat_id = ?');
        const rows = stmt.all(chatId) as ChatParticipant[];
        return rows;
    }

    getCountOfChatParticipants(chatId: number): number {
        const stmt = this.db.prepare('SELECT COUNT(*) FROM chat_participants WHERE chat_id = ?');
        const row = stmt.get(chatId) as { count: number };
        return row.count;
    }

    // get chat by peer id - for single direct chat
    getChatByPeerId(otherPeerId: string, mode?: NetworkMode): Chat | null {
        const stmt = this.db.prepare('SELECT * FROM chat_participants WHERE peer_id = ?');
        const rows = stmt.all(otherPeerId) as ChatParticipant[];
        const chatIds = rows.map((row: ChatParticipant) => row.chat_id);

        const chats = this.getChats(chatIds, mode);
        return chats.find((chat: Chat) => chat.type === 'direct') ?? null;
    }

    getAllOfflineBucketSecrets(includeGroupChats: boolean = true, limit: number = 25): string[] {
        let query = 'SELECT offline_bucket_secret FROM chats WHERE network_mode = ?';
        if (!includeGroupChats) {
            query += " AND type = 'direct'";
        }
        query += ' ORDER BY updated_at DESC LIMIT ?';

        const stmt = this.db.prepare(query);
        const rows = stmt.all(this.getActiveNetworkMode(), limit) as { offline_bucket_secret: string }[];
        return rows.map(row => row.offline_bucket_secret);
    }

    getOfflineReadBucketInfo(limit: number = 25): Array<{
        offline_bucket_secret: string;
        peer_id: string;
        signing_public_key: string;
        offline_last_read_timestamp: number;
    }> {
        const query = `
            SELECT c.offline_bucket_secret, cp.peer_id, u.signing_public_key, c.offline_last_read_timestamp
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            JOIN users u ON cp.peer_id = u.peer_id AND u.network_mode = c.network_mode
            WHERE c.type = 'direct'
            AND c.network_mode = ?
            AND cp.peer_id != c.created_by
            AND cp.peer_id NOT IN (SELECT peer_id FROM blocked_peers WHERE network_mode = c.network_mode)
            ORDER BY c.updated_at DESC
            LIMIT ?
        `;
        const stmt = this.db.prepare(query);
        return stmt.all(this.getActiveNetworkMode(), limit) as Array<{
            offline_bucket_secret: string;
            peer_id: string;
            signing_public_key: string;
            offline_last_read_timestamp: number;
        }>;
    }

    getOfflineReadBucketInfoForChats(chatIds: number[]): Array<{
        chat_id: number;
        offline_bucket_secret: string;
        peer_id: string;
        signing_public_key: string;
        offline_last_read_timestamp: number;
    }> {
        if (chatIds.length === 0) return [];

        const placeholders = chatIds.map(() => '?').join(',');
        const query = `
            SELECT c.id as chat_id, c.offline_bucket_secret, cp.peer_id, u.signing_public_key, c.offline_last_read_timestamp
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            JOIN users u ON cp.peer_id = u.peer_id AND u.network_mode = c.network_mode
            WHERE c.id IN (${placeholders})
            AND c.type = 'direct'
            AND c.network_mode = ?
            AND cp.peer_id != c.created_by
            AND cp.peer_id NOT IN (SELECT peer_id FROM blocked_peers WHERE network_mode = c.network_mode)
        `;
        const stmt = this.db.prepare(query);
        return stmt.all(...chatIds, this.getActiveNetworkMode()) as Array<{
            chat_id: number;
            offline_bucket_secret: string;
            peer_id: string;
            signing_public_key: string;
            offline_last_read_timestamp: number;
        }>;
    }

    getAllNotificationsBucketKeys(): string[] {
        const stmt = this.db.prepare('SELECT notifications_bucket_key FROM chats WHERE network_mode = ?');
        const rows = stmt.all(this.getActiveNetworkMode()) as Chat[];
        return rows.map(row => row.notifications_bucket_key);
    }

    getGroupNotificationBuckerKeysNotCreatedBy(ownerPeerId: string): string[] {
        const stmt = this.db.prepare(`SELECT notifications_bucket_key FROM chats WHERE type = 'group' AND created_by != ? AND network_mode = ?`);
        const rows = stmt.all(ownerPeerId, this.getActiveNetworkMode()) as Chat[];
        return rows.map(row => row.notifications_bucket_key);
    }


    getNotificationsBucketKeysByPeerIds(peerIds: string[]): string[] {
        const placeholders = peerIds.map(() => '?').join(',');
        // get all notifications bucket keys for the given peer ids (in chats that are only direct chats)
        const stmt = this.db.prepare(`
            SELECT DISTINCT c.notifications_bucket_key 
            FROM chats c
            JOIN chat_participants cp ON c.id = cp.chat_id
            WHERE c.type = 'direct' AND c.network_mode = ? AND cp.peer_id IN (${placeholders})
        `);
        const rows = stmt.all(this.getActiveNetworkMode(), ...peerIds) as { notifications_bucket_key: string }[];
        return rows.map((row: { notifications_bucket_key: string }) => row.notifications_bucket_key);
    }

    getOfflineBucketSecretByPeerId(otherPeerId: string): string | null {
        const chat = this.getChatByPeerId(otherPeerId);
        if (!chat) return null;
        return chat.offline_bucket_secret;
    }

    countTrustedDirectChatsByOfflineSecret(offlineBucketSecret: string): number {
        const stmt = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM chats
            WHERE network_mode = ?
              AND type = 'direct'
              AND trusted_out_of_band = 1
              AND offline_bucket_secret = ?
        `);
        const row = stmt.get(this.getActiveNetworkMode(), offlineBucketSecret) as { count: number } | undefined;
        return row?.count ?? 0;
    }

    // Offline message last read timestamp operations
    getOfflineLastReadTimestamp(chatId: number): number {
        const stmt = this.db.prepare('SELECT offline_last_read_timestamp FROM chats WHERE id = ?');
        const row = stmt.get(chatId) as { offline_last_read_timestamp: number };
        return row.offline_last_read_timestamp;
    }

    updateOfflineLastReadTimestamp(chatId: number, timestamp: number): void {
        const stmt = this.db.prepare('UPDATE chats SET offline_last_read_timestamp = ? WHERE id = ?');
        stmt.run(timestamp, chatId);
    }

    getOfflineLastReadTimestampByPeerId(peerId: string): number {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return 0;
        return chat.offline_last_read_timestamp;
    }

    updateOfflineLastReadTimestampByPeerId(peerId: string, timestamp: number): void {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return;
        this.updateOfflineLastReadTimestamp(chat.id, timestamp);
    }

    // Offline ACK sent tracking (to avoid sending redundant ACKs)
    getOfflineLastAckSentByPeerId(peerId: string): number {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return 0;
        return chat.offline_last_ack_sent;
    }

    updateOfflineLastAckSentByPeerId(peerId: string, timestamp: number): void {
        const chat = this.getChatByPeerId(peerId);
        if (!chat) return;
        const stmt = this.db.prepare('UPDATE chats SET offline_last_ack_sent = ? WHERE id = ?');
        stmt.run(timestamp, chat.id);
    }

    // Used when upgrading from out-of-band trust
    updateChatEncryptionKeys(chatId: number, keys: {
        offline_bucket_secret: string;
        notifications_bucket_key: string;
        trusted_out_of_band: boolean;
    }): void {
        const stmt = this.db.prepare(`
            UPDATE chats 
            SET offline_bucket_secret = ?, 
                notifications_bucket_key = ?,
                trusted_out_of_band = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `);
        stmt.run(
            keys.offline_bucket_secret,
            keys.notifications_bucket_key,
            keys.trusted_out_of_band ? 1 : 0,
            chatId
        );
    }

    // Offline sent messages operations (local cache to avoid DHT reads before writes)
    getOfflineSentMessages(bucketKey: string): { messages: OfflineMessage[]; version: number } {
        const stmt = this.db.prepare('SELECT messages, version FROM offline_sent_messages WHERE bucket_key = ?');
        const row = stmt.get(bucketKey) as { messages: string; version: number } | undefined;
        if (!row) {
            return { messages: [], version: 0 };
        }
        return {
            messages: JSON.parse(row.messages) as OfflineMessage[],
            version: row.version
        };
    }

    saveOfflineSentMessages(bucketKey: string, messages: OfflineMessage[], version: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO offline_sent_messages (bucket_key, messages, version, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(bucket_key) DO UPDATE SET
                messages = excluded.messages,
                version = excluded.version,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(bucketKey, JSON.stringify(messages), version);
    }

    deleteOfflineSentMessages(bucketKey: string): void {
        const tx = this.db.transaction((key: string) => {
            this.db.prepare('DELETE FROM offline_sent_messages WHERE bucket_key = ?').run(key);
            this.db.prepare('DELETE FROM offline_sent_message_categories WHERE bucket_key = ?').run(key);
        });
        tx(bucketKey);
    }

    getOfflineSentMessageCategories(bucketKey: string): OfflineSentMessageCategoryEntry[] {
        const stmt = this.db.prepare(`
            SELECT bucket_key, message_id, category, updated_at
            FROM offline_sent_message_categories
            WHERE bucket_key = ?
        `);
        return stmt.all(bucketKey) as OfflineSentMessageCategoryEntry[];
    }

    syncOfflineSentMessageCategories(
        bucketKey: string,
        entries: Array<{ messageId: string; category: OfflineMessageCategory }>,
    ): void {
        const tx = this.db.transaction((key: string, rows: Array<{ messageId: string; category: OfflineMessageCategory }>) => {
            this.db.prepare('DELETE FROM offline_sent_message_categories WHERE bucket_key = ?').run(key);
            if (rows.length === 0) {
                return;
            }

            const insert = this.db.prepare(`
                INSERT OR REPLACE INTO offline_sent_message_categories (bucket_key, message_id, category, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            `);
            for (const row of rows) {
                insert.run(key, row.messageId, row.category);
            }
        });
        tx(bucketKey, entries);
    }

    // --- Pending offline sends queue (durable, batched background flush) ---

    insertPendingOfflineSend(row: {
        messageId: string;
        chatId: number;
        peerId: string;
        bucketKey: string;
        content: string;
        createdAt: number;
    }): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO pending_offline_sends
                (message_id, chat_id, peer_id, bucket_key, content, created_at, status, attempts, last_error)
            VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL)
        `);
        stmt.run(row.messageId, row.chatId, row.peerId, row.bucketKey, row.content, row.createdAt);
    }

    // 'queued' rows for a bucket, oldest first — the batch the flush worker drains.
    getQueuedPendingOfflineSendsByBucket(bucketKey: string): PendingOfflineSend[] {
        const stmt = this.db.prepare(`
            SELECT * FROM pending_offline_sends
            WHERE bucket_key = ? AND status = 'queued'
            ORDER BY created_at ASC
        `);
        return stmt.all(bucketKey) as PendingOfflineSend[];
    }

    // Count rows that are still actively queued for a bucket write. Failed rows
    // remain retryable local state but do not occupy DHT bucket capacity.
    countActivePendingOfflineSendsByBucket(bucketKey: string): number {
        const stmt = this.db.prepare(`
            SELECT COUNT(*) AS count FROM pending_offline_sends
            WHERE bucket_key = ? AND status = 'queued'
        `);
        return (stmt.get(bucketKey) as { count: number }).count;
    }

    getPendingOfflineSend(messageId: string): PendingOfflineSend | null {
        const stmt = this.db.prepare('SELECT * FROM pending_offline_sends WHERE message_id = ?');
        return (stmt.get(messageId) as PendingOfflineSend | undefined) ?? null;
    }

    getAllPendingOfflineSends(): PendingOfflineSend[] {
        return this.db.prepare('SELECT * FROM pending_offline_sends').all() as PendingOfflineSend[];
    }

    // Atomic settle of delivered sends: consume queued rows AND clear the matching
    // chat rows' send-state in one transaction. Failed rows require an explicit
    // retry/requeue before they can be delivered, so late success cannot overwrite
    // a first terminal failure.
    settlePendingOfflineSendsDelivered(messageIds: string[]): void {
        if (messageIds.length === 0) return;
        const inputPlaceholders = messageIds.map(() => '?').join(',');
        const tx = this.db.transaction((ids: string[]) => {
            const rows = this.db.prepare(
                `SELECT message_id FROM pending_offline_sends WHERE message_id IN (${inputPlaceholders}) AND status = 'queued'`,
            ).all(...ids) as Array<{ message_id: string }>;
            const queuedIds = rows.map(row => row.message_id);
            if (queuedIds.length === 0) return;

            const queuedPlaceholders = queuedIds.map(() => '?').join(',');
            this.db.prepare(`DELETE FROM pending_offline_sends WHERE message_id IN (${queuedPlaceholders}) AND status = 'queued'`).run(...queuedIds);
            this.db.prepare(
                `UPDATE messages SET local_send_state = NULL, failed_reason = NULL, retry_after_ts = NULL WHERE id IN (${queuedPlaceholders})`,
            ).run(...queuedIds);
        });
        tx(messageIds);
    }

    // Atomic settle of failed sends: consume queued rows and mark their chat rows
    // failed in one transaction. Already delivered rows have no pending row, and
    // already failed rows must be explicitly requeued before another attempt.
    settlePendingOfflineSendsFailed(messageIds: string[], lastError?: string): void {
        if (messageIds.length === 0) return;
        const inputPlaceholders = messageIds.map(() => '?').join(',');
        const tx = this.db.transaction((ids: string[]) => {
            const rows = this.db.prepare(
                `SELECT message_id FROM pending_offline_sends WHERE message_id IN (${inputPlaceholders}) AND status = 'queued'`,
            ).all(...ids) as Array<{ message_id: string }>;
            const queuedIds = rows.map(row => row.message_id);
            if (queuedIds.length === 0) return;

            const queuedPlaceholders = queuedIds.map(() => '?').join(',');
            this.db.prepare(
                `UPDATE pending_offline_sends SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE message_id IN (${queuedPlaceholders}) AND status = 'queued'`,
            ).run(lastError ?? null, ...queuedIds);
            this.db.prepare(
                `UPDATE messages SET local_send_state = 'failed', failed_reason = COALESCE(NULLIF(failed_reason, ''), 'other') WHERE id IN (${queuedPlaceholders})`,
            ).run(...queuedIds);
        });
        tx(messageIds);
    }

    // Manual retry: move a failed row back to 'queued' so the flush picks it up.
    requeuePendingOfflineSend(messageId: string): void {
        this.db.prepare(`UPDATE pending_offline_sends SET status = 'queued' WHERE message_id = ?`).run(messageId);
    }

    // Startup reconcile (atomic, idempotent): no auto-resume. Any send interrupted
    // mid-flight (`queued`) becomes `failed`, and every chat row that still has a
    // pending queue row but shows `sending` is corrected to `failed` (manual retry).
    // Delivered sends left no pending row (atomic settle), so they're untouched.
    reconcileInterruptedOfflineSends(): void {
        const tx = this.db.transaction(() => {
            this.db.prepare(`UPDATE pending_offline_sends SET status = 'failed' WHERE status = 'queued'`).run();
            this.db.prepare(`
                UPDATE messages SET local_send_state = 'failed', failed_reason = COALESCE(NULLIF(failed_reason, ''), 'other')
                WHERE local_send_state = 'sending' AND id IN (SELECT message_id FROM pending_offline_sends)
            `).run();
        });
        tx();
    }

    // Group offline sent messages operations (local cache to avoid DHT reads before writes)
    getGroupOfflineSentMessages(bucketKey: string): { messages: GroupContentMessage[]; version: number } {
        const stmt = this.db.prepare('SELECT messages, version FROM group_offline_sent_messages WHERE bucket_key = ?');
        const row = stmt.get(bucketKey) as { messages: string; version: number } | undefined;
        if (!row) {
            return { messages: [], version: 0 };
        }
        return {
            messages: JSON.parse(row.messages) as GroupContentMessage[],
            version: row.version
        };
    }

    saveGroupOfflineSentMessages(bucketKey: string, messages: GroupContentMessage[], version: number): void {
        const stmt = this.db.prepare(`
            INSERT INTO group_offline_sent_messages (bucket_key, messages, version, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(bucket_key) DO UPDATE SET
                messages = excluded.messages,
                version = excluded.version,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(bucketKey, JSON.stringify(messages), version);
    }

    deleteGroupOfflineSentMessages(bucketKey: string): void {
        const stmt = this.db.prepare('DELETE FROM group_offline_sent_messages WHERE bucket_key = ?');
        stmt.run(bucketKey);
    }

    // --- Pending group offline backups (durable retry across restart) ---

    upsertPendingGroupOfflineBackup(row: { messageId: string; chatId: number; groupId: string; payload: string }): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO pending_group_offline_backups (message_id, chat_id, group_id, payload, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(row.messageId, row.chatId, row.groupId, row.payload, Date.now());
    }

    deletePendingGroupOfflineBackup(messageId: string): void {
        this.db.prepare('DELETE FROM pending_group_offline_backups WHERE message_id = ?').run(messageId);
    }

    getAllPendingGroupOfflineBackups(): Array<{ message_id: string; chat_id: number; group_id: string; payload: string }> {
        return this.db.prepare('SELECT message_id, chat_id, group_id, payload FROM pending_group_offline_backups').all() as Array<{ message_id: string; chat_id: number; group_id: string; payload: string }>;
    }

    deleteGroupOfflineSentMessagesByPrefix(bucketKeyPrefix: string): void {
        const stmt = this.db.prepare('DELETE FROM group_offline_sent_messages WHERE bucket_key LIKE ?');
        stmt.run(`${bucketKeyPrefix}%`);
    }

    // Message operations
    messageExists(messageId: string): boolean {
        const stmt = this.db.prepare(`SELECT id FROM messages WHERE id = ?`);
        const row = stmt.get(messageId);
        return !!row;
    }

    /**
     * Chat-scoped existence check. The global `messageExists` would treat a
     * cross-chat id collision as a duplicate; group offline catch-up needs to know
     * whether the message is already persisted *in this chat* specifically.
     */
    messageExistsInChat(chatId: number, messageId: string): boolean {
        const row = this.db
            .prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND id = ? LIMIT 1`)
            .get(chatId, messageId);
        return !!row;
    }

    getFileMessageById(messageId: string): Message | null {
        const row = this.db.prepare(`
            SELECT m.*
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            WHERE m.id = ?
              AND c.network_mode = ?
              AND m.message_type = 'file'
            LIMIT 1
        `).get(messageId, this.sessionNetworkMode) as (Omit<Message, 'timestamp' | 'event_timestamp' | 'created_at'> & {
            timestamp: string;
            event_timestamp: string | null;
            created_at: string;
        }) | undefined;
        if (!row) return null;
        return {
            ...row,
            timestamp: new Date(row.timestamp),
            event_timestamp: row.event_timestamp ? new Date(row.event_timestamp) : null,
            created_at: new Date(row.created_at),
        };
    }

    getPendingIncomingFileOffers(): Array<Message & { sender_username?: string }> {
        const rows = this.db.prepare(`
            SELECT m.*, u.username AS sender_username
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            LEFT JOIN users u
              ON u.peer_id = m.sender_peer_id
             AND u.network_mode = c.network_mode
            WHERE c.network_mode = ?
              AND m.message_type = 'file'
              AND m.transfer_status = 'incoming_pending_user'
            ORDER BY m.timestamp ASC
        `).all(this.sessionNetworkMode) as Array<Omit<Message, 'timestamp' | 'event_timestamp' | 'created_at'> & {
            timestamp: string;
            event_timestamp: string | null;
            created_at: string;
            sender_username?: string;
        }>;
        return rows.map((row) => ({
            ...row,
            timestamp: new Date(row.timestamp),
            event_timestamp: row.event_timestamp ? new Date(row.event_timestamp) : null,
            created_at: new Date(row.created_at),
        }));
    }

    getPendingFileInboxSnapshot(input: {
        maxPendingFilesPerPeer: number;
        maxPendingFilesTotal: number;
    }): PendingFileInboxSnapshot {
        const rows = this.db.prepare(`
            SELECT
                m.id,
                m.chat_id,
                m.sender_peer_id,
                m.file_name,
                m.file_size,
                m.timestamp,
                m.transfer_error,
                c.name AS chat_name,
                c.type AS chat_type,
                u.username AS sender_username
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            LEFT JOIN users u
              ON u.peer_id = m.sender_peer_id
             AND u.network_mode = c.network_mode
            WHERE c.network_mode = ?
              AND m.message_type = 'file'
              AND m.transfer_status = 'incoming_pending_user'
            ORDER BY m.timestamp ASC
        `).all(this.sessionNetworkMode) as Array<{
            id: string;
            chat_id: number;
            sender_peer_id: string;
            file_name: string | null;
            file_size: number | null;
            timestamp: string;
            transfer_error: string | null;
            chat_name: string | null;
            chat_type: 'direct' | 'group';
            sender_username: string | null;
        }>;

        const offers = rows.map((row) => ({
            fileId: row.id,
            chatId: row.chat_id,
            chatName: row.chat_name ?? 'Unknown chat',
            chatType: row.chat_type,
            senderPeerId: row.sender_peer_id,
            senderUsername: row.sender_username ?? row.sender_peer_id,
            filename: row.file_name ?? 'Unknown file',
            size: row.file_size ?? 0,
            offeredAt: new Date(row.timestamp).getTime(),
            countsTowardCapacity: !row.transfer_error,
            ...(row.transfer_error ? { transferError: row.transfer_error } : {}),
        }));

        const senderMap = new Map<string, PendingFileInboxSnapshot['senders'][number]>();
        for (const offer of offers) {
            let summary = senderMap.get(offer.senderPeerId);
            if (!summary) {
                summary = {
                    senderPeerId: offer.senderPeerId,
                    senderUsername: offer.senderUsername,
                    count: 0,
                    limit: input.maxPendingFilesPerPeer,
                    full: false,
                    offers: [],
                };
                senderMap.set(offer.senderPeerId, summary);
            }
            summary.offers.push(offer);
            if (offer.countsTowardCapacity) {
                summary.count += 1;
            }
        }

        const senders = [...senderMap.values()]
            .map((summary) => ({
                ...summary,
                full: summary.count >= input.maxPendingFilesPerPeer,
            }))
            .sort((a, b) => {
                if (a.full !== b.full) return a.full ? -1 : 1;
                if (a.count !== b.count) return b.count - a.count;
                return a.senderUsername.localeCompare(b.senderUsername);
            });

        const total = offers.filter((offer) => offer.countsTowardCapacity).length;
        return {
            total,
            totalLimit: input.maxPendingFilesTotal,
            full: total >= input.maxPendingFilesTotal,
            hasFullSender: senders.some((sender) => sender.full),
            senders,
            offers,
        };
    }

    rejectPendingIncomingFileOffer(messageId: string): {
        messageId: string;
        offerId: string;
        chatId: number;
        senderPeerId: string;
    } | null {
        const row = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'rejected',
                transfer_progress = 0,
                transfer_error = 'Offer rejected'
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'incoming_pending_user'
              AND chat_id IN (
                SELECT id FROM chats WHERE network_mode = ?
              )
              AND file_offer_id IS NOT NULL
            RETURNING
              id AS messageId,
              file_offer_id AS offerId,
              chat_id AS chatId,
              sender_peer_id AS senderPeerId
        `).get(messageId, this.sessionNetworkMode) as {
            messageId: string;
            offerId: string;
            chatId: number;
            senderPeerId: string;
        } | undefined;
        return row ?? null;
    }

    terminalizeOutgoingFileOfferFromNack(input: {
        offerId: string;
        chatId: number;
        localPeerId: string;
        status: 'rejected' | 'failed';
        error: string;
    }): { messageId: string; filename: string } | null {
        const row = this.db.prepare(`
            UPDATE messages
            SET transfer_status = ?,
                transfer_progress = 0,
                transfer_error = ?
            WHERE file_offer_id = ?
              AND chat_id = ?
              AND sender_peer_id = ?
              AND message_type = 'file'
              AND transfer_status = 'awaiting_acceptance'
              AND chat_id IN (
                SELECT id FROM chats WHERE network_mode = ?
              )
            RETURNING id AS messageId, file_name AS filename
        `).get(
            input.status,
            input.error,
            input.offerId,
            input.chatId,
            input.localPeerId,
            this.sessionNetworkMode,
        ) as { messageId: string; filename: string | null } | undefined;
        return row ? {
            messageId: row.messageId,
            filename: row.filename ?? 'Unknown file',
        } : null;
    }

    cancelOutgoingFileOffer(input: {
        fileId: string;
        localPeerId: string;
    }): { offerId: string; chatId: number; targetPeerId: string; filename: string } | null {
        const tx = this.db.transaction(() => {
            const row = this.db.prepare(`
                SELECT
                  m.file_offer_id AS offerId,
                  m.chat_id AS chatId,
                  m.file_name AS filename,
                  (
                    SELECT cp.peer_id
                    FROM chat_participants cp
                    WHERE cp.chat_id = m.chat_id
                      AND cp.peer_id != ?
                    LIMIT 1
                  ) AS targetPeerId
                FROM messages m
                JOIN chats c ON c.id = m.chat_id
                WHERE m.id = ?
                  AND m.sender_peer_id = ?
                  AND m.message_type = 'file'
                  AND m.transfer_status = 'awaiting_acceptance'
                  AND m.file_offer_id IS NOT NULL
                  AND c.type = 'direct'
                  AND c.network_mode = ?
                LIMIT 1
            `).get(
                input.localPeerId,
                input.fileId,
                input.localPeerId,
                this.sessionNetworkMode,
            ) as {
                offerId: string;
                chatId: number;
                filename: string | null;
                targetPeerId: string | null;
            } | undefined;
            if (!row?.targetPeerId) {
                return null;
            }
            const result = this.db.prepare(`
                UPDATE messages
                SET transfer_status = 'cancelled',
                    transfer_progress = 0,
                    transfer_error = 'Offer cancelled'
                WHERE id = ?
                  AND sender_peer_id = ?
                  AND message_type = 'file'
                  AND transfer_status = 'awaiting_acceptance'
                  AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
            `).run(input.fileId, input.localPeerId, this.sessionNetworkMode);
            if (result.changes !== 1) {
                return null;
            }
            return {
                offerId: row.offerId,
                chatId: row.chatId,
                targetPeerId: row.targetPeerId,
                filename: row.filename ?? 'Unknown file',
            };
        });
        return tx() as { offerId: string; chatId: number; targetPeerId: string; filename: string } | null;
    }

    cancelOutgoingGroupFileOffer(input: {
        fileId: string;
        localPeerId: string;
    }): {
        offerId: string;
        chatId: number;
        groupId: string;
        filename: string;
        status: 'cancelled' | 'partially_completed';
        error: string | null;
        groupDownloadTotal: number;
        groupDownloadCompleted: number;
    } | null {
        const tx = this.db.transaction(() => {
            const row = this.db.prepare(`
                SELECT
                  m.file_offer_id AS offerId,
                  m.chat_id AS chatId,
                  m.file_name AS filename,
                  COALESCE(m.file_group_download_total, 0) AS groupDownloadTotal,
                  COALESCE(m.file_group_download_completed, 0) AS groupDownloadCompleted,
                  c.group_id AS groupId
                FROM messages m
                JOIN chats c ON c.id = m.chat_id
                WHERE m.id = ?
                  AND m.sender_peer_id = ?
                  AND m.message_type = 'file'
                  AND m.transfer_status = 'awaiting_acceptance'
                  AND m.file_offer_id IS NOT NULL
                  AND c.type = 'group'
                  AND c.group_id IS NOT NULL
                  AND c.network_mode = ?
                LIMIT 1
            `).get(
                input.fileId,
                input.localPeerId,
                this.sessionNetworkMode,
            ) as {
                offerId: string;
                chatId: number;
                filename: string | null;
                groupDownloadTotal: number;
                groupDownloadCompleted: number;
                groupId: string | null;
            } | undefined;
            if (!row?.groupId) {
                return null;
            }

            const status = row.groupDownloadCompleted > 0 ? 'partially_completed' : 'cancelled';
            const error = status === 'cancelled' ? 'Offer cancelled' : null;
            const result = this.db.prepare(`
                UPDATE messages
                SET transfer_status = ?,
                    transfer_progress = ?,
                    transfer_error = ?
                WHERE id = ?
                  AND sender_peer_id = ?
                  AND message_type = 'file'
                  AND transfer_status = 'awaiting_acceptance'
                  AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
            `).run(
                status,
                status === 'partially_completed' ? 100 : 0,
                error,
                input.fileId,
                input.localPeerId,
                this.sessionNetworkMode,
            );
            if (result.changes !== 1) {
                return null;
            }
            return {
                offerId: row.offerId,
                chatId: row.chatId,
                groupId: row.groupId,
                filename: row.filename ?? 'Unknown file',
                status,
                error,
                groupDownloadTotal: row.groupDownloadTotal,
                groupDownloadCompleted: row.groupDownloadCompleted,
            };
        });
        return tx() as {
            offerId: string;
            chatId: number;
            groupId: string;
            filename: string;
            status: 'cancelled' | 'partially_completed';
            error: string | null;
            groupDownloadTotal: number;
            groupDownloadCompleted: number;
        } | null;
    }

    cancelPendingIncomingFileOfferByOfferId(input: {
        offerId: string;
        chatId: number;
        senderPeerId: string;
    }): { messageId: string; filename: string } | null {
        const row = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'cancelled',
                transfer_progress = 0,
                transfer_error = 'Offer cancelled'
            WHERE file_offer_id = ?
              AND chat_id = ?
              AND sender_peer_id = ?
              AND message_type = 'file'
              AND transfer_status = 'incoming_pending_user'
              AND chat_id IN (
                SELECT id FROM chats WHERE network_mode = ?
              )
            RETURNING id AS messageId, file_name AS filename
        `).get(
            input.offerId,
            input.chatId,
            input.senderPeerId,
            this.sessionNetworkMode,
        ) as { messageId: string; filename: string | null } | undefined;
        return row ? {
            messageId: row.messageId,
            filename: row.filename ?? 'Unknown file',
        } : null;
    }

    recordFileOfferCancellationTombstone(input: {
        offerId: string;
        senderPeerId: string;
    }): void {
        const now = Date.now();
        this.pruneExpiredFileOfferCancellationTombstones(now);
        this.db.prepare(`
            INSERT OR REPLACE INTO file_offer_cancellation_tombstones
              (network_mode, offer_id, sender_peer_id, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(this.sessionNetworkMode, input.offerId, input.senderPeerId, now, now + MESSAGE_TTL);
    }

    hasFileOfferCancellationTombstone(input: {
        offerId: string;
        senderPeerId: string;
    }): boolean {
        const now = Date.now();
        this.pruneExpiredFileOfferCancellationTombstones(now);
        const row = this.db.prepare(`
            SELECT 1
            FROM file_offer_cancellation_tombstones
            WHERE network_mode = ?
              AND offer_id = ?
              AND sender_peer_id = ?
              AND expires_at > ?
            LIMIT 1
        `).get(this.sessionNetworkMode, input.offerId, input.senderPeerId, now);
        return !!row;
    }

    private pruneExpiredFileOfferCancellationTombstones(now: number = Date.now()): void {
        this.db.prepare(`
            DELETE FROM file_offer_cancellation_tombstones
            WHERE network_mode = ?
              AND expires_at <= ?
        `).run(this.sessionNetworkMode, now);
    }

    getCompletedFileMediaById(messageId: string): {
        filePath: string;
        fileName: string;
    } | null {
        const row = this.db.prepare(`
            SELECT m.file_path, m.file_name
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            WHERE m.id = ?
              AND c.network_mode = ?
              AND m.message_type IN ('file', 'image')
              AND m.transfer_status = 'completed'
              AND m.file_path IS NOT NULL
              AND m.file_path != ''
            LIMIT 1
        `).get(messageId, this.sessionNetworkMode) as {
            file_path: string;
            file_name: string | null;
        } | undefined;

        if (!row) {
            return null;
        }

        return {
            filePath: row.file_path,
            fileName: row.file_name || path.basename(row.file_path),
        };
    }

    hasCompletedFilePath(filePath: string): boolean {
        const row = this.db.prepare(`
            SELECT 1
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            WHERE m.file_path = ?
              AND c.network_mode = ?
              AND m.message_type IN ('file', 'image')
              AND m.transfer_status = 'completed'
            LIMIT 1
        `).get(filePath, this.sessionNetworkMode);
        return !!row;
    }

    /**
     * Authoritative insert. A (chat_id, client_msg_id) collision is an invariant
     * violation here — outbound sends mint fresh cids, and other callers default
     * client_msg_id to the unique row id — so we DON'T swallow conflicts: a plain
     * INSERT throws (and the caller's transaction, if any, rolls back). For the
     * inbound path where the same logical message can legitimately arrive twice
     * (online + offline), use `tryCreateMessage` instead.
     */
    async createMessage(message: Omit<Message, 'created_at'>): Promise<string> {
        return this.retryOperation(() => {
            this.insertMessageRow(message, 'throw');
            return message.id;
        });
    }

    /**
     * Inbound dedup insert; reports whether a row was actually inserted so callers
     * can skip emitting a phantom "message received" event on a duplicate.
     * - `dedupe: 'cid'` (default) — direct inbound: the row `id` is a freshly minted
     *   per-receive UUID (never collides), only `(chat_id, client_msg_id)` can, so a
     *   cid-targeted `ON CONFLICT` is right (and a PK collision still throws — an anomaly).
     * - `dedupe: 'any'` — group inbound: `id == messageId == client_msg_id`, so a
     *   duplicate collides on the **PK `id`** too; a *targetless* `ON CONFLICT DO NOTHING`
     *   covers both. (Not `INSERT OR IGNORE`, which would also swallow NOT NULL/CHECK/FK.)
     */
    async tryCreateMessage(
        message: Omit<Message, 'created_at'>,
        opts?: { dedupe?: 'cid' | 'any' },
    ): Promise<{ id: string; inserted: boolean }> {
        const strategy = opts?.dedupe === 'any' ? 'ignoreAny' : 'ignoreCid';
        return this.retryOperation(() => {
            const inserted = this.insertMessageRow(message, strategy);
            // Targetless DO NOTHING swallows *any* uniqueness conflict, so a skipped
            // 'any' insert is only a valid duplicate if a row matching ALL of
            // (id, chat_id, client_msg_id) exists. Otherwise the conflict came from a
            // *different* row (cross-chat PK reuse, or a cid collision with a different
            // id) — throw so the caller does NOT advance sequence/cursor for a message
            // it never actually persisted.
            if (!inserted && strategy === 'ignoreAny') {
                this.assertIgnoredInsertIsExactDuplicate(message);
            }
            return { id: message.id, inserted };
        });
    }

    /** Throws unless a skipped insert corresponds to an exact-matching existing row. */
    private assertIgnoredInsertIsExactDuplicate(message: Omit<Message, 'created_at'>): void {
        const expectedCid = message.client_msg_id ?? message.id;
        const exact = this.db
            .prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ? AND client_msg_id = ? LIMIT 1')
            .get(message.id, message.chat_id, expectedCid);
        if (!exact) {
            throw new Error(
                `Message insert skipped on conflict but no exact-matching row exists ` +
                `(id=${message.id} chat=${message.chat_id} cid=${expectedCid}) — uniqueness collision with a different row`,
            );
        }
    }

    /**
     * Shared message INSERT. The conflict strategy decides duplicate handling:
     * `'throw'` (outbound/authoritative — surfaces an invariant violation),
     * `'ignoreCid'` (cid-targeted DO NOTHING, direct inbound), or
     * `'ignoreAny'` (targetless DO NOTHING, group inbound where id == cid).
     * Bumps the chat's updated_at only when a row was actually inserted. Returns
     * whether a row was inserted.
     */
    private insertMessageRow(
        message: Omit<Message, 'created_at'>,
        conflict: 'throw' | 'ignoreCid' | 'ignoreAny',
    ): boolean {
        const conflictClause =
            conflict === 'ignoreCid' ? 'ON CONFLICT(chat_id, client_msg_id) DO NOTHING'
                : conflict === 'ignoreAny' ? 'ON CONFLICT DO NOTHING'
                    : '';
        const ts = message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp;
        const info = this.db.prepare(`
            INSERT INTO messages (
                id, chat_id, sender_peer_id, content, message_type, timestamp,
                file_name, file_size, file_path, file_offer_id, file_checksum,
                file_total_chunks, file_protocol_version, file_group_download_total,
                file_group_download_completed, transfer_status, transfer_progress, transfer_error,
                local_send_state, failed_reason, retry_after_ts, event_timestamp, client_msg_id,
                reply_to_client_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ${conflictClause}
        `).run(
            message.id,
            message.chat_id,
            message.sender_peer_id,
            message.content,
            message.message_type,
            ts,
            message.file_name ?? null,
            message.file_size ?? null,
            message.file_path ?? null,
            message.file_offer_id ?? null,
            message.file_checksum ?? null,
            message.file_total_chunks ?? null,
            message.file_protocol_version ?? null,
            message.file_group_download_total ?? null,
            message.file_group_download_completed ?? null,
            message.transfer_status ?? null,
            message.transfer_progress ?? null,
            message.transfer_error ?? null,
            message.local_send_state ?? null,
            message.failed_reason ?? null,
            message.retry_after_ts ?? null,
            message.event_timestamp
                ? (message.event_timestamp instanceof Date
                    ? message.event_timestamp.toISOString()
                    : message.event_timestamp)
                : null,
            // cid defaults to the row id (file rows: id = fileId) so it is never null
            message.client_msg_id ?? message.id,
            message.reply_to_client_id ?? null,
        );

        const inserted = info.changes > 0;
        if (inserted) {
            this.db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(ts, message.chat_id);
        }
        return inserted;
    }

    /**
     * Atomically persist a new outbound message AND its pending offline-send queue
     * row in one transaction — and enforce the bucket capacity within that same
     * transaction so two concurrent sends can't both observe room and overfill.
     * Returns false (and writes nothing) if the bucket is full. The crash-safety
     * guarantee also holds: never a `sending` message row without its queue row.
     */
    createMessageWithPendingOfflineSend(
        message: Omit<Message, 'created_at'>,
        pending: { peerId: string; bucketKey: string; content: string; createdAt: number },
        capacityLimit: number,
    ): boolean {
        const ts = message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp;
        const tx = this.db.transaction(() => {
            // Capacity check inside the transaction: live (non-expired) stored count
            // + still-pending count, matching the write path's pruning.
            const storedRow = this.db.prepare('SELECT messages FROM offline_sent_messages WHERE bucket_key = ?')
                .get(pending.bucketKey) as { messages: string } | undefined;
            const now = Date.now();
            const storedLive = storedRow
                ? (JSON.parse(storedRow.messages) as Array<{ expires_at: number; signed_payload?: { ack_only?: boolean } }>)
                    .filter(m => m.expires_at > now && m.signed_payload?.ack_only !== true).length
                : 0;
            const pendingActive = (this.db.prepare(
                `SELECT COUNT(*) AS c FROM pending_offline_sends WHERE bucket_key = ? AND status = 'queued'`,
            ).get(pending.bucketKey) as { c: number }).c;
            if (storedLive + pendingActive >= capacityLimit) {
                return false;
            }
            this.db.prepare(`
                INSERT INTO messages (
                    id, chat_id, sender_peer_id, content, message_type, timestamp,
                    file_name, file_size, file_path, transfer_status, transfer_progress,
                    transfer_error, local_send_state, failed_reason, retry_after_ts, event_timestamp,
                    client_msg_id, reply_to_client_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                // Outbound own-send: a cid collision is an invariant violation, so a
                // plain INSERT throws and the surrounding transaction rolls back
                // (no orphaned pending-queue row).
                message.id, message.chat_id, message.sender_peer_id, message.content,
                message.message_type, ts,
                message.file_name ?? null, message.file_size ?? null, message.file_path ?? null,
                message.transfer_status ?? null, message.transfer_progress ?? null, message.transfer_error ?? null,
                message.local_send_state ?? null, message.failed_reason ?? null, message.retry_after_ts ?? null,
                null,
                message.client_msg_id ?? message.id, message.reply_to_client_id ?? null,
            );
            this.db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(ts, message.chat_id);
            this.db.prepare(`
                INSERT OR REPLACE INTO pending_offline_sends
                    (message_id, chat_id, peer_id, bucket_key, content, created_at, status, attempts, last_error)
                VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL)
            `).run(message.id, message.chat_id, pending.peerId, pending.bucketKey, pending.content, pending.createdAt);
            return true;
        });
        return tx() as boolean;
    }

    /**
     * Update the local outbound send lifecycle of a message. Pass state=null to
     * settle it (delivered) — clears the failure reason and retry cooldown.
     * retryAfterTs only persists for 'failed' (e.g. group-rekey cooldown).
     */
    updateMessageSendState(
        messageId: string,
        state: 'queued' | 'sending' | 'failed' | null,
        failedReason?: string | null,
        retryAfterTs?: number | null,
    ): void {
        const isFailed = state === 'failed';
        const stmt = this.db.prepare(`
            UPDATE messages SET local_send_state = ?, failed_reason = ?, retry_after_ts = ? WHERE id = ?
        `);
        stmt.run(
            state,
            isFailed ? (failedReason ?? 'other') : null,
            isFailed ? (retryAfterTs ?? null) : null,
            messageId,
        );
    }

    updateMessageTransfer(messageId: string, updates: {
        file_name?: string;
        file_size?: number;
        file_path?: string;
        transfer_status?: FileTransferStatus;
        transfer_progress?: number;
        transfer_error?: string;
    }): void {
        const stmt = this.db.prepare(`
            UPDATE messages SET
                file_name = COALESCE(?, file_name),
                file_size = COALESCE(?, file_size),
                file_path = COALESCE(?, file_path),
                transfer_status = COALESCE(?, transfer_status),
                transfer_progress = COALESCE(?, transfer_progress),
                transfer_error = COALESCE(?, transfer_error)
            WHERE id = ?
        `);

        stmt.run(
            updates.file_name ?? null,
            updates.file_size ?? null,
            updates.file_path ?? null,
            updates.transfer_status ?? null,
            updates.transfer_progress ?? null,
            updates.transfer_error ?? null,
            messageId
        );
    }

    /**
     * Compare-and-set terminal transition for an outgoing served file: applies only while the row
     * is still in the active serving state (`awaiting_acceptance`), so the first terminal state
     * wins and a serve completion can never overwrite an already-applied NACK (rejected/failed).
     * Returns true iff this call performed the transition.
     */
    terminalizeServedFileIfActive(
        fileId: string,
        status: 'completed' | 'partially_completed' | 'failed' | 'cancelled',
        progress: number,
        error: string | null,
    ): boolean {
        const result = this.db.prepare(`
            UPDATE messages
            SET transfer_status = ?, transfer_progress = ?, transfer_error = ?
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'awaiting_acceptance'
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
        `).run(status, progress, error, fileId, this.sessionNetworkMode);
        return result.changes === 1;
    }

    recordGroupServedFileDownloadIfActive(fileId: string): {
        completed: number;
        total: number;
        completedAll: boolean;
    } | null {
        const row = this.db.prepare(`
            UPDATE messages
            SET file_group_download_completed = COALESCE(file_group_download_completed, 0) + 1,
                transfer_error = NULL
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'awaiting_acceptance'
              AND file_group_download_total IS NOT NULL
              AND file_group_download_total > 0
              AND COALESCE(file_group_download_completed, 0) < file_group_download_total
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
            RETURNING
              file_group_download_completed AS completed,
              file_group_download_total AS total
        `).get(fileId, this.sessionNetworkMode) as { completed: number; total: number } | undefined;
        if (!row) {
            return null;
        }
        return {
            completed: row.completed,
            total: row.total,
            completedAll: row.completed >= row.total,
        };
    }

    claimIncomingFilePull(messageId: string): {
        messageId: string;
        chatId: number;
        senderPeerId: string;
        offerId: string;
        fileName: string;
        size: number;
        checksum: string;
        totalChunks: number;
    } | null {
        const row = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'in_progress',
                transfer_progress = 0,
                transfer_error = NULL
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'incoming_pending_user'
              AND file_offer_id IS NOT NULL
              AND file_name IS NOT NULL
              AND file_size IS NOT NULL
              AND file_checksum IS NOT NULL
              AND file_total_chunks IS NOT NULL
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
            RETURNING
              id AS messageId,
              chat_id AS chatId,
              sender_peer_id AS senderPeerId,
              file_offer_id AS offerId,
              file_name AS fileName,
              file_size AS size,
              file_checksum AS checksum,
              file_total_chunks AS totalChunks
        `).get(messageId, this.sessionNetworkMode) as {
            messageId: string;
            chatId: number;
            senderPeerId: string;
            offerId: string;
            fileName: string;
            size: number;
            checksum: string;
            totalChunks: number;
        } | undefined;
        return row ?? null;
    }

    updateIncomingFilePullProgress(messageId: string, progress: number): boolean {
        const result = this.db.prepare(`
            UPDATE messages
            SET transfer_progress = ?
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'in_progress'
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
        `).run(progress, messageId, this.sessionNetworkMode);
        return result.changes === 1;
    }

    resetIncomingFilePullToPending(messageId: string, error: string): boolean {
        const result = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'incoming_pending_user',
                transfer_progress = 0,
                transfer_error = ?
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'in_progress'
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
        `).run(error, messageId, this.sessionNetworkMode);
        return result.changes === 1;
    }

    failIncomingFilePull(messageId: string, error: string): boolean {
        const result = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'failed',
                transfer_progress = 0,
                transfer_error = ?
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'in_progress'
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
        `).run(error, messageId, this.sessionNetworkMode);
        return result.changes === 1;
    }

    cancelIncomingFilePull(messageId: string, error: string): boolean {
        const result = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'failed',
                transfer_progress = 0,
                transfer_error = ?
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'in_progress'
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
        `).run(error, messageId, this.sessionNetworkMode);
        return result.changes === 1;
    }

    completeIncomingFilePull(messageId: string, filePath: string): boolean {
        const result = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'completed',
                transfer_progress = 100,
                transfer_error = NULL,
                file_path = ?
            WHERE id = ?
              AND message_type = 'file'
              AND transfer_status = 'in_progress'
              AND chat_id IN (SELECT id FROM chats WHERE network_mode = ?)
        `).run(filePath, messageId, this.sessionNetworkMode);
        return result.changes === 1;
    }

    failNonTerminalFileTransfers(reason: string = 'Transfer interrupted'): number {
        const stmt = this.db.prepare(`
            UPDATE messages
            SET transfer_status = 'failed', transfer_error = ?
            WHERE message_type = 'file'
              AND chat_id IN (
                SELECT id FROM chats WHERE network_mode = ?
              )
              AND transfer_status IN (
                'in_progress',
                'connecting',
                'awaiting_acceptance',
                'uploading',
                'awaiting_confirmation',
                'downloading'
              )
        `);
        const result = stmt.run(reason, this.sessionNetworkMode);
        return result.changes ?? 0;
    }

    getMessagesByChatId(chatId: number, limit: number = 50, offset: number = 0): Array<Message & { sender_username?: string | undefined }> {
        const stmt = this.db.prepare(`
            SELECT * FROM (
                SELECT
                    m.*,
                    u.username as sender_username
                FROM messages m
                JOIN chats c ON c.id = m.chat_id
                LEFT JOIN users u ON m.sender_peer_id = u.peer_id AND u.network_mode = c.network_mode
                WHERE m.chat_id = ?
                ORDER BY m.timestamp DESC
                LIMIT ? OFFSET ?
            ) AS recent_messages
            ORDER BY timestamp ASC
        `);

        const rows = stmt.all(chatId, limit, offset) as any[];

        return rows.map(row => ({
            ...row,
            timestamp: new Date(row.timestamp),
            event_timestamp: row.event_timestamp ? new Date(row.event_timestamp) : null,
            created_at: new Date(row.created_at),
            sender_username: row.sender_username || undefined
        }));
    }

    getMessageJumpWindow(chatId: number, clientMsgId: string): MessageJumpWindowResponse {
        if (!Number.isInteger(chatId) || chatId <= 0 || typeof clientMsgId !== 'string' || clientMsgId.length === 0) {
            throw new Error('Invalid message jump request');
        }

        const loadWindow = this.db.transaction((): MessageJumpWindowResponse => {
            const target = this.db.prepare(`
                SELECT rowid, timestamp
                FROM messages
                WHERE chat_id = ? AND client_msg_id = ?
                LIMIT 1
            `).get(chatId, clientMsgId) as { rowid: number; timestamp: string } | undefined;

            if (!target) {
                return { status: 'not_found', messages: [], hasMoreOlder: false };
            }

            const newerCount = (this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM messages
                WHERE chat_id = ?
                  AND (
                    timestamp > ?
                    OR (timestamp = ? AND rowid > ?)
                  )
            `).get(chatId, target.timestamp, target.timestamp, target.rowid) as { count: number }).count;

            const requiredCount = newerCount + 1;
            if (requiredCount > MAX_MESSAGE_JUMP_WINDOW_SIZE) {
                return { status: 'too_deep', messages: [], hasMoreOlder: true };
            }

            const limit = Math.min(
                MAX_MESSAGE_JUMP_WINDOW_SIZE,
                requiredCount + MESSAGE_JUMP_CONTEXT_SIZE,
            );
            const rows = this.db.prepare(`
                SELECT * FROM (
                    SELECT
                        m.*,
                        u.username AS sender_username
                    FROM messages m
                    JOIN chats c ON c.id = m.chat_id
                    LEFT JOIN users u
                      ON m.sender_peer_id = u.peer_id
                     AND u.network_mode = c.network_mode
                    WHERE m.chat_id = ?
                    ORDER BY m.timestamp DESC, m.rowid DESC
                    LIMIT ?
                ) AS jump_window
                ORDER BY timestamp ASC
            `).all(chatId, limit) as any[];

            const total = (this.db.prepare(
                'SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?'
            ).get(chatId) as { count: number }).count;

            return {
                status: 'loaded',
                messages: rows.map((row) => ({
                    ...row,
                    timestamp: new Date(row.timestamp),
                    event_timestamp: row.event_timestamp ? new Date(row.event_timestamp) : null,
                    created_at: new Date(row.created_at),
                    sender_username: row.sender_username || undefined,
                })),
                hasMoreOlder: total > rows.length,
            };
        });

        return loadWindow();
    }

    getMessagePreviewByClientMsgId(chatId: number, clientMsgId: string): {
        senderPeerId: string;
        senderUsername: string | undefined;
        content: string;
        messageType: 'text' | 'file' | 'image' | 'system';
        fileName: string | undefined;
    } | null {
        const stmt = this.db.prepare(`
            SELECT m.sender_peer_id, m.content, m.message_type, m.file_name, u.username AS sender_username
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            LEFT JOIN users u ON m.sender_peer_id = u.peer_id AND u.network_mode = c.network_mode
            WHERE m.chat_id = ? AND m.client_msg_id = ?
            LIMIT 1
        `);
        const row = stmt.get(chatId, clientMsgId) as any;
        if (!row) return null;
        return {
            senderPeerId: row.sender_peer_id,
            senderUsername: row.sender_username || undefined,
            content: row.content,
            messageType: row.message_type,
            fileName: row.file_name || undefined,
        };
    }

    // Pin or unpin a message
    setMessagePinned(chatId: number, clientMsgId: string, pinned: boolean): boolean {
        const tx = this.db.transaction((): boolean => {
            this.db.prepare(
                'UPDATE messages SET pinned_at = NULL WHERE chat_id = ? AND pinned_at IS NOT NULL'
            ).run(chatId);
            if (!pinned) return true;
            const result = this.db.prepare(
                'UPDATE messages SET pinned_at = ? WHERE chat_id = ? AND client_msg_id = ?'
            ).run(Date.now(), chatId, clientMsgId);
            return (result.changes ?? 0) > 0;
        });
        return tx();
    }

    /** The single pinned message for a chat (local-only), or null. */
    getPinnedMessage(chatId: number): PinnedMessagePreview | null {
        const stmt = this.db.prepare(`
            SELECT m.client_msg_id, m.sender_peer_id, m.content, m.message_type, m.file_name,
                   u.username AS sender_username
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
            LEFT JOIN users u ON m.sender_peer_id = u.peer_id AND u.network_mode = c.network_mode
            WHERE m.chat_id = ? AND m.pinned_at IS NOT NULL
            ORDER BY m.pinned_at DESC
            LIMIT 1
        `);
        const row = stmt.get(chatId) as any;
        if (!row || !row.client_msg_id) return null;
        return {
            clientMsgId: row.client_msg_id,
            senderPeerId: row.sender_peer_id,
            senderUsername: row.sender_username || undefined,
            content: row.content,
            messageType: row.message_type,
            fileName: row.file_name || undefined,
        };
    }

    getLatestMessageForChat(chatId: number): Message | null {
        const stmt = this.db.prepare(`
            SELECT * FROM messages 
            WHERE chat_id = ? 
            ORDER BY timestamp DESC 
            LIMIT 1
        `);

        const row = stmt.get(chatId) as any;

        if (!row) return null;

        return {
            ...row,
            timestamp: new Date(row.timestamp),
            event_timestamp: row.event_timestamp ? new Date(row.event_timestamp) : null,
            created_at: new Date(row.created_at)
        };
    }

    /**
     * Conversation search, scoped to one chat. Matches message text + filenames,
     * excludes system messages, newest-first. Two query paths by length:
     *   - >= 3 chars -> FTS5 trigram MATCH (indexed substring search) as an
     *     indexed pre-filter, refined by the type-scoped LIKE below.
     *   - 1-2 chars  -> type-scoped LIKE over the single chat (trigram can't
     *     index <3-char terms); bounded to one chat_id so the scan stays cheap.
     *
     * Column scope: TEXT messages match on `content`; FILE/IMAGE messages match
     * on `file_name` only (their `content` is the synthetic "name (size bytes)"
     * string, outside the agreed text+filename scope).
     *
     * Pagination is **keyset** on (timestamp, rowid), not OFFSET: a message
     * deleted mid-search can't shift later pages and skip a match. `snapshotMaxRowid`
     * additionally freezes the searchable universe (and the total) for the life
     * of one query so arriving messages don't inflate the count.
     */
    searchChatMessages(
        chatId: number,
        rawQuery: string,
        options?: {
            limit?: number;
            snapshotMaxRowid?: number;
            cursor?: ChatMessageSearchCursor | null;
        },
    ): ChatMessageSearchResponse {
        const empty: ChatMessageSearchResponse = {
            results: [], total: 0, snapshotMaxRowid: 0, nextCursor: null,
        };

        const query = (rawQuery ?? '').trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
        if (!Number.isInteger(chatId) || chatId <= 0 || query.length === 0) {
            return empty;
        }

        const rawLimit = options?.limit;
        const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(Math.trunc(rawLimit as number), 1), MAX_SEARCH_PAGE_SIZE)
            : DEFAULT_SEARCH_PAGE_SIZE;

        // Stable snapshot: capture MAX(rowid) once per query and reuse across pages.
        let snapshotMaxRowid =
            Number.isFinite(options?.snapshotMaxRowid) && (options!.snapshotMaxRowid as number) > 0
                ? Math.trunc(options!.snapshotMaxRowid as number)
                : 0;
        if (snapshotMaxRowid <= 0) {
            const row = this.db
                .prepare(`SELECT MAX(rowid) AS maxRowid FROM messages WHERE chat_id = ?`)
                .get(chatId) as { maxRowid: number | null } | undefined;
            snapshotMaxRowid = row?.maxRowid ?? 0;
        }
        if (snapshotMaxRowid <= 0) {
            return empty;
        }

        const cursor = options?.cursor ?? null;
        const hasCursor = !!cursor
            && Number.isFinite(cursor.timestamp)
            && Number.isInteger(cursor.rowid);

        const useFts = query.length >= 3;
        const likeExpr = `%${escapeLikePattern(query)}%`;

        // text -> content; file/image -> file_name only.
        const typeScoped = `(
            (m.message_type = 'text' AND m.content LIKE ? ESCAPE '\\')
            OR (m.message_type IN ('file', 'image')
                AND m.file_name IS NOT NULL
                AND m.file_name LIKE ? ESCAPE '\\')
        )`;

        // FTS path adds an indexed trigram MATCH as a pre-filter; the quoted
        // term keeps special chars from altering the FTS grammar.
        const source = useFts
            ? `FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
               WHERE messages_fts MATCH ? AND`
            : `FROM messages m WHERE`;
        const matchParam = useFts ? [`"${query.replace(/"/g, '""')}"`] : [];
        const scopeParams = [chatId, snapshotMaxRowid, likeExpr, likeExpr];

        const cursorClause = hasCursor
            ? `AND (m.timestamp < ? OR (m.timestamp = ? AND m.rowid < ?))`
            : '';
        const cursorIso = hasCursor ? new Date(cursor!.timestamp).toISOString() : null;
        const cursorParams = hasCursor ? [cursorIso, cursorIso, cursor!.rowid] : [];

        const rows = this.db.prepare(`
            SELECT m.id, m.client_msg_id, m.content, m.file_name, m.message_type,
                   m.sender_peer_id, m.timestamp, m.rowid AS rowid
            ${source} m.chat_id = ?
                  AND m.message_type != 'system'
                  AND m.rowid <= ?
                  AND ${typeScoped}
                  ${cursorClause}
            ORDER BY m.timestamp DESC, m.rowid DESC
            LIMIT ?
        `).all(...matchParam, ...scopeParams, ...cursorParams, limit) as any[];

        const total = (this.db.prepare(`
            SELECT COUNT(*) AS total
            ${source} m.chat_id = ?
                  AND m.message_type != 'system'
                  AND m.rowid <= ?
                  AND ${typeScoped}
        `).get(...matchParam, ...scopeParams) as { total: number }).total;

        const results: ChatMessageSearchResult[] = rows.map((row) => ({
            id: row.id as string,
            clientMsgId: (row.client_msg_id ?? null) as string | null,
            content: row.content as string,
            fileName: (row.file_name ?? null) as string | null,
            messageType: row.message_type as ChatMessageSearchResult['messageType'],
            senderPeerId: row.sender_peer_id as string,
            timestamp: new Date(row.timestamp).getTime(),
        }));

        const last = rows[rows.length - 1];
        const nextCursor: ChatMessageSearchCursor | null =
            rows.length === limit && last
                ? { timestamp: new Date(last.timestamp).getTime(), rowid: last.rowid as number }
                : null;

        return { results, total, snapshotMaxRowid, nextCursor };
    }

    // Utility methods
    deleteMessage(messageId: number): void {
        const stmt = this.db.prepare('DELETE FROM messages WHERE id = ?');
        stmt.run(messageId);
    }

    deleteMessagesForMe(chatId: number, messageIds: string[]): DeleteMessagesForMeResult {
        if (!Number.isInteger(chatId) || chatId <= 0) {
            throw new Error('Invalid chat id');
        }
        if (messageIds.length === 0) {
            throw new Error('Select at least one message to delete');
        }
        if (messageIds.some((messageId) => typeof messageId !== 'string' || messageId.length === 0)) {
            throw new Error('Invalid message id');
        }
        if (new Set(messageIds).size !== messageIds.length) {
            throw new Error('Duplicate message ids are not allowed');
        }

        const chunkSize = 500;
        const transaction = this.db.transaction((): DeleteMessagesForMeResult => {
            const selectedRows: Array<{
                id: string;
                message_type: Message['message_type'];
                local_send_state: Message['local_send_state'];
                transfer_status: FileTransferStatus | null;
            }> = [];

            for (let start = 0; start < messageIds.length; start += chunkSize) {
                const ids = messageIds.slice(start, start + chunkSize);
                const placeholders = ids.map(() => '?').join(',');
                const rows = this.db.prepare(`
                    SELECT id, message_type, local_send_state, transfer_status
                    FROM messages
                    WHERE chat_id = ? AND id IN (${placeholders})
                `).all(chatId, ...ids) as typeof selectedRows;
                selectedRows.push(...rows);
            }

            if (selectedRows.length !== messageIds.length) {
                throw new Error('One or more selected messages no longer exist in this chat');
            }

            const hasIneligibleRow = selectedRows.some((row) =>
                row.message_type === 'system'
                || (
                    row.local_send_state !== null
                    && row.local_send_state !== 'failed'
                )
                || (
                    (row.message_type === 'file' || row.message_type === 'image')
                    && !['completed', 'partially_completed', 'failed', 'rejected', 'cancelled'].includes(row.transfer_status ?? '')
                )
            );
            if (hasIneligibleRow) {
                throw new Error('One or more selected messages cannot be deleted');
            }

            for (let start = 0; start < messageIds.length; start += chunkSize) {
                const ids = messageIds.slice(start, start + chunkSize);
                const placeholders = ids.map(() => '?').join(',');
                this.db.prepare(`
                    DELETE FROM pending_offline_sends
                    WHERE message_id IN (${placeholders})
                `).run(...ids);
                this.db.prepare(`
                    DELETE FROM pending_group_offline_backups
                    WHERE message_id IN (${placeholders})
                `).run(...ids);
            }

            let deletedCount = 0;
            for (let start = 0; start < messageIds.length; start += chunkSize) {
                const ids = messageIds.slice(start, start + chunkSize);
                const placeholders = ids.map(() => '?').join(',');
                const result = this.db.prepare(`
                    DELETE FROM messages
                    WHERE chat_id = ? AND id IN (${placeholders})
                `).run(chatId, ...ids);
                deletedCount += result.changes ?? 0;
            }

            if (deletedCount !== messageIds.length) {
                throw new Error('Message deletion did not complete atomically');
            }

            const latestRow = this.db.prepare(`
                SELECT content, timestamp, client_msg_id
                FROM messages
                WHERE chat_id = ? AND local_send_state IS NULL
                ORDER BY timestamp DESC, created_at DESC, id DESC
                LIMIT 1
            `).get(chatId) as {
                content: string;
                timestamp: string | number;
                client_msg_id: string | null;
            } | undefined;

            return {
                deletedCount,
                latestRemaining: latestRow
                    ? {
                        content: latestRow.content,
                        timestamp: new Date(latestRow.timestamp),
                        clientMsgId: latestRow.client_msg_id,
                    }
                    : null,
            };
        });

        return transaction();
    }

    deleteAllMessagesForChat(chatId: number): void {
        const stmt = this.db.prepare('DELETE FROM messages WHERE chat_id = ?');
        stmt.run(chatId);
    }

    deleteChatAndUser(chatId: number, userPeerId: string): void {
        const deleteChatStmt = this.db.prepare('DELETE FROM chats WHERE id = ?');
        const hasAnyChatWithPeerStmt = this.db.prepare(`
            SELECT 1
            FROM chat_participants
            JOIN chats c ON c.id = chat_participants.chat_id
            WHERE chat_participants.peer_id = ?
            AND c.network_mode = ?
            LIMIT 1
        `);
        const deleteUserStmt = this.db.prepare('DELETE FROM users WHERE peer_id = ? AND network_mode = ?');
        const mode = this.getActiveNetworkMode();

        const txn = this.db.transaction((cId: number, peerId: string) => {
            deleteChatStmt.run(cId);
            const stillHasChats = hasAnyChatWithPeerStmt.get(peerId, mode) !== undefined;
            if (!stillHasChats) {
                deleteUserStmt.run(peerId, mode);
            }
        });

        txn(chatId, userPeerId);
    }

    deleteContactAttemptsByPeerId(peerId: string): void {
        const stmt = this.db.prepare('DELETE FROM contact_attempts WHERE sender_peer_id = ? AND network_mode = ?');
        stmt.run(peerId, this.getActiveNetworkMode());
    }

    deleteChatParticipantByChatId(chatId: number): void {
        const stmt = this.db.prepare('DELETE FROM chat_participants WHERE chat_id = ?');
        stmt.run(chatId);
    }

    deleteBlockedPeer(peerId: string): void {
        const stmt = this.db.prepare('DELETE FROM blocked_peers WHERE peer_id = ? AND network_mode = ?');
        stmt.run(peerId, this.getActiveNetworkMode());
    }

    deleteChat(chatId: number): void {
        // Messages will be deleted automatically due to CASCADE
        const stmt = this.db.prepare('DELETE FROM chats WHERE id = ?');
        stmt.run(chatId);
    }

    getMessageCount(chatId: number): number {
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ?');
        const result = stmt.get(chatId) as { count: number };
        return result.count;
    }

    // Notification operations
    createNotification(notification: Omit<Notification, 'created_at' | 'network_mode'>): string {
        const mode = this.getActiveNetworkMode();
        const stmt = this.db.prepare('INSERT INTO notifications (id, network_mode, notification_type, notification_data, bucket_key, status) VALUES (?, ?, ?, ?, ?, ?)');
        stmt.run(notification.id, mode, notification.notification_type, notification.notification_data, notification.bucket_key, notification.status || 'pending');
        return notification.id;
    }

    updateNotificationStatus(
        notificationId: string,
        status: 'pending' | 'accepted' | 'rejected' | 'expired',
        mode?: NetworkMode,
    ): void {
        const stmt = this.db.prepare('UPDATE notifications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND network_mode = ?');
        stmt.run(status, notificationId, this.getActiveNetworkMode(mode));
    }

    getNotificationById(notificationId: string): Notification | null {
        const stmt = this.db.prepare('SELECT * FROM notifications WHERE id = ? AND network_mode = ?');
        const row = stmt.get(notificationId, this.getActiveNetworkMode()) as any;
        if (!row) return null;
        return row as Notification;
    }

    getNotificationsByBucketKey(bucketKey: string): Notification[] {
        const stmt = this.db.prepare('SELECT * FROM notifications WHERE bucket_key = ? AND network_mode = ?');
        const rows = stmt.all(bucketKey, this.getActiveNetworkMode()) as any[];
        return rows.map(row => ({
            ...row,
            created_at: new Date(row.created_at)
        }));
    }

    getAllNotifications(): Notification[] {
        const stmt = this.db.prepare('SELECT * FROM notifications WHERE network_mode = ? ORDER BY created_at DESC');
        const rows = stmt.all(this.getActiveNetworkMode()) as any[];
        return rows.map(row => ({
            ...row,
            created_at: new Date(row.created_at)
        }));
    }

    getPendingGroupInvitationNotifications(): PendingGroupInvitationNotification[] {
        const stmt = this.db.prepare(`
            SELECT *
            FROM notifications
            WHERE network_mode = ?
              AND notification_type = 'group_invitation'
              AND status = 'pending'
            ORDER BY created_at DESC
        `);
        const rows = stmt.all(this.getActiveNetworkMode()) as any[];
        return rows.map(row => ({
            ...row,
            status: 'pending' as const,
            notification_type: 'group_invitation' as const,
            created_at: new Date(row.created_at)
        }));
    }

    // Bootstrap nodes operations
    getBootstrapNodes(): { address: string }[] {
        const stmt = this.db.prepare('SELECT address FROM bootstrap_nodes WHERE network_mode = ? ORDER BY sort_order ASC, id ASC');
        return stmt.all(this.getActiveNetworkMode()) as { address: string }[];
    }

    removeBootstrapNode(address: string): void {
        const stmt = this.db.prepare('DELETE FROM bootstrap_nodes WHERE address = ? AND network_mode = ?');
        stmt.run(address, this.getActiveNetworkMode());
    }

    addBootstrapNode(address: string): void {
        const mode = this.getActiveNetworkMode();
        const existsStmt = this.db.prepare('SELECT 1 FROM bootstrap_nodes WHERE address = ? AND network_mode = ? LIMIT 1');
        const exists = existsStmt.get(address, mode) as { 1: number } | undefined;
        if (exists) {
            throw new Error('Bootstrap node already exists');
        }

        const maxOrder = (this.db.prepare('SELECT MAX(sort_order) as max_order FROM bootstrap_nodes WHERE network_mode = ?').get(mode) as { max_order: number | null })?.max_order ?? -1;
        const stmt = this.db.prepare('INSERT INTO bootstrap_nodes (address, network_mode, sort_order) VALUES (?, ?, ?)');
        stmt.run(address, mode, maxOrder + 1);
    }

    reorderBootstrapNodes(addresses: string[]): void {
        const mode = this.getActiveNetworkMode();
        const existingRows = this.db
            .prepare('SELECT address FROM bootstrap_nodes WHERE network_mode = ?')
            .all(mode) as Array<{ address: string }>;
        const existingAddresses = existingRows.map((row) => row.address);
        const existingSet = new Set(existingAddresses);

        if (addresses.length !== existingSet.size) {
            throw new Error('Invalid bootstrap reorder payload: address count mismatch');
        }
        for (const address of addresses) {
            if (!existingSet.has(address)) {
                throw new Error(`Invalid bootstrap reorder payload: unknown address "${address}"`);
            }
        }

        const updateStmt = this.db.prepare('UPDATE bootstrap_nodes SET sort_order = ? WHERE address = ? AND network_mode = ?');
        const transaction = this.db.transaction(() => {
            for (let i = 0; i < addresses.length; i++) {
                const info = updateStmt.run(i, addresses[i], mode);
                if (info.changes !== 1) {
                    throw new Error(`Failed to reorder bootstrap node: "${addresses[i]}"`);
                }
            }
        });
        transaction();
    }

    isHealthy(): boolean {
        try {
            this.db.prepare('SELECT 1').get();
            return true;
        } catch (error) {
            console.error('Database health check failed:', error);
            return false;
        }
    }

    checkIntegrity(): { ok: boolean; errors: string[] } {
        try {
            const result = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;

            // integrity_check returns array with single "ok" if healthy, or array of error messages
            const isOk = result.length === 1 && result[0]?.integrity_check === 'ok';
            const errors = isOk ? [] : result.map(r => r.integrity_check);

            if (!isOk) {
                const errorMsg = `Database corruption detected: ${errors.join(', ')}`;
                console.error(`[DATABASE] ${errorMsg}`);
            } else {
                log('[DATABASE] Integrity check passed');
            }

            return { ok: isOk, errors };
        } catch (error) {
            const errorMsg = `Database integrity check failed: ${errStr(error)}`;
            console.error(`[DATABASE] ${errorMsg}`);
            return { ok: false, errors: [errorMsg] };
        }
    }

    private reconnect(): void {
        try {
            this.db.close();
        } catch {
            // Ignore close errors
        }
        try {
            this.db = new Database(this.dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.pragma('cache_size = 10000');
            this.db.pragma('temp_store = memory');
            this.db.pragma('mmap_size = 268435456'); // 256MB
            log('Database reconnected successfully');
        } catch (error) {
            console.error('Failed to reconnect to database:', error);
            throw error;
        }
    }

    // Login attempts methods
    getLoginAttempt(peerId: string, mode?: NetworkMode): LoginAttempt | undefined {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('SELECT * FROM login_attempts WHERE peer_id = ? AND network_mode = ?');
        const row = stmt.get(peerId, activeMode) as any;
        if (!row) return undefined;

        return {
            ...row,
            network_mode: row.network_mode,
            last_attempt_at: new Date(row.last_attempt_at),
            cooldown_until: row.cooldown_until ? new Date(row.cooldown_until) : null,
            created_at: new Date(row.created_at)
        };
    }

    recordFailedLoginAttempt(peerId: string, mode?: NetworkMode): void {
        const activeMode = this.getActiveNetworkMode(mode);
        const existing = this.getLoginAttempt(peerId, activeMode);
        const now = new Date();

        if (existing) {
            const newCount = existing.attempt_count + 1;
            const cooldownMinutes = this.calculateCooldown(newCount);

            // Only apply cooldown if we've reached 5 or more attempts
            const cooldownUntil = cooldownMinutes > 0
                ? new Date(now.getTime() + cooldownMinutes * 60000)
                : null;

            const stmt = this.db.prepare(`
                UPDATE login_attempts
                SET attempt_count = ?,
                    last_attempt_at = ?,
                    cooldown_until = ?
                WHERE peer_id = ? AND network_mode = ?
            `);
            stmt.run(newCount, now.toISOString(), cooldownUntil?.toISOString() || null, peerId, activeMode);
        } else {
            // First attempt - no cooldown
            const stmt = this.db.prepare(`
                INSERT INTO login_attempts (network_mode, peer_id, attempt_count, last_attempt_at, cooldown_until)
                VALUES (?, ?, ?, ?, ?)
            `);
            stmt.run(activeMode, peerId, 1, now.toISOString(), null);
        }
    }

    clearLoginAttempts(peerId: string, mode?: NetworkMode): void {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare('DELETE FROM login_attempts WHERE peer_id = ? AND network_mode = ?');
        stmt.run(peerId, activeMode);
    }

    private calculateCooldown(attemptCount: number): number {
        if (attemptCount <= 4) return 0; // No cooldown for first 4 attempts
        if (attemptCount === 5) return 5;
        if (attemptCount === 6) return 10;
        if (attemptCount === 7) return 20;
        if (attemptCount === 8) return 30;
        return 60; // 9+ attempts = 60 minutes
    }

    checkLoginCooldown(peerId: string, mode?: NetworkMode): { isLocked: boolean; remainingSeconds: number } {
        const attempt = this.getLoginAttempt(peerId, mode);
        if (!attempt || !attempt.cooldown_until) {
            return { isLocked: false, remainingSeconds: 0 };
        }

        const now = new Date();
        const remainingMs = attempt.cooldown_until.getTime() - now.getTime();

        if (remainingMs <= 0) {
            // Cooldown expired
            return { isLocked: false, remainingSeconds: 0 };
        }

        return {
            isLocked: true,
            remainingSeconds: Math.ceil(remainingMs / 1000)
        };
    }

    // Toggle mute status for a chat
    toggleChatMute(chatId: number): boolean {
        const stmt = this.db.prepare('UPDATE chats SET muted = NOT muted WHERE id = ?');
        stmt.run(chatId);

        // Return new muted status
        const chat = this.db.prepare('SELECT muted FROM chats WHERE id = ?').get(chatId) as { muted: number } | undefined;
        return Boolean(chat?.muted);
    }

    // --- Group key history ---

    insertGroupKeyHistory(
        groupId: string,
        keyVersion: number,
        encryptedKey: string,
        groupInfoMetadataKey: string,
    ): void {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO group_key_history (group_id, key_version, encrypted_key, group_info_metadata_key)
            VALUES (?, ?, ?, ?)
        `);
        if (!groupInfoMetadataKey) {
            throw new Error('groupInfoMetadataKey is required');
        }
        stmt.run(groupId, keyVersion, encryptedKey, groupInfoMetadataKey);
    }

    getGroupKeyForEpoch(groupId: string, keyVersion: number): string | null {
        const stmt = this.db.prepare('SELECT encrypted_key FROM group_key_history WHERE group_id = ? AND key_version = ?');
        const row = stmt.get(groupId, keyVersion) as { encrypted_key: string } | undefined;
        return row?.encrypted_key ?? null;
    }

    getGroupInfoMetadataKeyForEpoch(groupId: string, keyVersion: number): string | null {
        const stmt = this.db.prepare('SELECT group_info_metadata_key FROM group_key_history WHERE group_id = ? AND key_version = ?');
        const row = stmt.get(groupId, keyVersion) as { group_info_metadata_key: string } | undefined;
        return row?.group_info_metadata_key ?? null;
    }

    getGroupKeyHistory(groupId: string): GroupKeyHistory[] {
        const stmt = this.db.prepare('SELECT * FROM group_key_history WHERE group_id = ? ORDER BY key_version ASC');
        return stmt.all(groupId) as GroupKeyHistory[];
    }

    deleteGroupKeyHistory(groupId: string): void {
        this.db.prepare('DELETE FROM group_key_history WHERE group_id = ?').run(groupId);
        this.db.prepare('DELETE FROM group_epoch_boundaries WHERE group_id = ?').run(groupId);
    }

    deleteGroupKeyHistoryForEpoch(groupId: string, keyVersion: number): void {
        this.db.prepare('DELETE FROM group_key_history WHERE group_id = ? AND key_version = ?')
            .run(groupId, keyVersion);
        this.db.prepare('DELETE FROM group_epoch_boundaries WHERE group_id = ? AND key_version = ?')
            .run(groupId, keyVersion);
    }

    updateGroupKeyStateHash(groupId: string, keyVersion: number, stateHash: string): void {
        this.db.prepare('UPDATE group_key_history SET state_hash = ? WHERE group_id = ? AND key_version = ?')
            .run(stateHash, groupId, keyVersion);
    }

    getGroupKeyStateHash(groupId: string, keyVersion: number): string | null {
        const row = this.db.prepare('SELECT state_hash FROM group_key_history WHERE group_id = ? AND key_version = ?')
            .get(groupId, keyVersion) as { state_hash: string | null } | undefined;
        return row?.state_hash ?? null;
    }

    markGroupKeyUsedUntil(groupId: string, keyVersion: number, usedUntil: number): void {
        this.db.prepare('UPDATE group_key_history SET used_until = ? WHERE group_id = ? AND key_version = ?')
            .run(usedUntil, groupId, keyVersion);
    }

    // --- Group offline cursors ---

    upsertGroupOfflineCursor(groupId: string, keyVersion: number, senderPeerId: string, timestamp: number, messageId: string): void {
        const stmt = this.db.prepare(`
            INSERT INTO group_offline_cursors (group_id, key_version, sender_peer_id, last_read_timestamp, last_read_message_id, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(group_id, key_version, sender_peer_id) DO UPDATE SET
                last_read_timestamp = excluded.last_read_timestamp,
                last_read_message_id = excluded.last_read_message_id,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(groupId, keyVersion, senderPeerId, timestamp, messageId);
    }

    getGroupOfflineCursor(groupId: string, keyVersion: number, senderPeerId: string): GroupOfflineCursor | null {
        const stmt = this.db.prepare('SELECT * FROM group_offline_cursors WHERE group_id = ? AND key_version = ? AND sender_peer_id = ?');
        const row = stmt.get(groupId, keyVersion, senderPeerId) as GroupOfflineCursor | undefined;
        return row ?? null;
    }

    getGroupOfflineCursors(groupId: string, keyVersion?: number): GroupOfflineCursor[] {
        if (keyVersion === undefined) {
            const stmt = this.db.prepare('SELECT * FROM group_offline_cursors WHERE group_id = ?');
            return stmt.all(groupId) as GroupOfflineCursor[];
        }
        const stmt = this.db.prepare('SELECT * FROM group_offline_cursors WHERE group_id = ? AND key_version = ?');
        return stmt.all(groupId, keyVersion) as GroupOfflineCursor[];
    }

    deleteGroupOfflineCursors(groupId: string): void {
        this.db.prepare('DELETE FROM group_offline_cursors WHERE group_id = ?').run(groupId);
    }

    deleteGroupOfflineCursorsForEpoch(groupId: string, keyVersion: number): void {
        this.db.prepare('DELETE FROM group_offline_cursors WHERE group_id = ? AND key_version = ?')
            .run(groupId, keyVersion);
    }

    // --- Group pending ACKs ---

    insertPendingAck(groupId: string, targetPeerId: string, messageType: AckMessageType, payload: string, mode?: NetworkMode): void {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare(`
            INSERT INTO group_pending_acks (group_id, target_peer_id, message_type, network_mode, message_payload, status)
            VALUES (?, ?, ?, ?, ?, 'active')
            ON CONFLICT(group_id, target_peer_id, message_type, network_mode) DO UPDATE SET
                message_payload = excluded.message_payload,
                status = 'active',
                last_published_at = CURRENT_TIMESTAMP
        `);
        stmt.run(groupId, targetPeerId, messageType, activeMode, payload);
    }

    removePendingAck(groupId: string, targetPeerId: string, messageType: AckMessageType, mode?: NetworkMode): void {
        const stmt = this.db.prepare('DELETE FROM group_pending_acks WHERE group_id = ? AND target_peer_id = ? AND message_type = ? AND network_mode = ?');
        stmt.run(groupId, targetPeerId, messageType, this.getActiveNetworkMode(mode));
    }

    removePendingAcksForMember(groupId: string, targetPeerId: string, mode?: NetworkMode): void {
        const stmt = this.db.prepare('DELETE FROM group_pending_acks WHERE group_id = ? AND target_peer_id = ? AND network_mode = ?');
        stmt.run(groupId, targetPeerId, this.getActiveNetworkMode(mode));
    }

    removePendingAcksForGroup(groupId: string, mode?: NetworkMode): void {
        this.db.prepare('DELETE FROM group_pending_acks WHERE group_id = ? AND network_mode = ?')
            .run(groupId, this.getActiveNetworkMode(mode));
    }

    getAllPendingAcks(mode?: NetworkMode): GroupPendingAck[] {
        const stmt = this.db.prepare(`SELECT * FROM group_pending_acks WHERE network_mode = ? AND status = 'active'`);
        return stmt.all(this.getActiveNetworkMode(mode)) as GroupPendingAck[];
    }

    getPendingAcksForGroup(groupId: string, mode?: NetworkMode): GroupPendingAck[] {
        const stmt = this.db.prepare(`SELECT * FROM group_pending_acks WHERE group_id = ? AND network_mode = ? AND status = 'active'`);
        return stmt.all(groupId, this.getActiveNetworkMode(mode)) as GroupPendingAck[];
    }

    getPendingAcksForTargets(targetPeerIds: string[], mode?: NetworkMode): GroupPendingAck[] {
        if (targetPeerIds.length === 0) return [];
        const placeholders = targetPeerIds.map(() => '?').join(',');
        const stmt = this.db.prepare(`
            SELECT *
            FROM group_pending_acks
            WHERE network_mode = ?
              AND status = 'active'
              AND target_peer_id IN (${placeholders})
        `);
        return stmt.all(this.getActiveNetworkMode(mode), ...targetPeerIds) as GroupPendingAck[];
    }

    updatePendingAckLastPublished(groupId: string, targetPeerId: string, messageType: AckMessageType, mode?: NetworkMode): void {
        const stmt = this.db.prepare('UPDATE group_pending_acks SET last_published_at = CURRENT_TIMESTAMP WHERE group_id = ? AND target_peer_id = ? AND message_type = ? AND network_mode = ?');
        stmt.run(groupId, targetPeerId, messageType, this.getActiveNetworkMode(mode));
    }

    retireStalePendingAcks(maxAgeMs: number, mode?: NetworkMode): number {
        const cutoffSeconds = Math.floor((Date.now() - Math.max(0, maxAgeMs)) / 1000);
        const stmt = this.db.prepare(`
            UPDATE group_pending_acks
            SET status = 'retired'
            WHERE network_mode = ?
              AND status = 'active'
              AND CAST(strftime('%s', created_at) AS INTEGER) <= ?
        `);
        const result = stmt.run(this.getActiveNetworkMode(mode), cutoffSeconds);
        return result.changes ?? 0;
    }

    reactivateRetiredPendingAcksForTarget(targetPeerId: string, mode?: NetworkMode, groupId?: string): number {
        const activeMode = this.getActiveNetworkMode(mode);
        if (groupId) {
            const stmt = this.db.prepare(`
                UPDATE group_pending_acks
                SET status = 'active',
                    created_at = CURRENT_TIMESTAMP
                WHERE network_mode = ?
                  AND group_id = ?
                  AND target_peer_id = ?
                  AND status = 'retired'
            `);
            const result = stmt.run(activeMode, groupId, targetPeerId);
            return result.changes ?? 0;
        }

        const stmt = this.db.prepare(`
            UPDATE group_pending_acks
            SET status = 'active',
                created_at = CURRENT_TIMESTAMP
            WHERE network_mode = ?
              AND target_peer_id = ?
              AND status = 'retired'
        `);
        const result = stmt.run(activeMode, targetPeerId);
        return result.changes ?? 0;
    }

    // --- Group info pending publishes ---

    upsertPendingGroupInfoPublish(
        groupId: string,
        keyVersion: number,
        versionedDhtKey: string,
        versionedPayload: string,
        latestDhtKey: string,
        latestPayload: string,
        nextRetryAt: number,
        lastError?: string | null,
        mode?: NetworkMode,
    ): void {
        const activeMode = this.getActiveNetworkMode(mode);
        const stmt = this.db.prepare(`
            INSERT INTO group_pending_info_publishes (
                group_id, key_version, network_mode, versioned_dht_key, versioned_payload, latest_dht_key, latest_payload, attempts, next_retry_at, last_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(group_id, key_version, network_mode) DO UPDATE SET
                versioned_dht_key = excluded.versioned_dht_key,
                versioned_payload = excluded.versioned_payload,
                latest_dht_key = excluded.latest_dht_key,
                latest_payload = excluded.latest_payload,
                next_retry_at = excluded.next_retry_at,
                last_error = excluded.last_error,
                updated_at = CURRENT_TIMESTAMP
        `);
        stmt.run(groupId, keyVersion, activeMode, versionedDhtKey, versionedPayload, latestDhtKey, latestPayload, nextRetryAt, lastError ?? null);
    }

    markPendingGroupInfoPublishAttempt(groupId: string, keyVersion: number, nextRetryAt: number, lastError: string, mode?: NetworkMode): void {
        const stmt = this.db.prepare(`
            UPDATE group_pending_info_publishes
            SET attempts = attempts + 1,
                next_retry_at = ?,
                last_error = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE group_id = ? AND key_version = ? AND network_mode = ?
        `);
        stmt.run(nextRetryAt, lastError, groupId, keyVersion, this.getActiveNetworkMode(mode));
    }

    removePendingGroupInfoPublish(groupId: string, keyVersion: number, mode?: NetworkMode): void {
        this.db.prepare('DELETE FROM group_pending_info_publishes WHERE group_id = ? AND key_version = ? AND network_mode = ?')
            .run(groupId, keyVersion, this.getActiveNetworkMode(mode));
    }

    getDuePendingGroupInfoPublishes(nowMs: number, limit = 50, mode?: NetworkMode): GroupPendingInfoPublish[] {
        const stmt = this.db.prepare(`
            SELECT * FROM group_pending_info_publishes
            WHERE next_retry_at <= ? AND network_mode = ?
            ORDER BY next_retry_at ASC
            LIMIT ?
        `);
        return stmt.all(nowMs, this.getActiveNetworkMode(mode), limit) as GroupPendingInfoPublish[];
    }

    markInviteDeliveryAckReceived(groupId: string, targetPeerId: string, inviteId: string, mode?: NetworkMode): void {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO group_invite_delivery_acks (group_id, target_peer_id, invite_id, network_mode)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(groupId, targetPeerId, inviteId, this.getActiveNetworkMode(mode));
    }

    isInviteDeliveryAckReceived(groupId: string, targetPeerId: string, inviteId: string, mode?: NetworkMode): boolean {
        const stmt = this.db.prepare(`
            SELECT 1
            FROM group_invite_delivery_acks
            WHERE group_id = ? AND target_peer_id = ? AND invite_id = ? AND network_mode = ?
        `);
        const row = stmt.get(groupId, targetPeerId, inviteId, this.getActiveNetworkMode(mode));
        return row !== undefined;
    }

    removeInviteDeliveryAcksForMember(groupId: string, targetPeerId: string, mode?: NetworkMode): void {
        const stmt = this.db.prepare(`
            DELETE FROM group_invite_delivery_acks
            WHERE group_id = ? AND target_peer_id = ? AND network_mode = ?
        `);
        stmt.run(groupId, targetPeerId, this.getActiveNetworkMode(mode));
    }

    // --- Group sender sequence ---

    getNextSeqAndIncrement(groupId: string, keyVersion: number): number {
        const upsert = this.db.prepare(`
            INSERT INTO group_sender_seq (group_id, key_version, next_seq) VALUES (?, ?, 2)
            ON CONFLICT(group_id, key_version) DO UPDATE SET next_seq = next_seq + 1
        `);
        const select = this.db.prepare('SELECT next_seq - 1 AS seq FROM group_sender_seq WHERE group_id = ? AND key_version = ?');

        const txn = this.db.transaction((gId: string, kv: number) => {
            upsert.run(gId, kv);
            const row = select.get(gId, kv) as { seq: number };
            return row.seq;
        });

        return txn(groupId, keyVersion);
    }

    getCurrentSeq(groupId: string, keyVersion: number): number {
        const row = this.db.prepare('SELECT next_seq FROM group_sender_seq WHERE group_id = ? AND key_version = ?')
            .get(groupId, keyVersion) as { next_seq: number } | undefined;
        return row ? row.next_seq - 1 : 0;
    }

    deleteGroupSenderSeqs(groupId: string): void {
        this.db.prepare('DELETE FROM group_sender_seq WHERE group_id = ?').run(groupId);
    }

    deleteGroupSenderSeqForEpoch(groupId: string, keyVersion: number): void {
        this.db.prepare('DELETE FROM group_sender_seq WHERE group_id = ? AND key_version = ?')
            .run(groupId, keyVersion);
    }

    // --- Group member seq (observed seqs from all members) ---

    updateMemberSeq(groupId: string, keyVersion: number, senderPeerId: string, seq: number): void {
        this.db.prepare(`
            INSERT INTO group_member_seq (group_id, key_version, sender_peer_id, highest_seq) VALUES (?, ?, ?, ?)
            ON CONFLICT(group_id, key_version, sender_peer_id) DO UPDATE SET
                highest_seq = MAX(highest_seq, excluded.highest_seq)
        `).run(groupId, keyVersion, senderPeerId, seq);
    }

    getMemberSeq(groupId: string, keyVersion: number, senderPeerId: string): number {
        const row = this.db.prepare('SELECT highest_seq FROM group_member_seq WHERE group_id = ? AND key_version = ? AND sender_peer_id = ?')
            .get(groupId, keyVersion, senderPeerId) as { highest_seq: number } | undefined;
        return row?.highest_seq ?? 0;
    }

    getAllMemberSeqs(groupId: string, keyVersion: number): Record<string, number> {
        const rows = this.db.prepare('SELECT sender_peer_id, highest_seq FROM group_member_seq WHERE group_id = ? AND key_version = ?')
            .all(groupId, keyVersion) as Array<{ sender_peer_id: string; highest_seq: number }>;
        const result: Record<string, number> = {};
        for (const row of rows) {
            result[row.sender_peer_id] = row.highest_seq;
        }
        return result;
    }

    deleteGroupMemberSeqs(groupId: string): void {
        this.db.prepare('DELETE FROM group_member_seq WHERE group_id = ?').run(groupId);
    }

    deleteGroupMemberSeqsForEpoch(groupId: string, keyVersion: number): void {
        this.db.prepare('DELETE FROM group_member_seq WHERE group_id = ? AND key_version = ?')
            .run(groupId, keyVersion);
    }

    // --- Group epoch boundaries (finalized per-sender seq cutoffs for old epochs) ---

    upsertGroupEpochBoundary(
        groupId: string,
        keyVersion: number,
        senderPeerId: string,
        boundarySeq: number,
        source = 'local_rotation',
    ): void {
        this.db.prepare(`
            INSERT INTO group_epoch_boundaries (group_id, key_version, sender_peer_id, boundary_seq, source, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(group_id, key_version, sender_peer_id) DO UPDATE SET
                boundary_seq = MAX(boundary_seq, excluded.boundary_seq),
                source = excluded.source,
                updated_at = CURRENT_TIMESTAMP
        `).run(groupId, keyVersion, senderPeerId, boundarySeq, source);
    }

    upsertGroupEpochBoundaries(
        groupId: string,
        keyVersion: number,
        boundaries: Record<string, number>,
        source = 'local_rotation',
    ): void {
        const entries = Object.entries(boundaries);
        if (entries.length === 0) return;

        const stmt = this.db.prepare(`
            INSERT INTO group_epoch_boundaries (group_id, key_version, sender_peer_id, boundary_seq, source, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(group_id, key_version, sender_peer_id) DO UPDATE SET
                boundary_seq = MAX(boundary_seq, excluded.boundary_seq),
                source = excluded.source,
                updated_at = CURRENT_TIMESTAMP
        `);

        const txn = this.db.transaction((rows: Array<[string, number]>) => {
            for (const [senderPeerId, boundarySeq] of rows) {
                if (!senderPeerId) continue;
                const normalized = Number.isFinite(boundarySeq) ? Math.max(0, Math.floor(boundarySeq)) : 0;
                stmt.run(groupId, keyVersion, senderPeerId, normalized, source);
            }
        });
        txn(entries);
    }

    getGroupEpochBoundaries(groupId: string, keyVersion: number): Record<string, number> {
        const rows = this.db.prepare(`
            SELECT sender_peer_id, boundary_seq
            FROM group_epoch_boundaries
            WHERE group_id = ? AND key_version = ?
        `).all(groupId, keyVersion) as Array<{ sender_peer_id: string; boundary_seq: number }>;

        const result: Record<string, number> = {};
        for (const row of rows) {
            result[row.sender_peer_id] = row.boundary_seq;
        }
        return result;
    }

    getAllGroupEpochBoundaries(groupId: string, keyVersion: number): GroupEpochBoundary[] {
        const stmt = this.db.prepare(`
            SELECT *
            FROM group_epoch_boundaries
            WHERE group_id = ? AND key_version = ?
            ORDER BY sender_peer_id ASC
        `);
        return stmt.all(groupId, keyVersion) as GroupEpochBoundary[];
    }

    deleteGroupEpochBoundaries(groupId: string): void {
        this.db.prepare('DELETE FROM group_epoch_boundaries WHERE group_id = ?').run(groupId);
    }

    deleteGroupEpochBoundariesForEpoch(groupId: string, keyVersion: number): void {
        this.db.prepare('DELETE FROM group_epoch_boundaries WHERE group_id = ? AND key_version = ?')
            .run(groupId, keyVersion);
    }

    // --- Group chat column helpers ---

    updateChatStatus(chatId: number, status: string): void {
        this.db.prepare("UPDATE chats SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .run(status, chatId);
    }

    updateChatGroupStatus(chatId: number, groupStatus: string): void {
        if (groupStatus === 'removed') {
            this.db.prepare(`
                UPDATE chats
                SET group_status = ?,
                    needs_removed_catchup = 1,
                    removed_at = ?,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?
            `).run(groupStatus, Date.now(), chatId);
            return;
        }

        this.db.prepare(`
            UPDATE chats
            SET group_status = ?,
                needs_removed_catchup = 0,
                removed_at = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `).run(groupStatus, chatId);
    }

    setLastKnownActiveCall(chatId: number, callId: string, seenAt: number): void {
        this.db.prepare(`
            UPDATE chats
            SET last_known_active_call_id = ?,
                last_known_active_call_seen_at = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `).run(callId, seenAt, chatId);
    }

    clearLastKnownActiveCall(chatId: number): void {
        this.db.prepare(`
            UPDATE chats
            SET last_known_active_call_id = NULL,
                last_known_active_call_seen_at = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `).run(chatId);
    }

    transitionChatGroupStatus(chatId: number, nextStatus: GroupStatus, reason: string): void {
        const row = this.db.prepare('SELECT group_status FROM chats WHERE id = ?')
            .get(chatId) as { group_status: string | null } | undefined;
        if (!row) {
            throw new Error(`Chat ${chatId} not found`);
        }

        const current = row.group_status;
        if (current === nextStatus) {
            return;
        }

        if (current !== null) {
            if (!isGroupStatus(current)) {
                throw new Error(
                    `Unknown group status in DB for chat ${chatId}: ${current} (reason=${reason})`,
                );
            }
            assertGroupTransition(current, nextStatus, reason);
        }

        this.updateChatGroupStatus(chatId, nextStatus);
        log(
            `[GROUP][STATE][TRANSITION] chatId=${chatId} from=${current ?? 'null'} to=${nextStatus} reason=${reason}`,
        );
    }

    markRemovedCatchupCompleted(chatId: number): void {
        this.db.prepare(`
            UPDATE chats
            SET needs_removed_catchup = 0
            WHERE id = ? AND group_status = 'removed'
        `).run(chatId);
    }

    recoverRekeyingGroupsOnStartup(): number {
        const result = this.db.prepare(`
            UPDATE chats
            SET group_status = 'active',
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE type = 'group'
              AND status = 'active'
              AND group_status = 'rekeying'
              AND network_mode = ?
              AND (key_version > 0 OR permanent_key IS NOT NULL)
        `).run(this.getActiveNetworkMode());

        return Number(result.changes ?? 0);
    }

    updateChatKeyVersion(chatId: number, keyVersion: number): void {
        this.db.prepare("UPDATE chats SET key_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .run(keyVersion, chatId);
    }

    updateChatGroupInfoDhtKey(chatId: number, dhtKey: string): void {
        this.db.prepare("UPDATE chats SET group_info_dht_key = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?")
            .run(dhtKey, chatId);
    }

    restoreGroupChatFromInvite(chatId: number, inviterPeerId: string, groupName: string): void {
        this.db.prepare(`
            UPDATE chats
            SET name = ?,
                created_by = ?,
                status = 'pending',
                group_status = 'invited_pending',
                needs_removed_catchup = 0,
                removed_at = NULL,
                group_creator_peer_id = ?,
                permanent_key = NULL,
                group_key = NULL,
                group_info_dht_key = NULL,
                key_version = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `).run(groupName, inviterPeerId, inviterPeerId, chatId);
    }

    clearGroupChatRuntimeState(chatId: number): void {
        this.db.prepare(`
            UPDATE chats
            SET permanent_key = NULL,
                group_key = NULL,
                group_info_dht_key = NULL,
                key_version = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `).run(chatId);
    }

    resetGroupRuntimeForReinvite(chatId: number, groupId: string): void {
        const modeRow = this.db.prepare('SELECT network_mode FROM chats WHERE id = ?').get(chatId) as { network_mode?: unknown } | undefined;
        const mode = isNetworkMode(modeRow?.network_mode) ? modeRow.network_mode : this.getActiveNetworkMode();
        const groupOfflineBucketPrefix = getNetworkModeRuntime(mode).config.dhtNamespaces.groupOffline;
        const clearChatRuntimeStmt = this.db.prepare(`
            UPDATE chats
            SET permanent_key = NULL,
                group_key = NULL,
                group_info_dht_key = NULL,
                key_version = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?
        `);
        const deleteKeyHistoryStmt = this.db.prepare('DELETE FROM group_key_history WHERE group_id = ?');
        const deleteOfflineCursorsStmt = this.db.prepare('DELETE FROM group_offline_cursors WHERE group_id = ?');
        const deleteSenderSeqStmt = this.db.prepare('DELETE FROM group_sender_seq WHERE group_id = ?');
        const deleteMemberSeqStmt = this.db.prepare('DELETE FROM group_member_seq WHERE group_id = ?');
        const deleteEpochBoundariesStmt = this.db.prepare('DELETE FROM group_epoch_boundaries WHERE group_id = ?');
        const deleteOfflineSentStmt = this.db.prepare('DELETE FROM group_offline_sent_messages WHERE bucket_key LIKE ?');

        const txn = this.db.transaction((cId: number, gId: string) => {
            clearChatRuntimeStmt.run(cId);
            deleteKeyHistoryStmt.run(gId);
            deleteOfflineCursorsStmt.run(gId);
            deleteSenderSeqStmt.run(gId);
            deleteMemberSeqStmt.run(gId);
            deleteEpochBoundariesStmt.run(gId);
            deleteOfflineSentStmt.run(`${groupOfflineBucketPrefix}/${gId}/%`);
        });

        txn(chatId, groupId);
    }

    updateGroupParticipants(chatId: number, peerIds: string[]): void {
        this.db.prepare('DELETE FROM chat_participants WHERE chat_id = ?').run(chatId);
        const insert = this.db.prepare(
            'INSERT INTO chat_participants (chat_id, peer_id, role, joined_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
        );
        for (const peerId of peerIds) {
            insert.run(chatId, peerId, 'member');
        }
    }

    close(): void {
        try {
            log('[DATABASE] Shutting down database...');

            // Checkpoint WAL to ensure all data is persisted
            // TRUNCATE mode: checkpoint and truncate WAL file
            this.db.pragma('wal_checkpoint(TRUNCATE)');
            log('[DATABASE] WAL checkpoint completed');

            this.db.close();
            log('[DATABASE] Database connection closed successfully');
        } catch (error) {
            console.error('[DATABASE] Error during shutdown:', error);
            throw error;
        }
    }

    /**
     * Wipes all data from the database
     */
    async wipeDatabase(): Promise<void> {
        try {
            console.warn('[DATABASE] WARNING: Wiping all database data...');

            this.db.pragma('foreign_keys = OFF');

            const tables = this.db.prepare(`
                SELECT name FROM sqlite_master
                WHERE type='table'
                  AND name NOT LIKE 'sqlite_%'
                  AND name != 'messages_fts'
                  AND name NOT LIKE 'messages_fts_%'
            `).all() as Array<{ name: string }>;

            this.db.exec('BEGIN TRANSACTION');

            for (const table of tables) {
                log(`[DATABASE] Deleting data from table: ${table.name}`);
                this.db.prepare(`DELETE FROM ${table.name}`).run();
            }

            // FTS5 shadow tables are maintained by SQLite and cannot be deleted
            // directly. Rebuild the external-content index from the emptied
            // messages table to guarantee search state is wiped as well.
            this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);

            this.db.exec('COMMIT');

            this.db.pragma('foreign_keys = ON');

            this.db.exec('VACUUM');

            log('[DATABASE] All data wiped successfully');
        } catch (error) {
            this.db.exec('ROLLBACK');
            // Re-enable foreign keys even on error
            this.db.pragma('foreign_keys = ON');
            console.error('[DATABASE] Error wiping database:', error);
            throw error;
        }
    }

    async backupEncrypted(backupPath: string, password: string): Promise<void> {
        ChatDatabase.assertStrongBackupPassword(password);

        this.db.pragma('wal_checkpoint(TRUNCATE)');
        const plaintext = this.db.serialize();
        const salt = randomBytes(32);
        const nonce = randomBytes(12);
        const key = ChatDatabase.deriveBackupKey(password, salt);
        const header = ChatDatabase.createBackupHeader(salt, nonce);
        const cipher = gcm(key, nonce, ChatDatabase.backupHeaderAad(header));
        const ciphertext = cipher.encrypt(plaintext);
        const artifact = ChatDatabase.serializeBackupArtifact(header, ciphertext);

        await writeFile(backupPath, artifact, { mode: 0o600 });
        await chmod(backupPath, 0o600);
    }

    async restoreEncrypted(backupPath: string, password: string): Promise<void> {
        const tempPath = await ChatDatabase.decryptBackupToValidatedTempFile(this.dbPath, backupPath, password);

        try {
            this.close();
            await ChatDatabase.replaceDatabaseWithValidatedTemp(this.dbPath, tempPath);
            this.openRestoredDatabase();
            log('Database restored from encrypted backup');
        } catch (error) {
            if (!this.db.open) {
                try {
                    this.openRestoredDatabase();
                } catch (reopenError) {
                    console.error('[DATABASE] Failed to reopen database after restore failure:', reopenError);
                }
            }
            throw error;
        } finally {
            await ChatDatabase.removeIfExists(tempPath);
        }
    }

    static async restoreEncryptedAtPath(dbPath: string, backupPath: string, password: string): Promise<void> {
        const tempPath = await ChatDatabase.decryptBackupToValidatedTempFile(dbPath, backupPath, password);

        try {
            await ChatDatabase.replaceDatabaseWithValidatedTemp(dbPath, tempPath);
            log('Database restored from encrypted backup');
        } finally {
            await ChatDatabase.removeIfExists(tempPath);
        }
    }

    private openRestoredDatabase(): void {
        const restoredDb = new Database(this.dbPath);
        try {
            restoredDb.pragma('journal_mode = WAL');
            restoredDb.pragma('synchronous = NORMAL');
            restoredDb.pragma('cache_size = 10000');
            restoredDb.pragma('temp_store = memory');
            restoredDb.pragma('mmap_size = 268435456'); // 256MB
            restoredDb.pragma('busy_timeout = 30000'); // 30 second timeout
            restoredDb.pragma('foreign_keys = ON');
            this.db = restoredDb;
            this.checkIntegrity();
        } catch (error) {
            try {
                restoredDb.close();
            } catch {
                // Ignore close errors while surfacing the original open failure.
            }
            throw error;
        }
    }

    private static assertBackupPassword(password: string): void {
        if (typeof password !== 'string' || password.trim().length === 0) {
            throw new Error('Backup password is required');
        }
    }

    // Enforced only when CREATING a backup (the artifact leaves the machine, so a weak
    // password undermines its confidentiality). Restore intentionally does not gate on
    // policy — the GCM tag is the real check — so a strong old backup always restores.
    private static assertStrongBackupPassword(password: string): void {
        ChatDatabase.assertBackupPassword(password);
        if (password.length < DATABASE_BACKUP_MIN_PASSWORD_LENGTH) {
            throw new Error(`Backup password must be at least ${DATABASE_BACKUP_MIN_PASSWORD_LENGTH} characters`);
        }
        const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
        if (classes < 4) {
            throw new Error('Backup password must include lowercase, uppercase, numbers, and a special character');
        }
    }

    private static createBackupHeader(salt: Uint8Array, nonce: Uint8Array): DatabaseBackupHeader {
        return {
            magic: DATABASE_BACKUP_MAGIC,
            version: DATABASE_BACKUP_VERSION,
            kdf: 'scrypt',
            scrypt: DATABASE_BACKUP_SCRYPT_PARAMS,
            cipher: 'AES-256-GCM',
            salt: Buffer.from(salt).toString('base64'),
            nonce: Buffer.from(nonce).toString('base64'),
            encoding: 'base64',
        };
    }

    private static deriveBackupKey(password: string, salt: Uint8Array): Uint8Array {
        return scrypt(
            new TextEncoder().encode(password),
            salt,
            DATABASE_BACKUP_SCRYPT_PARAMS,
        );
    }

    private static backupHeaderAad(header: DatabaseBackupHeader): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(ChatDatabase.canonicalBackupHeader(header)));
    }

    private static canonicalBackupHeader(header: DatabaseBackupHeader): DatabaseBackupHeader {
        return {
            magic: header.magic,
            version: header.version,
            kdf: header.kdf,
            scrypt: {
                N: header.scrypt.N,
                r: header.scrypt.r,
                p: header.scrypt.p,
                dkLen: header.scrypt.dkLen,
            },
            cipher: header.cipher,
            salt: header.salt,
            nonce: header.nonce,
            encoding: header.encoding,
        };
    }

    private static serializeBackupArtifact(header: DatabaseBackupHeader, ciphertext: Uint8Array): Buffer {
        return Buffer.concat([
            Buffer.from(JSON.stringify(ChatDatabase.canonicalBackupHeader(header)), 'utf8'),
            Buffer.from('\n', 'utf8'),
            Buffer.from(Buffer.from(ciphertext).toString('base64'), 'utf8'),
        ]);
    }

    private static async decryptBackupToValidatedTempFile(
        dbPath: string,
        backupPath: string,
        password: string,
    ): Promise<string> {
        ChatDatabase.assertBackupPassword(password);

        const plaintext = await ChatDatabase.decryptBackupFile(backupPath, password);
        const dbDir = path.dirname(dbPath);
        fs.mkdirSync(dbDir, { recursive: true });
        const tempPath = path.join(
            dbDir,
            `${path.basename(dbPath)}.restore-${process.pid}-${Date.now()}-${ChatDatabase.randomHex(8)}.tmp`,
        );

        try {
            await writeFile(tempPath, plaintext, { flag: 'wx', mode: 0o600 });
            ChatDatabase.validateDatabaseFile(tempPath);
            return tempPath;
        } catch (error) {
            await ChatDatabase.removeIfExists(tempPath);
            throw error;
        }
    }

    private static async decryptBackupFile(backupPath: string, password: string): Promise<Buffer> {
        const artifact = await readFile(backupPath);
        const { header, salt, nonce, ciphertext } = ChatDatabase.parseBackupArtifact(artifact);
        const key = ChatDatabase.deriveBackupKey(password, salt);

        try {
            const cipher = gcm(key, nonce, ChatDatabase.backupHeaderAad(header));
            return Buffer.from(cipher.decrypt(ciphertext));
        } catch {
            throw new Error('Failed to decrypt database backup - incorrect password or corrupted file');
        }
    }

    private static parseBackupArtifact(artifact: Buffer): {
        header: DatabaseBackupHeader;
        salt: Buffer;
        nonce: Buffer;
        ciphertext: Buffer;
    } {
        const headerEnd = artifact.indexOf(0x0A);
        if (headerEnd <= 0 || headerEnd > DATABASE_BACKUP_HEADER_MAX_BYTES) {
            throw new Error('Invalid database backup format');
        }

        let parsedHeader: unknown;
        try {
            parsedHeader = JSON.parse(artifact.subarray(0, headerEnd).toString('utf8'));
        } catch {
            throw new Error('Invalid database backup header');
        }

        const header = ChatDatabase.validateBackupHeader(parsedHeader);
        const body = artifact.subarray(headerEnd + 1).toString('utf8').trim();
        const salt = ChatDatabase.decodeBase64(header.salt, 'backup salt', 32);
        const nonce = ChatDatabase.decodeBase64(header.nonce, 'backup nonce', 12);
        const ciphertext = ChatDatabase.decodeBase64(body, 'backup ciphertext');

        if (ciphertext.length <= 16) {
            throw new Error('Invalid database backup ciphertext');
        }

        return { header, salt, nonce, ciphertext };
    }

    private static validateBackupHeader(value: unknown): DatabaseBackupHeader {
        if (value === null || typeof value !== 'object') {
            throw new Error('Invalid database backup header');
        }

        const header = value as Partial<DatabaseBackupHeader>;
        const scryptParams = header.scrypt as Partial<DatabaseBackupScryptParams> | undefined;
        if (
            !scryptParams
            || header.magic !== DATABASE_BACKUP_MAGIC
            || header.version !== DATABASE_BACKUP_VERSION
            || header.kdf !== 'scrypt'
            || header.cipher !== 'AES-256-GCM'
            || header.encoding !== 'base64'
            || typeof header.salt !== 'string'
            || typeof header.nonce !== 'string'
            || scryptParams.N !== DATABASE_BACKUP_SCRYPT_PARAMS.N
            || scryptParams.r !== DATABASE_BACKUP_SCRYPT_PARAMS.r
            || scryptParams.p !== DATABASE_BACKUP_SCRYPT_PARAMS.p
            || scryptParams.dkLen !== DATABASE_BACKUP_SCRYPT_PARAMS.dkLen
        ) {
            throw new Error('Unsupported database backup format');
        }

        return ChatDatabase.canonicalBackupHeader({
            magic: header.magic,
            version: header.version,
            kdf: header.kdf,
            scrypt: {
                N: scryptParams.N,
                r: scryptParams.r,
                p: scryptParams.p,
                dkLen: scryptParams.dkLen,
            },
            cipher: header.cipher,
            salt: header.salt,
            nonce: header.nonce,
            encoding: header.encoding,
        });
    }

    private static decodeBase64(value: string, fieldName: string, expectedLength?: number): Buffer {
        if (value.length === 0 || !BASE64_PATTERN.test(value)) {
            throw new Error(`Invalid ${fieldName}`);
        }

        const bytes = Buffer.from(value, 'base64');
        if (expectedLength !== undefined && bytes.length !== expectedLength) {
            throw new Error(`Invalid ${fieldName}`);
        }

        return bytes;
    }

    private static validateDatabaseFile(filePath: string): void {
        let validationDb: Database.Database | null = null;
        try {
            validationDb = new Database(filePath, { readonly: true, fileMustExist: true });
            validationDb.pragma('schema_version');

            const integrityResult = validationDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
            const integrityOk = integrityResult.length === 1 && integrityResult[0]?.integrity_check === 'ok';
            if (!integrityOk) {
                throw new Error('Invalid SQLite database integrity check');
            }

            const placeholders = DATABASE_BACKUP_REQUIRED_TABLES.map(() => '?').join(', ');
            const rows = validationDb.prepare(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
            ).all(...DATABASE_BACKUP_REQUIRED_TABLES) as Array<{ name: string }>;
            const foundTables = new Set(rows.map((row) => row.name));
            const missingTables = DATABASE_BACKUP_REQUIRED_TABLES.filter((table) => !foundTables.has(table));
            if (missingTables.length > 0) {
                throw new Error(`Invalid Kiyeovo database backup: missing ${missingTables.join(', ')}`);
            }
        } catch (error) {
            throw new Error(`Invalid SQLite database backup: ${errStr(error)}`);
        } finally {
            if (validationDb) {
                validationDb.close();
            }
        }
    }

    private static async replaceDatabaseWithValidatedTemp(dbPath: string, tempPath: string): Promise<void> {
        const swapId = `restore-${process.pid}-${Date.now()}-${ChatDatabase.randomHex(8)}`;
        const backupFiles: DatabaseSwapBackupFile[] = [];

        try {
            for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
                const livePath = `${dbPath}${suffix}`;
                const backupPath = `${livePath}.${swapId}.bak`;
                if (await ChatDatabase.renameIfExists(livePath, backupPath)) {
                    backupFiles.push({ livePath, backupPath });
                }
            }

            await rename(tempPath, dbPath);
            await ChatDatabase.removeIfExists(`${dbPath}-wal`);
            await ChatDatabase.removeIfExists(`${dbPath}-shm`);
            ChatDatabase.validateDatabaseFile(dbPath);
            await ChatDatabase.deleteSwapBackups(backupFiles);
        } catch (error) {
            await ChatDatabase.rollbackDatabaseSwap(dbPath, backupFiles);
            throw error;
        }
    }

    private static async rollbackDatabaseSwap(dbPath: string, backupFiles: DatabaseSwapBackupFile[]): Promise<void> {
        for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
            await ChatDatabase.removeIfExists(`${dbPath}${suffix}`);
        }

        for (const backupFile of backupFiles) {
            await rename(backupFile.backupPath, backupFile.livePath);
        }
    }

    private static async deleteSwapBackups(backupFiles: DatabaseSwapBackupFile[]): Promise<void> {
        for (const backupFile of backupFiles) {
            try {
                await ChatDatabase.removeIfExists(backupFile.backupPath);
            } catch (error) {
                console.warn('[DATABASE] Failed to remove restore rollback file:', backupFile.backupPath, error);
            }
        }
    }

    private static async renameIfExists(from: string, to: string): Promise<boolean> {
        try {
            await rename(from, to);
            return true;
        } catch (error) {
            if (ChatDatabase.isNotFoundError(error)) {
                return false;
            }
            throw error;
        }
    }

    private static async removeIfExists(filePath: string): Promise<void> {
        await rm(filePath, { force: true });
    }

    private static isNotFoundError(error: unknown): boolean {
        return typeof error === 'object'
            && error !== null
            && 'code' in error
            && (error as { code?: unknown }).code === 'ENOENT';
    }

    private static randomHex(byteLength: number): string {
        return Buffer.from(randomBytes(byteLength)).toString('hex');
    }
}
