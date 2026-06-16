import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { RefreshCw, WifiOff, X } from 'lucide-react';
import type { RootState } from '../state/store';

type OfflineBannerProps = {
  wakeRecovery?: { deadlineAt: number } | null;
};

// Purely informational and non-blocking: the local DB stays fully readable
export const OfflineBanner = ({ wakeRecovery = null }: OfflineBannerProps) => {
  const isOnline = useSelector((state: RootState) => state.user.networkOnline);
  const [dismissed, setDismissed] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (isOnline) {
      setDismissed(false);
    }
  }, [isOnline]);

  useEffect(() => {
    if (!wakeRecovery) {
      setSecondsLeft(0);
      return;
    }
    const update = () => {
      setSecondsLeft(Math.max(0, Math.ceil((wakeRecovery.deadlineAt - Date.now()) / 1000)));
    };
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [wakeRecovery]);

  if (wakeRecovery) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-x-0 top-0 z-100 flex items-center justify-center gap-2 bg-warning px-4 py-1.5 text-center text-xs font-medium text-warning-foreground shadow-md"
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span>Waking up... give me {secondsLeft} more seconds</span>
        <span className="shrink-0 tabular-nums">{secondsLeft}s</span>
      </div>
    );
  }

  if (isOnline || dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-100 flex items-center justify-center gap-2 bg-warning px-4 py-1.5 text-center text-xs font-medium text-warning-foreground shadow-md"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>No internet connection — you can still read past messages. We&apos;ll reconnect automatically.</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-2 shrink-0 rounded p-0.5 transition-colors hover:bg-black/10"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
