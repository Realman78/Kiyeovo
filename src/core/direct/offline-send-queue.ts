import type { ChatNode, OfflineMessage, MessageSendStateChangedEvent } from '../types.js';
import type { ChatDatabase, PendingOfflineSend } from '../db/database.js';
import { MAX_MESSAGES_PER_STORE, OFFLINE_ACK_RESERVE, OFFLINE_CONTROL_MESSAGE_RESERVE } from '../constants.js';
import { errStr } from '../utils/general-error.js';
import { log } from '../../shared/logger.js';
import { OfflineMessageManager } from './offline-message-manager.js';

export interface OfflineSendQueueDeps {
  node: ChatNode;
  database: ChatDatabase;
  /** Build the signed OfflineMessage for a queued row (sender keys / recipient key live in the caller). */
  buildOfflineMessage: (send: PendingOfflineSend) => OfflineMessage;
  /** Current identity signing key, used to sign the bucket store. */
  getSigningKey: () => Uint8Array;
  /** Dual-write partner: push the send-state transition to the renderer. */
  emitSendState: (data: MessageSendStateChangedEvent) => void;
  /** Capacity panel partner: notify the renderer-facing owner to refetch this chat. */
  emitInboxCapacityChanged: (chatId: number) => void;
}

const userCapacityLimit = (): number => Math.max(0, MAX_MESSAGES_PER_STORE - OFFLINE_CONTROL_MESSAGE_RESERVE - OFFLINE_ACK_RESERVE);

/**
 * Durable, batched background queue for 1:1 offline sends.
 *
 * A burst of N messages to an offline peer becomes one (or a couple) DHT writes:
 * each enqueue triggers `flushBucket`, but only one flush runs per bucket at a
 * time, so messages that arrive while a write is in flight pile into the queue
 * and get drained together on the next pass (leading-edge + trailing coalesce).
 *
 * Outcomes are dual-written: the DB row (`updateMessageSendState`, source of
 * truth, survives restart / non-active chats) AND the live event. On any write
 * failure we mark the rows `failed` and stop — give-up threshold is 0; recovery
 * is a manual Retry.
 */
export class OfflineSendQueue {
  private readonly deps: OfflineSendQueueDeps;
  private readonly flushing = new Set<string>();
  private readonly reflush = new Set<string>();

  constructor(deps: OfflineSendQueueDeps) {
    this.deps = deps;
  }

  /** True while the bucket has room for one more message (stored + still-pending < limit). */
  /**
   * Best-effort capacity check for the renderer pre-send UX (avoid the optimistic
   * row when obviously full). The authoritative, atomic gate is the
   * count-and-insert inside `createMessageWithPendingOfflineSend`.
   */
  hasCapacity(bucketKey: string, additional = 0): boolean {
    // Live (expiry-pruned) count so the gate matches the write path; otherwise
    // aged-out entries would keep rejecting new sends until the cache is cleared.
    // `additional` = caller's in-flight messages not yet in the queue.
    const stored = OfflineMessageManager.liveBucketMessageCount(this.deps.database, bucketKey);
    const pending = this.deps.database.countActivePendingOfflineSendsByBucket(bucketKey);
    return stored + pending + additional < userCapacityLimit();
  }

  /** Max user messages a bucket may hold (the atomic insert enforces this). */
  capacityLimit(): number {
    return userCapacityLimit();
  }

  /** Manual retry of a failed row: requeue, show the spinner again, flush. */
  retry(messageId: string): void {
    const row = this.deps.database.getPendingOfflineSend(messageId);
    if (!row) {
      return;
    }
    this.deps.database.requeuePendingOfflineSend(messageId);
    this.deps.database.updateMessageSendState(messageId, 'sending');
    this.deps.emitSendState({ messageId, chatId: row.chat_id, outcome: 'sending' });
    this.deps.emitInboxCapacityChanged(row.chat_id);
    void this.flushBucket(row.bucket_key);
  }

  /**
   * On startup, any row left `queued` was mid-flight when the app died. Per the
   * manual-retry policy there is no auto-resume — surface them as `failed` so the
   * Retry button appears. The chat rows reload as failed via `mapDbMessage`.
   */
  recoverOnStartup(): void {
    // Atomic + idempotent: any interrupted send becomes `failed` (manual retry),
    // and chat rows stuck on `sending` with a pending queue row are corrected.
    this.deps.database.reconcileInterruptedOfflineSends();
    log('[OFFLINE-QUEUE][RECOVER] reconciled interrupted offline sends to failed (manual retry)');
  }

