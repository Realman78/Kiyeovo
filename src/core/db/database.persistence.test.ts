import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatDatabase, type Chat, type Message } from './database.js';
import type { NetworkMode, OfflineMessage } from '../types.js';

type PersistableMessage = Omit<Message, 'created_at'>;

async function createUser(database: ChatDatabase, peerId: string, username = peerId): Promise<void> {
  await database.createUser({
    peer_id: peerId,
    signing_public_key: peerId + '_signing_key',
    offline_public_key: peerId + '_offline_key',
    signature: peerId + '_signature',
    username,
  });
}

async function createDirectChat(database: ChatDatabase, peerId = 'sender_peer', username = 'sender'): Promise<number> {
  await createUser(database, peerId, username);
  return database.createChat({
    type: 'direct',
    name: username,
    created_by: peerId,
    offline_bucket_secret: peerId + '_bucket_secret',
    notifications_bucket_key: peerId + '_notifications_key',
    status: 'active',
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    trusted_out_of_band: false,
    muted: false,
    key_version: 0,
    created_at: new Date(1_000),
    participants: [peerId],
  });
}

async function createDirectDatabase(): Promise<{ database: ChatDatabase; chatId: number }> {
  const database = new ChatDatabase(':memory:');
  const chatId = await createDirectChat(database);
  return { database, chatId };
}

async function createGroupChat(database: ChatDatabase, groupId: string): Promise<number> {
  await createUser(database, 'local_peer', 'local');
  await createUser(database, 'sender_peer', 'sender');
  return database.createChat({
    type: 'group',
    name: groupId,
    created_by: 'local_peer',
    offline_bucket_secret: groupId + '_bucket_secret',
    notifications_bucket_key: groupId + '_notifications_key',
    status: 'active',
    group_id: groupId,
    group_key: Buffer.alloc(32, 1).toString('base64'),
    permanent_key: groupId + '_permanent_key',
    trusted_out_of_band: false,
    muted: false,
    key_version: 1,
    group_creator_peer_id: 'local_peer',
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    created_at: new Date(1_000),
    participants: ['local_peer', 'sender_peer'],
  });
}

test('countUsersByUsername reports duplicate contact names', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  await createUser(database, 'peer_a', 'parin');
  await createUser(database, 'peer_b', 'parin');
  await createUser(database, 'peer_c', 'other');

  assert.equal(database.countUsersByUsername('parin'), 2);
  assert.equal(database.countUsersByUsername('other'), 1);
  assert.equal(database.countUsersByUsername('missing'), 0);
});

test('createChat rolls back failed participant inserts and leaves connection reusable', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());

  await createUser(database, 'local_peer', 'local');

  const chatInput: Omit<Chat, 'id' | 'updated_at' | 'network_mode'> & { participants: string[] } = {
    type: 'direct',
    name: 'local',
    created_by: 'local_peer',
    offline_bucket_secret: 'failed_bucket_secret',
    notifications_bucket_key: 'failed_notifications_key',
    status: 'active',
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    trusted_out_of_band: false,
    muted: false,
    key_version: 0,
    created_at: new Date(1_000),
    participants: ['local_peer', 'local_peer'],
  };

  await assert.rejects(
    database.createChat(chatInput),
    /UNIQUE constraint failed: chat_participants.chat_id, chat_participants.peer_id/,
  );
  assert.deepEqual(database.getAllChats(), []);

  const chatId = await database.createChat({
    ...chatInput,
    participants: ['local_peer'],
  });

  assert.equal(typeof chatId, 'number');
  assert.equal(database.getAllChats().length, 1);
  assert.deepEqual(database.getChatParticipants(chatId).map((participant) => participant.peer_id), ['local_peer']);
});

