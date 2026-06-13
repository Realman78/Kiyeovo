import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { WifiOff, X } from 'lucide-react';
import type { RootState } from '../state/store';

// Purely informational and non-blocking: the local DB stays fully readable
export const OfflineBanner = () => {
  const isOnline = useSelector((state: RootState) => state.user.networkOnline);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isOnline) {
      setDismissed(false);
    }
  }, [isOnline]);

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
