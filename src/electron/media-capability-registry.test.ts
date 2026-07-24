import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import {
  mintMediaToken,
  resolveMediaCapability,
  resolveServedContentType,
  revokeMediaToken,
} from './media-capability-registry.js';

function uniquePath(name: string): string {
  return join('/tmp', `kiyeovo-media-capability-${randomUUID()}`, name);
}

test('mintMediaToken rejects relative paths', () => {
  assert.throws(() => mintMediaToken('relative/path.png', 'image'), /absolute/);
});

test('mintMediaToken is stable per canonical path and records the minted kind', () => {
  const imagePath = uniquePath('photo.png');
  const tokenA = mintMediaToken(imagePath, 'image');
  const tokenB = mintMediaToken(imagePath, 'image');
  assert.equal(tokenA, tokenB);

  const capability = resolveMediaCapability(tokenA);
  assert.deepEqual(capability, { canonicalPath: imagePath, kind: 'image' });
});

test('revokeMediaToken removes the capability so it no longer resolves', () => {
  const imagePath = uniquePath('revoked.png');
  const token = mintMediaToken(imagePath, 'image');
  assert.ok(resolveMediaCapability(token));

  revokeMediaToken(token, imagePath);
  assert.equal(resolveMediaCapability(token), undefined);

  // Revoking clears the reverse (path -> token) index too, so minting again for the same path
  // issues a fresh token rather than resurrecting the revoked one.
  const reissued = mintMediaToken(imagePath, 'image');
  assert.notEqual(reissued, token);
});

test('resolveServedContentType hardcodes audio/webm for voice-note capabilities regardless of extension', () => {
  // The `mime-types` package maps a `.webm` filename to `video/webm` — resolveServedContentType
  // must not consult it for voice-note capabilities, or every voice note would 415.
  assert.equal(resolveServedContentType('voice-note', '/some/path/clip.webm'), 'audio/webm');
  assert.equal(resolveServedContentType('voice-note', '/some/path/clip.unknownext'), 'audio/webm');
});

test('resolveServedContentType only accepts image/* for image capabilities, and does not blanket-allow video/*', () => {
  assert.equal(resolveServedContentType('image', '/some/path/photo.png'), 'image/png');
  assert.equal(resolveServedContentType('image', '/some/path/photo.jpg'), 'image/jpeg');
  // An image capability pointed at a .webm file must still be rejected — the kind alone doesn't
  // bypass the image/* gate for the image path, and video/* is never served.
  assert.equal(resolveServedContentType('image', '/some/path/clip.webm'), null);
  assert.equal(resolveServedContentType('image', '/some/path/unknown.bin'), null);
});
