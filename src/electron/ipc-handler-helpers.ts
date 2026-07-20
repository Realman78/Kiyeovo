import { lstat, realpath, stat } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path';
import { UPLOADS_DIR } from '../core/constants.js';
import { getDefaultDownloadsDirectory } from '../core/lib/file-storage.js';
import { validatePortableFileName, type PortableFileNameFailure } from '../core/utils/portable-filename.js';
import { isImageFile } from '../shared/file-types.js';
// Re-exported from src/core so callers in both layers share one implementation
// (src/core must not import from src/electron). The unit tests and existing IPC
// call sites keep importing it from here unchanged.
export { createDebouncedInvoker, type DebouncedInvoker } from '../core/utils/debounced-invoker.js';

type FileStats = {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type FileSystemOps = {
  lstat(path: string): Promise<FileStats>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Pick<FileStats, 'isDirectory' | 'isFile'>>;
};

export type CompletedFileMediaDatabase = {
  getCompletedFileMediaById(messageId: string): { filePath: string; fileName: string } | null;
};

export type CompletedFileLocationDatabase = {
  hasCompletedFilePath(filePath: string): boolean;
};

export type SettingsDatabase = {
  getSetting(key: string): string | null;
};

const defaultFileSystemOps: FileSystemOps = { lstat, realpath, stat };

function uploadFileNameError(reason: PortableFileNameFailure): string {
  switch (reason) {
    case 'required': return 'Upload filename is required';
    case 'path': return 'Upload filename must not contain a path';
    case 'unsupported_characters': return 'Upload filename contains unsupported characters';
    case 'reserved': return 'Upload filename is reserved by the operating system';
    case 'too_long': return 'Upload filename is too long';
    case 'invalid': return 'Upload filename is invalid';
  }
}

export function validateUploadImageFileName(value: unknown): { success: true; fileName: string } | { success: false; error: string } {
  const validation = validatePortableFileName(value, { trimOuterWhitespace: true });
  if (!validation.ok) return { success: false, error: uploadFileNameError(validation.reason) };
  const candidate = validation.fileName;

  const extensionSeparatorIndex = candidate.lastIndexOf('.');
  const stem = extensionSeparatorIndex === -1
    ? candidate
    : candidate.slice(0, extensionSeparatorIndex);
  if (!stem || stem.endsWith('.') || stem.endsWith(' ')) {
    return { success: false, error: 'Upload filename is invalid' };
  }

  if (!isImageFile(candidate)) {
    return { success: false, error: 'Unsupported upload filename' };
  }

  return { success: true, fileName: candidate };
}

export function resolveUploadsDirectoryFromSetting(
  configuredDownloadsDir: string | null | undefined,
  cwd = process.cwd(),
): string {
  const rawDownloadsDir = configuredDownloadsDir || getDefaultDownloadsDirectory();
  const downloadsDir = isAbsolute(rawDownloadsDir)
    ? rawDownloadsDir
    : resolvePath(cwd, rawDownloadsDir);
  return join(dirname(downloadsDir), UPLOADS_DIR);
}

export function resolveUploadsDirectory(db: SettingsDatabase): string {
  return resolveUploadsDirectoryFromSetting(db.getSetting('downloads_directory'));
}

export async function resolveCompletedImageMedia(
  database: CompletedFileMediaDatabase,
  messageId: string,
  fsOps: FileSystemOps = defaultFileSystemOps,
): Promise<{ canonicalPath: string; fileName: string }> {
  if (typeof messageId !== 'string' || !messageId.trim()) {
    throw new Error('Invalid message ID');
  }

  const media = database.getCompletedFileMediaById(messageId);
  if (!media || !isImageFile(media.fileName)) {
    throw new Error('Completed image message not found');
  }

  const storedPathStats = await fsOps.lstat(media.filePath);
  if (storedPathStats.isSymbolicLink()) {
    throw new Error('Symbolic-link media paths are not allowed');
  }

  const canonicalPath = await fsOps.realpath(media.filePath);
  const fileStats = await fsOps.stat(canonicalPath);
  if (!fileStats.isFile()) {
    throw new Error('Media path is not a file');
  }

  return {
    canonicalPath,
    fileName: media.fileName,
  };
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const relativePath = relative(directoryPath, candidatePath);
  return !!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

export async function resolveOpenFileLocationPath(input: {
  database: CompletedFileLocationDatabase;
  filePath: unknown;
  uploadsDir: string;
  cwd?: string;
  fsOps?: FileSystemOps;
}): Promise<string> {
  const { database, uploadsDir, cwd = process.cwd(), fsOps = defaultFileSystemOps } = input;
  if (typeof input.filePath !== 'string' || !input.filePath.trim()) {
    throw new Error('Invalid file path');
  }

  const requestedPath = input.filePath.trim();
  const normalizedPath = isAbsolute(requestedPath) ? requestedPath : resolvePath(cwd, requestedPath);
  const pathStats = await fsOps.lstat(normalizedPath);
  if (pathStats.isSymbolicLink()) {
    throw new Error('Symbolic-link file locations are not allowed');
  }

  const canonicalPath = await fsOps.realpath(normalizedPath);
  const fileStats = await fsOps.stat(canonicalPath);
  if (!fileStats.isFile()) {
    throw new Error('File location is not a regular file');
  }

  if (database.hasCompletedFilePath(normalizedPath) || database.hasCompletedFilePath(canonicalPath)) {
    return canonicalPath;
  }

  let canonicalUploadsDir: string;
  try {
    const uploadsPathStats = await fsOps.lstat(uploadsDir);
    if (uploadsPathStats.isSymbolicLink()) {
      canonicalUploadsDir = '';
    } else {
      canonicalUploadsDir = await fsOps.realpath(uploadsDir);
      const uploadsDirStats = await fsOps.stat(canonicalUploadsDir);
      if (!uploadsDirStats.isDirectory()) {
        canonicalUploadsDir = '';
      }
    }
  } catch {
    canonicalUploadsDir = '';
  }

  if (canonicalUploadsDir && isPathInsideDirectory(canonicalPath, canonicalUploadsDir)) {
    return canonicalPath;
  }

  throw new Error('File location is not available');
}