  async flushBucket(bucketKey: string): Promise<void> {
    if (this.flushing.has(bucketKey)) {
      this.reflush.add(bucketKey);
      // TEMP_LOG: burst coalescing path — a second send arrived while a bucket
      // flush was already in flight.
      log(`[TEMP_LOG][OFFLINE][QUEUE][REFLUSH] bucket=*${bucketKey.slice(-12)} reason=already_flushing`);
      return;
    }
    this.flushing.add(bucketKey);
    try {
      for (;;) {
        const rows = this.deps.database.getQueuedPendingOfflineSendsByBucket(bucketKey);
        if (rows.length === 0) {
          break;
        }
        const peerIds = Array.from(new Set(rows.map(r => r.peer_id)));
        const connectedPeers = peerIds.filter(peerId =>
          this.deps.node.getConnections().some(conn => conn.remotePeer.toString() === peerId),
        );
        // TEMP_LOG: tells us whether a flush started while the target peer was
        // already connected, which is the key race for the refetch nudge.
        log(
          `[TEMP_LOG][OFFLINE][QUEUE][FLUSH][START] bucket=*${bucketKey.slice(-12)} count=${rows.length} peers=${peerIds.map(id => id.slice(-8)).join(',')} connected=${connectedPeers.map(id => id.slice(-8)).join(',') || 'none'}`,
        );
        const ids = rows.map(r => r.message_id);
        try {
          const offlineMessages = rows.map(r => this.deps.buildOfflineMessage(r));
          await OfflineMessageManager.storeOfflineMessages(
            this.deps.node,
            bucketKey,
            offlineMessages,
            this.deps.getSigningKey(),
            this.deps.database,
          );
          // Atomic: drop queue rows + clear chat rows together (crash-safe).
          this.deps.database.settlePendingOfflineSendsDelivered(ids);
          const changedChatIds = new Set<number>();
          for (const r of rows) {
            this.deps.emitSendState({
              messageId: r.message_id,
              chatId: r.chat_id,
              outcome: 'delivered',
              messageSentStatus: 'offline',
            });
            changedChatIds.add(r.chat_id);
          }
          for (const chatId of changedChatIds) {
            this.deps.emitInboxCapacityChanged(chatId);
          }
          // TEMP_LOG: confirms the offline message became live in the local
          // bucket mirror, and whether the peer was connected at that moment.
          log(
            `[TEMP_LOG][OFFLINE][QUEUE][FLUSH][DONE] bucket=*${bucketKey.slice(-12)} count=${rows.length} peers=${peerIds.map(id => id.slice(-8)).join(',')} connected=${connectedPeers.map(id => id.slice(-8)).join(',') || 'none'}`,
          );
          // Loop: pick up anything that arrived during the PUT (trailing coalesce).
        } catch (error: unknown) {
          const reason = errStr(error);
          // Atomic: mark queue rows + chat rows failed together (crash-safe).
          this.deps.database.settlePendingOfflineSendsFailed(ids, reason);
          const changedChatIds = new Set<number>();
          for (const r of rows) {
            this.deps.emitSendState({
              messageId: r.message_id,
              chatId: r.chat_id,
              outcome: 'failed',
              failedReason: 'other',
            });
            changedChatIds.add(r.chat_id);
          }
          for (const chatId of changedChatIds) {
            this.deps.emitInboxCapacityChanged(chatId);
          }
          // TEMP_LOG: distinguishes "nudge race" from "the flush itself never
          // finished", which would make a refetch impossible.
          log(
            `[TEMP_LOG][OFFLINE][QUEUE][FLUSH][FAIL] bucket=*${bucketKey.slice(-12)} count=${rows.length} peers=${peerIds.map(id => id.slice(-8)).join(',')} connected=${connectedPeers.map(id => id.slice(-8)).join(',') || 'none'} reason=${reason}`,
          );
          log(`[OFFLINE-QUEUE][FLUSH][FAIL] bucket=${bucketKey.slice(-12)} count=${ids.length} reason=${reason}`);
          break; // give-up = 0: stop on failure, await manual retry.
        }
      }
    } finally {
      this.flushing.delete(bucketKey);
      if (this.reflush.delete(bucketKey)) {
        void this.flushBucket(bucketKey);
      }
    }
  }
}
