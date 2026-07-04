import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import { ChatDatabase } from '../db/database.js';
import { KeyExchange } from './key-exchange.js';
import type { AuthenticatedEncryptedMessage, MessageToVerify, UserRegistration } from '../types.js';

const encoder = new TextEncoder();
const PEER_ID = 'peer_alice';
const USERNAME = 'alice';

type SigningKeyPair = {
  privateKey: Uint8Array;
  publicKey: string;
};

function makeSigningKeyPair(): SigningKeyPair {
  const privateKey = ed25519.utils.randomSecretKey();
  return {
    privateKey,
    publicKey: Buffer.from(ed25519.getPublicKey(privateKey)).toString('base64'),
  };
}

function signPayload(privateKey: Uint8Array, payload: object): string {
  return Buffer.from(ed25519.sign(encoder.encode(JSON.stringify(payload)), privateKey)).toString('base64');
}

function makeRegistration(input: {
  peerId?: string;
  username?: string;
  signingPublicKey: string;
  offlinePublicKey?: string;
  signature?: string;
}): UserRegistration {
  return {
    peerID: input.peerId ?? PEER_ID,
    username: input.username ?? USERNAME,
    timestamp: 1_000,
    signingPublicKey: input.signingPublicKey,
    offlinePublicKey: input.offlinePublicKey ?? 'offline_key',
    signature: input.signature ?? 'registration_signature',
    peerBinding: 'peer_binding',
  };
}

function makeVerifyMessage(content: MessageToVerify['content'] = 'key_exchange_response'): MessageToVerify {
  return {
    type: 'key_exchange',
    content,
    ephemeralPublicKey: 'ephemeral_public_key',
    senderUsername: USERNAME,
    timestamp: 1_000,
  };
}

async function createPinnedUser(
  database: ChatDatabase,
  signingPublicKey: string,
  offlinePublicKey = 'old_offline_key',
): Promise<void> {
  await database.createUser({
    peer_id: PEER_ID,
    username: USERNAME,
    signing_public_key: signingPublicKey,
    offline_public_key: offlinePublicKey,
    signature: 'old_registration_signature',
  });
}

async function createRosterSeededUser(
  database: ChatDatabase,
  signingPublicKey: string,
  offlinePublicKey = 'roster_offline_key',
): Promise<void> {
  await database.createUser({
    peer_id: PEER_ID,
    username: USERNAME,
    signing_public_key: signingPublicKey,
    offline_public_key: offlinePublicKey,
    signature: '',
  });
}

function makeKeyExchange(database: ChatDatabase, usernameRegistry: object): any {
  const noop = () => undefined;
  return new KeyExchange(
    {} as any,
    usernameRegistry as any,
    {} as any,
    database,
    noop,
    noop,
    noop,
    noop,
    noop,
    noop,
  ) as any;
}

test('verifySignatureWithFallback does not mutate pinned keys when DHT retry also fails', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  const wrongSigner = makeSigningKeyPair();
  await createPinnedUser(database, pinned.publicKey, 'old_offline_key');

  const message = makeVerifyMessage();
  const signature = signPayload(wrongSigner.privateKey, message);
  const keyExchange = makeKeyExchange(database, {
    lookup: async () => makeRegistration({
      signingPublicKey: pinned.publicKey,
      offlinePublicKey: 'refreshed_offline_key',
      signature: 'refreshed_registration_signature',
    }),
  });

  const result = await keyExchange.verifySignatureWithFallback(signature, message, USERNAME, PEER_ID);

  assert.equal(result.valid, false);
  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, pinned.publicKey);
  assert.equal(user?.offline_public_key, 'old_offline_key');
  assert.equal(user?.signature, 'old_registration_signature');
});

