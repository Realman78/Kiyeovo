import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PORTABLE_FILENAME_BYTES,
  checkPortableFileName,
  containsUnsupportedFileNameCharacter,
  exceedsMaxPortableFilenameBytes,
  hasTrailingDotOrSpace,
  isPathTraversalSegment,
  isWindowsReservedBasename,
  sanitizePortableFileName,
  windowsBasenameOf,
} from './portable-filename.js';

test('isPathTraversalSegment flags dot/dot-dot and separators', () => {
  for (const value of ['.', '..', 'a/b', 'a\\b', '../x', 'nested/report.pdf']) {
    assert.equal(isPathTraversalSegment(value), true, value);
  }
  for (const value of ['report.pdf', '..hidden', 'a.b.c']) {
    assert.equal(isPathTraversalSegment(value), false, value);
  }
});

test('containsUnsupportedFileNameCharacter flags each Windows-forbidden character', () => {
  for (const char of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
    assert.equal(containsUnsupportedFileNameCharacter(`bad${char}name.txt`), true, char);
  }
  assert.equal(containsUnsupportedFileNameCharacter('fine-name.txt'), false);
});

test('containsUnsupportedFileNameCharacter flags control characters and DEL', () => {
  assert.equal(containsUnsupportedFileNameCharacter('bad\x00name.txt'), true);
  assert.equal(containsUnsupportedFileNameCharacter('bad\x1Fname.txt'), true);
  assert.equal(containsUnsupportedFileNameCharacter('bad\x7Fname.txt'), true);
  assert.equal(containsUnsupportedFileNameCharacter('bad\nname.txt'), true);
});

test('hasTrailingDotOrSpace', () => {
  assert.equal(hasTrailingDotOrSpace('name.'), true);
  assert.equal(hasTrailingDotOrSpace('name '), true);
  assert.equal(hasTrailingDotOrSpace('name.txt'), false);
});

test('windowsBasenameOf takes the portion before the first dot', () => {
  assert.equal(windowsBasenameOf('CON'), 'CON');
  assert.equal(windowsBasenameOf('CON.txt'), 'CON');
  assert.equal(windowsBasenameOf('CON.tar.gz'), 'CON');
  assert.equal(windowsBasenameOf('foo.CON.txt'), 'foo');
});

test('isWindowsReservedBasename covers every reserved device name, case-insensitively', () => {
  const reserved = ['CON', 'con', 'Prn', 'AUX', 'NUL', 'COM1', 'com9', 'LPT1', 'lpt9'];
  for (const name of reserved) {
    assert.equal(isWindowsReservedBasename(name), true, name);
  }
  for (const name of ['CONSOLE', 'COM0', 'COM10', 'LPT0', 'LPT10', 'NULL', 'document']) {
    assert.equal(isWindowsReservedBasename(name), false, name);
  }
});

test('isWindowsReservedBasename covers the superscript COM/LPT device names', () => {
  const reserved = ['COM¹', 'com¹', 'COM²', 'COM³', 'LPT¹', 'lpt¹', 'LPT²', 'LPT³'];
  for (const name of reserved) {
    assert.equal(isWindowsReservedBasename(name), true, name);
  }
  // Superscript digits only exist for 1-3 in this context (there's no reserved COM⁴/LPT⁵, etc.),
  // and the superscript form must be an exact basename match, not merely a prefix/suffix.
  for (const name of ['COM⁴', 'COM¹0', 'X COM¹', 'CONSOLE¹']) {
    assert.equal(isWindowsReservedBasename(name), false, name);
  }
});

test('exceedsMaxPortableFilenameBytes uses a UTF-8 byte budget, not code-unit length', () => {
  assert.equal(exceedsMaxPortableFilenameBytes('a'.repeat(MAX_PORTABLE_FILENAME_BYTES)), false);
  assert.equal(exceedsMaxPortableFilenameBytes('a'.repeat(MAX_PORTABLE_FILENAME_BYTES + 1)), true);
  // Multi-byte characters count by UTF-8 bytes.
  assert.equal(exceedsMaxPortableFilenameBytes('é'.repeat(MAX_PORTABLE_FILENAME_BYTES / 2 + 1)), true);
});

