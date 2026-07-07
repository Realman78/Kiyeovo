import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPeriodicOfflineSweeper,
  type PeriodicOfflineSweepSummary,
} from './periodic-offline-sweeper.js';

// Deterministic scheduler: keeps the single pending timer and fires it on demand,
// so cadence/jitter/skip logic can be asserted without wall-clock waits.
class FakeScheduler {
  private nextHandle = 1;
  private readonly pending = new Map<number, { handler: () => void; ms: number }>();

  readonly timers = {
    set: (handler: () => void, ms: number): number => {
      const handle = this.nextHandle++;
      this.pending.set(handle, { handler, ms });
      return handle;
    },
    clear: (handle: number): void => {
      this.pending.delete(handle);
    },
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Delay of the single currently-pending timer. */
  get pendingDelay(): number {
    const entry = [...this.pending.values()][0];
    if (!entry) throw new Error('no pending timer');
    return entry.ms;
  }

  fireNext(): void {
    const [handle, entry] = [...this.pending.entries()][0] ?? [];
    if (handle === undefined || !entry) throw new Error('no pending timer');
    this.pending.delete(handle);
    entry.handler();
  }
}

const summary = (over: Partial<PeriodicOfflineSweepSummary> = {}): PeriodicOfflineSweepSummary => ({
  directChecked: 0,
  directUnread: 0,
  groupSwept: true,
  ...over,
});

const flush = async (): Promise<void> => {
  // Drain enough microtask rounds to settle the runSweep .then/.catch/.finally chain.
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

test('start arms one timer but does not sweep until the first tick fires', () => {
  const scheduler = new FakeScheduler();
  let sweeps = 0;
  const sweeper = createPeriodicOfflineSweeper({
    intervalMs: 300_000,
    jitterRatio: 0,
    isDhtConnected: () => true,
    runSweep: async () => { sweeps++; return summary(); },
    timers: scheduler.timers,
  });

  sweeper.start();
  assert.equal(scheduler.pendingCount, 1, 'one pending timer after start');
  assert.equal(sweeps, 0, 'nothing runs before the first tick');
});

test('a connected tick runs a sweep and re-arms the next tick', async () => {
  const scheduler = new FakeScheduler();
  let sweeps = 0;
  const sweeper = createPeriodicOfflineSweeper({
    intervalMs: 300_000,
    jitterRatio: 0,
    isDhtConnected: () => true,
    runSweep: async () => { sweeps++; return summary(); },
    timers: scheduler.timers,
  });

  sweeper.start();
  scheduler.fireNext();
  await flush();

  assert.equal(sweeps, 1, 'sweep ran on the tick');
  assert.equal(scheduler.pendingCount, 1, 'cadence continues (next tick re-armed)');
});

test('a tick while DHT is disconnected is skipped but the cadence continues', async () => {
  const scheduler = new FakeScheduler();
  let sweeps = 0;
  let connected = false;
  const sweeper = createPeriodicOfflineSweeper({
    intervalMs: 300_000,
    jitterRatio: 0,
    isDhtConnected: () => connected,
    runSweep: async () => { sweeps++; return summary(); },
    timers: scheduler.timers,
  });

  sweeper.start();
  scheduler.fireNext();
  await flush();
  assert.equal(sweeps, 0, 'no sweep while disconnected');
  assert.equal(scheduler.pendingCount, 1, 'still scheduled the next tick');

  connected = true;
  scheduler.fireNext();
  await flush();
  assert.equal(sweeps, 1, 'sweeps once reconnected');
});

test('overlapping sweeps are skipped while the previous is still running', async () => {
  const scheduler = new FakeScheduler();
  let sweeps = 0;
  let release: (() => void) | null = null;
  const sweeper = createPeriodicOfflineSweeper({
    intervalMs: 300_000,
    jitterRatio: 0,
    isDhtConnected: () => true,
    runSweep: async () => {
      sweeps++;
      await new Promise<void>((resolve) => { release = resolve; });
      return summary();
    },
    timers: scheduler.timers,
  });

  sweeper.start();
  scheduler.fireNext(); // tick 1 → starts sweep, stays in flight
  await flush();
  assert.equal(sweeps, 1);

  scheduler.fireNext(); // tick 2 fires while sweep 1 still running
  await flush();
  assert.equal(sweeps, 1, 'second tick skipped due to overlap');

  release?.();          // let sweep 1 finish
  await flush();

  scheduler.fireNext(); // tick 3, now idle
  await flush();
  assert.equal(sweeps, 2, 'sweeps again once the prior one settled');
});

test('jittered delay stays within ±jitterRatio of the interval', () => {
  const samples = [0, 0.25, 0.5, 0.75, 0.999];
  let i = 0;
  const scheduler = new FakeScheduler();
  const sweeper = createPeriodicOfflineSweeper({
    intervalMs: 300_000,
    jitterRatio: 0.15,
    isDhtConnected: () => true,
    runSweep: async () => summary(),
    random: () => samples[i++ % samples.length]!,
    timers: scheduler.timers,
  });

  sweeper.start();
  for (let n = 0; n < samples.length; n++) {
    const delay = scheduler.pendingDelay;
    assert.ok(delay >= 300_000 * 0.85, `delay ${delay} >= lower bound`);
    assert.ok(delay <= 300_000 * 1.15, `delay ${delay} <= upper bound`);
    scheduler.fireNext();
  }
});

test('stop cancels the pending tick', () => {
  const scheduler = new FakeScheduler();
  let sweeps = 0;
  const sweeper = createPeriodicOfflineSweeper({
    intervalMs: 300_000,
    jitterRatio: 0,
    isDhtConnected: () => true,
    runSweep: async () => { sweeps++; return summary(); },
    timers: scheduler.timers,
  });

  sweeper.start();
  sweeper.stop();
  assert.equal(scheduler.pendingCount, 0, 'stop clears the pending timer');
  assert.equal(sweeps, 0);
});