function makeTextMessage(input: {
  id: string;
  chatId: number;
  clientMsgId?: string;
  senderPeerId?: string;
  content?: string;
  timestampMs?: number;
  localSendState?: PersistableMessage['local_send_state'];
  failedReason?: string | null;
  retryAfterTs?: number | null;
}): PersistableMessage {
  return {
    id: input.id,
    client_msg_id: input.clientMsgId ?? input.id,
    chat_id: input.chatId,
    sender_peer_id: input.senderPeerId ?? 'sender_peer',
    content: input.content ?? 'content:' + input.id,
    message_type: 'text',
    timestamp: new Date(input.timestampMs ?? 2_000),
    local_send_state: input.localSendState,
    failed_reason: input.failedReason,
    retry_after_ts: input.retryAfterTs,
  };
}

function getChat(database: ChatDatabase, chatId: number): Chat {
  const chat = database.getChats([chatId])[0];
  assert.ok(chat);
  return chat;
}

function getMessage(database: ChatDatabase, chatId: number, messageId: string): Message | undefined {
  return database.getMessagesByChatId(chatId).find((message) => message.id === messageId);
}

function tamperBackupCiphertext(artifact: string): string {
  const headerEnd = artifact.indexOf('\n');
  assert.notEqual(headerEnd, -1);
  const ciphertext = Buffer.from(artifact.slice(headerEnd + 1).trim(), 'base64');
  assert.ok(ciphertext.length > 16);
  const lastByteIndex = ciphertext.length - 1;
  ciphertext[lastByteIndex] = (ciphertext[lastByteIndex] ?? 0) ^ 0x01;
  return artifact.slice(0, headerEnd + 1) + ciphertext.toString('base64');
}