test('checkPortableFileName accepts an already-safe name', () => {
  assert.deepEqual(checkPortableFileName('report.pdf'), { ok: true });
});

test('checkPortableFileName rejects empty/whitespace-only names', () => {
  assert.deepEqual(checkPortableFileName(''), { ok: false, reason: 'empty' });
  assert.deepEqual(checkPortableFileName('   '), { ok: false, reason: 'empty' });
});

test('checkPortableFileName rejects path traversal before other checks', () => {
  assert.deepEqual(checkPortableFileName('../report.pdf'), { ok: false, reason: 'path' });
  assert.deepEqual(checkPortableFileName('nested/report.pdf'), { ok: false, reason: 'path' });
});

test('checkPortableFileName rejects unsupported characters, a trailing dot, reserved names, and overlong names', () => {
  assert.deepEqual(checkPortableFileName('bad:name.txt'), { ok: false, reason: 'unsupported_character' });
  assert.deepEqual(checkPortableFileName('name.'), { ok: false, reason: 'trailing_dot_or_space' });
  // A trailing *space* on the raw input is edge whitespace trim() tolerates (same as the outer
  // leading/trailing-whitespace tolerance voice-note-upload's original validator had) — it never
  // reaches the trailing-dot-or-space check. hasTrailingDotOrSpace is exercised directly above.
  assert.deepEqual(checkPortableFileName('CON.txt'), { ok: false, reason: 'reserved' });
  assert.deepEqual(checkPortableFileName('COM¹.txt'), { ok: false, reason: 'reserved' });
  assert.deepEqual(checkPortableFileName('LPT³.txt'), { ok: false, reason: 'reserved' });
  assert.deepEqual(
    checkPortableFileName(`${'a'.repeat(MAX_PORTABLE_FILENAME_BYTES)}.txt`),
    { ok: false, reason: 'too_long' },
  );
});

// --- sanitizePortableFileName -------------------------------------------------------------

test('sanitizePortableFileName passes an already-safe name through unchanged', () => {
  assert.equal(sanitizePortableFileName('report.pdf'), 'report.pdf');
  assert.equal(sanitizePortableFileName('holiday photo (final).jpg'), 'holiday photo (final).jpg');
});

test('sanitizePortableFileName replaces every Windows-forbidden character with underscore', () => {
  const cases: Array<[string, string]> = [
    ['bad<name.txt', 'bad_name.txt'],
    ['bad>name.txt', 'bad_name.txt'],
    ['bad:name.txt', 'bad_name.txt'],
    ['bad"name.txt', 'bad_name.txt'],
    ['bad|name.txt', 'bad_name.txt'],
    ['bad?name.txt', 'bad_name.txt'],
    ['bad*name.txt', 'bad_name.txt'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizePortableFileName(input), expected, input);
  }
});

test('sanitizePortableFileName replaces control characters', () => {
  assert.equal(sanitizePortableFileName('bad\x00name.txt'), 'bad_name.txt');
  assert.equal(sanitizePortableFileName('bad\nname.txt'), 'bad_name.txt');
  assert.equal(sanitizePortableFileName('bad\x7Fname.txt'), 'bad_name.txt');
});

test('sanitizePortableFileName trims a trailing dot or space', () => {
  assert.equal(sanitizePortableFileName('name.'), 'name');
  assert.equal(sanitizePortableFileName('name '), 'name');
  assert.equal(sanitizePortableFileName('name...'), 'name');
  assert.equal(sanitizePortableFileName('name. . '), 'name');
});

test('sanitizePortableFileName prefixes reserved DOS device basenames, preserving the extension', () => {
  const cases: Array<[string, string]> = [
    ['CON.txt', '_CON.txt'],
    ['con.txt', '_con.txt'],
    ['NUL', '_NUL'],
    ['COM1.pdf', '_COM1.pdf'],
    ['lpt9.tar.gz', '_lpt9.tar.gz'],
    ['PRN', '_PRN'],
    ['AUX.docx', '_AUX.docx'],
    ['COM¹.txt', '_COM¹.txt'],
    ['lpt².tar.gz', '_lpt².tar.gz'],
    ['COM³', '_COM³'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizePortableFileName(input), expected, input);
  }
});

