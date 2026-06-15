import { randomUUID, publicEncrypt, randomBytes, createCipheriv } from 'crypto';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import type { ChatNode, OfflineMessage, OfflineMessageStore, OfflineSenderInfo, OfflineSignedPayload, StoreSignedPayload } from '../types.js';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import {
    MAX_MESSAGES_PER_STORE,
    MESSAGE_TTL,
    OFFLINE_ACK_RESERVE,
    OFFLINE_CONTROL_MESSAGE_RESERVE,
    OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS,
} from '../constants.js';
import type { ChatDatabase, OfflineMessageCategory } from '../db/database.js';
import { QueryEvent } from '@libp2p/kad-dht';
import { log } from '../../shared/logger.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * Manages offline message storage and retrieval using DHT
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class OfflineMessageManager {
    private static readonly OFFLINE_DHT_PUT_TIMEOUT_FAST_MS = 15_000;
    private static readonly OFFLINE_DHT_PUT_TIMEOUT_ANONYMOUS_MS = 30_000;
    static inFlightOfflineChecks: Map<string, Promise<any>> = new Map<string, Promise<any>>();
    private static bucketMutationQueues: Map<string, Promise<void>> = new Map<string, Promise<void>>();

    /**
     * Serializes all store mutations per bucket key to prevent lost updates.
     * Different buckets can still mutate in parallel.
     */
    private static async withBucketMutationLock<T>(
        bucketKey: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const previous = OfflineMessageManager.bucketMutationQueues.get(bucketKey) ?? Promise.resolve();
        let releaseCurrent!: () => void;
        const current = new Promise<void>(resolve => {
            releaseCurrent = resolve;
        });

        OfflineMessageManager.bucketMutationQueues.set(
            bucketKey,
            previous.catch(() => undefined).then(() => current),
        );

        await previous.catch(() => undefined);

        try {
            return await operation();
        } finally {
            releaseCurrent();
            if (OfflineMessageManager.bucketMutationQueues.get(bucketKey) === current) {
                OfflineMessageManager.bucketMutationQueues.delete(bucketKey);
            }
        }
    }
 
    static async storeOfflineMessage(
        node: ChatNode,
        bucketKey: string,
        message: OfflineMessage,
        signingPrivateKey: Uint8Array,
        database: ChatDatabase,
        options?: {
            bypassControlReserve?: boolean;
            category?: Exclude<OfflineMessageCategory, 'ack'>;
        }
    ): Promise<void> {
        return OfflineMessageManager.storeOfflineMessages(
            node, bucketKey, [message], signingPrivateKey, database, options,
        );
    }

    // Append a batch of offline messages to the bucket in a SINGLE DHT PUT
    static async storeOfflineMessages(
        node: ChatNode,
        bucketKey: string,
        newMessages: OfflineMessage[],
        signingPrivateKey: Uint8Array,
        database: ChatDatabase,
        options?: {
            bypassControlReserve?: boolean;
            category?: Exclude<OfflineMessageCategory, 'ack'>;
        }
    ): Promise<void> {
        if (newMessages.length === 0) {
            return;
        }
        return OfflineMessageManager.withBucketMutationLock(bucketKey, async () => {
            try {
                const bypassControlReserve = options?.bypassControlReserve === true;
                const userCapacityLimit = Math.max(0, MAX_MESSAGES_PER_STORE - OFFLINE_CONTROL_MESSAGE_RESERVE - OFFLINE_ACK_RESERVE);
                const local = database.getOfflineSentMessages(bucketKey);

                const messages: OfflineMessage[] = OfflineMessageManager.filterExpiredMessages(local.messages);
                let version = local.version;
                // User cap counts only user messages (the ack-only entry has its own
                // reserved slot); the hard cap counts everything in the payload.
                const userStored = messages.filter(m => m.signed_payload?.ack_only !== true).length;
                const userProjected = userStored + newMessages.length;
                const totalProjected = messages.length + newMessages.length;

                if (!bypassControlReserve && userProjected > userCapacityLimit) {
                    throw new Error(
                        `Offline message reserve reached (${userStored}+${newMessages.length}/${userCapacityLimit}); ` +
                        `${OFFLINE_CONTROL_MESSAGE_RESERVE} slots reserved for group control messages`,
                    );
                }

                if (totalProjected > MAX_MESSAGES_PER_STORE) {
                    throw new Error(`Offline message store full (${messages.length}+${newMessages.length}/${MAX_MESSAGES_PER_STORE})`);
                }

                log(
                    `[OFFLINE][WRITE][START] bucket=${bucketKey.slice(-12)} batch=${newMessages.length}`
                );
                messages.push(...newMessages);
                version++;

                // Sign the store before putting to DHT
                const signedStore = OfflineMessageManager.signStore(
                    messages,
                    version,
                    bucketKey,
                    signingPrivateKey
                );

                await OfflineMessageManager.putToDHT(node, bucketKey, signedStore, database);
                database.saveOfflineSentMessages(bucketKey, messages, version);
                OfflineMessageManager.syncLocalCategoryMirror(database, bucketKey, messages, new Map(
                    newMessages.map(message => [message.id, options?.category ?? 'regular'])
                ));

                log(`[OFFLINE][WRITE][DONE] bucket=*${bucketKey.slice(-12)} newVersion=${version} newCount=${messages.length}`);
            } catch (error: unknown) {
                generalErrorHandler(error);
                throw error;
            }
        });
    }

    /**
     * Write a standalone offline ACK into the bucket. Supersedes any prior ack-only
     * entry (only the latest lastReadTs matters) and may use the reserved ack slot
     * even when the bucket is otherwise full — so an ACK is always writable and never
     * accumulates.
     */
    static async storeOfflineAck(
        node: ChatNode,
        bucketKey: string,
        ackMessage: OfflineMessage,
        signingPrivateKey: Uint8Array,
        database: ChatDatabase,
    ): Promise<void> {
        return OfflineMessageManager.withBucketMutationLock(bucketKey, async () => {
            const local = database.getOfflineSentMessages(bucketKey);
            // Drop expired + any existing ACK (supersede), keep real messages.
            const kept = OfflineMessageManager.filterExpiredMessages(local.messages)
                .filter(m => m.signed_payload?.ack_only !== true);
            const messages = [...kept, ackMessage];
            if (messages.length > MAX_MESSAGES_PER_STORE) {
                throw new Error(`Offline store full even for ACK (${messages.length}/${MAX_MESSAGES_PER_STORE})`);
            }
            const version = local.version + 1;
            const signedStore = OfflineMessageManager.signStore(messages, version, bucketKey, signingPrivateKey);
            await OfflineMessageManager.putToDHT(node, bucketKey, signedStore, database);
            database.saveOfflineSentMessages(bucketKey, messages, version);
            OfflineMessageManager.syncLocalCategoryMirror(database, bucketKey, messages, new Map([[ackMessage.id, 'ack']]));
            log(`[OFFLINE][ACK][WRITE][DONE] bucket=*${bucketKey.slice(-12)} newVersion=${version} newCount=${messages.length}`);
        });
    }

    static async getOfflineMessages(
        node: ChatNode,
        bucketKeys: string[],
        appendBucketKey: boolean = true
    ): Promise<OfflineMessageStore> {
        const fetchPromises = bucketKeys.map(async (bucketKey) => {
            log('fetching messages for bucket', bucketKey);
            const key = new TextEncoder().encode(bucketKey);
            const bucketMessages: OfflineMessage[] = [];
            let valueEventCount = 0;
            let parsedStoreCount = 0;
            const storeSignatures = new Set<string>();

            try {
                let foundValue = false;

                for await (const event of node.services.dht.get(key) as AsyncIterable<QueryEvent>) {
                    if (event.name === 'VALUE' && event.value.length > 0) {
                        foundValue = true;
                        valueEventCount++;

                        const compressedBuffer = Buffer.from(event.value);
                        const decompressedBuffer = await gunzipAsync(compressedBuffer);
                        const store = JSON.parse(decompressedBuffer.toString('utf8')) as unknown;

                        if (!store || typeof store !== 'object' || !('messages' in store) || !Array.isArray(store.messages) || store.messages.length === 0) continue;
                        parsedStoreCount++;

                        const storeVersion = 'version' in store && typeof (store as any).version === 'number'
                            ? (store as any).version
                            : 'n/a';
                        const storeLastUpdated = 'last_updated' in store && typeof (store as any).last_updated === 'number'
                            ? (store as any).last_updated
                            : 'n/a';
                        const storeSignature = 'store_signature' in store && typeof (store as any).store_signature === 'string'
                            ? (store as any).store_signature
                            : '';
                        if (storeSignature) {
                            storeSignatures.add(storeSignature);
                        }

                        const validMessages = store.messages.filter(
                            (msg: unknown) => OfflineMessageManager.isValidOfflineMessage(msg)
                        );
                        const validIds = validMessages
                            .map(msg => msg.id)
                            .slice(0, 3)
                            .join(',');

                        log(
                            `[OFFLINE][READ] bucket=${bucketKey.slice(0, 48)}... value#${valueEventCount} ` +
                            `storeVersion=${storeVersion} storeLastUpdated=${storeLastUpdated} ` +
                            `raw=${store.messages.length} valid=${validMessages.length} ` +
                            `sampleIds=[${validIds}]`
                        );

                        if (appendBucketKey) {
                            bucketMessages.push(...validMessages.map(msg => ({ ...msg, bucket_key: bucketKey })));
                        } else {
                            bucketMessages.push(...validMessages);
                        }
                    }
                }

                if (!foundValue) {
                    log(`No value found in DHT for bucket key: ${bucketKey}`);
                } else {
                    const uniqueIds = new Set(bucketMessages.map(m => m.id)).size;
                    const duplicateCount = bucketMessages.length - uniqueIds;
                    const repeatedStoreWrites = parsedStoreCount - storeSignatures.size;
                    log(
                        `[OFFLINE][READ] bucket=${bucketKey.slice(0, 48)}... summary ` +
                        `valueEvents=${valueEventCount} parsedStores=${parsedStoreCount} uniqueStores=${storeSignatures.size} ` +
                        `repeatedStorePayloads=${Math.max(0, repeatedStoreWrites)} accumulatedMessages=${bucketMessages.length} duplicatesById=${Math.max(0, duplicateCount)}`
                    );
                }

            } catch (error: unknown) {
                generalErrorHandler(error, `Failed to fetch offline messages for bucket: ${bucketKey}`);
            }

            return bucketMessages;
        });

        const results = await Promise.all(fetchPromises);
        const messages = results.flat();

        // Return structure with placeholder signature fields
        // The caller must call signStore() before putting to DHT
        return {
            messages,
            last_updated: Date.now(),
            version: 0,
            store_signature: '',
            store_signed_payload: {
                message_ids: [],
                version: 0,
                timestamp: 0,
                bucket_key: ''
            }
        };
    }

    private static filterExpiredMessages(messages: OfflineMessage[]): OfflineMessage[] {
        const now = Date.now();
        return messages.filter(msg => msg.expires_at > now).map(msg => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { bucket_key, ...clean } = msg;
            return clean;
        });
    }

    /**
     * Live (non-expired) count of **user** messages stored in a bucket — excludes
     * the ack-only entry, which lives in its own reserved slot (so it must not be
     * counted against the user cap, and a lone stale ACK must not look like
     * "pending messages"). Prunes expired entries to match the write path.
     */
    static liveBucketMessageCount(database: ChatDatabase, bucketKey: string): number {
        return OfflineMessageManager.filterExpiredMessages(database.getOfflineSentMessages(bucketKey).messages)
            .filter(m => m.signed_payload?.ack_only !== true)
            .length;
    }

    private static syncLocalCategoryMirror(
        database: ChatDatabase,
        bucketKey: string,
        messages: OfflineMessage[],
        newCategoryByMessageId?: Map<string, OfflineMessageCategory>,
    ): void {
        const existingCategories = new Map(
            database.getOfflineSentMessageCategories(bucketKey).map(entry => [entry.message_id, entry.category]),
        );

        database.syncOfflineSentMessageCategories(
            bucketKey,
            messages.map((message) => {
                if (message.signed_payload?.ack_only === true) {
                    return { messageId: message.id, category: 'ack' as const };
                }

                return {
                    messageId: message.id,
                    category: newCategoryByMessageId?.get(message.id)
                        ?? existingCategories.get(message.id)
                        ?? 'regular',
                };
            }),
        );
    }

    /**
     * Sign the entire store to prevent unauthorized modifications
     *
     * The signature covers: message_ids, version, timestamp, bucket_key
     * This prevents third parties from deleting/modifying messages even if they know the bucket key
     */
    static signStore(
        messages: OfflineMessage[],
        version: number,
        bucketKey: string,
        signingPrivateKey: Uint8Array
    ): OfflineMessageStore {
        const timestamp = Date.now();
        const messageIds = messages.map(m => m.id);

        const storeSignedPayload: StoreSignedPayload = {
            message_ids: messageIds,
            version,
            timestamp,
            bucket_key: bucketKey
        };

        const payloadBytes = new TextEncoder().encode(JSON.stringify(storeSignedPayload));
        const signatureBytes = ed25519.sign(payloadBytes, signingPrivateKey);
        const storeSignature = Buffer.from(signatureBytes).toString('base64');

        return {
            messages,
            last_updated: timestamp,
            version,
            store_signature: storeSignature,
            store_signed_payload: storeSignedPayload
        };
    }

    // Clear acknowledged messages from a bucket. 
    static async clearAcknowledgedMessages(
        bucketKey: string,
        ackTimestamp: number,
        database: ChatDatabase
    ): Promise<void> {
        await OfflineMessageManager.withBucketMutationLock(bucketKey, async () => {
            const local = database.getOfflineSentMessages(bucketKey);
            const remainingMessages = local.messages.filter(msg => msg.timestamp > ackTimestamp);
            const bucketTag = bucketKey.slice(-12);
            const ackOnlyBefore = local.messages.filter(msg => msg.signed_payload?.ack_only === true).length;

            const cleanMessages = OfflineMessageManager.filterExpiredMessages(remainingMessages);
            const ackOnlyAfter = cleanMessages.filter(msg => msg.signed_payload?.ack_only === true).length;

            // TEMP_LOG: detailed sender-side mirror diff for ACK-clearing investigations.
            log(
                `[TEMP_LOG][OFFLINE][ACK_CLEAR][EVAL] bucket=*${bucketTag} ackTs=${ackTimestamp} before=${local.messages.length} afterCandidate=${cleanMessages.length} ackOnlyBefore=${ackOnlyBefore} ackOnlyAfter=${ackOnlyAfter}`
            );

            if (cleanMessages.length === local.messages.length) {
                log(
                    `[OFFLINE][ACK_CLEAR][SKIP] bucket=*${bucketTag} ackTs=${ackTimestamp} localCount=${local.messages.length}`
                );
                return;
            }

            const version = local.version + 1;
            // Local save is sufficient, next outbound write will publish pruned state.
            database.saveOfflineSentMessages(bucketKey, cleanMessages, version);
            OfflineMessageManager.syncLocalCategoryMirror(database, bucketKey, cleanMessages);

            log(
                `[OFFLINE][ACK_CLEAR][DONE] bucket=*${bucketTag} removed=${local.messages.length - cleanMessages.length} newVersion=${version} newCount=${cleanMessages.length}`
            );
        });
    }

    /**
     * Create a new offline message
     *
     * 1. Encrypt content and sender info with recipient's RSA public key
     * 2. Sign the hashes of encrypted data (for DHT validation)
     *
     * The signature is over: {content_hash, sender_info_hash, timestamp, bucket_key}
     * This allows DHT validators to verify writes without decryption.
     */
    static createOfflineMessage(
        senderPeerId: string,
        senderUsername: string,
        content: string,
        recipientPublicKey: string,           // RSA public key of recipient (PEM format)
        senderSigningPrivateKey: Uint8Array,  // Ed25519 private key for signing
        bucketKey: string,                    // Full bucket key for signature binding
        offlineAckTimestamp?: number,         // Optional ACK for messages we've read from recipient's bucket
        // Optional stable identity for idempotent rebuilds (the background-send
        // queue passes the chat message id + original send time). The recipient
        // dedupes by `id`, so a retry of the same message can't deliver twice.
        stableId?: string,
        stableTimestamp?: number,
        // Standalone ACK marker (signed). The recipient processes the ACK but does
        // not display/save it or advance its lastReadTs.
        ackOnly?: boolean,
    ): OfflineMessage {
        // RSA-OAEP (Node default) max plaintext for a 2048-bit key: 256 - 2*20 - 2 = 214 bytes
        const RSA_MAX_PLAINTEXT = 214;

        try {
            const timestamp = stableTimestamp ?? Date.now();

            const contentBytes = Buffer.from(content, 'utf8');
            let encryptedContentB64: string;
            let encryptedAesKey: string | undefined;
            let aesIv: string | undefined;
            let messageType: 'encrypted' | 'hybrid';

            if (contentBytes.byteLength <= RSA_MAX_PLAINTEXT) {
                // Small enough to RSA-encrypt directly
                const encryptedContent = publicEncrypt(recipientPublicKey, contentBytes);
                encryptedContentB64 = encryptedContent.toString('base64');
                messageType = 'encrypted';
            } else {
                // Hybrid: AES-256-GCM for content, RSA for the AES key
                const aesKey = randomBytes(32);
                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
                const ciphertext = Buffer.concat([cipher.update(contentBytes), cipher.final()]);
                const authTag = cipher.getAuthTag();
                // Prepend authTag (16 bytes) to ciphertext so decryptor can extract it
                encryptedContentB64 = Buffer.concat([authTag, ciphertext]).toString('base64');
                encryptedAesKey = publicEncrypt(recipientPublicKey, aesKey).toString('base64');
                aesIv = iv.toString('base64');
                messageType = 'hybrid';
            }

            // Encrypt sender info (peer_id, username, and optional ACK) with recipient's RSA public key
            const senderInfo: OfflineSenderInfo = {
                peer_id: senderPeerId,
                username: senderUsername,
            };
            if (offlineAckTimestamp) {
                senderInfo.offline_ack_timestamp = offlineAckTimestamp;
            }
            const encryptedSenderInfo = publicEncrypt(
                recipientPublicKey,
                Buffer.from(JSON.stringify(senderInfo), 'utf8')
            );
            const encryptedSenderInfoB64 = encryptedSenderInfo.toString('base64');

            const encryptedContentBuf = Buffer.from(encryptedContentB64, 'base64');
            const signedPayload: OfflineSignedPayload = {
                content_hash: Buffer.from(sha256(encryptedContentBuf)).toString('base64'),
                sender_info_hash: Buffer.from(sha256(encryptedSenderInfo)).toString('base64'),
                timestamp,
                bucket_key: bucketKey,
                ...(ackOnly ? { ack_only: true } : {}),
            };

            const payloadBytes = new TextEncoder().encode(JSON.stringify(signedPayload));
            const signatureBytes = ed25519.sign(payloadBytes, senderSigningPrivateKey);
            const signature = Buffer.from(signatureBytes).toString('base64');

            return {
                id: stableId ?? randomUUID(),
                encrypted_sender_info: encryptedSenderInfoB64,
                content: encryptedContentB64,
                signature,
                signed_payload: signedPayload,
                message_type: messageType,
                ...(encryptedAesKey !== undefined && { encrypted_aes_key: encryptedAesKey }),
                ...(aesIv !== undefined && { aes_iv: aesIv }),
                timestamp,
                expires_at: timestamp + MESSAGE_TTL
            };
        } catch (error: unknown) {
            const errorMessage = errStr(error);
            console.error('Failed to create offline message:', errorMessage);
            throw error;
        }
    }

    static verifyOfflineMessageSignature(
        message: OfflineMessage,
        senderSigningPublicKey: string, // Ed25519 public key (base64)
        expectedBucketKey: string
    ): boolean {
        try {
            if (!message.signature || !message.signed_payload) {
                log('Skipping signature verification: missing signature or signed_payload');
                return false;
            }

            // 1. Verify signature over signed_payload
            const payloadBytes = new TextEncoder().encode(JSON.stringify(message.signed_payload));
            const signatureBytes = Buffer.from(message.signature, 'base64');
            const publicKeyBytes = Buffer.from(senderSigningPublicKey, 'base64');

            const isSignatureValid = ed25519.verify(signatureBytes, payloadBytes, publicKeyBytes);
            if (!isSignatureValid) {
                log('Offline message signature verification failed');
                return false;
            }

            // 2. Verify content_hash matches actual encrypted content
            const contentBytes = Buffer.from(message.content, 'base64');
            const actualContentHash = Buffer.from(sha256(contentBytes)).toString('base64');
            if (actualContentHash !== message.signed_payload.content_hash) {
                log('Offline message content_hash mismatch');
                return false;
            }

            // 3. Verify sender_info_hash matches actual encrypted sender info
            const senderInfoBytes = Buffer.from(message.encrypted_sender_info, 'base64');
            const actualSenderInfoHash = Buffer.from(sha256(senderInfoBytes)).toString('base64');
            if (actualSenderInfoHash !== message.signed_payload.sender_info_hash) {
                log('Offline message sender_info_hash mismatch');
                return false;
            }

            // 4. Verify bucket_key
            if (message.signed_payload.bucket_key !== expectedBucketKey) {
                log('Offline message bucket_key mismatch');
                return false;
            }

            if (!Number.isFinite(message.timestamp) || message.timestamp <= 0) {
                log('Offline message timestamp invalid');
                return false;
            }
            if (!Number.isFinite(message.signed_payload.timestamp) || message.signed_payload.timestamp <= 0) {
                log('Offline message signed timestamp invalid');
                return false;
            }
            if (message.timestamp !== message.signed_payload.timestamp) {
                log('Offline message timestamp mismatch between payload and metadata');
                return false;
            }
            if (message.timestamp > Date.now() + OFFLINE_MESSAGE_MAX_FUTURE_SKEW_MS) {
                log('Offline message timestamp too far in future');
                return false;
            }

            return true;
        } catch (error: unknown) {
            generalErrorHandler(error);
            return false;
        }
    }

    private static getOfflinePutTimeoutMs(database: ChatDatabase): number {
        return database.getSessionNetworkMode() === 'anonymous'
            ? OfflineMessageManager.OFFLINE_DHT_PUT_TIMEOUT_ANONYMOUS_MS
            : OfflineMessageManager.OFFLINE_DHT_PUT_TIMEOUT_FAST_MS;
    }

    private static async putToDHT(
        node: ChatNode,
        key: string,
        data: OfflineMessageStore,
        database: ChatDatabase,
    ): Promise<void> {
        const keyBytes = new TextEncoder().encode(key);
        const jsonBytes = Buffer.from(JSON.stringify(data), 'utf8');
        const timeoutMs = OfflineMessageManager.getOfflinePutTimeoutMs(database);

        const compressedBytes = await gzipAsync(jsonBytes);

        log(`PUT to DHT - Key: ${key}, Original: ${jsonBytes.length} bytes`);
        log(`Compressed: ${compressedBytes.length} bytes (${Math.round((1 - compressedBytes.length / jsonBytes.length) * 100)}% reduction)`);

        const putSignal = AbortSignal.timeout(timeoutMs);

        // Diagnostic tally of the Kademlia walk. The put yields a stream of
        // QueryEvents (DIALING_PEER, PEER_RESPONSE, QUERY_ERROR, FINAL_PEER, ...)
        // as it routes toward the closest peers. On timeout the whole walk is
        // discarded, so we record per-name counts plus when the first/last event
        // arrived to tell apart "couldn't dial out at all" from "reached peers
        // but storage was slow/failing".
        const putStartedAtMs = Date.now();
        const eventCounts: Record<string, number> = {};
        let totalEvents = 0;
        let firstEventAtMs: number | null = null;
        let lastEventAtMs: number | null = null;

        const formatEventTally = (): string => {
            const names = Object.keys(eventCounts).sort();
            const byName = names.length > 0
                ? names.map((name) => `${name}=${eventCounts[name]}`).join(',')
                : 'none';
            const firstOffset = firstEventAtMs !== null ? firstEventAtMs - putStartedAtMs : -1;
            const lastOffset = lastEventAtMs !== null ? lastEventAtMs - putStartedAtMs : -1;
            return `total=${totalEvents} byName=${byName} firstEventMs=${firstOffset} lastEventMs=${lastOffset}`;
        };

        try {
            let hadSuccess = false;
            let errorCount = 0;

            for await (const event of node.services.dht.put(
                keyBytes,
                compressedBytes,
                { signal: putSignal },
            ) as AsyncIterable<QueryEvent>) {
                totalEvents++;
                const nowMs = Date.now();
                if (firstEventAtMs === null) firstEventAtMs = nowMs;
                lastEventAtMs = nowMs;
                eventCounts[event.name] = (eventCounts[event.name] ?? 0) + 1;

                if (event.name === 'QUERY_ERROR') errorCount++;
                else if (event.name === 'PEER_RESPONSE') hadSuccess = true;
            }
            if (errorCount > 0 && !hadSuccess) {
                log(`[OFFLINE][PUT][EVENTS][FAIL] ${formatEventTally()}`);
                throw new Error(`DHT PUT failed: All ${errorCount} peers unreachable`);
            }

            log(`[OFFLINE][PUT][EVENTS][DONE] ${formatEventTally()}`);
            log(`DHT PUT completed with ${totalEvents} events`);

            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error: unknown) {
            if (error instanceof Error && error.name === 'AbortError') {
                log(`[OFFLINE][PUT][EVENTS][TIMEOUT] ${formatEventTally()}`);
                const timeoutError = new Error(`Offline DHT write timed out after ${timeoutMs}ms`);
                generalErrorHandler(timeoutError, 'PUT to DHT failed');
                throw timeoutError;
            }
            log(`[OFFLINE][PUT][EVENTS][ERROR] ${formatEventTally()}`);
            generalErrorHandler(error, "PUT to DHT failed");
            throw error;
        }
    }

    private static isValidOfflineMessage(msg: unknown): msg is OfflineMessage {
        return typeof msg === 'object' && 
        msg !== null && 
        'id' in msg && 
        typeof msg.id === 'string' && 
        'encrypted_sender_info' in msg && 
        typeof msg.encrypted_sender_info === 'string' && 
        'content' in msg && 
        typeof msg.content === 'string' && 
        'signature' in msg && 
        typeof msg.signature === 'string' && 'signed_payload' in msg && typeof msg.signed_payload === 'object' && 'message_type' in msg && typeof msg.message_type === 'string' && 'timestamp' in msg && typeof msg.timestamp === 'number' && 'expires_at' in msg && typeof msg.expires_at === 'number';
    }
}
