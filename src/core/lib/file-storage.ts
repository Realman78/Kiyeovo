import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { formatCopyTimestamp } from '../utils/miscellaneous.js';
import { sanitizePortableFileName } from '../utils/portable-filename.js';

const MAX_FILENAME_ALLOCATION_ATTEMPTS = 1000;

// The default must be an absolute, stable location: a cwd-relative default
// scatters downloads by launch context (a packaged app started from a
// .desktop entry can have cwd '/' or '$HOME'). Derived from homedir() rather
// than Electron's app.getPath so core stays usable outside Electron.
export function getDefaultDownloadsDirectory(): string {
  return join(homedir(), 'Downloads', 'Kiyeovo');
}

export function resolveConfiguredDownloadsDirectory(configuredPath: string | null | undefined): string {
  const value = configuredPath && configuredPath.trim() ? configuredPath : getDefaultDownloadsDirectory();
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

/**
 * Receiver-side entry point for incoming file-transfer offers. A peer's offer already passed
 * validateIncomingFileOffer's hard traversal/separator rejection (src/core/protocol/
 * file-offer-validation.ts) — that check stays strict and is not weakened here. But a
 * Linux/macOS sender can legally offer a name Windows cannot create on disk (a reserved device
 * basename like `CON.txt`, a forbidden character like `:`, a trailing dot/space). Rather than
 * reject the offer or touch the signed wire payload, we sanitize only the name handed to the
 * filesystem write: sanitizePortableFileName deterministically rewrites it into something every
 * supported OS can save. The offer's original filename keeps being used as-is for the DB
 * `file_name` column / chat UI display; only this on-disk name changes.
 */
export async function writeIncomingFileWithCopySuffix(
  directoryPath: string,
  offeredFileName: string,
  bytes: Buffer,
): Promise<string> {
  return writeFileWithCopySuffix(directoryPath, sanitizePortableFileName(offeredFileName), bytes);
}
