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

async function createOutgoingOfferDatabase(): Promise<{ database: ChatDatabase; chatId: number }> {
  const database = new ChatDatabase(':memory:');
  await database.createUser({
    peer_id: 'recipient_peer',
    signing_public_key: 'signing_key',
    offline_public_key: 'offline_key',
    signature: 'signature',
    username: 'recipient',
  });
  const chatId = await database.createChat({
    type: 'direct',
    name: 'recipient',
    created_by: 'recipient_peer',
    offline_bucket_secret: 'bucket_secret',
    notifications_bucket_key: 'notifications_key',
    status: 'active',
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    trusted_out_of_band: false,
    muted: false,
    key_version: 0,
    created_at: new Date(),
    participants: ['recipient_peer'],
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

test('pending file inbox snapshot mirrors capacity counting', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());

  await database.createMessage({
    id: 'incoming_counted',
    client_msg_id: 'incoming_counted',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'counted.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'counted.pdf',
    file_size: 10,
    file_offer_id: 'offer_counted',
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(1_000),
  });
  await database.createMessage({
    id: 'incoming_errored',
    client_msg_id: 'incoming_errored',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'errored.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'errored.pdf',
    file_size: 10,
    file_offer_id: 'offer_errored',
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    transfer_error: 'No longer available',
    timestamp: new Date(2_000),
  });

  const snapshot = database.getPendingFileInboxSnapshot({
    maxPendingFilesPerPeer: 1,
    maxPendingFilesTotal: 2,
  });

  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.full, false);
  assert.equal(snapshot.hasFullSender, true);
  assert.equal(snapshot.offers.length, 2);
  assert.equal(snapshot.senders.length, 1);
  assert.equal(snapshot.senders[0]?.count, 1);
  assert.equal(snapshot.senders[0]?.full, true);
  assert.equal(snapshot.senders[0]?.offers.length, 2);
  assert.equal(snapshot.offers.find((offer) => offer.fileId === 'incoming_errored')?.countsTowardCapacity, false);
});

test('cancels an active outgoing offer exactly once and resolves the target peer', async (t) => {
  const { database, chatId } = await createOutgoingOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'outgoing_file',
    client_msg_id: 'outgoing_file',
    chat_id: chatId,
    sender_peer_id: 'local_peer',
    content: 'report.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'report.pdf',
    file_size: 10,
    file_offer_id: 'offer_1',
    transfer_status: 'awaiting_acceptance',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.deepEqual(database.cancelOutgoingFileOffer({
    fileId: 'outgoing_file',
    localPeerId: 'local_peer',
  }), {
    offerId: 'offer_1',
    chatId,
    targetPeerId: 'recipient_peer',
    filename: 'report.pdf',
  });
  const row = database.getFileMessageById('outgoing_file');
  assert.equal(row?.transfer_status, 'cancelled');
  assert.equal(row?.transfer_error, 'Offer cancelled');
  assert.equal(database.cancelOutgoingFileOffer({
    fileId: 'outgoing_file',
    localPeerId: 'local_peer',
  }), null);
});

test('cancels a pending incoming offer by offer id exactly once', async (t) => {
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

  assert.deepEqual(database.cancelPendingIncomingFileOfferByOfferId({
    offerId: 'offer_1',
    chatId,
    senderPeerId: 'sender_peer',
  }), {
    messageId: 'incoming_file',
    filename: 'report.pdf',
  });
  const row = database.getFileMessageById('incoming_file');
  assert.equal(row?.transfer_status, 'cancelled');
  assert.equal(row?.transfer_error, 'Offer cancelled');
  assert.equal(database.cancelPendingIncomingFileOfferByOfferId({
    offerId: 'offer_1',
    chatId,
    senderPeerId: 'sender_peer',
  }), null);
});

