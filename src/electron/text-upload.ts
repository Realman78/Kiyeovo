import { validatePortableFileName, type PortableFileNameFailure } from '../core/utils/portable-filename.js';

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

function portableFileNameError(reason: PortableFileNameFailure): string {
  switch (reason) {
    case 'required': return 'Text upload filename is required';
    case 'path': return 'Text upload filename must not contain a path';
    case 'unsupported_characters': return 'Text upload filename contains unsupported characters';
    case 'reserved': return 'Text upload filename is reserved by the operating system';
    case 'too_long': return 'Text upload filename is too long';
    case 'invalid': return 'Text upload filename is invalid';
  }
}

function validateTextFileName(value: unknown): { fileName: string } | { error: string } {
  const validation = validatePortableFileName(value, { trimOuterWhitespace: true });
  if (!validation.ok) return { error: portableFileNameError(validation.reason) };
  const candidate = validation.fileName;

  if (!candidate.toLowerCase().endsWith('.txt')) {
    return { error: 'Text upload filename must end in .txt' };
  }

  const stem = candidate.slice(0, -4);
  if (!stem || stem.endsWith('.') || stem.endsWith(' ')) {
    return { error: 'Text upload filename is invalid' };
  }

  const normalizedFileName = `${stem}.txt`;
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
