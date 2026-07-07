import assert from 'node:assert/strict';
import test from 'node:test';
import type { OfflineMessage } from '../types.js';
import { isStructurallyStorableOfflineMessage } from './offline-message-storable.js';

function baseMessage(): OfflineMessage {
  const timestamp = 1_700_000_000_000;
  const expires_at = timestamp + 1_000;
  return {
    id: 'msg-1',
    encrypted_sender_info: 'x',
    content: 'y',
    signature: 'sig',
    message_type: 'encrypted',
    timestamp,
    expires_at,
    signed_payload: {
      content_hash: 'ch',
      sender_info_hash: 'sh',
      timestamp,
      bucket_key: 'bk',
      message_type: 'encrypted',
      expires_at,
    },
  } as OfflineMessage;
}

test('a well-formed encrypted message is storable', () => {
  assert.equal(isStructurallyStorableOfflineMessage(baseMessage()), true);
});

test('a well-formed hybrid message is storable', () => {
  const msg = baseMessage();
  msg.message_type = 'hybrid';
  msg.signed_payload.message_type = 'hybrid';
  assert.equal(isStructurallyStorableOfflineMessage(msg), true);
});

test('a message whose signed payload lacks message_type is dropped (pre-4dbf77c shape)', () => {
  const msg = baseMessage();
  delete (msg.signed_payload as { message_type?: string }).message_type;
  assert.equal(isStructurallyStorableOfflineMessage(msg), false);
});

test('envelope/payload message_type disagreement is dropped', () => {
  const msg = baseMessage();
  msg.signed_payload.message_type = 'hybrid';
  assert.equal(isStructurallyStorableOfflineMessage(msg), false);
});

test('an unknown message_type is dropped', () => {
  const msg = baseMessage();
  (msg as { message_type: string }).message_type = 'plaintext';
  (msg.signed_payload as { message_type: string }).message_type = 'plaintext';
  assert.equal(isStructurallyStorableOfflineMessage(msg), false);
});

test('timestamp disagreement with signed payload is dropped', () => {
  const msg = baseMessage();
  msg.timestamp = msg.signed_payload.timestamp + 1;
  assert.equal(isStructurallyStorableOfflineMessage(msg), false);
});

test('expires_at disagreement with signed payload is dropped', () => {
  const msg = baseMessage();
  msg.expires_at = msg.signed_payload.expires_at + 1;
  assert.equal(isStructurallyStorableOfflineMessage(msg), false);
});

test('a message missing signature or signed_payload is dropped', () => {
  const noSig = baseMessage();
  (noSig as { signature?: string }).signature = '';
  assert.equal(isStructurallyStorableOfflineMessage(noSig), false);

  const noPayload = baseMessage();
  delete (noPayload as { signed_payload?: unknown }).signed_payload;
  assert.equal(isStructurallyStorableOfflineMessage(noPayload), false);
});