test('file offer cancellation tombstones are scoped by offer and sender', async (t) => {
  const { database } = await createFileOfferDatabase();
  t.after(() => database.close());

  database.recordFileOfferCancellationTombstone({
    offerId: 'offer_1',
    senderPeerId: 'sender_peer',
  });

  assert.equal(database.hasFileOfferCancellationTombstone({
    offerId: 'offer_1',
    senderPeerId: 'sender_peer',
  }), true);
  assert.equal(database.hasFileOfferCancellationTombstone({
    offerId: 'offer_2',
    senderPeerId: 'sender_peer',
  }), false);
  assert.equal(database.hasFileOfferCancellationTombstone({
    offerId: 'offer_1',
    senderPeerId: 'other_peer',
  }), false);
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

test('recipient pull claim is single-flight and can reset to pending for retry', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'incoming_file',
    client_msg_id: 'incoming_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'incoming.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'incoming.pdf',
    file_size: 10,
    file_offer_id: 'incoming_offer',
    file_checksum: 'a'.repeat(64),
    file_total_chunks: 1,
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.deepEqual(database.claimIncomingFilePull('incoming_file'), {
    messageId: 'incoming_file',
    chatId,
    senderPeerId: 'sender_peer',
    offerId: 'incoming_offer',
    fileName: 'incoming.pdf',
    size: 10,
    checksum: 'a'.repeat(64),
    totalChunks: 1,
  });
  assert.equal(database.getFileMessageById('incoming_file')?.transfer_status, 'in_progress');
  assert.equal(database.claimIncomingFilePull('incoming_file'), null);

  assert.equal(database.updateIncomingFilePullProgress('incoming_file', 50), true);
  assert.equal(database.getFileMessageById('incoming_file')?.transfer_progress, 50);

  assert.equal(database.resetIncomingFilePullToPending('incoming_file', 'Sender offline'), true);
  const row = database.getFileMessageById('incoming_file');
  assert.equal(row?.transfer_status, 'incoming_pending_user');
  assert.equal(row?.transfer_progress, 0);
  assert.equal(row?.transfer_error, 'Sender offline');

  assert.notEqual(database.claimIncomingFilePull('incoming_file'), null);
});

test('recipient pull terminal transitions only apply while in progress', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'incoming_file',
    client_msg_id: 'incoming_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'incoming.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'incoming.pdf',
    file_size: 10,
    file_offer_id: 'incoming_offer',
    file_checksum: 'a'.repeat(64),
    file_total_chunks: 1,
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.equal(database.completeIncomingFilePull('incoming_file', '/tmp/incoming.pdf'), false);
  assert.notEqual(database.claimIncomingFilePull('incoming_file'), null);
  assert.equal(database.completeIncomingFilePull('incoming_file', '/tmp/incoming.pdf'), true);
  let row = database.getFileMessageById('incoming_file');
  assert.equal(row?.transfer_status, 'completed');
  assert.equal(row?.transfer_progress, 100);
  assert.equal(row?.file_path, '/tmp/incoming.pdf');
  assert.equal(database.failIncomingFilePull('incoming_file', 'late failure'), false);
  assert.equal(database.resetIncomingFilePullToPending('incoming_file', 'late retry'), false);
  assert.equal(database.cancelIncomingFilePull('incoming_file', 'Download canceled by user'), false);
  assert.equal(database.getFileMessageById('incoming_file')?.transfer_status, 'completed');

  await database.createMessage({
    id: 'incoming_rejected',
    client_msg_id: 'incoming_rejected',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'rejected.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'rejected.pdf',
    file_size: 10,
    file_offer_id: 'rejected_offer',
    file_checksum: 'b'.repeat(64),
    file_total_chunks: 1,
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });
  assert.notEqual(database.claimIncomingFilePull('incoming_rejected'), null);
  assert.equal(database.rejectPendingIncomingFileOffer('incoming_rejected'), null);
  assert.equal(database.failIncomingFilePull('incoming_rejected', 'integrity'), true);
  row = database.getFileMessageById('incoming_rejected');
  assert.equal(row?.transfer_status, 'failed');
  assert.equal(row?.transfer_error, 'integrity');
});

test('recipient cancel is guarded by the active in-progress state', async (t) => {
  const { database, chatId } = await createFileOfferDatabase();
  t.after(() => database.close());
  await database.createMessage({
    id: 'incoming_file',
    client_msg_id: 'incoming_file',
    chat_id: chatId,
    sender_peer_id: 'sender_peer',
    content: 'incoming.pdf (10 bytes)',
    message_type: 'file',
    file_name: 'incoming.pdf',
    file_size: 10,
    file_offer_id: 'incoming_offer',
    file_checksum: 'a'.repeat(64),
    file_total_chunks: 1,
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  assert.equal(database.cancelIncomingFilePull('incoming_file', 'Download canceled by user'), false);
  assert.equal(database.getFileMessageById('incoming_file')?.transfer_status, 'incoming_pending_user');

  assert.notEqual(database.claimIncomingFilePull('incoming_file'), null);
  assert.equal(database.cancelIncomingFilePull('incoming_file', 'Download canceled by user'), true);
  const row = database.getFileMessageById('incoming_file');
  assert.equal(row?.transfer_status, 'failed');
  assert.equal(row?.transfer_progress, 0);
  assert.equal(row?.transfer_error, 'Download canceled by user');
  assert.equal(database.completeIncomingFilePull('incoming_file', '/tmp/incoming.pdf'), false);
});
