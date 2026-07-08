import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREDEFINED_NODES_SUNSET_TS,
  isSunsetActive,
  isOfferingActive,
  normalizePredefinedValue,
  matchesPredefinedNode,
  hasSavedPredefinedNode,
} from './predefined-nodes.js';

// These assertions run against the REAL PREDEFINED_NODES fleet values shipped in
// predefined-nodes.ts (SFO used as the representative node). They exercise the
// pure matching/timing logic; if the fleet list changes, update these too.
const FLEET_BOOTSTRAP =
  '/ip4/167.172.115.233/tcp/9000/p2p/12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K';
const FLEET_TURN = 'turn:167.172.115.233:3478';
// A STUN-only node (Toronto runs no TURN) — needed for the kind-disagreement
// test, since a dual STUN+TURN host would normalize identically across kinds.
const FLEET_STUN_ONLY = 'stun:134.122.41.208:3478';
const FLEET_ICE_HOST = '167.172.115.233:3478'; // normalized ICE form (scheme/query/creds/case stripped)

test('isSunsetActive: strictly before / at / after the sunset timestamp', () => {
  assert.equal(isSunsetActive(PREDEFINED_NODES_SUNSET_TS - 1), false);
  assert.equal(isSunsetActive(PREDEFINED_NODES_SUNSET_TS), true);
  assert.equal(isSunsetActive(PREDEFINED_NODES_SUNSET_TS + 1), true);
});

test('isOfferingActive is the inverse of the sunset gate', () => {
  assert.equal(isOfferingActive(PREDEFINED_NODES_SUNSET_TS - 1), true);
  assert.equal(isOfferingActive(PREDEFINED_NODES_SUNSET_TS), false);
});

test('normalizePredefinedValue: multiaddr trims whitespace and trailing slash', () => {
  assert.equal(
    normalizePredefinedValue('bootstrap', `  ${FLEET_BOOTSTRAP}/  `),
    FLEET_BOOTSTRAP,
  );
});

test('normalizePredefinedValue: ICE url drops scheme, query, creds, case', () => {
  assert.equal(
    normalizePredefinedValue('turn', 'TURN:167.172.115.233:3478?transport=udp'),
    FLEET_ICE_HOST,
  );
  assert.equal(
    normalizePredefinedValue('turn', 'turn:user:secret@167.172.115.233:3478'),
    FLEET_ICE_HOST,
  );
});

test('matchesPredefinedNode: bootstrap exact multiaddr matches', () => {
  assert.equal(matchesPredefinedNode(FLEET_BOOTSTRAP, 'bootstrap'), true);
  assert.equal(matchesPredefinedNode(`${FLEET_BOOTSTRAP} `, 'bootstrap'), true);
});

test('matchesPredefinedNode: non-predefined multiaddr does not match', () => {
  assert.equal(
    matchesPredefinedNode('/dns4/somebody-else.example/tcp/4001/p2p/12D3KooWOther', 'bootstrap'),
    false,
  );
});

test('matchesPredefinedNode: TURN matches ignoring transport + credentials', () => {
  assert.equal(matchesPredefinedNode(`${FLEET_TURN}?transport=udp`, 'turn'), true);
  // Saved TURN url may include the scheme in a different case / include creds.
  assert.equal(matchesPredefinedNode('TURN:167.172.115.233:3478', 'turn'), true);
});

test('matchesPredefinedNode: turns alias maps to turn kind', () => {
  assert.equal(
    matchesPredefinedNode('turns:167.172.115.233:3478', 'turns'),
    true,
  );
});

test('matchesPredefinedNode: kind must agree (stun url not matched as turn)', () => {
  // Toronto is STUN-only, so its stun: url must not match any turn entry.
  assert.equal(matchesPredefinedNode(FLEET_STUN_ONLY, 'turn'), false);
  assert.equal(matchesPredefinedNode(FLEET_STUN_ONLY, 'stun'), true);
});

test('matchesPredefinedNode: empty / whitespace value never matches', () => {
  assert.equal(matchesPredefinedNode('', 'bootstrap'), false);
  assert.equal(matchesPredefinedNode('   ', 'turn'), false);
});

test('hasSavedPredefinedNode: true when any saved entry matches', () => {
  assert.equal(
    hasSavedPredefinedNode([
      { kind: 'bootstrap', value: '/dns4/unrelated.example/tcp/4001/p2p/12D3KooWx' },
      { kind: 'turn', value: `${FLEET_TURN}?transport=tcp` },
    ]),
    true,
  );
  assert.equal(
    hasSavedPredefinedNode([
      { kind: 'bootstrap', value: '/dns4/unrelated.example/tcp/4001/p2p/12D3KooWx' },
    ]),
    false,
  );
});
