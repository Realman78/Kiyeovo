import { useEffect, useRef } from 'react';
import { Info, MicOff } from 'lucide-react';

type GroupCallVideoTileProps = {
  name: string;
  cameraOn: boolean;
  stream: MediaStream | null;
  connected: boolean;
  disconnectSeconds?: number | null;
  isLocal?: boolean;
  isWriter?: boolean;
  muted?: boolean;
  pinned?: boolean;
  // Pin/unpin
  onClick?: () => void;
  onInfo?: () => void;
  className?: string;
};

export const GroupCallVideoTile = ({
  name,
  cameraOn,
  stream,
  connected,
  disconnectSeconds = null,
  isLocal = false,
  isWriter = false,
  muted = false,
  pinned = false,
  onClick,
  onInfo,
  className = '',
}: GroupCallVideoTileProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hasVideo = cameraOn && Boolean(stream && stream.getVideoTracks().length > 0);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const next = hasVideo ? stream : null;
    if (video.srcObject !== next) {
      video.srcObject = next;
    }
    // Always mute the <video> element: audio playback is handled separately
    video.muted = true;
    if (hasVideo) {
      void video.play().catch(() => {
        // Autoplay may be deferred until a user gesture.
      });
    }
  }, [stream, hasVideo]);

  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      onClick={onClick}
      className={`group relative flex items-center justify-center overflow-hidden rounded-lg border bg-secondary/30 ${pinned ? 'border-primary' : 'border-border/70'} ${onClick ? 'cursor-pointer hover:border-primary/70' : ''} ${!connected ? 'opacity-60' : ''} ${className}`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${isLocal ? 'scale-x-[-1]' : ''}`}
        />
      ) : (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/20 text-lg font-semibold text-primary">
          {initial}
        </div>
      )}

      {onInfo && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onInfo();
          }}
          className="absolute right-1 top-1 hidden rounded bg-black/50 p-1 text-white/80 transition hover:text-white group-hover:block"
          title={`Show info for ${name}`}
          aria-label={`Show info for ${name}`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 py-1">
        <span className="truncate text-[11px] font-medium text-white">
          {isWriter ? '🎮 ' : ''}{name}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {muted && <MicOff className="h-3 w-3 text-white/80" />}
          {disconnectSeconds != null
            ? <span className="text-[10px] font-semibold text-warning">{disconnectSeconds}s</span>
            : !connected && <span className="text-sm font-extrabold text-warning">•</span>}
        </span>
      </div>
    </div>
  );
};

// The "+N" tile shown when more participants exist than the slot-limited view
// can display. Sizing (aspect/width/height) is supplied by the caller.
export const OverflowTile = ({ count, className = '' }: { count: number; className?: string }) => (
  <div className={`flex items-center justify-center rounded-lg border border-border/70 bg-secondary/30 text-sm font-semibold text-muted-foreground ${className}`}>
    +{count}
  </div>
);
