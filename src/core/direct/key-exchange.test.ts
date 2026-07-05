import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import { ChatDatabase } from '../db/database.js';
import type { User } from '../db/database.js';
import {
  KEY_EXCHANGE_FOLLOWUP_TIMEOUT_ANONYMOUS_MS,
  KEY_EXCHANGE_FOLLOWUP_TIMEOUT_FAST_MS,
  KEY_EXCHANGE_FOLLOWUP_TIMEOUT_MAX_MS,
  KEY_EXCHANGE_FOLLOWUP_TIMEOUT_MIN_MS,
  KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY,
  NETWORK_MODES,
} from '../constants.js';
import { KeyExchange } from './key-exchange.js';
import type { AuthenticatedEncryptedMessage, ChatNode, ContactRequestEvent, MessageToVerify, UserRegistration } from '../types.js';
import type { UsernameRegistry } from '../username/username-registry.js';
import type { SessionManager } from './session-manager.js';

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
    networkMode: NETWORK_MODES.FAST,
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

function makeContactRequestMessage(senderUsername = USERNAME): AuthenticatedEncryptedMessage {
  return {
    type: 'key_exchange',
    content: 'key_exchange_init',
    ephemeralPublicKey: 'ephemeral_public_key',
    senderUsername,
    timestamp: Date.now(),
    signature: 'signature',
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

type KeyExchangeTestOptions = {
  node?: Partial<ChatNode>;
  onContactRequestReceived?: (data: ContactRequestEvent) => void;
};

type SignatureFallbackResult = {
  valid: boolean;
  signingPublicKey?: string;
};

type KeyExchangeInitSignatureResult = {
  valid: boolean;
  keys: {
    signingPublicKey: string;
    offlinePublicKey: string;
    signature: string;
  };
};

type KeyExchangeHarness = {
  pendingAcceptances: Map<string, unknown>;
  acceptPendingContact(senderPeerId: string): void;
  authorizeContactRequest(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    initialMessageBody: string,
    onPendingCreated?: () => Promise<void>,
  ): Promise<UserRegistration | User | null>;
  verifySignatureWithFallback(
    signature: string,
    message: MessageToVerify,
    username: string,
    peerId: string,
  ): Promise<SignatureFallbackResult>;
  verifyKeyExchangeInitSignature(
    message: AuthenticatedEncryptedMessage,
    sender: UserRegistration | User,
    remoteId: string,
  ): Promise<KeyExchangeInitSignatureResult>;
  ensureUserExistsWithKeys(
    remoteId: string,
    username: string,
    signingPublicKey: string,
    offlinePublicKey: string,
    signature: string,
  ): Promise<void>;
  keyExchangeRecipientKeys: Map<string, { signingPublicKey: string; offlinePublicKey: string; signature: string }>;
  getKeyExchangeFollowupTimeoutMs(): number;
  verifyKeyExchangeResponseSignature(
    signature: string,
    messageToVerify: MessageToVerify,
    username: string,
    peerId: string,
  ): Promise<boolean>;
};

function makeKeyExchange(
  database: ChatDatabase,
  usernameRegistry: object,
  options: KeyExchangeTestOptions = {},
): KeyExchangeHarness {
  const noop = () => undefined;
  return new KeyExchange(
    (options.node ?? { getConnections: () => [] }) as unknown as ChatNode,
    usernameRegistry as unknown as UsernameRegistry,
    {} as unknown as SessionManager,
    database,
    noop,
    options.onContactRequestReceived ?? noop,
    noop,
    noop,
    noop,
    noop,
  ) as unknown as KeyExchangeHarness;
}

async function waitForPendingContact(keyExchange: KeyExchangeHarness, peerId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (keyExchange.pendingAcceptances.has(peerId)) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Pending contact request was not created');
}

test('authorizeContactRequest prompts and accepts using DHT-resolved username over claimed name', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const signing = makeSigningKeyPair();
  const resolved = makeRegistration({
    peerId: PEER_ID,
    username: 'bob',
    signingPublicKey: signing.publicKey,
    offlinePublicKey: 'bob_offline_key',
    signature: 'bob_registration_signature',
  });
  let prompt: ContactRequestEvent | undefined;
  const keyExchange = makeKeyExchange(
    database,
    { lookupByPeerId: async () => resolved },
    { onContactRequestReceived: (data) => { prompt = data; } },
  );

  const request = keyExchange.authorizeContactRequest(
    PEER_ID,
    makeContactRequestMessage('alice'),
    'hello from claimed alice',
  );
  await waitForPendingContact(keyExchange, PEER_ID);
  keyExchange.acceptPendingContact(PEER_ID);
  const sender = await request;

  assert.equal(prompt?.username, 'bob');
  assert.equal(prompt?.peerId, PEER_ID);
  assert.equal(sender.username, 'bob');
  assert.equal(sender.peerID, PEER_ID);
  assert.equal(sender.signingPublicKey, signing.publicKey);
});

test('authorizeContactRequest does not prompt unresolved peers under a claimed username', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  let prompted = false;
  const keyExchange = makeKeyExchange(
    database,
    { lookupByPeerId: async () => { throw new Error('not found'); } },
    { onContactRequestReceived: () => { prompted = true; } },
  );

  const sender = await keyExchange.authorizeContactRequest(
    PEER_ID,
    makeContactRequestMessage('alice'),
    'hello from claimed alice',
  );

  assert.equal(sender, null);
  assert.equal(prompted, false);
  assert.deepEqual(database.getContactAttemptsByPeerId(PEER_ID), []);
});

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

