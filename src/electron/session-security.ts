import type { BrowserWindow, Session, WebContents, WebFrameMain } from 'electron';
import { ALLOWED_RENDERER_PERMISSIONS } from './constants.js';
import { isTrustedAppOrigin, type AppUrlPolicyOptions } from './app-url-policy.js';

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

function isTrustedMainWindowFrame(
  frame: WebFrameMain | null,
  getMainWindow: SessionSecurityOptions['getMainWindow'],
): boolean {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || !frame) {
    return false;
  }

  try {
    if (frame.isDestroyed()) {
      return false;
    }

    const mainFrame = mainWindow.webContents.mainFrame;
    return frame === mainFrame
      || (
        frame.processId === mainFrame.processId
        && frame.frameToken === mainFrame.frameToken
      );
  } catch {
    return false;
  }
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

  return isTrustedAppOrigin(requestingUrl, options);
}

function logBlockedPermission(permission: string, requestingUrl: string): void {
  console.warn(
    `[Electron][SECURITY] Blocked renderer permission: ${permission} requestingUrl=${requestingUrl || 'unknown'}`,
  );
}

function isAllowedDisplayMediaRequest(
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  options: SessionSecurityOptions,
): boolean {
  if (!request.videoRequested || request.audioRequested || !request.userGesture) {
    return false;
  }

  if (!isTrustedMainWindowFrame(request.frame, options.getMainWindow)) {
    return false;
  }

  const requestingUrl = request.securityOrigin || request.frame?.url || '';
  return isTrustedAppOrigin(requestingUrl, options);
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

  session.setDisplayMediaRequestHandler((request, callback) => {
    const requestingUrl = request.securityOrigin || request.frame?.url || '';
    if (!isAllowedDisplayMediaRequest(request, options)) {
      logBlockedPermission('display-capture', requestingUrl);
      callback({});
      return;
    }

    console.warn(
      '[Electron][SECURITY] Display capture request reached the fallback handler; no desktopCapturer source picker is implemented yet.',
    );
    callback({});
  }, { useSystemPicker: true });
}
