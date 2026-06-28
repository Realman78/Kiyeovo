import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatDatabase } from './database.js';

async function createFileOfferDatabase(): Promise<{ database: ChatDatabase; chatId: number }> {
  const database = new ChatDatabase(':memory:');
  await database.createUser({
    peer_id: 'sender_peer',
    signing_public_key: 'signing_key',
    offline_public_key: 'offline_key',
    signature: 'signature',
    username: 'sender',
  });
  const chatId = await database.createChat({
    type: 'direct',
    name: 'sender',
    created_by: 'sender_peer',
    offline_bucket_secret: 'bucket_secret',
    notifications_bucket_key: 'notifications_key',
    status: 'active',
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    trusted_out_of_band: false,
    muted: false,
    key_version: 0,
    created_at: new Date(),
    participants: ['sender_peer'],
  });
  return { database, chatId };
}

test('rejects a persisted pending incoming offer exactly once', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'incoming_file',
    client_msg_id: 'incoming_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'report.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'report.pdf',
    file_size: 10,
    file_offer_id: 'offer_1',
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.deepEqual(database.rejectPendingIncomingFileOffer('incoming_file'), {
    messageId: 'incoming_file',
    offerId: 'offer_1',
    chatId,
    senderPeerId: 'sender_peer',
  });
  assert.equal(database.getFileMessageById('incoming_file')?.transfer_status, 'rejected');
  assert.equal(database.rejectPendingIncomingFileOffer('incoming_file'), null);
});

test('applies a NACK only to the matching active outgoing offer', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'outgoing_file',
    client_msg_id: 'outgoing_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'report.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'report.pdf',
    file_offer_id: 'offer_1',
    transfer_status: 'awaiting_acceptance',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.equal(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'unknown_offer',
    chatId,
    localPeerId: 'sender_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), null);
  assert.equal(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'offer_1',
    chatId: chatId + 1,
    localPeerId: 'sender_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), null);
  assert.equal(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'offer_1',
    chatId,
    localPeerId: 'different_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), null);
  assert.deepEqual(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'offer_1',
    chatId,
    localPeerId: 'sender_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), {
    messageId: 'outgoing_file',
    filename: 'report.pdf',
  });
  assert.equal(database.getFileMessageById('outgoing_file')?.transfer_status, 'rejected');
  assert.equal(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'offer_1',
    chatId,
    localPeerId: 'sender_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), null);
});

test('a prior NACK wins over a later serve completion or source-change (CAS, first terminal wins)', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'outgoing_file',
    client_msg_id: 'outgoing_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'report.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'report.pdf',
    file_offer_id: 'offer_1',
    transfer_status: 'awaiting_acceptance',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  // A signed NACK lands first and moves the row to a terminal 'rejected'.
  assert.deepEqual(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'offer_1',
    chatId,
    localPeerId: 'sender_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), { messageId: 'outgoing_file', filename: 'report.pdf' });

  // A later (lost-confirm racing) serve completion must NOT overwrite the decline.
  assert.equal(database.terminalizeServedFileIfActive('outgoing_file', 'completed', 100, null), false);
  // …nor a later source-change failure.
  assert.equal(database.terminalizeServedFileIfActive('outgoing_file', 'failed', 0, 'File no longer available'), false);
  assert.equal(database.getFileMessageById('outgoing_file')?.transfer_status, 'rejected');
});

test('serve completion wins when no terminal state preceded it, and a late NACK then no-ops', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'outgoing_file',
    client_msg_id: 'outgoing_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'report.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'report.pdf',
    file_offer_id: 'offer_1',
    transfer_status: 'awaiting_acceptance',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  // Completion lands first on the still-active row.
  assert.equal(database.terminalizeServedFileIfActive('outgoing_file', 'completed', 100, null), true);
  assert.equal(database.getFileMessageById('outgoing_file')?.transfer_status, 'completed');
  // A second CAS (e.g. duplicate confirm) is a no-op.
  assert.equal(database.terminalizeServedFileIfActive('outgoing_file', 'completed', 100, null), false);
  // A NACK arriving after completion cannot revert it (its own active-state guard fails).
  assert.equal(database.terminalizeOutgoingFileOfferFromNack({
    offerId: 'offer_1',
    chatId,
    localPeerId: 'sender_peer',
    status: 'rejected',
    error: 'Recipient declined',
  }), null);
  assert.equal(database.getFileMessageById('outgoing_file')?.transfer_status, 'completed');
});

test('startup reconciliation fails sender authority but preserves recipient offers', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'incoming_file',
    client_msg_id: 'incoming_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'incoming.pdf (10 bytes)',
    message_type: 'file',
    file_offer_id: 'incoming_offer',
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });
  await database.createMessage({
    id: 'outgoing_file',
    client_msg_id: 'outgoing_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'outgoing.pdf (10 bytes)',
    message_type: 'file',
    file_offer_id: 'outgoing_offer',
    transfer_status: 'awaiting_acceptance',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.equal(database.failNonTerminalFileTransfers('restart'), 1);
  assert.equal(database.getFileMessageById('incoming_file')?.transfer_status, 'incoming_pending_user');
  assert.equal(database.getFileMessageById('outgoing_file')?.transfer_status, 'failed');
});
