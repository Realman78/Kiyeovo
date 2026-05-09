import type { PeerId, Stream } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';

import type { ChatNode } from '../types.js';
import { NETWORK_MODES, getNetworkModeConfig } from '../constants.js';
import type { ChatDatabase } from '../db/database.js';
import { getConfiguredFastRelayAddrs } from '../network/node-relays.js';
import { triggerFastRelayRefresh } from '../network/relay-keepalive.js';
import { isStaleDialError } from './dial-errors.js';
import { log } from '../../shared/logger.js';
import { errStr } from '../utils/general-error.js';

const PRIVATE_ONLY_DIRECT_DIAL_TIMEOUT_MS = 2_000;
const FAST_MODE_DIRECT_DIAL_TIMEOUT_MS = 10_000;
const FAST_MODE_RELAY_DIAL_TIMEOUT_MS = 10_000;

type DialProtocolWithRelayFallbackParams = {
  node: ChatNode;
  database: ChatDatabase;
  targetPeerId: PeerId;
  protocol: string;
  context: string;
};

function isPrivateHost(host: string): boolean {
  return /^(::f{4}:)?10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?172\.(1[6-9]|2\d|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^(::f{4}:)?169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/i.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe80:/i.test(host) ||
    /^::1$/i.test(host);
}

function extractIpHost(address: string): string | null {
  const matched = address.match(/\/(?:ip4|ip6)\/([^/]+)/);
  return matched?.[1] ?? null;
}

function isDirectAddressPrivateOnly(address: string): boolean {
  if (address.includes('/p2p-circuit')) {
    return false;
  }

  const host = extractIpHost(address);
  if (host === null) {
    return false;
  }

  return isPrivateHost(host);
}

type KnownAddressSnapshot = {
  all: string[];
  direct: string[];
  directPrivate: string[];
  directPublic: string[];
  circuit: string[];
};

async function getKnownAddressSnapshot(node: ChatNode, targetPeerId: PeerId): Promise<KnownAddressSnapshot> {
  try {
    const peerData = await node.peerStore.get(targetPeerId);
    const all = (peerData.addresses ?? []).map((entry) => entry.multiaddr.toString());
    const direct = all.filter((address) => !address.includes('/p2p-circuit'));
    return {
      all,
      direct,
      directPrivate: direct.filter(isDirectAddressPrivateOnly),
      directPublic: direct.filter((address) => !isDirectAddressPrivateOnly(address)),
      circuit: all.filter((address) => address.includes('/p2p-circuit')),
    };
  } catch {
    return {
      all: [],
      direct: [],
      directPrivate: [],
      directPublic: [],
      circuit: [],
    };
  }
}

async function shouldUseShortDirectTimeout(node: ChatNode, targetPeerId: PeerId): Promise<boolean> {
  const targetPeer = targetPeerId.toString();
  const hasActiveConnection = node.getConnections().some((connection) => connection.remotePeer.toString() === targetPeer);
  if (hasActiveConnection) {
    return false;
  }

  const snapshot = await getKnownAddressSnapshot(node, targetPeerId);
  if (snapshot.direct.length === 0) {
    return false;
  }

  return snapshot.direct.every(isDirectAddressPrivateOnly);
}

async function dialWithTimeout(
  node: ChatNode,
  target: PeerId | ReturnType<typeof multiaddr>,
  protocol: string,
  dialOptions: { runOnLimitedConnection: boolean; signal?: AbortSignal },
  timeoutMs?: number,
): Promise<Stream> {
  if (timeoutMs === undefined) {
    return node.dialProtocol(target, protocol, dialOptions);
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort(new Error(`Dial timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await node.dialProtocol(target, protocol, {
      ...dialOptions,
      signal: abortController.signal,
    });
  } catch (error: unknown) {
    if (abortController.signal.aborted) {
      throw abortController.signal.reason ?? error;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function closeTargetPeerConnections(
  node: ChatNode,
  targetPeer: string,
  context: string,
): Promise<void> {
  const connections = node
    .getConnections()
    .filter((connection) => connection.remotePeer.toString() === targetPeer);

  if (connections.length === 0) {
    log(`[DIAL][${context}] stale recovery found no active connections to close target=${targetPeer}`);
    return;
  }

  log(`[DIAL][${context}] stale recovery closing ${connections.length} connection(s) target=${targetPeer}`);

  const closeResults = await Promise.allSettled(connections.map((connection) => connection.close()));
  const failed = closeResults.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    console.warn(`[DIAL][${context}] stale recovery failed to close ${failed.length}/${connections.length} connection(s)`);
  }
}

const inFlightRecoveriesByPeer = new Map<string, Promise<void>>();

async function recoverFromStaleMuxerDialError(
  params: DialProtocolWithRelayFallbackParams,
  error: unknown,
): Promise<void> {
  const { node, database, targetPeerId, context } = params;
  const targetPeer = targetPeerId.toString();
  const networkMode = database.getSessionNetworkMode();
  const existingRecovery = inFlightRecoveriesByPeer.get(targetPeer);

  if (existingRecovery !== undefined) {
    log(`[DIAL][${context}] stale recovery already in flight target=${targetPeer}`);
    await existingRecovery;
    return;
  }

  console.warn(
    `[DIAL][${context}] stale muxer detected target=${targetPeer} reason=${errStr(error)}; ` +
    'recovering and retrying once',
  );

  const recovery = (async () => {
    await closeTargetPeerConnections(node, targetPeer, context);

    if (networkMode === NETWORK_MODES.FAST) {
      try {
        await triggerFastRelayRefresh();
      } catch (refreshError: unknown) {
        console.warn(`[DIAL][${context}] stale recovery relay refresh failed reason=${errStr(refreshError)}`);
      }
    }
  })();

  inFlightRecoveriesByPeer.set(targetPeer, recovery);

  try {
    await recovery;
  } finally {
    if (inFlightRecoveriesByPeer.get(targetPeer) === recovery) {
      inFlightRecoveriesByPeer.delete(targetPeer);
    }
  }
}

export async function dialProtocolWithRelayFallback(
  params: DialProtocolWithRelayFallbackParams
): Promise<Stream> {
  try {
    return await dialProtocolWithRelayFallbackOnce(params);
  } catch (error: unknown) {
    if (!isStaleDialError(error)) {
      throw error;
    }

    await recoverFromStaleMuxerDialError(params, error);
    return dialProtocolWithRelayFallbackOnce(params);
  }
}

async function dialProtocolWithRelayFallbackOnce(
  params: DialProtocolWithRelayFallbackParams
): Promise<Stream> {
  const {
    node,
    database,
    targetPeerId,
    protocol,
    context,
  } = params;

  const networkMode = database.getSessionNetworkMode();
  const modeConfig = getNetworkModeConfig(networkMode);
  const expectedProtocolPrefix = `${modeConfig.protocolName}/`;
  if (!protocol.startsWith(expectedProtocolPrefix)) {
    console.warn(
      `[MODE-GUARD][REJECT][dial_protocol] mode=${networkMode} context=${context} ` +
      `protocol=${protocol} expectedPrefix=${expectedProtocolPrefix}`
    );
    throw new Error('cross_mode_protocol_rejected');
  }

  const dialOptions = { runOnLimitedConnection: true };
  const targetPeer = targetPeerId.toString();
  const activeConnections = node
    .getConnections()
    .filter((connection) => connection.remotePeer.toString() === targetPeer)
    .map((connection) => connection.remoteAddr.toString());
  const knownAddressSnapshot = await getKnownAddressSnapshot(node, targetPeerId);
  log(
    `[DIAL][${context}] decision target=${targetPeer} ` +
    `activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'} ` +
    `allKnown=${knownAddressSnapshot.all.length > 0 ? knownAddressSnapshot.all.join(',') : 'none'} ` +
    `directPrivate=${knownAddressSnapshot.directPrivate.length > 0 ? knownAddressSnapshot.directPrivate.join(',') : 'none'} ` +
    `directPublic=${knownAddressSnapshot.directPublic.length > 0 ? knownAddressSnapshot.directPublic.join(',') : 'none'} ` +
    `circuit=${knownAddressSnapshot.circuit.length > 0 ? knownAddressSnapshot.circuit.join(',') : 'none'}`,
  );
  const directDialOptions = {
    ...dialOptions,
    ...(networkMode === NETWORK_MODES.FAST && await shouldUseShortDirectTimeout(node, targetPeerId)
      ? { signal: AbortSignal.timeout(PRIVATE_ONLY_DIRECT_DIAL_TIMEOUT_MS) }
      : {}),
  };

  if ('signal' in directDialOptions) {
    log(
      `[DIAL][${context}] using short direct timeout target=${targetPeer} timeoutMs=${PRIVATE_ONLY_DIRECT_DIAL_TIMEOUT_MS} reason=private_only_known_addrs`,
    );
  } else if (networkMode === NETWORK_MODES.FAST) {
    log(
      `[DIAL][${context}] using bounded direct timeout target=${targetPeer} timeoutMs=${FAST_MODE_DIRECT_DIAL_TIMEOUT_MS}`,
    );
  }

  const directDialStartedAt = Date.now();
  try {
    const stream = await dialWithTimeout(
      node,
      targetPeerId,
      protocol,
      directDialOptions,
      networkMode === NETWORK_MODES.FAST && !('signal' in directDialOptions)
        ? FAST_MODE_DIRECT_DIAL_TIMEOUT_MS
        : undefined,
    );
    log(
      `[DIAL][${context}] direct dial succeeded target=${targetPeer} durationMs=${Date.now() - directDialStartedAt}`,
    );
    return stream;
  } catch (directDialError: unknown) {
    if (networkMode !== NETWORK_MODES.FAST) {
      throw directDialError;
    }

    const relayAddrs = getConfiguredFastRelayAddrs(database).addresses;
    if (relayAddrs.length === 0) {
      throw directDialError;
    }

    const directReason = errStr(directDialError);
    console.warn(
      `[DIAL][${context}] direct dial failed target=${targetPeer} durationMs=${Date.now() - directDialStartedAt} ` +
      `reason=${directReason}. trying relay fallback count=${relayAddrs.length}`
    );

    let lastRelayError: unknown = directDialError;
    for (const relayAddr of relayAddrs) {
      try {
        let relayBase = relayAddr;
        if (relayBase.includes('/p2p-circuit')) {
          relayBase = relayBase.split('/p2p-circuit')[0] ?? relayAddr;
        }

        const relayMa = multiaddr(relayBase);
        if (!relayMa.getPeerId()) {
          console.warn(`[DIAL][${context}] skipping relay without /p2p peer id: ${relayAddr}`);
          continue;
        }

        const circuitAddr = `${relayBase}/p2p-circuit/p2p/${targetPeer}`;
        const stream = await dialWithTimeout(
          node,
          multiaddr(circuitAddr),
          protocol,
          dialOptions,
          FAST_MODE_RELAY_DIAL_TIMEOUT_MS,
        );
        log(`[DIAL][${context}] relay fallback succeeded target=${targetPeer} via=${relayBase}`);
        return stream;
      } catch (relayError: unknown) {
        lastRelayError = relayError;
        console.warn(`[DIAL][${context}] relay fallback failed via=${relayAddr} reason=${errStr(relayError)}`);
      }
    }

    throw lastRelayError;
  }
}
