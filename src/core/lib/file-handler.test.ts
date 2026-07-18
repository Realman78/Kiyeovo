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
import type { PendingFileOfferDeferredEvent } from '../types.js';
import type { MessageHandler } from './message-handler.js';
import type { InboundApplicationMessageContext } from '../protocol/application-message.js';
import { VOICE_NOTE_MAX_DURATION_MS_WIRE, MAX_VOICE_NOTE_FILE_SIZE, CHUNK_SIZE } from '../constants.js';

const LOCAL_PEER = 'local_peer';
const RECIPIENT_PEER = 'recipient_peer';
const SECOND_RECIPIENT_PEER = 'second_recipient_peer';

const localPrivateKey = new Uint8Array(32).fill(3);
const localPublicKey = Buffer.from(ed25519.getPublicKey(localPrivateKey)).toString('base64');
const recipientPrivateKey = new Uint8Array(32).fill(9);
const recipientPublicKey = Buffer.from(ed25519.getPublicKey(recipientPrivateKey)).toString('base64');
const secondRecipientPrivateKey = new Uint8Array(32).fill(11);
const secondRecipientPublicKey = Buffer.from(ed25519.getPublicKey(secondRecipientPrivateKey)).toString('base64');

function sign(privateKey: Uint8Array, message: string): Uint8Array {
  return ed25519.sign(new TextEncoder().encode(message), privateKey);
}

type ServedFileMetaForTest = {
  offerId: string;
  fileId: string;
  filePath: string;
  size: number;
  checksum: string;
  chatId: number;
  isGroup: boolean;
  authorizedPullerCount: number;
};

type FileHandlerServeInternals = {
  servedFiles: {
    getMeta: (id: string) => ServedFileMetaForTest | undefined;
    getAuthorizedKey: (id: string, peerId: string) => string | undefined;
  };
  applySuccessfulServedPull: (id: string, meta: ServedFileMetaForTest, peerId: string) => void;
  applyCanceledServedPull: (id: string, meta: ServedFileMetaForTest, peerId: string) => void;
  tryAcquireOfferServeLock: (
    offerId: string,
    requesterPeerId: string,
    isGroup: boolean,
  ) => { release: () => void } | null;
};

