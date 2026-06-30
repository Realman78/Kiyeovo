import assert from 'node:assert/strict';
import test from 'node:test';
import { createReconnectController } from './reconnect-controller.js';

type ClockControls = {
  advance(ms: number): void;
};

type FakeTimer = {
  callback: () => void;
  cleared: boolean;
  delayMs: number;
};

function withMockedNow<T>(initialNow: number, run: (clock: ClockControls) => T): T {
  const originalNow = Date.now;
  let now = initialNow;
  Date.now = () => now;
  try {
    return run({
      advance(ms: number) {
        now += ms;
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

async function withFakeTimers<T>(
  run: (timers: { scheduled: FakeTimer[]; fire(index: number): void }) => Promise<T> | T,
): Promise<T> {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled: FakeTimer[] = [];
  const activeTimers = new Map<number, FakeTimer>();
  let nextTimerId = 1;

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    const timer: FakeTimer = {
      callback: () => {
        if (typeof callback === 'function') {
          callback();
        }
      },
      cleared: false,
      delayMs: Number(delay ?? 0),
    };
    const id = nextTimerId++;
    scheduled.push(timer);
    activeTimers.set(id, timer);
    return id;
  }) as unknown as typeof setTimeout;

  globalThis.clearTimeout = ((timerId?: ReturnType<typeof setTimeout>) => {
    const id = Number(timerId);
    const timer = activeTimers.get(id);
    if (!timer) {
      return;
    }
    timer.cleared = true;
    activeTimers.delete(id);
  }) as typeof clearTimeout;

  try {
    return await run({
      scheduled,
      fire(index: number) {
        const timer = scheduled[index];
        if (!timer || timer.cleared) {
          return;
        }
        timer.callback();
      },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

function withoutConsoleNoise<T>(run: () => T): T {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    return run();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

test('reconnect gate waits for consecutive negative health statuses and respects cooldown', () => {
  withoutConsoleNoise(() => withMockedNow(100_000, (clock) => {
    const controller = createReconnectController();

    assert.equal(controller.recordHealthStatus(null), false);
    assert.equal(controller.tryBeginReconnect(), false);

    assert.equal(controller.recordHealthStatus(false), true);
    assert.equal(controller.tryBeginReconnect(), false);
    assert.equal(controller.recordHealthStatus(false), true);
    assert.equal(controller.tryBeginReconnect(), false);

    assert.equal(controller.recordHealthStatus(true), false);
    assert.equal(controller.recordHealthStatus(false), true);
    assert.equal(controller.tryBeginReconnect(), false);
    assert.equal(controller.recordHealthStatus(false), true);
    assert.equal(controller.recordHealthStatus(false), true);

    assert.equal(controller.tryBeginReconnect(), true);
    assert.equal(controller.isReconnectInProgress(), true);
    assert.equal(controller.tryBeginReconnect(), false);

    controller.finishReconnect();
    assert.equal(controller.isReconnectInProgress(), false);
    assert.equal(controller.tryBeginReconnect(), false);

    clock.advance(120_000);
    assert.equal(controller.tryBeginReconnect(), true);
  }));
});

test('immediate reconnect bypasses probe threshold but honors failed-reconnect floor cooldown', () => {
  withoutConsoleNoise(() => withMockedNow(200_000, (clock) => {
    const controller = createReconnectController();

    assert.equal(controller.tryBeginImmediateReconnect(), true);
    assert.equal(controller.tryBeginImmediateReconnect(), false);

    controller.finishReconnect();
    assert.equal(controller.tryBeginImmediateReconnect(), false);

    controller.noteFailedReconnect();
    assert.equal(controller.tryBeginImmediateReconnect(), false);
    clock.advance(4_999);
    assert.equal(controller.tryBeginImmediateReconnect(), false);
    clock.advance(1);
    assert.equal(controller.tryBeginImmediateReconnect(), true);
  }));
});

test('bootstrap retry suppresses timer negatives and owns post-retry verification timers', async () => {
  await withFakeTimers((timers) => withoutConsoleNoise(() => {
    const controller = createReconnectController();
    let callbackCount = 0;

    controller.schedulePostRetryVerify('fast', () => {
      callbackCount += 1;
    });
    assert.equal(timers.scheduled[0]?.delayMs, 3_000);

    controller.schedulePostRetryVerify('anonymous', () => {
      callbackCount += 10;
    });
    assert.equal(timers.scheduled[0]?.cleared, true);
    assert.equal(timers.scheduled[1]?.delayMs, 7_000);

    timers.fire(0);
    assert.equal(callbackCount, 0);
    timers.fire(1);
    assert.equal(callbackCount, 10);

    controller.schedulePostRetryVerify('fast', () => {
      callbackCount += 100;
    });
    controller.beginBootstrapRetry();
    assert.equal(timers.scheduled[2]?.cleared, true);
    assert.equal(controller.shouldSuppressNegativeStatusDuringBootstrapRetry('timer_5s'), true);
    assert.equal(controller.shouldSuppressNegativeStatusDuringBootstrapRetry('timer_30s'), true);
    assert.equal(controller.shouldSuppressNegativeStatusDuringBootstrapRetry('manual_retry'), false);
    assert.equal(controller.shouldSuppressNegativeStatusDuringBootstrapRetry('post_retry_verify'), false);

    controller.endBootstrapRetry();
    assert.equal(controller.shouldSuppressNegativeStatusDuringBootstrapRetry('timer_30s'), false);
  }));
});

test('catch-up flag is consumed once and reconnect-success handlers are isolated', () => {
  withoutConsoleNoise(() => {
    const controller = createReconnectController();
    let handlerScore = 0;

    assert.equal(controller.consumeCatchupNeeded(), false);
    controller.markCatchupNeeded();
    assert.equal(controller.consumeCatchupNeeded(), true);
    assert.equal(controller.consumeCatchupNeeded(), false);

    controller.onReconnectSucceeded(() => {
      handlerScore += 1;
      throw new Error('handler failure');
    });
    controller.onReconnectSucceeded(() => {
      handlerScore += 10;
    });

    controller.fireReconnectSucceededHandlers();
    assert.equal(handlerScore, 11);
  });
});
