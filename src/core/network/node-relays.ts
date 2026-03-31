import { multiaddr } from '@multiformats/multiaddr';

import type { ChatNode } from '../types.js';

import {
  FAST_RELAY_MULTIADDRS_SETTING_KEY,
  NETWORK_MODES,
} from '../constants.js';
import { DEFAULT_FAST_RELAY_MULTIADDRS } from './default-infrastructure.js';
import { dedupe } from '../utils/collections.js';
import { parsePeerIdFromAddress } from '../utils/multiaddr.js';
import { ChatDatabase } from '../db/database.js';
import { log } from '../../shared/logger.js';
import { errStr } from '../utils/general-error.js';

export type FastRelayDialResult = {
  attempted: number;
  connected: number;
  addresses: string[];
  source: 'db' | 'default' | 'none';
  skipped: boolean;
};

export type FastRelayConfig = {
  addresses: string[];
  source: 'db' | 'default';
};

export type FastRelayStatusNode = {
  address: string;
  connected: boolean;
};

export type FastRelayStatusSnapshot = {
  nodes: FastRelayStatusNode[];
  source: 'db' | 'default' | 'none';
  skipped: boolean;
};

export function parseFastRelayAddressList(raw: string): string[] {
  return dedupe(
    raw
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function normalizeFastRelayAddressList(addresses: string[]): string[] {
  return dedupe(
    addresses
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function serializeFastRelayAddressList(addresses: string[]): string {
  return normalizeFastRelayAddressList(addresses).join(',');
}

function logFastCircuitState(node: ChatNode): void {
  const circuitAddrs = node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .filter((addr) => addr.includes('/p2p-circuit'));

  log(
    `[CONFIG][FAST][RELAY] localCircuitAddrs=${circuitAddrs.length} values=${circuitAddrs.join(',') || 'none'}`
  );
}

function getReservedRelayPeerIds(node: ChatNode): Set<string> {
  return new Set(
    node
      .getMultiaddrs()
      .map((addr) => addr.toString())
      .filter((addr) => addr.includes('/p2p-circuit'))
      .map((addr) => parsePeerIdFromAddress(addr.split('/p2p-circuit')[0] ?? ''))
      .filter((peerId): peerId is string => peerId !== null),
  );
}

export function getConfiguredFastRelayAddrs(database: ChatDatabase): FastRelayConfig {
  const settingValue = database.getSetting(FAST_RELAY_MULTIADDRS_SETTING_KEY);
  if (settingValue !== null) {
    const fromDb = parseFastRelayAddressList(settingValue);
    return { addresses: fromDb, source: 'db' };
  }

  return { addresses: dedupe(DEFAULT_FAST_RELAY_MULTIADDRS), source: 'default' };
}

export function getFastRelayStatusSnapshot(node: ChatNode, database: ChatDatabase): FastRelayStatusSnapshot {
  const networkMode = database.getSessionNetworkMode();
  if (networkMode !== NETWORK_MODES.FAST) {
    return {
      nodes: [],
      source: 'none',
      skipped: true,
    };
  }

  const relayConfig = getConfiguredFastRelayAddrs(database);
  const connectedPeerIds = new Set(
    node.getConnections().map((connection) => connection.remotePeer.toString()),
  );
  const reservedRelayPeerIds = getReservedRelayPeerIds(node);

  return {
    nodes: relayConfig.addresses.map((address) => {
      const peerId = parsePeerIdFromAddress(address);
      const connected = peerId !== null
        && (connectedPeerIds.has(peerId) || reservedRelayPeerIds.has(peerId));
      return { address, connected };
    }),
    source: relayConfig.source,
    skipped: false,
  };
}

export async function dialConfiguredFastRelays(node: ChatNode, database: ChatDatabase): Promise<FastRelayDialResult> {
  const networkMode = database.getSessionNetworkMode();
  if (networkMode !== NETWORK_MODES.FAST) {
    return {
      attempted: 0,
      connected: 0,
      addresses: [],
      source: 'none',
      skipped: true,
    };
  }

  const fastRelayConfig = getConfiguredFastRelayAddrs(database);
  const fastRelayAddrs = fastRelayConfig.addresses;
  if (fastRelayAddrs.length === 0) {
    console.warn(`[CONFIG][FAST] no relay addresses configured (source=${fastRelayConfig.source})`);
    logFastCircuitState(node);
    return {
      attempted: 0,
      connected: 0,
      addresses: [],
      source: fastRelayConfig.source,
      skipped: false,
    };
  }

  const concurrency = Math.min(5, fastRelayAddrs.length);
  log(
    `[CONFIG][FAST] attempting deterministic relay dials count=${fastRelayAddrs.length} concurrency=${concurrency} source=${fastRelayConfig.source}`
  );
  let connected = 0;
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    while (cursor < fastRelayAddrs.length) {
      const relayAddr = fastRelayAddrs[cursor++];
      try {
        await node.dial(multiaddr(relayAddr));
        connected++;
        log(`[CONFIG][FAST][RELAY] connected ${relayAddr}`);
      } catch (error) {
        const reason = errStr(error, 'unknown');
        console.warn(`[CONFIG][FAST][RELAY] failed ${relayAddr} reason=${reason}`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  log(`[CONFIG][FAST][RELAY] connected=${connected}/${fastRelayAddrs.length}`);
  logFastCircuitState(node);

  return {
    attempted: fastRelayAddrs.length,
    connected,
    addresses: fastRelayAddrs,
    source: fastRelayConfig.source,
    skipped: false,
  };
}
