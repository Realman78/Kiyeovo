type LogArguments = Parameters<typeof console.log>;

const resolveDebugMode = (): boolean => {
  const processDebugMode = typeof process !== 'undefined' ? process.env?.DEBUG_MODE : undefined;
  if (processDebugMode !== undefined) {
    return processDebugMode === 'true';
  }

  // In the renderer `process` is unavailable, so fall back to Vite's
  // import.meta.env. Vite only exposes VITE_-prefixed vars, so prefer
  // VITE_DEBUG_MODE; keep DEBUG_MODE as a fallback for any context that injects it.
  const viteEnv = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env;
  const viteDebugMode = viteEnv?.VITE_DEBUG_MODE ?? viteEnv?.DEBUG_MODE;

  if (typeof viteDebugMode === 'boolean') {
    return viteDebugMode;
  }

  return viteDebugMode === 'true';
};

export const isDebugModeEnabled = (): boolean => resolveDebugMode();

export const log = (...args: LogArguments): void => {
  if (!resolveDebugMode()) {
    return;
  }

  console.log(...args);
};
