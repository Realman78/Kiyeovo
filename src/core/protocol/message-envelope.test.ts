import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MESSAGE_ENVELOPE_VERSION,
  decodeEnvelope,
  dispatchEnvelope,
  encodeApplicationEnvelope,
  encodeEnvelope,
} from './message-envelope.js';

test('round-trips a typed text envelope', () => {
  const encoded = encodeEnvelope({
    cid: 'message_1',
    text: 'hello',
    replyToCid: 'message_0',
  });
  assert.equal((JSON.parse(encoded) as { v?: unknown }).v, 1);
  assert.deepEqual(decodeEnvelope(encoded), {
    ok: true,
    message: {
      cid: 'message_1',
      kind: 'text',
      payload: { text: 'hello', reply_to: 'message_0' },
    },
  });
});

test('rejects bare text and envelopes without a kind', () => {
  assert.deepEqual(
    decodeEnvelope('plain text'),
    { ok: false, reason: 'invalid_envelope' },
  );
  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'message_1',
    text: 'untyped envelope',
  })), { ok: false, reason: 'invalid_envelope' });
});

test('rejects unknown kinds and unsupported versions instead of rendering them', () => {
  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'message_1',
    kind: 'future_kind',
    payload: { text: 'must stay hidden' },
  })), { ok: false, reason: 'unknown_kind' });

  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION + 1,
    cid: 'message_1',
    kind: 'text',
    payload: { text: 'must stay hidden' },
  })), { ok: false, reason: 'unsupported_version' });
});

test('validates typed envelope identifiers and payload bounds', () => {
  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: '../invalid',
    kind: 'text',
    payload: { text: 'hello' },
  })), { ok: false, reason: 'invalid_envelope' });

  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'message_1',
    kind: 'file_offer_cancel',
    payload: { type: 'file_offer_cancel', offerId: 'offer_1', signature: '' },
  })), { ok: false, reason: 'invalid_envelope' });

  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'message_1',
    kind: 'file_offer_nack',
    payload: {
      type: 'file_offer_nack',
      offerId: 'offer_1',
      reason: 'unknown_reason',
      signature: 'signature',
    },
  })), { ok: false, reason: 'invalid_envelope' });
});

function baseFileOfferPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'file_offer',
    offerId: 'offer_1',
    fileId: 'file_1',
    filename: 'clip.webm',
    mimeType: 'audio/webm',
    size: 1024,
    checksum: 'a'.repeat(64),
    totalChunks: 1,
    timestamp: 1_750_000_000_000,
    signature: 'sig',
    ...overrides,
  };
}

test('accepts a file_offer whose optional voiceNote metadata is well-formed', () => {
  const result = decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'file_1',
    kind: 'file_offer',
    payload: baseFileOfferPayload({ voiceNote: { durationMs: 12_000 } }),
  }));
  assert.equal(result.ok, true);
  if (result.ok && result.message.kind === 'file_offer') {
    assert.deepEqual(result.message.payload.voiceNote, { durationMs: 12_000 });
  }
});

// The wire-shape check is deliberately loose: an out-of-range (or absurd) durationMs must NOT
// invalidate the whole offer here — FileHandler re-validates the value and decides separately
// whether to honor it as a voice note or silently fall back to a plain file. Only the *shape*
// (an object with a finite, non-negative number) is enforced at this layer.
test('tolerates an out-of-range voiceNote duration at the envelope layer (business cap is enforced elsewhere)', () => {
  const result = decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'file_1',
    kind: 'file_offer',
    payload: baseFileOfferPayload({ voiceNote: { durationMs: 999_999_999 } }),
  }));
  assert.equal(result.ok, true);
});

test('rejects a file_offer whose voiceNote metadata has the wrong shape', () => {
  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'file_1',
    kind: 'file_offer',
    payload: baseFileOfferPayload({ voiceNote: { durationMs: 'twelve seconds' } }),
  })), { ok: false, reason: 'invalid_envelope' });

  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'file_1',
    kind: 'file_offer',
    payload: baseFileOfferPayload({ voiceNote: 'not-an-object' }),
  })), { ok: false, reason: 'invalid_envelope' });

  assert.deepEqual(decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'file_1',
    kind: 'file_offer',
    payload: baseFileOfferPayload({ voiceNote: { durationMs: -1 } }),
  })), { ok: false, reason: 'invalid_envelope' });
});

test('a plain file_offer with no voiceNote field still validates (old-client compatibility)', () => {
  const result = decodeEnvelope(JSON.stringify({
    v: MESSAGE_ENVELOPE_VERSION,
    cid: 'file_1',
    kind: 'file_offer',
    payload: baseFileOfferPayload(),
  }));
  assert.equal(result.ok, true);
  if (result.ok && result.message.kind === 'file_offer') {
    assert.equal(result.message.payload.voiceNote, undefined);
  }
});

test('dispatches by kind and leaves recognized-but-unregistered kinds unhandled', async () => {
  const encoded = encodeApplicationEnvelope({
    cid: 'control_1',
    kind: 'file_offer_cancel',
    payload: {
      type: 'file_offer_cancel',
      offerId: 'offer_1',
      signature: 'signature',
    },
  });

  const handled = await dispatchEnvelope(encoded, {
    file_offer_cancel: ({ payload }) => payload.offerId,
  });
  assert.equal(handled.status, 'handled');
  if (handled.status === 'handled') {
    assert.equal(handled.value, 'offer_1');
  }

  const unhandled = await dispatchEnvelope(encoded, { text: () => 'text' });
  assert.equal(unhandled.status, 'unhandled');

  const mismatched = await dispatchEnvelope(
    encoded,
    { file_offer_cancel: () => 'handled' },
    { expectedCid: 'different_control_id' },
  );
  assert.deepEqual(mismatched, { status: 'rejected', reason: 'invalid_envelope' });
});
