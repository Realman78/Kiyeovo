import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { ChatDatabase } from '../db/database.js';
import { FileHandler } from './file-handler.js';
import {
  createFileOfferCancelSignaturePayload,
  createFileOfferNackSignaturePayload,
} from '../protocol/file-offer-control.js';
import { createFileOfferSignaturePayload } from '../protocol/file-offer-validation.js';
import type { ChatNode } from '../types.js';
import type { MessageHandler } from './message-handler.js';
import type { InboundApplicationMessageContext } from '../protocol/application-message.js';

const LOCAL_PEER = 'local_peer';
const RECIPIENT_PEER = 'recipient_peer';

const localPrivateKey = new Uint8Array(32).fill(3);
const recipientPrivateKey = new Uint8Array(32).fill(9);
const recipientPublicKey = Buffer.from(ed25519.getPublicKey(recipientPrivateKey)).toString('base64');

function sign(privateKey: Uint8Array, message: string): Uint8Array {
  return ed25519.sign(new TextEncoder().encode(message), privateKey);
}

async function createHarness(t: { after: (fn: () => void) => void }): Promise<{
  database: ChatDatabase;
  fileHandler: FileHandler;
  chatId: number;
  sentApplicationMessages: Array<{ peerId: string; kind: string; payload: unknown }>;
}> {
  const database = new ChatDatabase(':memory:');
  await database.createUser({
    peer_id: RECIPIENT_PEER,
    signing_public_key: recipientPublicKey,
    offline_public_key: 'offline_key',
    signature: 'signature',
    username: 'recipient',
  });
  const chatId = await database.createChat({
    type: 'direct',
    name: 'recipient',
    created_by: RECIPIENT_PEER,
    offline_bucket_secret: 'bucket_secret',
    notifications_bucket_key: 'notifications_key',
    status: 'active',
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    trusted_out_of_band: false,
    muted: false,
    key_version: 0,
    created_at: new Date(),
    participants: [RECIPIENT_PEER],
  });

  const node = {
    peerId: { toString: () => LOCAL_PEER },
    handle: async () => undefined, // serve-handler registration is a no-op in unit tests
  } as unknown as ChatNode;
  const sentApplicationMessages: Array<{ peerId: string; kind: string; payload: unknown }> = [];
  const messageHandler = {
    getUserIdentity: () => ({ sign: (message: string) => sign(localPrivateKey, message) }),
    sendApplicationMessage: async (target: { type: 'direct'; peerId: string }, request: { message: { kind: string; payload: unknown } }) => {
      sentApplicationMessages.push({
        peerId: target.peerId,
        kind: request.message.kind,
        payload: request.message.payload,
      });
      return {
        chatId,
        messageId: 'sent',
        timestamp: Date.now(),
        messageSentStatus: 'online' as const,
        warning: null,
        offlineBackupRetry: null,
      };
    },
  } as unknown as MessageHandler;
  const noop = () => {};
  const fileHandler = new FileHandler(
    node, messageHandler, database, noop, noop, noop, noop, noop, noop,
  );
  t.after(() => database.close());
  return { database, fileHandler, chatId, sentApplicationMessages };
}

function nackContext(offerId: string, chatId: number): InboundApplicationMessageContext {
  const signaturePayload = createFileOfferNackSignaturePayload({ offerId, reason: 'declined' });
  const signature = Buffer.from(
    sign(recipientPrivateKey, JSON.stringify(signaturePayload)),
  ).toString('base64');
  return {
    message: {
      cid: 'nack_cid',
      kind: 'file_offer_nack',
      payload: { type: 'file_offer_nack', offerId, reason: 'declined', signature },
    },
    chatId,
    senderPeerId: RECIPIENT_PEER,
    senderUsername: 'recipient',
    timestamp: Date.now(),
    transportMessageId: 'nack_transport',
    route: 'direct_online',
  };
}

function cancelContext(offerId: string, chatId: number): InboundApplicationMessageContext {
  const signaturePayload = createFileOfferCancelSignaturePayload({ offerId });
  const signature = Buffer.from(
    sign(recipientPrivateKey, JSON.stringify(signaturePayload)),
  ).toString('base64');
  return {
    message: {
      cid: 'cancel_cid',
      kind: 'file_offer_cancel',
      payload: { type: 'file_offer_cancel', offerId, signature },
    },
    chatId,
    senderPeerId: RECIPIENT_PEER,
    senderUsername: 'recipient',
    timestamp: Date.now(),
    transportMessageId: 'cancel_transport',
    route: 'direct_online',
  };
}

function offerContext(input: {
  offerId: string;
  fileId: string;
  chatId: number;
}): InboundApplicationMessageContext {
  const unsignedOffer = {
    type: 'file_offer' as const,
    offerId: input.offerId,
    fileId: input.fileId,
    filename: 'incoming.txt',
    mimeType: 'text/plain',
    size: 5,
    checksum: 'a'.repeat(64),
    totalChunks: 1,
    timestamp: Date.now(),
  };
  const signature = Buffer.from(
    sign(recipientPrivateKey, JSON.stringify(createFileOfferSignaturePayload(unsignedOffer))),
  ).toString('base64');
  return {
    message: {
      cid: input.fileId,
      kind: 'file_offer',
      payload: { ...unsignedOffer, signature },
    },
    chatId: input.chatId,
    senderPeerId: RECIPIENT_PEER,
    senderUsername: 'recipient',
    timestamp: Date.now(),
    transportMessageId: 'offer_transport',
    route: 'direct_online',
  };
}

