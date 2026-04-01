import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
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

  return rawAddrs
    .map((address) => validateBootstrapAnnounceAddress(address, isAnonymousMode))
    .filter((address): address is string => address !== null);
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
    datastorePath: resolve(join('./bootstrap-datastore', networkMode)),
    peerIdFile: readBootstrapPeerIdFile(networkMode),
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
  console.log(`[CONFIG][BOOTSTRAP] datastore=${runtimeConfig.datastorePath}`);
  console.log(`[CONFIG][BOOTSTRAP] peer_id_file=${runtimeConfig.peerIdFile}`);
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

function registerBootstrapShutdownHandlers({ node, datastore }: BootstrapRuntime): void {
  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nShutting down bootstrap node (${signal})...`);

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
  const { privateKey } = await PeerIdManager.loadOrCreate(runtimeConfig.peerIdFile);

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
      connectionManager: {
        maxConnections: 500,
        maxPeerAddrsToDial: 10,
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
    return {
      node: bootstrap as ChatNode,
      datastore,
      datastorePath: runtimeConfig.datastorePath,
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
