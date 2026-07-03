import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ed25519 } from '@noble/curves/ed25519';
import {
  GROUP_MAX_MESSAGES_PER_SENDER,
  GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
  NETWORK_MODE_CONFIG,
} from '../../constants.js';
import { toBase64Url } from '../../utils/miscellaneous.js';
import type {
  GroupContentMessage,
  GroupInfoLatest,
  GroupInfoVersioned,
  GroupOfflineStore,
} from '../types.js';
import {
  groupInfoLatestSelector,
  groupInfoLatestValidateUpdate,
  groupInfoLatestValidator,
  groupInfoVersionedSelector,
  groupInfoVersionedValidateUpdate,
  groupInfoVersionedValidator,
  groupOfflineMessageSelector,
  groupOfflineMessageValidator,
  groupOfflineValidateUpdate,
} from './group-dht-validator.js';

const encoder = new TextEncoder();
const SENDER_PRIVATE = new Uint8Array(32).fill(31);
const CREATOR_PRIVATE = new Uint8Array(32).fill(37);
const SENDER_PUBLIC_BYTES = ed25519.getPublicKey(SENDER_PRIVATE);
const CREATOR_PUBLIC_BYTES = ed25519.getPublicKey(CREATOR_PRIVATE);
const GROUP_ID = 'group-alpha';
const GROUP_OFFLINE_KEY = NETWORK_MODE_CONFIG.fast.dhtNamespaces.groupOffline
  + '/' + GROUP_ID
  + '/1/'
  + toBase64Url(SENDER_PUBLIC_BYTES);
const GROUP_INFO_LATEST_KEY = NETWORK_MODE_CONFIG.fast.dhtNamespaces.groupInfoLatest
  + '/' + GROUP_ID
  + '/' + toBase64Url(CREATOR_PUBLIC_BYTES);
const GROUP_INFO_VERSIONED_KEY = NETWORK_MODE_CONFIG.fast.dhtNamespaces.groupInfoVersion
  + '/' + GROUP_ID
  + '/' + toBase64Url(CREATOR_PUBLIC_BYTES)
  + '/1';

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function signJson(privateKey: Uint8Array, payload: unknown): string {
  return base64(ed25519.sign(encoder.encode(JSON.stringify(payload)), privateKey));
}

function makeGroupMessage(overrides: Partial<GroupContentMessage> = {}): GroupContentMessage {
  const unsigned = {
    type: 'GROUP_MESSAGE' as const,
    groupId: overrides.groupId ?? GROUP_ID,
    keyVersion: overrides.keyVersion ?? 1,
    senderPeerId: overrides.senderPeerId ?? 'sender-peer',
    messageId: overrides.messageId ?? 'group-message-1',
    seq: overrides.seq ?? 1,
    encryptedContent: overrides.encryptedContent ?? base64('encrypted group content'),
    nonce: overrides.nonce ?? base64('nonce'),
    timestamp: overrides.timestamp ?? Date.now(),
    messageType: overrides.messageType ?? 'text',
  };
  return {
    ...unsigned,
    signature: overrides.signature ?? signJson(SENDER_PRIVATE, unsigned),
  };
}

function makeGroupOfflineStore(overrides: Partial<GroupOfflineStore> & {
  messages?: GroupContentMessage[];
} = {}): GroupOfflineStore {
  const messages = overrides.messages ?? [makeGroupMessage()];
  const highestSeq = overrides.highestSeq ?? Math.max(...messages.map((message) => message.seq));
  const lastUpdated = overrides.lastUpdated ?? Date.now();
  const version = overrides.version ?? 1;
  const storeSignedPayload = overrides.storeSignedPayload ?? {
    messageIds: messages.map((message) => message.messageId),
    highestSeq,
    version,
    timestamp: lastUpdated,
    bucketKey: GROUP_OFFLINE_KEY,
  };
  return {
    messages,
    highestSeq,
    lastUpdated,
    version,
    storeSignature: overrides.storeSignature ?? signJson(SENDER_PRIVATE, storeSignedPayload),
    storeSignedPayload,
  };
}

