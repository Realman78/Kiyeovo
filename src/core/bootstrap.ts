import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { bootstrap as bootstrapDiscovery } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { LevelDatastore } from 'datastore-level';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';

import type { PeerId } from '@libp2p/interface';
import type { Datastore } from 'interface-datastore';
import type { ChatNode } from './types.js';

import { PeerIdManager } from './network/peer-id-manager.js';
import {
  BOOTSTRAP_LISTEN_ADDRESS,
  DEFAULT_NETWORK_MODE,
  K_BUCKET_SIZE,
  NETWORK_MODES,
  PREFIX_LENGTH,
  BOOTSTRAP_PEER_ID_FILE,
  getTorConfig,
  getNetworkModeConfig,
  getNetworkModeRuntime,
  isNetworkMode,
} from './constants.js';
import { isDeploymentMode } from './server/deploy-mode.js';
import {
  buildClientAddrs,
  getRuntimeMetadataPath,
  getServerVersion,
  removeRuntimeMetadataFile,
  writeRuntimeMetadata,
  type ServiceRuntimeMetadata,
} from './server/runtime-metadata.js';
import { filterOnionAddressesMapper } from './utils/miscellaneous.js';
import { offlineMessageSelector, offlineMessageValidateUpdate, offlineMessageValidator } from './direct/offline-message-validator.js';
import { groupOfflineMessageValidator, groupInfoLatestValidator, groupInfoVersionedValidator, groupOfflineMessageSelector, groupInfoLatestSelector, groupInfoVersionedSelector, groupOfflineValidateUpdate, groupInfoLatestValidateUpdate, groupInfoVersionedValidateUpdate } from './group/dht/group-dht-validator.js';
import {
  usernameRegistrationSelector,
  usernameRegistrationValidateUpdate,
  usernameRegistrationValidator,
} from './username/username-dht-validator.js';
import { errStr } from './utils/general-error.js';

dotenv.config();

type BootstrapRuntime = {
  node: ChatNode;
  datastore: LevelDatastore;
  datastorePath: string;
  runtimeFile: string | undefined;
  federationReconnectTimer: NodeJS.Timeout | undefined;
};

type BootstrapRuntimeConfig = {
  networkMode: 'fast' | 'anonymous';
  modeConfig: ReturnType<typeof getNetworkModeConfig>;
  modeRuntime: ReturnType<typeof getNetworkModeRuntime>;
  torConfig: ReturnType<typeof getTorConfig>;
  isAnonymousMode: boolean;
  listenAddr: string;
  announceAddrs: string[];
  datastorePath: string;
  peerIdFile: string;
  maxConnections: number;
  bootstrapPeers: string[];
};

function readBootstrapNetworkMode(): 'fast' | 'anonymous' {
  const raw = process.env.BOOTSTRAP_NETWORK_MODE?.trim().toLowerCase();
  if (isNetworkMode(raw)) {
    return raw;
  }

  if (raw) {
    console.warn(`[CONFIG][BOOTSTRAP] invalid BOOTSTRAP_NETWORK_MODE="${raw}", defaulting to ${DEFAULT_NETWORK_MODE}`);
  }

  return DEFAULT_NETWORK_MODE;
}

function validateBootstrapAnnounceAddress(address: string, isAnonymousMode: boolean): string | null {
  try {
    const announceAddress = multiaddr(address);
    const multiaddrComponents = announceAddress.getComponents();
    
    const protocols = multiaddrComponents.map((component) => component.code);
    const isOnion = protocols.includes(445);

    if (isOnion) {
      const onionTuple = multiaddrComponents.find((component) => component.code === 445);
      if (onionTuple?.value) {
        const [onionHost] = onionTuple.value.split(':');
        if (onionHost && !/^[a-z2-7]{56}$/i.test(onionHost)) {
          console.warn(`[BOOTSTRAP] Invalid onion v3 address ignored: ${address} (must be 56 characters base32)`);
          return null;
        }
      }
    }

    if (isAnonymousMode && !isOnion) {
      console.warn(`[CONFIG][BOOTSTRAP] ignoring non-onion announce address in anonymous mode: ${address}`);
      return null;
    }

    if (!isAnonymousMode && isOnion) {
      console.warn(`[CONFIG][BOOTSTRAP] ignoring onion announce address in fast mode: ${address}`);
      return null;
    }

    return address;
  } catch {
    console.warn(`[BOOTSTRAP] Invalid announce address ignored: ${address}`);
    return null;
  }
}

