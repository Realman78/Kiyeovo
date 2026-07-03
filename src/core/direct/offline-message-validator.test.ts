import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { MAX_MESSAGES_PER_STORE, MESSAGE_TTL, NETWORK_MODE_CONFIG } from '../constants.js';
import { toBase64Url } from '../utils/miscellaneous.js';
import {
  type OfflineMessageDHT,
  type OfflineMessageStoreDHT,
  type OfflineSignedPayload,
  type StoreSignedPayloadDHT,
  offlineMessageSelector,
  offlineMessageValidateUpdate,
  offlineMessageValidator,
} from './offline-message-validator.js';

const encoder = new TextEncoder();
const PRIVATE_KEY = new Uint8Array(32).fill(23);
const PUBLIC_KEY_BYTES = ed25519.getPublicKey(PRIVATE_KEY);
const BUCKET_KEY = NETWORK_MODE_CONFIG.fast.dhtNamespaces.offline
  + '/bucket-secret/'
  + toBase64Url(PUBLIC_KEY_BYTES);

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function sha256Base64(base64Value: string): string {
  return Buffer.from(sha256(Buffer.from(base64Value, 'base64'))).toString('base64');
}

function signPayload(payload: unknown): string {
  return base64(ed25519.sign(encoder.encode(JSON.stringify(payload)), PRIVATE_KEY));
}

function makeMessage(overrides: Partial<OfflineMessageDHT> & {
  signedBucketKey?: string;
} = {}): OfflineMessageDHT {
  const timestamp = overrides.timestamp ?? Date.now();
  const content = overrides.content ?? base64('encrypted-content');
  const encryptedSenderInfo = overrides.encrypted_sender_info ?? base64('encrypted-sender-info');
  const signedPayload: OfflineSignedPayload = overrides.signed_payload ?? {
    content_hash: sha256Base64(content),
    sender_info_hash: sha256Base64(encryptedSenderInfo),
    timestamp,
    bucket_key: overrides.signedBucketKey ?? BUCKET_KEY,
  };
  return {
    id: overrides.id ?? 'message-1',
    encrypted_sender_info: encryptedSenderInfo,
    content,
    signature: overrides.signature ?? signPayload(signedPayload),
    signed_payload: signedPayload,
    message_type: overrides.message_type ?? 'encrypted',
    timestamp,
    expires_at: overrides.expires_at ?? Date.now() + MESSAGE_TTL,
    ...(overrides.encrypted_aes_key === undefined ? {} : { encrypted_aes_key: overrides.encrypted_aes_key }),
    ...(overrides.aes_iv === undefined ? {} : { aes_iv: overrides.aes_iv }),
  };
}

function makeStore(overrides: Partial<OfflineMessageStoreDHT> & {
  messages?: OfflineMessageDHT[];
  signedBucketKey?: string;
} = {}): OfflineMessageStoreDHT {
  const messages = overrides.messages ?? [makeMessage()];
  const lastUpdated = overrides.last_updated ?? Date.now();
  const version = overrides.version ?? 1;
  const signedPayload: StoreSignedPayloadDHT = overrides.store_signed_payload ?? {
    message_ids: messages.map((message) => message.id),
    version,
    timestamp: lastUpdated,
    bucket_key: overrides.signedBucketKey ?? BUCKET_KEY,
  };
  return {
    messages,
    last_updated: lastUpdated,
    version,
    store_signature: overrides.store_signature ?? signPayload(signedPayload),
    store_signed_payload: signedPayload,
  };
}

function encodeStore(store: OfflineMessageStoreDHT): Uint8Array {
  return gzipSync(Buffer.from(JSON.stringify(store)));
}

async function withoutConsoleLog(fn: () => Promise<void>): Promise<void> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
}

test('offline DHT validator accepts a signed store bound to the bucket key', async () => {
  await offlineMessageValidator(encoder.encode(BUCKET_KEY), encodeStore(makeStore()));
});

test('offline DHT validator rejects bucket-binding and message-hash tampering', async () => {
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode(BUCKET_KEY),
        encodeStore(makeStore({ signedBucketKey: BUCKET_KEY + '-other' })),
      ),
      /Store bucket_key mismatch/,
    );
  });

  const validMessage = makeMessage();
  const tamperedMessage = {
    ...validMessage,
    content: base64('different encrypted content'),
  };
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode(BUCKET_KEY),
        encodeStore(makeStore({ messages: [tamperedMessage] })),
      ),
      /content_hash mismatch/,
    );
  });
});

