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

test('recovery phrase validation and derivation normalize case and whitespace', () => {
  const phrase = EncryptedUserIdentity.generateRecoveryPhrase();
  const words = phrase.split(' ');
  const messyPhrase = `\n${words.slice(0, 6).join('  ')}\t${words.slice(6, 12).join('\n')}\r\n${words.slice(12, 18).join('   ')} ${words.slice(18).join('\t')}\n`.toUpperCase();

  assert.equal(EncryptedUserIdentity.validateRecoveryPhrase(phrase), true);
  assert.equal(EncryptedUserIdentity.validateRecoveryPhrase(messyPhrase), true);

  const canonicalPassword = EncryptedUserIdentity.derivePasswordFromPhrase(phrase, 'fast');
  const messyPassword = EncryptedUserIdentity.derivePasswordFromPhrase(messyPhrase, 'fast');
  try {
    assert.deepEqual(Buffer.from(messyPassword), Buffer.from(canonicalPassword));
  } finally {
    canonicalPassword.fill(0);
    messyPassword.fill(0);
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

test('new identity creation stores remembered password only after encrypted save succeeds', async () => {
  const originalCreateEncrypted = EncryptedUserIdentity.createEncrypted;
  const originalError = console.error;
  const originalLog = console.log;
  const events: string[] = [];
  const fakeIdentity = {
    id: 'peer_keychain_after_save',
    saveEncrypted: async () => {
      events.push('save');
      throw new Error('persist failed');
    },
  } as unknown as EncryptedUserIdentity;
  const fakeDatabase = {
    getEncryptedUserIdentityForMode: () => null,
  };
  const fakeKeytar = {
    getPassword: async () => null,
    setPassword: async () => {
      events.push('store');
    },
  };

  EncryptedUserIdentity.createEncrypted = async () => fakeIdentity;
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    await assert.rejects(
      EncryptedUserIdentity.loadOrCreateEncryptedForMode(
        fakeDatabase as unknown as Parameters<typeof EncryptedUserIdentity.loadOrCreateEncryptedForMode>[0],
        'fast',
        async () => ({
          password: 'Long-enough-123',
          rememberMe: true,
        }),
        () => undefined,
        fakeKeytar,
      ),
      /persist failed/,
    );

    assert.deepEqual(events, ['save']);
  } finally {
    EncryptedUserIdentity.createEncrypted = originalCreateEncrypted;
    console.error = originalError;
    console.log = originalLog;
  }
});

test('recovery phrase login prompts for a new password and re-encrypts under it', async () => {
  // Exercises the fix-5 orchestration without spawning the real encryption
  // Worker thread (which needs the compiled .js and cannot run under tsx):
  // loadWithRecoveryPhrase is stubbed and saveEncrypted is a spy.
  const peerId = 'peer_recovery_reset';
  const recoveryPhrase = EncryptedUserIdentity.generateRecoveryPhrase();
  const newPassword = 'New-password-123!';

  const originalLoadWithRecoveryPhrase = EncryptedUserIdentity.loadWithRecoveryPhrase;
  const originalError = console.error;
  const originalLog = console.log;

  const events: string[] = [];
  let savedPassword: string | null = null;
  let savedRecoveryPhrase: string | undefined;
  const fakeIdentity = {
    id: peerId,
    saveEncrypted: async (_db: unknown, _mode: unknown, password: Uint8Array, _status: unknown, phrase?: string) => {
      events.push('save');
      savedPassword = new TextDecoder().decode(password);
      savedRecoveryPhrase = phrase;
    },
  } as unknown as EncryptedUserIdentity;

  const storedPasswords: Array<{ service: string; account: string; password: string }> = [];
  const fakeKeytar = {
    getPassword: async () => null,
    setPassword: async (service: string, account: string, password: string) => {
      events.push('store');
      storedPasswords.push({ service, account, password });
    },
  };
  const fakeDatabase = {
    checkLoginCooldown: () => ({ isLocked: false, remainingSeconds: 0 }),
    clearLoginAttempts: () => { events.push('clearAttempts'); },
    recordFailedLoginAttempt: () => { events.push('failedAttempt'); },
  };
  const primaryRow = {
    peer_id: peerId,
    salt: Buffer.alloc(32),
    nonce: Buffer.alloc(12),
    encrypted_data: Buffer.from('unused'),
  };

  const passwordRequests: Array<{
    isNew: boolean;
    prompt: string;
    recoveryPhrase: string | undefined;
    showRecoveryOption: boolean | undefined;
    keychainAvailable: boolean | undefined;
  }> = [];

  EncryptedUserIdentity.loadWithRecoveryPhrase = async () => {
    events.push('recover');
    return fakeIdentity;
  };
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    const recovered = await EncryptedUserIdentity.loadEncrypted(
      primaryRow as unknown as Parameters<typeof EncryptedUserIdentity.loadEncrypted>[0],
      'fast',
      async (prompt, isNew, requestRecoveryPhrase, _prefill, _err, _cooldown, showRecoveryOption, keychainAvailable) => {
        passwordRequests.push({ isNew, prompt, recoveryPhrase: requestRecoveryPhrase, showRecoveryOption, keychainAvailable });
        if (!isNew) {
          return { password: recoveryPhrase, rememberMe: false, useRecoveryPhrase: true };
        }
        return { password: newPassword, rememberMe: true };
      },
      () => undefined,
      fakeDatabase as unknown as Parameters<typeof EncryptedUserIdentity.loadEncrypted>[4],
      fakeKeytar,
    );

    assert.equal(recovered, fakeIdentity);
    // Two prompts: the recovery-phrase unlock, then the forced set-new-password.
    assert.equal(passwordRequests.length, 2);
    const setPasswordPrompt = passwordRequests[1];
    assert.ok(setPasswordPrompt);
    assert.equal(setPasswordPrompt.prompt, 'Set a new password for your identity');
    assert.equal(setPasswordPrompt.isNew, true);
    assert.equal(setPasswordPrompt.recoveryPhrase, undefined);
    assert.equal(setPasswordPrompt.showRecoveryOption, false);
    assert.equal(setPasswordPrompt.keychainAvailable, true);

    // Re-encrypt happens with the NEW password and the SAME recovery phrase,
    // the keychain is written only AFTER the save, and attempts clear last.
    assert.deepEqual(events, ['recover', 'save', 'store', 'clearAttempts']);
    assert.equal(savedPassword, newPassword);
    assert.equal(savedRecoveryPhrase, recoveryPhrase);
    assert.deepEqual(storedPasswords, [{
      service: 'kiyeovo',
      account: `fast:${peerId}`,
      password: newPassword,
    }]);
  } finally {
    EncryptedUserIdentity.loadWithRecoveryPhrase = originalLoadWithRecoveryPhrase;
    console.error = originalError;
    console.log = originalLog;
  }
});

test('recovery-phrase re-encrypt failure surfaces a clear error and does not clear login attempts', async () => {
  const peerId = 'peer_recovery_reset_fail';
  const recoveryPhrase = EncryptedUserIdentity.generateRecoveryPhrase();

  const originalLoadWithRecoveryPhrase = EncryptedUserIdentity.loadWithRecoveryPhrase;
  const originalError = console.error;
  const originalLog = console.log;

  const events: string[] = [];
  const fakeIdentity = {
    id: peerId,
    saveEncrypted: async () => {
      events.push('save');
      throw new Error('disk full');
    },
  } as unknown as EncryptedUserIdentity;
  const fakeKeytar = {
    getPassword: async () => null,
    setPassword: async () => { events.push('store'); },
  };
  const fakeDatabase = {
    checkLoginCooldown: () => ({ isLocked: false, remainingSeconds: 0 }),
    clearLoginAttempts: () => { events.push('clearAttempts'); },
    recordFailedLoginAttempt: () => { events.push('failedAttempt'); },
  };
  const primaryRow = { peer_id: peerId, salt: Buffer.alloc(32), nonce: Buffer.alloc(12), encrypted_data: Buffer.from('unused') };

  EncryptedUserIdentity.loadWithRecoveryPhrase = async () => fakeIdentity;
  console.error = () => undefined;
  console.log = () => undefined;

  try {
    await assert.rejects(
      EncryptedUserIdentity.loadEncrypted(
        primaryRow as unknown as Parameters<typeof EncryptedUserIdentity.loadEncrypted>[0],
        'fast',
        async (_prompt, isNew) => (isNew
          ? { password: 'New-password-123!', rememberMe: true }
          : { password: recoveryPhrase, rememberMe: false, useRecoveryPhrase: true }),
        () => undefined,
        fakeDatabase as unknown as Parameters<typeof EncryptedUserIdentity.loadEncrypted>[4],
        fakeKeytar,
      ),
      /Recovery phrase accepted, but setting a new password failed/,
    );

    // The save was attempted, but the keychain was never written and login
    // attempts were not cleared — the failure is not swallowed or retried.
    assert.deepEqual(events, ['save']);
  } finally {
    EncryptedUserIdentity.loadWithRecoveryPhrase = originalLoadWithRecoveryPhrase;
    console.error = originalError;
    console.log = originalLog;
  }
});
