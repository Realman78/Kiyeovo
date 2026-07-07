import { BOOTSTRAP_RECONNECT_REPUBLISH_DEBOUNCE_MS } from '../constants.js';
import { createDebouncedInvoker, type DebouncedInvoker } from '../utils/debounced-invoker.js';

/** The slice of UsernameRegistry this seam depends on (keeps it unit-testable). */
export type ReconnectRepublishTarget = {
  getCurrentUsername(): string | null;
  republishRegistrationAfterReconnect(): Promise<void>;
};

/**
 * Builds a debounced invoker that re-publishes the username registration when
 * bootstrap connectivity is (re)established. `schedule()` is called from each
 * connect-success signal (reconnect-success, bootstrap-retry-success); a burst
 * coalesces into one republish `delayMs` after the last signal.
 *
 * The registration guard lives in `resolveTarget`: if no username is currently
 * registered at fire time, the target resolves to `null` and the invoker skips
 * the run — so a reconnect while unregistered (or startup, before auto-register
 * completes) is a no-op.
 */
export function createUsernameReconnectRepublisher(deps: {
  getRegistry: () => ReconnectRepublishTarget | null | undefined;
  onError?: (error: unknown) => void;
  delayMs?: number;
  timers?: {
    set: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (handle: ReturnType<typeof setTimeout>) => void;
  };
}): DebouncedInvoker {
  return createDebouncedInvoker<ReconnectRepublishTarget>({
    delayMs: deps.delayMs ?? BOOTSTRAP_RECONNECT_REPUBLISH_DEBOUNCE_MS,
    resolveTarget: () => {
      const registry = deps.getRegistry();
      if (!registry || registry.getCurrentUsername() == null) {
        return null;
      }
      return registry;
    },
    run: (registry) => registry.republishRegistrationAfterReconnect(),
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });
}