test('offline DHT selector and validateUpdate prefer newest non-stale stores', async () => {
  const older = encodeStore(makeStore({ version: 1, last_updated: 1_000 }));
  const newerSameVersion = encodeStore(makeStore({ version: 1, last_updated: 2_000 }));
  const higherVersion = encodeStore(makeStore({ version: 2, last_updated: 1_500 }));

  assert.equal(
    offlineMessageSelector(encoder.encode(BUCKET_KEY), [older, higherVersion, newerSameVersion]),
    1,
  );

  await assert.rejects(
    () => offlineMessageValidateUpdate(encoder.encode(BUCKET_KEY), higherVersion, newerSameVersion),
    /stale record rejected/,
  );
  await assert.rejects(
    () => offlineMessageValidateUpdate(encoder.encode(BUCKET_KEY), newerSameVersion, older),
    /stale record rejected/,
  );
  await offlineMessageValidateUpdate(encoder.encode(BUCKET_KEY), older, newerSameVersion);
});

test('offline DHT validator rejects malformed stores, invalid key formats, and size limits', async () => {
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(encoder.encode(BUCKET_KEY), encoder.encode('not-gzip')),
      /Failed to decompress or parse DHT value/,
    );
  });

  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode('/wrong-offline/bucket-secret/' + toBase64Url(PUBLIC_KEY_BYTES)),
        encodeStore(makeStore()),
      ),
      /Invalid offline bucket key prefix/,
    );
  });

  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode(NETWORK_MODE_CONFIG.fast.dhtNamespaces.offline + '/bucket-secret'),
        encodeStore(makeStore()),
      ),
      /Invalid bucket key format/,
    );
  });

  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode(NETWORK_MODE_CONFIG.fast.dhtNamespaces.offline + '/bucket-secret/abc'),
        encodeStore(makeStore()),
      ),
      /Invalid sender public key length/,
    );
  });

  const tooManyMessages = Array.from(
    { length: MAX_MESSAGES_PER_STORE + 1 },
    (_, index) => makeMessage({ id: 'message-' + index }),
  );
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode(BUCKET_KEY),
        encodeStore(makeStore({ messages: tooManyMessages })),
      ),
      /Max messages reached/,
    );
  });
});

test('offline DHT validator rejects store-integrity tampering', async () => {
  const messageA = makeMessage({ id: 'message-a' });
  const messageB = makeMessage({ id: 'message-b' });
  const validStore = makeStore({ messages: [messageA, messageB], version: 3 });

  const reorderedIds = {
    ...validStore,
    store_signed_payload: {
      ...validStore.store_signed_payload,
      message_ids: ['message-b', 'message-a'],
    },
  };
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(encoder.encode(BUCKET_KEY), encodeStore(reorderedIds)),
      /Store message_ids mismatch/,
    );
  });

  const versionMismatch = { ...validStore, version: validStore.version + 1 };
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(encoder.encode(BUCKET_KEY), encodeStore(versionMismatch)),
      /Store version mismatch/,
    );
  });

  const timestampMismatch = { ...validStore, last_updated: validStore.last_updated + 1 };
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(encoder.encode(BUCKET_KEY), encodeStore(timestampMismatch)),
      /Store timestamp mismatch/,
    );
  });
});

test('offline DHT validator rejects replay-sensitive timestamp and expiry failures', async () => {
  const signedTimestamp = Date.now();
  const timestampMismatchPayload: OfflineSignedPayload = {
    content_hash: sha256Base64(base64('encrypted-content')),
    sender_info_hash: sha256Base64(base64('encrypted-sender-info')),
    timestamp: signedTimestamp,
    bucket_key: BUCKET_KEY,
  };
  const mismatchedTimestamp = makeMessage({
    timestamp: signedTimestamp + 1,
    signed_payload: timestampMismatchPayload,
  });
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(
        encoder.encode(BUCKET_KEY),
        encodeStore(makeStore({ messages: [mismatchedTimestamp] })),
      ),
      /timestamp mismatch with signed payload/,
    );
  });

  const expired = makeMessage({ expires_at: Date.now() - 1 });
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(encoder.encode(BUCKET_KEY), encodeStore(makeStore({ messages: [expired] }))),
      /has expired/,
    );
  });

  const tooOldTimestamp = Date.now() - MESSAGE_TTL - 1_000;
  const tooOld = makeMessage({
    timestamp: tooOldTimestamp,
    expires_at: Date.now() + MESSAGE_TTL,
  });
  await withoutConsoleLog(async () => {
    await assert.rejects(
      () => offlineMessageValidator(encoder.encode(BUCKET_KEY), encodeStore(makeStore({ messages: [tooOld] }))),
      /too old/,
    );
  });
});
