import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  disableLinuxAutostart,
  enableLinuxAutostart,
  generateDesktopEntryContent,
  getAutostartDirPath,
  getAutostartFilePath,
  isLinuxAutostartEnabled,
} from './autostart-linux.js';

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), 'kiyeovo-autostart-test-'));
}

test('generateDesktopEntryContent produces a valid autostart entry with the hidden launch flag', () => {
  const content = generateDesktopEntryContent('/opt/Kiyeovo/kiyeovo');

  assert.match(content, /^\[Desktop Entry\]$/m);
  assert.match(content, /^Type=Application$/m);
  assert.match(content, /^Name=Kiyeovo$/m);
  assert.match(content, /^X-GNOME-Autostart-enabled=true$/m);
  assert.match(content, /^Exec="\/opt\/Kiyeovo\/kiyeovo" --hidden$/m);
});

test('generateDesktopEntryContent escapes paths containing spaces and quote-sensitive characters', () => {
  const content = generateDesktopEntryContent('/opt/My "Apps"/Kiyeovo $HOME/kiyeovo');

  assert.match(content, /^Exec="\/opt\/My \\"Apps\\"\/Kiyeovo \\\$HOME\/kiyeovo" --hidden$/m);
});

test('generateDesktopEntryContent doubles percent signs so they cannot start Exec field codes', () => {
  const content = generateDesktopEntryContent('/opt/100%free/Kiyeovo.AppImage');

  assert.match(content, /^Exec="\/opt\/100%%free\/Kiyeovo\.AppImage" --hidden$/m);
});

test('getAutostartFilePath / getAutostartDirPath point at ~/.config/autostart/kiyeovo.desktop', () => {
  // Computed via join() rather than POSIX literals: on a win32 test runner
  // path.join emits backslashes, but the runtime code only ever executes on
  // Linux, so the SHAPE (home + .config/autostart/kiyeovo.desktop) is what
  // this test asserts - not the separator.
  assert.equal(getAutostartDirPath('/home/alice'), join('/home/alice', '.config', 'autostart'));
  assert.equal(
    getAutostartFilePath('/home/alice'),
    join('/home/alice', '.config', 'autostart', 'kiyeovo.desktop'),
  );
});

test('enableLinuxAutostart / isLinuxAutostartEnabled / disableLinuxAutostart round-trip', () => {
  const homeDir = makeTempHome();
  try {
    assert.equal(isLinuxAutostartEnabled(homeDir), false);

    enableLinuxAutostart('/opt/Kiyeovo/kiyeovo', homeDir);
    assert.equal(isLinuxAutostartEnabled(homeDir), true);

    disableLinuxAutostart(homeDir);
    assert.equal(isLinuxAutostartEnabled(homeDir), false);

    // Disabling when nothing exists must not throw.
    disableLinuxAutostart(homeDir);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
