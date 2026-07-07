import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUsernameReconnectRepublisher,
  type ReconnectRepublishTarget,
} from './username-reconnect-republisher.js';

// Deterministic fake scheduler: records pending timers and fires them on demand,
// so debounce coalescing can be asserted without wall-clock waits.
class FakeScheduler {
  private nextHandle = 1;
  private readonly pending = new Map<number, () => void>();

  readonly timers = {
    set: (handler: () => void): number => {
      const handle = this.nextHandle++;
      this.pending.set(handle, handler);
      return handle;
    },
    clear: (handle: number): void => {
      this.pending.delete(handle);
    },
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  fireAll(): void {
    const handlers = [...this.pending.values()];
    this.pending.clear();
    for (const handler of handlers) {
      handler();
    }
  }
}

class FakeRegistry implements ReconnectRepublishTarget {
  currentUsername: string | null;
  republishCount = 0;
  private readonly failWith: Error | null;

  constructor(currentUsername: string | null, failWith: Error | null = null) {
    this.currentUsername = currentUsername;
    this.failWith = failWith;
  }

  getCurrentUsername(): string | null {
    return this.currentUsername;
  }

  async republishRegistrationAfterReconnect(): Promise<void> {
    this.republishCount++;
    if (this.failWith) {
      throw this.failWith;
    }
  }
}

test('reconnect republisher coalesces a burst of connect-success signals into one republish', () => {
  const scheduler = new FakeScheduler();
  const registry = new FakeRegistry('alice');
  const invoker = createUsernameReconnectRepublisher({
    getRegistry: () => registry,
    delayMs: 5000,
    timers: scheduler.timers,
  });

  invoker.schedule(); // reconnect-success
  invoker.schedule(); // post-retry-verify success burst
  invoker.schedule();

  assert.equal(scheduler.pendingCount, 1, 'burst collapses to a single pending timer');
  assert.equal(registry.republishCount, 0, 'nothing runs before the debounce fires');

  scheduler.fireAll();
  assert.equal(registry.republishCount, 1, 'exactly one republish after the debounce');
});

test('reconnect republisher is a no-op when no username is registered at fire time', () => {
  const scheduler = new FakeScheduler();
  const registry = new FakeRegistry(null);
  const invoker = createUsernameReconnectRepublisher({
    getRegistry: () => registry,
    delayMs: 5000,
    timers: scheduler.timers,
  });

  invoker.schedule();
  scheduler.fireAll();

  assert.equal(registry.republishCount, 0, 'guard skips republish while unregistered');
});

test('reconnect republisher resolves the registration guard at fire time, not schedule time', () => {
  const scheduler = new FakeScheduler();
  const registry = new FakeRegistry(null);
  const invoker = createUsernameReconnectRepublisher({
    getRegistry: () => registry,
    delayMs: 5000,
    timers: scheduler.timers,
  });

  invoker.schedule(); // scheduled while unregistered
  registry.currentUsername = 'bob'; // becomes registered before the timer fires
  scheduler.fireAll();

  assert.equal(registry.republishCount, 1, 'runs because a username exists at fire time');
});

test('reconnect republisher skips the run when the registry is absent at fire time', () => {
  const scheduler = new FakeScheduler();
  let registry: FakeRegistry | null = new FakeRegistry('carol');
  const invoker = createUsernameReconnectRepublisher({
    getRegistry: () => registry,
    delayMs: 5000,
    timers: scheduler.timers,
  });

  invoker.schedule();
  registry = null;
  scheduler.fireAll();
  // No throw, nothing to assert on the (gone) registry — reaching here is the pass.
  assert.equal(scheduler.pendingCount, 0);
});

test('reconnect republisher routes republish failures to onError', async () => {
  const scheduler = new FakeScheduler();
  const failure = new Error('zero-accept republish');
  const registry = new FakeRegistry('dave', failure);
  const errors: unknown[] = [];
  const invoker = createUsernameReconnectRepublisher({
    getRegistry: () => registry,
    delayMs: 5000,
    timers: scheduler.timers,
    onError: (error) => errors.push(error),
  });

  invoker.schedule();
  scheduler.fireAll();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(registry.republishCount, 1);
  assert.deepEqual(errors, [failure], 'async republish rejection is routed to onError');
});

test('reconnect republisher cancel() prevents a pending republish from firing', () => {
  const scheduler = new FakeScheduler();
  const registry = new FakeRegistry('erin');
  const invoker = createUsernameReconnectRepublisher({
    getRegistry: () => registry,
    delayMs: 5000,
    timers: scheduler.timers,
  });

  invoker.schedule();
  invoker.cancel();
  scheduler.fireAll();

  assert.equal(registry.republishCount, 0, 'cancelled republish never runs');
});
