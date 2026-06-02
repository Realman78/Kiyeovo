import { type FC, useEffect, useMemo, useState } from 'react';
import { BadgeInfo, Check, CircleUser, Copy, Shield, Users } from 'lucide-react';

import type { GroupCallParticipant } from '../../../core/types';
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog';

type GroupMemberInfo = {
  peerId: string;
  username: string;
  status: 'pending' | 'accepted' | 'confirmed';
};

type GroupCallParticipantModalProps = {
  chatId: number | null;
  connected: boolean;
  disconnectSecondsRemaining: number | null;
  displayName: string;
  groupName: string;
  localPeerId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  participant: GroupCallParticipant | null;
  writerPeerId: string | null;
};

function formatDate(timestamp: number | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return 'Unknown';
  }
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const GroupCallParticipantModal: FC<GroupCallParticipantModalProps> = ({
  chatId,
  connected,
  disconnectSecondsRemaining,
  displayName,
  groupName,
  localPeerId,
  open,
  onOpenChange,
  participant,
  writerPeerId,
}) => {
  const [loading, setLoading] = useState(false);
  const [groupMember, setGroupMember] = useState<GroupMemberInfo | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  useEffect(() => {
    if (!open || chatId === null || !participant) {
      setGroupMember(null);
      return;
    }

    let cancelled = false;
    const loadGroupMember = async () => {
      setLoading(true);
      try {
        const result = await window.kiyeovoAPI.getGroupMembers(chatId);
        if (!cancelled && result.success) {
          const match = result.members.find((member) => member.peerId === participant.peerId) ?? null;
          setGroupMember(match);
        }
      } catch (error) {
        console.error('Failed to load group call participant info:', error);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadGroupMember();
    return () => {
      cancelled = true;
    };
  }, [chatId, open, participant]);

  const resolvedName = groupMember?.username || displayName;
  const callRole = participant?.peerId === writerPeerId ? 'Writer' : 'Member';
  const callStatus = useMemo(() => {
    if (disconnectSecondsRemaining !== null) {
      return `Disconnect ${disconnectSecondsRemaining}s`;
    }
    return connected ? 'Connected' : 'Pending';
  }, [connected, disconnectSecondsRemaining]);
  const membershipStatus = participant?.peerId === localPeerId
    ? 'You'
    : groupMember?.status
      ? groupMember.status[0].toUpperCase() + groupMember.status.slice(1)
      : 'Unknown';

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{resolvedName}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-6">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          )}

          <div className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <CircleUser className="h-4 w-4 text-primary" />
              Participant
            </h3>
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-primary" />
              <span className="min-w-[110px] text-muted-foreground">Display name:</span>
              <span className="flex-1 font-mono">{resolvedName}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void copyToClipboard(resolvedName, 'name')}
              >
                {copiedField === 'name' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Shield className="h-4 w-4 text-primary" />
              <span className="min-w-[110px] text-muted-foreground">Peer ID:</span>
              <span className="flex-1 truncate font-mono text-xs">{participant?.peerId ?? 'Unknown'}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void copyToClipboard(participant?.peerId ?? '', 'peerId')}
              >
                {copiedField === 'peerId' ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <BadgeInfo className="h-4 w-4 text-primary" />
              Call Info
            </h3>
            <div className="space-y-2 pl-6 text-sm">
              <div className="flex items-center">
                <span className="min-w-[140px] text-muted-foreground">Group:</span>
                <span>{groupName}</span>
              </div>
              <div className="flex items-center">
                <span className="min-w-[140px] text-muted-foreground">Role:</span>
                <span>{callRole}</span>
              </div>
              <div className="flex items-center">
                <span className="min-w-[140px] text-muted-foreground">Status:</span>
                <span>{callStatus}</span>
              </div>
              <div className="flex items-center">
                <span className="min-w-[140px] text-muted-foreground">Joined call:</span>
                <span className="font-mono text-xs">{formatDate(participant?.joinedAt ?? null)}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Users className="h-4 w-4 text-primary" />
              Group Membership
            </h3>
            <div className="space-y-2 pl-6 text-sm">
              <div className="flex items-center">
                <span className="min-w-[140px] text-muted-foreground">Membership:</span>
                <span>{membershipStatus}</span>
              </div>
              {!groupMember && participant?.peerId !== localPeerId && (
                <div className="text-xs text-muted-foreground">
                  This peer is in the call roster, but we do not have richer group member details locally.
                </div>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
