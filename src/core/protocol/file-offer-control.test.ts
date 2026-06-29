import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import type { FileOfferCancelApplicationPayload, FileOfferNackApplicationPayload } from './message-envelope.js';
import {
  createFileOfferCancelSignaturePayload,
  createFileOfferNackSignaturePayload,
  getFileOfferNackOutcome,
  validateFileOfferCancel,
  validateFileOfferNack,
} from './file-offer-control.js';

const recipientPrivateKey = new Uint8Array(32).fill(7);
const recipientPublicKey = ed25519.getPublicKey(recipientPrivateKey);
const wrongPublicKey = ed25519.getPublicKey(new Uint8Array(32).fill(8));

function createSignedNack(): FileOfferNackApplicationPayload {
  const unsigned = {
    type: 'file_offer_nack' as const,
    offerId: 'offer_1',
    reason: 'declined' as const,
  };
  const encoded = new TextEncoder().encode(
    JSON.stringify(createFileOfferNackSignaturePayload(unsigned)),
  );
  return {
    ...unsigned,
    signature: Buffer.from(ed25519.sign(encoded, recipientPrivateKey)).toString('base64'),
  };
}

function createSignedCancel(): FileOfferCancelApplicationPayload {
  const unsigned = {
    type: 'file_offer_cancel' as const,
    offerId: 'offer_1',
  };
  const encoded = new TextEncoder().encode(
    JSON.stringify(createFileOfferCancelSignaturePayload(unsigned)),
  );
  return {
    ...unsigned,
    signature: Buffer.from(ed25519.sign(encoded, recipientPrivateKey)).toString('base64'),
  };
}

function verifyWith(publicKey: Uint8Array) {
  return (signature: string, payload: object): boolean => ed25519.verify(
    Buffer.from(signature, 'base64'),
    new TextEncoder().encode(JSON.stringify(payload)),
    publicKey,
  );
}

test('validates a domain-separated file-offer cancel signature', () => {
  assert.equal(validateFileOfferCancel({
    cancel: createSignedCancel(),
    verifySignature: verifyWith(recipientPublicKey),
  }), true);
});

test('rejects a cancel signed by a different application identity', () => {
  assert.equal(validateFileOfferCancel({
    cancel: createSignedCancel(),
    verifySignature: verifyWith(wrongPublicKey),
  }), false);
});

test('rejects a cancel whose signed offer id was changed', () => {
  assert.equal(validateFileOfferCancel({
    cancel: { ...createSignedCancel(), offerId: 'offer_2' },
    verifySignature: verifyWith(recipientPublicKey),
  }), false);
});

test('validates a domain-separated file-offer decline signature', () => {
  assert.equal(validateFileOfferNack({
    nack: createSignedNack(),
    verifySignature: verifyWith(recipientPublicKey),
  }), true);
});

test('rejects a decline signed by a different application identity', () => {
  assert.equal(validateFileOfferNack({
    nack: createSignedNack(),
    verifySignature: verifyWith(wrongPublicKey),
  }), false);
});

test('rejects a NACK whose signed reason was changed', () => {
  assert.equal(validateFileOfferNack({
    nack: { ...createSignedNack(), reason: 'inbox_full' },
    verifySignature: verifyWith(recipientPublicKey),
  }), false);
});

test('maps decline and capacity NACKs to their sender terminal states', () => {
  assert.deepEqual(getFileOfferNackOutcome('declined'), {
    status: 'rejected',
    error: 'Recipient declined',
  });
  assert.deepEqual(getFileOfferNackOutcome('inbox_full'), {
    status: 'failed',
    error: 'Recipient file inbox is full',
  });
  assert.deepEqual(getFileOfferNackOutcome('rate_limited'), {
    status: 'failed',
    error: 'Recipient rate-limited file offers',
  });
});
