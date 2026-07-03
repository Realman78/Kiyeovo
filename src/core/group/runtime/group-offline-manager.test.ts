import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { ed25519 } from '@noble/curves/ed25519';
import { NETWORK_MODE_CONFIG } from '../../constants.js';
import { ChatDatabase } from '../../db/database.js';
import { encodeEnvelope } from '../../protocol/message-envelope.js';
import { toBase64Url } from '../../utils/miscellaneous.js';
import { GroupMessageType, type GroupContentMessage, type GroupOfflineStore } from '../types.js';
import type { ChatNode } from '../../types.js';
import type { EncryptedUserIdentity } from '../../identity/encrypted-user-identity.js';
import { GroupOfflineManager } from './group-offline-manager.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GROUP_ID = 'group_offline_gate';
const LOCAL_PEER_ID = 'local_peer';
const CREATOR_PEER_ID = 'creator_peer';
const REMOVED_PEER_ID = 'removed_peer';

const LOCAL_PRIVATE = new Uint8Array(32).fill(11);
const CREATOR_PRIVATE = new Uint8Array(32).fill(17);
const REMOVED_PRIVATE = new Uint8Array(32).fill(31);

const LOCAL_PUBLIC = ed25519.getPublicKey(LOCAL_PRIVATE);
const CREATOR_PUBLIC = ed25519.getPublicKey(CREATOR_PRIVATE);
const REMOVED_PUBLIC = ed25519.getPublicKey(REMOVED_PRIVATE);

const GROUP_KEY = new Uint8Array(32).fill(7);
const GROUP_KEY_BASE64 = Buffer.from(GROUP_KEY).toString('base64');
const METADATA_KEY_BASE64 = Buffer.from(new Uint8Array(32).fill(19)).toString('base64');

