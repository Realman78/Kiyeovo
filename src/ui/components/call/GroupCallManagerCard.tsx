import { useEffect, useMemo, useState } from 'react';
import { Loader2, Mic, MicOff, PhoneOff, Users } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { groupCallService, type GroupCallSnapshot } from '../../lib/call/groupCallService';

function groupCallStateLabel(snapshot: GroupCallSnapshot): string {
  switch (snapshot.state) {
    case 'joining':
      return 'Joining...';
    case 'active':
      return 'Audio connected';
    case 'waiting':
      return snapshot.role === 'writer' ? 'Waiting for participants' : 'Waiting for audio';
    default:
      return snapshot.state;
  }
}

export const GroupCallManagerCard = () => {
  const { toast } = useToast();
  const chats = useAppSelector((state) => state.chat.chats);
  const userPeerId = useAppSelector((state) => state.user.peerId);
  const [snapshot, setSnapshot] = useState<GroupCallSnapshot>(() => groupCallService.getSnapshot());
  const [actionPending, setActionPending] = useState<'mute' | 'leave' | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    return groupCallService.subscribe((event) => {
      if (event.type === 'state') {
        setSnapshot(event.snapshot);
      }
    });
  }, []);

  useEffect(() => {
    if (snapshot.pendingDisconnects.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot.pendingDisconnects.length]);

  const participantPeerIds = useMemo(() => {
    if (snapshot.participantPeerIds.length > 0) {
      return snapshot.participantPeerIds;
    }
    if (snapshot.localPeerId) {
      return [snapshot.localPeerId];
    }
    return [];
  }, [snapshot.localPeerId, snapshot.participantPeerIds]);

  const connectedPeerIds = useMemo(() => new Set(snapshot.connectedPeerIds), [snapshot.connectedPeerIds]);
  const pendingDisconnects = useMemo(
    () => new Map(snapshot.pendingDisconnects.map((entry) => [entry.peerId, entry.expiresAt])),
    [snapshot.pendingDisconnects],
  );
  const groupChat = chats.find((chat) => chat.id === snapshot.chatId || chat.groupId === snapshot.groupId);

  const resolvePeerName = (peerId: string): string => {
    if (peerId === userPeerId || peerId === snapshot.localPeerId) {
      return 'You';
    }
    return chats.find((chat) => chat.type === 'direct' && chat.peerId === peerId)?.name
      ?? `user_${peerId.slice(-8)}`;
  };

  const handleToggleMute = async () => {
    setActionPending('mute');
    const result = await groupCallService.toggleMute();
    setActionPending(null);
    if (!result.success) {
      toast.error(result.error || 'Failed to update microphone state');
    }
  };

  const handleLeave = async () => {
    setActionPending('leave');
    const result = await groupCallService.leave();
    setActionPending(null);
    if (!result.success) {
      toast.error(result.error || 'Failed to leave group call');
    }
  };

  if (snapshot.state === 'idle' || snapshot.state === 'ended') {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 rounded-xl border border-primary/30 bg-background/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-primary">
            <Users className="h-4 w-4" />
            Group Call
          </div>
          <div className="mt-1 truncate font-mono text-sm text-foreground">
            {groupChat?.name || 'Group chat'}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {groupCallStateLabel(snapshot)}
          </div>
        </div>
        <div className="rounded-md border border-border px-2 py-1 text-xs font-mono text-muted-foreground">
          {snapshot.connectedPeerIds.length} connected
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border/70 bg-secondary/20 p-3">
        <div className="mb-2 text-xs font-mono uppercase tracking-wide text-muted-foreground">
          Participants
        </div>
        <div className="space-y-2">
          {participantPeerIds.map((peerId) => {
            const isWriter = peerId === snapshot.writerPeerId;
            const isConnected = peerId === snapshot.localPeerId || connectedPeerIds.has(peerId);
            return (
              <div key={peerId} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-mono text-foreground">
                    {resolvePeerName(peerId)}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {peerId}
                  </div>
                </div>
                <div className="shrink-0 text-right text-[11px] uppercase tracking-wide text-muted-foreground">
                  <div>{isWriter ? 'Writer' : 'Member'}</div>
                  <div>
                    {pendingDisconnects.has(peerId)
                      ? `Disconnect ${Math.max(0, Math.ceil(((pendingDisconnects.get(peerId) ?? now) - now) / 1000))}s`
                      : isConnected
                        ? 'Connected'
                        : 'Pending'}
                  </div>
                </div>
              </div>
            );
          })}
          {participantPeerIds.length === 0 && (
            <div className="text-sm text-muted-foreground">Waiting for participant data...</div>
          )}
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          variant="secondary"
          className="flex-1"
          onClick={() => void handleToggleMute()}
          disabled={actionPending !== null}
        >
          {actionPending === 'mute'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : snapshot.localMuted
              ? <MicOff className="h-4 w-4" />
              : <Mic className="h-4 w-4" />}
          {snapshot.localMuted ? 'Unmute' : 'Mute'}
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          onClick={() => void handleLeave()}
          disabled={actionPending !== null}
        >
          {actionPending === 'leave'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <PhoneOff className="h-4 w-4" />}
          Leave
        </Button>
      </div>
    </div>
  );
};
