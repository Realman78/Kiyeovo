import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import dotenv from 'dotenv';

import type { PeerId } from '@libp2p/interface';

import { PeerIdManager } from './network/peer-id-manager.js';
import { isDeploymentMode } from './server/deploy-mode.js';
import {
  buildClientAddrs,
  getRuntimeMetadataPath,
  getServerVersion,
  removeRuntimeMetadataFile,
  writeRuntimeMetadata,
} from './server/runtime-metadata.js';
import { errStr } from './utils/general-error.js';

dotenv.config();

const DEFAULT_RELAY_PEER_ID_FILE = './relay-peer-id.bin';
const DEFAULT_RELAY_LISTEN_ADDRESS = '/ip4/0.0.0.0/tcp/4002';

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseAnnounceAddrs(): string[] {
  const raw = (process.env.RELAY_ANNOUNCE_ADDRS ?? '')
    .split(',')
    .map(addr => addr.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const addr of raw) {
    try {
      multiaddr(addr);
      out.push(addr);
    } catch {
      console.warn(`[RELAY] Invalid announce address ignored: ${addr}`);
    }
  }

  // Deploy mode fails fast: every provided announce address must parse, and at
  // least one is required so clients have a reachable address to dial.
  if (isDeploymentMode()) {
    const droppedCount = raw.length - out.length;
    if (droppedCount > 0) {
      throw new Error(
        `[CONFIG][RELAY] deploy mode: ${droppedCount} invalid announce address(es) in ` +
          'RELAY_ANNOUNCE_ADDRS; aborting.'
      );
    }
    if (out.length === 0) {
      throw new Error(
        '[CONFIG][RELAY] deploy mode: at least one valid announce address is required ' +
          '(set RELAY_ANNOUNCE_ADDRS); aborting.'
      );
    }
  }

  return out;
}