test('sendFile reserves a serving slot and a terminal NACK frees it through the handler', async (t) => {
  const { database, fileHandler, chatId } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello kiyeovo file sharing');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendFile(RECIPIENT_PEER, filePath, 'file_1');

  const row = database.getFileMessageById('file_1');
  assert.ok(row);
  assert.equal(row.transfer_status, 'awaiting_acceptance');
  const offerId = row.file_offer_id;
  assert.ok(offerId);
  assert.equal(fileHandler.hasActiveOffer(offerId), true);

  const handled = await fileHandler.handleApplicationMessage(nackContext(offerId, chatId));
  assert.equal(handled, true);
  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  assert.equal(database.getFileMessageById('file_1')?.transfer_status, 'rejected');
});

test('a duplicate/late NACK after the slot is freed is a no-op', async (t) => {
  const { database, fileHandler, chatId } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.txt`);
  await writeFile(filePath, 'second file body');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendFile(RECIPIENT_PEER, filePath, 'file_2');
  const offerId = database.getFileMessageById('file_2')?.file_offer_id;
  assert.ok(offerId);

  await fileHandler.handleApplicationMessage(nackContext(offerId, chatId));
  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  // Late duplicate: handled (ignored), no throw, slot stays gone, row stays rejected.
  const handledAgain = await fileHandler.handleApplicationMessage(nackContext(offerId, chatId));
  assert.equal(handledAgain, true);
  assert.equal(database.getFileMessageById('file_2')?.transfer_status, 'rejected');
});

test('cancelOutgoingFileOffer terminalizes the sender row, releases the slot, and emits a signed cancel', async (t) => {
  const { database, fileHandler, sentApplicationMessages } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.txt`);
  await writeFile(filePath, 'cancel me');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendFile(RECIPIENT_PEER, filePath, 'file_cancel');
  const offerId = database.getFileMessageById('file_cancel')?.file_offer_id;
  assert.ok(offerId);
  assert.equal(fileHandler.hasActiveOffer(offerId), true);

  assert.equal(await fileHandler.cancelOutgoingFileOffer('file_cancel'), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const row = database.getFileMessageById('file_cancel');
  assert.equal(row?.transfer_status, 'cancelled');
  assert.equal(row?.transfer_error, 'Offer cancelled');
  assert.equal(fileHandler.hasActiveOffer(offerId), false);

  const cancelMessage = sentApplicationMessages.find((message) => message.kind === 'file_offer_cancel');
  assert.ok(cancelMessage);
  assert.equal(cancelMessage.peerId, RECIPIENT_PEER);
});

test('cancelOutgoingFileOffer refuses an offer that is already being served', async (t) => {
  const { database, fileHandler } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.txt`);
  await writeFile(filePath, 'already serving');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendFile(RECIPIENT_PEER, filePath, 'file_serving');
  const offerId = database.getFileMessageById('file_serving')?.file_offer_id;
  assert.ok(offerId);

  (fileHandler as unknown as { servingOffers: Set<string> }).servingOffers.add(offerId);
  assert.equal(await fileHandler.cancelOutgoingFileOffer('file_serving'), false);
  assert.equal(database.getFileMessageById('file_serving')?.transfer_status, 'awaiting_acceptance');
  assert.equal(fileHandler.hasActiveOffer(offerId), true);
});

test('a signed file-offer cancel terminalizes a pending incoming offer', async (t) => {
  const { database, fileHandler, chatId } = await createHarness(t);
  await database.createMessage({
    id: 'incoming_cancelled',
    client_msg_id: 'incoming_cancelled',
    chat_id: chatId,
    sender_peer_id: RECIPIENT_PEER,
    content: 'incoming.txt (5 bytes)',
    message_type: 'file',
    file_name: 'incoming.txt',
    file_size: 5,
    file_offer_id: 'offer_cancelled',
    file_checksum: 'a'.repeat(64),
    file_total_chunks: 1,
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  const handled = await fileHandler.handleApplicationMessage(cancelContext('offer_cancelled', chatId));
  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_cancelled');
  assert.equal(row?.transfer_status, 'cancelled');
  assert.equal(row?.transfer_error, 'Offer cancelled');
  assert.equal(database.hasFileOfferCancellationTombstone({
    offerId: 'offer_cancelled',
    senderPeerId: RECIPIENT_PEER,
  }), true);
});

test('a cancel that arrives before its offer tombstones and suppresses the late offer', async (t) => {
  const { database, fileHandler, chatId } = await createHarness(t);

  assert.equal(await fileHandler.handleApplicationMessage(cancelContext('offer_before', chatId)), true);
  assert.equal(database.hasFileOfferCancellationTombstone({
    offerId: 'offer_before',
    senderPeerId: RECIPIENT_PEER,
  }), true);

  assert.equal(await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'offer_before',
    fileId: 'late_file',
    chatId,
  })), true);
  assert.equal(database.getFileMessageById('late_file'), null);
});
