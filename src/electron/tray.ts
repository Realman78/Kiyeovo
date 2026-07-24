import { app, Menu, nativeImage, Notification, Tray } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import type { P2PCore } from '../core/index.js';
import { getTrayBackgroundNoticeShown, setTrayBackgroundNoticeShown } from './tray-settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AppTrayOptions {
  /** Called when the user picks "Open Kiyeovo" from the menu, or (win/linux) left-clicks the icon. */
  onOpen: () => void;
  /** Called when the user picks "Quit" from the menu. */
  onQuit: () => void;
}

export type AppTray = Tray;

function resolveIconsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '..', '..', 'resources', 'icons');
}

function resolveTrayIconPath(): string {
  const iconsDir = resolveIconsDir();
  // macOS menu-bar icons render best small; we don't have a genuine
  // monochrome "template" asset, so use a small colored icon instead of
  // naming it *Template.png (Electron would then mis-render non-template
  // art as if it were a template image).
  const fileName = process.platform === 'darwin' ? '24x24.png' : '32x32.png';
  return path.join(iconsDir, fileName);
}

/**
 * Creates the tray icon + context menu (Open Kiyeovo / Quit). Never throws:
 * on any failure (icon missing, platform has no tray support, etc.) it logs
 * and returns null so callers can fall back to normal close-quits behavior.
 * This is the important safety net - closing to a tray that doesn't exist
 * would leave the app running invisibly with no way back.
 */
export function createAppTray(options: AppTrayOptions): AppTray | null {
  try {
    const icon = nativeImage.createFromPath(resolveTrayIconPath());
    if (icon.isEmpty()) {
      throw new Error(`Tray icon failed to load from ${resolveTrayIconPath()}`);
    }

    const tray = new Tray(icon);
    tray.setToolTip('Kiyeovo');

    const menu = Menu.buildFromTemplate([
      { label: 'Open Kiyeovo', click: () => options.onOpen() },
      { type: 'separator' },
      { label: 'Quit', click: () => options.onQuit() },
    ]);
    tray.setContextMenu(menu);

    // macOS already opens the menu on click; adding our own click handler
    // there causes the "click-to-toggle" weirdness the spec explicitly
    // avoids. Left-click show+focus is a win/linux-only affordance.
    if (process.platform !== 'darwin') {
      tray.on('click', () => options.onOpen());
    }

    return tray;
  } catch (error) {
    console.error('[Tray] Failed to create system tray icon; close/minimize-to-tray disabled:', error);
    return null;
  }
}

/**
 * Shows "Kiyeovo is still running in the tray" exactly once, the first time
 * the window is ever hidden to tray instead of closed.
 */
export function showTrayBackgroundNoticeOnce(getP2PCore: () => P2PCore | null): void {
  if (getTrayBackgroundNoticeShown(getP2PCore)) {
    return;
  }
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Kiyeovo',
        body: 'Kiyeovo is still running in the tray',
      }).show();
    }
  } catch (error) {
    console.error('[Tray] Failed to show background notice:', error);
  } finally {
    setTrayBackgroundNoticeShown(getP2PCore);
  }
}
