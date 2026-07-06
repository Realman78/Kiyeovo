import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getDefaultDownloadsDirectory, resolveConfiguredDownloadsDirectory } from '../core/lib/file-storage.js';
import type {
  CompletedFileLocationDatabase,
  CompletedFileMediaDatabase,
} from './ipc-handler-helpers.js';
import {
  createDebouncedInvoker,
  resolveCompletedImageMedia,
  resolveOpenFileLocationPath,
  resolveUploadsDirectoryFromSetting,
  validateUploadImageFileName,
} from './ipc-handler-helpers.js';

// Deterministic fake scheduler: records pending timers and fires them on demand,
// so debounce coalescing/reset can be asserted without wall-clock waits.
class FakeScheduler {
  private nextHandle = 1;
  private readonly pending = new Map<number, () => void>();

  readonly timers = {
    set: (handler: () => void): number => {
      const handle = this.nextHandle++;
      this.pending.set(handle, handler);
      return handle;
    },
    clear: (handle: number): void => {
      this.pending.delete(handle);
    },
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  fireAll(): void {
    const handlers = [...this.pending.values()];
    this.pending.clear();
    for (const handler of handlers) {
      handler();
    }
  }
}

class FakeFileDatabase implements CompletedFileMediaDatabase, CompletedFileLocationDatabase {
  readonly mediaByMessageId = new Map<string, { filePath: string; fileName: string }>();
  readonly completedFilePaths = new Set<string>();

  getCompletedFileMediaById(messageId: string): { filePath: string; fileName: string } | null {
    return this.mediaByMessageId.get(messageId) ?? null;
  }

  hasCompletedFilePath(filePath: string): boolean {
    return this.completedFilePaths.has(filePath);
  }
}

test('validateUploadImageFileName accepts image basenames and rejects paths or unsupported names', () => {
  assert.deepEqual(validateUploadImageFileName(' pasted.PNG '), {
    success: true,
    fileName: 'pasted.PNG',
  });

  assert.deepEqual(validateUploadImageFileName('../pasted.png'), {
    success: false,
    error: 'Upload filename must not contain a path',
  });
  assert.deepEqual(validateUploadImageFileName('nested\\pasted.png'), {
    success: false,
    error: 'Upload filename must not contain a path',
  });
  assert.deepEqual(validateUploadImageFileName('bad:name.png'), {
    success: false,
    error: 'Upload filename contains unsupported characters',
  });
  assert.deepEqual(validateUploadImageFileName('.png'), {
    success: false,
    error: 'Upload filename is invalid',
  });
  assert.deepEqual(validateUploadImageFileName('CON.png'), {
    success: false,
    error: 'Upload filename is reserved by the operating system',
  });
  assert.deepEqual(validateUploadImageFileName('pasted.txt'), {
    success: false,
    error: 'Unsupported upload filename',
  });
  assert.deepEqual(validateUploadImageFileName('a'.repeat(252) + '.png'), {
    success: false,
    error: 'Upload filename is too long',
  });
});

test('resolveUploadsDirectoryFromSetting derives the app-owned uploads sibling directory', () => {
  assert.equal(
    resolveUploadsDirectoryFromSetting('/home/user/Downloads', '/repo'),
    '/home/user/kiyeovo-uploads',
  );
  assert.equal(
    resolveUploadsDirectoryFromSetting('downloads', '/repo'),
    '/repo/kiyeovo-uploads',
  );
  // No configured value: sibling of the absolute home-based downloads default,
  // never cwd-relative.
  assert.equal(
    resolveUploadsDirectoryFromSetting(null, '/repo'),
    join(homedir(), 'Downloads', 'kiyeovo-uploads'),
  );
});

test('downloads directory defaults to an absolute home-based path, not cwd', () => {
  assert.equal(getDefaultDownloadsDirectory(), join(homedir(), 'Downloads', 'Kiyeovo'));
  assert.equal(resolveConfiguredDownloadsDirectory(null), join(homedir(), 'Downloads', 'Kiyeovo'));
  assert.equal(resolveConfiguredDownloadsDirectory('  '), join(homedir(), 'Downloads', 'Kiyeovo'));
  // Explicitly configured values keep their existing semantics.
  assert.equal(resolveConfiguredDownloadsDirectory('/data/dl'), '/data/dl');
});

test('resolveCompletedImageMedia canonicalizes completed image paths and rejects invalid media', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-ipc-media-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new FakeFileDatabase();

  const imagePath = join(dir, 'photo.png');
  await writeFile(imagePath, Buffer.from('not decoded here'));
  db.mediaByMessageId.set('image_message', { filePath: imagePath, fileName: 'photo.png' });

  assert.deepEqual(await resolveCompletedImageMedia(db, 'image_message'), {
    canonicalPath: await realpath(imagePath),
    fileName: 'photo.png',
  });

  db.mediaByMessageId.set('non_image', { filePath: imagePath, fileName: 'photo.txt' });
  await assert.rejects(resolveCompletedImageMedia(db, 'non_image'), /Completed image message not found/);

  const linkPath = join(dir, 'link.png');
  await symlink(imagePath, linkPath);
  db.mediaByMessageId.set('symlink_image', { filePath: linkPath, fileName: 'link.png' });
  await assert.rejects(resolveCompletedImageMedia(db, 'symlink_image'), /Symbolic-link media paths/);

  const folderPath = join(dir, 'folder.png');
  await mkdir(folderPath);
  db.mediaByMessageId.set('folder_image', { filePath: folderPath, fileName: 'folder.png' });
  await assert.rejects(resolveCompletedImageMedia(db, 'folder_image'), /Media path is not a file/);
});

