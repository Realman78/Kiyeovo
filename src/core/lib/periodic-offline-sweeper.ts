type TimerHandle = ReturnType<typeof setTimeout>;

/** Terse per-tick counts, surfaced in the sweeper's [OFFLINE][PERIODIC][DONE] log. */
export interface PeriodicOfflineSweepSummary {
  directChecked: number;
  directUnread: number;
  groupSwept: boolean;
}

export interface PeriodicOfflineSweeper {
  /** Arm the recurring timer (no-op if already started). First tick fires after one jittered interval. */
  start(): void;
  /** Cancel the recurring timer; a sweep already in flight is left to settle. */
  stop(): void;
}

/**
 * Recurring backstop that pulls the online client's direct offline buckets AND
 * runs the recency-bounded group offline check on a fixed cadence, so bucket-first
 * control messages (invites/kicks/state updates) and group content can never sit
 * unread indefinitely while the app is running — the event-only healing triggers
 * (startup/reconnect/wake/manual) leave a gap when a peer stays online but
 * disconnected from us, which this closes.
 *
 * Lives in the main process (not the renderer) deliberately: a renderer timer is
 * throttled/paused by Chromium when the window is backgrounded or minimized —
 * exactly when this backstop matters most.
 *
 * Semantics:
 * - Each tick is scheduled up front (steady cadence), with ±`jitterRatio` jitter so
 *   a fleet doesn't sync in lockstep.
 * - A tick is SKIPPED (but the cadence continues) when the DHT is disconnected — no
 *   point burning Tor DHT walks while offline.
 * - Sweeps never overlap: if the previous sweep is still running when a tick fires,
 *   the tick is skipped.
 * - The sweep itself is expected to swallow its own errors; any that escape are
 *   logged and do not stop the cadence.
 */
export function createPeriodicOfflineSweeper(config: {
  intervalMs: number;
  isDhtConnected: () => boolean;
  runSweep: () => Promise<PeriodicOfflineSweepSummary>;
  jitterRatio?: number;
  log?: (line: string) => void;
  random?: () => number;
  now?: () => number;
  timers?: {
    set: (handler: () => void, ms: number) => TimerHandle;
    clear: (handle: TimerHandle) => void;
  };
}): PeriodicOfflineSweeper {
  const setTimer = config.timers?.set ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = config.timers?.clear ?? ((handle) => clearTimeout(handle));
  const random = config.random ?? Math.random;
  const now = config.now ?? Date.now;
  const log = config.log ?? (() => undefined);
  const jitterRatio = Math.min(Math.max(config.jitterRatio ?? 0.15, 0), 0.99);

  let handle: TimerHandle | null = null;
  let started = false;
  let sweepInFlight = false;

  const nextDelayMs = (): number => {
    // factor in [1 - jitterRatio, 1 + jitterRatio)
    const factor = 1 + (random() * 2 - 1) * jitterRatio;
    return Math.max(1, Math.round(config.intervalMs * factor));
  };

  const scheduleNext = (): void => {
    if (!started) {
      return;
    }
    handle = setTimer(tick, nextDelayMs());
  };

  const tick = (): void => {
    handle = null;
    if (!started) {
      return;
    }
    // Re-arm up front so the cadence holds even when this tick is skipped.
    scheduleNext();

    if (!config.isDhtConnected()) {
      log('[OFFLINE][PERIODIC][SKIP] reason=dht_disconnected');
      return;
    }
    if (sweepInFlight) {
      log('[OFFLINE][PERIODIC][SKIP] reason=overlap');
      return;
    }

    sweepInFlight = true;
    const startedAt = now();
    log('[OFFLINE][PERIODIC][TICK] running');
    void config.runSweep()
      .then((summary) => {
        log(
          `[OFFLINE][PERIODIC][DONE] directChecked=${summary.directChecked} ` +
          `directUnread=${summary.directUnread} groupSwept=${String(summary.groupSwept)} ` +
          `tookMs=${now() - startedAt}`,
        );
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log(`[OFFLINE][PERIODIC][FAIL] reason=${reason} tookMs=${now() - startedAt}`);
      })
      .finally(() => {
        sweepInFlight = false;
      });
  };

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      scheduleNext();
    },
    stop(): void {
      started = false;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
    },
  };
}