async function createHarness(t: { after: (fn: () => void) => void }): Promise<{
  database: ChatDatabase;
  fileHandler: FileHandler;
  chatId: number;
  sentApplicationMessages: Array<{
    target: { type: 'direct'; peerId: string } | { type: 'group'; groupId: string };
    kind: string;
    cid: string;
    payload: unknown;
  }>;
  pendingFileEvents: Array<{ chatId: number; fileId: string; filename: string; senderId: string }>;
  pendingFileDeferredEvents: PendingFileOfferDeferredEvent[];
  outgoingPendingEvents: Array<{
    chatId: number;
    messageId: string;
    groupDownloadTotal?: number;
    groupDownloadCompleted?: number;
  }>;
  outgoingTerminalEvents: Array<{ chatId: number; messageId: string; filename: string; status: string; error: string }>;
  completeEvents: Array<{
    chatId: number;
    messageId: string;
    filePath: string;
    status?: 'completed' | 'partially_completed';
    groupDownloadTotal?: number;
    groupDownloadCompleted?: number;
  }>;
  failedEvents: Array<{ chatId: number; messageId: string; error: string; status?: string }>;
}> {
  const database = new ChatDatabase(':memory:');
  await database.createUser({
    peer_id: LOCAL_PEER,
    signing_public_key: localPublicKey,
    offline_public_key: 'local_offline_key',
    signature: 'local_signature',
    username: 'local',
  });
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
  const sentApplicationMessages: Array<{
    target: { type: 'direct'; peerId: string } | { type: 'group'; groupId: string };
    kind: string;
    cid: string;
    payload: unknown;
  }> = [];
  const messageHandler = {
    getUserIdentity: () => ({ sign: (message: string) => sign(localPrivateKey, message) }),
    sendApplicationMessage: async (
      target: { type: 'direct'; peerId: string } | { type: 'group'; groupId: string },
      request: { message: { cid: string; kind: string; payload: unknown } },
    ) => {
      sentApplicationMessages.push({
        target,
        kind: request.message.kind,
        cid: request.message.cid,
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
  const pendingFileEvents: Array<{ chatId: number; fileId: string; filename: string; senderId: string }> = [];
  const pendingFileDeferredEvents: PendingFileOfferDeferredEvent[] = [];
  const outgoingPendingEvents: Array<{
    chatId: number;
    messageId: string;
    groupDownloadTotal?: number;
    groupDownloadCompleted?: number;
  }> = [];
  const outgoingTerminalEvents: Array<{ chatId: number; messageId: string; filename: string; status: string; error: string }> = [];
  const completeEvents: Array<{
    chatId: number;
    messageId: string;
    filePath: string;
    status?: 'completed' | 'partially_completed';
    groupDownloadTotal?: number;
    groupDownloadCompleted?: number;
  }> = [];
  const failedEvents: Array<{ chatId: number; messageId: string; error: string; status?: string }> = [];
  const fileHandler = new FileHandler(
    node,
    messageHandler,
    database,
    noop,
    (event) => completeEvents.push(event),
    (event) => failedEvents.push(event),
    (event) => outgoingPendingEvents.push(event),
    (event) => outgoingTerminalEvents.push(event),
    (event) => pendingFileEvents.push(event),
    (event) => pendingFileDeferredEvents.push(event),
  );
  t.after(() => database.close());
  return {
    database,
    fileHandler,
    chatId,
    sentApplicationMessages,
    pendingFileEvents,
    pendingFileDeferredEvents,
    outgoingPendingEvents,
    outgoingTerminalEvents,
    completeEvents,
    failedEvents,
  };
}

async function createGroupChat(
  database: ChatDatabase,
  groupId = `group-${randomUUID()}`,
  participants = [LOCAL_PEER, RECIPIENT_PEER],
): Promise<number> {
  const chatId = await database.createChat({
    type: 'group',
    name: 'test group',
    created_by: LOCAL_PEER,
    offline_bucket_secret: 'group_bucket_secret',
    notifications_bucket_key: 'group_notifications_key',
    status: 'active',
    group_id: groupId,
    group_key: Buffer.alloc(32, 1).toString('base64'),
    permanent_key: 'group_permanent_key',
    trusted_out_of_band: false,
    muted: false,
    key_version: 1,
    group_creator_peer_id: LOCAL_PEER,
    offline_last_read_timestamp: 0,
    offline_last_ack_sent: 0,
    created_at: new Date(),
    participants,
  });
  database.updateChatGroupStatus(chatId, 'active');
  return chatId;
}

function signedDeclineNackPayload(
  offerId: string,
  privateKey: Uint8Array = recipientPrivateKey,
) {
  const reason = 'declined' as const;
  const signaturePayload = createFileOfferNackSignaturePayload({ offerId, reason });
  const signature = Buffer.from(
    sign(privateKey, JSON.stringify(signaturePayload)),
  ).toString('base64');
  return { type: 'file_offer_nack' as const, offerId, reason, signature };
}

function nackContext(offerId: string, chatId: number): InboundApplicationMessageContext {
  return {
    message: {
      cid: 'nack_cid',
      kind: 'file_offer_nack',
      payload: signedDeclineNackPayload(offerId),
    },
    chatId,
    senderPeerId: RECIPIENT_PEER,
    senderUsername: 'recipient',
    timestamp: Date.now(),
    transportMessageId: 'nack_transport',
    route: 'direct_online',
  };
}

function groupNackContext(
  offerId: string,
  chatId: number,
  senderPeerId = RECIPIENT_PEER,
  privateKey = recipientPrivateKey,
): InboundApplicationMessageContext {
  return {
    message: {
      cid: `group_nack_${senderPeerId}`,
      kind: 'file_offer_nack',
      payload: signedDeclineNackPayload(offerId, privateKey),
    },
    chatId,
    senderPeerId,
    senderUsername: senderPeerId === SECOND_RECIPIENT_PEER ? 'second' : 'recipient',
    timestamp: Date.now(),
    transportMessageId: `group_nack_transport_${senderPeerId}`,
    route: 'group_realtime',
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

function groupCancelContext(offerId: string, chatId: number): InboundApplicationMessageContext {
  const signaturePayload = createFileOfferCancelSignaturePayload({ offerId });
  const signature = Buffer.from(
    sign(recipientPrivateKey, JSON.stringify(signaturePayload)),
  ).toString('base64');
  return {
    message: {
      cid: 'group_cancel_cid',
      kind: 'file_offer_cancel',
      payload: { type: 'file_offer_cancel', offerId, signature },
    },
    chatId,
    senderPeerId: RECIPIENT_PEER,
    senderUsername: 'recipient',
    timestamp: Date.now(),
    transportMessageId: 'group_cancel_transport',
    route: 'group_realtime',
  };
}

function offerContext(input: {
  offerId: string;
  fileId: string;
  chatId: number;
  route?: InboundApplicationMessageContext['route'];
  voiceNote?: { durationMs: number };
  filename?: string;
  mimeType?: string;
  size?: number;
  totalChunks?: number;
}): InboundApplicationMessageContext {
  const unsignedOffer = {
    type: 'file_offer' as const,
    offerId: input.offerId,
    fileId: input.fileId,
    filename: input.filename ?? (input.voiceNote ? 'incoming.webm' : 'incoming.txt'),
    mimeType: input.mimeType ?? (input.voiceNote ? 'audio/webm' : 'text/plain'),
    size: input.size ?? 5,
    checksum: 'a'.repeat(64),
    totalChunks: input.totalChunks ?? 1,
    ...(input.voiceNote ? { voiceNote: input.voiceNote } : {}),
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
    route: input.route ?? 'direct_online',
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

test('sendFile with a voice-note duration signs it into the offer and persists file_kind/file_duration_ms', async (t) => {
  const { database, fileHandler, sentApplicationMessages } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.webm`);
  await writeFile(filePath, 'fake opus bytes');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendFile(RECIPIENT_PEER, filePath, 'voice_file_1', undefined, 12_000);

  const row = database.getFileMessageById('voice_file_1');
  assert.equal(row?.file_kind, 'voice_note');
  assert.equal(row?.file_duration_ms, 12_000);
  const sentOffer = sentApplicationMessages.find((m) => m.cid === 'voice_file_1');
  assert.deepEqual((sentOffer?.payload as { voiceNote?: { durationMs: number } }).voiceNote, { durationMs: 12_000 });
});

test('sendFile rejects a nonsensical voice-note duration and reserves no offer', async (t) => {
  const { database, fileHandler } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.webm`);
  await writeFile(filePath, 'fake opus bytes');
  t.after(() => rm(filePath, { force: true }));

  await assert.rejects(
    fileHandler.sendFile(RECIPIENT_PEER, filePath, 'voice_file_bad', undefined, VOICE_NOTE_MAX_DURATION_MS_WIRE + 1),
    /Invalid voice note duration/,
  );
  assert.equal(database.getFileMessageById('voice_file_bad'), null);
});

test('an inbound offer with a plausible voiceNote is persisted and emitted as a voice note', async (t) => {
  const { database, fileHandler, chatId, pendingFileEvents } = await createHarness(t);

  const handled = await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'incoming_offer_voice',
    fileId: 'incoming_voice_file',
    chatId,
    voiceNote: { durationMs: 9_000 },
  }));

  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_voice_file');
  assert.equal(row?.file_kind, 'voice_note');
  assert.equal(row?.file_duration_ms, 9_000);
  const event = pendingFileEvents.find((e) => e.fileId === 'incoming_voice_file') as
    { isVoiceNote?: boolean; voiceDurationMs?: number } | undefined;
  assert.equal(event?.isVoiceNote, true);
  assert.equal(event?.voiceDurationMs, 9_000);
});

test('an inbound offer with an out-of-range voiceNote degrades to a plain file instead of being dropped', async (t) => {
  const { database, fileHandler, chatId, pendingFileEvents } = await createHarness(t);

  const handled = await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'incoming_offer_bad_voice',
    fileId: 'incoming_bad_voice_file',
    chatId,
    voiceNote: { durationMs: VOICE_NOTE_MAX_DURATION_MS_WIRE + 60_000 },
  }));

  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_bad_voice_file');
  assert.ok(row, 'offer must still be persisted as a plain file, not dropped');
  assert.equal(row?.file_kind, null);
  assert.equal(row?.file_duration_ms, null);
  const event = pendingFileEvents.find((e) => e.fileId === 'incoming_bad_voice_file') as
    { isVoiceNote?: boolean } | undefined;
  assert.equal(event?.isVoiceNote, undefined);
});

test('an inbound offer with a negative voiceNote duration degrades to a plain file instead of being dropped', async (t) => {
  // Regression coverage for the degrade-don't-drop contract across both layers: the envelope
  // check now tolerates durationMs:-1 (see message-envelope.test.ts), and FileHandler must still
  // refuse to honor it as a voice note rather than crash or persist a negative duration.
  const { database, fileHandler, chatId, pendingFileEvents } = await createHarness(t);

  const handled = await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'incoming_offer_negative_voice',
    fileId: 'incoming_negative_voice_file',
    chatId,
    voiceNote: { durationMs: -1 },
  }));

  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_negative_voice_file');
  assert.ok(row, 'offer must still be persisted as a plain file, not dropped');
  assert.equal(row?.file_kind, null);
  assert.equal(row?.file_duration_ms, null);
  const event = pendingFileEvents.find((e) => e.fileId === 'incoming_negative_voice_file') as
    { isVoiceNote?: boolean } | undefined;
  assert.equal(event?.isVoiceNote, undefined);
});

