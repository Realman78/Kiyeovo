import { basename } from 'path';
import { CHUNK_SIZE } from '../constants.js';
import type { FileOfferApplicationPayload } from './message-envelope.js';

export const FILE_OFFER_MAX_FUTURE_SKEW_MS = 60_000;

export type FileOfferValidationFailure =
  | 'cid_mismatch'
  | 'invalid_filename'
  | 'invalid_size'
  | 'invalid_chunk_count'
  | 'invalid_checksum'
  | 'future_timestamp'
  | 'invalid_signature';

export type FileOfferValidationResult =
  | { ok: true }
  | { ok: false; reason: FileOfferValidationFailure };

export function createFileOfferSignaturePayload(
  offer: Omit<FileOfferApplicationPayload, 'signature'> | FileOfferApplicationPayload,
): object {
  return {
    type: offer.type,
    offerId: offer.offerId,
    fileId: offer.fileId,
    filename: offer.filename,
    mimeType: offer.mimeType,
    size: offer.size,
    checksum: offer.checksum,
    totalChunks: offer.totalChunks,
    ...(offer.replyToCid ? { replyToCid: offer.replyToCid } : {}),
    ...(offer.voiceNote ? { voiceNote: offer.voiceNote } : {}),
    timestamp: offer.timestamp,
  };
}

export function validateIncomingFileOffer(input: {
  envelopeCid: string;
  offer: FileOfferApplicationPayload;
  maxFileSize: number;
  now: number;
  verifySignature: (signature: string, payload: object) => boolean;
}): FileOfferValidationResult {
  const { envelopeCid, offer, maxFileSize, now, verifySignature } = input;

  if (offer.fileId !== envelopeCid) {
    return { ok: false, reason: 'cid_mismatch' };
  }
  if (
    basename(offer.filename) !== offer.filename
    || offer.filename.includes('\\')
    || offer.filename === '.'
    || offer.filename === '..'
  ) {
    return { ok: false, reason: 'invalid_filename' };
  }
  if (offer.size <= 0 || offer.size > maxFileSize) {
    return { ok: false, reason: 'invalid_size' };
  }
  if (offer.totalChunks !== Math.ceil(offer.size / CHUNK_SIZE)) {
    return { ok: false, reason: 'invalid_chunk_count' };
  }
  if (!/^[a-f0-9]{64}$/i.test(offer.checksum)) {
    return { ok: false, reason: 'invalid_checksum' };
  }
  if (offer.timestamp > now + FILE_OFFER_MAX_FUTURE_SKEW_MS) {
    return { ok: false, reason: 'future_timestamp' };
  }
  if (!verifySignature(offer.signature, createFileOfferSignaturePayload(offer))) {
    return { ok: false, reason: 'invalid_signature' };
  }

  return { ok: true };
}
