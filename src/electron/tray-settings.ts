import type { P2PCore } from '../core/index.js';
import {
  CLOSE_TO_TRAY_SETTING_KEY,
  MINIMIZE_TO_TRAY_SETTING_KEY,
  TRAY_BACKGROUND_NOTICE_SHOWN_SETTING_KEY,
} from '../core/constants.js';
import { withSettingsDatabase } from './settings-db.js';

// Defaults per the system-tray spec: close-to-tray is on by default,
// minimize-to-tray is opt-in.
const DEFAULT_CLOSE_TO_TRAY = true;
const DEFAULT_MINIMIZE_TO_TRAY = false;

function readBoolSetting(
  getP2PCore: () => P2PCore | null,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = withSettingsDatabase(getP2PCore, (db) => db.getSetting(key));
  return value === null ? defaultValue : value === 'true';
}

function writeBoolSetting(
  getP2PCore: () => P2PCore | null,
  key: string,
  value: boolean,
): void {
  withSettingsDatabase(getP2PCore, (db) => db.setSetting(key, value ? 'true' : 'false'));
}

export function getCloseToTrayEnabled(getP2PCore: () => P2PCore | null): boolean {
  return readBoolSetting(getP2PCore, CLOSE_TO_TRAY_SETTING_KEY, DEFAULT_CLOSE_TO_TRAY);
}

export function setCloseToTrayEnabled(getP2PCore: () => P2PCore | null, enabled: boolean): void {
  writeBoolSetting(getP2PCore, CLOSE_TO_TRAY_SETTING_KEY, enabled);
}

export function getMinimizeToTrayEnabled(getP2PCore: () => P2PCore | null): boolean {
  return readBoolSetting(getP2PCore, MINIMIZE_TO_TRAY_SETTING_KEY, DEFAULT_MINIMIZE_TO_TRAY);
}

export function setMinimizeToTrayEnabled(getP2PCore: () => P2PCore | null, enabled: boolean): void {
  writeBoolSetting(getP2PCore, MINIMIZE_TO_TRAY_SETTING_KEY, enabled);
}

export function getTrayBackgroundNoticeShown(getP2PCore: () => P2PCore | null): boolean {
  return readBoolSetting(getP2PCore, TRAY_BACKGROUND_NOTICE_SHOWN_SETTING_KEY, false);
}

export function setTrayBackgroundNoticeShown(getP2PCore: () => P2PCore | null): void {
  writeBoolSetting(getP2PCore, TRAY_BACKGROUND_NOTICE_SHOWN_SETTING_KEY, true);
}