async function snapshotFile(filePath: string): Promise<{ size: number; bytes: Buffer }> {
  const [stats, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
  return { size: stats.size, bytes };
}

async function assertFileUnchanged(filePath: string, before: { size: number; bytes: Buffer }): Promise<void> {
  const after = await snapshotFile(filePath);
  assert.equal(after.size, before.size);
  assert.deepEqual(after.bytes, before.bytes);
}

function makePending(messageId: string, bucketKey: string): {
  peerId: string;
  bucketKey: string;
  content: string;
  createdAt: number;
} {
  return {
    peerId: 'sender_peer',
    bucketKey,
    content: 'encrypted:' + messageId,
    createdAt: 10_000,
  };
}

function makeOfflineMessage(input: {
  id: string;
  bucketKey: string;
  expiresAt: number;
  ackOnly?: boolean;
}): OfflineMessage {
  const signedPayload: OfflineMessage['signed_payload'] = {
    content_hash: 'content_hash:' + input.id,
    sender_info_hash: 'sender_hash:' + input.id,
    timestamp: 1_000,
    bucket_key: input.bucketKey,
    message_type: 'encrypted',
    expires_at: input.expiresAt,
  };
  if (input.ackOnly === true) {
    signedPayload.ack_only = true;
  }
  return {
    id: input.id,
    encrypted_sender_info: 'sender:' + input.id,
    content: 'content:' + input.id,
    signature: 'signature:' + input.id,
    signed_payload: signedPayload,
    message_type: 'encrypted',
    timestamp: 1_000,
    expires_at: input.expiresAt,
  };
}

async function withoutConsoleWarn<T>(fn: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

function withoutConsoleLog(fn: () => void): void {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
}

test('encrypted identity insert errors propagate to callers', () => {
  const database = new ChatDatabase(':memory:');
  try {
    withoutConsoleLog(() => {
      assert.throws(
        () => database.createEncryptedUserIdentityForMode(
          'invalid-mode' as NetworkMode,
          'primary',
          {
            peer_id: 'peer_identity_insert_failure',
            encrypted_data: Buffer.from('encrypted'),
            salt: Buffer.alloc(32),
            nonce: Buffer.alloc(12),
          },
        ),
        /constraint/i,
      );
    });

    assert.equal(database.getEncryptedUserIdentityForMode('fast', 'primary'), null);
  } finally {
    database.close();
  }
});

test('direct inbound tryCreateMessage deduplicates by chat client id without mutating chat state', async (t) => {
  const { database, chatId } = await createDirectDatabase();
  t.after(() => database.close());

  const first = makeTextMessage({
    id: 'direct_first',
    chatId,
    clientMsgId: 'shared_cid',
    timestampMs: 2_000,
  });
  assert.deepEqual(await database.tryCreateMessage(first), {
    id: 'direct_first',
    inserted: true,
  });
  assert.equal(getChat(database, chatId).updated_at.getTime(), 2_000);

  const duplicate = makeTextMessage({
    id: 'direct_duplicate',
    chatId,
    clientMsgId: 'shared_cid',
    timestampMs: 3_000,
  });
  assert.deepEqual(await database.tryCreateMessage(duplicate), {
    id: 'direct_duplicate',
    inserted: false,
  });

  assert.equal(database.messageExists('direct_duplicate'), false);
  assert.equal(database.getMessageCount(chatId), 1);
  assert.equal(getChat(database, chatId).updated_at.getTime(), 2_000);
  assert.equal(getMessage(database, chatId, 'direct_first')?.client_msg_id, 'shared_cid');

  await assert.rejects(
    database.createMessage(makeTextMessage({
      id: 'direct_authoritative_conflict',
      chatId,
      clientMsgId: 'shared_cid',
      timestampMs: 4_000,
    })),
  );
});

test('group inbound tryCreateMessage only accepts exact id chat client-id duplicates', async (t) => {
  const database = new ChatDatabase(':memory:');
  t.after(() => database.close());
  const chatId = await createGroupChat(database, 'group_dedupe');

  const first = makeTextMessage({
    id: 'group_message',
    chatId,
    clientMsgId: 'group_message',
    timestampMs: 2_000,
  });
  assert.deepEqual(await database.tryCreateMessage(first, { dedupe: 'any' }), {
    id: 'group_message',
    inserted: true,
  });

  assert.deepEqual(await database.tryCreateMessage(first, { dedupe: 'any' }), {
    id: 'group_message',
    inserted: false,
  });

  await assert.rejects(
    database.tryCreateMessage(makeTextMessage({
      id: 'group_message_other_id',
      chatId,
      clientMsgId: 'group_message',
      timestampMs: 3_000,
    }), { dedupe: 'any' }),
    /no exact-matching row/,
  );

  const otherChatId = await createGroupChat(database, 'group_dedupe_other');
  await assert.rejects(
    database.tryCreateMessage(makeTextMessage({
      id: 'group_message',
      chatId: otherChatId,
      clientMsgId: 'group_message',
      timestampMs: 4_000,
    }), { dedupe: 'any' }),
    /no exact-matching row/,
  );

  assert.equal(database.getMessageCount(chatId), 1);
  assert.equal(database.getMessageCount(otherChatId), 0);
});

test('pending offline send creation enforces bucket capacity atomically', async (t) => {
  const { database, chatId } = await createDirectDatabase();
  t.after(() => database.close());
  const bucketKey = 'capacity_bucket';

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'queued_one',
      chatId,
      localSendState: 'sending',
    }),
    makePending('queued_one', bucketKey),
    1,
  ), true);

  assert.equal(database.getPendingOfflineSend('queued_one')?.status, 'queued');
  assert.equal(database.messageExists('queued_one'), true);

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'blocked_by_queue',
      chatId,
      localSendState: 'sending',
    }),
    makePending('blocked_by_queue', bucketKey),
    1,
  ), false);
  assert.equal(database.messageExists('blocked_by_queue'), false);
  assert.equal(database.getPendingOfflineSend('blocked_by_queue'), null);

  database.settlePendingOfflineSendsFailed(['queued_one'], 'dht write failed');
  assert.equal(database.getPendingOfflineSend('queued_one')?.status, 'failed');

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'queued_after_failure',
      chatId,
      localSendState: 'sending',
    }),
    makePending('queued_after_failure', bucketKey),
    1,
  ), true);
  assert.equal(database.getPendingOfflineSend('queued_after_failure')?.status, 'queued');
  assert.equal(database.getMessageCount(chatId), 2);
});