function readBootstrapAnnounceAddrs(isAnonymousMode: boolean): string[] {
  const rawAddrs = process.env.BOOTSTRAP_ANNOUNCE_ADDRS
    ?.split(',')
    .map((address) => address.trim())
    .filter(Boolean) ?? [];

  const validAddrs = rawAddrs
    .map((address) => validateBootstrapAnnounceAddress(address, isAnonymousMode))
    .filter((address): address is string => address !== null);

  // Deploy mode fails fast: every provided announce address must be valid for
  // the current mode, and at least one is required (a public node with no
  // reachable announce address is a misconfiguration).
  if (isDeploymentMode()) {
    const droppedCount = rawAddrs.length - validAddrs.length;
    if (droppedCount > 0) {
      throw new Error(
        `[CONFIG][BOOTSTRAP] deploy mode: ${droppedCount} invalid announce address(es) in ` +
          `BOOTSTRAP_ANNOUNCE_ADDRS for ${isAnonymousMode ? 'anonymous' : 'fast'} mode; aborting.`
      );
    }
    if (validAddrs.length === 0) {
      throw new Error(
        '[CONFIG][BOOTSTRAP] deploy mode: at least one valid announce address is required ' +
          '(set BOOTSTRAP_ANNOUNCE_ADDRS); aborting.'
      );
    }
  }

  return validAddrs;
}

function readBootstrapDatastorePath(networkMode: 'fast' | 'anonymous'): string {
  const raw = process.env.BOOTSTRAP_DATASTORE_PATH?.trim();
  if (raw) return resolve(raw);

  return resolve(join('./bootstrap-datastore', networkMode));
}

function readBootstrapListenAddr(networkMode: 'fast' | 'anonymous'): string {
  const defaultListenAddr = networkMode === NETWORK_MODES.ANONYMOUS
    ? '/ip4/127.0.0.1/tcp/9001'
    : BOOTSTRAP_LISTEN_ADDRESS;

  const raw = process.env.BOOTSTRAP_LISTEN_ADDRESS?.trim();
  if (!raw) return defaultListenAddr;

  try {
    multiaddr(raw);
    return raw;
  } catch {
    console.warn(`[CONFIG][BOOTSTRAP] invalid BOOTSTRAP_LISTEN_ADDRESS="${raw}", defaulting to ${defaultListenAddr}`);
    return defaultListenAddr;
  }
}

function readBootstrapPeerIdFile(networkMode: 'fast' | 'anonymous'): string {
  const raw = process.env.BOOTSTRAP_PEER_ID_FILE?.trim();
  if (raw) return raw;

  return networkMode === NETWORK_MODES.ANONYMOUS 
    ? BOOTSTRAP_PEER_ID_FILE.replace(/\.bin$/, '-anonymous.bin') 
    : BOOTSTRAP_PEER_ID_FILE;
}

// Federation: other bootstrap servers this node dials on startup so their
// kad-dht routing tables merge into one keyspace (a username PUT via any node
// is then findable via any node). @libp2p/bootstrap peerDiscovery does the
// initial dial; startFederationReconnect keeps the links up thereafter. The
// same full list can be injected on every node: createBootstrapNode filters
// out this node's own entry before use, so self is never dialed.
//
// Fast mode only. The anonymous onion bootstrap is inbound-only (no outbound
// Tor path), so it cannot dial peers; BOOTSTRAP_PEERS is ignored there.
function readBootstrapPeers(isAnonymousMode: boolean): string[] {
  if (isAnonymousMode) {
    console.warn(
      '[CONFIG][BOOTSTRAP] BOOTSTRAP_PEERS is set but ignored in anonymous mode ' +
        '(onion bootstrap is inbound-only and cannot dial peers)'
    );
    return [];
  }

  const raw = process.env.BOOTSTRAP_PEERS
    ?.split(',')
    .map((address) => address.trim())
    .filter(Boolean) ?? [];

  if (raw.length === 0) return [];

  const validPeers = raw.filter((address) => {
    try {
      // A federation peer must carry a peer id (/p2p/<id>) so the dialer can
      // authenticate the remote against its expected identity.
      return multiaddr(address).getPeerId() !== null;
    } catch {
      console.warn(`[CONFIG][BOOTSTRAP] ignoring invalid BOOTSTRAP_PEERS entry "${address}"`);
      return false;
    }
  });

  return validPeers;
}

