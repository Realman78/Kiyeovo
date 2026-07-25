import {
  containsUnsupportedFileNameCharacter,
  exceedsMaxPortableFilenameBytes,
  isWindowsReservedBasename,
  windowsBasenameOf,
} from '../core/utils/portable-filename.js';

export type PreparedTextUpload =
  | {
      success: true;
      fileName: string;
      bytes: Buffer;
      error: null;
    }
  | {
      success: false;
      fileName: null;
      bytes: null;
      error: string;
    };

function validateTextFileName(value: unknown): { fileName: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Text upload filename is required' };
  }

  const candidate = value.trim();
  if (
    candidate === '.'
    || candidate === '..'
    || candidate.includes('/')
    || candidate.includes('\\')
  ) {
    return { error: 'Text upload filename must not contain a path' };
  }

  if (containsUnsupportedFileNameCharacter(candidate)) {
    return { error: 'Text upload filename contains unsupported characters' };
  }

  if (!candidate.toLowerCase().endsWith('.txt')) {
    return { error: 'Text upload filename must end in .txt' };
  }

  const stem = candidate.slice(0, -4);
  if (!stem || stem.endsWith('.') || stem.endsWith(' ')) {
    return { error: 'Text upload filename is invalid' };
  }

  if (isWindowsReservedBasename(windowsBasenameOf(stem))) {
    return { error: 'Text upload filename is reserved by the operating system' };
  }

  const normalizedFileName = `${stem}.txt`;
  if (exceedsMaxPortableFilenameBytes(normalizedFileName)) {
    return { error: 'Text upload filename is too long' };
  }

  return { fileName: normalizedFileName };
}

export function prepareTextUpload(
  text: unknown,
  fileName: unknown,
  maxFileSize: number,
): PreparedTextUpload {
  if (typeof text !== 'string') {
    return {
      success: false,
      fileName: null,
      bytes: null,
      error: 'Text content is required',
    };
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return {
      success: false,
      fileName: null,
      bytes: null,
      error: 'Text content is required',
    };
  }

  const validatedFileName = validateTextFileName(fileName);
  if ('error' in validatedFileName) {
    return {
      success: false,
      fileName: null,
      bytes: null,
      error: validatedFileName.error,
    };
  }

  const byteLength = Buffer.byteLength(trimmedText, 'utf8');
  if (byteLength > maxFileSize) {
    return {
      success: false,
      fileName: null,
      bytes: null,
      error: `Text exceeds the configured file-size limit (${maxFileSize} bytes)`,
    };
  }

  return {
    success: true,
    fileName: validatedFileName.fileName,
    bytes: Buffer.from(trimmedText, 'utf8'),
    error: null,
  };
}
