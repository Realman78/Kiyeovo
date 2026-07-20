import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileWithCopySuffix, safeDownloadBasename } from './file-storage.js';

test('safeDownloadBasename rejects non-portable names', () => {
  assert.equal(safeDownloadBasename('report.pdf'), 'report.pdf');
  for (const name of [
    '../report.pdf',
    'nested/report.pdf',
    'nested\\report.pdf',
    '.',
    '..',
    '',
    'CON.txt',
    'bad:name.txt',
    'report.',
    ' report.pdf',
    'a'.repeat(256),
  ]) {
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
