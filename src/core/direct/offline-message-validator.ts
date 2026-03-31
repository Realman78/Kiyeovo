import { sha256 } from '@noble/hashes/sha2';
import { ed25519 } from '@noble/curves/ed25519';
import { gunzipSync, gunzip } from 'zlib';
import { promisify } from 'util';
import { fromBase64Url } from '../utils/miscellaneous.js';
import { generalErrorHandler } from '../utils/general-error.js';
import {
  MAX_MESSAGES_PER_STORE,
  MESSAGE_TTL,
  NETWORK_MODE_CONFIG,
  OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS,
} from '../constants.js';

const gunzipAsync = promisify(gunzip);
const OFFLINE_BUCKET_PREFIXES = Object.values(NETWORK_MODE_CONFIG).map((config) => config.dhtNamespaces.offline);

/**
 * The signed payload structure included in each offline message
 */
export interface OfflineSignedPayload {
  content_hash: string;       // SHA256 of encrypted content (base64)
  sender_info_hash: string;   // SHA256 of encrypted sender info (base64)
  timestamp: number;
  bucket_key: string;         // Full bucket key for binding
}

/**
 * Offline message structure as stored in DHT
 */
export interface OfflineMessageDHT {
  id: string;
  encrypted_sender_info: string;
  content: string;
  signature: string;
  signed_payload: OfflineSignedPayload;
  message_type: 'encrypted' | 'hybrid';
  encrypted_aes_key?: string;
  aes_iv?: string;
  timestamp: number;
  expires_at: number;
}

/**
 * Store signed payload - the bucket owner signs the entire store state
 */
export interface StoreSignedPayloadDHT {
  message_ids: string[];      // List of message IDs in order (for integrity)
  version: number;
  timestamp: number;
  bucket_key: string;         // Full bucket key for binding
}

/**
 * Offline message store structure in DHT
 */
export interface OfflineMessageStoreDHT {
  messages: OfflineMessageDHT[];
  last_updated: number;
  version: number;
  store_signature: string;              // Ed25519 signature over store_signed_payload
  store_signed_payload: StoreSignedPayloadDHT;  // The payload that was signed
}

/**
 * DHT Validator for offline message buckets
 *
 * Key format: kiyeovo-offline/<shared_secret>/<sender_pubkey_base64url>
 *
 * Validation logic:
 * 1. Extract sender public key from bucket key suffix
 * 2. Verify store signature (prevents unauthorized deletion/modification)
 * 3. Verify message_ids in store_signed_payload match actual messages
 * 4. For each message in the store:
 *    - Verify signature using extracted public key
 *    - Verify content_hash matches SHA256(encrypted_content)
 *    - Verify sender_info_hash matches SHA256(encrypted_sender_info)
 *    - Verify bucket_key in signed_payload matches the actual bucket key
 *
 * @throws Error if validation fails (DHT rejects the write)
 */
export async function offlineMessageValidator(
  key: Uint8Array,
  value: Uint8Array
): Promise<void> {
  try {
    const keyStr = new TextDecoder().decode(key);
    const senderPubKeyBase64url = parseOfflineBucketSenderPubKeyBase64Url(keyStr);

    // Decode sender public key from bucket key
    const senderPubKey = fromBase64Url(senderPubKeyBase64url);
    if (senderPubKey.length !== 32) {
      throw new Error(`Invalid sender public key length: ${senderPubKey.length}, expected 32`);
    }

    // 3. Decompress and parse value (OfflineMessageStore)
    let store: OfflineMessageStoreDHT;
    try {
      const decompressedBuffer = await gunzipAsync(Buffer.from(value));
      store = JSON.parse(decompressedBuffer.toString('utf8'));
    } catch (error) {
      throw new Error('Failed to decompress or parse DHT value');
    }

    if (!Array.isArray(store.messages)) {
      throw new Error('Invalid store format: messages is not an array');
    }

    if (store.messages.length > MAX_MESSAGES_PER_STORE) {
      throw new Error(`Max messages reached for offline message store: ${store.messages.length}`);
    }

    // 4. Validate store signature (prevents unauthorized deletion/modification)
    validateStoreSignature(store, senderPubKey, keyStr);

    // 5. Validate each message in the store
    for (const msg of store.messages) {
      validateSingleMessage(msg, senderPubKey, keyStr);
    }

  } catch (error: unknown) {
    generalErrorHandler(error, 'DHT offline message validation failed');
    throw error; // Re-throw to reject the DHT write
  }
}

