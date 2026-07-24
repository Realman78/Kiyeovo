import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DESKTOP_FILE_NAME = 'kiyeovo.desktop';
const HIDDEN_LAUNCH_ARG = '--hidden';

/** Escapes a single argument for placement inside a desktop-entry Exec= value. */
function escapeExecArg(value: string): string {
  // Per the Desktop Entry Specification, Exec values are first split on
  // whitespace, then each field passes through the "quoted" escaping rules.
  // Wrapping in double quotes and escaping the characters that are special
  // inside a quoted field ("\`$) keeps paths with spaces intact. `%` must
  // additionally be doubled (%% is the literal percent) or it would start a
  // field code like %f and corrupt the Exec line - a path like
  // `/opt/100%free/Kiyeovo.AppImage` would otherwise break login startup.
  return `"${value.replace(/([\\"$`])/g, '\\$1').replace(/%/g, '%%')}"`;
}

/**
 * Builds the content of the `~/.config/autostart/kiyeovo.desktop` file that
 * makes Linux desktop environments launch Kiyeovo at login, hidden in the
 * tray (via the `--hidden` argv flag main.ts checks at startup).
 *
 * Pure function - no filesystem access - so it can be unit tested directly.
 */
export function generateDesktopEntryContent(execPath: string): string {
  const exec = `${escapeExecArg(execPath)} ${HIDDEN_LAUNCH_ARG}`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Kiyeovo',
    'Comment=Start Kiyeovo minimized to the system tray',
    `Exec=${exec}`,
    'Terminal=false',
    'Hidden=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function getAutostartDirPath(homeDir: string = homedir()): string {
  return join(homeDir, '.config', 'autostart');
}

export function getAutostartFilePath(homeDir: string = homedir()): string {
  return join(getAutostartDirPath(homeDir), DESKTOP_FILE_NAME);
}

export function enableLinuxAutostart(execPath: string, homeDir: string = homedir()): void {
  const dir = getAutostartDirPath(homeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getAutostartFilePath(homeDir), generateDesktopEntryContent(execPath), 'utf-8');
}

export function disableLinuxAutostart(homeDir: string = homedir()): void {
  const filePath = getAutostartFilePath(homeDir);
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

/**
 * Best-effort check: a Kiyeovo-authored autostart entry exists and is not
 * disabled (`Hidden=true` or `X-GNOME-Autostart-enabled=false` would both
 * suppress autostart in a compliant DE, but we only ever write "enabled"
 * entries ourselves, so plain existence is a reliable enough signal for our
 * own toggle state).
 */
export function isLinuxAutostartEnabled(homeDir: string = homedir()): boolean {
  const filePath = getAutostartFilePath(homeDir);
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const content = readFileSync(filePath, 'utf-8');
    return !/^Hidden=true\s*$/m.test(content);
  } catch {
    return false;
  }
}
