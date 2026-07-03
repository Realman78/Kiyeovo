import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareTextUpload } from './text-upload.js';

test('prepareTextUpload returns trimmed UTF-8 bytes for a portable txt filename', () => {
  const result = prepareTextUpload('  hello\nworld  ', ' note.txt ', 100);

  assert.equal(result.success, true);
  assert.equal(result.fileName, 'note.txt');
  assert.deepEqual(result.bytes, Buffer.from('hello\nworld', 'utf8'));
  assert.equal(result.error, null);
});

test('prepareTextUpload rejects empty or non-string text', () => {
  assert.deepEqual(prepareTextUpload('   ', 'note.txt', 100), {
    success: false,
    fileName: null,
    bytes: null,
    error: 'Text content is required',
  });
  assert.deepEqual(prepareTextUpload(null, 'note.txt', 100), {
    success: false,
    fileName: null,
    bytes: null,
    error: 'Text content is required',
  });
});

test('prepareTextUpload rejects path-like, reserved, malformed, and oversized filenames', () => {
  assert.equal(prepareTextUpload('hello', '../note.txt', 100).error, 'Text upload filename must not contain a path');
  assert.equal(prepareTextUpload('hello', 'nested/note.txt', 100).error, 'Text upload filename must not contain a path');
  assert.equal(prepareTextUpload('hello', 'CON.txt', 100).error, 'Text upload filename is reserved by the operating system');
  assert.equal(prepareTextUpload('hello', 'bad:name.txt', 100).error, 'Text upload filename contains unsupported characters');
  assert.equal(prepareTextUpload('hello', 'note.md', 100).error, 'Text upload filename must end in .txt');
  assert.equal(prepareTextUpload('hello', '.txt', 100).error, 'Text upload filename is invalid');
  assert.equal(prepareTextUpload('hello', 'a'.repeat(252) + '.txt', 100).error, 'Text upload filename is too long');
});

test('prepareTextUpload enforces the configured byte limit after trimming', () => {
  assert.equal(
    prepareTextUpload('åå', 'note.txt', 3).error,
    'Text exceeds the configured file-size limit (3 bytes)',
  );
});
