import type { Chat } from '../state/slices/chatSlice';

export interface GroupCreatorLinkState {
  broken: boolean;
  creatorPeerId?: string;
  creatorName?: string;
}

export function getGroupCreatorLinkState(
  chat: Chat,
  chats: Chat[],
  myPeerId?: string | null
): GroupCreatorLinkState {
  if (chat.type !== 'group') return { broken: false };
  if (chat.groupStatus === 'disbanded') return { broken: false };

  const creatorPeerId = chat.groupCreatorPeerId;
  if (!creatorPeerId || !myPeerId || creatorPeerId === myPeerId) {
    return { broken: false };
  }

  const hasDirectChatWithCreator = chats.some(
    (candidate) =>
      candidate.type === 'direct' &&
      candidate.peerId === creatorPeerId &&
      candidate.status !== 'pending'
  );

  if (hasDirectChatWithCreator) {
    return { broken: false };
  }

  return {
    broken: true,
    creatorPeerId,
    creatorName: chat.groupCreatorUsername ?? undefined,
  };
}
