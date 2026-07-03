import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import test from 'node:test';
import { getPackagedAppEntryUrl } from './app-entry-url.js';
import { isTrustedAppOrigin, isTrustedAppUrl } from './app-url-policy.js';
import {
  APP_PROTOCOL_HOST,
  APP_PROTOCOL_SCHEME,
  DEV_SERVER_URL,
  MEDIA_PROTOCOL_HOST,
  MEDIA_PROTOCOL_SCHEME,
} from './constants.js';
import { normalizeExternalUrl, resolveAllowedExternalUrl } from './external-url-policy.js';
import { isNetworkConnected } from './network-connectivity.js';

test('Electron packaged URL helpers and trust policy recognize only the app surface', () => {
  const appEntryUrl = getPackagedAppEntryUrl();

  assert.equal(APP_PROTOCOL_SCHEME, 'kiyeovo');
  assert.equal(APP_PROTOCOL_HOST, 'app');
  assert.equal(MEDIA_PROTOCOL_SCHEME, 'kiyeovo-media');
  assert.equal(MEDIA_PROTOCOL_HOST, 'media');
  assert.equal(appEntryUrl, 'kiyeovo://app/index.html');

  assert.equal(isTrustedAppUrl(appEntryUrl, { appEntryUrl, isDevelopment: false }), true);
  assert.equal(isTrustedAppUrl('kiyeovo://app/settings.html', { appEntryUrl, isDevelopment: false }), false);
  assert.equal(isTrustedAppUrl('file:///tmp/index.html', { appEntryUrl, isDevelopment: false }), false);
  assert.equal(isTrustedAppOrigin('kiyeovo://app/other-view', { appEntryUrl, isDevelopment: false }), true);

  assert.equal(isTrustedAppUrl(DEV_SERVER_URL, { appEntryUrl, isDevelopment: true }), true);
  assert.equal(isTrustedAppUrl('http://localhost:9999/', { appEntryUrl, isDevelopment: true }), false);
  assert.equal(isTrustedAppOrigin('http://localhost:3000/other', { appEntryUrl, isDevelopment: true }), true);
});

test('Electron external URL policy normalizes only explicit HTTPS allowlist entries', () => {
  assert.equal(
    normalizeExternalUrl('https://github.com/Realman78/Kiyeovo/issues/'),
    'https://github.com/Realman78/Kiyeovo/issues',
  );
  assert.equal(
    resolveAllowedExternalUrl('https://github.com/Realman78/Kiyeovo/issues/'),
    'https://github.com/Realman78/Kiyeovo/issues',
  );
  assert.equal(resolveAllowedExternalUrl('https://github.com/Realman78/Kiyeovo/pulls'), null);
  assert.equal(resolveAllowedExternalUrl('http://github.com/Realman78/Kiyeovo'), null);
  assert.equal(resolveAllowedExternalUrl('https://user:pass@github.com/Realman78/Kiyeovo'), null);
  assert.equal(resolveAllowedExternalUrl('file:///tmp/index.html'), null);
});

test('preload source exposes only the frozen kiyeovoAPI bridge, not raw ipcRenderer', async () => {
  const preloadSource = await readFile(new URL('./preload.cts', import.meta.url), 'utf8');

  assert.equal(
    preloadSource.includes("contextBridge.exposeInMainWorld('kiyeovoAPI', Object.freeze(kiyeovoAPI));"),
    true,
  );
  assert.equal(/exposeInMainWorld\(['"]ipcRenderer/.test(preloadSource), false);
  assert.equal(/window\.(ipcRenderer|electron)\s*=/.test(preloadSource), false);
});

test('network connectivity smoke ignores virtual and link-local-only interfaces', (t) => {
  let interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    eth0: [{ address: '169.254.10.5', family: 'IPv4', internal: false }],
    wlan0: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
  } as unknown as ReturnType<typeof os.networkInterfaces>;
  t.mock.method(os, 'networkInterfaces', () => interfaces);

  assert.equal(isNetworkConnected(), false);

  interfaces = {
    eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
  } as unknown as ReturnType<typeof os.networkInterfaces>;
  assert.equal(isNetworkConnected(), true);
});
