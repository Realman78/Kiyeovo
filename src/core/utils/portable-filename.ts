const INVALID_PORTABLE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/;
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i;

export const MAX_PORTABLE_FILENAME_BYTES = 255;

export type PortableFileNameFailure =
  | 'required'
  | 'path'
  | 'unsupported_characters'
  | 'invalid'
  | 'reserved'
  | 'too_long';

export type PortableFileNameValidationResult =
  | { ok: true; fileName: string }
  | { ok: false; reason: PortableFileNameFailure };

function containsUnsupportedCharacter(value: string): boolean {
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

function isWindowsReservedFileName(value: string): boolean {
  const firstDotIndex = value.indexOf('.');
  const firstSegment = firstDotIndex === -1 ? value : value.slice(0, firstDotIndex);
  // Win32 strips trailing spaces/dots while resolving DOS device names, so
  // variants such as "CON .txt" must be rejected as well as "CON.txt".
  return WINDOWS_RESERVED_BASENAME.test(firstSegment.replace(/[ .]+$/u, ''));
}

/**
 * Validate one filename component against the common Windows/macOS/Linux
 * subset used by file offers and app-owned uploads. Protocol/storage callers
 * should keep the strict default. UI text fields may opt into outer-whitespace
 * trimming and use the returned canonical name.
 */
export function validatePortableFileName(
  value: unknown,
  options: { trimOuterWhitespace?: boolean } = {},
): PortableFileNameValidationResult {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'required' };
  }

  const trimmed = value.trim();
  if (!options.trimOuterWhitespace && trimmed !== value) {
    return { ok: false, reason: 'invalid' };
  }
  const candidate = options.trimOuterWhitespace ? trimmed : value;

  if (
    candidate === '.'
    || candidate === '..'
    || candidate.includes('/')
    || candidate.includes('\\')
  ) {
    return { ok: false, reason: 'path' };
  }
  if (containsUnsupportedCharacter(candidate)) {
    return { ok: false, reason: 'unsupported_characters' };
  }
  if (candidate.endsWith('.') || candidate.endsWith(' ')) {
    return { ok: false, reason: 'invalid' };
  }
  if (isWindowsReservedFileName(candidate)) {
    return { ok: false, reason: 'reserved' };
  }
  if (Buffer.byteLength(candidate, 'utf8') > MAX_PORTABLE_FILENAME_BYTES) {
    return { ok: false, reason: 'too_long' };
  }

  return { ok: true, fileName: candidate };
}