function readBootstrapRuntimeConfig(): BootstrapRuntimeConfig {
  const networkMode = readBootstrapNetworkMode();
  const isAnonymousMode = networkMode === NETWORK_MODES.ANONYMOUS;
  const announceAddrs = readBootstrapAnnounceAddrs(isAnonymousMode);
  const runtimeConfig: BootstrapRuntimeConfig = {
    networkMode,
    modeConfig: getNetworkModeConfig(networkMode),
    modeRuntime: getNetworkModeRuntime(networkMode),
    torConfig: getTorConfig(),
    isAnonymousMode,
    listenAddr: readBootstrapListenAddr(networkMode),
    announceAddrs,
    datastorePath: readBootstrapDatastorePath(networkMode),
    peerIdFile: readBootstrapPeerIdFile(networkMode),
    maxConnections: Number(process.env.BOOTSTRAP_MAX_CONNECTIONS) || 1000,
    bootstrapPeers: readBootstrapPeers(isAnonymousMode),
  };

  if (runtimeConfig.isAnonymousMode && runtimeConfig.announceAddrs.length === 0) {
    console.warn('[CONFIG][BOOTSTRAP] anonymous mode configured without onion announce addresses');
  }

  return runtimeConfig;
}

function logBootstrapRuntimeConfig(runtimeConfig: BootstrapRuntimeConfig): void {
  console.log(`[CONFIG][BOOTSTRAP] mode=${runtimeConfig.networkMode}`);
  console.log('[CONFIG][BOOTSTRAP] transport=tcp');
  console.log(`[CONFIG][BOOTSTRAP] dhtProtocol=${runtimeConfig.modeConfig.dhtProtocol}`);
  console.log(`[CONFIG][BOOTSTRAP] listen=${runtimeConfig.listenAddr}`);
  console.log(`[CONFIG][BOOTSTRAP] announceCount=${runtimeConfig.announceAddrs.length}`);
  console.log(`[CONFIG][BOOTSTRAP] federationPeers=${runtimeConfig.bootstrapPeers.length}`);
  console.log(`[CONFIG][BOOTSTRAP] datastore=${runtimeConfig.datastorePath}`);
  console.log(`[CONFIG][BOOTSTRAP] peer_id_file=${runtimeConfig.peerIdFile}`);
  console.log(`[CONFIG][BOOTSTRAP] maxConnections=${runtimeConfig.maxConnections}`);
  console.log(
    `[CONFIG][BOOTSTRAP] tor_defaults_proxy=${runtimeConfig.torConfig.socksHost}:${runtimeConfig.torConfig.socksPort}`
  );
}

