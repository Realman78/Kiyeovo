import { app } from 'electron';
import {
  disableLinuxAutostart,
  enableLinuxAutostart,
  isLinuxAutostartEnabled,
} from './autostart-linux.js';

const HIDDEN_LAUNCH_ARG = '--hidden';

/**
 * Path to the binary that should be relaunched at login. When running from
 * an AppImage, `process.execPath` points at the ephemeral mount under
 * `/tmp`, not the actual `.AppImage` file the user launched - `$APPIMAGE`
 * (set by the AppImage runtime) is the stable path in that case.
 */
function resolveLaunchExecPath(): string {
  return process.env.APPIMAGE || process.execPath;
}

/** True on win32/darwin, where Electron's own login-item API is used. */
function usesNativeLoginItemApi(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

export function getLaunchOnLoginEnabled(): boolean {
  if (usesNativeLoginItemApi()) {
    // Windows requires querying with the SAME args the login item was
    // registered with, or openAtLogin is reported false even when the
    // entry exists (Electron matches the full command line).
    const options = process.platform === 'win32' ? { args: [HIDDEN_LAUNCH_ARG] } : {};
    return app.getLoginItemSettings(options).openAtLogin;
  }
  if (process.platform === 'linux') {
    return isLinuxAutostartEnabled();
  }
  return false;
}

export function setLaunchOnLoginEnabled(enabled: boolean): void {
  if (usesNativeLoginItemApi()) {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled, // macOS only; ignored elsewhere.
      // Keep args identical for register AND remove - on Windows the args
      // are part of the registry entry's identity, so removing with
      // different args would leave the original entry behind.
      args: [HIDDEN_LAUNCH_ARG],
    });
    return;
  }
  if (process.platform === 'linux') {
    if (enabled) {
      enableLinuxAutostart(resolveLaunchExecPath());
    } else {
      disableLinuxAutostart();
    }
  }
}

/**
 * True if this launch should keep the main window hidden in the tray -
 * either because the OS reports it was opened as a login item hidden
 * (win32/darwin) or because our own autostart entry passed `--hidden`
 * (linux, and a defensive check on every platform).
 */
export function isStartedHidden(): boolean {
  if (process.argv.includes(HIDDEN_LAUNCH_ARG)) {
    return true;
  }
  if (usesNativeLoginItemApi()) {
    return app.getLoginItemSettings().wasOpenedAsHidden;
  }
  return false;
}
