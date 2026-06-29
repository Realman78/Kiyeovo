import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { DOWNLOADS_DIR } from '../constants.js';
import { formatCopyTimestamp } from '../utils/miscellaneous.js';

const MAX_FILENAME_ALLOCATION_ATTEMPTS = 1000;

export function resolveConfiguredDownloadsDirectory(configuredPath: string | null | undefined): string {
  const value = configuredPath && configuredPath.trim() ? configuredPath : DOWNLOADS_DIR;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function safeDownloadBasename(fileName: string): string {
  const trimmed = fileName.trim();
  const base = basename(trimmed);
  if (!base || base === '.' || base === '..' || base !== trimmed || base.includes('/') || base.includes('\\')) {
    throw new Error('Invalid download filename');
  }
  return base;
}

/**
 * Collision-safe local write: create the destination with O_EXCL (`flag:'wx'`) and add the same
 * `_copy_<timestamp>` suffix the upload path already uses. The DB row is updated only after this
 * resolves, so a failed/crashed write never exposes a partial path through persisted state.
 */
export async function writeFileWithCopySuffix(
  directoryPath: string,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  await mkdir(directoryPath, { recursive: true });

  const safeName = safeDownloadBasename(fileName);
  const extension = extname(safeName);
  const nameWithoutExtension = basename(safeName, extension);

  for (let attempt = 0; attempt < MAX_FILENAME_ALLOCATION_ATTEMPTS; attempt += 1) {
    const candidateName = attempt === 0
      ? safeName
      : `${nameWithoutExtension}_copy_${formatCopyTimestamp(new Date())}${attempt > 1 ? `_${attempt - 1}` : ''}${extension}`;
    const candidatePath = join(directoryPath, candidateName);

    try {
      await writeFile(candidatePath, bytes, { flag: 'wx' });
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      try { await rm(candidatePath, { force: true }); } catch { /* best-effort partial cleanup */ }
      throw error;
    }
  }

  throw new Error('Unable to allocate a unique filename');
}
