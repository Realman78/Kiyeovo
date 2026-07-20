import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileWithCopySuffix, writeIncomingFileWithCopySuffix, safeDownloadBasename } from './file-storage.js';

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
