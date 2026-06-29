import assert from 'node:assert/strict';
import test from 'node:test';
import { LeasePool } from './lease-pool.js';

test('enforces the global cap', () => {
  const pool = new LeasePool(2, 10);
  assert.ok(pool.tryAcquire('a'));
  assert.ok(pool.tryAcquire('b'));
  assert.equal(pool.tryAcquire('c'), null);
  assert.equal(pool.activeCount, 2);
});

test('enforces the per-peer cap even with global room', () => {
  const pool = new LeasePool(10, 2);
  assert.ok(pool.tryAcquire('a'));
  assert.ok(pool.tryAcquire('a'));
  assert.equal(pool.tryAcquire('a'), null); // peer 'a' is full
  assert.ok(pool.tryAcquire('b'));           // others still fit
  assert.equal(pool.peerCount('a'), 2);
});

test('acquire is all-or-nothing: a per-peer rejection takes no global slot', () => {
  const pool = new LeasePool(10, 1);
  pool.tryAcquire('a');
  assert.equal(pool.activeCount, 1);
  assert.equal(pool.tryAcquire('a'), null); // per-peer full
  assert.equal(pool.activeCount, 1);         // global was NOT incremented
});

test('release frees both the global and per-peer slot', () => {
  const pool = new LeasePool(1, 1);
  const lease = pool.tryAcquire('a');
  assert.ok(lease);
  assert.equal(pool.tryAcquire('a'), null);
  lease.release();
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.peerCount('a'), 0);
  assert.ok(pool.tryAcquire('a')); // slot reusable
});

test('release is idempotent and never decrements twice', () => {
  const pool = new LeasePool(2, 2);
  const a = pool.tryAcquire('p');
  const b = pool.tryAcquire('p');
  assert.ok(a && b);
  a.release();
  a.release(); // double-release must be a no-op
  a.release();
  assert.equal(pool.activeCount, 1);   // only b remains, not -1
  assert.equal(pool.peerCount('p'), 1);
  b.release();
  assert.equal(pool.activeCount, 0);
  assert.equal(pool.peerCount('p'), 0);
});

test('models the pre-auth → serve hand-off without drift', () => {
  const preAuth = new LeasePool(32, 2);
  const serve = new LeasePool(15, 4);
  const peer = 'peer';

  const preAuthLease = preAuth.tryAcquire(peer);
  assert.ok(preAuthLease);

  // Authentication succeeds: take the serve lease, then release the pre-auth lease.
  const serveLease = serve.tryAcquire(peer);
  assert.ok(serveLease);
  preAuthLease.release();

  assert.equal(preAuth.activeCount, 0);
  assert.equal(serve.activeCount, 1);

  // A redundant pre-auth release in a later finally must not underflow.
  preAuthLease.release();
  assert.equal(preAuth.activeCount, 0);

  serveLease.release();
  assert.equal(serve.activeCount, 0);
});
