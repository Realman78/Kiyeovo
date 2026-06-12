import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { GripVertical, Loader2, Maximize2, Mic, MicOff, Minimize2, PhoneOff, Users, Video, VideoOff } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { groupCallService, type GroupCallSnapshot, type GroupParticipantMedia } from '../../lib/call/groupCallService';
import { GroupCallParticipantModal } from './GroupCallParticipantModal';
import { GroupCallVideoTile, OverflowTile } from './GroupCallVideoTile';
import { useCallCardAnchor } from './useCallCardAnchor';

const MAX_DISCONNECT_COUNTDOWN_SECONDS = 30;
// Above this many simultaneous cameras the mesh starts to degrade; we warn 
const QUALITY_WARNING_CAMERA_COUNT = 5;
// Tiles shown before collapsing the remainder into a "+N" overflow tile.
const COMPACT_TILE_LIMIT = 4;
const PINNED_STRIP_TILE_LIMIT = 5;

type CallTile = {
  peerId: string;
  name: string;
  isLocal: boolean;
  isWriter: boolean;
  connected: boolean;
  disconnectSeconds: number | null;
  cameraOn: boolean;
  muted: boolean;
  stream: MediaStream | null;
};

// Choose which tiles fill a slot-limited view. Camera-on tiles are preferred so
// "video mode" always surfaces actual video, but the chosen tiles are displayed
// in stable roster order — the visible set only shifts when a camera is toggled,
// never on who is speaking. When over the limit, the last slot is a "+N" tile,
// so `slots = limit - 1` are shown.
const selectVisibleTiles = (all: CallTile[], limit: number): { visible: CallTile[]; overflow: number } => {
  if (all.length <= limit) {
    return { visible: all, overflow: 0 };
  }
  const slots = limit - 1;
  const prioritized = [...all].sort((a, b) => Number(b.cameraOn) - Number(a.cameraOn));
  const chosenIds = new Set(prioritized.slice(0, slots).map((tile) => tile.peerId));
  const visible = all.filter((tile) => chosenIds.has(tile.peerId));
  return { visible, overflow: all.length - visible.length };
};

