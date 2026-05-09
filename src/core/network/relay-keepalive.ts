import { multiaddr } from '@multiformats/multiaddr';

import type { ChatNode } from '../types.js';
import type { ChatDatabase } from '../db/database.js';
import {
  NETWORK_MODES,
  RELAY_KEEP_ALIVE_INTERVAL,
  RELAY_KEEP_ALIVE_PING_TIMEOUT,
  RELAY_KEEP_ALIVE_START_DELAY,
} from '../constants.js';
import {
  dialConfiguredFastRelays,
  getConfiguredFastRelayAddrs,
  getFastRelayStatusSnapshot,
} from './node-relays.js';
import { errStr } from '../utils/general-error.js';
import { parsePeerIdFromAddress } from '../utils/multiaddr.js';
import { log } from '../../shared/logger.js';

export interface RelayKeepAliveController {
  stop: () => Promise<void>;
  runNow: () => Promise<void>;
}

let activeController: RelayKeepAliveController | null = null;

export async function triggerFastRelayRefresh(): Promise<void> {
  if (activeController === null) {
    return;
  }
  await activeController.runNow();
}

type RelayPingResult =
  | { address: string; ok: true; rttMs: number }
  | { address: string; ok: false; error: unknown };

async function pingRelayAddress(node: ChatNode, address: string): Promise<RelayPingResult> {
  try {
    const rttMs = await node.services.ping.ping(multiaddr(address), {
      signal: AbortSignal.timeout(RELAY_KEEP_ALIVE_PING_TIMEOUT),
    });
    return { address, ok: true, rttMs };
  } catch (error: unknown) {
    return { address, ok: false, error };
  }
}

async function closeRelayConnections(node: ChatNode, relayAddresses: string[]): Promise<void> {
  const relayPeerIds = new Set(
    relayAddresses
      .map(parsePeerIdFromAddress)
      .filter((peerId): peerId is string => peerId !== null),
  );

  if (relayPeerIds.size === 0) {
    return;
  }

  const connections = node
    .getConnections()
    .filter((connection) => relayPeerIds.has(connection.remotePeer.toString()));

  if (connections.length === 0) {
    return;
  }

  await Promise.allSettled(connections.map((connection) => connection.close()));
}

export function startFastRelayKeepAlive(node: ChatNode, database: ChatDatabase): RelayKeepAliveController {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const runKeepAlive = async (reason: 'startup' | 'interval' | 'manual'): Promise<void> => {
    if (stopped || inFlight !== null) {
      return inFlight ?? Promise.resolve();
    }

    inFlight = (async () => {
      try {
        if (database.getSessionNetworkMode() !== NETWORK_MODES.FAST) {
          return;
        }

        const relayConfig = getConfiguredFastRelayAddrs(database);
        if (relayConfig.addresses.length === 0) {
          return;
        }

        const relayStatus = getFastRelayStatusSnapshot(node, database);
        const missingReservations = relayStatus.nodes.filter((relayNode) => !relayNode.connected);
        const pingResults = await Promise.all(relayConfig.addresses.map((address) => pingRelayAddress(node, address)));
        const failedPings = pingResults.filter((result): result is Extract<RelayPingResult, { ok: false }> => !result.ok);

        if (missingReservations.length === 0 && failedPings.length === 0) {
          const rtts = pingResults
            .filter((result): result is Extract<RelayPingResult, { ok: true }> => result.ok)
            .map((result) => `${result.rttMs}ms`)
            .join(',');
          log(`[RELAY][KEEPALIVE] ok reason=${reason} relayCount=${pingResults.length} rtt=${rtts || 'none'}`);
          return;
        }

        console.warn(
          `[RELAY][KEEPALIVE] refreshing relays reason=${reason} ` +
          `missingReservations=${missingReservations.length} failedPings=${failedPings.length}`,
        );

        if (failedPings.length > 0) {
          await closeRelayConnections(node, failedPings.map((result) => result.address));
        }

        const relayResult = await dialConfiguredFastRelays(node, database);
        log(
          `[RELAY][KEEPALIVE] refresh complete connected=${relayResult.connected}/${relayResult.attempted}`,
        );
      } catch (error: unknown) {
        console.warn(`[RELAY][KEEPALIVE] failed reason=${reason} error=${errStr(error)}`);
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  const startupTimeout = setTimeout(() => {
    void runKeepAlive('startup');
  }, RELAY_KEEP_ALIVE_START_DELAY);

  const interval = setInterval(() => {
    void runKeepAlive('interval');
  }, RELAY_KEEP_ALIVE_INTERVAL);

  const controller: RelayKeepAliveController = {
    stop: async () => {
      stopped = true;
      clearTimeout(startupTimeout);
      clearInterval(interval);
      if (activeController === controller) {
        activeController = null;
      }
      await inFlight;
    },
    runNow: () => runKeepAlive('manual'),
  };

  activeController = controller;
  return controller;
}
