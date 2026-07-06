/**
 * Pure decision helpers for event-triggered group offline catch-up.
 *
 * These live in src/core (no electron import) so the trigger site
 * (message-handler) and unit tests share one source of truth for WHEN a
 * membership transition should kick off a group offline fetch. They only decide
 * "should we trigger"; the actual fetch is per-chat coalesced by
 * MessageHandler.scheduleGroupStateUpdateCatchup, and checkGroupOfflineMessages
 * still reads only epochs <= the member's local key_version — this never moves
 * that boundary.
 */

export interface GroupMembershipSnapshot {
  groupStatus: string | null;
  keyVersion: number;
}

/**
 * A GROUP_WELCOME just completed a join (join-completion path). Trigger a
 * catch-up only when the welcome was genuinely applied — the chat is now an
 * active group at a real epoch (keyVersion >= 1) AND either it was not already
 * active or the epoch advanced. A duplicate welcome (already active at the same
 * epoch) leaves both snapshots unchanged and must NOT re-trigger.
 *
 * Epoch safety: the freshly-applied welcome sets the member's key_version to
 * the new epoch, and every membership change (including this join) rotates the
 * key, so the member only holds the post-join epoch key. Scanning that epoch's
 * bucket surfaces same-epoch messages that were published while the member was
 * still converging, while pre-join history remains in an older epoch the member
 * cannot decrypt — the boundary is untouched.
 */
export function shouldTriggerJoinCompletionCatchup(
  before: GroupMembershipSnapshot,
  after: GroupMembershipSnapshot,
): boolean {
  if (after.groupStatus !== 'active') return false;
  if (after.keyVersion < 1) return false;
  const becameActive = before.groupStatus !== 'active';
  const epochAdvanced = after.keyVersion > before.keyVersion;
  return becameActive || epochAdvanced;
}
