import { MAX_MESSAGE_CONTENT_LENGTH } from '../constants.js';

export const MESSAGE_ENVELOPE_VERSION = 1;
export const MAX_CID_LENGTH = 64;

const MAX_FILENAME_LENGTH = 255;
const MAX_MIME_TYPE_LENGTH = 255;
const MAX_CHECKSUM_LENGTH = 128;
const MAX_SIGNATURE_LENGTH = 512;

export type ApplicationMessageKind =
  | 'text'
  | 'file_offer'
  | 'file_offer_cancel'
  | 'file_offer_nack';

export interface TextApplicationPayload {
  text: string;
  reply_to?: string;
}

// The well-formed shape of a file_offer's optional voice-note metadata, as this app's sender
// mints it. Old clients that don't know this field simply never send it, so a plain file offer
// is unaffected.
export interface FileOfferVoiceNoteMetadata {
  durationMs: number;
}

export interface FileOfferApplicationPayload {
  type: 'file_offer';
  offerId: string;
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  checksum: string;
  totalChunks: number;
  replyToCid?: string;
  // Deliberately `unknown`, not FileOfferVoiceNoteMetadata: the envelope layer imposes NO shape
  // on this field. It must survive parsing verbatim regardless of shape — the offer signature is
  // reconstructed over the received value (see createFileOfferSignaturePayload), and a malformed
  // voiceNote degrades the offer to a plain file in FileHandler
  // (resolveIncomingVoiceNoteDurationMs) instead of dropping it here.
  voiceNote?: unknown;
  timestamp: number;
  signature: string;
}

export interface FileOfferCancelApplicationPayload {
  type: 'file_offer_cancel';
  offerId: string;
  signature: string;
}

export type FileOfferNackReason = 'declined' | 'inbox_full' | 'rate_limited';

export interface FileOfferNackApplicationPayload {
  type: 'file_offer_nack';
  offerId: string;
  reason: FileOfferNackReason;
  signature: string;
}

export interface ApplicationPayloadMap {
  text: TextApplicationPayload;
  file_offer: FileOfferApplicationPayload;
  file_offer_cancel: FileOfferCancelApplicationPayload;
  file_offer_nack: FileOfferNackApplicationPayload;
}

export type ApplicationMessage<K extends ApplicationMessageKind = ApplicationMessageKind> = {
  [P in K]: {
    cid: string;
    kind: P;
    payload: ApplicationPayloadMap[P];
  }
}[K];

type VersionedApplicationEnvelope<K extends ApplicationMessageKind = ApplicationMessageKind> = {
  [P in K]: ApplicationMessage<P> & { v: typeof MESSAGE_ENVELOPE_VERSION }
}[K];

export type EnvelopeDecodeRejectReason =
  | 'unsupported_version'
  | 'unknown_kind'
  | 'invalid_envelope';

export type EnvelopeDecodeResult =
  | { ok: true; message: ApplicationMessage }
  | { ok: false; reason: EnvelopeDecodeRejectReason };

export type ApplicationMessageHandlers<TResult> = {
  [K in ApplicationMessageKind]?: (
    message: ApplicationMessage<K>,
  ) => TResult | Promise<TResult>;
};

export type EnvelopeDispatchResult<TResult> =
  | { status: 'handled'; message: ApplicationMessage; value: TResult }
  | { status: 'unhandled'; message: ApplicationMessage }
  | { status: 'rejected'; reason: EnvelopeDecodeRejectReason };

export function isValidCid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function encodeEnvelope(params: {
  cid: string;
  text: string;
  replyToCid?: string | null | undefined;
}): string {
  const payload: TextApplicationPayload = { text: params.text };
  if (isValidCid(params.replyToCid)) {
    payload.reply_to = params.replyToCid;
  }
  return encodeApplicationEnvelope({
    cid: params.cid,
    kind: 'text',
    payload,
  });
}

export function encodeApplicationEnvelope(message: ApplicationMessage): string {
  if (!isValidApplicationMessage(message)) {
    throw new Error('encodeApplicationEnvelope: invalid application message');
  }
  const envelope: VersionedApplicationEnvelope = {
    v: MESSAGE_ENVELOPE_VERSION,
    ...message,
  };
  return JSON.stringify(envelope);
}

export function decodeEnvelope(plaintext: string): EnvelopeDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { ok: false, reason: 'invalid_envelope' };
  }

  if (!isRecord(parsed)) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (parsed.v !== MESSAGE_ENVELOPE_VERSION) {
    return { ok: false, reason: 'unsupported_version' };
  }
  if (!('kind' in parsed)) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  if (!isApplicationMessageKind(parsed.kind)) {
    return { ok: false, reason: 'unknown_kind' };
  }

  const candidate = {
    cid: parsed.cid,
    kind: parsed.kind,
    payload: parsed.payload,
  };
  if (!isValidApplicationMessage(candidate)) {
    return { ok: false, reason: 'invalid_envelope' };
  }
  return { ok: true, message: candidate };
}

