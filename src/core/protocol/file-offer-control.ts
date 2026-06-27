import type {
  FileOfferNackApplicationPayload,
  FileOfferNackReason,
} from './message-envelope.js';

export const FILE_OFFER_NACK_SIGNATURE_DOMAIN = 'kiyeovo-file-nack-v2';

export function createFileOfferNackSignaturePayload(input: {
  offerId: string;
  reason: FileOfferNackReason;
}): object {
  return {
    domain: FILE_OFFER_NACK_SIGNATURE_DOMAIN,
    offerId: input.offerId,
    reason: input.reason,
  };
}

export function validateFileOfferNack(input: {
  nack: FileOfferNackApplicationPayload;
  verifySignature: (signature: string, payload: object) => boolean;
}): boolean {
  return input.verifySignature(
    input.nack.signature,
    createFileOfferNackSignaturePayload(input.nack),
  );
}

export function getFileOfferNackOutcome(reason: FileOfferNackReason): {
  status: 'rejected' | 'failed';
  error: string;
} {
  switch (reason) {
    case 'declined':
      return { status: 'rejected', error: 'Recipient declined' };
    case 'inbox_full':
      return { status: 'failed', error: 'Recipient file inbox is full' };
    case 'rate_limited':
      return { status: 'failed', error: 'Recipient rate-limited file offers' };
  }
}