function parseOfflineBucketSenderPubKeyBase64Url(keyStr: string): string {
  const matchedPrefix = OFFLINE_BUCKET_PREFIXES.find((prefix) => keyStr.startsWith(`${prefix}/`));
  if (!matchedPrefix) {
    throw new Error(`Invalid offline bucket key prefix: ${keyStr.slice(0, 20)}...`);
  }

  const parts = keyStr.split('/');
  if (parts.length !== 4) {
    throw new Error(`Invalid bucket key format: expected 4 parts, got ${parts.length}`);
  }

  const senderPubKeyBase64url = parts[3];
  if (!senderPubKeyBase64url) {
    throw new Error('Missing sender public key in bucket key');
  }

  return senderPubKeyBase64url;
}

/**
 * Validate the store-level signature
 * This prevents unauthorized deletion/modification of the entire store
 */
function validateStoreSignature(
  store: OfflineMessageStoreDHT,
  senderPubKey: Uint8Array,
  expectedBucketKey: string
): void {
  // Check required fields
  if (!store.store_signature || !store.store_signed_payload) {
    throw new Error('Store missing store_signature or store_signed_payload');
  }

  // Verify bucket_key in store_signed_payload matches actual bucket key
  if (store.store_signed_payload.bucket_key !== expectedBucketKey) {
    throw new Error('Store bucket_key mismatch: signed for different bucket');
  }

  // Verify message_ids match actual messages
  const actualMessageIds = store.messages.map(m => m.id);
  const signedMessageIds = store.store_signed_payload.message_ids;

  if (actualMessageIds.length !== signedMessageIds.length) {
    throw new Error(`Store message_ids count mismatch: ${actualMessageIds.length} vs ${signedMessageIds.length}`);
  }

  for (let i = 0; i < actualMessageIds.length; i++) {
    if (actualMessageIds[i] !== signedMessageIds[i]) {
      throw new Error(`Store message_ids mismatch at index ${i}`);
    }
  }

  // Verify version matches
  if (store.version !== store.store_signed_payload.version) {
    throw new Error(`Store version mismatch: ${store.version} vs ${store.store_signed_payload.version}`);
  }

  if (!Number.isFinite(store.last_updated) || store.last_updated <= 0) {
    throw new Error('Store last_updated invalid');
  }
  if (!Number.isFinite(store.store_signed_payload.timestamp) || store.store_signed_payload.timestamp <= 0) {
    throw new Error('Store signed timestamp invalid');
  }
  if (store.last_updated !== store.store_signed_payload.timestamp) {
    throw new Error('Store timestamp mismatch between payload and metadata');
  }
  if (store.last_updated > Date.now() + OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS) {
    throw new Error('Store timestamp too far in future');
  }

  // Verify store signature
  const payloadBytes = new TextEncoder().encode(JSON.stringify(store.store_signed_payload));
  const signatureBytes = Buffer.from(store.store_signature, 'base64');

  const isValid = ed25519.verify(signatureBytes, payloadBytes, senderPubKey);
  if (!isValid) {
    throw new Error('Store signature verification failed');
  }
}

/**
 * Validate a single offline message
 */