test('an inbound offer with a plausible duration but a non-webm filename/mimeType degrades to a plain file', async (t) => {
  const { database, fileHandler, chatId, pendingFileEvents } = await createHarness(t);

  const handled = await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'incoming_offer_fake_voice',
    fileId: 'incoming_fake_voice_file',
    chatId,
    voiceNote: { durationMs: 9_000 },
    filename: 'report.pdf',
    mimeType: 'application/pdf',
  }));

  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_fake_voice_file');
  assert.ok(row, 'offer must still be persisted as a plain file, not dropped');
  assert.equal(row?.file_kind, null);
  assert.equal(row?.file_duration_ms, null);
  const event = pendingFileEvents.find((e) => e.fileId === 'incoming_fake_voice_file') as
    { isVoiceNote?: boolean } | undefined;
  assert.equal(event?.isVoiceNote, undefined);
});

test('an inbound offer with a plausible duration and webm filename but oversized declared size degrades to a plain file', async (t) => {
  const { database, fileHandler, chatId, pendingFileEvents } = await createHarness(t);
  const oversizedForVoiceNote = MAX_VOICE_NOTE_FILE_SIZE + CHUNK_SIZE;

  const handled = await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'incoming_offer_oversized_voice',
    fileId: 'incoming_oversized_voice_file',
    chatId,
    voiceNote: { durationMs: 9_000 },
    size: oversizedForVoiceNote,
    totalChunks: Math.ceil(oversizedForVoiceNote / CHUNK_SIZE),
  }));

  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_oversized_voice_file');
  assert.ok(row, 'offer must still be persisted as a plain file, not dropped');
  assert.equal(row?.file_kind, null);
  assert.equal(row?.file_duration_ms, null);
  const event = pendingFileEvents.find((e) => e.fileId === 'incoming_oversized_voice_file') as
    { isVoiceNote?: boolean } | undefined;
  assert.equal(event?.isVoiceNote, undefined);
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
  assert.deepEqual(cancelMessage.target, { type: 'direct', peerId: RECIPIENT_PEER });
});

