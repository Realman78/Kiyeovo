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
// the peer is unreachable — and each is human-blocking on the recipient side
// (an unseen invite stalls group formation; an unseen kick leaves the removed
// member typing into the void). Everything else keeps the default
// piggyback-only nudge: dial cost (a full onion circuit in anonymous mode) is
// not worth it for state updates the periodic/offline triggers cover anyway.
const FORCE_DIAL_NUDGE_TYPES = new Set<string>([
  GroupMessageType.GROUP_INVITE,
  GroupMessageType.GROUP_KICK,
  // The creator is actively waiting on this one to send the welcome and
  // activate the group — the most latency-sensitive control message of all.
  GroupMessageType.GROUP_INVITE_RESPONSE,
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
