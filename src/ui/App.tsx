import { useState, useEffect } from 'react'
import './App.css'
import { Login } from './pages/Login';
import { Main } from './pages/Main';
import { setPeerId, setTorEnabled } from './state/slices/userSlice';
import { fetchAppConfig } from './state/slices/appConfigSlice';
import { useAppDispatch } from './state/hooks';

function App() {
  const [initStatus, setInitStatus] = useState('Initializing...');
  const [isInitialized, setIsInitialized] = useState(false);

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

  return <div className='w-full h-full'>
    {isInitialized ? <Main /> : <Login initStatus={initStatus} />}
  </div>
}

export default App
