import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';

import {
  canonicalUsernameRegistrationPayload,
  isUsernameRegistrationRecord,
  signUsernameRegistrationPayload,
  verifyUsernameRegistrationSignature,
} from './username-record.js';
import type { UserRegistration } from '../types.js';

const encoder = new TextEncoder();
const priv = ed25519.utils.randomPrivateKey();
const signingPublicKey = Buffer.from(ed25519.getPublicKey(priv)).toString('base64');

type SignedFields = Omit<UserRegistration, 'signature' | 'peerBinding'>;

const baseFields = (over: Partial<SignedFields> = {}): SignedFields => ({
  peerID: '12D3KooWKDrpSzWYyCaJ4gfNGY5XUjUYN9tVZe8t9biMMY9HxU8K',
  networkMode: 'fast',
  username: 'alice',
  signingPublicKey,
  offlinePublicKey: Buffer.from('offline-key').toString('base64'),
  timestamp: 1_700_000_000_000,
  ...over,
});

const signed = (fields: SignedFields): UserRegistration => ({
  ...fields,
  signature: signUsernameRegistrationPayload(fields, (json) => ed25519.sign(encoder.encode(json), priv)),
  peerBinding: 'cGVlci1iaW5kaW5n', // shape-only; peer binding verified elsewhere
});

const A = '/ip4/1.1.1.1/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM/p2p-circuit';
const B = '/ip4/2.2.2.2/tcp/4002/p2p/12D3KooWDfn9gv6mQsb8CBCmXRPLbBzDaZrcZD8HiQ4a3rgNp4MM/p2p-circuit';

test('canonical payload includes multiaddrs, sorted', () => {
  const p = canonicalUsernameRegistrationPayload(baseFields({ multiaddrs: [B, A] }));
  assert.deepEqual(p.multiaddrs, [A, B]);
});

test('canonical payload keeps only the original fields when multiaddrs/kind absent (back-compat)', () => {
  const keys = Object.keys(canonicalUsernameRegistrationPayload(baseFields()));
  assert.deepEqual(keys, ['peerID', 'networkMode', 'username', 'signingPublicKey', 'offlinePublicKey', 'timestamp']);
});

test('empty multiaddrs is omitted from the canonical payload', () => {
  assert.equal('multiaddrs' in canonicalUsernameRegistrationPayload(baseFields({ multiaddrs: [] })), false);
});

test('signature covers multiaddrs — tampering an address fails verification', () => {
  const rec = signed(baseFields({ multiaddrs: [A] }));
  assert.equal(verifyUsernameRegistrationSignature(rec), true);
  assert.equal(verifyUsernameRegistrationSignature({ ...rec, multiaddrs: [B] }), false);
});

test('address order does not affect verification (canonical sorts)', () => {
  const rec = signed(baseFields({ multiaddrs: [A, B] }));
  assert.equal(verifyUsernameRegistrationSignature({ ...rec, multiaddrs: [B, A] }), true);
});

test('a record with no multiaddrs still verifies (unchanged signed bytes)', () => {
  assert.equal(verifyUsernameRegistrationSignature(signed(baseFields())), true);
});

test('isUsernameRegistrationRecord accepts valid multiaddrs and absent field', () => {
  assert.equal(isUsernameRegistrationRecord(signed(baseFields({ multiaddrs: [A] }))), true);
  assert.equal(isUsernameRegistrationRecord(signed(baseFields())), true);
});

test('isUsernameRegistrationRecord rejects malformed multiaddrs', () => {
  assert.equal(isUsernameRegistrationRecord({ ...signed(baseFields()), multiaddrs: 'nope' }), false);
  assert.equal(isUsernameRegistrationRecord({ ...signed(baseFields()), multiaddrs: [123] }), false);
  assert.equal(isUsernameRegistrationRecord({ ...signed(baseFields()), multiaddrs: [''] }), false);
});
