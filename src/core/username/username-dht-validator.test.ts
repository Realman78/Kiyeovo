import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { ed25519 } from '@noble/curves/ed25519';
import {
  NETWORK_MODE_CONFIG,
  NETWORK_MODES,
  REREGISTRATION_INTERVAL,
  USERNAME_MAX_FUTURE_SKEW_MS,
  USERNAME_MAX_LENGTH,
  USERNAME_RECORD_MAX_BYTES,
} from '../constants.js';
import { KeyExchange } from '../direct/key-exchange.js';
import type { NetworkMode, UserRegistration } from '../types.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import {
  PEER_BINDING_DOMAIN,
  canonicalUsernameRegistrationPayloadJson,
  isUsernameRegistrationRecord,
  signUsernameRegistrationPayload,
  signUsernameRegistrationPeerBinding,
  verifyUsernameRegistrationPeerBinding,
  verifyUsernameRegistrationSignature,
} from './username-record.js';
import {
  usernameRegistrationSelector,
  usernameRegistrationValidateUpdate,
  usernameRegistrationValidator,
} from './username-dht-validator.js';
import { UsernameRegistry } from './username-registry.js';

const encoder = new TextEncoder();
const PRIVATE_A = new Uint8Array(32).fill(7);
const PRIVATE_B = new Uint8Array(32).fill(13);

type TestPeer = {
  privateKey: PrivateKey;
  peerID: string;
};

async function makePeer(): Promise<TestPeer> {
  const privateKey = await generateKeyPair('Ed25519');
  return {
    privateKey,
    peerID: peerIdFromPrivateKey(privateKey).toString(),
  };
}

function publicKey(privateKey: Uint8Array): string {
  return Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64');
}

function sign(privateKey: Uint8Array, payloadJson: string): Uint8Array {
  return ed25519.sign(encoder.encode(payloadJson), privateKey);
}

async function makeRegistration(overrides: Partial<Omit<UserRegistration, 'signature' | 'peerBinding'>> & {
  privateKey?: Uint8Array;
  peerPrivateKey?: PrivateKey;
} = {}): Promise<UserRegistration> {
  const privateKey = overrides.privateKey ?? PRIVATE_A;
  const peerPrivateKey = overrides.peerPrivateKey ?? await generateKeyPair('Ed25519');
  const unsigned: Omit<UserRegistration, 'signature' | 'peerBinding'> = {
    peerID: overrides.peerID ?? peerIdFromPrivateKey(peerPrivateKey).toString(),
    networkMode: overrides.networkMode ?? NETWORK_MODES.FAST,
    username: overrides.username ?? 'alice',
    signingPublicKey: overrides.signingPublicKey ?? publicKey(privateKey),
    offlinePublicKey: overrides.offlinePublicKey ?? 'offline-key-a',
    timestamp: overrides.timestamp ?? Date.now(),
    ...(overrides.kind === undefined ? {} : { kind: overrides.kind }),
  };
  const signature = signUsernameRegistrationPayload(unsigned, (payloadJson) => sign(privateKey, payloadJson));
  const peerBinding = await signUsernameRegistrationPeerBinding(unsigned, (payloadBytes) =>
    peerPrivateKey.sign(payloadBytes),
  );
  return {
    ...unsigned,
    signature,
    peerBinding,
  };
}

function encodeRecord(registration: UserRegistration): Uint8Array {
  return encoder.encode(JSON.stringify(registration));
}