test('verifySignatureWithFallback records differing DHT key without replacing pinned key', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  const dht = makeSigningKeyPair();
  await createPinnedUser(database, pinned.publicKey);

  const message = makeVerifyMessage();
  const signature = signPayload(dht.privateKey, message);
  const keyExchange = makeKeyExchange(database, {
    lookup: async () => makeRegistration({
      signingPublicKey: dht.publicKey,
      offlinePublicKey: 'dht_offline_key',
      signature: 'dht_registration_signature',
    }),
  });

  const result = await keyExchange.verifySignatureWithFallback(signature, message, USERNAME, PEER_ID);

  assert.deepEqual(result, { valid: false, signingPublicKey: pinned.publicKey });
  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, pinned.publicKey);
  assert.equal(user?.offline_public_key, 'old_offline_key');

  const events = database.getKeyChangeEvents(PEER_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.peer_id, PEER_ID);
  assert.equal(events[0]?.username, USERNAME);
  assert.equal(events[0]?.old_signing_key, pinned.publicKey);
  assert.equal(events[0]?.new_signing_key, dht.publicKey);
  assert.equal(events[0]?.source, 'signature_dht_fallback');
});

test('verifySignatureWithFallback adopts verified DHT key over roster-seeded key without event', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const roster = makeSigningKeyPair();
  const dht = makeSigningKeyPair();
  await createRosterSeededUser(database, roster.publicKey);

  const message = makeVerifyMessage();
  const signature = signPayload(dht.privateKey, message);
  const keyExchange = makeKeyExchange(database, {
    lookup: async () => makeRegistration({
      signingPublicKey: dht.publicKey,
      offlinePublicKey: 'dht_offline_key',
      signature: 'dht_registration_signature',
    }),
  });

  const result = await keyExchange.verifySignatureWithFallback(signature, message, USERNAME, PEER_ID);

  assert.deepEqual(result, { valid: true, signingPublicKey: dht.publicKey });
  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, dht.publicKey);
  assert.equal(user?.offline_public_key, 'dht_offline_key');
  assert.equal(user?.signature, 'dht_registration_signature');
  assert.deepEqual(database.getKeyChangeEvents(PEER_ID), []);
});

test('verifySignatureWithFallback pins first-contact DHT key after successful verification', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const dht = makeSigningKeyPair();
  const message = makeVerifyMessage();
  const signature = signPayload(dht.privateKey, message);
  const keyExchange = makeKeyExchange(database, {
    lookup: async () => makeRegistration({
      signingPublicKey: dht.publicKey,
      offlinePublicKey: 'dht_offline_key',
      signature: 'dht_registration_signature',
    }),
  });

  const result = await keyExchange.verifySignatureWithFallback(signature, message, USERNAME, PEER_ID);

  assert.deepEqual(result, { valid: true, signingPublicKey: dht.publicKey });
  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, dht.publicKey);
  assert.equal(user?.offline_public_key, 'dht_offline_key');
  assert.equal(user?.signature, 'dht_registration_signature');
  assert.deepEqual(database.getKeyChangeEvents(PEER_ID), []);
});

test('verifyKeyExchangeInitSignature rejects differing incoming key for direct-KX-verified user and records event', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  const incoming = makeSigningKeyPair();
  await createPinnedUser(database, pinned.publicKey);

  const verifyPayload = makeVerifyMessage('key_exchange_init');
  const message: AuthenticatedEncryptedMessage = {
    type: 'key_exchange',
    content: 'key_exchange_init',
    ephemeralPublicKey: verifyPayload.ephemeralPublicKey,
    senderUsername: verifyPayload.senderUsername,
    timestamp: verifyPayload.timestamp,
    signature: signPayload(incoming.privateKey, verifyPayload),
  };
  const sender = makeRegistration({
    signingPublicKey: incoming.publicKey,
    offlinePublicKey: 'incoming_offline_key',
    signature: 'incoming_registration_signature',
  });

  const keyExchange = makeKeyExchange(database, {});
  const result = await keyExchange.verifyKeyExchangeInitSignature(message, sender, PEER_ID);

  assert.equal(result.valid, false);
  assert.equal(result.keys.signingPublicKey, pinned.publicKey);
  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, pinned.publicKey);
  assert.equal(user?.offline_public_key, 'old_offline_key');
  assert.equal(user?.signature, 'old_registration_signature');

  const events = database.getKeyChangeEvents(PEER_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.old_signing_key, pinned.publicKey);
  assert.equal(events[0]?.new_signing_key, incoming.publicKey);
  assert.equal(events[0]?.source, 'key_exchange_init_incoming');
});

