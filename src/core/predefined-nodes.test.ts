import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREDEFINED_NODES,
  PREDEFINED_NODES_ENABLED,
  PREDEFINED_NODES_SUNSET_TS,
  isSunsetActive,
  isOfferingActive,
  normalizePredefinedValue,
  matchesPredefinedNode,
  hasSavedPredefinedNode,
} from './predefined-nodes.js';

const SAMPLE_BOOTSTRAP =
  '/dns4/bootstrap.example/tcp/4001/p2p/12D3KooWSampleBootstrap';
const SAMPLE_TURN = 'turn:turn.example:3478';
const SAMPLE_STUN = 'stun:stun.example:3478';

test('predefined nodes are disabled for the 1.0.0 installer build', () => {
  assert.equal(PREDEFINED_NODES_ENABLED, false);
  assert.equal(PREDEFINED_NODES.length, 0);
  assert.equal(Number.isFinite(PREDEFINED_NODES_SUNSET_TS), false);
});

test('isSunsetActive stays false while no predefined-node sunset is configured', () => {
  assert.equal(isSunsetActive(Date.now()), false);
  assert.equal(isSunsetActive(Number.MAX_SAFE_INTEGER), false);
});

test('isOfferingActive stays false while predefined nodes are disabled', () => {
  assert.equal(isOfferingActive(0), false);
  assert.equal(isOfferingActive(Date.now()), false);
});

test('normalizePredefinedValue: multiaddr trims whitespace and trailing slash', () => {
  assert.equal(
    normalizePredefinedValue('bootstrap', `  ${SAMPLE_BOOTSTRAP}/  `),
    SAMPLE_BOOTSTRAP,
  );
});

test('normalizePredefinedValue: ICE url drops scheme, query, creds, case', () => {
  assert.equal(
    normalizePredefinedValue('turn', 'TURN:TURN.EXAMPLE:3478?transport=udp'),
    'turn.example:3478',
  );
  assert.equal(
    normalizePredefinedValue('turn', 'turn:user:secret@turn.example:3478'),
    'turn.example:3478',
  );
});

test('matchesPredefinedNode: no saved node matches while the configured list is empty', () => {
  assert.equal(matchesPredefinedNode(SAMPLE_BOOTSTRAP, 'bootstrap'), false);
  assert.equal(matchesPredefinedNode(`${SAMPLE_TURN}?transport=udp`, 'turn'), false);
  assert.equal(matchesPredefinedNode('turns:turn.example:3478', 'turns'), false);
});

test('matchesPredefinedNode: kind must agree (stun url not matched as turn)', () => {
  assert.equal(matchesPredefinedNode(SAMPLE_STUN, 'turn'), false);
  assert.equal(matchesPredefinedNode(SAMPLE_STUN, 'stun'), false);
});

test('matchesPredefinedNode: empty / whitespace value never matches', () => {
  assert.equal(matchesPredefinedNode('', 'bootstrap'), false);
  assert.equal(matchesPredefinedNode('   ', 'turn'), false);
});

test('hasSavedPredefinedNode: false while no predefined nodes are configured', () => {
  assert.equal(
    hasSavedPredefinedNode([
      { kind: 'bootstrap', value: '/dns4/unrelated.example/tcp/4001/p2p/12D3KooWx' },
      { kind: 'turn', value: `${SAMPLE_TURN}?transport=tcp` },
    ]),
    false,
  );
});
