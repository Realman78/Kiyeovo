import assert from 'node:assert/strict';
import test from 'node:test';
import { multiaddr } from '@multiformats/multiaddr';

import { NETWORK_MODES } from '../constants.js';
import { filterAddressesForMode, isAddressAllowedForMode } from './mode-address-policy.js';

const ONION = '/onion3/vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd:9000';
const PEER = '12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';

const allowedAnon = (addr: string) =>
  isAddressAllowedForMode(multiaddr(addr), NETWORK_MODES.ANONYMOUS);
const allowedFast = (addr: string) =>
  isAddressAllowedForMode(multiaddr(addr), NETWORK_MODES.FAST);

test('anonymous mode allows an onion address', () => {
  assert.equal(allowedAnon(ONION), true);
});

test('anonymous mode allows an onion address carrying a /p2p suffix', () => {
  assert.equal(allowedAnon(`${ONION}/p2p/${PEER}`), true);
});

test('anonymous mode rejects a clearnet TCP address', () => {
  // The K-01 deanonymisation vector: peer-supplied /ip4 dialed outside Tor.
  assert.equal(allowedAnon('/ip4/198.51.100.7/tcp/9000'), false);
});

test('anonymous mode rejects a loopback address', () => {
  assert.equal(allowedAnon('/ip4/127.0.0.1/tcp/9550'), false);
});

test('anonymous mode rejects an IPv6 address', () => {
  assert.equal(allowedAnon('/ip6/2001:db8::1/tcp/9000'), false);
});

test('anonymous mode rejects /dns4 (would trigger a system DNS lookup)', () => {
  // The K-02 vector: resolution alone leaks to the attacker's nameserver, before
  // any connection is attempted.
  assert.equal(allowedAnon('/dns4/beacon.attacker.example/tcp/9000'), false);
});

test('anonymous mode rejects /dns and /dns6', () => {
  assert.equal(allowedAnon('/dns/beacon.attacker.example/tcp/9000'), false);
  assert.equal(allowedAnon('/dns6/beacon.attacker.example/tcp/9000'), false);
});

test('anonymous mode rejects a /unix socket path', () => {
  // @libp2p/tcp's dialFilter explicitly accepts /unix, making it an SSRF target.
  assert.equal(allowedAnon('/unix/%2Fvar%2Frun%2Fdocker.sock'), false);
});

test('fast mode is unrestricted', () => {
  assert.equal(allowedFast(ONION), true);
  assert.equal(allowedFast('/ip4/198.51.100.7/tcp/9000'), true);
  assert.equal(allowedFast('/ip4/127.0.0.1/tcp/9550'), true);
  assert.equal(allowedFast('/dns4/example.test/tcp/9000'), true);
});

test('filterAddressesForMode keeps only onion addresses in anonymous mode', () => {
  const mixed = [
    '/ip4/198.51.100.7/tcp/9000',
    ONION,
    '/dns4/beacon.attacker.example/tcp/9000',
  ].map((a) => multiaddr(a));

  assert.deepEqual(
    filterAddressesForMode(mixed, NETWORK_MODES.ANONYMOUS).map((m) => m.toString()),
    [ONION],
  );
});

test('filterAddressesForMode passes everything through in fast mode', () => {
  const mixed = ['/ip4/198.51.100.7/tcp/9000', ONION].map((a) => multiaddr(a));

  assert.equal(filterAddressesForMode(mixed, NETWORK_MODES.FAST).length, 2);
});

test('filterAddressesForMode can empty the list without throwing', () => {
  const clearnetOnly = ['/ip4/198.51.100.7/tcp/9000'].map((a) => multiaddr(a));

  assert.deepEqual(filterAddressesForMode(clearnetOnly, NETWORK_MODES.ANONYMOUS), []);
});
