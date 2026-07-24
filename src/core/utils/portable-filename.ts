// Shared portable-filename primitives.
//
// Two consumers rely on these rules:
//  - src/electron/voice-note-upload.ts (and other renderer-generated-content
//    uploaders) validate a *locally generated* filename and reject outright
//    on any violation — the app controls that name, so there is no reason to
//    ever produce or accept a non-portable one.
//  - src/core/lib/file-storage.ts sanitizes a *peer-offered* filename at the
//    receiver's disk-write boundary. A remote peer on Linux/macOS can offer a
//    filename that its own OS accepts but Windows cannot create (a reserved
//    device basename, a forbidden character, a trailing dot/space). The
//    offer itself, the signed wire payload, and the DB display name must
//    stay untouched — only the on-disk name is rewritten, deterministically,
//    so the write never fails.
//
// Windows is the strictest of the supported targets, so validating against
// its rules keeps a saved file portable everywhere: it forbids the
// characters `<>:"/\|?*`, ASCII control characters (and DEL), the DOS
// device basenames CON/PRN/AUX/NUL/COM1-9/LPT1-9 (case-insensitively, with
// any extension), and a trailing dot or space on a path component.
//
// Windows also treats COM/LPT followed by a superscript 1/2/3 (U+00B9, U+00B2,
// U+00B3 — the only digits with a legacy superscript codepoint) as reserved,
// the same as the plain-ASCII COM1-3/LPT1-3: see Microsoft's file-naming
// documentation ("Naming Files, Paths, and Namespaces").

export const INVALID_PORTABLE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/;
export const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
export const MAX_PORTABLE_FILENAME_BYTES = 255;

const FALLBACK_FILE_NAME = '_file';

/** True for `.`, `..`, or any name containing a path separator. */
export function isPathTraversalSegment(value: string): boolean {
  return value === '.' || value === '..' || value.includes('/') || value.includes('\\');
}

/** True if `value` contains a Windows-forbidden character or an ASCII control/DEL code point. */
export function containsUnsupportedFileNameCharacter(value: string): boolean {
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

/** Windows cannot persist a path component ending in a dot or a space. */
export function hasTrailingDotOrSpace(value: string): boolean {
  return value.endsWith('.') || value.endsWith(' ');
}

/** The portion of `stem` Windows checks against its reserved device names: up to the first dot. */
export function windowsBasenameOf(stem: string): string {
  const firstDotIndex = stem.indexOf('.');
  return firstDotIndex === -1 ? stem : stem.slice(0, firstDotIndex);
}

export function isWindowsReservedBasename(basename: string): boolean {
  return WINDOWS_RESERVED_BASENAME.test(basename);
}

export function exceedsMaxPortableFilenameBytes(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') > MAX_PORTABLE_FILENAME_BYTES;
}

export type PortableFileNameIssue =
  | 'empty'
  | 'path'
  | 'unsupported_character'
  | 'trailing_dot_or_space'
  | 'reserved'
  | 'too_long';

export type PortableFileNameCheckResult =
  | { ok: true }
  | { ok: false; reason: PortableFileNameIssue };

/**
 * Strict validator: every one of the portability rules above, applied to the
 * whole (untrimmed-extension) filename. Callers that own the name they are
 * validating (e.g. voice-note-upload.ts, which additionally enforces its own
 * `.webm`-suffix convention) should reject on any failure here rather than
 * sanitize — there is no reason for the app to ever produce a non-portable
 * name itself.
 */
export function checkPortableFileName(value: string): PortableFileNameCheckResult {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, reason: 'empty' };
  }

  const candidate = value.trim();
  if (isPathTraversalSegment(candidate)) {
    return { ok: false, reason: 'path' };
  }
  if (containsUnsupportedFileNameCharacter(candidate)) {
    return { ok: false, reason: 'unsupported_character' };
  }
  if (hasTrailingDotOrSpace(candidate)) {
    return { ok: false, reason: 'trailing_dot_or_space' };
  }
  if (isWindowsReservedBasename(windowsBasenameOf(candidate))) {
    return { ok: false, reason: 'reserved' };
  }
  if (exceedsMaxPortableFilenameBytes(candidate)) {
    return { ok: false, reason: 'too_long' };
  }

  return { ok: true };
}