function encodeGroupOfflineStore(store: GroupOfflineStore): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(store)));
}

function makeLatestRecord(overrides: Partial<GroupInfoLatest> = {}): GroupInfoLatest {
  const payload = {
    groupId: overrides.groupId ?? GROUP_ID,
    latestVersion: overrides.latestVersion ?? 1,
    latestStateHash: overrides.latestStateHash ?? 'state-hash-1',
    lastUpdated: overrides.lastUpdated ?? Date.now(),
  };
  return {
    ...payload,
    creatorSignature: overrides.creatorSignature ?? signJson(CREATOR_PRIVATE, payload),
  };
}

function makeVersionedRecord(overrides: Partial<GroupInfoVersioned> = {}): GroupInfoVersioned {
  const payload = {
    groupId: overrides.groupId ?? GROUP_ID,
    version: overrides.version ?? 1,
    prevVersionHash: overrides.prevVersionHash ?? '',
    encryptedMetadata: overrides.encryptedMetadata ?? base64('encrypted metadata'),
    encryptedMetadataNonce: overrides.encryptedMetadataNonce ?? base64(new Uint8Array(24).fill(5)),
    activatedAt: overrides.activatedAt ?? Date.now(),
    stateHash: overrides.stateHash ?? 'state-hash-1',
  };
  return {
    ...payload,
    creatorSignature: overrides.creatorSignature ?? signJson(CREATOR_PRIVATE, payload),
  };
}

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

test('group offline DHT validator accepts a signed store bound to the key path', async () => {
  await groupOfflineMessageValidator(
    encoder.encode(GROUP_OFFLINE_KEY),
    encodeGroupOfflineStore(makeGroupOfflineStore()),
  );
});

test('group offline DHT validator rejects path and signature mismatches', async () => {
  const validMessage = makeGroupMessage();
  const wrongGroupMessage = { ...validMessage, groupId: 'other-group' };
  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode(GROUP_OFFLINE_KEY),
      encodeGroupOfflineStore(makeGroupOfflineStore({ messages: [wrongGroupMessage] })),
    ),
    /groupId mismatch/,
  );

  const tamperedMessage = {
    ...validMessage,
    encryptedContent: base64('tampered content'),
  };
  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode(GROUP_OFFLINE_KEY),
      encodeGroupOfflineStore(makeGroupOfflineStore({ messages: [tamperedMessage] })),
    ),
    /signature verification failed/,
  );
});

test('group offline selector and validateUpdate prefer newest non-stale stores', async () => {
  const older = encodeGroupOfflineStore(makeGroupOfflineStore({ version: 1, lastUpdated: 1_000 }));
  const newerSameVersion = encodeGroupOfflineStore(makeGroupOfflineStore({ version: 1, lastUpdated: 2_000 }));
  const higherVersion = encodeGroupOfflineStore(makeGroupOfflineStore({ version: 2, lastUpdated: 1_500 }));
  const oversizedValue = new Uint8Array(GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES + 1);

  assert.equal(
    groupOfflineMessageSelector(encoder.encode(GROUP_OFFLINE_KEY), [older, higherVersion, newerSameVersion]),
    1,
  );
  assert.equal(
    groupOfflineMessageSelector(encoder.encode(GROUP_OFFLINE_KEY), [oversizedValue, higherVersion]),
    1,
  );

  await assert.rejects(
    () => groupOfflineValidateUpdate(encoder.encode(GROUP_OFFLINE_KEY), higherVersion, oversizedValue),
    /Group offline store too large/,
  );

  await assert.rejects(
    () => groupOfflineValidateUpdate(encoder.encode(GROUP_OFFLINE_KEY), higherVersion, newerSameVersion),
    /stale record rejected/,
  );
  await assert.rejects(
    () => groupOfflineValidateUpdate(encoder.encode(GROUP_OFFLINE_KEY), newerSameVersion, older),
    /stale record rejected/,
  );
  await groupOfflineValidateUpdate(encoder.encode(GROUP_OFFLINE_KEY), older, newerSameVersion);
});

