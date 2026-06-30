import assert from 'node:assert/strict';
import test from 'node:test';
import setupNodesReducer, {
  applyLiveness,
  bumpSetupGeneration,
  mergeConfiguredNodes,
  setSetupNodes,
} from './setupNodesSlice.js';

test('setup nodes preserve liveness across config refresh and ignore stale generations', () => {
  let state = setupNodesReducer(undefined, setSetupNodes({
    section: 'bootstrap',
    nodes: [
      { address: '/ip4/127.0.0.1/tcp/1000', connected: null },
      { address: '/ip4/127.0.0.1/tcp/2000', connected: null },
    ],
  }));

  state = setupNodesReducer(state, applyLiveness({
    section: 'bootstrap',
    statuses: [
      { address: '/ip4/127.0.0.1/tcp/1000', connected: true },
      { address: '/ip4/127.0.0.1/tcp/2000', connected: false },
    ],
  }));

  state = setupNodesReducer(state, mergeConfiguredNodes({
    section: 'bootstrap',
    requestGeneration: 1,
    configured: [
      { address: '/ip4/127.0.0.1/tcp/2000', connected: null },
      { address: '/ip4/127.0.0.1/tcp/3000', connected: null },
    ],
  }));

  assert.deepEqual(state.bootstrap.nodes, [
    { address: '/ip4/127.0.0.1/tcp/2000', connected: false },
    { address: '/ip4/127.0.0.1/tcp/3000', connected: null },
  ]);
  assert.equal(state.bootstrap.loadedOnce, true);

  state = setupNodesReducer(state, bumpSetupGeneration({ section: 'bootstrap' }));
  state = setupNodesReducer(state, mergeConfiguredNodes({
    section: 'bootstrap',
    requestGeneration: 1,
    configured: [
      { address: '/ip4/127.0.0.1/tcp/stale', connected: true },
    ],
  }));

  assert.deepEqual(state.bootstrap.nodes, [
    { address: '/ip4/127.0.0.1/tcp/2000', connected: false },
    { address: '/ip4/127.0.0.1/tcp/3000', connected: null },
  ]);
});

test('setup node generation is scoped per section', () => {
  let state = setupNodesReducer(undefined, setSetupNodes({
    section: 'relay',
    nodes: [{ address: '/ip4/127.0.0.1/tcp/4000', connected: null }],
  }));

  assert.equal(state.bootstrap.generation, 0);
  assert.equal(state.relay.generation, 1);

  state = setupNodesReducer(state, bumpSetupGeneration({ section: 'bootstrap' }));
  assert.equal(state.bootstrap.generation, 1);
  assert.equal(state.relay.generation, 1);
});