test('pending offline send capacity counts live stored messages but skips ack-only and expired rows', async (t) => {
  const { database, chatId } = await createDirectDatabase();
  t.after(() => database.close());
  const bucketKey = 'stored_capacity_bucket';
  const now = Date.now();

  database.saveOfflineSentMessages(bucketKey, [
    makeOfflineMessage({
      id: 'stored_live',
      bucketKey,
      expiresAt: now + 60_000,
    }),
    makeOfflineMessage({
      id: 'stored_ack',
      bucketKey,
      expiresAt: now + 60_000,
      ackOnly: true,
    }),
    makeOfflineMessage({
      id: 'stored_expired',
      bucketKey,
      expiresAt: now - 60_000,
    }),
  ], 1);

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'blocked_by_stored_live',
      chatId,
      localSendState: 'sending',
    }),
    makePending('blocked_by_stored_live', bucketKey),
    1,
  ), false);
  assert.equal(database.messageExists('blocked_by_stored_live'), false);

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'allowed_with_only_one_live_stored',
      chatId,
      localSendState: 'sending',
    }),
    makePending('allowed_with_only_one_live_stored', bucketKey),
    2,
  ), true);
  assert.equal(database.getPendingOfflineSend('allowed_with_only_one_live_stored')?.status, 'queued');
});

test('pending offline send settlement and startup reconciliation keep message state in sync', async (t) => {
  const { database, chatId } = await createDirectDatabase();
  t.after(() => database.close());
  const bucketKey = 'settlement_bucket';

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'delivered_message',
      chatId,
      localSendState: 'sending',
      failedReason: 'other',
      retryAfterTs: 5_000,
    }),
    makePending('delivered_message', bucketKey),
    10,
  ), true);
  database.settlePendingOfflineSendsDelivered(['delivered_message']);
  assert.equal(database.getPendingOfflineSend('delivered_message'), null);
  assert.equal(getMessage(database, chatId, 'delivered_message')?.local_send_state, null);
  assert.equal(getMessage(database, chatId, 'delivered_message')?.failed_reason, null);
  assert.equal(getMessage(database, chatId, 'delivered_message')?.retry_after_ts, null);

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'failed_message',
      chatId,
      localSendState: 'sending',
    }),
    makePending('failed_message', bucketKey),
    10,
  ), true);
  database.settlePendingOfflineSendsFailed(['failed_message'], 'write failed');
  const failedPending = database.getPendingOfflineSend('failed_message');
  assert.equal(failedPending?.status, 'failed');
  assert.equal(failedPending?.attempts, 1);
  assert.equal(failedPending?.last_error, 'write failed');
  assert.equal(getMessage(database, chatId, 'failed_message')?.local_send_state, 'failed');
  assert.equal(getMessage(database, chatId, 'failed_message')?.failed_reason, 'other');

  database.requeuePendingOfflineSend('failed_message');
  assert.equal(database.getPendingOfflineSend('failed_message')?.status, 'queued');

  database.reconcileInterruptedOfflineSends();
  assert.equal(database.getPendingOfflineSend('failed_message')?.status, 'failed');
  assert.equal(getMessage(database, chatId, 'failed_message')?.local_send_state, 'failed');
  assert.equal(getMessage(database, chatId, 'delivered_message')?.local_send_state, null);

  database.settlePendingOfflineSendsFailed(['delivered_message'], 'late failure');
  assert.equal(getMessage(database, chatId, 'delivered_message')?.local_send_state, null);

  database.settlePendingOfflineSendsDelivered(['failed_message']);
  assert.equal(database.getPendingOfflineSend('failed_message')?.status, 'failed');
  assert.equal(database.getPendingOfflineSend('failed_message')?.attempts, 1);
  assert.equal(getMessage(database, chatId, 'failed_message')?.local_send_state, 'failed');
});

