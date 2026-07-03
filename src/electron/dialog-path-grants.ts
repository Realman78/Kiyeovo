import { lstat } from 'fs/promises';
import { basename, resolve as resolvePath } from 'path';

export const DEFAULT_DIALOG_PATH_GRANT_LIMIT = 32;
export const DIALOG_PATH_NOT_GRANTED_ERROR = 'File path was not selected through a native dialog';

type DialogPathGrantChecker = (rawPath: unknown) => boolean;

type MetadataStats = {
  size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

type MetadataFileSystemOps = {
  lstat(path: string): Promise<MetadataStats>;
};

export type DialogPathGrantRegistry = {
  grantDialogPath(rawPath: string): string;
  isDialogPathGranted(rawPath: unknown): boolean;
  resetDialogPathGrants(): void;
};

const defaultMetadataFileSystemOps: MetadataFileSystemOps = { lstat };

export function normalizeDialogPathGrant(rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('Invalid file path');
  }

  return resolvePath(rawPath);
}

export function createDialogPathGrantRegistry(
  maxGrants = DEFAULT_DIALOG_PATH_GRANT_LIMIT,
): DialogPathGrantRegistry {
  if (!Number.isInteger(maxGrants) || maxGrants <= 0) {
    throw new Error('Dialog path grant limit must be a positive integer');
  }

  const grantedPaths = new Set<string>();

  return {
    grantDialogPath(rawPath: string): string {
      const normalizedPath = normalizeDialogPathGrant(rawPath);
      grantedPaths.delete(normalizedPath);
      grantedPaths.add(normalizedPath);

      while (grantedPaths.size > maxGrants) {
        const oldestPath = grantedPaths.values().next().value;
        if (typeof oldestPath !== 'string') {
          break;
        }
        grantedPaths.delete(oldestPath);
      }

      return normalizedPath;
    },

    isDialogPathGranted(rawPath: unknown): boolean {
      try {
        return grantedPaths.has(normalizeDialogPathGrant(rawPath));
      } catch {
        return false;
      }
    },

    resetDialogPathGrants(): void {
      grantedPaths.clear();
    },
  };
}

const defaultDialogPathGrantRegistry = createDialogPathGrantRegistry();

export function grantDialogPath(rawPath: string): string {
  return defaultDialogPathGrantRegistry.grantDialogPath(rawPath);
}

export function isDialogPathGranted(rawPath: unknown): boolean {
  return defaultDialogPathGrantRegistry.isDialogPathGranted(rawPath);
}

export function resetDialogPathGrantsForTests(): void {
  defaultDialogPathGrantRegistry.resetDialogPathGrants();
}

export function resolveGrantedDialogPath(
  rawPath: unknown,
  grantChecker: DialogPathGrantChecker = isDialogPathGranted,
): string {
  const normalizedPath = normalizeDialogPathGrant(rawPath);
  if (!grantChecker(normalizedPath)) {
    throw new Error(DIALOG_PATH_NOT_GRANTED_ERROR);
  }

  return normalizedPath;
}

export async function resolveDialogGrantedFileMetadata(input: {
  filePath: unknown;
  isDialogPathGranted?: DialogPathGrantChecker;
  fsOps?: MetadataFileSystemOps;
}): Promise<{ name: string; size: number }> {
  const {
    fsOps = defaultMetadataFileSystemOps,
    isDialogPathGranted: grantChecker = isDialogPathGranted,
  } = input;

  const normalizedPath = resolveGrantedDialogPath(input.filePath, grantChecker);
  const pathStats = await fsOps.lstat(normalizedPath);
  if (pathStats.isSymbolicLink()) {
    throw new Error('Symbolic-link files are not allowed');
  }
  if (!pathStats.isFile()) {
    throw new Error('Selected path is not a regular file');
  }

  return {
    name: basename(normalizedPath),
    size: pathStats.size,
  };
}