test('cancelOutgoingFileOffer refuses an offer that is already being served', async (t) => {
  const { database, fileHandler } = await createHarness(t);
  const filePath = join(tmpdir(), `kiyeovo-test-${randomUUID()}.txt`);
  await writeFile(filePath, 'already serving');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendFile(RECIPIENT_PEER, filePath, 'file_serving');
  const offerId = database.getFileMessageById('file_serving')?.file_offer_id;
  assert.ok(offerId);

  (fileHandler as unknown as { servingDirectOffers: Set<string> }).servingDirectOffers.add(offerId);
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

test('a signed group file-offer cancel terminalizes a pending incoming group offer', async (t) => {
  const { database, fileHandler, failedEvents } = await createHarness(t);
  const groupChatId = await createGroupChat(database);
  await database.createMessage({
    id: 'incoming_group_cancelled',
    client_msg_id: 'incoming_group_cancelled',
    chat_id: groupChatId,
    sender_peer_id: RECIPIENT_PEER,
    content: 'incoming.txt (5 bytes)',
    message_type: 'file',
    file_name: 'incoming.txt',
    file_size: 5,
    file_offer_id: 'group_offer_cancelled',
    file_checksum: 'a'.repeat(64),
    file_total_chunks: 1,
    transfer_status: 'incoming_pending_user',
    transfer_progress: 0,
    timestamp: new Date(),
  });

  const handled = await fileHandler.handleApplicationMessage(groupCancelContext('group_offer_cancelled', groupChatId));
  assert.equal(handled, true);
  const row = database.getFileMessageById('incoming_group_cancelled');
  assert.equal(row?.transfer_status, 'cancelled');
  assert.equal(row?.transfer_error, 'Offer cancelled');
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0]?.messageId, 'incoming_group_cancelled');
  assert.equal(failedEvents[0]?.status, 'cancelled');
  assert.equal(database.hasFileOfferCancellationTombstone({
    offerId: 'group_offer_cancelled',
    senderPeerId: RECIPIENT_PEER,
  }), true);
});

test('recipient capacity ignores retryable errored pending offers', async (t) => {
  const { database, fileHandler, chatId, sentApplicationMessages } = await createHarness(t);

  for (let i = 0; i < 5; i++) {
    await database.createMessage({
      id: `pending_${i}`,
      client_msg_id: `pending_${i}`,
      chat_id: chatId,
      sender_peer_id: RECIPIENT_PEER,
      content: `pending_${i}.txt (5 bytes)`,
      message_type: 'file',
      file_name: `pending_${i}.txt`,
      file_size: 5,
      file_offer_id: `pending_offer_${i}`,
      file_checksum: 'a'.repeat(64),
      file_total_chunks: 1,
      transfer_status: 'incoming_pending_user',
      transfer_progress: 0,
      ...(i < 2 ? { transfer_error: 'Transfer interrupted' } : {}),
      timestamp: new Date(Date.now() + i),
    });
  }

  assert.equal(await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'new_offer_after_errors',
    fileId: 'new_file_after_errors',
    chatId,
  })), true);

  const inserted = database.getFileMessageById('new_file_after_errors');
  assert.equal(inserted?.transfer_status, 'incoming_pending_user');
  assert.equal(
    sentApplicationMessages.some((message) => message.kind === 'file_offer_nack'),
    false,
  );
});