test('file-backed database persists pending sends and group state across reopen', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-db-reopen-test-'));
  const dbFile = join(dir, 'kiyeovo.sqlite');
  let cleanupDatabase: ChatDatabase | null = null;
  t.after(async () => {
    cleanupDatabase?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const initial = new ChatDatabase(dbFile);
  cleanupDatabase = initial;
  const chatId = await createDirectChat(initial);
  const bucketKey = 'reopen_bucket';

  assert.equal(initial.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'reopen_message',
      chatId,
      localSendState: 'sending',
    }),
    makePending('reopen_message', bucketKey),
    10,
  ), true);
  initial.saveOfflineSentMessages(bucketKey, [
    makeOfflineMessage({
      id: 'reopen_stored',
      bucketKey,
      expiresAt: Date.now() + 60_000,
    }),
  ], 3);
  initial.insertGroupKeyHistory('reopen_group', 1, 'reopen_encrypted_key', 'reopen_metadata_key');
  initial.upsertGroupOfflineCursor('reopen_group', 1, 'sender_peer', 123, 'group_message_1');
  assert.equal(initial.getNextSeqAndIncrement('reopen_group', 1), 1);
  initial.updateMemberSeq('reopen_group', 1, 'sender_peer', 8);

  initial.close();
  cleanupDatabase = null;

  const reopened = new ChatDatabase(dbFile);
  cleanupDatabase = reopened;

  assert.equal(reopened.getMessageCount(chatId), 1);
  assert.equal(reopened.getPendingOfflineSend('reopen_message')?.status, 'queued');
  assert.equal(getMessage(reopened, chatId, 'reopen_message')?.local_send_state, 'sending');
  assert.equal(reopened.getOfflineSentMessages(bucketKey).version, 3);
  assert.equal(reopened.getGroupKeyForEpoch('reopen_group', 1), 'reopen_encrypted_key');
  assert.equal(reopened.getGroupOfflineCursor('reopen_group', 1, 'sender_peer')?.last_read_message_id, 'group_message_1');
  assert.equal(reopened.getCurrentSeq('reopen_group', 1), 1);
  assert.equal(reopened.getMemberSeq('reopen_group', 1, 'sender_peer'), 8);

  reopened.reconcileInterruptedOfflineSends();
  assert.equal(reopened.getPendingOfflineSend('reopen_message')?.status, 'failed');
  assert.equal(getMessage(reopened, chatId, 'reopen_message')?.local_send_state, 'failed');
});

test('wipeDatabase removes local app data and leaves the schema reusable', async (t) => {
  const { database, chatId } = await createDirectDatabase();
  t.after(() => database.close());
  const bucketKey = 'wipe_bucket';

  assert.equal(database.createMessageWithPendingOfflineSend(
    makeTextMessage({
      id: 'wipe_message',
      chatId,
      localSendState: 'sending',
    }),
    makePending('wipe_message', bucketKey),
    10,
  ), true);
  database.saveOfflineSentMessages(bucketKey, [
    makeOfflineMessage({
      id: 'wipe_stored',
      bucketKey,
      expiresAt: Date.now() + 60_000,
    }),
  ], 1);
  database.syncOfflineSentMessageCategories(bucketKey, [{ messageId: 'wipe_stored', category: 'regular' }]);
  database.insertGroupKeyHistory('wipe_group', 1, 'wipe_encrypted_key', 'wipe_metadata_key');
  database.upsertGroupOfflineCursor('wipe_group', 1, 'sender_peer', 123, 'wipe_group_message');
  database.upsertPendingGroupOfflineBackup({
    messageId: 'wipe_message',
    chatId,
    groupId: 'wipe_group',
    payload: 'wipe_payload',
  });
  database.createNotification({
    id: 'wipe_notification',
    notification_type: 'group_invitation',
    notification_data: '{}',
    bucket_key: 'wipe_notification_bucket',
    status: 'pending',
  });

  await withoutConsoleWarn(() => database.wipeDatabase());

  assert.equal(database.getAllUsers().length, 0);
  assert.equal(database.getAllChats().length, 0);
  assert.equal(database.messageExists('wipe_message'), false);
  assert.equal(database.getPendingOfflineSend('wipe_message'), null);
  assert.deepEqual(database.getOfflineSentMessages(bucketKey), { messages: [], version: 0 });
  assert.deepEqual(database.getOfflineSentMessageCategories(bucketKey), []);
  assert.deepEqual(database.getGroupKeyHistory('wipe_group'), []);
  assert.equal(database.getGroupOfflineCursor('wipe_group', 1, 'sender_peer'), null);
  assert.deepEqual(database.getAllPendingGroupOfflineBackups(), []);
  assert.equal(database.getNotificationById('wipe_notification'), null);

  const newChatId = await createDirectChat(database, 'new_peer', 'new');
  await database.createMessage(makeTextMessage({
    id: 'new_message_after_wipe',
    chatId: newChatId,
    senderPeerId: 'new_peer',
  }));
  assert.equal(database.getMessageCount(newChatId), 1);
});

