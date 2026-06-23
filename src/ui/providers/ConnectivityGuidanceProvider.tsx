import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MessageConnectivityFailure } from '../../core/types';
import { Button } from '../components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/Dialog';
import { useToast } from '../components/ui/use-toast';
import {
  ConnectivityGuidanceContext,
  type ConnectivityGuidanceContextValue,
} from '../hooks/useConnectivityGuidance';
import { useSetupReadiness } from '../hooks/useSetupReadiness';
import { requestOpenSetup } from '../utils/uiSignals';

const GUIDANCE_COOLDOWN_MS = 30_000;

export function ConnectivityGuidanceProvider({ children }: { children: ReactNode }) {
  const readiness = useSetupReadiness();
  const { toast } = useToast();
  const [callWarningOpen, setCallWarningOpen] = useState(false);
  const callWarningAcceptedRef = useRef(false);
  const pendingCallDecisionRef = useRef<((proceed: boolean) => void) | null>(null);
  const lastGuidanceAtRef = useRef<Partial<Record<
    MessageConnectivityFailure | 'call_connection_failed',
    number
  >>>({});

  const resolveCallDecision = useCallback((proceed: boolean) => {
    const resolve = pendingCallDecisionRef.current;
    pendingCallDecisionRef.current = null;
    setCallWarningOpen(false);
    resolve?.(proceed);
  }, []);

  useEffect(() => () => {
    pendingCallDecisionRef.current?.(false);
    pendingCallDecisionRef.current = null;
  }, []);

  const confirmCallAttempt = useCallback(async (): Promise<boolean> => {
    const iceMissing = readiness?.mode === 'fast'
      && (readiness.ice === 'missing' || readiness.ice === 'missing_acknowledged');
    if (!iceMissing || callWarningAcceptedRef.current) {
      return true;
    }
    if (pendingCallDecisionRef.current) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      pendingCallDecisionRef.current = resolve;
      setCallWarningOpen(true);
    });
  }, [readiness]);

  const canShowGuidance = useCallback((
    kind: MessageConnectivityFailure | 'call_connection_failed',
  ): boolean => {
    const now = Date.now();
    const lastShownAt = lastGuidanceAtRef.current[kind] ?? 0;
    if (now - lastShownAt < GUIDANCE_COOLDOWN_MS) {
      return false;
    }
    lastGuidanceAtRef.current[kind] = now;
    return true;
  }, []);

  const showCallConnectionFailure = useCallback((): boolean => {
    const iceMissing = readiness?.mode === 'fast'
      && (readiness.ice === 'missing' || readiness.ice === 'missing_acknowledged');
    if (!iceMissing || !canShowGuidance('call_connection_failed')) {
      return false;
    }

    toast.warningAction(
      'The call could not establish or maintain a media connection. Adding STUN/TURN servers may help across different networks.',
      'Open call setup',
      () => requestOpenSetup('ice'),
      'Call connection failed',
    );
    return true;
  }, [canShowGuidance, readiness, toast]);

  const showMessageFailureGuidance = useCallback((
    reason: MessageConnectivityFailure,
  ): boolean => {
    if (reason === 'bootstrap_unavailable' && readiness?.bootstrap === 'missing') {
      if (!canShowGuidance(reason)) return false;
      toast.warningAction(
        'The message could not reach the network because no bootstrap server is configured.',
        'Open bootstrap setup',
        () => requestOpenSetup('bootstrap'),
        'Messaging setup required',
      );
      return true;
    }

    if (
      reason === 'peer_unreachable'
      && readiness?.mode === 'fast'
      && readiness.relay === 'missing'
    ) {
      if (!canShowGuidance(reason)) return false;
      toast.warningAction(
        'This contact could not be reached. Adding a relay may improve messaging reliability.',
        'Open relay setup',
        () => requestOpenSetup('relay'),
        'Contact unreachable',
      );
      return true;
    }

    return false;
  }, [canShowGuidance, readiness, toast]);

  const value = useMemo<ConnectivityGuidanceContextValue>(() => ({
    confirmCallAttempt,
    showCallConnectionFailure,
    showMessageFailureGuidance,
  }), [confirmCallAttempt, showCallConnectionFailure, showMessageFailureGuidance]);

  return (
    <ConnectivityGuidanceContext.Provider value={value}>
      {children}

      <Dialog
        open={callWarningOpen}
        onOpenChange={(open) => {
          if (!open) {
            resolveCallDecision(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Calls may not connect</DialogTitle>
            <DialogDescription>
              No STUN/TURN servers are configured. Calls may work on LAN,
              but they can fail when people are on different networks.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                callWarningAcceptedRef.current = true;
                resolveCallDecision(true);
              }}
            >
              Try anyway
            </Button>
            <Button
              onClick={() => {
                resolveCallDecision(false);
                requestOpenSetup('ice');
              }}
            >
              Set up calling
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConnectivityGuidanceContext.Provider>
  );
}
