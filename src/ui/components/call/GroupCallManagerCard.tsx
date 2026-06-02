import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Loader2, Mic, MicOff, PhoneOff, Users } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { groupCallService, type GroupCallSnapshot } from '../../lib/call/groupCallService';
import { GroupCallParticipantModal } from './GroupCallParticipantModal';
import { useCallCardAnchor } from './useCallCardAnchor';

const MAX_DISCONNECT_COUNTDOWN_SECONDS = 30;

export const GroupCallManagerCard = () => {
  const { toast } = useToast();
  const chats = useAppSelector((state) => state.chat.chats);
  const userPeerId = useAppSelector((state) => state.user.peerId);
  const [snapshot, setSnapshot] = useState<GroupCallSnapshot>(() => groupCallService.getSnapshot());
  const [actionPending, setActionPending] = useState<'mute' | 'leave' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isDraggingAnchor, setIsDraggingAnchor] = useState(false);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const { positionClassName, snapToClosestCorner } = useCallCardAnchor();

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

  const disconnectSecondsRemaining = (peerId: string): number | null => {
    const expiresAt = pendingDisconnects.get(peerId);
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return null;
    }
    const remainingSeconds = Math.ceil((expiresAt - now) / 1000);
    return Math.min(
      MAX_DISCONNECT_COUNTDOWN_SECONDS,
      Math.max(0, remainingSeconds),
    );
  };
  const selectedParticipant = selectedPeerId
    ? snapshot.participants.find((participant) => participant.peerId === selectedPeerId) ?? null
    : null;

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

  const handleAnchorPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    setIsDraggingAnchor(true);

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // no-op
    }

    const cleanup = () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // no-op
      }
      setIsDraggingAnchor(false);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      cleanup();
      snapToClosestCorner(upEvent.clientX, upEvent.clientY);
    };

    const onPointerCancel = () => {
      cleanup();
    };

    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  return (
    <div className={`fixed ${positionClassName} z-100 w-80 rounded-xl border border-primary/30 bg-background/95 p-4 shadow-2xl backdrop-blur`}>
      <button
        type="button"
        className={`absolute top-1 left-1 z-10 h-5 w-5 cursor-move rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground ${isDraggingAnchor ? 'bg-accent/80 text-foreground' : ''}`}
        title="Drag to snap card position"
        aria-label="Drag to snap card position"
        onPointerDown={handleAnchorPointerDown}
      >
        <GripVertical className="mx-auto h-3.5 w-3.5" />
      </button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex ml-1 items-center gap-2 text-sm font-medium tracking-wide text-primary">
            <Users className="h-4 w-4" />
            {groupChat?.name || 'Group chat'}
          </div>
        </div>
        <div className="rounded-md border border-border px-2 py-1 text-xs font-mono text-muted-foreground">
          {snapshot.connectedPeerIds.length + 1} members
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border/70 bg-secondary/20 p-3">
        <div className="space-y-2">
          {participantPeerIds.map((peerId) => {
            const isWriter = peerId === snapshot.writerPeerId;
            const isConnected = peerId === snapshot.localPeerId || connectedPeerIds.has(peerId);
            return (
              <div key={peerId} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <button
                    type="button"
                    className={`truncate font-mono text-foreground transition hover:text-primary ${peerId === userPeerId ? "" : "hover:cursor-pointer"}`}
                    onClick={() => peerId === userPeerId ? null : setSelectedPeerId(peerId)}
                    title={peerId === userPeerId ? 'Cannot see your own info' : `Show info for ${resolvePeerName(peerId)}`}
                  >
                    {resolvePeerName(peerId)}
                  </button>
                </div>
                <div className="shrink-0 text-right text-[11px] uppercase tracking-wide text-muted-foreground">
                  <div>
                    {pendingDisconnects.has(peerId)
                      ? `Disconnect ${disconnectSecondsRemaining(peerId) ?? MAX_DISCONNECT_COUNTDOWN_SECONDS}s`
                      : isConnected
                        ? <><span className='text-sm'>{isWriter ? '🎮 ' : ''}</span><span className='text-emerald-600 font-extrabold text-xl'>•</span></>
                        : <span className='text-warning font-extrabold text-xl pulse-opacity-soft'>•</span>}
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
          size="icon"
          className="flex-1"
          onClick={() => void handleToggleMute()}
          disabled={actionPending !== null}
          title={snapshot.localMuted ? 'Unmute' : 'Mute'}
          aria-label={snapshot.localMuted ? 'Unmute' : 'Mute'}
        >
          {actionPending === 'mute'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : snapshot.localMuted
              ? <MicOff className="h-4 w-4" />
              : <Mic className="h-4 w-4" />}
        </Button>
        <Button
          variant="destructive"
          size="icon"
          className="flex-1"
          onClick={() => void handleLeave()}
          disabled={actionPending !== null}
          title="Leave"
          aria-label="Leave"
        >
          {actionPending === 'leave'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <PhoneOff className="h-4 w-4" />}
        </Button>
      </div>
      <GroupCallParticipantModal
        chatId={snapshot.chatId}
        connected={selectedPeerId ? (selectedPeerId === snapshot.localPeerId || connectedPeerIds.has(selectedPeerId)) : false}
        disconnectSecondsRemaining={selectedPeerId ? disconnectSecondsRemaining(selectedPeerId) : null}
        displayName={selectedPeerId ? resolvePeerName(selectedPeerId) : ''}
        groupName={groupChat?.name || 'Group chat'}
        localPeerId={snapshot.localPeerId}
        open={selectedPeerId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPeerId(null);
          }
        }}
        participant={selectedParticipant}
        writerPeerId={snapshot.writerPeerId}
      />
    </div>
  );
};