test('resolveOpenFileLocationPath allows only completed DB files or app-owned uploads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-ipc-open-location-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new FakeFileDatabase();
  const uploadsDir = join(dir, 'kiyeovo-uploads');
  await mkdir(uploadsDir);

  const completedPath = join(dir, 'completed.pdf');
  await writeFile(completedPath, 'completed');
  const completedCanonicalPath = await realpath(completedPath);
  db.completedFilePaths.add(completedCanonicalPath);

  assert.equal(await resolveOpenFileLocationPath({
    database: db,
    filePath: completedPath,
    uploadsDir,
  }), completedCanonicalPath);

  const uploadPath = join(uploadsDir, 'pasted.png');
  await writeFile(uploadPath, 'upload');
  assert.equal(await resolveOpenFileLocationPath({
    database: db,
    filePath: uploadPath,
    uploadsDir,
  }), await realpath(uploadPath));

  const arbitraryPath = join(dir, 'arbitrary.txt');
  await writeFile(arbitraryPath, 'arbitrary');
  await assert.rejects(resolveOpenFileLocationPath({
    database: db,
    filePath: arbitraryPath,
    uploadsDir,
  }), /File location is not available/);

  const uploadLinkPath = join(uploadsDir, 'link.png');
  await symlink(uploadPath, uploadLinkPath);
  await assert.rejects(resolveOpenFileLocationPath({
    database: db,
    filePath: uploadLinkPath,
    uploadsDir,
  }), /Symbolic-link file locations/);

  const symlinkedUploadsDir = join(dir, 'symlinked-uploads');
  await symlink(uploadsDir, symlinkedUploadsDir);
  await assert.rejects(resolveOpenFileLocationPath({
    database: db,
    filePath: uploadPath,
    uploadsDir: symlinkedUploadsDir,
  }), /File location is not available/);
});

test('createDebouncedInvoker coalesces a burst of schedule() calls into one run', () => {
  const scheduler = new FakeScheduler();
  let runs = 0;
  const invoker = createDebouncedInvoker({
    delayMs: 1000,
    resolveTarget: () => 'target',
    run: () => { runs += 1; },
    timers: scheduler.timers,
  });

  invoker.schedule();
  invoker.schedule();
  invoker.schedule();

  // Only the last timer is live; earlier ones were cleared on each reset.
  assert.equal(scheduler.pendingCount, 1);
  assert.equal(runs, 0);

  scheduler.fireAll();
  assert.equal(runs, 1);
});

test('createDebouncedInvoker resets the timer on each new schedule() call', () => {
  const scheduler = new FakeScheduler();
  const clearedHandles: number[] = [];
  let runs = 0;
  const invoker = createDebouncedInvoker({
    delayMs: 1000,
    resolveTarget: () => 'target',
    run: () => { runs += 1; },
    timers: {
      set: scheduler.timers.set,
      clear: (handle: number) => {
        clearedHandles.push(handle);
        scheduler.timers.clear(handle);
      },
    },
  });

  invoker.schedule();
  invoker.schedule();

  // The first timer handle must have been cleared when the second was scheduled.
  assert.deepEqual(clearedHandles, [1]);
  assert.equal(scheduler.pendingCount, 1);
  scheduler.fireAll();
  assert.equal(runs, 1);
});

test('createDebouncedInvoker resolves the target at fire time, not schedule time', () => {
  const scheduler = new FakeScheduler();
  const observed: string[] = [];
  let current = 'first';
  const invoker = createDebouncedInvoker({
    delayMs: 1000,
    resolveTarget: () => current,
    run: (target: string) => { observed.push(target); },
    timers: scheduler.timers,
  });

  invoker.schedule();
  // Target changes AFTER scheduling but BEFORE firing.
  current = 'second';
  scheduler.fireAll();

  assert.deepEqual(observed, ['second']);
});

test('createDebouncedInvoker skips the run when the target is absent at fire time', () => {
  const scheduler = new FakeScheduler();
  let runs = 0;
  let target: string | null = 'present';
  const invoker = createDebouncedInvoker<string>({
    delayMs: 1000,
    resolveTarget: () => target,
    run: () => { runs += 1; },
    timers: scheduler.timers,
  });

  invoker.schedule();
  target = null; // torn down between schedule and fire
  scheduler.fireAll();

  assert.equal(runs, 0);
});

test('createDebouncedInvoker cancel() prevents a pending run from firing', () => {
  const scheduler = new FakeScheduler();
  let runs = 0;
  const invoker = createDebouncedInvoker({
    delayMs: 1000,
    resolveTarget: () => 'target',
    run: () => { runs += 1; },
    timers: scheduler.timers,
  });

  invoker.schedule();
  invoker.cancel();
  assert.equal(scheduler.pendingCount, 0);
  scheduler.fireAll();
  assert.equal(runs, 0);
});

test('createDebouncedInvoker routes async run rejections to onError', async () => {
  const scheduler = new FakeScheduler();
  const errors: unknown[] = [];
  const invoker = createDebouncedInvoker({
    delayMs: 1000,
    resolveTarget: () => 'target',
    run: () => Promise.reject(new Error('boom')),
    onError: (error) => { errors.push(error); },
    timers: scheduler.timers,
  });

  invoker.schedule();
  scheduler.fireAll();
  // Allow the rejected promise's .catch microtask to run.
  await Promise.resolve();

  assert.equal(errors.length, 1);
  assert.match((errors[0] as Error).message, /boom/);
});
