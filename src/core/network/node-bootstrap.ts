import { CODE_P2P, multiaddr } from '@multiformats/multiaddr';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';

import type { BootstrapAddressResolution, BootstrapAttempt, BootstrapConnection, BootstrapConnectOptions, BootstrapConnectResult, ChatNode, DhtAdmissionApi, NetworkMode, TorBootstrapTarget } from '../types.js';

import {
  MAX_BOOTSTRAP_NODES_FAST,
  MAX_BOOTSTRAP_NODES_TOR,
  NETWORK_MODES,
} from '../constants.js';
import { dedupe } from '../utils/collections.js';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import { parsePeerIdFromAddress } from '../utils/multiaddr.js';
import { ChatDatabase } from '../db/database.js';
import { dialConfiguredFastRelays } from './node-relays.js';
import { isOnionMultiaddr } from '../utils/miscellaneous.js';
import { log } from '../../shared/logger.js';

const MAX_BOOTSTRAP_CANDIDATES_PER_CONNECT = 6;
const FAST_BOOTSTRAP_BATCH_TIMEOUT_MS = 10_000;
const ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS = 15_000;
const FAST_BOOTSTRAP_ADDRESS_TIMEOUT_MS = 5_000;
const ANONYMOUS_BOOTSTRAP_ADDRESS_TIMEOUT_MS = 12_000;
const BOOTSTRAP_RETRY_TIMEOUT_BUFFER_MS = 5_000;

type BootstrapDialPolicy = {
  addressTimeoutMs: number;
  batchSize: number;
  batchTimeoutMs: number;
  maxCandidates: number;
  targetConnectionCount: number;
};

type BootstrapPeerTarget = {
  key: string;
  peerId: string | null;
  addresses: string[];
};

type BootstrapDialOutcome = BootstrapAttempt & {
  connection?: BootstrapConnection;
};

function getBootstrapTargetConnectionCount(networkMode: NetworkMode): number {
  return networkMode === NETWORK_MODES.ANONYMOUS ? MAX_BOOTSTRAP_NODES_TOR : MAX_BOOTSTRAP_NODES_FAST;
}

function getBootstrapDialPolicy(networkMode: NetworkMode): BootstrapDialPolicy {
  const targetConnectionCount = getBootstrapTargetConnectionCount(networkMode);

  return {
    addressTimeoutMs: networkMode === NETWORK_MODES.ANONYMOUS
      ? ANONYMOUS_BOOTSTRAP_ADDRESS_TIMEOUT_MS
      : FAST_BOOTSTRAP_ADDRESS_TIMEOUT_MS,
    batchSize: targetConnectionCount,
    batchTimeoutMs: networkMode === NETWORK_MODES.ANONYMOUS
      ? ANONYMOUS_BOOTSTRAP_BATCH_TIMEOUT_MS
      : FAST_BOOTSTRAP_BATCH_TIMEOUT_MS,
    maxCandidates: MAX_BOOTSTRAP_CANDIDATES_PER_CONNECT,
    targetConnectionCount,
  };
}

export function getBootstrapRetryTimeoutMs(networkMode: NetworkMode): number {
  const dialPolicy = getBootstrapDialPolicy(networkMode);
  const maxBatchCount = Math.ceil(dialPolicy.maxCandidates / dialPolicy.batchSize);

  return (maxBatchCount * dialPolicy.batchTimeoutMs) + BOOTSTRAP_RETRY_TIMEOUT_BUFFER_MS;
}

function filterBootstrapAddressesForMode(networkMode: NetworkMode, addresses: string[]): string[] {
  if (networkMode === NETWORK_MODES.ANONYMOUS) {
    const filtered = addresses.filter(isOnionMultiaddr);
    const ignored = addresses.length - filtered.length;
    if (ignored > 0) {
      log(`[CONFIG][ANON] ignoring ${ignored} non-onion bootstrap addresses`);
    }
    return filtered;
  }

  const filtered = addresses.filter((address) => !isOnionMultiaddr(address));
  const ignored = addresses.length - filtered.length;
  if (ignored > 0) {
    log(`[CONFIG][FAST] ignoring ${ignored} onion bootstrap addresses`);
  }
  return filtered;
}

