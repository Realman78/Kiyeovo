import assert from 'node:assert/strict';
import test from 'node:test';

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';

import { NETWORK_MODES } from '../constants.js';
import { createConnectionGater } from './connection-gater.js';

import type { ChatDatabase } from '../db/database.js';
import type { NetworkMode } from '../types.js';

const ONION = '/onion3/vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd:9000';
const CLEARNET = '/ip4/198.51.100.7/tcp/9000';
const DNS4 = '/dns4/beacon.attacker.example/tcp/9000';

// The gater only reaches for isBlocked / getSetting / getChatByPeerId.
const stubDatabase = {
  isBlocked: () => false,
  getSetting: () => null,
  getChatByPeerId: () => null,
} as unknown as ChatDatabase;

/**
 * Merge a mixed address set into a real libp2p peer store and report what survived.
 *
 * This asserts the wiring, not just our predicate: libp2p installs
 * `connectionGater.filterMultiaddrForPeer` as the peer store's `addressFilter`, which
 * is what makes the anonymous-mode address rule cover every peer-supplied address —
 * the `multiaddrs` field of a username DHT record and identify's self-declared
 * listenAddrs alike. If a libp2p upgrade ever moves that hook, the unit tests on the
 * predicate would still pass while the protection silently disappeared. This test is
 * the tripwire for that.
 */
async function storedAfterMerge(networkMode: NetworkMode): Promise<string[]> {
  const selfKey = await generateKeyPair('Ed25519');
  const node = await createLibp2p({
    privateKey: selfKey,
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: createConnectionGater(
      stubDatabase,
      peerIdFromPrivateKey(selfKey),
      networkMode,
    ),
  });

  try {
    const remotePeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
    await node.peerStore.merge(remotePeerId, {
      multiaddrs: [multiaddr(ONION), multiaddr(CLEARNET), multiaddr(DNS4)],
    });

    const peer = await node.peerStore.get(remotePeerId);
    return peer.addresses.map((a) => a.multiaddr.toString());
  } finally {
    await node.stop();
  }
}

test('anonymous mode: libp2p stores only the onion address from a peer-supplied set', async () => {
  const stored = await storedAfterMerge(NETWORK_MODES.ANONYMOUS);

  assert.deepEqual(stored, [ONION]);
});

test('fast mode: libp2p stores every peer-supplied address', async () => {
  const stored = await storedAfterMerge(NETWORK_MODES.FAST);

  assert.equal(stored.length, 3);
  assert.ok(stored.includes(ONION));
  assert.ok(stored.includes(CLEARNET));
  assert.ok(stored.includes(DNS4));
});

test('anonymous mode: denyDialMultiaddr blocks clearnet and allows onion', async () => {
  const selfKey = await generateKeyPair('Ed25519');
  const gater = createConnectionGater(
    stubDatabase,
    peerIdFromPrivateKey(selfKey),
    NETWORK_MODES.ANONYMOUS,
  );

  assert.equal(await gater.denyDialMultiaddr?.(multiaddr(CLEARNET)), true);
  assert.equal(await gater.denyDialMultiaddr?.(multiaddr(DNS4)), true);
  assert.equal(await gater.denyDialMultiaddr?.(multiaddr(ONION)), false);
});

test('fast mode: denyDialMultiaddr does not block clearnet', async () => {
  const selfKey = await generateKeyPair('Ed25519');
  const gater = createConnectionGater(
    stubDatabase,
    peerIdFromPrivateKey(selfKey),
    NETWORK_MODES.FAST,
  );

  assert.equal(await gater.denyDialMultiaddr?.(multiaddr(CLEARNET)), false);
  assert.equal(await gater.denyDialMultiaddr?.(multiaddr(ONION)), false);
});

test('denyDialMultiaddr still blocks self-dials in both modes', async () => {
  for (const mode of [NETWORK_MODES.ANONYMOUS, NETWORK_MODES.FAST] as const) {
    const selfKey = await generateKeyPair('Ed25519');
    const selfPeerId = peerIdFromPrivateKey(selfKey);
    const gater = createConnectionGater(stubDatabase, selfPeerId, mode);

    // Onion in anonymous mode / clearnet in fast mode would otherwise be allowed.
    const base = mode === NETWORK_MODES.ANONYMOUS ? ONION : CLEARNET;
    const selfAddr = multiaddr(`${base}/p2p/${selfPeerId.toString()}`);

    assert.equal(await gater.denyDialMultiaddr?.(selfAddr), true);
  }
});
