import { shell, type BrowserWindow } from 'electron';
import { ALLOWED_EXTERNAL_URLS } from './constants.js';
import { isTrustedAppUrl, type AppUrlPolicyOptions } from './app-url-policy.js';

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

export function applyWindowSecurityPolicies(
  win: BrowserWindow,
  options: AppUrlPolicyOptions,
): void {
  win.webContents.on('will-attach-webview', (event, _webPreferences, params) => {
    event.preventDefault();
    console.warn(`[Electron][SECURITY] Blocked webview attachment src=${params.src || 'unknown'}`);
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isTrustedAppUrl(targetUrl, options)) {
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