test('group key history updates state and deletes epoch-scoped key metadata together', () => {
  const database = new ChatDatabase(':memory:');
  try {
    database.insertGroupKeyHistory('group_keys', 1, 'encrypted_key_v1', 'metadata_key_v1');
    database.insertGroupKeyHistory('group_keys', 2, 'encrypted_key_v2', 'metadata_key_v2');
    database.updateGroupKeyStateHash('group_keys', 1, 'state_hash_v1');
    database.markGroupKeyUsedUntil('group_keys', 1, 42);
    database.upsertGroupEpochBoundary('group_keys', 1, 'sender_peer', 7);
    database.upsertGroupEpochBoundary('group_keys', 2, 'sender_peer', 9);

    assert.equal(database.getGroupKeyForEpoch('group_keys', 1), 'encrypted_key_v1');
    assert.equal(database.getGroupInfoMetadataKeyForEpoch('group_keys', 1), 'metadata_key_v1');
    assert.equal(database.getGroupKeyStateHash('group_keys', 1), 'state_hash_v1');
    assert.equal(database.getGroupKeyHistory('group_keys').find((row) => row.key_version === 1)?.used_until, 42);

    database.deleteGroupKeyHistoryForEpoch('group_keys', 1);

    assert.equal(database.getGroupKeyForEpoch('group_keys', 1), null);
    assert.deepEqual(database.getGroupEpochBoundaries('group_keys', 1), {});
    assert.equal(database.getGroupKeyForEpoch('group_keys', 2), 'encrypted_key_v2');
    assert.deepEqual(database.getGroupEpochBoundaries('group_keys', 2), {
      sender_peer: 9,
    });
  } finally {
    database.close();
  }
});

test('group offline cursors are scoped by group, key version, and sender', () => {
  const database = new ChatDatabase(':memory:');
  try {
    database.upsertGroupOfflineCursor('group_cursors', 1, 'sender_a', 100, 'message_a1');
    database.upsertGroupOfflineCursor('group_cursors', 1, 'sender_a', 200, 'message_a2');
    database.upsertGroupOfflineCursor('group_cursors', 1, 'sender_b', 150, 'message_b1');
    database.upsertGroupOfflineCursor('group_cursors', 2, 'sender_a', 300, 'message_a3');
    database.upsertGroupOfflineCursor('other_group', 1, 'sender_a', 400, 'message_other');

    const senderCursor = database.getGroupOfflineCursor('group_cursors', 1, 'sender_a');
    assert.ok(senderCursor);
    assert.equal(senderCursor.last_read_timestamp, 200);
    assert.equal(senderCursor.last_read_message_id, 'message_a2');
    assert.equal(database.getGroupOfflineCursors('group_cursors', 1).length, 2);
    assert.equal(database.getGroupOfflineCursors('group_cursors').length, 3);

    database.deleteGroupOfflineCursorsForEpoch('group_cursors', 1);

    assert.equal(database.getGroupOfflineCursor('group_cursors', 1, 'sender_a'), null);
    assert.equal(database.getGroupOfflineCursors('group_cursors', 1).length, 0);
    assert.equal(database.getGroupOfflineCursor('group_cursors', 2, 'sender_a')?.last_read_message_id, 'message_a3');
    assert.equal(database.getGroupOfflineCursor('other_group', 1, 'sender_a')?.last_read_message_id, 'message_other');
  } finally {
    database.close();
  }
});