test('group info latest validator enforces key binding and creator signature', async () => {
  const valid = makeLatestRecord();
  await groupInfoLatestValidator(encoder.encode(GROUP_INFO_LATEST_KEY), encodeJson(valid));

  const wrongGroup = makeLatestRecord({ groupId: 'other-group' });
  await assert.rejects(
    () => groupInfoLatestValidator(encoder.encode(GROUP_INFO_LATEST_KEY), encodeJson(wrongGroup)),
    /groupId mismatch/,
  );

  const tampered = { ...valid, latestStateHash: 'tampered-hash' };
  await assert.rejects(
    () => groupInfoLatestValidator(encoder.encode(GROUP_INFO_LATEST_KEY), encodeJson(tampered)),
    /Creator signature verification failed/,
  );
});

test('group info latest selector and validateUpdate reject stale or conflicting records', async () => {
  const versionOne = makeLatestRecord({ latestVersion: 1, latestStateHash: 'hash-1', lastUpdated: 1_000 });
  const versionTwo = makeLatestRecord({ latestVersion: 2, latestStateHash: 'hash-2', lastUpdated: 500 });
  const newerVersionOne = makeLatestRecord({ latestVersion: 1, latestStateHash: 'hash-1', lastUpdated: 2_000 });

  assert.equal(
    groupInfoLatestSelector(
      encoder.encode(GROUP_INFO_LATEST_KEY),
      [encodeJson(versionOne), encoder.encode('{bad-json'), encodeJson(versionTwo), encodeJson(newerVersionOne)],
    ),
    2,
  );

  await assert.rejects(
    () => groupInfoLatestValidateUpdate(
      encoder.encode(GROUP_INFO_LATEST_KEY),
      encodeJson(versionTwo),
      encodeJson(newerVersionOne),
    ),
    /stale record rejected/,
  );

  await assert.rejects(
    () => groupInfoLatestValidateUpdate(
      encoder.encode(GROUP_INFO_LATEST_KEY),
      encodeJson(versionTwo),
      encodeJson(makeLatestRecord({ latestVersion: 2, latestStateHash: 'different', lastUpdated: 3_000 })),
    ),
    /stale record rejected/,
  );

  await groupInfoLatestValidateUpdate(
    encoder.encode(GROUP_INFO_LATEST_KEY),
    encodeJson(versionOne),
    encodeJson(newerVersionOne),
  );
});

test('group info versioned validator enforces immutable version records', async () => {
  const valid = makeVersionedRecord();
  await groupInfoVersionedValidator(encoder.encode(GROUP_INFO_VERSIONED_KEY), encodeJson(valid));

  const invalidNonce = makeVersionedRecord({ encryptedMetadataNonce: base64(new Uint8Array(12).fill(1)) });
  await assert.rejects(
    () => groupInfoVersionedValidator(encoder.encode(GROUP_INFO_VERSIONED_KEY), encodeJson(invalidNonce)),
    /expected base64 24-byte nonce/,
  );

  const wrongVersion = makeVersionedRecord({ version: 2 });
  await assert.rejects(
    () => groupInfoVersionedValidator(encoder.encode(GROUP_INFO_VERSIONED_KEY), encodeJson(wrongVersion)),
    /Version mismatch/,
  );

  assert.equal(
    groupInfoVersionedSelector(
      encoder.encode(GROUP_INFO_VERSIONED_KEY),
      [encoder.encode('{bad-json'), encodeJson(valid)],
    ),
    1,
  );

  await groupInfoVersionedValidateUpdate(
    encoder.encode(GROUP_INFO_VERSIONED_KEY),
    encodeJson(valid),
    encodeJson(valid),
  );
  await assert.rejects(
    () => groupInfoVersionedValidateUpdate(
      encoder.encode(GROUP_INFO_VERSIONED_KEY),
      encodeJson(valid),
      encodeJson(makeVersionedRecord({ stateHash: 'different-state' })),
    ),
    /stale record rejected/,
  );
});