function getDhtAdmissionApi(node: ChatNode): DhtAdmissionApi | null {
  const dhtCandidate = node.services.dht as unknown as Partial<DhtAdmissionApi>;
  if (
    dhtCandidate == null
    || typeof dhtCandidate.onPeerConnect !== 'function'
    || dhtCandidate.routingTable == null
    || typeof dhtCandidate.routingTable.size !== 'number'
  ) {
    return null;
  }

  return dhtCandidate as DhtAdmissionApi;
}

async function probeBootstrapDhtAdmission(node: ChatNode, remotePeer: PeerId | undefined): Promise<void> {
  try {
    const dhtAdmission = getDhtAdmissionApi(node);
    if (!dhtAdmission || !remotePeer) {
      return;
    }

    const peerInfo = await node.peerStore.get(remotePeer);
    const multiaddrs = (peerInfo.addresses ?? []).map((entry) => entry.multiaddr);

    await dhtAdmission.onPeerConnect({
      id: remotePeer,
      multiaddrs,
    });
  } catch (error: unknown) {
    console.warn(`[BOOTSTRAP] DHT admission probe failed: ${errStr(error)}`);
  }
}

// manual retry used to get “hijacked” by an already-running Kademlia dial for the 
// same peer. That background dial was peer-ID-only, so libp2p merged our retry into 
// it, and it kept using the bad private/localhost addresses from peer store 
// instead of the configured public bootstrap address
async function seedBootstrapPeerStoreAddress(node: ChatNode, address: string, peerId: string | null): Promise<void> {
  if (peerId === null) return;

  try {
    await node.peerStore.merge(peerIdFromString(peerId), {
      multiaddrs: [multiaddr(address)],
    });
  } catch (error) {
    console.warn(`[BOOTSTRAP][SEED][FAIL] peerId=${peerId} address=${address} error=${errStr(error)}`);
  }
}

function getBootstrapDialMultiaddr(address: string, peerId: string | null) {
  const configuredAddress = multiaddr(address);
  return peerId === null
    ? configuredAddress 
    : configuredAddress.decapsulateCode(CODE_P2P);
}

async function dialBootstrapAddress(
  node: ChatNode,
  address: string,
  signal: AbortSignal,
  getAbortError: () => string,
): Promise<BootstrapDialOutcome> {
  const startedAt = Date.now();
  const parsedPeerId = parsePeerIdFromAddress(address);

  try {
    await seedBootstrapPeerStoreAddress(node, address, parsedPeerId);

    const dialTarget = getBootstrapDialMultiaddr(address, parsedPeerId);
    log(`Trying bootstrap: ${address}`);
    const connection = await node.dial(dialTarget, { signal });

    if (parsedPeerId !== null && connection.remotePeer.toString() !== parsedPeerId) {
      const actualPeerId = connection.remotePeer.toString();
      try {
        await connection.close();
      } catch (closeError) {
        const closeMessage = errStr(closeError);
        console.warn(
          `[BOOTSTRAP][MISMATCH][CLOSE_FAIL] address=${address} expectedPeerId=${parsedPeerId} ` +
          `actualPeerId=${actualPeerId} error=${closeMessage}`,
        );
      }

      throw new Error(`bootstrap_peer_mismatch expected=${parsedPeerId} actual=${actualPeerId}`);
    }

    const durationMs = Date.now() - startedAt;
    log(`Connected to bootstrap peer: ${address} durationMs=${durationMs}`);

    return {
      address,
      ok: true,
      durationMs,
      connection: {
        address,
        remotePeer: connection?.remotePeer,
      },
    };
  } catch (error: unknown) {
    const durationMs = Date.now() - startedAt;
    if (signal.aborted) {
      const abortReason = getAbortError();
      console.warn(
        `[BOOTSTRAP][FAIL] address=${address} peerId=${parsedPeerId ?? 'unknown'} durationMs=${durationMs} ` +
        `reason=${abortReason}`,
      );
      return {
        address,
        ok: false,
        durationMs,
        error: abortReason,
      };
    }

    const message = errStr(error);
    const errorName = error instanceof Error ? error.name : typeof error;
    console.warn(
      `[BOOTSTRAP][FAIL] address=${address} peerId=${parsedPeerId ?? 'unknown'} durationMs=${durationMs} ` +
      `errorName=${errorName} error=${message}`,
    );
    generalErrorHandler(error, `[BOOTSTRAP][FAIL][RAW] address=${address}`);
    return {
      address,
      ok: false,
      durationMs,
      error: message,
    };
  }
}

