import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { ChatDatabase } from '../db/database.js';
import { FileHandler } from './file-handler.js';
import { createFileOfferNackSignaturePayload } from '../protocol/file-offer-control.js';
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

  const node = { peerId: { toString: () => LOCAL_PEER } } as unknown as ChatNode;
  const messageHandler = {
    getUserIdentity: () => ({ sign: (message: string) => sign(localPrivateKey, message) }),
    sendApplicationMessage: async () => ({
      chatId,
      messageId: 'sent',
      timestamp: Date.now(),
      messageSentStatus: 'online' as const,
      warning: null,
      offlineBackupRetry: null,
    }),
  } as unknown as MessageHandler;
  const noop = () => {};
  const fileHandler = new FileHandler(
    node, messageHandler, database, noop, noop, noop, noop, noop, noop,
  );
  t.after(() => database.close());
  return { database, fileHandler, chatId };
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