function createBootstrapValidateUpdate(runtimeConfig: BootstrapRuntimeConfig) {
  return async (key: Uint8Array, existing: Uint8Array, incoming: Uint8Array) => {
    const keyStr = new TextDecoder().decode(key);
    if (keyStr.startsWith(runtimeConfig.modeRuntime.dhtKeyPrefixes.offline)) {
      return offlineMessageValidateUpdate(key, existing, incoming);
    }
    if (keyStr.startsWith(runtimeConfig.modeRuntime.dhtKeyPrefixes.username)) {
      return usernameRegistrationValidateUpdate(key, existing, incoming);
    }
    if (keyStr.startsWith(runtimeConfig.modeRuntime.dhtKeyPrefixes.groupOffline)) {
      return groupOfflineValidateUpdate(key, existing, incoming);
    }
    if (keyStr.startsWith(runtimeConfig.modeRuntime.dhtKeyPrefixes.groupInfoLatest)) {
      return groupInfoLatestValidateUpdate(key, existing, incoming);
    }
    if (keyStr.startsWith(runtimeConfig.modeRuntime.dhtKeyPrefixes.groupInfoVersion)) {
      return groupInfoVersionedValidateUpdate(key, existing, incoming);
    }
    console.warn(
      `[MODE-GUARD][REJECT][dht_validate_update][bootstrap] mode=${runtimeConfig.networkMode} reason=unknown_namespace key=${keyStr}`
    );
    throw new Error('cross_mode_dht_key_rejected');
  };
}

function createBootstrapServices(runtimeConfig: BootstrapRuntimeConfig) {
  return {
    pubsub: gossipsub({
      doPX: true,
      fallbackToFloodsub: false,
      allowPublishToZeroTopicPeers: false,
    }),
    dht: kadDHT({
      protocol: runtimeConfig.modeConfig.dhtProtocol,
      peerInfoMapper: runtimeConfig.isAnonymousMode ? filterOnionAddressesMapper : passthroughMapper,
      clientMode: false,
      kBucketSize: K_BUCKET_SIZE,
      prefixLength: PREFIX_LENGTH,
      validators: {
        [runtimeConfig.modeRuntime.dhtNamespaceNames.offline]: offlineMessageValidator,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.username]: usernameRegistrationValidator,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.groupOffline]: groupOfflineMessageValidator,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.groupInfoLatest]: groupInfoLatestValidator,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.groupInfoVersion]: groupInfoVersionedValidator,
      },
      selectors: {
        [runtimeConfig.modeRuntime.dhtNamespaceNames.offline]: offlineMessageSelector,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.username]: usernameRegistrationSelector,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.groupOffline]: groupOfflineMessageSelector,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.groupInfoLatest]: groupInfoLatestSelector,
        [runtimeConfig.modeRuntime.dhtNamespaceNames.groupInfoVersion]: groupInfoVersionedSelector,
      },
      validateUpdate: createBootstrapValidateUpdate(runtimeConfig),
    }),
    identify: identify({
      runOnConnectionOpen: true,
      runOnLimitedConnection: true
    }),
    ping: ping({
      timeout: runtimeConfig.isAnonymousMode ? 60000 : 10000,
      runOnLimitedConnection: true
    }),
  };
}

// @libp2p/bootstrap dials each configured peer once at startup but never
// re-dials a link that later drops (its discovery is a one-shot timer). This
// safeguard periodically re-dials any federation peer that has stayed
// disconnected, so the mesh self-heals after an outage or a sibling restart
// without waiting for THIS node to restart. `peers` is already self-filtered.
const FEDERATION_RECONNECT_INTERVAL_MS = 30_000;
// Only re-dial after a peer has been seen disconnected on this many consecutive
// checks (~60s), so a brief blip that recovers on its own doesn't trigger a
// redundant dial. A genuine outage still heals: once past the threshold we
// re-dial every interval until the connection is back.
const FEDERATION_RECONNECT_MISS_THRESHOLD = 2;

