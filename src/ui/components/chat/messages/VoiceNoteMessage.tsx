import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '../../ui/Button';

interface InlineVoiceNoteMessageProps {
  fileId: string;
  initialMediaToken?: string;
  fallback: ReactNode;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Mirrors InlineImageMessage in FileMessage.tsx: mints (or reuses a sender-side) capability
// token for the completed audio file and streams it through the same content-type-gated
// kiyeovo-media:// protocol used for images, then drives a small custom play/seek UI off the
// underlying <audio> element's events.
export const InlineVoiceNoteMessage: React.FC<InlineVoiceNoteMessageProps> = ({
  fileId,
  initialMediaToken,
  fallback,
}) => {
  const [mediaToken, setMediaToken] = useState<string | null>(initialMediaToken ?? null);
  const [failed, setFailed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (initialMediaToken) return;

    let cancelled = false;

    void window.kiyeovoAPI.registerVoiceNoteMedia(fileId)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.token) {
          setMediaToken(result.token);
          return;
        }
        setFailed(true);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to register voice note media:', error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [fileId, initialMediaToken]);

  if (!mediaToken || failed) {
    return <>{fallback}</>;
  }

  const mediaUrl = `kiyeovo-media://media/${encodeURIComponent(mediaToken)}`;

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setFailed(true));
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio || !durationMs) return;
    const fraction = Number(event.target.value) / 1000;
    audio.currentTime = fraction * (durationMs / 1000);
    setCurrentTimeMs(audio.currentTime * 1000);
  };

  const progressPermille = durationMs
    ? Math.min(1000, Math.round((currentTimeMs / durationMs) * 1000))
    : 0;

  return (
    <div className="flex w-[260px] max-w-[65vw] items-center gap-2 rounded-lg bg-background/20 p-2">
      <audio
        ref={audioRef}
        src={mediaUrl}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const audioDuration = event.currentTarget.duration;
          if (Number.isFinite(audioDuration) && audioDuration > 0) {
            setDurationMs(audioDuration * 1000);
          }
        }}
        onTimeUpdate={(event) => setCurrentTimeMs(event.currentTarget.currentTime * 1000)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTimeMs(0);
        }}
        onError={() => setFailed(true)}
      />
      <Button
        type="button"
        onClick={togglePlay}
        variant="outline"
        size="icon"
        className="shrink-0"
        aria-label={isPlaying ? 'Pause voice message' : 'Play voice message'}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="range"
          min={0}
          max={1000}
          value={progressPermille}
          onChange={handleSeek}
          className="h-1 w-full cursor-pointer accent-primary"
          aria-label="Seek voice message"
        />
        <span className="text-xs opacity-70">
          {formatDuration(currentTimeMs)} / {durationMs ? formatDuration(durationMs) : '--:--'}
        </span>
      </div>
    </div>
  );
};