test('sendGroupFile persists a caller-owned group offer and snapshots authorized pullers', async (t) => {
  const { database, fileHandler, sentApplicationMessages } = await createHarness(t);
  const groupId = `group-${randomUUID()}`;
  const groupChatId = await createGroupChat(database, groupId);
  const filePath = join(tmpdir(), `kiyeovo-group-test-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello group file sharing');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_file_1');

  const row = database.getFileMessageById('group_file_1');
  assert.ok(row);
  assert.equal(row.chat_id, groupChatId);
  assert.equal(row.sender_peer_id, LOCAL_PEER);
  assert.equal(row.transfer_status, 'awaiting_acceptance');
  assert.equal(row.file_path, filePath);
  assert.equal(row.file_group_download_total, 1);
  assert.equal(row.file_group_download_completed, 0);
  assert.ok(row.file_offer_id);
  assert.equal(fileHandler.hasActiveOffer(row.file_offer_id), true);

  const registry = (fileHandler as unknown as {
    servedFiles: { getAuthorizedKey: (offerId: string, peerId: string) => string | undefined };
  }).servedFiles;
  assert.equal(registry.getAuthorizedKey(row.file_offer_id, RECIPIENT_PEER), recipientPublicKey);
  assert.equal(registry.getAuthorizedKey(row.file_offer_id, LOCAL_PEER), undefined);

  const sentOffer = sentApplicationMessages.find((message) => message.kind === 'file_offer');
  assert.ok(sentOffer);
  assert.deepEqual(sentOffer.target, { type: 'group', groupId });
  assert.equal(sentOffer.cid, 'group_file_1');
});

test('rejecting an incoming group file offer emits a signed group decline NACK', async (t) => {
  const { database, fileHandler, sentApplicationMessages } = await createHarness(t);
  const groupId = `group-${randomUUID()}`;
  const groupChatId = await createGroupChat(database, groupId);

  assert.equal(await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'incoming_group_reject_offer',
    fileId: 'incoming_group_reject_file',
    chatId: groupChatId,
    route: 'group_realtime',
  })), true);
  assert.equal(fileHandler.rejectPendingFile('incoming_group_reject_file'), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const nack = sentApplicationMessages.find((message) => message.kind === 'file_offer_nack');
  assert.ok(nack);
  assert.deepEqual(nack.target, { type: 'group', groupId });
  assert.equal((nack.payload as { offerId?: string }).offerId, 'incoming_group_reject_offer');
  assert.equal((nack.payload as { reason?: string }).reason, 'declined');
});

test('cancelOutgoingFileOffer withdraws a group offer and emits a signed group cancel', async (t) => {
  const { database, fileHandler, sentApplicationMessages, outgoingTerminalEvents } = await createHarness(t);
  const groupId = `group-${randomUUID()}`;
  const groupChatId = await createGroupChat(database, groupId);
  const filePath = join(tmpdir(), `kiyeovo-group-withdraw-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello group withdrawal');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_withdraw_file');
  const row = database.getFileMessageById('group_withdraw_file');
  assert.ok(row?.file_offer_id);
  const offerId = row.file_offer_id;

  assert.equal(await fileHandler.cancelOutgoingFileOffer('group_withdraw_file'), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const finalRow = database.getFileMessageById('group_withdraw_file');
  assert.equal(finalRow?.transfer_status, 'cancelled');
  assert.equal(finalRow?.transfer_error, 'Offer cancelled');
  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  assert.equal(outgoingTerminalEvents.length, 1);
  assert.equal(outgoingTerminalEvents[0]?.messageId, 'group_withdraw_file');
  assert.equal(outgoingTerminalEvents[0]?.status, 'cancelled');

  const cancelMessage = sentApplicationMessages.find((message) => message.kind === 'file_offer_cancel');
  assert.ok(cancelMessage);
  assert.deepEqual(cancelMessage.target, { type: 'group', groupId });
  assert.equal((cancelMessage.payload as { offerId?: string }).offerId, offerId);
});

test('cancelOutgoingFileOffer preserves partial group completion when withdrawing', async (t) => {
  const { database, fileHandler, sentApplicationMessages, completeEvents, failedEvents } = await createHarness(t);
  await database.createUser({
    peer_id: SECOND_RECIPIENT_PEER,
    signing_public_key: secondRecipientPublicKey,
    offline_public_key: 'second_offline_key',
    signature: 'second_signature',
    username: 'second',
  });
  const groupId = `group-${randomUUID()}`;
  const groupChatId = await createGroupChat(database, groupId, [
    LOCAL_PEER,
    RECIPIENT_PEER,
    SECOND_RECIPIENT_PEER,
  ]);
  const filePath = join(tmpdir(), `kiyeovo-group-withdraw-partial-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello partial group withdrawal');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_withdraw_partial_file');
  const row = database.getFileMessageById('group_withdraw_partial_file');
  assert.ok(row?.file_offer_id);
  const offerId = row.file_offer_id;
  const internals = fileHandler as unknown as FileHandlerServeInternals;
  const meta = internals.servedFiles.getMeta(offerId);
  assert.ok(meta);

  internals.applySuccessfulServedPull(offerId, meta, RECIPIENT_PEER);
  assert.equal(await fileHandler.cancelOutgoingFileOffer('group_withdraw_partial_file'), true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const finalRow = database.getFileMessageById('group_withdraw_partial_file');
  assert.equal(finalRow?.transfer_status, 'partially_completed');
  assert.equal(finalRow?.transfer_error, null);
  assert.equal(finalRow?.file_group_download_total, 2);
  assert.equal(finalRow?.file_group_download_completed, 1);
  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  assert.equal(failedEvents.length, 0);
  assert.equal(completeEvents.length, 1);
  assert.equal(completeEvents[0]?.status, 'partially_completed');
  assert.equal(completeEvents[0]?.groupDownloadTotal, 2);
  assert.equal(completeEvents[0]?.groupDownloadCompleted, 1);

  const cancelMessage = sentApplicationMessages.find((message) => message.kind === 'file_offer_cancel');
  assert.ok(cancelMessage);
  assert.deepEqual(cancelMessage.target, { type: 'group', groupId });
});

test('a successful group pull removes only that puller and completes after the last puller', async (t) => {
  const { database, fileHandler, outgoingPendingEvents, completeEvents } = await createHarness(t);
  await database.createUser({
    peer_id: SECOND_RECIPIENT_PEER,
    signing_public_key: secondRecipientPublicKey,
    offline_public_key: 'second_offline_key',
    signature: 'second_signature',
    username: 'second',
  });
  const groupChatId = await createGroupChat(database, `group-${randomUUID()}`, [
    LOCAL_PEER,
    RECIPIENT_PEER,
    SECOND_RECIPIENT_PEER,
  ]);
  const filePath = join(tmpdir(), `kiyeovo-group-success-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello two group pullers');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_success_file');
  const row = database.getFileMessageById('group_success_file');
  assert.ok(row?.file_offer_id);
  assert.equal(row.file_group_download_total, 2);
  assert.equal(row.file_group_download_completed, 0);
  const offerId = row.file_offer_id;
  const internals = fileHandler as unknown as FileHandlerServeInternals;
  const meta = internals.servedFiles.getMeta(offerId);
  assert.ok(meta);
  const pendingEventsBeforeFirstPull = outgoingPendingEvents.length;

  internals.applySuccessfulServedPull(offerId, meta, RECIPIENT_PEER);

  assert.equal(fileHandler.hasActiveOffer(offerId), true);
  assert.equal(internals.servedFiles.getAuthorizedKey(offerId, RECIPIENT_PEER), undefined);
  assert.equal(internals.servedFiles.getAuthorizedKey(offerId, SECOND_RECIPIENT_PEER), secondRecipientPublicKey);
  const afterFirstPull = database.getFileMessageById('group_success_file');
  assert.equal(afterFirstPull?.transfer_status, 'awaiting_acceptance');
  assert.equal(afterFirstPull?.file_group_download_total, 2);
  assert.equal(afterFirstPull?.file_group_download_completed, 1);
  assert.equal(completeEvents.length, 0);
  assert.equal(outgoingPendingEvents.length, pendingEventsBeforeFirstPull + 1);
  const latestPendingEvent = outgoingPendingEvents[outgoingPendingEvents.length - 1];
  assert.equal(latestPendingEvent?.groupDownloadTotal, 2);
  assert.equal(latestPendingEvent?.groupDownloadCompleted, 1);

  internals.applySuccessfulServedPull(offerId, meta, SECOND_RECIPIENT_PEER);

  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  const afterSecondPull = database.getFileMessageById('group_success_file');
  assert.equal(afterSecondPull?.transfer_status, 'completed');
  assert.equal(afterSecondPull?.file_group_download_total, 2);
  assert.equal(afterSecondPull?.file_group_download_completed, 2);
  assert.equal(completeEvents.length, 1);
  assert.equal(completeEvents[0]?.messageId, 'group_success_file');
});

test('group same-offer serve locks allow different recipients but reject duplicate requester pulls', async (t) => {
  const { fileHandler } = await createHarness(t);
  const internals = fileHandler as unknown as FileHandlerServeInternals;

  const directLock = internals.tryAcquireOfferServeLock('direct_offer', RECIPIENT_PEER, false);
  assert.ok(directLock);
  assert.equal(internals.tryAcquireOfferServeLock('direct_offer', SECOND_RECIPIENT_PEER, false), null);
  directLock.release();
  const directRetry = internals.tryAcquireOfferServeLock('direct_offer', SECOND_RECIPIENT_PEER, false);
  assert.ok(directRetry);
  directRetry.release();

  const groupFirst = internals.tryAcquireOfferServeLock('group_offer', RECIPIENT_PEER, true);
  assert.ok(groupFirst);
  const groupSecond = internals.tryAcquireOfferServeLock('group_offer', SECOND_RECIPIENT_PEER, true);
  assert.ok(groupSecond);
  assert.equal(internals.tryAcquireOfferServeLock('group_offer', RECIPIENT_PEER, true), null);

  groupFirst.release();
  const firstRetry = internals.tryAcquireOfferServeLock('group_offer', RECIPIENT_PEER, true);
  assert.ok(firstRetry);
  groupSecond.release();
  firstRetry.release();
});

test('a canceled group pull removes only that puller and keeps the offer for the rest', async (t) => {
  const { database, fileHandler, outgoingPendingEvents, failedEvents } = await createHarness(t);
  await database.createUser({
    peer_id: SECOND_RECIPIENT_PEER,
    signing_public_key: secondRecipientPublicKey,
    offline_public_key: 'second_offline_key',
    signature: 'second_signature',
    username: 'second',
  });
  const groupChatId = await createGroupChat(database, `group-${randomUUID()}`, [
    LOCAL_PEER,
    RECIPIENT_PEER,
    SECOND_RECIPIENT_PEER,
  ]);
  const filePath = join(tmpdir(), `kiyeovo-group-cancel-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello group cancel');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_cancel_file');
  const row = database.getFileMessageById('group_cancel_file');
  assert.ok(row?.file_offer_id);
  const offerId = row.file_offer_id;
  const internals = fileHandler as unknown as FileHandlerServeInternals;
  const meta = internals.servedFiles.getMeta(offerId);
  assert.ok(meta);
  const pendingEventsBeforeCancel = outgoingPendingEvents.length;

  internals.applyCanceledServedPull(offerId, meta, RECIPIENT_PEER);

  assert.equal(fileHandler.hasActiveOffer(offerId), true);
  assert.equal(internals.servedFiles.getAuthorizedKey(offerId, RECIPIENT_PEER), undefined);
  assert.equal(internals.servedFiles.getAuthorizedKey(offerId, SECOND_RECIPIENT_PEER), secondRecipientPublicKey);
  assert.equal(database.getFileMessageById('group_cancel_file')?.transfer_status, 'awaiting_acceptance');
  assert.equal(failedEvents.length, 0);
  assert.equal(outgoingPendingEvents.length, pendingEventsBeforeCancel + 1);
  const latestPendingEvent = outgoingPendingEvents[outgoingPendingEvents.length - 1];
  assert.equal(latestPendingEvent?.groupDownloadTotal, 2);
  assert.equal(latestPendingEvent?.groupDownloadCompleted, 0);
});

test('group decline NACK removes that puller and cancels when nobody downloaded', async (t) => {
  const { database, fileHandler, outgoingPendingEvents, failedEvents } = await createHarness(t);
  await database.createUser({
    peer_id: SECOND_RECIPIENT_PEER,
    signing_public_key: secondRecipientPublicKey,
    offline_public_key: 'second_offline_key',
    signature: 'second_signature',
    username: 'second',
  });
  const groupChatId = await createGroupChat(database, `group-${randomUUID()}`, [
    LOCAL_PEER,
    RECIPIENT_PEER,
    SECOND_RECIPIENT_PEER,
  ]);
  const filePath = join(tmpdir(), `kiyeovo-group-decline-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello group decline');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_decline_file');
  const row = database.getFileMessageById('group_decline_file');
  assert.ok(row?.file_offer_id);
  const offerId = row.file_offer_id;
  const internals = fileHandler as unknown as FileHandlerServeInternals;
  const pendingEventsBeforeDecline = outgoingPendingEvents.length;

  assert.equal(await fileHandler.handleApplicationMessage(groupNackContext(offerId, groupChatId)), true);

  assert.equal(fileHandler.hasActiveOffer(offerId), true);
  assert.equal(internals.servedFiles.getAuthorizedKey(offerId, RECIPIENT_PEER), undefined);
  assert.equal(internals.servedFiles.getAuthorizedKey(offerId, SECOND_RECIPIENT_PEER), secondRecipientPublicKey);
  const afterFirstDecline = database.getFileMessageById('group_decline_file');
  assert.equal(afterFirstDecline?.transfer_status, 'awaiting_acceptance');
  assert.equal(afterFirstDecline?.file_group_download_total, 2);
  assert.equal(afterFirstDecline?.file_group_download_completed, 0);
  assert.equal(failedEvents.length, 0);
  assert.equal(outgoingPendingEvents.length, pendingEventsBeforeDecline + 1);

  assert.equal(await fileHandler.handleApplicationMessage(
    groupNackContext(offerId, groupChatId, SECOND_RECIPIENT_PEER, secondRecipientPrivateKey),
  ), true);

  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  const finalRow = database.getFileMessageById('group_decline_file');
  assert.equal(finalRow?.transfer_status, 'cancelled');
  assert.equal(finalRow?.file_group_download_total, 2);
  assert.equal(finalRow?.file_group_download_completed, 0);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0]?.messageId, 'group_decline_file');
  assert.equal(failedEvents[0]?.status, 'cancelled');
});