test('group offline DHT validator rejects malformed stores, invalid key formats, and size limits', async () => {
  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode(GROUP_OFFLINE_KEY),
      new Uint8Array(GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES + 1),
    ),
    /Group offline store too large/,
  );

  await assert.rejects(
    () => groupOfflineMessageValidator(encoder.encode(GROUP_OFFLINE_KEY), encoder.encode('not-gzip')),
    /incorrect header|unexpected end|invalid/i,
  );

  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode('/wrong-group-offline/' + GROUP_ID + '/1/' + toBase64Url(SENDER_PUBLIC_BYTES)),
      encodeGroupOfflineStore(makeGroupOfflineStore()),
    ),
    /Invalid group offline bucket key prefix/,
  );

  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode(NETWORK_MODE_CONFIG.fast.dhtNamespaces.groupOffline + '/' + GROUP_ID + '/1'),
      encodeGroupOfflineStore(makeGroupOfflineStore()),
    ),
    /Invalid group offline bucket key format/,
  );

  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode(NETWORK_MODE_CONFIG.fast.dhtNamespaces.groupOffline + '/' + GROUP_ID + '/1/abc'),
      encodeGroupOfflineStore(makeGroupOfflineStore()),
    ),
    /Invalid sender public key length/,
  );

  const tooManyMessages = Array.from(
    { length: GROUP_MAX_MESSAGES_PER_SENDER + 1 },
    (_, index) => makeGroupMessage({ messageId: 'group-message-' + index, seq: index + 1 }),
  );
  await assert.rejects(
    () => groupOfflineMessageValidator(
      encoder.encode(GROUP_OFFLINE_KEY),
      encodeGroupOfflineStore(makeGroupOfflineStore({ messages: tooManyMessages })),
    ),
    /Too many messages/,
  );
});

test('group offline DHT validator rejects store-integrity tampering', async () => {
  const messageA = makeGroupMessage({ messageId: 'group-message-a', seq: 1 });
  const messageB = makeGroupMessage({ messageId: 'group-message-b', seq: 2 });
  const validStore = makeGroupOfflineStore({ messages: [messageA, messageB], version: 3 });

  const reorderedIds = {
    ...validStore,
    storeSignedPayload: {
      ...validStore.storeSignedPayload,
      messageIds: ['group-message-b', 'group-message-a'],
    },
  };
  await assert.rejects(
    () => groupOfflineMessageValidator(encoder.encode(GROUP_OFFLINE_KEY), encodeGroupOfflineStore(reorderedIds)),
    /Store messageIds mismatch/,
  );

  const versionMismatch = { ...validStore, version: validStore.version + 1 };
  await assert.rejects(
    () => groupOfflineMessageValidator(encoder.encode(GROUP_OFFLINE_KEY), encodeGroupOfflineStore(versionMismatch)),
    /Store version mismatch/,
  );

  const timestampMismatch = { ...validStore, lastUpdated: validStore.lastUpdated + 1 };
  await assert.rejects(
    () => groupOfflineMessageValidator(encoder.encode(GROUP_OFFLINE_KEY), encodeGroupOfflineStore(timestampMismatch)),
    /Store timestamp mismatch/,
  );

  const highestSeqMismatch = { ...validStore, highestSeq: 1 };
  await assert.rejects(
    () => groupOfflineMessageValidator(encoder.encode(GROUP_OFFLINE_KEY), encodeGroupOfflineStore(highestSeqMismatch)),
    /less than max message seq/,
  );
});
