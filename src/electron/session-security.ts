import type { BrowserWindow, Session, WebContents } from 'electron';
import { ALLOWED_RENDERER_PERMISSIONS } from './constants.js';
import { isTrustedAppUrl, type AppUrlPolicyOptions } from './app-url-policy.js';

type SessionSecurityOptions = AppUrlPolicyOptions & {
  getMainWindow: () => BrowserWindow | null;
};

function isTrustedMainWindowWebContents(
  webContents: WebContents | null,
  getMainWindow: SessionSecurityOptions['getMainWindow'],
): boolean {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || !webContents) {
    return false;
  }

  return webContents === mainWindow.webContents;
}

function isAllowedRendererPermission(
  permission: string,
  webContents: WebContents | null,
  requestingUrl: string,
  isMainFrame: boolean,
  options: SessionSecurityOptions,
): boolean {
  if (!ALLOWED_RENDERER_PERMISSIONS.has(permission)) {
    return false;
  }

  if (!isMainFrame) {
    return false;
  }

  if (!isTrustedMainWindowWebContents(webContents, options.getMainWindow)) {
    return false;
  }

  return isTrustedAppUrl(requestingUrl, options);
}

function logBlockedPermission(permission: string, requestingUrl: string): void {
  console.warn(
    `[Electron][SECURITY] Blocked renderer permission: ${permission} requestingUrl=${requestingUrl || 'unknown'}`,
  );
}

export function applySessionSecurityPolicies(
  session: Session,
  options: SessionSecurityOptions,
): void {
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl || requestingOrigin || webContents?.getURL() || '';
    const allowed = isAllowedRendererPermission(
      permission,
      webContents,
      requestingUrl,
      details.isMainFrame,
      options,
    );

    if (!allowed) {
      logBlockedPermission(permission, requestingUrl);
    }

    return allowed;
  });

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = ('requestingUrl' in details && typeof details.requestingUrl === 'string')
      ? details.requestingUrl
      : webContents.getURL();
    const isMainFrame = 'isMainFrame' in details ? Boolean(details.isMainFrame) : true;
    const allowed = isAllowedRendererPermission(
      permission,
      webContents,
      requestingUrl,
      isMainFrame,
      options,
    );

    if (!allowed) {
      logBlockedPermission(permission, requestingUrl);
    }

    callback(allowed);
  });
}
