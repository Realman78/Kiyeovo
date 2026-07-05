import { createLibp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { kadDHT, passthroughMapper } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { multiaddr } from '@multiformats/multiaddr';
import { tcp, type TCPComponents } from '@libp2p/tcp';
import type { Transport } from '@libp2p/interface';

import type { BootstrapAddressResolution, ChatNode, NetworkMode } from '../types.js';

import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import { offlineMessageValidator, offlineMessageSelector, offlineMessageValidateUpdate } from '../direct/offline-message-validator.js';
import {
  usernameRegistrationSelector,
  usernameRegistrationValidateUpdate,
  usernameRegistrationValidator,
} from '../username/username-dht-validator.js';
import {
  groupOfflineMessageValidator, groupOfflineMessageSelector, groupOfflineValidateUpdate,
  groupInfoLatestValidator, groupInfoLatestSelector, groupInfoLatestValidateUpdate,
  groupInfoVersionedValidator, groupInfoVersionedSelector, groupInfoVersionedValidateUpdate,
} from '../group/dht/group-dht-validator.js';
import {
  CHAT_NODE_INBOUND_CONNECTION_THRESHOLD_PER_HOST,
  CHAT_NODE_INBOUND_UPGRADE_TIMEOUT_MS,
  CHAT_NODE_MAX_CONNECTIONS,
  CHAT_NODE_MAX_INCOMING_PENDING_CONNECTIONS,
  K_BUCKET_SIZE,
  NETWORK_MODES,
  PREFIX_LENGTH,
  getNetworkModeConfig,
  getNetworkModeRuntime,
  getTorConfig,
} from '../constants.js';
import { filterOnionAddressesMapper } from '../utils/miscellaneous.js';
import { generalErrorHandler } from '../utils/general-error.js';
import { createConnectionGater } from './connection-gater.js';
import { ChatDatabase } from '../db/database.js';
import { torTransport, validateTorConnection, type TorTransportComponents } from '../transport/tor-transport.js';
import { resolveBootstrapAddressesForCurrentMode, extractTorBootstrapTargets } from './node-bootstrap.js';
import { getConfiguredFastRelayAddrs, type FastRelayConfig } from './node-relays.js';
import { log } from '../../shared/logger.js';

type RelayRuntime = {
  relayTransportFactory: ReturnType<typeof circuitRelayTransport> | null;
  dcutrFactory: ((components: unknown) => unknown) | null;
};

type ChatNodeRelayConfig = FastRelayConfig | {
  addresses: [];
  source: 'none';
};

type ChatNodeRuntimeConfig = {
  port: number;
  networkMode: NetworkMode;
  isAnonymousMode: boolean;
  modeConfig: ReturnType<typeof getNetworkModeConfig>;
  modeRuntime: ReturnType<typeof getNetworkModeRuntime>;
  bootstrapResolution: BootstrapAddressResolution;
  relayConfig: ChatNodeRelayConfig;
  relayRuntime: RelayRuntime;
  torConfig: ReturnType<typeof getTorConfig>;
};

export function createTransportArray(params: {
  networkMode: NetworkMode;
  torConfig: ReturnType<typeof getTorConfig>;
  relayTransportFactory: ReturnType<typeof circuitRelayTransport> | null;
}): Array<(components: TCPComponents & TorTransportComponents) => Transport> {
  const { networkMode, torConfig, relayTransportFactory } = params;

  if (networkMode === NETWORK_MODES.ANONYMOUS) {
    // When Tor is enabled, we need both TCP (for listening) and Tor (for dialing)
    return [
      tcp(),
      torTransport({
        socksProxy: {
          host: torConfig.socksHost,
          port: torConfig.socksPort,
        },
        connectionTimeout: torConfig.connectionTimeout,
        maxRetries: torConfig.maxRetries,
      }),
    ];
  }

  const transports: Array<(components: TCPComponents & TorTransportComponents) => Transport> = [tcp()];
  if (relayTransportFactory !== null) {
    transports.push(relayTransportFactory as (components: TCPComponents & TorTransportComponents) => Transport);
  }

  log(`[CONFIG][FAST] Tor disabled. relayTransport=${relayTransportFactory !== null ? 'enabled' : 'disabled'}`);
  return transports;
}

function getFastModeListenAddrs(port: number): string[] {
  return [`/ip4/0.0.0.0/tcp/${port}`, '/p2p-circuit'];
}

function getRelayRuntime(networkMode: NetworkMode): RelayRuntime {
  if (networkMode !== NETWORK_MODES.FAST) {
    return { relayTransportFactory: null, dcutrFactory: null };
  }

  return {
    relayTransportFactory: circuitRelayTransport(),
    dcutrFactory: dcutr() as unknown as (components: unknown) => unknown,
  };
}

function getTorConfigFromSettings(database: ChatDatabase): ReturnType<typeof getTorConfig> {
  const base = getTorConfig();
  const get = (key: string) => database.getSetting(key);

  const socksHost = get('tor_socks_host');
  const socksPort = get('tor_socks_port');
  const connectionTimeout = get('tor_connection_timeout');
  const circuitTimeout = get('tor_circuit_timeout');
  const maxRetries = get('tor_max_retries');
  const healthCheckInterval = get('tor_health_check_interval');
  const dnsResolution = get('tor_dns_resolution');

  return {
    socksHost: socksHost ?? base.socksHost,
    socksPort: socksPort ? parseInt(socksPort, 10) : base.socksPort,
    connectionTimeout: connectionTimeout ? parseInt(connectionTimeout, 10) : base.connectionTimeout,
    circuitTimeout: circuitTimeout ? parseInt(circuitTimeout, 10) : base.circuitTimeout,
    maxRetries: maxRetries ? parseInt(maxRetries, 10) : base.maxRetries,
    healthCheckInterval: healthCheckInterval ? parseInt(healthCheckInterval, 10) : base.healthCheckInterval,
    dnsResolution: (dnsResolution as 'tor' | 'system' | null) ?? base.dnsResolution,
  };
}

function getConfiguredAnnounceAddresses(
  database: ChatDatabase,
  runtimeConfig: ChatNodeRuntimeConfig,
): string[] {
  const announceAddrs: string[] = [];
  const onionAddress = database.getSetting('tor_onion_address');

  if (runtimeConfig.networkMode === NETWORK_MODES.ANONYMOUS && onionAddress) {
    const onionHost = onionAddress.replace('.onion', '');
    const announceAddr = `/onion3/${onionHost}:${runtimeConfig.port}`;
    try {
      multiaddr(announceAddr);
      announceAddrs.push(announceAddr);
      log(`Using onion announce address: ${announceAddr}`);
    } catch {
      console.warn(`Invalid onion announce address ignored: ${announceAddr}`);
    }
  }

  if (process.env.ANNOUNCE_ADDRS) {
    const rawAddrs = process.env.ANNOUNCE_ADDRS.split(',').map((addr) => addr.trim()).filter(Boolean);
    for (const addr of rawAddrs) {
      try {
        multiaddr(addr);
        if (!announceAddrs.includes(addr)) {
          announceAddrs.push(addr);
        }
      } catch {
        console.warn(`Invalid announce address ignored: ${addr}`);
      }
    }
  }

  return announceAddrs;
}

function readChatNodeRuntimeConfig(port: number, database: ChatDatabase): ChatNodeRuntimeConfig {
  const networkMode = database.getSessionNetworkMode();

  return {
    port,
    networkMode,
    isAnonymousMode: networkMode === NETWORK_MODES.ANONYMOUS,
    modeConfig: getNetworkModeConfig(networkMode),
    modeRuntime: getNetworkModeRuntime(networkMode),
    bootstrapResolution: resolveBootstrapAddressesForCurrentMode(database),
    relayConfig: networkMode === NETWORK_MODES.FAST
      ? getConfiguredFastRelayAddrs(database)
      : { addresses: [], source: 'none' },
    relayRuntime: getRelayRuntime(networkMode),
    torConfig: getTorConfigFromSettings(database),
  };
}

function logChatNodeRuntimeConfig(runtimeConfig: ChatNodeRuntimeConfig): void {
  console.log(`[CONFIG] mode=${runtimeConfig.networkMode}`);
  console.log(
    `[CONFIG] protocol=${runtimeConfig.modeConfig.protocolName} dhtProtocol=${runtimeConfig.modeConfig.dhtProtocol}`
  );
  console.log(`[CONFIG] bootstrapConfigured=${runtimeConfig.bootstrapResolution.addresses.length}`);
  console.log(
    `[CONFIG] transport=${runtimeConfig.isAnonymousMode ? 'tcp+tor-socks' : 'tcp+relay(+dcutr)'}`
  );
  console.log(
    `[CONFIG] relaySource=${runtimeConfig.relayConfig.source} relayConfigured=${runtimeConfig.relayConfig.addresses.length}`
  );

  if (!runtimeConfig.isAnonymousMode) {
    log('[CONFIG][FAST] relay runtime loaded');
  }
}

function logAnonymousModePreflight(runtimeConfig: ChatNodeRuntimeConfig): void {
  console.log('Tor transport enabled - routing through SOCKS5 proxy');
  console.log(`Initial Proxy: ${runtimeConfig.torConfig.socksHost}:${runtimeConfig.torConfig.socksPort}`);
}

async function validateAnonymousModeConnectivity(runtimeConfig: ChatNodeRuntimeConfig): Promise<boolean> {
  const bootstrapTargets = extractTorBootstrapTargets(runtimeConfig.bootstrapResolution.addresses);
  console.log('Validating Tor connectivity...');
  const { available: torAvailable } = await validateTorConnection({
    socksProxy: {
      host: runtimeConfig.torConfig.socksHost,
      port: runtimeConfig.torConfig.socksPort,
    },
    connectionTimeout: runtimeConfig.torConfig.connectionTimeout,
    maxRetries: runtimeConfig.torConfig.maxRetries,
  }, bootstrapTargets);

  return torAvailable;
}

async function runNodeModePreflight(runtimeConfig: ChatNodeRuntimeConfig): Promise<void> {
  if (!runtimeConfig.isAnonymousMode) {
    log('Fast mode selected: using direct TCP + relay/DCUtR path');
    return;
  }

  logAnonymousModePreflight(runtimeConfig);
  const torAvailable = await validateAnonymousModeConnectivity(runtimeConfig);

  if (!torAvailable) {
    console.error('WARNING: Tor connectivity check failed!');
    console.error(
      `  Make sure Tor is running and accessible via ${runtimeConfig.torConfig.socksHost}:${runtimeConfig.torConfig.socksPort}`
    );
    console.error('  Continuing anyway, but connections may fail...');
    return;
  }

  console.log('Tor connectivity validated');
}

function getChatNodeAddresses(
  database: ChatDatabase,
  runtimeConfig: ChatNodeRuntimeConfig,
): {
  listen: string[];
  announce: string[];
} {
  const announceAddrs = getConfiguredAnnounceAddresses(database, runtimeConfig);

  return {
    listen: runtimeConfig.isAnonymousMode
      ? [`/ip4/0.0.0.0/tcp/${runtimeConfig.port}`]
      : getFastModeListenAddrs(runtimeConfig.port),
    announce: runtimeConfig.isAnonymousMode ? announceAddrs : [],
  };
}

function createDhtValidateUpdate(runtimeConfig: ChatNodeRuntimeConfig) {
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
      `[MODE-GUARD][REJECT][dht_validate_update] mode=${runtimeConfig.networkMode} reason=unknown_namespace key=${keyStr}`
    );
    throw new Error('cross_mode_dht_key_rejected');
  };
}

