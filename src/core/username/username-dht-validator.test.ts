import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import { NETWORK_MODE_CONFIG, REREGISTRATION_INTERVAL, USERNAME_MAX_FUTURE_SKEW_MS } from '../constants.js';
import type { UserRegistration } from '../types.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import {
  signUsernameRegistrationPayload,
  verifyUsernameRegistrationSignature,
} from './username-record.js';
import {
  usernameRegistrationSelector,
  usernameRegistrationValidateUpdate,
  usernameRegistrationValidator,
} from './username-dht-validator.js';

const encoder = new TextEncoder();
const USERNAME_PREFIX = NETWORK_MODE_CONFIG.fast.dhtNamespaces.username;
const PRIVATE_A = new Uint8Array(32).fill(7);
const PRIVATE_B = new Uint8Array(32).fill(13);

function publicKey(privateKey: Uint8Array): string {
  return Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64');
}

function sign(privateKey: Uint8Array, payloadJson: string): Uint8Array {
  return ed25519.sign(encoder.encode(payloadJson), privateKey);
}

function makeRegistration(overrides: Partial<Omit<UserRegistration, 'signature'>> & {
  privateKey?: Uint8Array;
} = {}): UserRegistration {
  const privateKey = overrides.privateKey ?? PRIVATE_A;
  const unsigned: Omit<UserRegistration, 'signature'> = {
    peerID: overrides.peerID ?? 'peer-a',
    username: overrides.username ?? 'alice',
    signingPublicKey: overrides.signingPublicKey ?? publicKey(privateKey),
    offlinePublicKey: overrides.offlinePublicKey ?? 'offline-key-a',
    timestamp: overrides.timestamp ?? Date.now(),
    ...(overrides.kind === undefined ? {} : { kind: overrides.kind }),
  };
  return {
    ...unsigned,
    signature: signUsernameRegistrationPayload(unsigned, (payloadJson) => sign(privateKey, payloadJson)),
  };
}

function encodeRecord(registration: UserRegistration): Uint8Array {
  return encoder.encode(JSON.stringify(registration));
}

function usernameKey(kind: 'by-name' | 'by-peer', hash: string): Uint8Array {
  return encoder.encode(USERNAME_PREFIX + '/' + kind + '/' + hash);
}

async function withoutConsoleWarn(fn: () => Promise<void>): Promise<void> {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test('username DHT validator accepts valid by-name and by-peer registrations', async () => {
  const registration = makeRegistration();
  assert.equal(verifyUsernameRegistrationSignature(registration), true);

  await usernameRegistrationValidator(
    usernameKey('by-name', hashUsingSha256(registration.username)),
    encodeRecord(registration),
  );
  await usernameRegistrationValidator(
    usernameKey('by-peer', hashUsingSha256(registration.peerID)),
    encodeRecord(registration),
  );
});

test('username DHT validator rejects signature, key-binding, and future timestamp failures', async () => {
  const registration = makeRegistration();
  const tampered = { ...registration, username: 'mallory' };

  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-name', hashUsingSha256(tampered.username)),
      encodeRecord(tampered),
    ),
    /Invalid username registration signature/,
  );

  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-name', hashUsingSha256('mallory')),
      encodeRecord(registration),
    ),
    /key binding mismatch/,
  );

  await withoutConsoleWarn(async () => {
    const future = makeRegistration({ timestamp: Date.now() + USERNAME_MAX_FUTURE_SKEW_MS + 1_000 });
    await assert.rejects(
      () => usernameRegistrationValidator(
        usernameKey('by-name', hashUsingSha256(future.username)),
        encodeRecord(future),
      ),
      /future-dated record rejected/,
    );
  });
});

test('username DHT selector chooses the newest valid record bound to the requested key', () => {
  const key = usernameKey('by-name', hashUsingSha256('alice'));
  const older = makeRegistration({ username: 'alice', timestamp: 1_000 });
  const newer = makeRegistration({ username: 'alice', timestamp: 2_000 });
  const mismatched = makeRegistration({ username: 'bob', timestamp: 3_000 });
  const invalid = encoder.encode('{not-json');

  assert.equal(
    usernameRegistrationSelector(key, [encodeRecord(older), encodeRecord(mismatched), invalid, encodeRecord(newer)]),
    3,
  );
});

