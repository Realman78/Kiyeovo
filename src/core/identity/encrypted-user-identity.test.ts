import assert from 'node:assert/strict';
import test from 'node:test';
import { EncryptedUserIdentity } from './encrypted-user-identity.js';

test('recovery phrases validate as BIP39 and derive mode-scoped recovery passwords', () => {
  const phrase = EncryptedUserIdentity.generateRecoveryPhrase();

  assert.equal(EncryptedUserIdentity.validateRecoveryPhrase(phrase), true);
  assert.equal(EncryptedUserIdentity.validateRecoveryPhrase('not a valid recovery phrase'), false);

  const fastPassword = EncryptedUserIdentity.derivePasswordFromPhrase(phrase, 'fast');
  const anonymousPassword = EncryptedUserIdentity.derivePasswordFromPhrase(phrase, 'anonymous');
  try {
    assert.equal(fastPassword.byteLength, 32);
    assert.equal(anonymousPassword.byteLength, 32);
    assert.notDeepEqual(Buffer.from(fastPassword), Buffer.from(anonymousPassword));
  } finally {
    fastPassword.fill(0);
    anonymousPassword.fill(0);
  }
});

test('identity signatures verify only for the exact payload and signing key', async () => {
  const identity = await EncryptedUserIdentity.createEncrypted();
  const otherIdentity = await EncryptedUserIdentity.createEncrypted();
  const payload = {
    type: 'key_exchange',
    senderUsername: 'alice',
    timestamp: 1_000,
    ephemeralPublicKey: 'ephemeral-public-key',
  };

  const signature = Buffer.from(identity.sign(JSON.stringify(payload))).toString('base64');
  const publicKey = Buffer.from(identity.signingPublicKey).toString('base64');
  const otherPublicKey = Buffer.from(otherIdentity.signingPublicKey).toString('base64');

  assert.equal(EncryptedUserIdentity.verifyKeyExchangeSignature(signature, payload, publicKey), true);
  assert.equal(EncryptedUserIdentity.verifyKeyExchangeSignature(
    signature,
    { ...payload, timestamp: 2_000 },
    publicKey,
  ), false);
  assert.equal(EncryptedUserIdentity.verifyKeyExchangeSignature(signature, payload, otherPublicKey), false);
});

test('password strength requires length and character diversity', () => {
  assert.deepEqual(EncryptedUserIdentity.validatePasswordStrength('Short1!'), {
    valid: false,
    message: 'Password must be at least 12 characters long',
  });
  assert.deepEqual(EncryptedUserIdentity.validatePasswordStrength('longbutnodiversity'), {
    valid: false,
    message: 'Password must contain at least: lowercase, uppercase, numbers, special character',
  });
  assert.deepEqual(EncryptedUserIdentity.validatePasswordStrength('Long-enough-123'), {
    valid: true,
  });
});