export async function dispatchEnvelope<TResult>(
  plaintext: string,
  handlers: ApplicationMessageHandlers<TResult>,
  options?: { expectedCid?: string },
): Promise<EnvelopeDispatchResult<TResult>> {
  const decoded = decodeEnvelope(plaintext);
  if (!decoded.ok) {
    return { status: 'rejected', reason: decoded.reason };
  }
  if (
    options?.expectedCid !== undefined
    && decoded.message.cid !== options.expectedCid
  ) {
    return { status: 'rejected', reason: 'invalid_envelope' };
  }

  const { message } = decoded;
  switch (message.kind) {
    case 'text': {
      const handler = handlers.text;
      return handler
        ? { status: 'handled', message, value: await handler(message) }
        : { status: 'unhandled', message };
    }
    case 'file_offer': {
      const handler = handlers.file_offer;
      return handler
        ? { status: 'handled', message, value: await handler(message) }
        : { status: 'unhandled', message };
    }
    case 'file_offer_cancel': {
      const handler = handlers.file_offer_cancel;
      return handler
        ? { status: 'handled', message, value: await handler(message) }
        : { status: 'unhandled', message };
    }
    case 'file_offer_nack': {
      const handler = handlers.file_offer_nack;
      return handler
        ? { status: 'handled', message, value: await handler(message) }
        : { status: 'unhandled', message };
    }
  }
}

function isValidApplicationMessage(value: unknown): value is ApplicationMessage {
  if (!isRecord(value) || !isValidCid(value.cid) || !isApplicationMessageKind(value.kind)) {
    return false;
  }
  switch (value.kind) {
    case 'text':
      return isTextPayload(value.payload);
    case 'file_offer':
      return isFileOfferPayload(value.payload);
    case 'file_offer_cancel':
      return isFileOfferCancelPayload(value.payload);
    case 'file_offer_nack':
      return isFileOfferNackPayload(value.payload);
  }
}

function isTextPayload(value: unknown): value is TextApplicationPayload {
  return isRecord(value)
    && typeof value.text === 'string'
    && value.text.length <= MAX_MESSAGE_CONTENT_LENGTH
    && (value.reply_to === undefined || isValidCid(value.reply_to));
}

// `voiceNote` is intentionally NOT validated here — not even its shape. A wrong-typed voiceNote
// must degrade to a plain file in FileHandler (never drop the signed offer), and the value has to
// reach signature reconstruction verbatim for verification to succeed. See the field's comment on
// FileOfferApplicationPayload.
function isFileOfferPayload(value: unknown): value is FileOfferApplicationPayload {
  return isRecord(value)
    && value.type === 'file_offer'
    && isValidCid(value.offerId)
    && isValidCid(value.fileId)
    && isBoundedString(value.filename, MAX_FILENAME_LENGTH)
    && isBoundedString(value.mimeType, MAX_MIME_TYPE_LENGTH)
    && isNonNegativeSafeInteger(value.size)
    && isBoundedString(value.checksum, MAX_CHECKSUM_LENGTH)
    && isNonNegativeSafeInteger(value.totalChunks)
    && (value.replyToCid === undefined || isValidCid(value.replyToCid))
    && typeof value.timestamp === 'number'
    && Number.isFinite(value.timestamp)
    && value.timestamp > 0
    && isBoundedString(value.signature, MAX_SIGNATURE_LENGTH);
}

function isFileOfferCancelPayload(value: unknown): value is FileOfferCancelApplicationPayload {
  return isRecord(value)
    && value.type === 'file_offer_cancel'
    && isValidCid(value.offerId)
    && isBoundedString(value.signature, MAX_SIGNATURE_LENGTH);
}

function isFileOfferNackPayload(value: unknown): value is FileOfferNackApplicationPayload {
  return isRecord(value)
    && value.type === 'file_offer_nack'
    && isValidCid(value.offerId)
    && isFileOfferNackReason(value.reason)
    && isBoundedString(value.signature, MAX_SIGNATURE_LENGTH);
}

function isFileOfferNackReason(value: unknown): value is FileOfferNackReason {
  return value === 'declined' || value === 'inbox_full' || value === 'rate_limited';
}

function isApplicationMessageKind(value: unknown): value is ApplicationMessageKind {
  return value === 'text'
    || value === 'file_offer'
    || value === 'file_offer_cancel'
    || value === 'file_offer_nack';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
