type TimerHandle = ReturnType<typeof setTimeout>;

export type DebouncedInvoker = {
  /** (Re)start the shared timer; rapid calls coalesce into one deferred run. */
  schedule(): void;
  /** Cancel any pending run without firing it. */
  cancel(): void;
};

/**
 * Coalesces bursts of `schedule()` calls into a single deferred invocation that
 * runs `delayMs` after the LAST call (a shared timer reset on every call). The
 * target is resolved at FIRE time (not schedule time) via `resolveTarget`, so a
 * target that disappears between scheduling and firing is handled silently by
 * skipping the run. `run`'s own errors are swallowed and routed to `onError`,
 * so a failed run never escapes the timer callback.
 */
export function createDebouncedInvoker<T>(config: {
  delayMs: number;
  resolveTarget: () => T | null | undefined;
  run: (target: T) => void | Promise<void>;
  onError?: (error: unknown) => void;
  timers?: {
    set: (handler: () => void, ms: number) => TimerHandle;
    clear: (handle: TimerHandle) => void;
  };
}): DebouncedInvoker {
  const setTimer = config.timers?.set ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer = config.timers?.clear ?? ((handle) => clearTimeout(handle));
  let handle: TimerHandle | null = null;

  const cancel = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  const schedule = (): void => {
    cancel();
    handle = setTimer(() => {
      handle = null;
      const target = config.resolveTarget();
      if (target === null || target === undefined) {
        return;
      }
      try {
        const result = config.run(target);
        if (result && typeof (result as Promise<void>).then === 'function') {
          void (result as Promise<void>).catch((error) => {
            config.onError?.(error);
          });
        }
      } catch (error) {
        config.onError?.(error);
      }
    }, config.delayMs);
  };

  return { schedule, cancel };
}