export const GroupCallManagerCard = () => {
  const { toast } = useToast();
  const chats = useAppSelector((state) => state.chat.chats);
  const userPeerId = useAppSelector((state) => state.user.peerId);
  const [snapshot, setSnapshot] = useState<GroupCallSnapshot>(() => groupCallService.getSnapshot());
  const [participantMedia, setParticipantMedia] = useState<GroupParticipantMedia[]>(() => groupCallService.getParticipantMedia());
  const [localCameraStream, setLocalCameraStream] = useState<MediaStream | null>(() => groupCallService.getLocalCameraStream());
  const [actionPending, setActionPending] = useState<'mute' | 'leave' | 'camera' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [isDraggingAnchor, setIsDraggingAnchor] = useState(false);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pinnedPeerId, setPinnedPeerId] = useState<string | null>(null);
  const { positionClassName, snapToClosestCorner } = useCallCardAnchor();

  useEffect(() => {
    return groupCallService.subscribe((event) => {
      if (event.type === 'state') {
        setSnapshot(event.snapshot);
      } else if (event.type === 'media') {
        setParticipantMedia(groupCallService.getParticipantMedia());
        setLocalCameraStream(groupCallService.getLocalCameraStream());
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
  const streamByPeerId = useMemo(
    () => new Map(participantMedia.map((media) => [media.peerId, media.stream])),
    [participantMedia],
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

  const localCameraOn = snapshot.localCameraState === 'on';
  const cameraBusy = snapshot.localCameraState === 'starting'
    || snapshot.localCameraState === 'stopping'
    || actionPending === 'camera';

  const isLocalPeer = (peerId: string): boolean => (
    peerId === snapshot.localPeerId || peerId === userPeerId
  );

  // Tiles in stable roster order. Camera-off participants render as avatar tiles;
  // the local "You" preview counts as a slot
  const tiles: CallTile[] = participantPeerIds.map((peerId) => {
    const local = isLocalPeer(peerId);
    return {
      peerId,
      name: resolvePeerName(peerId),
      isLocal: local,
      isWriter: peerId === snapshot.writerPeerId,
      connected: local || connectedPeerIds.has(peerId),
      disconnectSeconds: local ? null : disconnectSecondsRemaining(peerId),
      cameraOn: local ? localCameraOn : Boolean(snapshot.participantCameraOn[peerId]),
      muted: local && snapshot.localMuted,
      stream: local ? localCameraStream : streamByPeerId.get(peerId) ?? null,
    };
  });

  const hasAnyVideo = tiles.some((tile) => tile.cameraOn);
  const activeCameraCount = tiles.filter((tile) => tile.cameraOn).length;
  const showQualityWarning = activeCameraCount > QUALITY_WARNING_CAMERA_COUNT;

  // Leave fullscreen automatically when there is no longer any video to show.
  useEffect(() => {
    if (!hasAnyVideo && isFullscreen) {
      setIsFullscreen(false);
      setPinnedPeerId(null);
    }
  }, [hasAnyVideo, isFullscreen]);

  // Drop a pin that points at a participant who is no longer present.
  useEffect(() => {
    if (pinnedPeerId && !participantPeerIds.includes(pinnedPeerId)) {
      setPinnedPeerId(null);
    }
  }, [participantPeerIds, pinnedPeerId]);

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

  const handleToggleCamera = async () => {
    if (cameraBusy) {
      return;
    }
    setActionPending('camera');
    const result = localCameraOn
      ? await groupCallService.stopCamera()
      : await groupCallService.startCamera();
    setActionPending(null);
    if (!result.success) {
      toast.error(result.error || 'Failed to update camera');
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

  const handleTilePin = (peerId: string) => {
    setPinnedPeerId((current) => (current === peerId ? null : peerId));
  };

  // Participant info stays reachable in video mode via a per-tile info button.
  // Local "You" has no info to show.
  const infoHandlerFor = (tile: CallTile): (() => void) | undefined => (
    tile.isLocal ? undefined : () => setSelectedPeerId(tile.peerId)
  );

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

  const memberCount = snapshot.connectedPeerIds.length + 1;
  const groupName = groupChat?.name || 'Group chat';

  const cameraButton = (
    <Button
      variant={localCameraOn ? 'destructive' : 'secondary'}
      size="icon"
      className="flex-1"
      onClick={() => void handleToggleCamera()}
      disabled={actionPending === 'mute' || actionPending === 'leave' || cameraBusy}
      title={localCameraOn ? 'Turn camera off' : 'Turn camera on'}
      aria-label={localCameraOn ? 'Turn camera off' : 'Turn camera on'}
    >
      {cameraBusy
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : localCameraOn
          ? <VideoOff className="h-4 w-4" />
          : <Video className="h-4 w-4" />}
    </Button>
  );

  const muteButton = (
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
  );

  const leaveButton = (
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
  );

  const qualityWarning = showQualityWarning ? (
    <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
      {activeCameraCount} cameras are on — call quality may become unstable. Turning some cameras off will help.
    </div>
  ) : null;

  // Rendered in both the compact and fullscreen branches so participant info
  // stays reachable regardless of view.
  const participantModal = (
    <GroupCallParticipantModal
      chatId={snapshot.chatId}
      connected={selectedPeerId ? (selectedPeerId === snapshot.localPeerId || connectedPeerIds.has(selectedPeerId)) : false}
      disconnectSecondsRemaining={selectedPeerId ? disconnectSecondsRemaining(selectedPeerId) : null}
      displayName={selectedPeerId ? resolvePeerName(selectedPeerId) : ''}
      groupName={groupName}
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
  );

  // ----- Fullscreen -----
  if (isFullscreen && hasAnyVideo) {
    const pinnedTile = pinnedPeerId
      ? tiles.find((tile) => tile.peerId === pinnedPeerId) ?? null
      : null;

    let body: ReactElement;
    if (pinnedTile) {
      const others = tiles.filter((tile) => tile.peerId !== pinnedTile.peerId);
      const { visible: stripVisible, overflow: stripOverflow } = selectVisibleTiles(others, PINNED_STRIP_TILE_LIMIT);
      body = (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          <div className="min-h-0 flex-1">
            <GroupCallVideoTile
              {...pinnedTile}
              pinned
              onClick={() => handleTilePin(pinnedTile.peerId)}
              onInfo={infoHandlerFor(pinnedTile)}
              className="h-full w-full"
            />
          </div>
          <div className="flex h-28 shrink-0 gap-2">
            {stripVisible.map((tile) => (
              <GroupCallVideoTile
                key={tile.peerId}
                {...tile}
                onClick={() => handleTilePin(tile.peerId)}
                onInfo={infoHandlerFor(tile)}
                className="aspect-video h-full"
              />
            ))}
            {stripOverflow > 0 && <OverflowTile count={stripOverflow} className="aspect-video h-full" />}
          </div>
        </div>
      );
    } else {
      const columns = Math.max(1, Math.ceil(Math.sqrt(tiles.length)));
      body = (
        <div
          className="grid min-h-0 flex-1 content-center gap-2 overflow-auto p-2"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {tiles.map((tile) => (
            <GroupCallVideoTile
              key={tile.peerId}
              {...tile}
              onClick={() => handleTilePin(tile.peerId)}
              onInfo={infoHandlerFor(tile)}
              className="aspect-video w-full"
            />
          ))}
        </div>
      );
    }

    return (
      <div className="fixed inset-0 z-200 flex flex-col bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium tracking-wide text-primary">
            <Users className="h-4 w-4" />
            {groupName}
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-md border border-border px-2 py-1 text-xs font-mono text-muted-foreground">
              {memberCount} members
            </div>
            <Button
              variant="secondary"
              size="icon"
              onClick={() => setIsFullscreen(false)}
              title="Exit fullscreen"
              aria-label="Exit fullscreen"
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {body}

        <div className="border-t border-border/70 px-4 py-3">
          {qualityWarning}
          <div className="mx-auto flex max-w-sm gap-2">
            {muteButton}
            {cameraButton}
            {leaveButton}
          </div>
        </div>
        {participantModal}
      </div>
    );
  }

  // ----- Compact -----
  const { visible: compactVisibleTiles, overflow: compactOverflow } = selectVisibleTiles(tiles, COMPACT_TILE_LIMIT);

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
            {groupName}
          </div>
        </div>
        <div className="rounded-md border border-border px-2 py-1 text-xs font-mono text-muted-foreground">
          {memberCount} members
        </div>
      </div>

      {hasAnyVideo ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          {compactVisibleTiles.map((tile) => (
            <GroupCallVideoTile
              key={tile.peerId}
              {...tile}
              onInfo={infoHandlerFor(tile)}
              className="aspect-video w-full"
            />
          ))}
          {compactOverflow > 0 && <OverflowTile count={compactOverflow} className="aspect-video w-full" />}
        </div>
      ) : (
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
      )}

      {snapshot.recoveryFailed && snapshot.state === 'waiting' && (
        <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          Reconnecting failed. Leave and rejoin if the call does not recover.
        </div>
      )}

      {qualityWarning}

      <div className="mt-4 flex gap-2">
        {muteButton}
        {cameraButton}
        {hasAnyVideo && (
          <Button
            variant="secondary"
            size="icon"
            className="flex-1"
            onClick={() => setIsFullscreen(true)}
            disabled={actionPending !== null}
            title="Fullscreen"
            aria-label="Fullscreen"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        )}
        {leaveButton}
      </div>
      {participantModal}
    </div>
  );
};