test('group sender and member sequences are monotonic and epoch scoped', () => {
  const database = new ChatDatabase(':memory:');
  try {
    assert.equal(database.getCurrentSeq('group_seq', 1), 0);
    assert.equal(database.getNextSeqAndIncrement('group_seq', 1), 1);
    assert.equal(database.getNextSeqAndIncrement('group_seq', 1), 2);
    assert.equal(database.getCurrentSeq('group_seq', 1), 2);
    assert.equal(database.getNextSeqAndIncrement('group_seq', 2), 1);
    assert.equal(database.getNextSeqAndIncrement('other_group_seq', 1), 1);

    database.updateMemberSeq('group_seq', 1, 'sender_a', 5);
    database.updateMemberSeq('group_seq', 1, 'sender_a', 3);
    database.updateMemberSeq('group_seq', 1, 'sender_b', 4);
    database.updateMemberSeq('group_seq', 2, 'sender_a', 1);

    assert.equal(database.getMemberSeq('group_seq', 1, 'sender_a'), 5);
    assert.deepEqual(database.getAllMemberSeqs('group_seq', 1), {
      sender_a: 5,
      sender_b: 4,
    });

    database.deleteGroupSenderSeqForEpoch('group_seq', 1);
    database.deleteGroupMemberSeqsForEpoch('group_seq', 1);

    assert.equal(database.getCurrentSeq('group_seq', 1), 0);
    assert.equal(database.getCurrentSeq('group_seq', 2), 1);
    assert.equal(database.getMemberSeq('group_seq', 1, 'sender_a'), 0);
    assert.equal(database.getMemberSeq('group_seq', 2, 'sender_a'), 1);
  } finally {
    database.close();
  }
});

test('recordKeyChangeEvent and getKeyChangeEvents round-trip audit rows', () => {
  const database = new ChatDatabase(':memory:');
  try {
    database.recordKeyChangeEvent({
      peer_id: 'peer_key_change',
      username: 'alice',
      old_signing_key: 'old_signing_key',
      new_signing_key: 'new_signing_key',
      source: 'unit_test',
    });

    const events = database.getKeyChangeEvents('peer_key_change');

    assert.equal(events.length, 1);
    assert.equal(events[0]?.network_mode, 'fast');
    assert.equal(events[0]?.peer_id, 'peer_key_change');
    assert.equal(events[0]?.username, 'alice');
    assert.equal(events[0]?.old_signing_key, 'old_signing_key');
    assert.equal(events[0]?.new_signing_key, 'new_signing_key');
    assert.equal(events[0]?.source, 'unit_test');
    assert.ok(events[0]?.created_at instanceof Date);
    assert.deepEqual(database.getKeyChangeEvents('other_peer'), []);
  } finally {
    database.close();
  }
});