test('verifyKeyExchangeInitSignature rejects DHT-refreshed differing pinned key and records event', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  const dht = makeSigningKeyPair();
  await createPinnedUser(database, pinned.publicKey);

  const verifyPayload = makeVerifyMessage('key_exchange_init');
  const message: AuthenticatedEncryptedMessage = {
    type: 'key_exchange',
    content: 'key_exchange_init',
    ephemeralPublicKey: verifyPayload.ephemeralPublicKey,
    senderUsername: verifyPayload.senderUsername,
    timestamp: verifyPayload.timestamp,
    signature: signPayload(dht.privateKey, verifyPayload),
  };
  const sender = database.getUserByPeerId(PEER_ID);
  assert.ok(sender);

  const keyExchange = makeKeyExchange(database, {
    lookupByPeerId: async () => makeRegistration({
      signingPublicKey: dht.publicKey,
      offlinePublicKey: 'dht_offline_key',
      signature: 'dht_registration_signature',
    }),
  });

  const result = await keyExchange.verifyKeyExchangeInitSignature(message, sender, PEER_ID);

  assert.equal(result.valid, false);
  assert.equal(result.keys.signingPublicKey, pinned.publicKey);
  assert.equal(database.getUserByPeerId(PEER_ID)?.signing_public_key, pinned.publicKey);

  const events = database.getKeyChangeEvents(PEER_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.old_signing_key, pinned.publicKey);
  assert.equal(events[0]?.new_signing_key, dht.publicKey);
  assert.equal(events[0]?.source, 'key_exchange_init_dht_refresh');
});

test('verifyKeyExchangeInitSignature adopts verified key over roster-seeded wrong key without event', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const roster = makeSigningKeyPair();
  const real = makeSigningKeyPair();
  await createRosterSeededUser(database, roster.publicKey);

  const verifyPayload = makeVerifyMessage('key_exchange_init');
  const message: AuthenticatedEncryptedMessage = {
    type: 'key_exchange',
    content: 'key_exchange_init',
    ephemeralPublicKey: verifyPayload.ephemeralPublicKey,
    senderUsername: verifyPayload.senderUsername,
    timestamp: verifyPayload.timestamp,
    signature: signPayload(real.privateKey, verifyPayload),
  };
  const sender = makeRegistration({
    signingPublicKey: real.publicKey,
    offlinePublicKey: 'real_offline_key',
    signature: 'real_registration_signature',
  });

  const keyExchange = makeKeyExchange(database, {});
  const result = await keyExchange.verifyKeyExchangeInitSignature(message, sender, PEER_ID);

  assert.equal(result.valid, true);
  assert.equal(result.keys.signingPublicKey, real.publicKey);

  await keyExchange.ensureUserExistsWithKeys(
    PEER_ID,
    USERNAME,
    result.keys.signingPublicKey,
    result.keys.offlinePublicKey,
    result.keys.signature,
  );

  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, real.publicKey);
  assert.equal(user?.offline_public_key, 'real_offline_key');
  assert.equal(user?.signature, 'real_registration_signature');
  assert.deepEqual(database.getKeyChangeEvents(PEER_ID), []);
});

