import assert from 'node:assert/strict';
import test from 'node:test';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';

import { filterToDirectPublicAddressesMapper } from './dht-address-mapper.js';

const ID = peerIdFromString('12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K');
const RELAY = '12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM';
const CIRCUIT = `/ip4/167.172.115.233/tcp/4002/p2p/${RELAY}/p2p-circuit/p2p/${ID.toString()}`;

const mk = (addrs: string[]) => ({ id: ID, multiaddrs: addrs.map((a) => multiaddr(a)) });
const mapped = (addrs: string[]) =>
  filterToDirectPublicAddressesMapper(mk(addrs)).multiaddrs.map((m) => m.toString());

test('keeps a public direct address', () => {
  assert.deepEqual(mapped(['/ip4/167.172.115.233/tcp/9000']), ['/ip4/167.172.115.233/tcp/9000']);
});

test('drops a private (LAN) address', () => {
  assert.deepEqual(mapped(['/ip4/192.168.1.5/tcp/9000']), []);
});

test('drops a loopback address', () => {
  assert.deepEqual(mapped(['/ip4/127.0.0.1/tcp/9000']), []);
});

test('drops a relay/circuit address despite its public relay IP prefix', () => {
  // This is the case removePrivateAddressesMapper alone would wrongly keep.
  assert.deepEqual(mapped([CIRCUIT]), []);
});

test('keeps only the public direct address from a mixed set', () => {
  assert.deepEqual(
    mapped([
      '/ip4/8.8.8.8/tcp/9000',   // public direct -> keep
      '/ip4/10.0.0.4/tcp/9000',  // private       -> drop
      '/ip4/127.0.0.1/tcp/9000', // loopback      -> drop
      CIRCUIT,                   // relay         -> drop
    ]),
    ['/ip4/8.8.8.8/tcp/9000'],
  );
});

test('keeps a public dns address', () => {
  assert.deepEqual(mapped(['/dns4/bootstrap.example.com/tcp/9000']), ['/dns4/bootstrap.example.com/tcp/9000']);
});

test('a NAT-only peer (private + relay) is left with zero addresses', () => {
  // -> kad-dht onPeerConnect skips it, so it never enters the routing table.
  assert.deepEqual(mapped(['/ip4/192.168.0.10/tcp/9000', CIRCUIT]), []);
});