async function createRelayNode() {
  const peerIdFile = process.env.RELAY_PEER_ID_FILE?.trim() || DEFAULT_RELAY_PEER_ID_FILE;
  const listenAddress = process.env.RELAY_LISTEN_ADDRESS?.trim() || DEFAULT_RELAY_LISTEN_ADDRESS;
  const announceAddrs = parseAnnounceAddrs();

  // Launch-scale defaults (env overrides win). The circuit-relay-v2 library
  // defaults are sized for incidental relaying between full p2p nodes, not for
  // a public relay serving NAT-restricted chat clients:
  // - maxReservations: library default is 15 — i.e. only 15 NATed peers per
  //   relay could hold a slot to be dialable at all. 512 slots are nearly free
  //   (a record + keepalive each).
  // - defaultDataLimit: library default is 128 KB, which kills any relayed
  //   file transfer (the last-resort path when DCUtR hole-punching fails on
  //   both sides). 64 MB covers realistic transfers without opening the relay
  //   to unbounded bulk abuse.
  // - defaultDurationLimit: was 5 min here (library: 2 min); long-lived idle
  //   chat connections get cut and re-established each expiry, so 30 min
  //   trades a little relay accounting for far less churn.
  const maxReservations = parseOptionalPositiveInt(process.env.RELAY_MAX_RESERVATIONS) ?? 512;
  const reservationTtl = parseOptionalPositiveInt(process.env.RELAY_RESERVATION_TTL_MS);
  const defaultDurationLimit = parseOptionalPositiveInt(process.env.RELAY_DEFAULT_DURATION_LIMIT_MS) ?? 30 * 60 * 1000;
  const defaultDataLimit = parseOptionalPositiveInt(process.env.RELAY_DEFAULT_DATA_LIMIT_BYTES) ?? 64 * 1024 * 1024;

  const runtimeFile = getRuntimeMetadataPath();

  // Clear any stale runtime metadata before we become healthy so the CLI never
  // reads addresses from a previous run while this process is still starting.
  // In deploy mode this is part of the control-plane contract, so a failure to
  // clear stale metadata aborts startup.
  if (runtimeFile) {
    await removeRuntimeMetadataFile(runtimeFile, { required: isDeploymentMode() });
  }

  const { privateKey } = await PeerIdManager.loadOrCreate(peerIdFile, {
    failClosed: isDeploymentMode(),
  });

  console.log('[CONFIG][RELAY] mode=fast');
  console.log(`[CONFIG][RELAY] listen=${listenAddress}`);
  console.log(`[CONFIG][RELAY] announceCount=${announceAddrs.length}`);
  console.log(`[CONFIG][RELAY] maxReservations=${maxReservations ?? 'default'}`);
  console.log(`[CONFIG][RELAY] reservationTtlMs=${reservationTtl ?? 'default'}`);
  console.log(`[CONFIG][RELAY] durationLimitMs=${defaultDurationLimit ?? 'default'}`);
  console.log(`[CONFIG][RELAY] dataLimitBytes=${defaultDataLimit ?? 'default'}`);

  const relay = await createLibp2p({
    privateKey,
    addresses: {
      listen: [listenAddress],
      announce: announceAddrs,
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: {
      maxConnections: 1000,
      maxPeerAddrsToDial: 20,
      // Absorb reconnect storms after a relay restart (default 10 concurrent
      // inbound handshakes) and don't rate-limit CGNAT clusters — mobile
      // carriers put many users behind one source IP (default 5 conns/s/host).
      maxIncomingPendingConnections: 100,
      inboundConnectionThreshold: 25,
    },
    services: {
      identify: identify({
        runOnConnectionOpen: true,
        runOnLimitedConnection: true
      }),
      ping: ping({
        timeout: 10000,
        runOnLimitedConnection: true
      }),
      circuitRelay: circuitRelayServer({
        reservations: {
          ...(maxReservations != null ? { maxReservations } : {}),
          ...(reservationTtl != null ? { reservationTtl } : {}),
          ...(defaultDurationLimit != null ? { defaultDurationLimit } : {}),
          ...(defaultDataLimit != null ? { defaultDataLimit: BigInt(defaultDataLimit) } : {}),
        },
      }),
    },
  });

  await relay.start();

  if (runtimeFile) {
    const peerId = relay.peerId.toString();
    await writeRuntimeMetadata(runtimeFile, {
      schemaVersion: 1,
      role: 'relay',
      networkMode: 'fast',
      peerId,
      announceAddrs,
      clientAddrs: buildClientAddrs(announceAddrs, peerId),
      version: getServerVersion(),
      startedAt: new Date().toISOString(),
    }, { required: isDeploymentMode() });
  }

  return { relay, runtimeFile };
}

function registerRelayShutdownHandlers(
  relay: { stop: () => void | Promise<void> },
  runtimeFile: string | undefined
): void {
  let shuttingDown = false;
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nShutting down relay node (${signal})...`);

    // Remove runtime metadata first so the CLI immediately stops treating this
    // node as healthy while it winds down.
    if (runtimeFile) {
      await removeRuntimeMetadataFile(runtimeFile);
    }

    try {
      await relay.stop();
    } catch (stopError: unknown) {
      console.error(`[CONFIG][RELAY] failed to stop libp2p cleanly: ${errStr(stopError)}`);
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

async function main(): Promise<void> {
  try {
    const { relay, runtimeFile } = await createRelayNode();
    console.log(`Relay Peer ID: ${relay.peerId.toString()}`);

    relay.getMultiaddrs().forEach(addr => {
      console.log(`Listening on: ${addr.toString()}`);
    });

    relay.addEventListener('peer:connect', (evt: CustomEvent<PeerId>) => {
      console.log(`Peer connected: ${evt.detail.toString()}`);
    });

    relay.addEventListener('peer:disconnect', (evt: CustomEvent<PeerId>) => {
      console.log(`Peer disconnected: ${evt.detail.toString()}`);
    });

    console.log('Relay node ready for reservations...');

    registerRelayShutdownHandlers(relay, runtimeFile);
  } catch (err: unknown) {
    console.error('Failed to start relay node:', errStr(err, 'Unknown error'));
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

main().catch(console.error);
