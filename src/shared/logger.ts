type LogArguments = Parameters<typeof console.log>;

const resolveDebugMode = (): boolean => {
  const processDebugMode = typeof process !== 'undefined' ? process.env?.DEBUG_MODE : undefined;
  if (processDebugMode !== undefined) {
    return processDebugMode === 'true';
  }

  const viteDebugMode = (import.meta as ImportMeta & {
    env?: Record<string, string | boolean | undefined>;
  }).env?.DEBUG_MODE;

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