function createChatNodeServices(runtimeConfig: ChatNodeRuntimeConfig) {
  return {
    pubsub: gossipsub({
      emitSelf: false,
      runOnLimitedConnection: true,
      fallbackToFloodsub: false,
      allowPublishToZeroTopicPeers: false,
    }),
    dht: kadDHT({
      protocol: runtimeConfig.modeConfig.dhtProtocol,
      peerInfoMapper: runtimeConfig.isAnonymousMode ? filterOnionAddressesMapper : passthroughMapper,
      clientMode: false,
      kBucketSize: K_BUCKET_SIZE,
      prefixLength: PREFIX_LENGTH,
      // Bound the per-peer DHT dial/request. libp2p's AdaptiveTimeout grows on
      // failure (next.push(time * 2)) up to 60s, so after a restart against many
      // dead/stale peers the per-peer timeout balloons and a single offline
      // closest-peer (no relay reservation + stale cross-subnet LAN addr) can
      // stall a put/get past its overall budget. Capping maxTimeout keeps the
      // runaway in check: the dead peer aborts fast (QUERY_ERROR) while reachable
      // closest peers still get the record. (networkDialTimeout is wired to the
      // DHT Network via patches/@libp2p+kad-dht+15.1.11.patch — upstream drops it.)
      networkDialTimeout: { minTimeout: 5_000, maxTimeout: 8_000 },
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
      validateUpdate: createDhtValidateUpdate(runtimeConfig),
    }),
    identify: identify({
      runOnConnectionOpen: true,
      runOnLimitedConnection: true
    }),
    ping: ping({
      timeout: runtimeConfig.isAnonymousMode ? 60000 : 10000,
      runOnLimitedConnection: true,
      // A single health-probe ping that fails/aborts can leave its outbound stream
      // stuck, permanently occupying the only slot  so every later probe fails
      maxOutboundStreams: 8,
    }),
    ...(runtimeConfig.networkMode === NETWORK_MODES.FAST && runtimeConfig.relayRuntime.dcutrFactory
      ? { dcutr: runtimeConfig.relayRuntime.dcutrFactory }
      : {}),
  };
}

