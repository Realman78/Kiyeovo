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

// These assertions run against the PLACEHOLDER PREDEFINED_NODES values shipped
// in predefined-nodes.ts. They exercise the pure matching/timing logic; when
// Marin replaces the placeholders the expected values below must be updated too
// (they intentionally reference the placeholder multiaddrs / ICE urls).
const PLACEHOLDER_BOOTSTRAP =
  '/dns4/bootstrap.placeholder.kiyeovo/tcp/4001/p2p/12D3KooWPLACEHOLDERbootstrap0000000000000000000000000000';
const PLACEHOLDER_TURN = 'turn:turn.placeholder.kiyeovo:3478';
const PLACEHOLDER_STUN = 'stun:stun.placeholder.kiyeovo:3478';

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
    normalizePredefinedValue('bootstrap', `  ${PLACEHOLDER_BOOTSTRAP}/  `),
    PLACEHOLDER_BOOTSTRAP,
  );
});

test('normalizePredefinedValue: ICE url drops scheme, query, creds, case', () => {
  assert.equal(
    normalizePredefinedValue('turn', 'TURN:TURN.PLACEHOLDER.KIYEOVO:3478?transport=udp'),
    'turn.placeholder.kiyeovo:3478',
  );
  assert.equal(
    normalizePredefinedValue('turn', 'turn:user:secret@turn.placeholder.kiyeovo:3478'),
    'turn.placeholder.kiyeovo:3478',
  );
});

test('matchesPredefinedNode: bootstrap exact multiaddr matches', () => {
  assert.equal(matchesPredefinedNode(PLACEHOLDER_BOOTSTRAP, 'bootstrap'), true);
  assert.equal(matchesPredefinedNode(`${PLACEHOLDER_BOOTSTRAP} `, 'bootstrap'), true);
});

test('matchesPredefinedNode: non-predefined multiaddr does not match', () => {
  assert.equal(
    matchesPredefinedNode('/dns4/somebody-else.example/tcp/4001/p2p/12D3KooWOther', 'bootstrap'),
    false,
  );
});

test('matchesPredefinedNode: TURN matches ignoring transport + credentials', () => {
  assert.equal(matchesPredefinedNode(`${PLACEHOLDER_TURN}?transport=udp`, 'turn'), true);
  // Saved TURN url may include the scheme in a different case / include creds.
  assert.equal(matchesPredefinedNode('TURN:turn.placeholder.kiyeovo:3478', 'turn'), true);
});

test('matchesPredefinedNode: turns alias maps to turn kind', () => {
  assert.equal(
    matchesPredefinedNode('turns:turn.placeholder.kiyeovo:3478', 'turns'),
    true,
  );
});

test('matchesPredefinedNode: kind must agree (stun url not matched as turn)', () => {
  assert.equal(matchesPredefinedNode(PLACEHOLDER_STUN, 'turn'), false);
  assert.equal(matchesPredefinedNode(PLACEHOLDER_STUN, 'stun'), true);
});

test('matchesPredefinedNode: empty / whitespace value never matches', () => {
  assert.equal(matchesPredefinedNode('', 'bootstrap'), false);
  assert.equal(matchesPredefinedNode('   ', 'turn'), false);
});

test('hasSavedPredefinedNode: true when any saved entry matches', () => {
  assert.equal(
    hasSavedPredefinedNode([
      { kind: 'bootstrap', value: '/dns4/unrelated.example/tcp/4001/p2p/12D3KooWx' },
      { kind: 'turn', value: `${PLACEHOLDER_TURN}?transport=tcp` },
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
