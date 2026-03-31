export type ChatHeaderGroupMember = {
  peerId: string;
  username: string;
  status: 'pending' | 'accepted' | 'confirmed';
};

export type GroupInfoDetails = {
  groupId: string;
  keyVersion: number;
  groupStatus: string;
  createdByPeerId: string;
  creatorUsername: string;
  createdAt: Date | null;
};