function startFederationReconnect(node: ChatNode, peers: string[]): NodeJS.Timeout {
  const consecutiveMisses = new Map<string, number>();
  const maintainFederation = (): void => {
    const connected = new Set(node.getConnections().map((connection) => connection.remotePeer.toString()));
    // kad-dht only admits a peer to the routing table on peer:connect (via its
    // topology). A sibling can be evicted from the routing table while its TCP
    // connection stays up (connectionMonitor keeps the socket alive and we set
    // abortConnectionOnPingFailure:false), so peer:connect never re-fires and
    // the peer is never re-added — federation silently degrades even though
    // getConnections() still lists it. Re-assert routing-table membership for
    // every connected sibling each tick so an eviction self-heals.
    const routingTable = ((node.services as Record<string, unknown>).dht as
      { routingTable?: { add?: (peerId: PeerId) => Promise<void> } } | undefined)?.routingTable;
    for (const addr of peers) {
      let peerIdStr: string | null = null;
      try {
        peerIdStr = multiaddr(addr).getPeerId();
      } catch {
        continue;
      }
      if (peerIdStr === null) continue;
      if (connected.has(peerIdStr)) {
        consecutiveMisses.delete(peerIdStr);
        // add() is idempotent (no-op when already present) and ping-gated (skips
        // an unresponsive peer), so re-adding a live sibling every tick is safe.
        if (routingTable?.add) {
          void Promise.resolve(routingTable.add(peerIdFromString(peerIdStr))).catch(() => {});
        }
        continue;
      }
      const misses = (consecutiveMisses.get(peerIdStr) ?? 0) + 1;
      consecutiveMisses.set(peerIdStr, misses);
      if (misses < FEDERATION_RECONNECT_MISS_THRESHOLD) continue;
      node.dial(multiaddr(addr)).catch((error: unknown) => {
        console.warn(`[BOOTSTRAP][federation] reconnect dial to ${addr} failed: ${errStr(error)}`);
      });
    }
  };
  const timer = setInterval(maintainFederation, FEDERATION_RECONNECT_INTERVAL_MS);
  // Don't hold the event loop open solely for this timer.
  timer.unref?.();
  return timer;
}

function registerBootstrapLifecycleLogging(bootstrap: ChatNode, datastorePath: string): void {
  console.log(`Bootstrap Peer ID: ${bootstrap.peerId.toString()}`);
  console.log(`[CONFIG][BOOTSTRAP] datastore_opened=${datastorePath}`);

  bootstrap.getMultiaddrs().forEach((address) => {
    console.log(`Listening on: ${address.toString()}`);
  });

  bootstrap.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
    const peerId: PeerId = evt.detail;
    console.log(`Peer connected: ${peerId.toString()}`);
  });

  bootstrap.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
    const peerId: PeerId = evt.detail;
    console.log(`Peer disconnected: ${peerId.toString()}`);
  });

  console.log('Bootstrap node ready for connections...');
}

