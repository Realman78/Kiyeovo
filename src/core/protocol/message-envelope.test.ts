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
