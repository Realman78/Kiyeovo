import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  readSetupReadiness,
  SetupReadinessRefreshContext,
  SetupReadinessStateContext,
  type SetupReadiness,
} from '../hooks/useSetupReadiness';

export function SetupReadinessProvider({ children }: { children: ReactNode }) {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const refreshGenerationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const nextReadiness = await readSetupReadiness();

    if (generation === refreshGenerationRef.current) {
      setReadiness(nextReadiness);
    }
  }, []);

  useEffect(() => {
    const generation = ++refreshGenerationRef.current;
    void readSetupReadiness().then((nextReadiness) => {
      if (generation === refreshGenerationRef.current) {
        setReadiness(nextReadiness);
      }
    });

    return () => {
      refreshGenerationRef.current += 1;
    };
  }, []);

  return (
    <SetupReadinessRefreshContext.Provider value={refresh}>
      <SetupReadinessStateContext.Provider value={readiness}>
        {children}
      </SetupReadinessStateContext.Provider>
    </SetupReadinessRefreshContext.Provider>
  );
}
