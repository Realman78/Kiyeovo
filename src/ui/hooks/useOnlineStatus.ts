import { useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 5000;

// Tracks OS-level network connectivity
export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const { connected } = await window.kiyeovoAPI.isNetworkConnected();
        if (!cancelled) {
          setIsOnline(connected);
        }
      } catch {
        // If the check itself fails, assume online to avoid a false offline banner.
        if (!cancelled) {
          setIsOnline(true);
        }
      }
    };

    void check();
    const timer = setInterval(() => { void check(); }, POLL_INTERVAL_MS);

    const onHint = () => { void check(); };
    window.addEventListener('online', onHint);
    window.addEventListener('offline', onHint);
    window.addEventListener('focus', onHint);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('online', onHint);
      window.removeEventListener('offline', onHint);
      window.removeEventListener('focus', onHint);
    };
  }, []);

  return isOnline;
}
