import path from 'path';
import { randomUUID } from 'crypto';
import mime from 'mime-types';

// A media capability token is only ever minted by vetted main-process resolvers — completed
// image messages, selected/pasted images, completed voice-note audio, and the local recorder's
// own upload (see resolveCompletedImageMedia / resolveCompletedVoiceNoteMedia in
// ipc-handler-helpers.ts and the SAVE_VOICE_NOTE_UPLOAD/SHOW_OPEN_DIALOG/SAVE_UPLOAD handlers in
// ipc-handlers.ts). `kind` records *why* the capability was minted so the protocol handler can
// decide what content type to serve without re-deriving it from the filename — see
// resolveServedContentType below for why that distinction matters.
export type MediaCapabilityKind = 'image' | 'voice-note';

interface MediaCapability {
  canonicalPath: string;
  kind: MediaCapabilityKind;
}

const mediaByToken = new Map<string, MediaCapability>();
const tokenByPath = new Map<string, string>();

export function mintMediaToken(canonicalPath: string, kind: MediaCapabilityKind): string {
  if (!path.isAbsolute(canonicalPath)) {
    throw new Error('Media capability path must be absolute');
  }

  const existingToken = tokenByPath.get(canonicalPath);
  if (existingToken) {
    return existingToken;
  }

  const token = randomUUID();
  mediaByToken.set(token, { canonicalPath, kind });
  tokenByPath.set(canonicalPath, token);
  return token;
}

export function resolveMediaCapability(token: string): MediaCapability | undefined {
  return mediaByToken.get(token);
}

export function revokeMediaToken(token: string, canonicalPath: string): void {
  mediaByToken.delete(token);
  if (tokenByPath.get(canonicalPath) === token) {
    tokenByPath.delete(canonicalPath);
  }
}

/**
 * The content type served for a media capability is bound to *why* the token was minted, not
 * inferred from the file's extension at serve time. This matters because the `mime-types`
 * package maps a `.webm` filename to `video/webm` — if the media protocol handler inferred the
 * type from the filename, every voice note (always a `.webm` file) would be served as
 * `video/webm`, fail the image/*-or-audio/* gate, and 415 instead of playing. Voice-note
 * capabilities are only ever minted from resolveCompletedVoiceNoteMedia or the local recorder
 * upload path, both of which only ever point at a recorded audio/webm;codecs=opus file, so
 * hardcoding the served type to `audio/webm` for that kind is safe and matches what was actually
 * recorded — it does not widen what a renderer can reach, since the capability is still gated.
 * Image capabilities keep the filename-derived lookup, narrowed to image/*.
 */
export function resolveServedContentType(kind: MediaCapabilityKind, canonicalPath: string): string | null {
  if (kind === 'voice-note') {
    return 'audio/webm';
  }
  const contentType = mime.lookup(canonicalPath);
  return contentType && contentType.startsWith('image/') ? contentType : null;
}
