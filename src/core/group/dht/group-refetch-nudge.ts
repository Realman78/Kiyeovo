import type { ChatDatabase } from '../../db/database.js';
import { GroupMessageType } from '../types.js';

export interface GroupRefetchNudgeOptions {
  allowDialWithoutConnection?: boolean;
}

interface CreatorNudgeDeps {
  database: ChatDatabase;
  nudgeGroupRefetch?: (peerId: string, groupId: string, options?: GroupRefetchNudgeOptions) => void;
}

// Control messages whose nudge is worth a forced dial when no connection to
// the recipient exists. These are bucket-first sends — no dial was ever
// attempted for the message itself, so "not connected" carries no evidence
// the peer is unreachable — and each is either human-blocking on the
// recipient side (an unseen invite stalls group formation; an unseen kick
// leaves the removed member typing into the void) or correctness-critical
// (see GROUP_STATE_UPDATE below). Everything else keeps the default
// piggyback-only nudge.
const FORCE_DIAL_NUDGE_TYPES = new Set<string>([
  GroupMessageType.GROUP_INVITE,
  GroupMessageType.GROUP_KICK,
  // The creator is actively waiting on this one to send the welcome and
  // activate the group — the most latency-sensitive control message of all.
  GroupMessageType.GROUP_INVITE_RESPONSE,
  // Key-epoch announcements. An epoch-lagged member doesn't just receive
  // late: anything they SEND goes to the old epoch's topic/bucket, and
  // healed members permanently drop old-bucket messages timestamped more
  // than GROUP_ROTATION_GRACE_WINDOW_MS past the rotation — silent loss,
  // invisible to the sender. This entry originally stayed piggyback-only on
  // the assumption that "the periodic/offline triggers cover state updates
  // anyway", but no periodic offline check exists in the build
  // (OFFLINE_MESSAGE_CHECK_INTERVAL has no call sites) — healing is
  // event-only (startup/reconnect/wake/manual resync), so the realtime
  // nudge is the only prompt path for an online-but-disconnected member.
  GroupMessageType.GROUP_STATE_UPDATE,
]);

export function nudgeGroupRefetchIfKnownGroup(
  deps: CreatorNudgeDeps,
  peerId: string,
  message: object,
): void {
  const groupIdCandidate = (message as { groupId?: unknown }).groupId;
  if (typeof groupIdCandidate !== 'string') {
    return;
  }

  const groupId = groupIdCandidate;
  const chat = deps.database.getChatByGroupId(groupId);
  if (chat) {
    const messageType = (message as { type?: unknown }).type;
    const forceDial = typeof messageType === 'string' && FORCE_DIAL_NUDGE_TYPES.has(messageType);
    deps.nudgeGroupRefetch?.(peerId, groupId, forceDial ? { allowDialWithoutConnection: true } : undefined);
  }
}