test('getKeyExchangeFollowupTimeoutMs returns mode defaults and honors clamped override', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const keyExchange = makeKeyExchange(database, {});

  // Default (fast mode for a fresh in-memory DB) must be large enough to cover a peer-side
  // verify + DHT round-trip — the too-tight 5000ms value was the root cause of the drop.
  assert.equal(keyExchange.getKeyExchangeFollowupTimeoutMs(), KEY_EXCHANGE_FOLLOWUP_TIMEOUT_FAST_MS);
  assert.ok(KEY_EXCHANGE_FOLLOWUP_TIMEOUT_FAST_MS >= 30_000);
  // Anonymous mode (fixed at DB construction) must allow at least as much time as fast mode.
  assert.ok(KEY_EXCHANGE_FOLLOWUP_TIMEOUT_ANONYMOUS_MS >= KEY_EXCHANGE_FOLLOWUP_TIMEOUT_FAST_MS);

  database.setSetting(KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY, '12000');
  assert.equal(keyExchange.getKeyExchangeFollowupTimeoutMs(), 12_000);

  database.setSetting(KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY, '1');
  assert.equal(keyExchange.getKeyExchangeFollowupTimeoutMs(), KEY_EXCHANGE_FOLLOWUP_TIMEOUT_MIN_MS);

  database.setSetting(KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY, '9999999');
  assert.equal(keyExchange.getKeyExchangeFollowupTimeoutMs(), KEY_EXCHANGE_FOLLOWUP_TIMEOUT_MAX_MS);

  database.setSetting(KEY_EXCHANGE_FOLLOWUP_TIMEOUT_SETTING_KEY, 'not-a-number');
  assert.equal(keyExchange.getKeyExchangeFollowupTimeoutMs(), KEY_EXCHANGE_FOLLOWUP_TIMEOUT_FAST_MS);
});

test('verifyKeyExchangeResponseSignature verifies against stashed key without any DHT lookup', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const responder = makeSigningKeyPair();
  const keyExchange = makeKeyExchange(database, {
    // Any DHT access here must be treated as a test failure: the whole point of the fix is to
    // keep the response-signature verification off the (slow) DHT critical path on first contact.
    lookup: async () => { throw new Error('DHT lookup must not be used on the confirm path'); },
    lookupByPeerId: async () => { throw new Error('DHT lookup must not be used on the confirm path'); },
  });

  keyExchange.keyExchangeRecipientKeys.set(PEER_ID, {
    signingPublicKey: responder.publicKey,
    offlinePublicKey: 'responder_offline_key',
    signature: 'responder_registration_signature',
  });

  const message = makeVerifyMessage('key_exchange_response');
  const signature = signPayload(responder.privateKey, message);

  const valid = await keyExchange.verifyKeyExchangeResponseSignature(signature, message, USERNAME, PEER_ID);
  assert.equal(valid, true);

  // The verified keys are persisted so the subsequent chat finalization pins them.
  const user = database.getUserByPeerId(PEER_ID);
  assert.equal(user?.signing_public_key, responder.publicKey);
  assert.equal(user?.offline_public_key, 'responder_offline_key');
});

test('verifyKeyExchangeResponseSignature falls back to DHT when the stashed key does not match', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const stashedWrong = makeSigningKeyPair();
  const actualSigner = makeSigningKeyPair();
  let dhtLookups = 0;
  const keyExchange = makeKeyExchange(database, {
    lookup: async () => {
      dhtLookups += 1;
      return makeRegistration({ signingPublicKey: actualSigner.publicKey });
    },
  });

  keyExchange.keyExchangeRecipientKeys.set(PEER_ID, {
    signingPublicKey: stashedWrong.publicKey,
    offlinePublicKey: 'responder_offline_key',
    signature: 'responder_registration_signature',
  });

  const message = makeVerifyMessage('key_exchange_response');
  const signature = signPayload(actualSigner.privateKey, message);

  const valid = await keyExchange.verifyKeyExchangeResponseSignature(signature, message, USERNAME, PEER_ID);
  assert.equal(valid, true);
  assert.equal(dhtLookups, 1);
});

test('verifyKeyExchangeResponseSignature ignores stash when a pinned key exists', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  const pinned = makeSigningKeyPair();
  const stashed = makeSigningKeyPair();
  await createPinnedUser(database, pinned.publicKey);

  const keyExchange = makeKeyExchange(database, {
    lookup: async () => makeRegistration({ signingPublicKey: pinned.publicKey }),
  });

  // A stash signed by a different key must NOT bypass the pinned-key path (key-change detection).
  keyExchange.keyExchangeRecipientKeys.set(PEER_ID, {
    signingPublicKey: stashed.publicKey,
    offlinePublicKey: 'responder_offline_key',
    signature: 'responder_registration_signature',
  });

  const message = makeVerifyMessage('key_exchange_response');
  const signatureFromStash = signPayload(stashed.privateKey, message);
  const validFromStash = await keyExchange.verifyKeyExchangeResponseSignature(signatureFromStash, message, USERNAME, PEER_ID);
  assert.equal(validFromStash, false);

  const signatureFromPinned = signPayload(pinned.privateKey, message);
  const validFromPinned = await keyExchange.verifyKeyExchangeResponseSignature(signatureFromPinned, message, USERNAME, PEER_ID);
  assert.equal(validFromPinned, true);
});