test('sanitizePortableFileName does not touch non-reserved names that merely start similarly', () => {
  assert.equal(sanitizePortableFileName('CONSOLE.txt'), 'CONSOLE.txt');
  assert.equal(sanitizePortableFileName('foo.CON.txt'), 'foo.CON.txt');
});

test('sanitizePortableFileName never returns an empty string', () => {
  assert.equal(sanitizePortableFileName(''), '_file');
  assert.equal(sanitizePortableFileName('   '), '_file');
  assert.equal(sanitizePortableFileName('...'), '_file');
  assert.equal(sanitizePortableFileName('. . .'), '_file');
});

test('sanitizePortableFileName replaces path separators with underscore rather than dropping them', () => {
  // Defense in depth only: file-offer-validation.ts already hard-rejects any offer whose
  // filename contains a path separator before sanitizePortableFileName is ever reached.
  assert.equal(sanitizePortableFileName('/\\'), '__');
  assert.equal(sanitizePortableFileName('a/b\\c.txt'), 'a_b_c.txt');
});

test('sanitizePortableFileName truncates an overlong name to the byte budget, preserving the extension', () => {
  const longName = `${'a'.repeat(300)}.txt`;
  const sanitized = sanitizePortableFileName(longName);
  assert.equal(exceedsMaxPortableFilenameBytes(sanitized), false);
  assert.ok(sanitized.endsWith('.txt'));
  assert.ok(sanitized.length < longName.length);
});

// Byte-budget truncation of "CONX" + this extension leaves a stem budget of exactly 3 bytes,
// which chops the trailing "X" off "CONX" and lands on the reserved basename "CON" — a case a
// single, non-iterating sanitize pass never re-checks. See the byte-budget arithmetic:
// extension is `.` + `a` + 125 * `é` = 1 + 1 + 250 = 252 bytes, leaving a 255 - 252 = 3-byte stem
// budget, i.e. exactly "CON".
const RESERVED_NAME_CREATED_BY_TRUNCATION_EXTENSION = `.a${'é'.repeat(125)}`;

test('sanitizePortableFileName is idempotent', () => {
  const inputs = [
    'report.pdf',
    'bad:name<>.txt',
    'CON.txt',
    'lpt9.tar.gz',
    'name...',
    '',
    '   ',
    `${'a'.repeat(300)}.txt`,
    'foo.CON.txt',
    '\x00\x01\x02',
    // Byte-budget truncation can itself create a reserved basename that was never checked.
    `CONX${RESERVED_NAME_CREATED_BY_TRUNCATION_EXTENSION}`,
    // Superscript COM/LPT device names.
    'COM¹.txt',
    'LPT²X.txt',
    `COM³${'é'.repeat(150)}`,
  ];
  for (const input of inputs) {
    const once = sanitizePortableFileName(input);
    const twice = sanitizePortableFileName(once);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

test('sanitizePortableFileName re-checks reserved-basename and byte-budget after truncation', () => {
  // The raw stem "CONX" isn't reserved, but truncating away the trailing "X" (to make room for a
  // byte-budget-consuming multibyte extension) leaves exactly "CON" — which must be re-detected
  // and re-prefixed, not returned as-is.
  const input = `CONX${RESERVED_NAME_CREATED_BY_TRUNCATION_EXTENSION}`;
  const sanitized = sanitizePortableFileName(input);

  assert.equal(exceedsMaxPortableFilenameBytes(sanitized), false);
  const extensionIndex = sanitized.lastIndexOf('.');
  const stem = extensionIndex > 0 ? sanitized.slice(0, extensionIndex) : sanitized;
  assert.equal(isWindowsReservedBasename(windowsBasenameOf(stem)), false, sanitized);
  assert.equal(sanitizePortableFileName(sanitized), sanitized, 'must already be a fixed point');
});
