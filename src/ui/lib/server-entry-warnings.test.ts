import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWarningDismissalKey, getServerEntryWarning, parseMultiaddr } from './server-entry-warnings.js';

const BOOTSTRAP_A = '/ip4/203.0.113.10/tcp/9000/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';
const RELAY_A = '/ip4/203.0.113.10/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM';
// Same host+port as BOOTSTRAP_A but a different peer ID — still a host/port
// collision (the real incident's signature: the bootstrap address was pasted
// verbatim into the relay list).
const RELAY_SAME_HOST_PORT_AS_BOOTSTRAP_A = '/ip4/203.0.113.10/tcp/9000/p2p/12D3KooWOtherPeerIdEntirely111111111111111';
// Different host+port but the SAME peer ID as BOOTSTRAP_A.
const RELAY_SAME_PEER_ID_AS_BOOTSTRAP_A = '/ip4/198.51.100.5/tcp/4002/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';

test('parseMultiaddr extracts host, port, and peer ID', () => {
  assert.deepEqual(parseMultiaddr(BOOTSTRAP_A), {
    host: '203.0.113.10',
    port: '9000',
    peerId: '12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K',
  });
});

test('parseMultiaddr returns null when host or port is missing', () => {
  assert.equal(parseMultiaddr('/p2p/12D3KooWKDrp'), null);
  assert.equal(parseMultiaddr('not a multiaddr at all'), null);
});

test('parseMultiaddr handles onion3 addresses with an embedded port', () => {
  assert.deepEqual(
    parseMultiaddr('/onion3/26ls5ncglwcndci23ibeaz2nynivobs6armqonsnwag3gh5sn24rgmid:9000/p2p/12D3KooWApMAqAEWpWenYfXRZwWMUH8arQYjACu7xNhASBWm2st5'),
    {
      host: '26ls5ncglwcndci23ibeaz2nynivobs6armqonsnwag3gh5sn24rgmid',
      port: '9000',
      peerId: '12D3KooWApMAqAEWpWenYfXRZwWMUH8arQYjACu7xNhASBWm2st5',
    },
  );
});

test('cross-list duplicate: relay entry sharing host+port with a saved bootstrap entry', () => {
  const warning = getServerEntryWarning(RELAY_SAME_HOST_PORT_AS_BOOTSTRAP_A, 'relay', {
    bootstrap: [BOOTSTRAP_A],
  });
  assert.equal(warning?.code, 'cross-list-duplicate');
  assert.match(warning!.message, /already configured as a bootstrap server/);
});

test('cross-list duplicate: bootstrap entry sharing host+port with a saved relay entry', () => {
  const warning = getServerEntryWarning(BOOTSTRAP_A, 'bootstrap', {
    relay: [RELAY_SAME_HOST_PORT_AS_BOOTSTRAP_A],
  });
  assert.equal(warning?.code, 'cross-list-duplicate');
  assert.match(warning!.message, /already configured as a relay server/);
});

test('cross-list duplicate: matches on shared /p2p/ peer ID even with a different host+port', () => {
  const warning = getServerEntryWarning(RELAY_SAME_PEER_ID_AS_BOOTSTRAP_A, 'relay', {
    bootstrap: [BOOTSTRAP_A],
  });
  assert.equal(warning?.code, 'cross-list-duplicate');
});