test('verifyKeyExchangeInitSignature verifies correct roster-seeded key and promotes signature', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const real = makeSigningKeyPair();
  await createRosterSeededUser(database, real.publicKey);

  const verifyPayload = makeVerifyMessage('key_exchange_init');
  const message: AuthenticatedEncryptedMessage = {
    type: 'key_exchange',
    content: 'key_exchange_init',
    ephemeralPublicKey: verifyPayload.ephemeralPublicKey,
    senderUsername: verifyPayload.senderUsername,
    timestamp: verifyPayload.timestamp,
    signature: signPayload(real.privateKey, verifyPayload),
  };
  const sender = makeRegistration({
    signingPublicKey: real.publicKey,
    offlinePublicKey: 'real_offline_key',
    signature: 'real_registration_signature',
  });

  const keyExchange = makeKeyExchange(database, {});
  const result = await keyExchange.verifyKeyExchangeInitSignature(message, sender, PEER_ID);

  assert.equal(result.valid, true);
  assert.equal(result.keys.signingPublicKey, real.publicKey);

  await keyExchange.ensureUserExistsWithKeys(
    PEER_ID,
    USERNAME,
    result.keys.signingPublicKey,
    result.keys.offlinePublicKey,
    result.keys.signature,
  );

  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, real.publicKey);
  assert.equal(user?.offline_public_key, 'real_offline_key');
  assert.equal(user?.signature, 'real_registration_signature');
  assert.deepEqual(database.getKeyChangeEvents(PEER_ID), []);
});

test('verifyKeyExchangeInitSignature keeps same-key missing metadata population', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  await database.createUser({
    peer_id: PEER_ID,
    username: USERNAME,
    signing_public_key: pinned.publicKey,
    offline_public_key: '',
    signature: '',
  });

  const verifyPayload = makeVerifyMessage('key_exchange_init');
  const message: AuthenticatedEncryptedMessage = {
    type: 'key_exchange',
    content: 'key_exchange_init',
    ephemeralPublicKey: verifyPayload.ephemeralPublicKey,
    senderUsername: verifyPayload.senderUsername,
    timestamp: verifyPayload.timestamp,
    signature: signPayload(pinned.privateKey, verifyPayload),
  };
  const sender = makeRegistration({
    signingPublicKey: pinned.publicKey,
    offlinePublicKey: 'populated_offline_key',
    signature: 'populated_registration_signature',
  });

  const keyExchange = makeKeyExchange(database, {});
  const result = await keyExchange.verifyKeyExchangeInitSignature(message, sender, PEER_ID);

  assert.equal(result.valid, true);
  assert.equal(result.keys.signingPublicKey, pinned.publicKey);
  assert.equal(result.keys.offlinePublicKey, 'populated_offline_key');
  assert.equal(result.keys.signature, 'populated_registration_signature');

  await keyExchange.ensureUserExistsWithKeys(
    PEER_ID,
    USERNAME,
    result.keys.signingPublicKey,
    result.keys.offlinePublicKey,
    result.keys.signature,
  );

  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, pinned.publicKey);
  assert.equal(user?.offline_public_key, 'populated_offline_key');
  assert.equal(user?.signature, 'populated_registration_signature');
  assert.deepEqual(database.getKeyChangeEvents(PEER_ID), []);
});

test('ensureUserExistsWithKeys records event instead of replacing an existing pinned key', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  const incoming = makeSigningKeyPair();
  await createPinnedUser(database, pinned.publicKey);

  const keyExchange = makeKeyExchange(database, {});
  await keyExchange.ensureUserExistsWithKeys(
    PEER_ID,
    USERNAME,
    incoming.publicKey,
    'incoming_offline_key',
    'incoming_registration_signature',
  );

  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, pinned.publicKey);
  assert.equal(user?.offline_public_key, 'old_offline_key');
  assert.equal(user?.signature, 'old_registration_signature');

  const events = database.getKeyChangeEvents(PEER_ID);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.old_signing_key, pinned.publicKey);
  assert.equal(events[0]?.new_signing_key, incoming.publicKey);
  assert.equal(events[0]?.source, 'key_exchange_init_persist');
});
