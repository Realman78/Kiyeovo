import type { ChatNode, OfflineMessage, MessageSendStateChangedEvent } from '../types.js';
import type { ChatDatabase, PendingOfflineSend } from '../db/database.js';
import { MAX_MESSAGES_PER_STORE, OFFLINE_CONTROL_MESSAGE_RESERVE } from '../constants.js';
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
}

const userCapacityLimit = (): number => Math.max(0, MAX_MESSAGES_PER_STORE - OFFLINE_CONTROL_MESSAGE_RESERVE);

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
  hasCapacity(bucketKey: string): boolean {
    // Live (expiry-pruned) count so the gate matches the write path; otherwise
    // aged-out entries would keep rejecting new sends until the cache is cleared.
    const stored = OfflineMessageManager.liveBucketMessageCount(this.deps.database, bucketKey);
    const pending = this.deps.database.countActivePendingOfflineSendsByBucket(bucketKey);
    return stored + pending < userCapacityLimit();
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
      return;
    }
    this.flushing.add(bucketKey);
    try {
      for (;;) {
        const rows = this.deps.database.getQueuedPendingOfflineSendsByBucket(bucketKey);
        if (rows.length === 0) {
          break;
        }
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
          for (const r of rows) {
            this.deps.emitSendState({
              messageId: r.message_id,
              chatId: r.chat_id,
              outcome: 'delivered',
              messageSentStatus: 'offline',
            });
          }
          // Loop: pick up anything that arrived during the PUT (trailing coalesce).
        } catch (error: unknown) {
          const reason = errStr(error);
          // Atomic: mark queue rows + chat rows failed together (crash-safe).
          this.deps.database.settlePendingOfflineSendsFailed(ids, reason);
          for (const r of rows) {
            this.deps.emitSendState({
              messageId: r.message_id,
              chatId: r.chat_id,
              outcome: 'failed',
              failedReason: 'other',
            });
          }
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
