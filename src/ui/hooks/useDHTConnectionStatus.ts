import { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { setConnected } from '../state/slices/userSlice';

// Owns DHT connectivity freshness globally.
export function useDHTConnectionStatus(): void {
  const dispatch = useDispatch();

  useEffect(() => {
    let isDisposed = false;

    void window.kiyeovoAPI.getDHTConnectionStatus().then((result) => {
      if (isDisposed || !result.success) return;
      dispatch(setConnected(result.connected));
    }).catch((error) => {
      console.error('[DHT-STATUS][UI][SNAPSHOT] failed:', error);
    });

    const unsubStatus = window.kiyeovoAPI.onDHTConnectionStatus((status) => {
      dispatch(setConnected(status.connected));
    });

    return () => {
      isDisposed = true;
      unsubStatus();
    };
  }, [dispatch]);
}