export async function createChatNode(
  port: number,
  userIdentity: EncryptedUserIdentity,
  database: ChatDatabase,
): Promise<ChatNode> {
  try {
    if (port < 1024 || port > 65535) {
      throw new Error(`Invalid port: ${port}. Must be between 1024-65535`);
    }

    const privateKey = userIdentity.getLibp2pPrivateKey();
    const runtimeConfig = readChatNodeRuntimeConfig(port, database);

    logChatNodeRuntimeConfig(runtimeConfig);
    await runNodeModePreflight(runtimeConfig);

    const transports = createTransportArray({
      networkMode: runtimeConfig.networkMode,
      torConfig: runtimeConfig.torConfig,
      relayTransportFactory: runtimeConfig.relayRuntime.relayTransportFactory,
    });
    const addresses = getChatNodeAddresses(database, runtimeConfig);

    const node = await createLibp2p({
      privateKey,
      addresses,
      transports,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: CHAT_NODE_MAX_CONNECTIONS,
        inboundConnectionThreshold: CHAT_NODE_INBOUND_CONNECTION_THRESHOLD_PER_HOST,
        maxIncomingPendingConnections: CHAT_NODE_MAX_INCOMING_PENDING_CONNECTIONS,
        inboundUpgradeTimeout: CHAT_NODE_INBOUND_UPGRADE_TIMEOUT_MS,
      },
      connectionMonitor: {
        enabled: true,
        pingInterval: runtimeConfig.isAnonymousMode ? 120000 : 30000,
        pingTimeout: {
          minTimeout: runtimeConfig.isAnonymousMode ? 30000 : 5000,
          maxTimeout: runtimeConfig.isAnonymousMode ? 120000 : 30000,
        },
        abortConnectionOnPingFailure: false,
      },
      connectionGater: createConnectionGater(database),
      services: createChatNodeServices(runtimeConfig),
    });

    await node.start();
    return node as ChatNode;
  } catch (error: unknown) {
    generalErrorHandler(error);
    throw error;
  }
}
