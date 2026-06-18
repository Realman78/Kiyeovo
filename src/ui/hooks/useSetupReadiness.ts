import { useEffect, useState } from 'react';
import type { NetworkMode } from '../../core/types';

export type SetupNodeStatus = 'missing' | 'configured' | 'unknown';
export type SetupIceStatus = 'not_applicable' | 'configured' | 'missing' | 'missing_acknowledged' | 'unknown';
export type SetupSeverity = 'blocked' | 'warning' | 'ready';

export type SetupReadiness = {
  mode: NetworkMode;
  bootstrap: SetupNodeStatus;
  relay: SetupNodeStatus | 'not_applicable';
  ice: SetupIceStatus;
  severity: SetupSeverity;
};

function getSeverity(
  bootstrap: SetupNodeStatus,
  relay: SetupReadiness['relay'],
  ice: SetupIceStatus,
): SetupSeverity {
  if (bootstrap !== 'configured') return 'blocked';
  if (relay === 'missing' || relay === 'unknown') return 'warning';
  if (ice === 'missing' || ice === 'unknown') return 'warning';
  return 'ready';
}

function getNodeStatus(nodes: unknown): SetupNodeStatus {
  if (!Array.isArray(nodes)) return 'unknown';
  return nodes.length > 0 ? 'configured' : 'missing';
}

async function loadNodeStatus(
  label: 'bootstrap' | 'relay',
  loadNodes: () => Promise<{ nodes: unknown }>,
): Promise<SetupNodeStatus> {
  try {
    return getNodeStatus((await loadNodes()).nodes);
  } catch (error) {
    console.warn(`[SetupReadiness] Failed to read ${label} configuration:`, error);
    return 'unknown';
  }
}

function failedReadiness(mode: NetworkMode = 'fast'): SetupReadiness {
  return {
    mode,
    bootstrap: 'unknown',
    relay: mode === 'fast' ? 'unknown' : 'not_applicable',
    ice: mode === 'fast' ? 'unknown' : 'not_applicable',
    severity: 'blocked',
  };
}

async function loadSetupReadiness(): Promise<SetupReadiness> {
  const modeResult = await window.kiyeovoAPI.getNetworkMode();
  const mode: NetworkMode = modeResult.mode === 'anonymous' ? 'anonymous' : 'fast';
  const bootstrap = await loadNodeStatus(
    'bootstrap',
    () => window.kiyeovoAPI.getBootstrapNodes(),
  );

  if (mode === 'anonymous') {
    return {
      mode,
      bootstrap,
      relay: 'not_applicable',
      ice: 'not_applicable',
      severity: getSeverity(bootstrap, 'not_applicable', 'not_applicable'),
    };
  }

  const [relay, iceResult, acknowledgementResult] = await Promise.all([
    loadNodeStatus('relay', () => window.kiyeovoAPI.getRelayStatus()),
    window.kiyeovoAPI.getIceServers().catch((error) => {
      console.warn('[SetupReadiness] Failed to read ICE configuration:', error);
      return null;
    }),
    window.kiyeovoAPI.getMissingIceWarningAcknowledged().catch((error) => {
      console.warn('[SetupReadiness] Failed to read ICE warning preference:', error);
      return null;
    }),
  ]);

  let ice: SetupIceStatus = 'unknown';
  if (iceResult && Array.isArray(iceResult.servers)) {
    if (iceResult.servers.length > 0) {
      ice = 'configured';
    } else {
      const acknowledged = acknowledgementResult?.acknowledged === true;
      ice = acknowledged ? 'missing_acknowledged' : 'missing';
    }
  }

  return {
    mode,
    bootstrap,
    relay,
    ice,
    severity: getSeverity(bootstrap, relay, ice),
  };
}

export function useSetupReadiness() {
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);

  useEffect(() => {
    let disposed = false;
    void loadSetupReadiness()
      .then((result) => {
        if (!disposed) {
          setReadiness(result);
        }
      })
      .catch((error) => {
        console.warn('[SetupReadiness] Failed to load:', error);
        if (!disposed) {
          setReadiness(failedReadiness());
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  return readiness;
}