function usernameKey(
  kind: 'by-name' | 'by-peer',
  hash: string,
  mode: NetworkMode = NETWORK_MODES.FAST,
): Uint8Array {
  const prefix = NETWORK_MODE_CONFIG[mode].dhtNamespaces.username;
  return encoder.encode(prefix + '/' + kind + '/' + hash);
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

async function* dhtValue(value: Uint8Array): AsyncIterable<unknown> {
  yield { name: 'VALUE', value };
}

test('username DHT validator accepts valid by-name and by-peer registrations', async () => {
  const registration = await makeRegistration();
  assert.equal(verifyUsernameRegistrationSignature(registration), true);
  assert.equal(verifyUsernameRegistrationPeerBinding(registration), true);

  await usernameRegistrationValidator(
    usernameKey('by-name', hashUsingSha256(registration.username)),
    encodeRecord(registration),
  );
  await usernameRegistrationValidator(
    usernameKey('by-peer', hashUsingSha256(registration.peerID)),
    encodeRecord(registration),
  );
});

test('username DHT validator binds registrations to the key network mode', async () => {
  const peer = await makePeer();
  const fastRegistration = await makeRegistration({
    username: 'alice',
    peerID: peer.peerID,
    peerPrivateKey: peer.privateKey,
    networkMode: NETWORK_MODES.FAST,
    timestamp: 1_000,
  });
  const anonymousRegistration = await makeRegistration({
    username: fastRegistration.username,
    peerID: peer.peerID,
    peerPrivateKey: peer.privateKey,
    networkMode: NETWORK_MODES.ANONYMOUS,
    timestamp: 2_000,
  });

  const usernameHash = hashUsingSha256(fastRegistration.username);
  const fastKey = usernameKey('by-name', usernameHash, NETWORK_MODES.FAST);
  const anonymousKey = usernameKey('by-name', usernameHash, NETWORK_MODES.ANONYMOUS);
  const replayedFastValue = encodeRecord(fastRegistration);
  const anonymousValue = encodeRecord(anonymousRegistration);

  await usernameRegistrationValidator(fastKey, replayedFastValue);
  await usernameRegistrationValidator(anonymousKey, anonymousValue);

  await assert.rejects(
    () => usernameRegistrationValidator(anonymousKey, replayedFastValue),
    /network mode mismatch/,
  );

  assert.equal(
    usernameRegistrationSelector(anonymousKey, [replayedFastValue, anonymousValue]),
    1,
  );
  assert.throws(
    () => usernameRegistrationSelector(anonymousKey, [replayedFastValue]),
    /network mode mismatch/,
  );

  await assert.rejects(
    () => usernameRegistrationValidateUpdate(anonymousKey, anonymousValue, replayedFastValue),
    /network mode mismatch/,
  );
});

test('username DHT validator rejects signature, key-binding, and future timestamp failures', async () => {
  const registration = await makeRegistration();
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
    const future = await makeRegistration({ timestamp: Date.now() + USERNAME_MAX_FUTURE_SKEW_MS + 1_000 });
    await assert.rejects(
      () => usernameRegistrationValidator(
        usernameKey('by-name', hashUsingSha256(future.username)),
        encodeRecord(future),
      ),
      /future-dated record rejected/,
    );
  });
});

test('username DHT validator rejects missing, malformed, and mis-bound peerBinding records', async () => {
  const peerA = await makePeer();
  const peerB = await makePeer();
  const registration = await makeRegistration({ peerID: peerA.peerID, peerPrivateKey: peerA.privateKey });

  const missingPeerBinding: Partial<UserRegistration> = { ...registration };
  delete missingPeerBinding.peerBinding;
  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-peer', hashUsingSha256(registration.peerID)),
      encoder.encode(JSON.stringify(missingPeerBinding)),
    ),
    /Invalid username registration schema/,
  );

  const malformedPeerBinding = { ...registration, peerBinding: 'not base64' };
  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-peer', hashUsingSha256(registration.peerID)),
      encodeRecord(malformedPeerBinding),
    ),
    /Invalid username registration peer binding/,
  );

  const misBound = await makeRegistration({
    peerID: peerA.peerID,
    peerPrivateKey: peerB.privateKey,
  });
  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-peer', hashUsingSha256(peerA.peerID)),
      encodeRecord(misBound),
    ),
    /Invalid username registration peer binding/,
  );
});

test('username peerBinding uses a domain-separated signing input', async () => {
  const peer = await makePeer();
  const registration = await makeRegistration({ peerID: peer.peerID, peerPrivateKey: peer.privateKey });
  const unsigned = {
    peerID: registration.peerID,
    networkMode: registration.networkMode,
    username: registration.username,
    signingPublicKey: registration.signingPublicKey,
    offlinePublicKey: registration.offlinePublicKey,
    timestamp: registration.timestamp,
    ...(registration.kind === undefined ? {} : { kind: registration.kind }),
  };
  const canonicalBytes = encoder.encode(canonicalUsernameRegistrationPayloadJson(unsigned));
  const domainBytes = encoder.encode(PEER_BINDING_DOMAIN);
  const prefixedBytes = new Uint8Array(domainBytes.length + canonicalBytes.length);
  prefixedBytes.set(domainBytes);
  prefixedBytes.set(canonicalBytes, domainBytes.length);

  const manuallyPrefixed = {
    ...registration,
    peerBinding: Buffer.from(await peer.privateKey.sign(prefixedBytes)).toString('base64'),
  };
  assert.equal(verifyUsernameRegistrationPeerBinding(manuallyPrefixed), true);

  const unprefixed = {
    ...registration,
    peerBinding: Buffer.from(await peer.privateKey.sign(canonicalBytes)).toString('base64'),
  };
  assert.equal(verifyUsernameRegistrationPeerBinding(unprefixed), false);

  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-peer', hashUsingSha256(unprefixed.peerID)),
      encodeRecord(unprefixed),
    ),
    /Invalid username registration peer binding/,
  );
});

