import { ChatNode, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, OutgoingFileOfferPendingEvent, OutgoingFileOfferTerminalEvent, PendingFileReceivedEvent } from "../types";
import type { Stream } from "@libp2p/interface";
import { ChatDatabase } from "../db/database";
import { readFile, stat } from "fs/promises";
import { basename } from "path";
import { blake3 } from "@napi-rs/blake-hash";
import { randomUUID } from "crypto";
import mime from "mime-types";
import { CHUNK_SIZE, MAX_FILE_SIZE, FILE_OFFER_RATE_LIMIT, FILE_OFFER_RATE_LIMIT_WINDOW, MAX_PENDING_FILES_PER_PEER, MAX_PENDING_FILES_TOTAL } from "../constants.js";
import { MessageHandler } from "./message-handler.js";
import { errStr, generalErrorHandler } from "../utils/general-error.js";
import { EncryptedUserIdentity } from "../identity/encrypted-user-identity.js";
import { isDebugModeEnabled, log } from "../../shared/logger.js";
import {
  MESSAGE_ENVELOPE_VERSION,
  isValidCid,
  type FileOfferApplicationPayload,
  type FileOfferNackApplicationPayload,
  type FileOfferNackReason,
} from "../protocol/message-envelope.js";
import type { InboundApplicationMessageContext } from "../protocol/application-message.js";
import {
  createFileOfferSignaturePayload,
  validateIncomingFileOffer,
} from "../protocol/file-offer-validation.js";
import {
  createFileOfferNackSignaturePayload,
  getFileOfferNackOutcome,
  validateFileOfferNack,
} from "../protocol/file-offer-control.js";

interface FileMetadata {
  buffer: Buffer
  filename: string
  mimeType: string
  size: number
  checksum: string
  totalChunks: number
}

export class FileHandler {
  private static readonly TRACE_ENABLED = isDebugModeEnabled();
  private node: ChatNode;
  private messageHandler: MessageHandler;
  private database: ChatDatabase;
  private fileOfferTimestamps = new Map<string, number[]>();
  private fileOfferRateLimitNackAt = new Map<string, number>();
  private activeTransfersByPeer = new Map<string, { fileId: string; direction: 'send' | 'receive' }>();
  private activeTransferStreams = new Map<string, Stream>();
  private onFileTransferProgress: (data: FileTransferProgressEvent) => void;
  private onFileTransferComplete: (data: FileTransferCompleteEvent) => void;
  private onFileTransferFailed: (data: FileTransferFailedEvent) => void;
  private onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void;
  private onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => void;
  private onPendingFileReceived: (data: PendingFileReceivedEvent) => void;

  constructor(
    node: ChatNode,
    messageHandler: MessageHandler,
    database: ChatDatabase,
    onFileTransferProgress: (data: FileTransferProgressEvent) => void,
    onFileTransferComplete: (data: FileTransferCompleteEvent) => void,
    onFileTransferFailed: (data: FileTransferFailedEvent) => void,
    onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void,
    onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => void,
    onPendingFileReceived: (data: PendingFileReceivedEvent) => void
  ) {
    this.node = node;
    this.messageHandler = messageHandler;
    this.database = database;
    this.onFileTransferProgress = onFileTransferProgress;
    this.onFileTransferComplete = onFileTransferComplete;
    this.onFileTransferFailed = onFileTransferFailed;
    this.onOutgoingFileOfferPending = onOutgoingFileOfferPending;
    this.onOutgoingFileOfferTerminal = onOutgoingFileOfferTerminal;
    this.onPendingFileReceived = onPendingFileReceived;
    const failedCount = this.database.failNonTerminalFileTransfers('Transfer interrupted (app restart/close)');
    if (failedCount > 0) {
      console.log(`[FileHandler] Marked ${failedCount} non-terminal file transfer(s) as failed on startup`);
    }
  }

