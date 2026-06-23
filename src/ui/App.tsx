import { useState, useEffect } from 'react'
import './App.css'
import { Login } from './pages/Login';
import { Main } from './pages/Main';
import { OfflineBanner } from './components/OfflineBanner';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useReconnectOnNetworkReturn } from './hooks/useReconnectOnNetworkReturn';
import { setPeerId, setTorEnabled, setNetworkOnline } from './state/slices/userSlice';
import { fetchAppConfig } from './state/slices/appConfigSlice';
import { useAppDispatch } from './state/hooks';
import { SetupReadinessProvider } from './providers/SetupReadinessProvider';
import { ConnectivityGuidanceProvider } from './providers/ConnectivityGuidanceProvider';

type WakeRecoveryState = {
  token: number;
  deadlineAt: number;
  reconnectSettled: boolean;
  offlineSyncSettled: boolean;
} | null;

function App() {
  const [initStatus, setInitStatus] = useState('Initializing...');
  const [isInitialized, setIsInitialized] = useState(false);
  const [wakeRecovery, setWakeRecovery] = useState<WakeRecoveryState>(null);

  const dispatch = useAppDispatch();

  useEffect(() => {
    let isMounted = true;
    const loadTorSettings = async () => {
      try {
        const result = await window.kiyeovoAPI.getTorSettings();
        if (!isMounted || !result.success || !result.settings) return;
        dispatch(setTorEnabled(result.settings.enabled === 'true'));
      } catch {
        // ignore; defaults to false
      }
    };

    const loadInitState = async () => {
      try {
        const initState = await window.kiyeovoAPI.getInitState();
        if (!isMounted) return;
        if (initState.status) {
          setInitStatus(initState.status.message);
          if (initState.status.stage === 'peerId') {
            dispatch(setPeerId(initState.status.message as string));
          }
        }
        if (initState.error) {
          setInitStatus(initState.error);
        }
        if (initState.initialized) {
          setIsInitialized(true);
          setInitStatus('Initialized successfully!');
        }
      } catch {
        // ignore and rely on live events
      }
    };

    void loadInitState();
    // May fail before core init; retried on init complete below.
    void loadTorSettings();

    const unsubStatus = window.kiyeovoAPI.onInitStatus((status) => {
      if (status.stage === 'peerId') {
        dispatch(setPeerId(status.message as string));
        return;
      }
      setInitStatus(status.message);
    });

    const unsubComplete = window.kiyeovoAPI.onInitComplete(() => {
      setIsInitialized(true);
      setInitStatus('Initialized successfully!');
      void loadTorSettings();
    });

    const unsubError = window.kiyeovoAPI.onInitError((error) => {
      setInitStatus(error);
    });


    return () => {
      isMounted = false;
      unsubStatus();
      unsubComplete();
      unsubError();
    };
  }, [dispatch]);

  useEffect(() => {
    if (!isInitialized) return;
    void dispatch(fetchAppConfig());
  }, [isInitialized, dispatch]);

  // Single source of OS-connectivity truth
  const isOnline = useOnlineStatus();
  useReconnectOnNetworkReturn(isOnline);
  useEffect(() => {
    dispatch(setNetworkOnline(isOnline));
  }, [isOnline, dispatch]);

  useEffect(() => {
    const unsubWakeStarted = window.kiyeovoAPI.onWakeRecoveryStarted((data) => {
      setWakeRecovery({
        token: data.token,
        deadlineAt: data.deadlineAt,
        reconnectSettled: false,
        offlineSyncSettled: false,
      });
    });

    const unsubWakeReconnectSettled = window.kiyeovoAPI.onWakeRecoveryReconnectSettled((data) => {
      setWakeRecovery((current) => {
        if (!current || current.token !== data.token) return current;
        if (current.offlineSyncSettled) return null;
        return { ...current, reconnectSettled: true };
      });
    });

    return () => {
      unsubWakeStarted();
      unsubWakeReconnectSettled();
    };
  }, []);

  useEffect(() => {
    if (!wakeRecovery) return;
    if (wakeRecovery.reconnectSettled && wakeRecovery.offlineSyncSettled) {
      setWakeRecovery((current) => current?.token === wakeRecovery.token ? null : current);
      return;
    }
    const remainingMs = wakeRecovery.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      setWakeRecovery((current) => current?.token === wakeRecovery.token ? null : current);
      return;
    }
    const timer = setTimeout(() => {
      setWakeRecovery((current) => current?.token === wakeRecovery.token ? null : current);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [wakeRecovery]);

  const handleWakeRecoveryOfflineSyncSettled = (token: number) => {
    setWakeRecovery((current) => {
      if (!current || current.token !== token) return current;
      if (current.reconnectSettled) return null;
      return { ...current, offlineSyncSettled: true };
    });
  };

  return <div className='w-full h-full'>
    <OfflineBanner wakeRecovery={wakeRecovery ? { deadlineAt: wakeRecovery.deadlineAt } : null} />
    {isInitialized
      ? (
        <SetupReadinessProvider>
          <ConnectivityGuidanceProvider>
            <Main
              wakeRecoveryToken={wakeRecovery?.token ?? null}
              onWakeRecoveryOfflineSyncSettled={handleWakeRecoveryOfflineSyncSettled}
            />
          </ConnectivityGuidanceProvider>
        </SetupReadinessProvider>
      )
      : <Login initStatus={initStatus} />}
  </div>
}

export default App
