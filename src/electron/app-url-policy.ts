import { DEV_SERVER_URL } from './constants.js';

export type AppUrlPolicyOptions = {
  appEntryUrl: string;
  isDevelopment: boolean;
};

export function isTrustedAppUrl(
  targetUrl: string,
  { appEntryUrl, isDevelopment }: AppUrlPolicyOptions,
): boolean {
  try {
    const parsedTargetUrl = new URL(targetUrl);

    if (isDevelopment) {
      const parsedDevServerUrl = new URL(DEV_SERVER_URL);
      return (
        parsedTargetUrl.protocol === parsedDevServerUrl.protocol
        && parsedTargetUrl.hostname === parsedDevServerUrl.hostname
        && parsedTargetUrl.port === parsedDevServerUrl.port
      );
    }

    const parsedAppEntryUrl = new URL(appEntryUrl);
    return (
      parsedTargetUrl.protocol === parsedAppEntryUrl.protocol
      && parsedTargetUrl.hostname === parsedAppEntryUrl.hostname
      && parsedTargetUrl.pathname === parsedAppEntryUrl.pathname
    );
  } catch {
    return false;
  }
}

export function isTrustedAppOrigin(
  targetUrl: string,
  { appEntryUrl, isDevelopment }: AppUrlPolicyOptions,
): boolean {
  try {
    const parsedTargetUrl = new URL(targetUrl);
    const parsedReferenceUrl = new URL(isDevelopment ? DEV_SERVER_URL : appEntryUrl);

    if (parsedTargetUrl.protocol !== parsedReferenceUrl.protocol) return false;
    if (parsedTargetUrl.hostname !== parsedReferenceUrl.hostname) return false;
    if (isDevelopment && parsedTargetUrl.port !== parsedReferenceUrl.port) return false;

    return true;
  } catch {
    return false;
  }
}
