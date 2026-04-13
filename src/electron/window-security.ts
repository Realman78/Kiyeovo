import { shell, type BrowserWindow } from 'electron';
import { ALLOWED_EXTERNAL_URLS, DEV_SERVER_URL } from './constants.js';

type WindowSecurityOptions = {
  appEntryUrl: string;
  isDevelopment: boolean;
};

function normalizeExternalUrl(targetUrl: string): string | null {
  try {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      return null;
    }

    const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    return `${parsedUrl.origin}${normalizedPathname}`;
  } catch {
    return null;
  }
}

function isAllowedExternalUrl(targetUrl: string): boolean {
  const normalizedUrl = normalizeExternalUrl(targetUrl);
  if (!normalizedUrl) {
    return false;
  }

  return ALLOWED_EXTERNAL_URLS.has(normalizedUrl);
}

function openAllowedExternalUrl(targetUrl: string): void {
  if (!isAllowedExternalUrl(targetUrl)) {
    console.warn(`[Electron][SECURITY] Blocked external URL: ${targetUrl}`);
    return;
  }

  void shell.openExternal(targetUrl);
}

function isAllowedNavigationUrl(
  targetUrl: string,
  { appEntryUrl, isDevelopment }: WindowSecurityOptions,
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

export function applyWindowSecurityPolicies(
  win: BrowserWindow,
  options: WindowSecurityOptions,
): void {
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedNavigationUrl(targetUrl, options)) {
      return;
    }

    event.preventDefault();
    openAllowedExternalUrl(targetUrl);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openAllowedExternalUrl(url);
    return { action: 'deny' };
  });
}