  // Get configuration values from database with fallback to constants
  private getMaxFileSize(): number {
    const setting = this.database.getSetting('max_file_size');
    return setting ? parseInt(setting, 10) : MAX_FILE_SIZE;
  }

  private getFileOfferRateLimit(): number {
    const setting = this.database.getSetting('file_offer_rate_limit');
    return setting ? parseInt(setting, 10) : FILE_OFFER_RATE_LIMIT;
  }

  private getMaxPendingFilesPerPeer(): number {
    const setting = this.database.getSetting('max_pending_files_per_peer');
    return setting ? parseInt(setting, 10) : MAX_PENDING_FILES_PER_PEER;
  }

  private getMaxPendingFilesTotal(): number {
    const setting = this.database.getSetting('max_pending_files_total');
    return setting ? parseInt(setting, 10) : MAX_PENDING_FILES_TOTAL;
  }

  private trace(scope: 'SEND' | 'RECV' | 'CORE', peerId: string, fileId: string | null, event: string, extra?: string): void {
    if (!FileHandler.TRACE_ENABLED) return;
    const peerSuffix = peerId ? peerId.slice(-8) : 'unknown';
    const fileLabel = fileId && fileId.trim() ? fileId : 'n/a';
    const details = extra ? ` ${extra}` : '';
    log(`[FILE][TRACE][${scope}] peer=*${peerSuffix} file=${fileLabel} event=${event}${details}`);
  }


  // Check if peer has exceeded file offer rate limit
  private isFileOfferRateLimitExceeded(peerId: string): boolean {
    const now = Date.now();
    const timestamps = this.fileOfferTimestamps.get(peerId) ?? [];

    const recentTimestamps = timestamps.filter(
      ts => now - ts < FILE_OFFER_RATE_LIMIT_WINDOW
    );

    this.fileOfferTimestamps.set(peerId, recentTimestamps);

    return recentTimestamps.length >= this.getFileOfferRateLimit();
  }

  // Track a new file offer from peer
  private trackFileOffer(peerId: string): void {
    const timestamps = this.fileOfferTimestamps.get(peerId) ?? [];
    timestamps.push(Date.now());
    this.fileOfferTimestamps.set(peerId, timestamps);
  }

  private shouldAttemptRateLimitNack(peerId: string): boolean {
    const now = Date.now();
    const lastAttempt = this.fileOfferRateLimitNackAt.get(peerId) ?? 0;
    if (now - lastAttempt < FILE_OFFER_RATE_LIMIT_WINDOW) {
      return false;
    }
    this.fileOfferRateLimitNackAt.set(peerId, now);
    return true;
  }

  acceptPendingFile(fileId: string): void {
    const message = this.database.getFileMessageById(fileId);
    if (!message || message.transfer_status !== 'incoming_pending_user') {
      throw new Error('Pending file offer not found');
    }

    throw new Error('File download is not available until pull transfer is enabled');
  }

  rejectPendingFile(fileId: string): boolean {
    const rejected = this.database.rejectPendingIncomingFileOffer(fileId);
    if (!rejected) {
      return false;
    }

    void this.#sendFileOfferNack(rejected.senderPeerId, rejected.offerId, 'declined');
    return true;
  }

  cancelIncomingFileDownload(fileId: string): boolean {
    const stream = this.activeTransferStreams.get(fileId);
    if (!stream) {
      return false;
    }

    const transferEntry = Array.from(this.activeTransfersByPeer.values()).find((entry) => entry.fileId === fileId);
    if (!transferEntry || transferEntry.direction !== 'receive') {
      return false;
    }

    this.database.updateMessageTransfer(fileId, {
      transfer_status: 'failed',
      transfer_error: 'Download canceled by user',
    });

    try {
      stream.abort(new Error('Download canceled by user'));
      this.trace('RECV', '', fileId, 'CANCEL_REQUESTED_BY_USER');
      return true;
    } catch (error: unknown) {
      this.trace('RECV', '', fileId, 'CANCEL_ABORT_FAILED', 'err=' + (errStr(error, 'unknown')));
      return false;
    }
  }