function toBootstrapAttempt(outcome: BootstrapDialOutcome): BootstrapAttempt {
  const { connection, ...attempt } = outcome;
  return attempt;
}

function buildBootstrapPeerTargets(
  addresses: string[],
  maxTargets: number,
): {
  targets: BootstrapPeerTarget[];
  totalTargetCount: number;
} {
  const orderedTargets: BootstrapPeerTarget[] = [];
  const targetsByKey = new Map<string, BootstrapPeerTarget>();

  for (const address of addresses) {
    const peerId = parsePeerIdFromAddress(address);
    const key = peerId ?? `address:${address}`;

    let target = targetsByKey.get(key);
    if (!target) {
      target = { key, peerId, addresses: [] };
      targetsByKey.set(key, target);
      orderedTargets.push(target);
    }

    target.addresses.push(address);
  }

  return {
    targets: orderedTargets.slice(0, maxTargets),
    totalTargetCount: orderedTargets.length,
  };
}

async function dialBootstrapPeerTarget(
  node: ChatNode,
  target: BootstrapPeerTarget,
  addressTimeoutMs: number,
  signal: AbortSignal,
  getAbortError: () => string,
): Promise<{
  attempts: BootstrapAttempt[];
  successfulConnection: BootstrapConnection | null;
}> {
  const attempts: BootstrapAttempt[] = [];

  const dialAddressWithTimeout = async (address: string): Promise<BootstrapDialOutcome> => {
    const addressAbortController = new AbortController();
    let abortedByParent = false;
    let timedOut = false;

    const abortFromParent = (): void => {
      abortedByParent = true;
      addressAbortController.abort();
    };

    if (signal.aborted) {
      abortedByParent = true;
      addressAbortController.abort();
    } else {
      signal.addEventListener('abort', abortFromParent, { once: true });
    }

    const timeoutId = setTimeout(() => {
      timedOut = true;
      addressAbortController.abort();
    }, addressTimeoutMs);

    try {
      return await dialBootstrapAddress(
        node,
        address,
        addressAbortController.signal,
        () => (abortedByParent ? 'bootstrap_connection_aborted' : timedOut ? 'bootstrap_address_timeout' : getAbortError()),
      );
    } finally {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', abortFromParent);
    }
  };

  for (const address of target.addresses) {
    const outcome = await dialAddressWithTimeout(address);
    attempts.push(toBootstrapAttempt(outcome));

    if (outcome.ok && outcome.connection !== undefined) {
      return {
        attempts,
        successfulConnection: outcome.connection,
      };
    }

    if (signal.aborted) {
      break;
    }
  }

  return {
    attempts,
    successfulConnection: null,
  };
}

