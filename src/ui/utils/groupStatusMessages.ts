export function getGroupStatusMessage(groupStatus?: string): string | null {
  switch (groupStatus) {
    case 'invited_pending':
      return 'Waiting for members to accept invites...';
    case 'awaiting_activation':
      return 'Waiting for creator activation...';
    case 'rekeying':
      return 'Group membership is updating...';
    case 'left':
      return 'You left this group.';
    case 'removed':
      return 'You were removed from this group.';
    case 'disbanded':
      return 'This group was disbanded by the creator.';
    default:
      return null;
  }
}

export function isGroupStatusWaiting(groupStatus?: string): boolean {
  return groupStatus === 'invited_pending'
    || groupStatus === 'awaiting_activation'
    || groupStatus === 'rekeying';
}
