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

type TransportManagerLike = {
  listen: (addrs: ReturnType<typeof multiaddr>[]) => Promise<void>;
};

function getTransportManager(node: ChatNode): TransportManagerLike {
  return (node as ChatNode & { components: { transportManager: TransportManagerLike } }).components.transportManager;
}

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

function toConfiguredFastRelayListenAddr(address: string): string | null {
  const peerId = parsePeerIdFromAddress(address);
  if (peerId === null) {
    console.warn(`[CONFIG][FAST][RELAY] invalid relay address (missing peer id): ${address}`);
    return null;
  }

  try {
    return multiaddr(address).encapsulate('/p2p-circuit').toString();
  } catch {
    console.warn(`[CONFIG][FAST][RELAY] invalid relay address ignored: ${address}`);
    return null;
  }
}

function getLocalCircuitAddresses(node: ChatNode): string[] {
  return node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .filter((addr) => addr.includes('/p2p-circuit'));
}

function logFastCircuitState(node: ChatNode): void {
  const circuitAddrs = getLocalCircuitAddresses(node);
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
  const reservedRelayPeerIds = getReservedRelayPeerIds(node);

  return {
    nodes: relayConfig.addresses.map((address) => {
      const peerId = parsePeerIdFromAddress(address);
      const connected = peerId !== null && reservedRelayPeerIds.has(peerId);
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
    `[CONFIG][FAST] attempting deterministic relay reservations count=${fastRelayAddrs.length} concurrency=${concurrency} source=${fastRelayConfig.source}`
  );
  let connected = 0;
  let cursor = 0;
  const transportManager = getTransportManager(node);

  const runWorker = async (): Promise<void> => {
    while (cursor < fastRelayAddrs.length) {
      const relayAddr = fastRelayAddrs[cursor++];
      if (relayAddr == null) continue;

      const relayPeerId = parsePeerIdFromAddress(relayAddr);
      const relayListenAddr = toConfiguredFastRelayListenAddr(relayAddr);
      if (relayListenAddr === null) continue;

      if (relayPeerId !== null && getReservedRelayPeerIds(node).has(relayPeerId)) {
        connected++;
        log(`[CONFIG][FAST][RELAY] reservation already active ${relayAddr}`);
        continue;
      }

      try {
        await transportManager.listen([multiaddr(relayListenAddr)]);
        connected++;
        log(`[CONFIG][FAST][RELAY] reserved ${relayAddr} via=${relayListenAddr}`);
      } catch (error) {
        const reason = errStr(error, 'unknown');
        console.warn(`[CONFIG][FAST][RELAY] reservation failed ${relayAddr} via=${relayListenAddr} reason=${reason}`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  log(`[CONFIG][FAST][RELAY] reserved=${connected}/${fastRelayAddrs.length}`);
  logFastCircuitState(node);

  return {
    attempted: fastRelayAddrs.length,
    connected,
    addresses: fastRelayAddrs,
    source: fastRelayConfig.source,
    skipped: false,
  };
}
