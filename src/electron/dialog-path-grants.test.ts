import assert from 'node:assert/strict';
import { resolve as resolvePath } from 'node:path';
import test from 'node:test';
import {
  DIALOG_PATH_NOT_GRANTED_ERROR,
  createDialogPathGrantRegistry,
  resolveDialogGrantedFileMetadata,
  resolveGrantedDialogPath,
} from './dialog-path-grants.js';

function makeStats(input: {
  size?: number;
  isFile?: boolean;
  isSymbolicLink?: boolean;
} = {}) {
  const {
    size = 0,
    isFile = true,
    isSymbolicLink = false,
  } = input;

  return {
    size,
    isFile: () => isFile,
    isSymbolicLink: () => isSymbolicLink,
  };
}

test('dialog path grants allow only main-granted normalized paths', () => {
  const registry = createDialogPathGrantRegistry();
  const grantedPath = '/tmp/kiyeovo-dialog-grants/dir/../file.txt';

  assert.equal(registry.isDialogPathGranted(grantedPath), false);

  registry.grantDialogPath(grantedPath);

  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/file.txt'), true);
  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/dir/../other.txt'), false);
  assert.equal(registry.isDialogPathGranted(''), false);
  assert.equal(registry.isDialogPathGranted(null), false);
});

test('dialog path grant registry evicts the oldest paths beyond its cap', () => {
  const registry = createDialogPathGrantRegistry(2);

  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/a.txt');
  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/b.txt');
  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/c.txt');

  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/a.txt'), false);
  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/b.txt'), true);
  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/c.txt'), true);

  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/b.txt');
  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/d.txt');

  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/c.txt'), false);
  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/b.txt'), true);
  assert.equal(registry.isDialogPathGranted('/tmp/kiyeovo-dialog-grants/d.txt'), true);
});

test('resolveGrantedDialogPath rejects ungranted paths and returns normalized granted paths', () => {
  const registry = createDialogPathGrantRegistry();

  assert.throws(
    () => resolveGrantedDialogPath('/tmp/kiyeovo-dialog-grants/secret.txt', registry.isDialogPathGranted),
    new RegExp(DIALOG_PATH_NOT_GRANTED_ERROR),
  );

  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/dir/../allowed.txt');

  assert.equal(
    resolveGrantedDialogPath('/tmp/kiyeovo-dialog-grants/allowed.txt', registry.isDialogPathGranted),
    resolvePath('/tmp/kiyeovo-dialog-grants/allowed.txt'),
  );
});

test('resolveDialogGrantedFileMetadata checks grant before filesystem access', async () => {
  const registry = createDialogPathGrantRegistry();
  let lstatCalls = 0;

  await assert.rejects(
    resolveDialogGrantedFileMetadata({
      filePath: '/tmp/kiyeovo-dialog-grants/ungranted.txt',
      isDialogPathGranted: registry.isDialogPathGranted,
      fsOps: {
        async lstat() {
          lstatCalls += 1;
          return makeStats();
        },
      },
    }),
    new RegExp(DIALOG_PATH_NOT_GRANTED_ERROR),
  );

  assert.equal(lstatCalls, 0);
});

test('resolveDialogGrantedFileMetadata returns metadata for granted regular files', async () => {
  const registry = createDialogPathGrantRegistry();
  const lstatPaths: string[] = [];

  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/file.txt');

  const metadata = await resolveDialogGrantedFileMetadata({
    filePath: '/tmp/kiyeovo-dialog-grants/dir/../file.txt',
    isDialogPathGranted: registry.isDialogPathGranted,
    fsOps: {
      async lstat(path) {
        lstatPaths.push(path);
        return makeStats({ size: 123 });
      },
    },
  });

  assert.deepEqual(metadata, { name: 'file.txt', size: 123 });
  assert.deepEqual(lstatPaths, [resolvePath('/tmp/kiyeovo-dialog-grants/file.txt')]);
});

test('resolveDialogGrantedFileMetadata rejects granted symlinks and non-regular files', async () => {
  const registry = createDialogPathGrantRegistry();
  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/link.txt');
  registry.grantDialogPath('/tmp/kiyeovo-dialog-grants/folder.txt');

  await assert.rejects(
    resolveDialogGrantedFileMetadata({
      filePath: '/tmp/kiyeovo-dialog-grants/link.txt',
      isDialogPathGranted: registry.isDialogPathGranted,
      fsOps: {
        async lstat() {
          return makeStats({ isSymbolicLink: true });
        },
      },
    }),
    /Symbolic-link files are not allowed/,
  );

  await assert.rejects(
    resolveDialogGrantedFileMetadata({
      filePath: '/tmp/kiyeovo-dialog-grants/folder.txt',
      isDialogPathGranted: registry.isDialogPathGranted,
      fsOps: {
        async lstat() {
          return makeStats({ isFile: false });
        },
      },
    }),
    /Selected path is not a regular file/,
  );
});