/**
 * Truncates `value` to at most `maxBytes` UTF-8 bytes, cutting only on whole
 * code points (never splitting a multibyte character). Exported so callers
 * that build their own byte-budgeted names on top of an already-sanitized
 * stem (e.g. file-storage.ts's collision-suffix generation) can reuse the
 * exact same truncation rule instead of duplicating it.
 */
export function truncateStringToByteBudget(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }

  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function truncateToByteLimit(value: string, maxBytes: number): string {
  if (!exceedsMaxPortableFilenameBytes(value)) {
    return value;
  }

  const extensionIndex = value.lastIndexOf('.');
  const extension = extensionIndex > 0 ? value.slice(extensionIndex) : '';
  const stem = extensionIndex > 0 ? value.slice(0, extensionIndex) : value;
  const extensionBytes = Buffer.byteLength(extension, 'utf8');

  const stemBudget = Math.max(0, maxBytes - extensionBytes);
  const truncatedStem = truncateStringToByteBudget(stem, stemBudget);
  const candidate = `${truncatedStem}${extension}`;
  if (!exceedsMaxPortableFilenameBytes(candidate) && truncatedStem) {
    return candidate;
  }

  // The extension alone doesn't leave room for any stem; fall back to a
  // flat byte-budget cut of the whole name (drops the extension).
  return truncateStringToByteBudget(value, maxBytes);
}

/**
 * Deterministically rewrites `name` into a filename that is safe to create
 * on every supported OS. Used at the incoming-file-transfer disk-write
 * boundary: the signed offer payload, wire filename, and DB display name are
 * never touched — only the name handed to the filesystem write call.
 *
 * - Invalid/control characters are replaced with `_`.
 * - A trailing run of dots/spaces is dropped.
 * - A reserved DOS device basename (CON, NUL, COM1, ...) is prefixed with `_`.
 * - The extension is preserved where possible, including when truncating an
 *   over-long name to fit the byte budget.
 * - Never returns an empty string — falls back to a generic name.
 * - Idempotent: sanitizePortableFileName(sanitizePortableFileName(x)) === sanitizePortableFileName(x).
 */
export function sanitizePortableFileName(name: string): string {
  let candidate = typeof name === 'string' ? name.trim() : '';

  candidate = Array.from(candidate)
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (
        INVALID_PORTABLE_FILENAME_CHARACTERS.test(character)
        || codePoint === undefined
        || codePoint <= 0x1F
        || codePoint === 0x7F
      ) {
        return '_';
      }
      return character;
    })
    .join('');

  candidate = candidate.replace(/[. ]+$/, '');

  if (!candidate) {
    return FALLBACK_FILE_NAME;
  }

  // Re-run the reserved-basename / byte-budget / trailing-dot passes until
  // the result stabilizes. A single pass is not enough: byte-budget
  // truncation of a long-enough stem can *create* a new reserved basename
  // that was never checked (e.g. "CONX." + a long multibyte tail truncates
  // down to a "CON" stem), and prefixing a reserved basename with `_` can in
  // turn push the name back over the byte budget. Each pass either adds the
  // fixed one-byte `_` prefix — which truncation can never strip, since it
  // always keeps the leftmost bytes — or strictly shortens the name, so this
  // converges in only a couple of passes for any real input; the iteration
  // cap is defense-in-depth against a pathological case oscillating forever.
  for (let pass = 0; pass < MAX_SANITIZE_PORTABILITY_PASSES; pass += 1) {
    const next = applyPortabilityPass(candidate);
    if (next === candidate) {
      break;
    }
    candidate = next;
  }

  return candidate || FALLBACK_FILE_NAME;
}

const MAX_SANITIZE_PORTABILITY_PASSES = 8;

function applyPortabilityPass(candidate: string): string {
  const extensionIndex = candidate.lastIndexOf('.');
  const stem = extensionIndex > 0 ? candidate.slice(0, extensionIndex) : candidate;
  const extension = extensionIndex > 0 ? candidate.slice(extensionIndex) : '';

  let next = candidate;
  if (isWindowsReservedBasename(windowsBasenameOf(stem))) {
    next = `_${stem}${extension}`;
  }

  if (exceedsMaxPortableFilenameBytes(next)) {
    next = truncateToByteLimit(next, MAX_PORTABLE_FILENAME_BYTES);
  }

  // Truncation (or, in principle, the reserved-name prefix) could have
  // reintroduced a trailing dot/space, or emptied the name.
  next = next.replace(/[. ]+$/, '');

  return next || FALLBACK_FILE_NAME;
}
