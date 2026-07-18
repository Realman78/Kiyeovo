import { VOICE_NOTE_MAX_DURATION_MS_WIRE } from '../core/constants.js';

// Mirrors text-upload.ts's precedent for renderer-generated content: the renderer never writes
// to disk directly (sandboxed), so recorded audio bytes cross this vetted IPC boundary and are
// written to the app's managed uploads location before feeding the existing send-file flow.
const INVALID_PORTABLE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PORTABLE_FILENAME_BYTES = 255;

export type PreparedVoiceNoteUpload =
  | {
      success: true;
      fileName: string;
      bytes: Buffer;
      durationMs: number;
      error: null;
    }
  | {
      success: false;
      fileName: null;
      bytes: null;
      durationMs: null;
      error: string;
    };

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

function validateVoiceNoteFileName(value: unknown): { fileName: string } | { error: string } {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Voice note filename is required' };
  }

  const candidate = value.trim();
  if (
    candidate === '.'
    || candidate === '..'
    || candidate.includes('/')
    || candidate.includes('\\')
  ) {
    return { error: 'Voice note filename must not contain a path' };
  }

  if (containsUnsupportedFileNameCharacter(candidate)) {
    return { error: 'Voice note filename contains unsupported characters' };
  }

  if (!candidate.toLowerCase().endsWith('.webm')) {
    return { error: 'Voice note filename must end in .webm' };
  }

  const stem = candidate.slice(0, -5);
  if (!stem || stem.endsWith('.') || stem.endsWith(' ')) {
    return { error: 'Voice note filename is invalid' };
  }

  const firstDotIndex = stem.indexOf('.');
  const windowsBasename = firstDotIndex === -1
    ? stem
    : stem.slice(0, firstDotIndex);
  if (WINDOWS_RESERVED_BASENAME.test(windowsBasename)) {
    return { error: 'Voice note filename is reserved by the operating system' };
  }

  const normalizedFileName = `${stem}.webm`;
  if (Buffer.byteLength(normalizedFileName, 'utf8') > MAX_PORTABLE_FILENAME_BYTES) {
    return { error: 'Voice note filename is too long' };
  }

  return { fileName: normalizedFileName };
}

function failure(error: string): PreparedVoiceNoteUpload {
  return { success: false, fileName: null, bytes: null, durationMs: null, error };
}

/**
 * Validates and prepares a recorded voice note for the atomic-upload write path.
 * `maxFileSize` is the caller-resolved cap (min of the configured file-size limit and the
 * voice-note-specific byte cap) — enforced here, and re-derived independently by FileHandler
 * when the offer is actually sent, so a compromised/buggy renderer can't bypass it.
 * `durationMs` is bounds-checked but never trusted beyond display — the receiver independently
 * re-validates it against the same wire cap before treating an incoming offer as a voice note.
 */
export function prepareVoiceNoteUpload(
  bytes: unknown,
  fileName: unknown,
  durationMs: unknown,
  maxFileSize: number,
): PreparedVoiceNoteUpload {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return failure('Voice note audio is required');
  }

  const validatedFileName = validateVoiceNoteFileName(fileName);
  if ('error' in validatedFileName) {
    return failure(validatedFileName.error);
  }

  if (bytes.byteLength > maxFileSize) {
    return failure(`Voice note exceeds the configured file-size limit (${maxFileSize} bytes)`);
  }

  if (
    typeof durationMs !== 'number'
    || !Number.isFinite(durationMs)
    || !Number.isInteger(durationMs)
    || durationMs <= 0
    || durationMs > VOICE_NOTE_MAX_DURATION_MS_WIRE
  ) {
    return failure('Invalid voice note duration');
  }

  return {
    success: true,
    fileName: validatedFileName.fileName,
    bytes: Buffer.from(bytes),
    durationMs,
    error: null,
  };
}