test('port heuristic: relay entry on port 9000 (bootstrap convention) warns, softer than a duplicate', () => {
  const warning = getServerEntryWarning(
    '/ip4/198.51.100.20/tcp/9000/p2p/12D3KooWUnrelatedPeerId1111111111111111',
    'relay',
    {},
  );
  assert.equal(warning?.code, 'port-heuristic');
  assert.match(warning!.message, /Port 9000 is Kiyeovo's bootstrap convention/);
});

test('port heuristic: bootstrap entry on port 4002 (relay convention) warns', () => {
  const warning = getServerEntryWarning(
    '/ip4/198.51.100.20/tcp/4002/p2p/12D3KooWUnrelatedPeerId1111111111111111',
    'bootstrap',
    {},
  );
  assert.equal(warning?.code, 'port-heuristic');
  assert.match(warning!.message, /Port 4002 is Kiyeovo's relay convention/);
});

test('cross-list duplicate takes priority over the port heuristic when both would apply', () => {
  // Bootstrap entry on port 4002 (which alone would be a port-heuristic hint)
  // AND already saved verbatim in the relay list -> the stronger warning wins.
  const entry = '/ip4/203.0.113.10/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM';
  const warning = getServerEntryWarning(entry, 'bootstrap', { relay: [entry] });
  assert.equal(warning?.code, 'cross-list-duplicate');
});

test('negative: distinct bootstrap and relay entries on conventional ports produce no warning', () => {
  const warning = getServerEntryWarning(BOOTSTRAP_A, 'bootstrap', { relay: [RELAY_A] });
  assert.equal(warning, null);
});

test('negative: relay entry with an unrelated port and no cross-list match', () => {
  const warning = getServerEntryWarning(RELAY_A, 'relay', { bootstrap: [BOOTSTRAP_A] });
  assert.equal(warning, null);
});

test('negative: empty or unparsable entries produce no warning', () => {
  assert.equal(getServerEntryWarning('', 'bootstrap', {}), null);
  assert.equal(getServerEntryWarning('   ', 'relay', {}), null);
  assert.equal(getServerEntryWarning('not-a-multiaddr', 'bootstrap', { relay: [RELAY_A] }), null);
});

test('STUN/TURN: a pasted bootstrap/relay multiaddr is flagged as the wrong format', () => {
  const warning = getServerEntryWarning(BOOTSTRAP_A, 'stun', {});
  assert.equal(warning?.code, 'wrong-format');
  const warningTurn = getServerEntryWarning(RELAY_A, 'turn', {});
  assert.equal(warningTurn?.code, 'wrong-format');
});

test('STUN/TURN: a well-formed stun:/turn:/turns: URL produces no warning', () => {
  assert.equal(getServerEntryWarning('stun:stun.l.google.com:19302', 'stun', {}), null);
  assert.equal(getServerEntryWarning('turn:turn.example.com:3478', 'turn', {}), null);
  assert.equal(getServerEntryWarning('turns:turn.example.com:5349', 'turns', {}), null);
});

test('STUN/TURN: a pasted multiaddr without a /tcp/ or /udp/ segment is still flagged (portless /dnsaddr/ form)', () => {
  const warning = getServerEntryWarning(
    '/dnsaddr/bootstrap.example.com/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K',
    'stun',
    {},
  );
  assert.equal(warning?.code, 'wrong-format');
});

test('STUN/TURN: a bare /ip4/ address without a /tcp/ or /udp/ segment is still flagged', () => {
  const warning = getServerEntryWarning('/ip4/203.0.113.10/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K', 'turn', {});
  assert.equal(warning?.code, 'wrong-format');
});

test('cross-list duplicate: matches on shared /p2p/ peer ID even when the entry is portless (host/port unresolvable)', () => {
  // /dnsaddr/ entries are dialed by resolving DNS TXT records at connect
  // time and legitimately carry no /tcp//udp/ port segment — parseMultiaddr
  // returns null for these, but the peer ID should still be comparable.
  const portlessDuplicate = '/dnsaddr/bootstrap.example.com/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';
  assert.equal(parseMultiaddr(portlessDuplicate), null);

  const warning = getServerEntryWarning(portlessDuplicate, 'relay', { bootstrap: [BOOTSTRAP_A] });
  assert.equal(warning?.code, 'cross-list-duplicate');
});

test('cross-list duplicate: matches on shared /p2p/ peer ID when the SAVED other-list entry is portless', () => {
  const portlessBootstrap = '/dnsaddr/bootstrap.example.com/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';
  assert.equal(parseMultiaddr(portlessBootstrap), null);

  const warning = getServerEntryWarning(RELAY_SAME_PEER_ID_AS_BOOTSTRAP_A, 'relay', {
    bootstrap: [portlessBootstrap],
  });
  assert.equal(warning?.code, 'cross-list-duplicate');
});

test('negative: portless entry with no peer-ID match and no host/port produces no warning', () => {
  const warning = getServerEntryWarning('/dnsaddr/unrelated.example.com', 'bootstrap', { relay: [RELAY_A] });
  assert.equal(warning, null);
});

test('buildWarningDismissalKey: trims the value and includes the warning code', () => {
  assert.equal(buildWarningDismissalKey('  /ip4/1.2.3.4/tcp/9000  ', 'port-heuristic'), '/ip4/1.2.3.4/tcp/9000::port-heuristic');
});

test('buildWarningDismissalKey: different codes for the same value produce different keys', () => {
  const portHeuristicKey = buildWarningDismissalKey(BOOTSTRAP_A, 'port-heuristic');
  const crossListKey = buildWarningDismissalKey(BOOTSTRAP_A, 'cross-list-duplicate');
  assert.notEqual(portHeuristicKey, crossListKey);
});