test('encrypted database backup hides plaintext, rejects invalid passwords and tampering, and round-trips rows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-db-encrypted-backup-test-'));
  const sourcePath = join(dir, 'source.db');
  const targetPath = join(dir, 'target.db');
  const backupPath = join(dir, 'backup.kiyeovo-db-backup');
  const tamperedPath = join(dir, 'tampered.kiyeovo-db-backup');
  const backupPassword = 'Correct backup password 0013!';
  const secretContent = 'ticket-0013 secret message plaintext marker';
  const originalContent = 'target database original message';
  let source: ChatDatabase | null = null;
  let target: ChatDatabase | null = null;

  t.after(async () => {
    source?.close();
    target?.close();
    await rm(dir, { recursive: true, force: true });
  });

  source = new ChatDatabase(sourcePath);
  const sourceChatId = await createDirectChat(source, 'source_peer', 'source');
  await source.createMessage(makeTextMessage({
    id: 'source_secret_message',
    chatId: sourceChatId,
    senderPeerId: 'source_peer',
    content: secretContent,
  }));
  await source.backupEncrypted(backupPath, backupPassword);

  const backupText = await readFile(backupPath, 'utf8');
  assert.equal(backupText.includes(secretContent), false);
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600);

  target = new ChatDatabase(targetPath);
  const targetChatId = await createDirectChat(target, 'target_peer', 'target');
  await target.createMessage(makeTextMessage({
    id: 'target_original_message',
    chatId: targetChatId,
    senderPeerId: 'target_peer',
    content: originalContent,
  }));

  await assert.rejects(
    target.restoreEncrypted(backupPath, 'wrong backup password'),
    /incorrect password|corrupted|decrypt/i,
  );
  assert.equal(getMessage(target, targetChatId, 'target_original_message')?.content, originalContent);

  await writeFile(tamperedPath, tamperBackupCiphertext(backupText));
  await assert.rejects(
    target.restoreEncrypted(tamperedPath, backupPassword),
    /incorrect password|corrupted|decrypt/i,
  );
  assert.equal(getMessage(target, targetChatId, 'target_original_message')?.content, originalContent);

  await target.restoreEncrypted(backupPath, backupPassword);
  assert.equal(getMessage(target, sourceChatId, 'source_secret_message')?.content, secretContent);
  assert.equal(target.getMessageCount(sourceChatId), 1);
});

test('encrypted backup creation rejects weak passwords but restore does not gate on strength', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-db-weak-password-test-'));
  const dbPath = join(dir, 'chat.db');
  const backupPath = join(dir, 'backup.kiyeovo-db-backup');
  let database: ChatDatabase | null = null;

  t.after(async () => {
    database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  database = new ChatDatabase(dbPath);
  await createDirectChat(database, 'weakpw_peer', 'weakpw');

  // Too short, and missing character classes: both rejected before any file is written.
  await assert.rejects(database.backupEncrypted(backupPath, 'short1!A'), /at least 12 characters/);
  await assert.rejects(database.backupEncrypted(backupPath, 'alllowercaseletters'), /lowercase, uppercase/);
  await assert.rejects(stat(backupPath), /ENOENT/); // rejected before any artifact is written

  // A policy-compliant password creates a backup that round-trips; restore accepts it
  // without re-checking policy (the GCM tag is the real gate).
  const strongPassword = 'Strong backup pw 1!';
  await database.backupEncrypted(backupPath, strongPassword);
  await database.restoreEncrypted(backupPath, strongPassword);
});

test('malformed encrypted restore is rejected before pre-login path touches database sidecars', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kiyeovo-db-malformed-restore-test-'));
  const dbPath = join(dir, 'chat.db');
  const malformedPath = join(dir, 'malformed.kiyeovo-db-backup');
  const originalContent = 'pre-login original message';
  let database: ChatDatabase | null = null;

  t.after(async () => {
    database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  database = new ChatDatabase(dbPath);
  const chatId = await createDirectChat(database, 'prelogin_peer', 'prelogin');
  await database.createMessage(makeTextMessage({
    id: 'prelogin_original_message',
    chatId,
    senderPeerId: 'prelogin_peer',
    content: originalContent,
  }));

  const dbBefore = await snapshotFile(dbPath);
  const walBefore = await snapshotFile(`${dbPath}-wal`);
  const shmBefore = await snapshotFile(`${dbPath}-shm`);
  await writeFile(malformedPath, 'not a Kiyeovo encrypted database backup');

  await assert.rejects(
    ChatDatabase.restoreEncryptedAtPath(dbPath, malformedPath, 'backup password'),
    /Invalid database backup/i,
  );

  await assertFileUnchanged(dbPath, dbBefore);
  await assertFileUnchanged(`${dbPath}-wal`, walBefore);
  await assertFileUnchanged(`${dbPath}-shm`, shmBefore);
  assert.equal(getMessage(database, chatId, 'prelogin_original_message')?.content, originalContent);
});
