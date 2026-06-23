import { createContext, useContext } from 'react';
import type { MessageConnectivityFailure } from '../../core/types';

export type ConnectivityGuidanceContextValue = {
  confirmCallAttempt: () => Promise<boolean>;
  showCallConnectionFailure: () => boolean;
  showMessageFailureGuidance: (reason: MessageConnectivityFailure) => boolean;
};

export const ConnectivityGuidanceContext =
  createContext<ConnectivityGuidanceContextValue | undefined>(undefined);

export function useConnectivityGuidance(): ConnectivityGuidanceContextValue {
  const guidance = useContext(ConnectivityGuidanceContext);
  if (!guidance) {
    throw new Error('useConnectivityGuidance must be used within ConnectivityGuidanceProvider');
  }
  return guidance;
}