function validateSingleMessage(
  msg: OfflineMessageDHT,
  senderPubKey: Uint8Array,
  expectedBucketKey: string
): void {
  // Check required fields
  if (!msg.signature || !msg.signed_payload) {
    throw new Error(`Message ${msg.id} missing signature or signed_payload`);
  }

  if (!msg.signed_payload.content_hash || !msg.signed_payload.sender_info_hash) {
    throw new Error(`Message ${msg.id} missing content_hash or sender_info_hash`);
  }

  // 1. Verify bucket_key in signed_payload matches actual bucket key
  if (msg.signed_payload.bucket_key !== expectedBucketKey) {
    throw new Error(`Message ${msg.id} bucket_key mismatch: signed for different bucket`);
  }

  if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) {
    throw new Error(`Message ${msg.id} timestamp invalid`);
  }
  if (!Number.isFinite(msg.signed_payload.timestamp) || msg.signed_payload.timestamp <= 0) {
    throw new Error(`Message ${msg.id} signed timestamp invalid`);
  }

  // Timestamp used by receivers must be exactly what was signed.
  if (msg.timestamp !== msg.signed_payload.timestamp) {
    throw new Error(`Message ${msg.id} timestamp mismatch with signed payload`);
  }

  // 2. Verify content_hash matches SHA256(encrypted_content)
  const contentBytes = Buffer.from(msg.content, 'base64');
  const actualContentHash = Buffer.from(sha256(contentBytes)).toString('base64');
  if (actualContentHash !== msg.signed_payload.content_hash) {
    throw new Error(`Message ${msg.id} content_hash mismatch`);
  }

  // 3. Verify sender_info_hash matches SHA256(encrypted_sender_info)
  const senderInfoBytes = Buffer.from(msg.encrypted_sender_info, 'base64');
  const actualSenderInfoHash = Buffer.from(sha256(senderInfoBytes)).toString('base64');
  if (actualSenderInfoHash !== msg.signed_payload.sender_info_hash) {
    throw new Error(`Message ${msg.id} sender_info_hash mismatch`);
  }

  // 4. Verify signature over the signed_payload
  const payloadBytes = new TextEncoder().encode(JSON.stringify(msg.signed_payload));
  const signatureBytes = Buffer.from(msg.signature, 'base64');

  const isValid = ed25519.verify(signatureBytes, payloadBytes, senderPubKey);
  if (!isValid) {
    throw new Error(`Message ${msg.id} signature verification failed`);
  }

  // 5. Check timestamp freshness (optional but good practice)
  const now = Date.now();
  if (msg.timestamp > now + OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS) {
    throw new Error(`Message ${msg.id} timestamp invalid: too far in future`);
  }
  const messageAge = now - msg.timestamp;

  if (messageAge > MESSAGE_TTL) {
    throw new Error(`Message ${msg.id} timestamp invalid: too old`);
  }

  // 6. Check expiration
  if (msg.expires_at < now) {
    throw new Error(`Message ${msg.id} has expired`);
  }
}

/**
 * DHT validateUpdate for offline message buckets
 *
 * Called by the forked kad-dht PUT_VALUE handler when a record already exists
 * for the same key. Rejects the incoming record if its version is lower than
 * the existing one, preventing stale record overwrites.
 *
 * @throws Error with message 'stale record rejected' if incoming version < existing version
 */
export async function offlineMessageValidateUpdate(
  _key: Uint8Array,
  existing: Uint8Array,
  incoming: Uint8Array
): Promise<void> {
  const existingStore = decompressStore(existing);
  const incomingStore = decompressStore(incoming);

  if (incomingStore.version < existingStore.version) {
    throw new Error('stale record rejected');
  }

  if (
    incomingStore.version === existingStore.version &&
    incomingStore.last_updated < existingStore.last_updated
  ) {
    throw new Error('stale record rejected');
  }
}

/**
 * Decompress and parse a gzipped OfflineMessageStoreDHT record
 */
function decompressStore(value: Uint8Array): OfflineMessageStoreDHT {
  const decompressedBuffer = gunzipSync(Buffer.from(value));
  return JSON.parse(decompressedBuffer.toString('utf8'));
}

/**
 * DHT Selector for offline message buckets
 *
 * When multiple records are found for the same key, select the one with:
 * 1. Highest version number
 * 2. Most recent last_updated timestamp (tiebreaker)
 *
 * @returns Index of the best record
 */
export function offlineMessageSelector(
  _key: Uint8Array,
  records: Uint8Array[]
): number {
  if (records.length === 0) {
    return 0;
  }

  if (records.length === 1) {
    return 0;
  }

  let bestIndex = 0;
  let bestVersion = -1;
  let bestTimestamp = 0;

  for (let i = 0; i < records.length; i++) {
    try {
      const record = records[i];
      if (!record) continue;

      const store = decompressStore(record);

      // Prefer higher version, then more recent timestamp
      if (
        store.version > bestVersion ||
        (store.version === bestVersion && store.last_updated > bestTimestamp)
      ) {
        bestVersion = store.version;
        bestTimestamp = store.last_updated;
        bestIndex = i;
      }
    } catch {
      // Skip invalid records
      continue;
    }
  }

  return bestIndex;
}
