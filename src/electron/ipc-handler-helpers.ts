import { lstat, realpath, stat } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'path';
import { DOWNLOADS_DIR, UPLOADS_DIR } from '../core/constants.js';
import { isImageFile } from '../shared/file-types.js';

const INVALID_PORTABLE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PORTABLE_FILENAME_BYTES = 255;

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

function containsUnsupportedFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      INVALID_PORTABLE_FILENAME_CHARACTERS.test(character)
      || codePoint === undefined
      || codePoint <= 0x1F
      || codePoint === 0x7F
    ) {
      return true;
    }
  }
  return false;
}

export function validateUploadImageFileName(value: unknown): { success: true; fileName: string } | { success: false; error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { success: false, error: 'Upload filename is required' };
  }

  const candidate = value.trim();
  if (candidate === '.' || candidate === '..' || candidate.includes('/') || candidate.includes('\\')) {
    return { success: false, error: 'Upload filename must not contain a path' };
  }

  if (containsUnsupportedFileNameCharacter(candidate)) {
    return { success: false, error: 'Upload filename contains unsupported characters' };
  }

  if (Buffer.byteLength(candidate, 'utf8') > MAX_PORTABLE_FILENAME_BYTES) {
    return { success: false, error: 'Upload filename is too long' };
  }

  const extensionSeparatorIndex = candidate.lastIndexOf('.');
  const stem = extensionSeparatorIndex === -1
    ? candidate
    : candidate.slice(0, extensionSeparatorIndex);
  if (!stem || stem.endsWith('.') || stem.endsWith(' ')) {
    return { success: false, error: 'Upload filename is invalid' };
  }

  const firstDotIndex = stem.indexOf('.');
  const windowsBasename = firstDotIndex === -1
    ? stem
    : stem.slice(0, firstDotIndex);
  if (WINDOWS_RESERVED_BASENAME.test(windowsBasename)) {
    return { success: false, error: 'Upload filename is reserved by the operating system' };
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
  const rawDownloadsDir = configuredDownloadsDir || DOWNLOADS_DIR;
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