test('username DHT validateUpdate enforces timestamp and owner rules', async () => {
  const existing = makeRegistration({ username: 'alice', peerID: 'peer-a', timestamp: Date.now() });
  const key = usernameKey('by-name', hashUsingSha256(existing.username));
  const sameOwnerNewer = makeRegistration({
    username: existing.username,
    peerID: existing.peerID,
    timestamp: existing.timestamp + 1,
  });
  await usernameRegistrationValidateUpdate(key, encodeRecord(existing), encodeRecord(sameOwnerNewer));

  const older = makeRegistration({
    username: existing.username,
    peerID: existing.peerID,
    timestamp: existing.timestamp - 1,
  });
  await withoutConsoleWarn(async () => {
    await assert.rejects(
      () => usernameRegistrationValidateUpdate(key, encodeRecord(existing), encodeRecord(older)),
      /stale record rejected/,
    );
  });

  const sameTimestampDifferentPayload = makeRegistration({
    username: existing.username,
    peerID: existing.peerID,
    offlinePublicKey: 'changed-offline-key',
    timestamp: existing.timestamp,
  });
  await withoutConsoleWarn(async () => {
    await assert.rejects(
      () => usernameRegistrationValidateUpdate(
        key,
        encodeRecord(existing),
        encodeRecord(sameTimestampDifferentPayload),
      ),
      /stale record rejected/,
    );
  });

  const differentOwner = makeRegistration({
    username: existing.username,
    peerID: 'peer-b',
    offlinePublicKey: 'offline-key-b',
    privateKey: PRIVATE_B,
    timestamp: existing.timestamp + 2,
  });
  await withoutConsoleWarn(async () => {
    await assert.rejects(
      () => usernameRegistrationValidateUpdate(key, encodeRecord(existing), encodeRecord(differentOwner)),
      /stale record rejected/,
    );
  });
});

test('username DHT validator rejects malformed schemas and invalid key formats', async () => {
  const shortUsername = makeRegistration({ username: 'ab' });
  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-name', hashUsingSha256(shortUsername.username)),
      encodeRecord(shortUsername),
    ),
    /Invalid username registration schema/,
  );

  const registration = makeRegistration();
  await assert.rejects(
    () => usernameRegistrationValidator(
      encoder.encode('/wrong-username/by-name/' + hashUsingSha256(registration.username)),
      encodeRecord(registration),
    ),
    /Invalid username key prefix/,
  );

  await assert.rejects(
    () => usernameRegistrationValidator(
      encoder.encode(USERNAME_PREFIX + '/by-name'),
      encodeRecord(registration),
    ),
    /Invalid username key format/,
  );

  await assert.rejects(
    () => usernameRegistrationValidator(
      encoder.encode(USERNAME_PREFIX + '/by-email/' + hashUsingSha256(registration.username)),
      encodeRecord(registration),
    ),
    new RegExp('Invalid username key kind/hash'),
  );
});

test('username DHT validateUpdate allows released and stale active records to be replaced', async () => {
  const released = makeRegistration({
    username: 'alice',
    peerID: 'peer-a',
    kind: 'released',
    timestamp: Date.now(),
  });
  const releasedKey = usernameKey('by-name', hashUsingSha256(released.username));
  const takeoverAfterRelease = makeRegistration({
    username: released.username,
    peerID: 'peer-b',
    offlinePublicKey: 'offline-key-b',
    privateKey: PRIVATE_B,
    timestamp: released.timestamp + 1,
  });
  await usernameRegistrationValidateUpdate(
    releasedKey,
    encodeRecord(released),
    encodeRecord(takeoverAfterRelease),
  );

  const staleActive = makeRegistration({
    username: 'carol',
    peerID: 'peer-a',
    timestamp: Date.now() - (REREGISTRATION_INTERVAL * 2) - 1_000,
  });
  const staleKey = usernameKey('by-name', hashUsingSha256(staleActive.username));
  const takeoverAfterStale = makeRegistration({
    username: staleActive.username,
    peerID: 'peer-b',
    offlinePublicKey: 'offline-key-b',
    privateKey: PRIVATE_B,
    timestamp: staleActive.timestamp + 1,
  });

  await withoutConsoleWarn(async () => {
    await usernameRegistrationValidateUpdate(
      staleKey,
      encodeRecord(staleActive),
      encodeRecord(takeoverAfterStale),
    );
  });
});