test('a group offer closes as partial completion when the last remaining puller cancels after successes', async (t) => {
  const { database, fileHandler, completeEvents, failedEvents } = await createHarness(t);
  await database.createUser({
    peer_id: SECOND_RECIPIENT_PEER,
    signing_public_key: secondRecipientPublicKey,
    offline_public_key: 'second_offline_key',
    signature: 'second_signature',
    username: 'second',
  });
  const groupChatId = await createGroupChat(database, `group-${randomUUID()}`, [
    LOCAL_PEER,
    RECIPIENT_PEER,
    SECOND_RECIPIENT_PEER,
  ]);
  const filePath = join(tmpdir(), `kiyeovo-group-partial-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello partial group completion');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_partial_file');
  const row = database.getFileMessageById('group_partial_file');
  assert.ok(row?.file_offer_id);
  const offerId = row.file_offer_id;
  const internals = fileHandler as unknown as FileHandlerServeInternals;
  const meta = internals.servedFiles.getMeta(offerId);
  assert.ok(meta);

  internals.applySuccessfulServedPull(offerId, meta, RECIPIENT_PEER);
  internals.applyCanceledServedPull(offerId, meta, SECOND_RECIPIENT_PEER);

  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  const finalRow = database.getFileMessageById('group_partial_file');
  assert.equal(finalRow?.transfer_status, 'partially_completed');
  assert.equal(finalRow?.transfer_error, null);
  assert.equal(finalRow?.file_group_download_total, 2);
  assert.equal(finalRow?.file_group_download_completed, 1);
  assert.equal(failedEvents.length, 0);
  assert.equal(completeEvents.length, 1);
  assert.equal(completeEvents[0]?.messageId, 'group_partial_file');
  assert.equal(completeEvents[0]?.status, 'partially_completed');
  assert.equal(completeEvents[0]?.groupDownloadTotal, 2);
  assert.equal(completeEvents[0]?.groupDownloadCompleted, 1);
});

test('a canceled one-recipient group pull releases the offer and terminalizes the sender row', async (t) => {
  const { database, fileHandler, failedEvents } = await createHarness(t);
  const groupChatId = await createGroupChat(database);
  const filePath = join(tmpdir(), `kiyeovo-group-cancel-last-${randomUUID()}.txt`);
  await writeFile(filePath, 'hello last group cancel');
  t.after(() => rm(filePath, { force: true }));

  await fileHandler.sendGroupFile(groupChatId, filePath, 'group_cancel_last_file');
  const row = database.getFileMessageById('group_cancel_last_file');
  assert.ok(row?.file_offer_id);
  const offerId = row.file_offer_id;
  const internals = fileHandler as unknown as FileHandlerServeInternals;
  const meta = internals.servedFiles.getMeta(offerId);
  assert.ok(meta);

  internals.applyCanceledServedPull(offerId, meta, RECIPIENT_PEER);

  assert.equal(fileHandler.hasActiveOffer(offerId), false);
  assert.equal(database.getFileMessageById('group_cancel_last_file')?.transfer_status, 'cancelled');
  assert.equal(database.getFileMessageById('group_cancel_last_file')?.transfer_error, 'Recipient canceled the download');
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0]?.messageId, 'group_cancel_last_file');
  assert.equal(failedEvents[0]?.status, 'cancelled');
});

test('incoming group file offers persist as pending group file rows', async (t) => {
  const { database, fileHandler, pendingFileEvents } = await createHarness(t);
  const groupChatId = await createGroupChat(database);

  const handled = await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'group_offer_in',
    fileId: 'group_file_in',
    chatId: groupChatId,
    route: 'group_realtime',
  }));

  assert.equal(handled, true);
  const row = database.getFileMessageById('group_file_in');
  assert.ok(row);
  assert.equal(row.chat_id, groupChatId);
  assert.equal(row.sender_peer_id, RECIPIENT_PEER);
  assert.equal(row.transfer_status, 'incoming_pending_user');
  assert.equal(row.file_offer_id, 'group_offer_in');
  assert.equal(pendingFileEvents.length, 1);
  const event = pendingFileEvents[0];
  assert.ok(event);
  assert.equal(event.chatId, groupChatId);
  assert.equal(event.fileId, 'group_file_in');
});

test('group file offer capacity rejection emits a local deferred warning without NACKing', async (t) => {
  const { database, fileHandler, chatId, sentApplicationMessages, pendingFileDeferredEvents } = await createHarness(t);
  const groupChatId = await createGroupChat(database);

  for (let i = 0; i < 5; i++) {
    await database.createMessage({
      id: `full_pending_${i}`,
      client_msg_id: `full_pending_${i}`,
      chat_id: chatId,
      sender_peer_id: RECIPIENT_PEER,
      content: `full_pending_${i}.txt (5 bytes)`,
      message_type: 'file',
      file_name: `full_pending_${i}.txt`,
      file_size: 5,
      file_offer_id: `full_offer_${i}`,
      file_checksum: 'a'.repeat(64),
      file_total_chunks: 1,
      transfer_status: 'incoming_pending_user',
      transfer_progress: 0,
      timestamp: new Date(Date.now() + i),
    });
  }

  assert.equal(await fileHandler.handleApplicationMessage(offerContext({
    offerId: 'silent_group_full',
    fileId: 'silent_group_file',
    chatId: groupChatId,
    route: 'group_offline',
  })), true);

  assert.equal(database.getFileMessageById('silent_group_file'), null);
  assert.equal(
    sentApplicationMessages.some((message) => message.kind === 'file_offer_nack'),
    false,
  );
  assert.equal(pendingFileDeferredEvents.length, 1);
  assert.deepEqual(pendingFileDeferredEvents[0], {
    chatId: groupChatId,
    senderId: RECIPIENT_PEER,
    senderUsername: 'recipient',
    reason: 'inbox_full',
    pendingTotal: 5,
    maxPendingTotal: 10,
    pendingFromSender: 5,
    maxPendingPerPeer: 5,
  });
});