async function dialBootstrapBatch(
  node: ChatNode,
  targets: BootstrapPeerTarget[],
  addressTimeoutMs: number,
  batchTimeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<{
  attempts: BootstrapAttempt[];
  successfulConnections: BootstrapConnection[];
  abortedByParent: boolean;
}> {
  const batchAbortController = new AbortController();
  let abortedByParent = false;
  let timedOut = false;

  const abortFromParent = (): void => {
    abortedByParent = true;
    batchAbortController.abort();
  };

  if (parentSignal?.aborted) {
    abortedByParent = true;
    batchAbortController.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    batchAbortController.abort();
  }, batchTimeoutMs);

  try {
    const getAbortError = (): string => (
      abortedByParent
        ? 'bootstrap_connection_aborted'
        : timedOut
          ? 'bootstrap_batch_timeout'
          : 'bootstrap_connection_aborted'
    );

    const outcomes = await Promise.all(
      targets.map((target) => (
        dialBootstrapPeerTarget(node, target, addressTimeoutMs, batchAbortController.signal, getAbortError)
      )),
    );

    return {
      attempts: outcomes.flatMap((outcome) => outcome.attempts),
      successfulConnections: outcomes
        .filter((outcome): outcome is { attempts: BootstrapAttempt[]; successfulConnection: BootstrapConnection } => (
          outcome.successfulConnection !== null
        ))
        .map((outcome) => outcome.successfulConnection),
      abortedByParent,
    };
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

async function dialBootstrapCandidates(
  node: ChatNode,
  addresses: string[],
  dialPolicy: BootstrapDialPolicy,
  signal?: AbortSignal,
): Promise<BootstrapConnectResult & { successfulConnections: BootstrapConnection[] }> {
  const attempts: BootstrapAttempt[] = [];
  const successfulConnections: BootstrapConnection[] = [];
  const connectedAddresses: string[] = [];
  const connectedPeerIds: string[] = [];
  const successfulBootstrapKeys = new Set<string>();

  const buildResult = (status: 'connected' | 'all_failed' | 'aborted') => ({
    status,
    successfulConnections,
    connectedAddresses,
    connectedPeerIds,
    connectedCount: successfulBootstrapKeys.size,
    targetConnectionCount: dialPolicy.targetConnectionCount,
    targetReached: successfulBootstrapKeys.size >= dialPolicy.targetConnectionCount,
    attempts,
  });

  const {
    targets: cappedTargets,
    totalTargetCount,
  } = buildBootstrapPeerTargets(addresses, dialPolicy.maxCandidates);
  if (cappedTargets.length < totalTargetCount) {
    log(
      `[BOOTSTRAP] limiting attempts to first ${cappedTargets.length}/${totalTargetCount} configured bootstrap peers`,
    );
  }

  for (let start = 0; start < cappedTargets.length; start += dialPolicy.batchSize) {
    if (signal?.aborted) {
      return buildResult(successfulBootstrapKeys.size > 0 ? 'connected' : 'aborted');
    }

    const batchTargets = cappedTargets.slice(start, start + dialPolicy.batchSize);
    const batchNumber = Math.floor(start / dialPolicy.batchSize) + 1;
    log(
      `[BOOTSTRAP] starting batch ${batchNumber} peers=${batchTargets.length} timeoutMs=${dialPolicy.batchTimeoutMs}`,
    );

    // eslint-disable-next-line no-await-in-loop
    const batchResult = await dialBootstrapBatch(
      node,
      batchTargets,
      dialPolicy.addressTimeoutMs,
      dialPolicy.batchTimeoutMs,
      signal,
    );
    attempts.push(...batchResult.attempts);

    for (const connection of batchResult.successfulConnections) {
      successfulConnections.push(connection);

      const connectedPeerId = connection.remotePeer?.toString() ?? parsePeerIdFromAddress(connection.address);
      const connectedKey = connectedPeerId ?? connection.address;
      if (!successfulBootstrapKeys.has(connectedKey)) {
        successfulBootstrapKeys.add(connectedKey);
        connectedAddresses.push(connection.address);
        if (connectedPeerId !== null && !connectedPeerIds.includes(connectedPeerId)) {
          connectedPeerIds.push(connectedPeerId);
        }
      }
    }

    if (successfulBootstrapKeys.size >= dialPolicy.targetConnectionCount) {
      return buildResult('connected');
    }

    if (batchResult.abortedByParent) {
      return buildResult(successfulBootstrapKeys.size > 0 ? 'connected' : 'aborted');
    }
  }

  return buildResult(successfulBootstrapKeys.size > 0 ? 'connected' : 'all_failed');
}

function isLocalBootstrapAddress(address: string, localPeerId?: string): boolean {
  if (!localPeerId) {
    return false;
  }

  if (address === localPeerId) {
    return true;
  }

  return parsePeerIdFromAddress(address) === localPeerId;
}

export function resolveBootstrapAddressesForCurrentMode(
  database: ChatDatabase,
  localPeerId?: string,
): BootstrapAddressResolution {
  const networkMode = database.getSessionNetworkMode();
  const dbAddresses = database.getBootstrapNodes().map((bootstrapNode) => bootstrapNode.address);
  const candidateAddresses = dedupe(dbAddresses)
    .filter((address) => !isLocalBootstrapAddress(address, localPeerId));

  return {
    networkMode,
    addresses: filterBootstrapAddressesForMode(networkMode, candidateAddresses),
  };
}

export function extractTorBootstrapTargets(addresses: string[]): TorBootstrapTarget[] {
  const targets: TorBootstrapTarget[] = [];

  for (const address of addresses) {
    try {
      const onionAddress = multiaddr(address)
        .getComponents()
        .find((component) => component.code === 445)
        ?.value;

      if (!onionAddress) {
        continue;
      }

      const [host, rawPort] = onionAddress.split(':');
      const port = parseInt(rawPort ?? '', 10);
      if (!host || !Number.isFinite(port)) {
        continue;
      }

      targets.push({ host: `${host}.onion`, port });
    } catch {
      console.warn(`[CONFIG][ANON] ignoring invalid bootstrap address during Tor validation: ${address}`);
    }
  }

  return targets;
}

export function getBootstrapAddressesForCurrentMode(database: ChatDatabase, localPeerId?: string): string[] {
  return resolveBootstrapAddressesForCurrentMode(database, localPeerId).addresses;
}

export function getBootstrapPeerIdsForCurrentMode(database: ChatDatabase, localPeerId?: string): Set<string> {
  return new Set(
    getBootstrapAddressesForCurrentMode(database, localPeerId)
      .map(parsePeerIdFromAddress)
      .filter((peerId): peerId is string => peerId !== null),
  );
}

export async function connectToBootstrap(
  node: ChatNode,
  database: ChatDatabase,
  options: BootstrapConnectOptions = {},
): Promise<BootstrapConnectResult> {
  const bootstrapResolution = resolveBootstrapAddressesForCurrentMode(database, node.peerId.toString());
  const { networkMode } = bootstrapResolution;
  const dialPolicy = getBootstrapDialPolicy(networkMode);
  const { targetConnectionCount } = dialPolicy;

  if (bootstrapResolution.addresses.length === 0) {
    console.log(`No bootstrap addresses configured for mode=${networkMode}.`);
    if (options.signal?.aborted) {
      return {
        status: 'aborted',
        connectedAddresses: [],
        connectedPeerIds: [],
        connectedCount: 0,
        targetConnectionCount,
        targetReached: false,
        attempts: [],
      };
    }
    await dialConfiguredFastRelays(node, database);
    return {
      status: 'no_candidates',
      connectedAddresses: [],
      connectedPeerIds: [],
      connectedCount: 0,
      targetConnectionCount,
      targetReached: false,
      attempts: [],
    };
  }

  console.log(`Attempting to connect to bootstrap nodes... mode=${networkMode} configured=${bootstrapResolution.addresses.length}`);

  const dialResult = await dialBootstrapCandidates(
    node,
    bootstrapResolution.addresses,
    dialPolicy,
    options.signal,
  );

  if (dialResult.status === 'all_failed') {
    console.log(`No reachable bootstrap nodes for mode=${networkMode}.`);
  }

  const { successfulConnections, ...publicDialResult } = dialResult;

  const toResult = (statusOverride?: BootstrapConnectResult['status']): BootstrapConnectResult => ({
    ...publicDialResult,
    status: statusOverride ?? publicDialResult.status,
  });

  if (dialResult.status === 'aborted') {
    return toResult();
  }

  if (options.signal?.aborted) {
    return toResult(dialResult.connectedCount > 0 ? 'connected' : 'aborted');
  }

  const probedBootstrapPeers = new Set<string>();
  for (const successfulConnection of successfulConnections) {
    const remotePeerId = successfulConnection.remotePeer?.toString();
    if (!remotePeerId || probedBootstrapPeers.has(remotePeerId)) {
      continue;
    }

    probedBootstrapPeers.add(remotePeerId);
    // Keep bootstrap connect bounded by dial outcomes; DHT admission is best-effort
    // and can complete in the background once we know the peer connection exists.
    void probeBootstrapDhtAdmission(node, successfulConnection.remotePeer);
  }

  await dialConfiguredFastRelays(node, database);
  return toResult();
}
