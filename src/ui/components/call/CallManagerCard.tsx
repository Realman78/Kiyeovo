import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowLeftRight,
  Fullscreen,
  GripVertical,
  Mic,
  MicOff,
  Minimize2,
  PhoneCall,
  PhoneOff,
  Video,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { callService } from '../../lib/call/callService';
import { useCallCardAnchor, type CallCardAnchor } from './useCallCardAnchor';

function stateLabel(state: string): string {
  switch (state) {
    case 'ringing_out':
      return 'Ringing...';
    case 'ringing_in':
      return 'Incoming call';
    case 'connecting':
      return 'Connecting...';
    case 'active':
      return 'In call';
    default:
      return state;
  }
}

function formatCallDuration(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const CallManagerCard = () => {
  const { toast } = useToast();
  const activeCall = useAppSelector((state) => state.call.activeCall);
  const incomingCall = useAppSelector((state) => state.call.incomingCall);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isDraggingAnchor, setIsDraggingAnchor] = useState(false);
  const [isVideoExpanded, setIsVideoExpanded] = useState(false);
  const [isVideoStreamsSwapped, setIsVideoStreamsSwapped] = useState(false);
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const [mediaTick, setMediaTick] = useState(0);
  const largeVideoRef = useRef<HTMLVideoElement | null>(null);
  const smallVideoRef = useRef<HTMLVideoElement | null>(null);
  const compactRemotePreviewRef = useRef<HTMLVideoElement | null>(null);
  const previousAnchorRef = useRef<CallCardAnchor | null>(null);
  const { anchor, setAnchor, positionClassName, snapToClosestCorner } = useCallCardAnchor();

  const restoreAnchorAfterFullscreen = () => {
    if (!previousAnchorRef.current) return;
    setAnchor(previousAnchorRef.current);
    previousAnchorRef.current = null;
  };

  const enterVideoFullscreen = () => {
    if (isVideoExpanded) return;
    previousAnchorRef.current = anchor;
    setAnchor('bottom-left');
    setIsVideoExpanded(true);
  };

  const exitVideoFullscreen = () => {
    if (!isVideoExpanded) return;
    setIsVideoExpanded(false);
    restoreAnchorAfterFullscreen();
  };

  useEffect(() => {
    if (!activeCall) {
      if (isVideoExpanded) {
        setIsVideoExpanded(false);
        restoreAnchorAfterFullscreen();
      }
      setIsVideoStreamsSwapped(false);
      setLocalVideoStream(null);
      setRemoteVideoStream(null);
      setMediaTick(0);
      return;
    }

    const audioState = callService.getAudioControlState();
    setIsMuted(audioState.muted);
    setIsDeafened(audioState.deafened);

    const media = callService.getMediaStreams();
    setLocalVideoStream(media.localStream);
    setRemoteVideoStream(media.remoteStream);

    if (activeCall.mediaType !== 'video') {
      if (isVideoExpanded) {
        setIsVideoExpanded(false);
        restoreAnchorAfterFullscreen();
      }
      setIsVideoStreamsSwapped(false);
    }
  }, [activeCall?.callId, activeCall?.mediaType]);

  useEffect(() => {
    if (!activeCall) {
      setElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.floor((Date.now() - activeCall.startedAt) / 1000));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [activeCall?.callId, activeCall?.startedAt]);

  useEffect(() => {
    const unsubscribe = callService.subscribe((event) => {
      if (event.type !== 'media') return;
      if (!activeCall) return;
      if (event.callId !== activeCall.callId || event.peerId !== activeCall.peerId) return;
      setLocalVideoStream(event.localStream);
      setRemoteVideoStream(event.remoteStream);
      setMediaTick((value) => value + 1);
    });
    return unsubscribe;
  }, [activeCall?.callId, activeCall?.peerId]);

  const isVideoCall = activeCall?.mediaType === 'video';
  const largeVideoStream = isVideoCall
    ? (isVideoStreamsSwapped ? localVideoStream : remoteVideoStream)
    : null;
  const smallVideoStream = isVideoCall
    ? (isVideoStreamsSwapped ? remoteVideoStream : localVideoStream)
    : null;
  const isLargeLocal = isVideoStreamsSwapped;
  const isSmallLocal = !isVideoStreamsSwapped;

  useEffect(() => {
    const largeVideo = largeVideoRef.current;
    if (!largeVideo) return;

    if (largeVideo.srcObject !== largeVideoStream) {
      largeVideo.srcObject = largeVideoStream;
    }

    largeVideo.muted = true;
    if (largeVideoStream) {
      void largeVideo.play().catch(() => {
        // Playback can fail before user gesture.
      });
    }
  }, [largeVideoStream, isVideoExpanded, mediaTick]);

  useEffect(() => {
    const smallVideo = smallVideoRef.current;
    if (!smallVideo) return;

    if (smallVideo.srcObject !== smallVideoStream) {
      smallVideo.srcObject = smallVideoStream;
    }

    smallVideo.muted = true;
    if (smallVideoStream) {
      void smallVideo.play().catch(() => {
        // Playback can fail before user gesture.
      });
    }
  }, [smallVideoStream, isVideoExpanded, mediaTick]);

  useEffect(() => {
    const compactPreview = compactRemotePreviewRef.current;
    if (!compactPreview) return;

    if (compactPreview.srcObject !== remoteVideoStream) {
      compactPreview.srcObject = remoteVideoStream;
    }

    compactPreview.muted = true;
    if (remoteVideoStream) {
      void compactPreview.play().catch(() => {
        // Playback can fail before user gesture.
      });
    }
  }, [remoteVideoStream, isVideoCall, mediaTick, activeCall?.state, isVideoExpanded]);

  if (!activeCall) return null;
  if (activeCall.state === 'ringing_in' && incomingCall) return null;

  const showTimer = activeCall.state === 'active';
  const timerText = showTimer ? formatCallDuration(elapsedSeconds) : null;
  const largeHasVideo = Boolean(largeVideoStream && largeVideoStream.getVideoTracks().length > 0);
  const smallHasVideo = Boolean(smallVideoStream && smallVideoStream.getVideoTracks().length > 0);
  const remotePreviewHasVideo = Boolean(remoteVideoStream && remoteVideoStream.getVideoTracks().length > 0);
  const showCompactPreview = isVideoCall && activeCall.state === 'active' && !isVideoExpanded;

  const handleHangup = async () => {
    if (isVideoExpanded) {
      setIsVideoExpanded(false);
      restoreAnchorAfterFullscreen();
    }

    const result = await callService.hangupCall(activeCall.peerId, activeCall.callId, 'hangup');
    if (!result.success) {
      toast.error(result.error || 'Failed to hang up');
    }
  };

  const handleToggleMute = () => {
    setIsMuted(callService.toggleMute());
  };

  const handleToggleDeafen = () => {
    setIsDeafened(callService.toggleDeafen());
  };

  const handleAnchorPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isVideoExpanded) return;
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    setIsDraggingAnchor(true);

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // no-op: pointer capture can fail on some environments, snap still works via window listener
    }

    const cleanup = () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // no-op: if capture was never set, release can throw
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
    <>
      {isVideoCall && isVideoExpanded && (
        <div className="fixed inset-0 z-108 bg-black/95">
          {largeHasVideo ? (
            <video
              ref={largeVideoRef}
              autoPlay
              playsInline
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-white/80">
              {isLargeLocal ? 'Camera unavailable' : 'Waiting for remote video...'}
            </div>
          )}

          <div className="absolute top-4 left-4 rounded-md bg-black/40 px-2 py-1 text-xs text-white/80">
            {isLargeLocal ? 'You' : activeCall.peerName}
          </div>

          <div className="absolute bottom-4 right-4 h-32 w-48 overflow-hidden rounded-lg border border-white/20 bg-black/70 shadow-xl">
            {smallHasVideo ? (
              <video
                ref={smallVideoRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-white/70">
                {isSmallLocal ? 'Camera unavailable' : 'No remote video'}
              </div>
            )}
            <div className="absolute top-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/80">
              {isSmallLocal ? 'You' : activeCall.peerName}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="absolute top-1 right-1 h-6 w-6 border-white/20 bg-black/45 p-0 text-white hover:bg-black/60"
              onClick={() => setIsVideoStreamsSwapped((prev) => !prev)}
              title="Swap videos"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="absolute top-4 right-4 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-white/20 bg-black/40 text-white hover:bg-black/55"
              onClick={() => setIsVideoStreamsSwapped((prev) => !prev)}
              title="Swap videos"
            >
              <ArrowLeftRight className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-white/20 bg-black/40 text-white hover:bg-black/55"
              onClick={exitVideoFullscreen}
              title="Exit fullscreen"
            >
              <Minimize2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <div className={`fixed ${positionClassName} z-109 w-fit rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl`}>
        <button
          type="button"
          className={`absolute top-1 left-1 z-10 h-5 w-5 rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground ${isVideoExpanded ? 'cursor-not-allowed opacity-50' : 'cursor-move'} ${isDraggingAnchor ? 'bg-accent/80 text-foreground' : ''}`}
          title={isVideoExpanded ? 'Card position locked while fullscreen' : 'Drag to snap card position'}
          aria-label={isVideoExpanded ? 'Card position locked while fullscreen' : 'Drag to snap card position'}
          onPointerDown={handleAnchorPointerDown}
        >
          <GripVertical className="mx-auto h-3.5 w-3.5" />
        </button>

        <div className="flex items-start justify-between gap-3 pr-1">
          <div className="flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-primary" />
            <div className="text-sm font-semibold text-foreground">
              {activeCall.state === 'active'
                ? `${activeCall.peerName}${timerText ? ` • ${timerText}` : ''}`
                : stateLabel(activeCall.state)}
            </div>
            {isVideoCall && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                <Video className="h-3 w-3" />
                Video
              </span>
            )}
          </div>

          {showCompactPreview && (
            <div className="relative h-16 w-24 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/30">
              {remotePreviewHasVideo ? (
                <video
                  ref={compactRemotePreviewRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
                  No remote video
                </div>
              )}
              <div className="absolute bottom-1 left-1 rounded bg-black/55 px-1 py-0.5 text-[9px] text-white/85">
                {activeCall.peerName}
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {isVideoCall && (
            <Button
              variant="outline"
              size="sm"
              onClick={isVideoExpanded ? exitVideoFullscreen : enterVideoFullscreen}
              title={isVideoExpanded ? 'Exit fullscreen' : 'Fullscreen video'}
            >
              {isVideoExpanded ? <Minimize2 className="w-4 h-4" /> : <Fullscreen className="w-4 h-4" />}
            </Button>
          )}
          <Button variant={isMuted ? 'secondary' : 'outline'} size="sm" onClick={handleToggleMute}>
            {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
          </Button>
          <Button variant={isDeafened ? 'secondary' : 'outline'} size="sm" onClick={handleToggleDeafen}>
            {isDeafened ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </Button>
          <Button variant="destructive" size="sm" onClick={handleHangup}>
            <PhoneOff className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </>
  );
};
