import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeBucketPacingDelaysMs,
  shuffleAndPaceExecute,
  shuffleCopy,
} from './bucket-scan-pacing.js';

// --- shuffleCopy -----------------------------------------------------------

test('shuffleCopy returns a permutation of the input (same multiset, same length)', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = shuffleCopy(items, () => 0.5);
  assert.equal(shuffled.length, items.length);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), items);
});

test('shuffleCopy does not mutate the input array', () => {
  const items = [1, 2, 3, 4, 5];
  const copy = [...items];
  shuffleCopy(items, () => 0.9);
  assert.deepEqual(items, copy);
});

test('shuffleCopy with random()=0 always swaps into a deterministic, non-identity-for-most-sizes order', () => {
  // Fisher-Yates with random() always 0 picks j=0 every iteration, producing a
  // specific deterministic rotation - verify it's reproducible, not verify a
  // particular permutation shape.
  const items = ['a', 'b', 'c', 'd', 'e'];
  const first = shuffleCopy(items, () => 0);
  const second = shuffleCopy(items, () => 0);
  assert.deepEqual(first, second, 'same random source must reproduce the same order');
});

test('shuffleCopy on an empty or single-item array is a no-op', () => {
  assert.deepEqual(shuffleCopy([], () => 0.5), []);
  assert.deepEqual(shuffleCopy([42], () => 0.5), [42]);
});

// --- computeBucketPacingDelaysMs -------------------------------------------

test('computeBucketPacingDelaysMs returns all-zero delays at or below the minCount floor', () => {
  assert.deepEqual(computeBucketPacingDelaysMs(0, 30_000, () => 0.5), []);
  assert.deepEqual(computeBucketPacingDelaysMs(1, 30_000, () => 0.5), [0]);
  assert.deepEqual(computeBucketPacingDelaysMs(2, 30_000, () => 0.5), [0, 0]);
});

test('computeBucketPacingDelaysMs pacing kicks in above the minCount floor', () => {
  const delays = computeBucketPacingDelaysMs(3, 30_000, () => 0.5);
  assert.equal(delays.length, 3);
  assert.deepEqual(delays, [15_000, 15_000, 15_000]);
});

test('computeBucketPacingDelaysMs every delay is bounded by totalBudgetMs regardless of count', () => {
  for (const count of [3, 10, 50, 500]) {
    const delays = computeBucketPacingDelaysMs(count, 30_000, () => 0.999999);
    assert.equal(delays.length, count);
    for (const delay of delays) {
      assert.ok(delay <= 30_000, `delay ${delay} must stay <= totalBudgetMs for count=${count}`);
      assert.ok(delay >= 0);
    }
  }
});

test('computeBucketPacingDelaysMs respects a custom minCount', () => {
  assert.deepEqual(computeBucketPacingDelaysMs(5, 30_000, () => 0.5, 10), [0, 0, 0, 0, 0]);
});

test('computeBucketPacingDelaysMs returns zero delays when totalBudgetMs is zero or negative', () => {
  assert.deepEqual(computeBucketPacingDelaysMs(5, 0, () => 0.5), [0, 0, 0, 0, 0]);
  assert.deepEqual(computeBucketPacingDelaysMs(5, -1, () => 0.5), [0, 0, 0, 0, 0]);
});

// --- shuffleAndPaceExecute ---------------------------------------------------

test('shuffleAndPaceExecute preserves the original item order in its results', async () => {
  const items = [10, 20, 30, 40, 50];
  const { results } = await shuffleAndPaceExecute(
    items,
    async (n) => n * 2,
    { totalBudgetMs: 30_000, random: () => 0.5, sleep: async () => undefined },
  );
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
});

test('shuffleAndPaceExecute skips sleeping entirely at or below the minCount floor', async () => {
  const sleptMs: number[] = [];
  const { bucketCount, totalSpreadMs } = await shuffleAndPaceExecute(
    ['a', 'b'],
    async (item) => item,
    {
      totalBudgetMs: 30_000,
      random: () => 0.7,
      sleep: async (ms) => { sleptMs.push(ms); },
    },
  );
  assert.equal(bucketCount, 2);
  assert.equal(totalSpreadMs, 0);
  assert.deepEqual(sleptMs, [], 'no sleep should be invoked for <=2 items');
});

test('shuffleAndPaceExecute stages start delays and reports the max as totalSpreadMs', async () => {
  const sleptMs: number[] = [];
  const samples = [0.1, 0.9, 0.5, 0.2]; // shuffle draws + delay draws share this sequence
  let i = 0;
  const random = () => samples[i++ % samples.length]!;

  const { bucketCount, totalSpreadMs } = await shuffleAndPaceExecute(
    ['a', 'b', 'c', 'd'],
    async (item) => item,
    {
      totalBudgetMs: 30_000,
      random,
      sleep: async (ms) => { sleptMs.push(ms); },
    },
  );

  assert.equal(bucketCount, 4);
  assert.ok(sleptMs.length > 0, 'pacing above the floor must call sleep at least once');
  assert.ok(sleptMs.every((ms) => ms <= 30_000), 'every staged delay must respect the budget');
  assert.equal(totalSpreadMs, Math.max(...sleptMs, 0));
});

test('shuffleAndPaceExecute total spread never exceeds the budget regardless of bucket count', async () => {
  const items = Array.from({ length: 200 }, (_, i) => i);
  const { totalSpreadMs } = await shuffleAndPaceExecute(
    items,
    async (n) => n,
    { totalBudgetMs: 30_000, random: () => 0.999999, sleep: async () => undefined },
  );
  assert.ok(totalSpreadMs <= 30_000, `totalSpreadMs ${totalSpreadMs} must stay within the fixed budget for 200 buckets`);
});

test('shuffleAndPaceExecute handles duplicate-valued items without losing any result slot', async () => {
  const items = ['x', 'x', 'y', 'x'];
  const { results } = await shuffleAndPaceExecute(
    items,
    async (item) => `${item}!`,
    { totalBudgetMs: 30_000, random: () => 0.3, sleep: async () => undefined },
  );
  assert.deepEqual(results, ['x!', 'x!', 'y!', 'x!']);
});
