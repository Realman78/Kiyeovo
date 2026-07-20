import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import { CHUNK_SIZE, MAX_FILE_SIZE } from '../constants.js';
import type { FileOfferApplicationPayload } from './message-envelope.js';
import {
  createFileOfferSignaturePayload,
  validateIncomingFileOffer,
} from './file-offer-validation.js';

const privateKey = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(privateKey);
const now = 1_750_000_000_000;

function signPayload(payload: object): string {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return Buffer.from(ed25519.sign(encoded, privateKey)).toString('base64');
}

function verifySignature(signature: string, payload: object): boolean {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return ed25519.verify(Buffer.from(signature, 'base64'), encoded, publicKey);
}

function createOffer(
  overrides: Partial<FileOfferApplicationPayload> = {},
): FileOfferApplicationPayload {
  const unsigned: Omit<FileOfferApplicationPayload, 'signature'> = {
    type: 'file_offer',
    offerId: 'offer_1',
    fileId: 'file_1',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: CHUNK_SIZE + 1,
    checksum: 'a'.repeat(64),
    totalChunks: 2,
    timestamp: now,
    ...overrides,
  };
  return {
    ...unsigned,
    signature: overrides.signature ?? signPayload(createFileOfferSignaturePayload(unsigned)),
  };
}

function validate(offer: FileOfferApplicationPayload, envelopeCid = offer.fileId) {
  return validateIncomingFileOffer({
    envelopeCid,
    offer,
    maxFileSize: MAX_FILE_SIZE,
    now,
    verifySignature,
  });
}

test('accepts a valid signed file offer', () => {
  assert.deepEqual(validate(createOffer()), { ok: true });
});

test('rejects a file offer with an invalid chunk count', () => {
  assert.deepEqual(validate(createOffer({ totalChunks: 1 })), {
    ok: false,
    reason: 'invalid_chunk_count',
  });
});

test('rejects a file offer with a malformed checksum', () => {
  assert.deepEqual(validate(createOffer({ checksum: 'not-a-blake3-checksum' })), {
    ok: false,
    reason: 'invalid_checksum',
  });
});

test('rejects path traversal and cross-platform path separators', () => {
  assert.deepEqual(validate(createOffer({ filename: '../report.pdf' })), {
    ok: false,
    reason: 'invalid_filename',
  });
  assert.deepEqual(validate(createOffer({ filename: '..\\report.pdf' })), {
    ok: false,
    reason: 'invalid_filename',
  });
});

test('rejects a file offer with an invalid signature', () => {
  assert.deepEqual(validate(createOffer({ signature: Buffer.alloc(64).toString('base64') })), {
    ok: false,
    reason: 'invalid_signature',
  });
});

test('rejects a file offer whose file id differs from the envelope cid', () => {
  assert.deepEqual(validate(createOffer(), 'different_file'), {
    ok: false,
    reason: 'cid_mismatch',
  });
});