test('username DHT selector chooses the newest valid record bound to the requested key', async () => {
  const key = usernameKey('by-name', hashUsingSha256('alice'));
  const older = await makeRegistration({ username: 'alice', timestamp: 1_000 });
  const newer = await makeRegistration({ username: 'alice', timestamp: 2_000 });
  const mismatched = await makeRegistration({ username: 'bob', timestamp: 3_000 });
  const invalid = encoder.encode('{not-json');

  assert.equal(
    usernameRegistrationSelector(key, [encodeRecord(older), encodeRecord(mismatched), invalid, encodeRecord(newer)]),
    3,
  );
});

test('username DHT selector ignores records with invalid peerBinding', async () => {
  const peerA = await makePeer();
  const peerB = await makePeer();
  const key = usernameKey('by-peer', hashUsingSha256(peerA.peerID));
  const validOlder = await makeRegistration({
    peerID: peerA.peerID,
    peerPrivateKey: peerA.privateKey,
    timestamp: 1_000,
  });
  const misBoundNewer = await makeRegistration({
    peerID: peerA.peerID,
    peerPrivateKey: peerB.privateKey,
    timestamp: 3_000,
  });

  assert.equal(
    usernameRegistrationSelector(key, [encodeRecord(validOlder), encodeRecord(misBoundNewer)]),
    0,
  );
});

