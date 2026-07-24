import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeFileWithCopySuffix, writeIncomingFileWithCopySuffix, safeDownloadBasename } from './file-storage.js';
import { MAX_PORTABLE_FILENAME_BYTES, exceedsMaxPortableFilenameBytes } from '../utils/portable-filename.js';

test('safeDownloadBasename rejects traversal and path separators', () => {
  assert.equal(safeDownloadBasename('report.pdf'), 'report.pdf');
  for (const name of ['../report.pdf', 'nested/report.pdf', 'nested\\report.pdf', '.', '..', '']) {
    assert.throws(() => safeDownloadBasename(name), /Invalid download filename/);
  }
});

test('writeFileWithCopySuffix never overwrites an existing file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  const firstPath = join(dir, 'report.txt');
  await writeFile(firstPath, 'existing');

  const savedPath = await writeFileWithCopySuffix(dir, 'report.txt', Buffer.from('new file'));

  assert.notEqual(savedPath, firstPath);
  assert.equal(await readFile(firstPath, 'utf8'), 'existing');
  assert.equal(await readFile(savedPath, 'utf8'), 'new file');
});

test('writeIncomingFileWithCopySuffix sanitizes a Windows-incompatible offered filename before writing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  const savedPath = await writeIncomingFileWithCopySuffix(dir, 'CON.txt', Buffer.from('peer offer'));

  assert.equal(savedPath, join(dir, '_CON.txt'));
  assert.equal(await readFile(savedPath, 'utf8'), 'peer offer');
});

test('writeIncomingFileWithCopySuffix leaves an already-portable offered filename unchanged', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  const savedPath = await writeIncomingFileWithCopySuffix(dir, 'report.pdf', Buffer.from('peer offer'));

  assert.equal(savedPath, join(dir, 'report.pdf'));
});

test('writeIncomingFileWithCopySuffix still applies collision-safe copy suffixing after sanitization', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  const firstPath = await writeIncomingFileWithCopySuffix(dir, 'NUL.txt', Buffer.from('first'));
  const secondPath = await writeIncomingFileWithCopySuffix(dir, 'NUL.txt', Buffer.from('second'));

  assert.equal(firstPath, join(dir, '_NUL.txt'));
  assert.notEqual(secondPath, firstPath);
  assert.equal(await readFile(firstPath, 'utf8'), 'first');
  assert.equal(await readFile(secondPath, 'utf8'), 'second');
});

test('writeIncomingFileWithCopySuffix byte-budgets the collision suffix so a near-limit multibyte name can still save twice', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  // 125 two-byte 'é' characters + '.txt' = 254 bytes: already sanitized to fit under the 255-byte
  // ceiling on its own, but not with enough headroom left for a `_copy_<timestamp>` suffix
  // (roughly 20 more bytes) to fit alongside it too. Before the fix, the second write's
  // collision-suffixed candidate name would exceed the OS filename limit and fail (ENAMETOOLONG)
  // instead of falling back to a `_copy_...` name like every other collision does.
  const offeredFileName = `${'é'.repeat(125)}.txt`;
  assert.equal(exceedsMaxPortableFilenameBytes(offeredFileName), false);

  const firstPath = await writeIncomingFileWithCopySuffix(dir, offeredFileName, Buffer.from('first'));
  const secondPath = await writeIncomingFileWithCopySuffix(dir, offeredFileName, Buffer.from('second'));

  assert.equal(firstPath, join(dir, offeredFileName));
  assert.notEqual(secondPath, firstPath);
  assert.equal(exceedsMaxPortableFilenameBytes(basename(secondPath)), false);
  assert.ok(basename(secondPath).endsWith('.txt'));
  assert.equal(await readFile(firstPath, 'utf8'), 'first');
  assert.equal(await readFile(secondPath, 'utf8'), 'second');
});

test('writeFileWithCopySuffix byte-budgets the collision suffix for locally-generated names too', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  const fileName = `${'a'.repeat(MAX_PORTABLE_FILENAME_BYTES - 4)}.txt`;
  assert.equal(exceedsMaxPortableFilenameBytes(fileName), false);

  const firstPath = await writeFileWithCopySuffix(dir, fileName, Buffer.from('first'));
  const secondPath = await writeFileWithCopySuffix(dir, fileName, Buffer.from('second'));

  assert.equal(firstPath, join(dir, fileName));
  assert.notEqual(secondPath, firstPath);
  assert.equal(exceedsMaxPortableFilenameBytes(basename(secondPath)), false);
  assert.equal(await readFile(firstPath, 'utf8'), 'first');
  assert.equal(await readFile(secondPath, 'utf8'), 'second');
});

test('writeFileWithCopySuffix byte-budgets a near-limit extension so a collision candidate still fits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-download-test-'));
  t.after(() => { void rm(dir, { recursive: true, force: true }); });

  // A 1-byte stem with a ~249-byte single-segment extension is a valid ≤255-byte name on its
  // own, but the extension alone leaves no room for the mandatory `_copy_<timestamp>` suffix.
  // Budgeting only the stem (the old behavior) yields a >255-byte collision candidate and
  // ENAMETOOLONG; the extension has to shrink too, with the suffix kept intact.
  const fileName = `a.${'x'.repeat(MAX_PORTABLE_FILENAME_BYTES - 7)}`;
  assert.equal(exceedsMaxPortableFilenameBytes(fileName), false);

  const firstPath = await writeFileWithCopySuffix(dir, fileName, Buffer.from('first'));
  const secondPath = await writeFileWithCopySuffix(dir, fileName, Buffer.from('second'));

  assert.equal(firstPath, join(dir, fileName));
  assert.notEqual(secondPath, firstPath);
  assert.equal(exceedsMaxPortableFilenameBytes(basename(secondPath)), false);
  assert.ok(basename(secondPath).includes('_copy_'), 'collision disambiguator must survive the byte budget');
  assert.equal(await readFile(firstPath, 'utf8'), 'first');
  assert.equal(await readFile(secondPath, 'utf8'), 'second');
});
