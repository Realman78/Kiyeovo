import assert from 'node:assert/strict';
import test from 'node:test';
import { isScreenShareSupported } from './screen-share-support.js';

test('screen sharing is enabled on every supported desktop platform', () => {
  assert.equal(isScreenShareSupported('darwin'), true);
  assert.equal(isScreenShareSupported('linux'), true);
  assert.equal(isScreenShareSupported('win32'), true);
});

test('screen sharing remains disabled on unsupported platforms', () => {
  assert.equal(isScreenShareSupported('aix'), false);
  assert.equal(isScreenShareSupported('freebsd'), false);
});