  async #loadFileMetadata(filePath: string): Promise<FileMetadata> {
    const buffer = await readFile(filePath);
    const filename = basename(filePath);
    const checksum = blake3(buffer).toString('hex');
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);
    const mimeType = mime.lookup(filename) || 'application/octet-stream';

    return {
      buffer,
      filename,
      mimeType,
      size: buffer.length,
      checksum,
      totalChunks,
    };
  }

  #createApplicationFileOffer(input: {
    offerId: string;
    fileId: string;
    metadata: FileMetadata;
    replyToCid?: string;
  }): FileOfferApplicationPayload {
    const unsignedOffer: Omit<FileOfferApplicationPayload, 'signature'> = {
      type: 'file_offer',
      offerId: input.offerId,
      fileId: input.fileId,
      filename: input.metadata.filename,
      mimeType: input.metadata.mimeType,
      size: input.metadata.size,
      checksum: input.metadata.checksum,
      totalChunks: input.metadata.totalChunks,
      ...(input.replyToCid ? { replyToCid: input.replyToCid } : {}),
      timestamp: Date.now(),
    };
    const identity = this.messageHandler.getUserIdentity();
    if (!identity) {
      throw new Error('No user identity available');
    }
    const signature = identity.sign(JSON.stringify(createFileOfferSignaturePayload(unsignedOffer)));
    return {
      ...unsignedOffer,
      signature: Buffer.from(signature).toString('base64'),
    };
  }

  async #sendFileOfferNack(
    targetPeerId: string,
    offerId: string,
    reason: FileOfferNackReason,
  ): Promise<void> {
    try {
      const identity = this.messageHandler.getUserIdentity();
      if (!identity) {
        throw new Error('No user identity available');
      }
      const unsignedNack = {
        type: 'file_offer_nack' as const,
        offerId,
        reason,
      };
      const signature = identity.sign(
        JSON.stringify(createFileOfferNackSignaturePayload(unsignedNack)),
      );
      await this.messageHandler.sendApplicationMessage(
        { type: 'direct', peerId: targetPeerId },
        {
          message: {
            cid: randomUUID(),
            kind: 'file_offer_nack',
            payload: {
              ...unsignedNack,
              signature: Buffer.from(signature).toString('base64'),
            },
          },
          persistence: { owner: 'none' },
        },
      );
      this.trace('SEND', targetPeerId, null, 'OFFER_NACK_SENT', `offer=${offerId} reason=${reason}`);
    } catch (error: unknown) {
      console.warn(
        `[FILE][NACK][DELIVERY_FAILED] peer=*${targetPeerId.slice(-8)} `
        + `offer=${offerId} reason=${reason} err=${errStr(error, 'unknown')}`,
      );
    }
  }

  #handleFileOfferNack(
    context: InboundApplicationMessageContext,
    nack: FileOfferNackApplicationPayload,
  ): boolean {
    if (context.route !== 'direct_online' && context.route !== 'direct_offline') {
      return false;
    }
    const chat = this.database.getChatByPeerId(context.senderPeerId);
    const sender = this.database.getUserByPeerId(context.senderPeerId);
    if (!chat || chat.type !== 'direct' || !sender) {
      return true;
    }
    if (!validateFileOfferNack({
      nack,
      verifySignature: (signature, payload) => EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature,
        payload,
        sender.signing_public_key,
      ),
    })) {
      return true;
    }

    const { status, error } = getFileOfferNackOutcome(nack.reason);
    const terminalized = this.database.terminalizeOutgoingFileOfferFromNack({
      offerId: nack.offerId,
      chatId: chat.id,
      localPeerId: this.node.peerId.toString(),
      status,
      error,
    });
    if (!terminalized) {
      return true;
    }

    this.onOutgoingFileOfferTerminal({
      chatId: chat.id,
      messageId: terminalized.messageId,
      filename: terminalized.filename,
      status,
      error,
    });
    this.trace('RECV', context.senderPeerId, terminalized.messageId, 'OFFER_NACK_APPLIED', `offer=${nack.offerId} reason=${nack.reason}`);
    return true;
  }

  async handleApplicationMessage(context: InboundApplicationMessageContext): Promise<boolean> {
    if (context.message.kind === 'file_offer_nack') {
      return this.#handleFileOfferNack(context, context.message.payload);
    }
    if (context.message.kind !== 'file_offer') {
      return false;
    }
    if (context.route !== 'direct_online' && context.route !== 'direct_offline') {
      return false;
    }

    const offer = context.message.payload;
    const chat = this.database.getChatByPeerId(context.senderPeerId);
    const sender = this.database.getUserByPeerId(context.senderPeerId);
    if (!chat || chat.type !== 'direct' || !sender) {
      return true;
    }

    const existing = this.database.getFileMessageById(offer.fileId);
    if (existing) {
      return true;
    }
    const pending = this.database.getPendingIncomingFileOffers();
    const pendingCapacityFull =
      pending.length >= this.getMaxPendingFilesTotal()
      || pending.filter((message) => message.sender_peer_id === context.senderPeerId).length
        >= this.getMaxPendingFilesPerPeer();
    if (this.isFileOfferRateLimitExceeded(context.senderPeerId)) {
      if (this.shouldAttemptRateLimitNack(context.senderPeerId)) {
        const validation = validateIncomingFileOffer({
          envelopeCid: context.message.cid,
          offer,
          maxFileSize: this.getMaxFileSize(),
          now: Date.now(),
          verifySignature: (signature, payload) => EncryptedUserIdentity.verifyKeyExchangeSignature(
            signature,
            payload,
            sender.signing_public_key,
          ),
        });
        if (validation.ok) {
          void this.#sendFileOfferNack(
            context.senderPeerId,
            offer.offerId,
            pendingCapacityFull ? 'inbox_full' : 'rate_limited',
          );
        }
      }
      return true;
    }
    this.trackFileOffer(context.senderPeerId);

    const validation = validateIncomingFileOffer({
      envelopeCid: context.message.cid,
      offer,
      maxFileSize: this.getMaxFileSize(),
      now: Date.now(),
      verifySignature: (signature, payload) => EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature,
        payload,
        sender.signing_public_key,
      ),
    });
    if (!validation.ok) {
      return true;
    }

    if (pendingCapacityFull) {
      void this.#sendFileOfferNack(context.senderPeerId, offer.offerId, 'inbox_full');
      return true;
    }

    const { inserted } = await this.database.tryCreateMessage({
      id: offer.fileId,
      client_msg_id: offer.fileId,
      reply_to_client_id: offer.replyToCid ?? null,
      chat_id: chat.id,
      sender_peer_id: context.senderPeerId,
      content: `${offer.filename} (${offer.size} bytes)`,
      message_type: 'file',
      file_name: offer.filename,
      file_size: offer.size,
      file_offer_id: offer.offerId,
      file_checksum: offer.checksum,
      file_total_chunks: offer.totalChunks,
      file_protocol_version: MESSAGE_ENVELOPE_VERSION,
      transfer_status: 'incoming_pending_user',
      transfer_progress: 0,
      timestamp: new Date(context.timestamp),
    }, { dedupe: 'any' });
    if (!inserted) {
      return true;
    }

    this.onPendingFileReceived({
      chatId: chat.id,
      fileId: offer.fileId,
      filename: offer.filename,
      size: offer.size,
      senderId: context.senderPeerId,
      senderUsername: sender.username,
      ...(offer.replyToCid ? { replyToClientId: offer.replyToCid } : {}),
    });
    this.trace('RECV', context.senderPeerId, offer.fileId, 'OFFER_MESSAGE_PERSISTED', `offer=${offer.offerId}`);
    return true;
  }

  async sendFile(targetUsername: string, filePath: string, providedFileId?: string, replyToCidInput?: string): Promise<void> {
    const user = this.database.getUserByPeerIdThenUsername(targetUsername);
    if (!user) {
      throw new Error('User not found');
    }
    const chat = this.database.getChatByPeerId(user.peer_id);
    if (!chat || chat.type !== 'direct') {
      throw new Error('Direct chat not found');
    }

    const fileStats = await stat(filePath);
    const maxFileSize = this.getMaxFileSize();
    if (fileStats.size <= 0 || fileStats.size > maxFileSize) {
      throw new Error(
        fileStats.size <= 0
          ? 'File is empty'
          : `File too large (${fileStats.size} bytes, max ${maxFileSize} bytes)`,
      );
    }

    const metadata = await this.#loadFileMetadata(filePath);
    if (metadata.size <= 0 || metadata.size > maxFileSize) {
      throw new Error('File changed while preparing the offer');
    }
    if (providedFileId !== undefined && !isValidCid(providedFileId)) {
      throw new Error('Invalid file message id');
    }
    const fileId = providedFileId ?? randomUUID();
    const offerId = randomUUID();
    const replyToCid = isValidCid(replyToCidInput) ? replyToCidInput : undefined;
    const offer = this.#createApplicationFileOffer({
      offerId,
      fileId,
      metadata,
      ...(replyToCid ? { replyToCid } : {}),
    });
    let rowPersisted = false;
    try {
      await this.database.createMessage({
        id: fileId,
        client_msg_id: fileId,
        reply_to_client_id: replyToCid ?? null,
        chat_id: chat.id,
        sender_peer_id: this.node.peerId.toString(),
        content: `${metadata.filename} (${metadata.size} bytes)`,
        message_type: 'file',
        file_name: metadata.filename,
        file_size: metadata.size,
        file_path: filePath,
        file_offer_id: offerId,
        file_checksum: metadata.checksum,
        file_total_chunks: metadata.totalChunks,
        file_protocol_version: MESSAGE_ENVELOPE_VERSION,
        transfer_status: 'awaiting_acceptance',
        transfer_progress: 0,
        timestamp: new Date(),
      });
      rowPersisted = true;

      await this.messageHandler.sendApplicationMessage(
        { type: 'direct', peerId: user.peer_id },
        {
          message: { cid: fileId, kind: 'file_offer', payload: offer },
          persistence: { owner: 'caller' },
        },
      );
      if (this.database.getFileMessageById(fileId)?.transfer_status === 'awaiting_acceptance') {
        this.onOutgoingFileOfferPending({ chatId: chat.id, messageId: fileId });
      }
      this.trace('SEND', user.peer_id, fileId, 'OFFER_MESSAGE_SENT', `offer=${offerId}`);
    } catch (error: unknown) {
      const errorText = errStr(error, 'Unknown error');
      if (rowPersisted) {
        this.database.updateMessageTransfer(fileId, {
          transfer_status: 'failed',
          transfer_progress: 0,
          transfer_error: errorText,
        });
      }
      if (rowPersisted) {
        this.onFileTransferFailed({ chatId: chat.id, messageId: fileId, error: errorText });
      }
      generalErrorHandler(error);
      throw error;
    }
  }

  cleanup(): void {
    for (const [fileId, stream] of this.activeTransferStreams.entries()) {
      try {
        stream.abort(new Error('File transfer interrupted: application shutdown'));
      } catch {
        // best-effort shutdown cleanup
      } finally {
        this.activeTransferStreams.delete(fileId);
      }
    }
    this.activeTransfersByPeer.clear();

    const failed = this.database.failNonTerminalFileTransfers('Transfer interrupted (app shutdown)');
    if (failed > 0) {
      console.log(`[FileHandler] Shutdown cleanup marked ${failed} transfer(s) as failed`);
    }
  }

}
