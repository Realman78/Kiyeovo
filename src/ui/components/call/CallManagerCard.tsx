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
  ScreenShare,
  ScreenShareOff,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppSelector } from '../../state/hooks';
import { callService } from '../../lib/call/callService';
import { useCallCardAnchor, type CallCardAnchor } from './useCallCardAnchor';
import { SCREEN_SHARE_UNSUPPORTED_MESSAGE } from '../../constants';

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

const FULLSCREEN_IDLE_HIDE_DELAY_MS = 4000;

export const CallManagerCard = () => {
  const { toast } = useToast();
  const activeCall = useAppSelector((state) => state.call.activeCall);
  const incomingCall = useAppSelector((state) => state.call.incomingCall);
  const camera = useAppSelector((state) => state.call.camera);
  const screenShare = useAppSelector((state) => state.call.screenShare);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isDraggingAnchor, setIsDraggingAnchor] = useState(false);
  const [isCallCardHovered, setIsCallCardHovered] = useState(false);
  const [isVideoExpanded, setIsVideoExpanded] = useState(false);
  const [isFullscreenControlsVisible, setIsFullscreenControlsVisible] = useState(true);
  const [isVideoStreamsSwapped, setIsVideoStreamsSwapped] = useState(false);
  const [localVideoStream, setLocalVideoStream] = useState<MediaStream | null>(null);
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null);
  const [mediaTick, setMediaTick] = useState(0);
  const largeVideoRef = useRef<HTMLVideoElement | null>(null);
  const smallVideoRef = useRef<HTMLVideoElement | null>(null);
  const previousAnchorRef = useRef<CallCardAnchor | null>(null);
  const fullscreenIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { anchor, setAnchor, positionClassName, snapToClosestCorner } = useCallCardAnchor();

  const clearFullscreenIdleTimer = () => {
    if (!fullscreenIdleTimerRef.current) return;
    clearTimeout(fullscreenIdleTimerRef.current);
    fullscreenIdleTimerRef.current = null;
  };

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
  }, [activeCall?.callId]);

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

  const isCameraForActiveCall = !!activeCall
    && camera.callId === activeCall.callId
    && camera.peerId === activeCall.peerId;
  const localCameraState = isCameraForActiveCall ? camera.localState : 'off';
  const isLocalCameraStarting = localCameraState === 'starting';
  const isLocalCameraOn = localCameraState === 'on';
  const isLocalCameraStopping = localCameraState === 'stopping';
  const hasLocalCameraVisual = localCameraState !== 'off';
  const isRemoteCameraEnabled = isCameraForActiveCall && camera.remoteEnabled;

  const isScreenShareForActiveCall = !!activeCall
    && screenShare.callId === activeCall.callId
    && screenShare.peerId === activeCall.peerId;
  const localScreenShareState = isScreenShareForActiveCall ? screenShare.localState : 'idle';
  const isLocalScreenShareStarting = localScreenShareState === 'starting';
  const isLocalScreenSharing = localScreenShareState === 'sharing';
  const isLocalScreenShareStopping = localScreenShareState === 'stopping';
  const isRemoteScreenSharing = isScreenShareForActiveCall && screenShare.remoteSharing;

  const isVisualCall = hasLocalCameraVisual || isRemoteCameraEnabled || isLocalScreenSharing || isRemoteScreenSharing;
  const canSwapVideos = !isLocalScreenSharing && !isRemoteScreenSharing && hasLocalCameraVisual && isRemoteCameraEnabled;
  const hasSecondaryVisualTile = (isLocalScreenSharing && isRemoteCameraEnabled)
    || (isRemoteScreenSharing && hasLocalCameraVisual)
    || canSwapVideos;

  const largeVideoStream = isLocalScreenSharing
    ? localVideoStream
    : isRemoteScreenSharing
      ? remoteVideoStream
      : canSwapVideos
        ? (isVideoStreamsSwapped ? localVideoStream : remoteVideoStream)
        : isRemoteCameraEnabled
          ? remoteVideoStream
          : hasLocalCameraVisual
            ? localVideoStream
            : null;

  const smallVideoStream = isLocalScreenSharing
    ? (isRemoteCameraEnabled ? remoteVideoStream : null)
    : isRemoteScreenSharing
      ? (hasLocalCameraVisual ? localVideoStream : null)
      : canSwapVideos
        ? (isVideoStreamsSwapped ? remoteVideoStream : localVideoStream)
        : null;

  const isLargeLocal = isLocalScreenSharing
    || (!isRemoteScreenSharing && !isRemoteCameraEnabled && hasLocalCameraVisual)
    || (canSwapVideos && isVideoStreamsSwapped);
  const isSmallLocal = (isRemoteScreenSharing && hasLocalCameraVisual)
    || (canSwapVideos && !isVideoStreamsSwapped);

  const largeLabel = isLocalScreenSharing
    ? 'Your screen'
    : isRemoteScreenSharing
      ? `${activeCall?.peerName}'s screen`
      : isLargeLocal
        ? 'You'
        : activeCall?.peerName ?? 'Remote';
  const smallLabel = isLocalScreenSharing
    ? activeCall?.peerName ?? 'Remote'
    : isRemoteScreenSharing
      ? 'You'
      : isSmallLocal
        ? 'You'
        : activeCall?.peerName ?? 'Remote';

  const shouldPinFullscreenControls = isDraggingAnchor
    || isCallCardHovered
    || isLocalCameraStarting
    || isLocalCameraStopping
    || isLocalScreenShareStarting
    || isLocalScreenShareStopping;
  const shouldFadeCallCard = isVideoExpanded
    && !isFullscreenControlsVisible
    && !shouldPinFullscreenControls;

  useEffect(() => {
    if (!isVideoExpanded) {
      clearFullscreenIdleTimer();
      setIsFullscreenControlsVisible(true);
      return undefined;
    }

    const scheduleHide = () => {
      clearFullscreenIdleTimer();
      if (shouldPinFullscreenControls) return;
      fullscreenIdleTimerRef.current = setTimeout(() => {
        setIsFullscreenControlsVisible(false);
      }, FULLSCREEN_IDLE_HIDE_DELAY_MS);
    };

    const revealControls = () => {
      setIsFullscreenControlsVisible(true);
      scheduleHide();
    };

    revealControls();
    window.addEventListener('pointermove', revealControls);
    window.addEventListener('pointerdown', revealControls);
    window.addEventListener('keydown', revealControls);
    window.addEventListener('wheel', revealControls);

    return () => {
      window.removeEventListener('pointermove', revealControls);
      window.removeEventListener('pointerdown', revealControls);
      window.removeEventListener('keydown', revealControls);
      window.removeEventListener('wheel', revealControls);
      clearFullscreenIdleTimer();
    };
  }, [isVideoExpanded, shouldPinFullscreenControls]);

  useEffect(() => {
    if (!activeCall) return;
    if (!isVisualCall && isVideoExpanded) {
      setIsVideoExpanded(false);
      restoreAnchorAfterFullscreen();
    }
    if (!canSwapVideos) {
      setIsVideoStreamsSwapped(false);
    }
  }, [activeCall?.callId, canSwapVideos, isVideoExpanded, isVisualCall]);

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

  if (!activeCall) return null;
  if (activeCall.state === 'ringing_in' && incomingCall) return null;

  const showTimer = activeCall.state === 'active';
  const timerText = showTimer ? formatCallDuration(elapsedSeconds) : null;
  const largeHasVideo = Boolean(largeVideoStream && largeVideoStream.getVideoTracks().length > 0);
  const smallHasVideo = Boolean(smallVideoStream && smallVideoStream.getVideoTracks().length > 0);
  const canToggleCamera = activeCall.state === 'active'
    && !isLocalCameraStarting
    && !isLocalCameraStopping;
  const canToggleScreenShare = activeCall.state === 'active'
    && !isLocalScreenShareStarting
    && !isLocalScreenShareStopping
    && !isRemoteScreenSharing;
  const cameraButtonTitle = activeCall.state !== 'active'
    ? 'Camera is available once the call is connected'
    : isLocalCameraOn || isLocalCameraStarting
      ? 'Turn camera off'
      : 'Turn camera on';
  const screenShareTitle = isRemoteScreenSharing
    ? `${activeCall.peerName} is already sharing`
    : activeCall.state !== 'active'
      ? 'Screen sharing is available once the call is connected'
      : isLocalScreenSharing
        ? 'Stop sharing screen'
        : 'Share screen';
  const visualPlaceholderText = isLocalScreenSharing
    ? 'Screen preview unavailable'
    : isRemoteScreenSharing
      ? 'Waiting for screen share...'
      : isLocalCameraStarting
        ? 'Starting camera...'
        : isLargeLocal
          ? 'Camera unavailable'
          : 'Waiting for remote video...';
  const secondaryPlaceholderText = isSmallLocal
    ? (isLocalCameraStarting ? 'Starting camera...' : 'Camera unavailable')
    : 'Waiting for remote video...';

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

  const handleToggleCamera = async () => {
    if (!canToggleCamera) return;

    if (isLocalCameraOn) {
      const result = await callService.stopCamera();
      if (!result.success) {
        toast.error(result.error || 'Failed to stop camera');
      }
      return;
    }

    const result = await callService.startCamera();
    if (!result.success && !result.canceled) {
      const message = result.error?.toLowerCase().includes('device not found')
        ? 'Camera not found'
        : result.error;
      toast.error(message || 'Could not start camera');
    }
  };

  const handleToggleScreenShare = async () => {
    if (!canToggleScreenShare) return;

    if (isLocalScreenSharing) {
      const result = await callService.stopScreenShare('manual');
      if (!result.success) {
        toast.error(result.error || 'Failed to stop screen sharing');
      }
      return;
    }

    const result = await callService.startScreenShare();
    if (!result.success && result.unsupported) {
      toast.info(result.error || SCREEN_SHARE_UNSUPPORTED_MESSAGE);
      return;
    }

    if (!result.success && !result.canceled) {
      toast.error(result.error || 'Could not start screen sharing');
    }
  };

  const handleAnchorPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    setIsDraggingAnchor(true);
    setIsFullscreenControlsVisible(true);

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
      const draggedEnoughToCount = Math.hypot(
        upEvent.clientX - startClientX,
        upEvent.clientY - startClientY,
      ) > 4;
      if (isVideoExpanded && draggedEnoughToCount) {
        previousAnchorRef.current = null;
      }
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
      {isVisualCall && isVideoExpanded && (
        <div className="fixed inset-0 z-90 bg-black/95">
          {largeHasVideo ? (
            <video
              ref={largeVideoRef}
              autoPlay
              playsInline
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm text-white/80">
              {visualPlaceholderText}
            </div>
          )}

          <div className="absolute top-4 left-4 rounded-md bg-black/40 px-2 py-1 text-xs text-white/80">
            {largeLabel}
          </div>

          {hasSecondaryVisualTile && (
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
                  {secondaryPlaceholderText}
                </div>
              )}
              <div className="absolute top-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/80">
                {smallLabel}
              </div>
              {canSwapVideos && (
                <Button
                  variant="outline"
                  size="sm"
                  className="absolute top-1 right-1 h-6 w-6 border-white/20 bg-black/45 p-0 text-white hover:bg-black/60"
                  onClick={() => setIsVideoStreamsSwapped((prev) => !prev)}
                  title="Swap videos"
                >
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          )}

          <div className="absolute top-4 right-4 flex items-center gap-2">
            {canSwapVideos && (
              <Button
                variant="outline"
                size="sm"
                className="border-white/20 bg-black/40 text-white hover:bg-black/55"
                onClick={() => setIsVideoStreamsSwapped((prev) => !prev)}
                title="Swap videos"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </Button>
            )}
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

      <div
        // A flat w-[360px] is wider than the whole viewport on a phone once the
        // anchor's 16px inset is counted, so cap it to the space actually
        // available and only take the fixed width where there is room.
        className={`fixed ${positionClassName} z-100 ${isVisualCall ? 'w-[calc(100vw-2rem)] sm:w-[360px]' : 'w-fit max-w-[calc(100vw-2rem)]'} rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl transition-opacity duration-500 ${shouldFadeCallCard ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
        onPointerEnter={() => setIsCallCardHovered(true)}
        onPointerLeave={() => setIsCallCardHovered(false)}
      >
        <button
          type="button"
          className={`absolute top-1 left-1 z-10 h-5 w-5 cursor-move rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground ${isDraggingAnchor ? 'bg-accent/80 text-foreground' : ''}`}
          title="Drag to snap card position"
          aria-label="Drag to snap card position"
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
          </div>
        </div>

        {isVisualCall && !isVideoExpanded && (
          <div className="relative mt-3 h-52 overflow-hidden rounded-lg border border-border/70 bg-black/90 shadow-inner">
            {largeHasVideo ? (
              <video
                ref={largeVideoRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm text-white/80">
                {visualPlaceholderText}
              </div>
            )}

            <div className="absolute top-2 left-2 rounded bg-black/55 px-2 py-1 text-[10px] uppercase tracking-wide text-white/85">
              {largeLabel}
            </div>

            {hasSecondaryVisualTile && (
              <div className="absolute bottom-3 right-3 h-20 w-28 overflow-hidden rounded-md border border-white/15 bg-black/70 shadow-lg">
                {smallHasVideo ? (
                  <video
                    ref={smallVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px] text-white/70">
                    {secondaryPlaceholderText}
                  </div>
                )}
                <div className="absolute top-1 left-1 rounded bg-black/55 px-1.5 py-0.5 text-[9px] text-white/80">
                  {smallLabel}
                </div>
                {canSwapVideos && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="absolute top-1 right-1 h-5 w-5 border-white/20 bg-black/45 p-0 text-white hover:bg-black/60"
                    onClick={() => setIsVideoStreamsSwapped((prev) => !prev)}
                    title="Swap videos"
                  >
                    <ArrowLeftRight className="h-3 w-3" />
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {(isLocalCameraStarting || isLocalCameraStopping || isLocalScreenShareStarting || isLocalScreenSharing || isLocalScreenShareStopping || isRemoteScreenSharing) && (
            <div className="mr-auto inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-primary">
              {isLocalScreenShareStarting || isLocalScreenSharing || isLocalScreenShareStopping || isRemoteScreenSharing ? (
                <>
                  <ScreenShare className="h-3 w-3" />
                  {isLocalScreenShareStarting
                    ? 'Starting share'
                    : isLocalScreenShareStopping
                      ? 'Stopping share'
                      : isLocalScreenSharing
                        ? 'You are sharing'
                        : `${activeCall.peerName} is sharing`}
                </>
              ) : (
                <>
                  <Video className="h-3 w-3" />
                  {isLocalCameraStarting ? 'Starting camera' : 'Stopping camera'}
                </>
              )}
            </div>
          )}
          <Button
            variant={isLocalCameraOn ? 'destructive' : 'outline'}
            size="sm"
            onClick={handleToggleCamera}
            disabled={!canToggleCamera}
            title={cameraButtonTitle}
          >
            {isLocalCameraOn ? <VideoOff className="w-4 h-4" /> : <Video className="w-4 h-4" />}
          </Button>
          <Button
            variant={isLocalScreenSharing ? 'destructive' : 'outline'}
            size="sm"
            onClick={handleToggleScreenShare}
            disabled={!canToggleScreenShare}
            title={screenShareTitle}
          >
            {isLocalScreenSharing ? <ScreenShareOff className="w-4 h-4" /> : <ScreenShare className="w-4 h-4" />}
          </Button>
          {isVisualCall && (
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