function registerBootstrapShutdownHandlers({ node, datastore, runtimeFile, federationReconnectTimer }: BootstrapRuntime): void {
  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nShutting down bootstrap node (${signal})...`);

    if (federationReconnectTimer) {
      clearInterval(federationReconnectTimer);
    }

    // Remove runtime metadata first so the CLI immediately stops treating this
    // node as healthy while it winds down.
    if (runtimeFile) {
      await removeRuntimeMetadataFile(runtimeFile);
    }

    try {
      await node.stop();
    } catch (stopError: unknown) {
      console.error(
        `[CONFIG][BOOTSTRAP] failed to stop libp2p cleanly: ${errStr(stopError)}`
      );
    }

    try {
      await datastore.close();
    } catch (closeError: unknown) {
      console.error(
        `[CONFIG][BOOTSTRAP] failed to close datastore cleanly: ${errStr(closeError)}`
      );
    }

    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

async function createBootstrapNode(): Promise<BootstrapRuntime> {
  const runtimeConfig = readBootstrapRuntimeConfig();
  const runtimeFile = getRuntimeMetadataPath();

  // Clear any stale runtime metadata before we become healthy so the CLI never
  // reads addresses from a previous run while this process is still starting.
  // In deploy mode this is part of the control-plane contract, so a failure to
  // clear stale metadata aborts startup.
  if (runtimeFile) {
    await removeRuntimeMetadataFile(runtimeFile, { required: isDeploymentMode() });
  }

  const { peerId, privateKey } = await PeerIdManager.loadOrCreate(runtimeConfig.peerIdFile, {
    failClosed: isDeploymentMode(),
  });

  // Federation peers minus this node's own entry. The same full list is
  // deployed to every node, so each must drop itself — a self-dial is rejected
  // by libp2p and would otherwise log an error on every reconnect tick.
  const selfPeerId = peerId.toString();
  const federationPeers = runtimeConfig.bootstrapPeers.filter((addr) => {
    try {
      return multiaddr(addr).getPeerId() !== selfPeerId;
    } catch {
      return false;
    }
  });

  await mkdir(runtimeConfig.datastorePath, { recursive: true });
  const datastore = new LevelDatastore(runtimeConfig.datastorePath);
  await datastore.open();
  const libp2pDatastore = datastore as unknown as Datastore;
  logBootstrapRuntimeConfig(runtimeConfig);

  try {
    const bootstrap = await createLibp2p({
      privateKey: privateKey,
      datastore: libp2pDatastore,
      addresses: {
        listen: [runtimeConfig.listenAddr],
        announce: runtimeConfig.announceAddrs
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      // Federate with sibling bootstraps when configured (fast mode only): the
      // bootstrap module performs the initial dial + tags them; the periodic
      // startFederationReconnect (after start) heals any dropped link. Self is
      // already filtered out of federationPeers above.
      ...(federationPeers.length > 0
        ? { peerDiscovery: [bootstrapDiscovery({ list: federationPeers })] }
        : {}),
      connectionManager: {
        // Every Kiyeovo client holds up to 3 long-lived bootstrap connections
        // (MAX_BOOTSTRAP_NODES_FAST) and runs the DHT in server mode, so a
        // public bootstrap's connection count scales directly with online
        // users. 500 across the fleet started pruning around ~1.6k concurrent
        // users; per-connection memory is tens of KB, so 1000 is cheap even on
        // a 2 GB box. Env-tunable per deployment like the relay's knobs.
        maxConnections: runtimeConfig.maxConnections,
        maxPeerAddrsToDial: 10,
        // Absorb reconnect storms after a bootstrap restart (default 10
        // concurrent inbound handshakes) and don't rate-limit CGNAT clusters —
        // mobile carriers put many users behind one source IP (default 5
        // conns/s/host).
        maxIncomingPendingConnections: 100,
        inboundConnectionThreshold: 25,
      },
      connectionMonitor: {
        enabled: true,
        pingInterval: runtimeConfig.isAnonymousMode ? 120000 : 30000,
        pingTimeout: {
          minTimeout: runtimeConfig.isAnonymousMode ? 30000 : 5000,
          maxTimeout: runtimeConfig.isAnonymousMode ? 120000 : 30000,
        },
        // Let app-level health monitoring interpret ping failures and trigger reconnect policy
        // without force-closing connections on transient misses.
        abortConnectionOnPingFailure: false,
      },
      services: createBootstrapServices(runtimeConfig),
    });

    await bootstrap.start();

    if (runtimeFile) {
      const peerId = bootstrap.peerId.toString();
      const metadata: ServiceRuntimeMetadata = {
        schemaVersion: 1,
        role: 'bootstrap',
        networkMode: runtimeConfig.networkMode,
        peerId,
        announceAddrs: runtimeConfig.announceAddrs,
        clientAddrs: buildClientAddrs(runtimeConfig.announceAddrs, peerId),
        version: getServerVersion(),
        startedAt: new Date().toISOString(),
      };
      await writeRuntimeMetadata(runtimeFile, metadata, { required: isDeploymentMode() });
    }

    const federationReconnectTimer = federationPeers.length > 0
      ? startFederationReconnect(bootstrap as ChatNode, federationPeers)
      : undefined;

    return {
      node: bootstrap as ChatNode,
      datastore,
      datastorePath: runtimeConfig.datastorePath,
      runtimeFile,
      federationReconnectTimer,
    };
  } catch (error: unknown) {
    try {
      await datastore.close();
    } catch (closeError: unknown) {
      console.warn(
        `[CONFIG][BOOTSTRAP] failed to close datastore after startup error: ${errStr(closeError)}`
      );
    }
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const bootstrapRuntime = await createBootstrapNode();
    registerBootstrapLifecycleLogging(bootstrapRuntime.node, bootstrapRuntime.datastorePath);
    registerBootstrapShutdownHandlers(bootstrapRuntime);
  } catch (err: unknown) {
    console.error('Failed to start bootstrap node:', errStr(err, 'Unknown error'));
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(console.error);
