import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PORTABLE_FILENAME_BYTES, validatePortableFileName } from './portable-filename.js';

test('portable filename validation accepts a canonical cross-platform basename', () => {
  assert.deepEqual(validatePortableFileName('report.final-1.pdf'), {
    ok: true,
    fileName: 'report.final-1.pdf',
  });
});

test('portable filename validation rejects paths, device names, and unsupported characters', () => {
  const invalidNames = [
    '../report.pdf',
    'nested/report.pdf',
    'nested\\report.pdf',
    '.',
    '..',
    'CON.txt',
    'con .txt',
    'NUL',
    'COM1.log',
    'COM¹.log',
    'LPT9',
    'LPT².txt',
    'bad:name.txt',
    'bad?.txt',
    'report.',
    'report ',
    ' report.txt',
    'report.txt ',
    'control\u0000.txt',
  ];

  for (const fileName of invalidNames) {
    assert.equal(validatePortableFileName(fileName).ok, false, fileName);
  }
});

test('portable filename validation enforces the UTF-8 component limit', () => {
  assert.equal(validatePortableFileName('a'.repeat(MAX_PORTABLE_FILENAME_BYTES)).ok, true);
  assert.deepEqual(validatePortableFileName('a'.repeat(MAX_PORTABLE_FILENAME_BYTES + 1)), {
    ok: false,
    reason: 'too_long',
  });
});

test('portable filename validation trims only when explicitly requested', () => {
  assert.deepEqual(validatePortableFileName(' note.txt ', { trimOuterWhitespace: true }), {
    ok: true,
    fileName: 'note.txt',
  });
  assert.deepEqual(validatePortableFileName(' note.txt '), {
    ok: false,
    reason: 'invalid',
  });
});
