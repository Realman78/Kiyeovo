import type { ChatDatabase } from '../../db/database.js';

interface CreatorNudgeDeps {
  database: ChatDatabase;
  nudgeGroupRefetch?: (peerId: string, groupId: string) => void;
}

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
    deps.nudgeGroupRefetch?.(peerId, groupId);
  }
}
