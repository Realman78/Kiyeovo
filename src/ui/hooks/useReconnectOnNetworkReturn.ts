import { useEffect, useRef } from 'react';

// When OS-level connectivity returns (offline -> online), ask the core to
// reconnect to the DHT immediately instead of waiting up to 30s for the periodic
// health timer to notice the stale connections. The core's requestImmediateReconnect
// is internally guarded (cooldown + in-progress checks), so this safely no-ops if a
// reconnect — e.g. the 30s timer's, or the powerMonitor wake handler's — is already
// running. Fires only on a real transition, never on the initial mount.
export function useReconnectOnNetworkReturn(isOnline: boolean): void {
  const wasOnline = useRef(isOnline);

  useEffect(() => {
    if (!wasOnline.current && isOnline) {
      void window.kiyeovoAPI.notifyNetworkReconnected().catch(() => {
        // Best-effort: the 30s DHT health timer remains the backstop.
      });
    }
    wasOnline.current = isOnline;
  }, [isOnline]);
}
