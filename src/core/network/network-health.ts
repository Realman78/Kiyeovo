import { log } from '../../shared/logger.js';
import type { ChatNode } from '../types.js';
import { errStr } from '../utils/general-error.js';

type ChatConnection = ReturnType<ChatNode['getConnections']>[number];

export type DhtStatusCheckSource =
  | 'startup'
  | 'timer_5s'
  | 'timer_30s'
  | 'manual_retry'
  | 'post_retry_verify';

export type ProbeSource = 'dht' | 'bootstrap_fallback';

export type NetworkHealthEvaluation = {
  probeSource?: ProbeSource;
  reason: string;
  status: boolean | null;
};

type CreateNetworkHealthMonitorOptions = {
  activeDhtProtocol: string;
  getConnectedBootstrapConnections: (connections: ChatConnection[]) => ChatConnection[];
  node: ChatNode;
  pingProbeHardTimeoutMs: number;
  pingProbeTimeoutMs: number;
};

export function createNetworkHealthMonitor({
  activeDhtProtocol,
  getConnectedBootstrapConnections,
  node,
  pingProbeHardTimeoutMs,
  pingProbeTimeoutMs,
}: CreateNetworkHealthMonitorOptions) {
  const getDhtCapableConnections = async (): Promise<ChatConnection[]> => {
    const connections = node.getConnections();
    if (connections.length === 0) return [];

    const capabilityChecks = connections.map(async (connection) => {
      try {
        const peerData = await node.peerStore.get(connection.remotePeer);
        const protocols = peerData.protocols ?? [];
        if (protocols.includes(activeDhtProtocol)) {
          return connection;
        }
      } catch { };

      return null;
    });

    const resolved = await Promise.all(capabilityChecks);
    return resolved.filter((connection): connection is ChatConnection => connection !== null);
  };

  const probeAnyAliveConnection = async (
    connectionsToProbe: ChatConnection[],
    options: {
      probeSource?: ProbeSource;
    } = {},
  ): Promise<boolean> => {
    const {
      probeSource = 'dht',
    } = options;

    if (connectionsToProbe.length === 0) {
      return false;
    }

    const toProbe = connectionsToProbe.slice(0, 3);
    const pingWithHardTimeout = (remotePeer: unknown) => (
      Promise.race([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (node.services as any).ping.ping(remotePeer, {
          signal: AbortSignal.timeout(pingProbeTimeoutMs),
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('ping_probe_hard_timeout')), pingProbeHardTimeoutMs);
        }),
      ])
    );

    const probeTasks = toProbe.map(async (connection) => {
      try {
        await pingWithHardTimeout(connection.remotePeer);
        return { connection, alive: true } as const;
      } catch (error) {
        return { connection, alive: false, error } as const;
      }
    });

    const failureLogPromise = (async () => {
      const probeResults = await Promise.all(probeTasks);
      const deadResults = probeResults.filter((result) => !result.alive);
      if (deadResults.length === 0) {
        return;
      }

      log(
        `[DHT-STATUS][CORE][PROBE][FAIL] source=${probeSource} count=${deadResults.length} details=${deadResults
          .map((result) => `${result.connection.remotePeer.toString()}:${errStr(result.error)}`)
          .join('|')}`,
      );
      log(
        `[DHT-STATUS][CORE][PROBE][CLOSE_STALE][SKIP] reason=non_destructive_policy source=${probeSource} ` +
        `targets=${deadResults.map((result) => `${result.connection.remotePeer.toString()}@${result.connection.remoteAddr.toString()}`).join(',')}`,
      );
    })();

    let anyAlive = false;
    try {
      await Promise.any(
        probeTasks.map(async (task) => {
          const result = await task;
          if (!result.alive) {
            throw (result.error instanceof Error ? result.error : new Error('probe_failed'));
          }
          return result.connection;
        }),
      );
      anyAlive = true;
    } catch {
      anyAlive = false;
    }

    void failureLogPromise.catch((error) => {
      console.warn(
        '[DHT-STATUS][CORE][PROBE][CLOSE_STALE][ERROR] ' +
        errStr(error),
      );
    });

    return anyAlive;
  };

  const evaluateStatus = async (
    allConnections: ChatConnection[],
    source: DhtStatusCheckSource,
    options: {
      suppressNegativeStatusDuringBootstrapRetry: boolean;
    },
  ): Promise<NetworkHealthEvaluation> => {
    const { suppressNegativeStatusDuringBootstrapRetry } = options;

    if (allConnections.length === 0) {
      if (suppressNegativeStatusDuringBootstrapRetry) {
        return {
          status: null,
          reason: 'bootstrap_retry_in_progress',
        };
      }

      return {
        status: false,
        reason: 'no_connections',
      };
    }

    let connectionsToProbe = await getDhtCapableConnections();
    let probeSource: ProbeSource = 'dht';

    if (connectionsToProbe.length === 0) {
      const bootstrapConnections = getConnectedBootstrapConnections(allConnections);
      if (bootstrapConnections.length > 0) {
        probeSource = 'bootstrap_fallback';
        connectionsToProbe = bootstrapConnections;
        log(`[DHT-STATUS][CORE][CHECK][FALLBACK] count=${bootstrapConnections.length}`);
      }
    }

    if (connectionsToProbe.length === 0) {
      if (suppressNegativeStatusDuringBootstrapRetry) {
        return {
          status: null,
          reason: 'bootstrap_retry_in_progress',
        };
      }

      return {
        status: false,
        reason: 'no_dht_protocol_peers',
      };
    }

    const anyAlive = await probeAnyAliveConnection(connectionsToProbe, { probeSource });

    if (anyAlive) {
      return {
        status: true,
        reason: probeSource === 'dht' ? 'probe_ok' : 'probe_ok_bootstrap_fallback',
        probeSource,
      };
    }

    if (probeSource === 'bootstrap_fallback' && (source === 'startup' || source === 'post_retry_verify')) {
      return {
        status: null,
        reason: source === 'startup' ? 'bootstrap_warmup_startup' : 'bootstrap_warmup_retry',
        probeSource,
      };
    }

    if (suppressNegativeStatusDuringBootstrapRetry) {
      return {
        status: null,
        reason: 'bootstrap_retry_in_progress',
        probeSource,
      };
    }

    return {
      status: false,
      reason: probeSource === 'dht' ? 'probe_failed' : 'probe_failed_bootstrap_fallback',
      probeSource,
    };
  };

  return {
    evaluateStatus,
    getDhtCapableConnections,
    probeAnyAliveConnection,
  };
}