function base64(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function signJson(privateKey: Uint8Array, payload: unknown): string {
  return base64(ed25519.sign(encoder.encode(JSON.stringify(payload)), privateKey));
}

async function createUser(
  database: ChatDatabase,
  peerId: string,
  username: string,
  signingPublicKey: Uint8Array,
): Promise<void> {
  await database.createUser({
    peer_id: peerId,
    signing_public_key: base64(signingPublicKey),
    offline_public_key: base64(peerId + '_offline_key'),
    signature: peerId + '_signature',
    username,
  });
}

function encryptEnvelope(messageId: string, text: string, nonceSeed: number): { encryptedContent: string; nonce: string } {
  const nonce = new Uint8Array(24);
  nonce[0] = nonceSeed % 256;
  nonce[1] = Math.floor(nonceSeed / 256) % 256;
  const cipher = xchacha20poly1305(GROUP_KEY, nonce);
  const envelope = encodeEnvelope({ cid: messageId, text });
  return {
    encryptedContent: base64(cipher.encrypt(encoder.encode(envelope))),
    nonce: base64(nonce),
  };
}

function makeGroupMessage(input: {
  messageId: string;
  seq: number;
  timestamp: number;
  text: string;
  keyVersion?: number;
  senderPeerId?: string;
  senderPrivateKey?: Uint8Array;
}): GroupContentMessage {
  const keyVersion = input.keyVersion ?? 1;
  const senderPeerId = input.senderPeerId ?? REMOVED_PEER_ID;
  const { encryptedContent, nonce } = encryptEnvelope(input.messageId, input.text, input.seq + keyVersion * 1000);
  const unsigned = {
    type: GroupMessageType.GROUP_MESSAGE,
    groupId: GROUP_ID,
    keyVersion,
    senderPeerId,
    messageId: input.messageId,
    seq: input.seq,
    encryptedContent,
    nonce,
    timestamp: input.timestamp,
    messageType: 'text' as const,
  };
  return {
    ...unsigned,
    signature: signJson(input.senderPrivateKey ?? REMOVED_PRIVATE, unsigned),
  };
}

function bucketKeyForSender(groupId: string, keyVersion: number, senderPublicKey: Uint8Array): string {
  return NETWORK_MODE_CONFIG.fast.dhtNamespaces.groupOffline
    + '/' + groupId
    + '/' + String(keyVersion)
    + '/' + toBase64Url(senderPublicKey);
}

function makeStore(bucketKey: string, messages: GroupContentMessage[]): GroupOfflineStore {
  const highestSeq = Math.max(0, ...messages.map((message) => message.seq));
  const lastUpdated = Date.now();
  const version = 1;
  const storeSignedPayload = {
    messageIds: messages.map((message) => message.messageId),
    highestSeq,
    version,
    timestamp: lastUpdated,
    bucketKey,
  };
  return {
    messages,
    highestSeq,
    lastUpdated,
    version,
    storeSignature: signJson(REMOVED_PRIVATE, storeSignedPayload),
    storeSignedPayload,
  };
}

function makeNode(storesByKey: Map<string, GroupOfflineStore>): unknown {
  return {
    services: {
      dht: {
        get: async function* (keyBytes: Uint8Array) {
          const key = decoder.decode(keyBytes);
          const store = storesByKey.get(key);
          if (!store) return;
          yield {
            name: 'VALUE',
            value: gzipSync(Buffer.from(JSON.stringify(store), 'utf8')),
          };
        },
      },
    },
  };
}

async function createFixture(input: {
  messages: GroupContentMessage[];
  currentKeyVersion?: number;
  closedEpochUsedUntil?: number | null;
  highWater?: number;
  localBoundary?: number;
  participants?: string[];
}): Promise<{
  database: ChatDatabase;
  manager: GroupOfflineManager;
  chatId: number;
  received: unknown[];
}> {
  const currentKeyVersion = input.currentKeyVersion ?? 2;
  const database = new ChatDatabase(':memory:');
  await createUser(database, LOCAL_PEER_ID, 'local', LOCAL_PUBLIC);
  await createUser(database, CREATOR_PEER_ID, 'creator', CREATOR_PUBLIC);
  await createUser(database, REMOVED_PEER_ID, 'removed', REMOVED_PUBLIC);

  const chatId = await database.createChat({
    type: 'group',
    name: 'offline gate group',
    created_by: CREATOR_PEER_ID,
    offline_bucket_secret: 'group_bucket_secret',
    notifications_bucket_key: 'group_notifications_key',
    status: 'active',
    group_id: GROUP_ID,
    group_key: GROUP_KEY_BASE64,
    permanent_key: 'group_permanent_key',
    trusted_out_of_band: false,
    muted: false,
    key_version: currentKeyVersion,
    group_creator_peer_id: CREATOR_PEER_ID,
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    created_at: new Date(1_000),
    participants: input.participants ?? [LOCAL_PEER_ID, CREATOR_PEER_ID],
  });
  database.updateChatGroupStatus(chatId, 'active');
  database.updateChatKeyVersion(chatId, currentKeyVersion);

  database.insertGroupKeyHistory(GROUP_ID, 1, GROUP_KEY_BASE64, METADATA_KEY_BASE64);
  if (input.closedEpochUsedUntil !== undefined && input.closedEpochUsedUntil !== null) {
    database.markGroupKeyUsedUntil(GROUP_ID, 1, input.closedEpochUsedUntil);
  }
  if (currentKeyVersion >= 2) {
    database.insertGroupKeyHistory(GROUP_ID, 2, GROUP_KEY_BASE64, METADATA_KEY_BASE64);
  }
  if (input.highWater !== undefined) {
    database.updateMemberSeq(GROUP_ID, 1, REMOVED_PEER_ID, input.highWater);
  }
  if (input.localBoundary !== undefined) {
    database.upsertGroupEpochBoundaries(GROUP_ID, 1, { [REMOVED_PEER_ID]: input.localBoundary }, 'unit_test');
  }

  const storesByKey = new Map<string, GroupOfflineStore>();
  if (input.messages.length > 0) {
    const bucketKey = bucketKeyForSender(GROUP_ID, input.messages[0]?.keyVersion ?? 1, REMOVED_PUBLIC);
    storesByKey.set(bucketKey, makeStore(bucketKey, input.messages));
  }

  const received: unknown[] = [];
  const manager = new GroupOfflineManager({
    node: makeNode(storesByKey) as unknown as ChatNode,
    database,
    userIdentity: {
      signingPrivateKey: LOCAL_PRIVATE,
      signingPublicKey: LOCAL_PUBLIC,
    } as unknown as EncryptedUserIdentity,
    myPeerId: LOCAL_PEER_ID,
    onMessageReceived: (event) => received.push(event),
    onApplicationMessage: async () => false,
  });

  return { database, manager, chatId, received };
}

test('closed epoch with missing boundary defers seq beyond local high-water mark', async (t) => {
  const usedUntil = Date.now() - 1_000;
  const fixture = await createFixture({
    closedEpochUsedUntil: usedUntil,
    highWater: 2,
    messages: [makeGroupMessage({ messageId: 'msg_beyond_missing_boundary', seq: 3, timestamp: usedUntil + 100, text: 'late injection' })],
  });
  t.after(() => fixture.database.close());

  const result = await fixture.manager.checkGroupOfflineMessages([fixture.chatId]);

  assert.deepEqual(result.unreadFromChats.get(fixture.chatId), undefined);
  assert.equal(fixture.database.messageExistsInChat(fixture.chatId, 'msg_beyond_missing_boundary'), false);
  assert.equal(fixture.database.getMemberSeq(GROUP_ID, 1, REMOVED_PEER_ID), 2);
  assert.equal(fixture.received.length, 0);
});

test('closed epoch with authoritative boundary still rejects seq beyond sender boundary', async (t) => {
  const usedUntil = Date.now() - 1_000;
  const fixture = await createFixture({
    closedEpochUsedUntil: usedUntil,
    highWater: 10,
    localBoundary: 2,
    messages: [makeGroupMessage({ messageId: 'msg_beyond_authoritative_boundary', seq: 3, timestamp: usedUntil + 100, text: 'boundary violation' })],
  });
  t.after(() => fixture.database.close());

  await fixture.manager.checkGroupOfflineMessages([fixture.chatId]);

  assert.equal(fixture.database.messageExistsInChat(fixture.chatId, 'msg_beyond_authoritative_boundary'), false);
  assert.equal(fixture.database.getMemberSeq(GROUP_ID, 1, REMOVED_PEER_ID), 10);
  assert.equal(fixture.received.length, 0);
});

test('closed epoch with missing boundary still repairs backfill at or below local high-water mark', async (t) => {
  const usedUntil = Date.now() - 1_000;
  const fixture = await createFixture({
    closedEpochUsedUntil: usedUntil,
    highWater: 3,
    messages: [makeGroupMessage({ messageId: 'msg_backfill_known_seq', seq: 2, timestamp: usedUntil + 100, text: 'backfill text' })],
  });
  t.after(() => fixture.database.close());

  const result = await fixture.manager.checkGroupOfflineMessages([fixture.chatId]);
  const messages = fixture.database.getMessagesByChatId(fixture.chatId, 10);

  assert.equal(result.unreadFromChats.get(fixture.chatId), 1);
  assert.equal(fixture.database.messageExistsInChat(fixture.chatId, 'msg_backfill_known_seq'), true);
  assert.equal(messages.find((message) => message.id === 'msg_backfill_known_seq')?.content, 'backfill text');
  assert.equal(fixture.database.getMemberSeq(GROUP_ID, 1, REMOVED_PEER_ID), 3);
  assert.equal(fixture.received.length, 1);
});

test('live epoch without boundary remains uncapped by the closed-epoch ceiling', async (t) => {
  const now = Date.now();
  const fixture = await createFixture({
    currentKeyVersion: 1,
    closedEpochUsedUntil: null,
    highWater: 2,
    participants: [LOCAL_PEER_ID, CREATOR_PEER_ID, REMOVED_PEER_ID],
    messages: [makeGroupMessage({ messageId: 'msg_live_epoch_seq_advance', seq: 3, timestamp: now, text: 'live delivery', keyVersion: 1 })],
  });
  t.after(() => fixture.database.close());

  const result = await fixture.manager.checkGroupOfflineMessages([fixture.chatId]);
  const messages = fixture.database.getMessagesByChatId(fixture.chatId, 10);

  assert.equal(result.unreadFromChats.get(fixture.chatId), 1);
  assert.equal(fixture.database.messageExistsInChat(fixture.chatId, 'msg_live_epoch_seq_advance'), true);
  assert.equal(messages.find((message) => message.id === 'msg_live_epoch_seq_advance')?.content, 'live delivery');
  assert.equal(fixture.database.getMemberSeq(GROUP_ID, 1, REMOVED_PEER_ID), 3);
  assert.equal(fixture.received.length, 1);
});