test('username DHT validateUpdate enforces timestamp and owner rules', async () => {
  const peerA = await makePeer();
  const peerB = await makePeer();
  const existing = await makeRegistration({
    username: 'alice',
    peerID: peerA.peerID,
    peerPrivateKey: peerA.privateKey,
    timestamp: Date.now(),
  });
  const key = usernameKey('by-name', hashUsingSha256(existing.username));
  const sameOwnerNewer = await makeRegistration({
    username: existing.username,
    peerID: existing.peerID,
    peerPrivateKey: peerA.privateKey,
    timestamp: existing.timestamp + 1,
  });
  await usernameRegistrationValidateUpdate(key, encodeRecord(existing), encodeRecord(sameOwnerNewer));

  const older = await makeRegistration({
    username: existing.username,
    peerID: existing.peerID,
    peerPrivateKey: peerA.privateKey,
    timestamp: existing.timestamp - 1,
  });
  await withoutConsoleWarn(async () => {
    await assert.rejects(
      () => usernameRegistrationValidateUpdate(key, encodeRecord(existing), encodeRecord(older)),
      /stale record rejected/,
    );
  });

  const sameTimestampDifferentPayload = await makeRegistration({
    username: existing.username,
    peerID: existing.peerID,
    peerPrivateKey: peerA.privateKey,
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

  const differentOwner = await makeRegistration({
    username: existing.username,
    peerID: peerB.peerID,
    peerPrivateKey: peerB.privateKey,
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

test('username DHT validateUpdate rejects incoming records with invalid peerBinding', async () => {
  const peerA = await makePeer();
  const peerB = await makePeer();
  const existing = await makeRegistration({
    username: 'alice',
    peerID: peerA.peerID,
    peerPrivateKey: peerA.privateKey,
    timestamp: Date.now(),
  });
  const incoming = await makeRegistration({
    username: existing.username,
    peerID: peerA.peerID,
    peerPrivateKey: peerB.privateKey,
    timestamp: existing.timestamp + 1,
  });
  const key = usernameKey('by-name', hashUsingSha256(existing.username));

  await assert.rejects(
    () => usernameRegistrationValidateUpdate(key, encodeRecord(existing), encodeRecord(incoming)),
    /Invalid username registration peer binding/,
  );
});

test('username registration schema enforces the shared username policy', async () => {
  const valid = await makeRegistration({ username: 'Alice_123' });
  assert.equal(isUsernameRegistrationRecord(valid), true);

  for (const username of ['ab', 'a'.repeat(USERNAME_MAX_LENGTH + 1), 'bad-name', 'bad.name', 'bad name']) {
    const invalid = await makeRegistration({ username });
    assert.equal(isUsernameRegistrationRecord(invalid), false);
    await assert.rejects(
      () => usernameRegistrationValidator(
        usernameKey('by-name', hashUsingSha256(username)),
        encodeRecord(invalid),
      ),
      /Invalid username registration schema/,
    );
  }
});

test('username DHT validator rejects oversized values before JSON parse', async () => {
  const oversizedInvalidJson = encoder.encode('{'.repeat(USERNAME_RECORD_MAX_BYTES + 1));

  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-name', hashUsingSha256('alice')),
      oversizedInvalidJson,
    ),
    /exceeds 8192 byte limit/,
  );
});

test('username DHT validator rejects malformed schemas and invalid key formats', async () => {
  const shortUsername = await makeRegistration({ username: 'ab' });
  await assert.rejects(
    () => usernameRegistrationValidator(
      usernameKey('by-name', hashUsingSha256(shortUsername.username)),
      encodeRecord(shortUsername),
    ),
    /Invalid username registration schema/,
  );

  const registration = await makeRegistration();
  await assert.rejects(
    () => usernameRegistrationValidator(
      encoder.encode('/wrong-username/by-name/' + hashUsingSha256(registration.username)),
      encodeRecord(registration),
    ),
    /Invalid username key prefix/,
  );

  await assert.rejects(
    () => usernameRegistrationValidator(
      encoder.encode(NETWORK_MODE_CONFIG.fast.dhtNamespaces.username + '/by-name'),
      encodeRecord(registration),
    ),
    /Invalid username key format/,
  );

  await assert.rejects(
    () => usernameRegistrationValidator(
      encoder.encode(NETWORK_MODE_CONFIG.fast.dhtNamespaces.username + '/by-email/' + hashUsingSha256(registration.username)),
      encodeRecord(registration),
    ),
    new RegExp('Invalid username key kind/hash'),
  );
});

test('username DHT validateUpdate allows released and stale active records to be replaced', async () => {
  const peerA = await makePeer();
  const peerB = await makePeer();
  const released = await makeRegistration({
    username: 'alice',
    peerID: peerA.peerID,
    peerPrivateKey: peerA.privateKey,
    kind: 'released',
    timestamp: Date.now(),
  });
  const releasedKey = usernameKey('by-name', hashUsingSha256(released.username));
  const takeoverAfterRelease = await makeRegistration({
    username: released.username,
    peerID: peerB.peerID,
    peerPrivateKey: peerB.privateKey,
    offlinePublicKey: 'offline-key-b',
    privateKey: PRIVATE_B,
    timestamp: released.timestamp + 1,
  });
  await usernameRegistrationValidateUpdate(
    releasedKey,
    encodeRecord(released),
    encodeRecord(takeoverAfterRelease),
  );

  const staleActive = await makeRegistration({
    username: 'carol',
    peerID: peerA.peerID,
    peerPrivateKey: peerA.privateKey,
    timestamp: Date.now() - (REREGISTRATION_INTERVAL * 2) - 1_000,
  });
  const staleKey = usernameKey('by-name', hashUsingSha256(staleActive.username));
  const takeoverAfterStale = await makeRegistration({
    username: staleActive.username,
    peerID: peerB.peerID,
    peerPrivateKey: peerB.privateKey,
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

test('lookupByPeerId locally rejects records for a different peer ID', async () => {
  const requestedPeer = await makePeer();
  const otherPeer = await makePeer();
  const record = await makeRegistration({
    peerID: otherPeer.peerID,
    peerPrivateKey: otherPeer.privateKey,
    timestamp: Date.now(),
  });
  const registry = new UsernameRegistry(
    {
      services: {
        dht: {
          get: () => dhtValue(encodeRecord(record)),
        },
      },
    } as any,
    {
      getSessionNetworkMode: () => NETWORK_MODES.FAST,
    } as any,
  );

  await assert.rejects(
    () => registry.lookupByPeerId(requestedPeer.peerID),
    /Peer ID not found in DHT/,
  );
});

test('offline key resolution fails closed on mismatched DHT records', async () => {
  const requestedPeer = await makePeer();
  const otherPeer = await makePeer();
  const record = await makeRegistration({
    peerID: otherPeer.peerID,
    peerPrivateKey: otherPeer.privateKey,
    timestamp: Date.now(),
  });
  const keyExchange = Object.create(KeyExchange.prototype) as any;
  keyExchange.database = { getUserByPeerId: () => null };
  keyExchange.usernameRegistry = { lookupByPeerId: async () => record };

  await assert.rejects(
    () => keyExchange.resolveRecipientOfflinePublicKeyBase64(
      peerIdFromString(requestedPeer.peerID),
      'alice',
    ),
    /peer ID mismatch/,
  );
});
