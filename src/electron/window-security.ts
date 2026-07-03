import { shell, type BrowserWindow } from 'electron';
import { resolveAllowedExternalUrl } from './external-url-policy.js';
import { isTrustedAppUrl, type AppUrlPolicyOptions } from './app-url-policy.js';

function openAllowedExternalUrl(targetUrl: string): void {
  const allowedUrl = resolveAllowedExternalUrl(targetUrl);
  if (!allowedUrl) {
    console.warn(`[Electron][SECURITY] Blocked external URL: ${targetUrl}`);
    return;
  }

  void shell.openExternal(allowedUrl);
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

  win.webContents.on('will-redirect', (event, targetUrl) => {
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
