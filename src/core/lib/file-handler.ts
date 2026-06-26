import { ChatNode, StreamHandlerContext, ConversationSession, FileChunk, FileOffer, FileOfferResponse, FileTransferConfirm, FileTransferMessage, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, OutgoingFileOfferPendingEvent, PendingFileReceivedEvent } from "../types";
import type { Stream, PeerId } from "@libp2p/interface";
import { ChatDatabase, Chat, User } from "../db/database";
import { readFile, stat, writeFile, mkdir, access } from "fs/promises";
import { basename, extname, isAbsolute, resolve } from "path";
import { blake3 } from "@napi-rs/blake-hash";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes, randomUUID } from "crypto";
import { pushable } from "it-pushable";
import { pipe } from "it-pipe";
import { StreamHandler } from "../transport/stream-handler.js";
import mime from "mime-types";
import { CHUNK_SIZE, DOWNLOADS_DIR, FILE_ACCEPTANCE_TIMEOUT, FILE_OFFER, FILE_OFFER_RESPONSE, FILE_TRANSFER_CONFIRM, MAX_FILE_MESSAGE_SIZE, MAX_FILE_SIZE, CHUNK_RECEIVE_TIMEOUT, CHUNK_IDLE_TIMEOUT, FILE_OFFER_RATE_LIMIT, FILE_OFFER_RATE_LIMIT_WINDOW, MAX_PENDING_FILES_PER_PEER, MAX_PENDING_FILES_TOTAL, FILE_REJECTION_COUNTER_RESET_INTERVAL, SILENT_REJECTION_THRESHOLD_GLOBAL, SILENT_REJECTION_THRESHOLD_PER_PEER, getNetworkModeRuntime } from "../constants.js";
import { MessageHandler } from "./message-handler.js";
import { errStr, generalErrorHandler } from "../utils/general-error.js";
import { EncryptedUserIdentity } from "../identity/encrypted-user-identity.js";
import { dialProtocolWithRelayFallback } from "../transport/protocol-dialer.js";
import { formatCopyTimestamp } from "../utils/miscellaneous.js";
import { isDebugModeEnabled, log } from "../../shared/logger.js";
import { isValidCid } from "../protocol/message-envelope.js";

interface FileMetadata {
  buffer: Buffer
  filename: string
  mimeType: string
  size: number
  checksum: string
  totalChunks: number
}

interface OutgoingFileTransferContext {
  chat: Chat
  session: ConversationSession
  targetPeerId: PeerId
  targetPeerIdStr: string
  metadata: FileMetadata
  fileId: string
  replyToCid: string | undefined
}

interface OutgoingTransferResult {
  filePath: string
  messageId: string
  filename: string
  size: number
}

type IncomingOfferEvaluation =
  | { kind: 'silent-reject' }
  | { kind: 'reject'; reason: string }
  | {
    kind: 'ready'
    sender: User
    chat: Chat
    session: ConversationSession
    pinnedSessionPeerId: string
    expiresAt: number
  };

interface IncomingOfferDecision {
  accepted: boolean
  decision: 'accepted' | 'rejected' | 'expired' | 'shutdown'
}

export class FileHandler {
  private static readonly TRACE_ENABLED = isDebugModeEnabled();
  private node: ChatNode;
  private messageHandler: MessageHandler;
  private database: ChatDatabase;
  private pendingFileAcceptances = new Map<
    string,
    {
      resolve: (accepted: boolean) => void;
      reject: (error: Error) => void;
      offer: FileOffer;
      senderId: string;
      senderUsername: string;
      expiresAt: number;
      decision?: 'rejected' | 'expired' | 'shutdown';
    }
  >();
  private fileOfferTimestamps = new Map<string, number[]>();
  private perPeerPendingRejections = new Map<string, number>(); // Track "too many pending from you" rejections per peer
  private globalPendingRejectionsCount = 0; // Track total "too many global pending" rejections
  private activeTransfersByPeer = new Map<string, { fileId: string; direction: 'send' | 'receive' }>();
  private activeTransferStreams = new Map<string, Stream>();
  private onFileTransferProgress: (data: FileTransferProgressEvent) => void;
  private onFileTransferComplete: (data: FileTransferCompleteEvent) => void;
  private onFileTransferFailed: (data: FileTransferFailedEvent) => void;
  private onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void;
  private onPendingFileReceived: (data: PendingFileReceivedEvent) => void;
  private readonly fileTransferProtocol: string;

  constructor(
    node: ChatNode,
    messageHandler: MessageHandler,
    database: ChatDatabase,
    onFileTransferProgress: (data: FileTransferProgressEvent) => void,
    onFileTransferComplete: (data: FileTransferCompleteEvent) => void,
    onFileTransferFailed: (data: FileTransferFailedEvent) => void,
    onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void,
    onPendingFileReceived: (data: PendingFileReceivedEvent) => void
  ) {
    this.node = node;
    this.messageHandler = messageHandler;
    this.database = database;
    this.onFileTransferProgress = onFileTransferProgress;
    this.onFileTransferComplete = onFileTransferComplete;
    this.onFileTransferFailed = onFileTransferFailed;
    this.onOutgoingFileOfferPending = onOutgoingFileOfferPending;
    this.onPendingFileReceived = onPendingFileReceived;
    this.fileTransferProtocol = getNetworkModeRuntime(this.database.getSessionNetworkMode()).config.fileTransferProtocol;
    const failedCount = this.database.failNonTerminalFileTransfers('Transfer interrupted (app restart/close)');
    if (failedCount > 0) {
      console.log(`[FileHandler] Marked ${failedCount} non-terminal file transfer(s) as failed on startup`);
    }
    this.#setupProtocolHandler();
    this.#setupRejectionCounterReset();
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

  private getSilentRejectionThresholdGlobal(): number {
    const setting = this.database.getSetting('silent_rejection_threshold_global');
    return setting ? parseInt(setting, 10) : SILENT_REJECTION_THRESHOLD_GLOBAL;
  }

  private getSilentRejectionThresholdPerPeer(): number {
    const setting = this.database.getSetting('silent_rejection_threshold_per_peer');
    return setting ? parseInt(setting, 10) : SILENT_REJECTION_THRESHOLD_PER_PEER;
  }

  // Reset rejection counters every 10 minutes to give users a fresh start
  #setupRejectionCounterReset(): void {
    setInterval(() => {
      this.perPeerPendingRejections.clear();
      this.globalPendingRejectionsCount = 0;
    }, FILE_REJECTION_COUNTER_RESET_INTERVAL);
  }

  private trace(scope: 'SEND' | 'RECV' | 'CORE', peerId: string, fileId: string | null, event: string, extra?: string): void {
    if (!FileHandler.TRACE_ENABLED) return;
    const peerSuffix = peerId ? peerId.slice(-8) : 'unknown';
    const fileLabel = fileId && fileId.trim() ? fileId : 'n/a';
    const details = extra ? ` ${extra}` : '';
    log(`[FILE][TRACE][${scope}] peer=*${peerSuffix} file=${fileLabel} event=${event}${details}`);
  }


  private isUserCanceledTransferError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return message.includes('download canceled by user') || message.includes('download cancelled by user');
  }

  private tryBeginPeerTransfer(peerId: string, fileId: string, direction: 'send' | 'receive'): boolean {
    const active = this.activeTransfersByPeer.get(peerId);
    if (active) {
      this.trace(direction === 'send' ? 'SEND' : 'RECV', peerId, fileId, 'PEER_TRANSFER_BLOCKED', `activeFile=${active.fileId} activeDirection=${active.direction}`);
      return false;
    }
    this.activeTransfersByPeer.set(peerId, { fileId, direction });
    this.trace(direction === 'send' ? 'SEND' : 'RECV', peerId, fileId, 'PEER_TRANSFER_BEGIN', `direction=${direction}`);
    return true;
  }

  private endPeerTransfer(peerId: string, fileId: string): void {
    const active = this.activeTransfersByPeer.get(peerId);
    if (active && active.fileId === fileId) {
      this.activeTransfersByPeer.delete(peerId);
      this.trace(active.direction === 'send' ? 'SEND' : 'RECV', peerId, fileId, 'PEER_TRANSFER_END', `direction=${active.direction}`);
    }
  }

  private trackTransferStream(fileId: string, stream: Stream): void {
    this.activeTransferStreams.set(fileId, stream);
    this.trace('CORE', '', fileId, 'STREAM_TRACKED');
  }

  private untrackTransferStream(fileId: string): void {
    const existed = this.activeTransferStreams.delete(fileId);
    this.trace('CORE', '', fileId, 'STREAM_UNTRACKED', `existed=${existed}`);
  }

  private isPeerTransferActive(peerId: string): boolean {
    return this.activeTransfersByPeer.has(peerId);
  }

  // Emit for first 10 chunks, then only every 10% increment
  #shouldEmitProgress(currentChunk: number, totalChunks: number, lastEmittedPercentage: number): { shouldEmit: boolean; newPercentage: number } {
    if (currentChunk <= 10) {
      const percentage = Math.floor((currentChunk / totalChunks) * 100);
      return { shouldEmit: true, newPercentage: percentage };
    }

    const currentPercentage = Math.floor((currentChunk / totalChunks) * 100);
    const percentageBucket = Math.floor(currentPercentage / 10) * 10; // Round down to nearest 10%
    const lastBucket = Math.floor(lastEmittedPercentage / 10) * 10;

    if (percentageBucket > lastBucket) {
      return { shouldEmit: true, newPercentage: currentPercentage };
    }

    return { shouldEmit: false, newPercentage: lastEmittedPercentage };
  }

  private buildSignedFileOfferPayload(offer: FileOffer): object {
    const replyToCid = isValidCid(offer.replyToCid) ? offer.replyToCid : undefined;
    return {
      type: offer.type,
      fileId: offer.fileId,
      filename: offer.filename,
      mimeType: offer.mimeType,
      size: offer.size,
      checksum: offer.checksum,
      totalChunks: offer.totalChunks,
      ...(replyToCid ? { replyToCid } : {}),
      timestamp: offer.timestamp,
      expiresAt: offer.expiresAt,
    };
  }

  private isFileOfferSignatureValid(offer: FileOffer, signingPublicKey: string): boolean {
    if (!offer.signature || !offer.timestamp || !offer.expiresAt) {
      return false;
    }
    if (offer.replyToCid !== undefined && !isValidCid(offer.replyToCid)) {
      return false;
    }

    const payload = this.buildSignedFileOfferPayload(offer);
    return EncryptedUserIdentity.verifyKeyExchangeSignature(offer.signature, payload, signingPublicKey);
  }

  private buildFileOfferRejection(fileId: string, reason: string): FileOfferResponse {
    return {
      type: FILE_OFFER_RESPONSE,
      fileId,
      accepted: false,
      reason,
    };
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

  // Count pending files from specific peer
  private getPendingFilesFromPeer(peerId: string): number {
    return Array.from(this.pendingFileAcceptances.values())
      .filter(p => p.senderId === peerId)
      .length;
  }

  private getTotalPendingFiles(): number {
    return this.pendingFileAcceptances.size;
  }

  getPendingFiles(): Array<{ fileId: string; filename: string; size: number; senderId: string; senderUsername: string; expiresAt: number; replyToClientId?: string }> {
    return Array.from(this.pendingFileAcceptances.values()).map(p => {
      const replyToClientId = p.offer.replyToCid;
      return {
        fileId: p.offer.fileId,
        filename: p.offer.filename,
        size: p.offer.size,
        senderId: p.senderId,
        senderUsername: p.senderUsername,
        expiresAt: p.expiresAt,
        ...(replyToClientId ? { replyToClientId } : {}),
      };
    });
  }

  acceptPendingFile(fileId: string): void {
    const promise = this.pendingFileAcceptances.get(fileId);
    if (promise) {
      this.database.updateMessageTransfer(fileId, {
        transfer_status: 'in_progress'
      });
      promise.resolve(true);
      this.pendingFileAcceptances.delete(fileId);
    }
  }

  rejectPendingFile(fileId: string): void {
    const promise = this.pendingFileAcceptances.get(fileId);
    if (promise) {
      promise.decision = 'rejected';
      promise.resolve(false);
    }
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

  #setupProtocolHandler(): void {
    void this.node.handle(this.fileTransferProtocol, async (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);

      if (this.database.isBlocked(remoteId)) return stream.close();

      StreamHandler.logIncomingConnection(remoteId, this.fileTransferProtocol);

      try {
        await this.#handleIncomingFile(remoteId, stream);
      } catch (error: unknown) {
        if (this.isUserCanceledTransferError(error)) {
          this.trace('RECV', remoteId, null, 'CANCELED_BY_USER');
          return;
        }
        generalErrorHandler(error, `Failed to handle incoming file`);
      }
    }, {runOnLimitedConnection: true});
  }

  async #handleIncomingFile(
    senderPeerId: string,
    stream: Stream
  ): Promise<void> {
    const writable = pushable();
    const sinkPromise = pipe(writable, stream.sink);

    let offer: FileOffer | null = null;
    let chat: Chat | null = null;
    let session: ConversationSession | null = null;
    let offerAccepted = false;
    let pinnedSessionPeerId: string | null = null;
    let activePeerTransferStarted = false;
    let chunkTimeout: NodeJS.Timeout | null = null;
    let lastEmittedPercentage = 0;
    this.trace('RECV', senderPeerId, null, 'STREAM_OPEN');

    try {
      let buffer = new Uint8Array(0);
      const receivedChunks: Map<number, Buffer> = new Map();

      for await (const chunk of stream.source) {
        const chunkData = (chunk as unknown as Uint8Array).subarray();

        // Memory Guard: Prevent buffer from growing indefinitely for JSON messages
        if (buffer.length + chunkData.length > MAX_FILE_MESSAGE_SIZE) {
          throw new Error('Incoming message buffer exceeded limit');
        }

        const newBuffer = new Uint8Array(buffer.length + chunkData.length);
        newBuffer.set(buffer);
        newBuffer.set(chunkData, buffer.length);
        buffer = newBuffer;

        for (;;) {
          let decoded: { message: FileTransferMessage; bytesRead: number } | null;
          try {
            decoded = this.#decodeMessage(buffer);
          } catch (error: unknown) {
            this.trace('RECV', senderPeerId, offer?.fileId ?? null, 'DECODE_ERROR', `bufferBytes=${buffer.length} err=${errStr(error, 'unknown')}`);
            throw error;
          }
          if (!decoded) break;

          buffer = buffer.slice(decoded.bytesRead);
          const message = decoded.message;

          if (message.type === FILE_OFFER) {
            const offerMsg = message;
            offer = offerMsg;
            this.trace('RECV', senderPeerId, offerMsg.fileId, 'OFFER_RECEIVED', `size=${offerMsg.size} chunks=${offerMsg.totalChunks}`);
            const evaluation = await this.#evaluateIncomingFileOffer(senderPeerId, offerMsg);
            if (evaluation.kind === 'silent-reject') {
              return;
            }
            if (evaluation.kind === 'reject') {
              writable.push(this.#encodeMessage(this.buildFileOfferRejection(offer.fileId, evaluation.reason)));
              return;
            }

            chat = evaluation.chat;
            session = evaluation.session;
            pinnedSessionPeerId = evaluation.pinnedSessionPeerId;
            await this.#persistPendingIncomingOffer(offerMsg, senderPeerId, evaluation.sender, evaluation.chat, evaluation.expiresAt);

            // Wait for user decision with timeout
            // eslint-disable-next-line no-await-in-loop
            const decision = await this.#waitForIncomingOfferDecision(
              offerMsg,
              senderPeerId,
              evaluation.sender.username,
              evaluation.expiresAt,
            );

            if (!decision.accepted) {
              const transferStatus =
                decision.decision === 'rejected'
                  ? 'rejected'
                  : decision.decision === 'shutdown'
                    ? 'failed'
                    : 'expired';
              const transferError =
                decision.decision === 'rejected'
                  ? 'Offer rejected'
                  : decision.decision === 'shutdown'
                    ? 'Transfer interrupted (app shutdown)'
                    : 'Offer expired';

              this.database.updateMessageTransfer(offerMsg.fileId, {
                transfer_status: transferStatus,
                transfer_progress: 0,
                transfer_error: transferError
              });

              this.pendingFileAcceptances.delete(offerMsg.fileId);

              this.trace('RECV', senderPeerId, offerMsg.fileId, 'OFFER_NOT_ACCEPTED', `decision=${transferStatus}`);
              writable.push(this.#encodeMessage(this.buildFileOfferRejection(offerMsg.fileId, 'User rejected or timeout')));
              return;
            }

            // User accepted - start chunk timeout
            offerAccepted = true;
            this.trace('RECV', senderPeerId, offerMsg.fileId, 'OFFER_ACCEPTED');
            if (!this.tryBeginPeerTransfer(senderPeerId, offerMsg.fileId, 'receive')) {
              const busyReason = 'Another file transfer is already active with this peer';
              this.database.updateMessageTransfer(offerMsg.fileId, {
                transfer_status: 'failed',
                transfer_progress: 0,
                transfer_error: busyReason,
              });
              if (this.onFileTransferFailed && chat) {
                this.onFileTransferFailed({
                  chatId: chat.id,
                  messageId: offerMsg.fileId,
                  error: busyReason,
                });
              }
              const busyResponse: FileOfferResponse = {
                type: FILE_OFFER_RESPONSE,
                fileId: offerMsg.fileId,
                accepted: false,
                reason: busyReason,
              };
              this.trace('RECV', senderPeerId, offerMsg.fileId, 'OFFER_ACCEPT_FAILED_BUSY');
              writable.push(this.#encodeMessage(busyResponse));
              return;
            }
            activePeerTransferStarted = true;
            this.trackTransferStream(offerMsg.fileId, stream);
            const response: FileOfferResponse = {
              type: FILE_OFFER_RESPONSE,
              fileId: offerMsg.fileId,
              accepted: true,
            };
            writable.push(this.#encodeMessage(response));
            this.trace('RECV', senderPeerId, offerMsg.fileId, 'OFFER_ACCEPT_SENT');

            // Set per-chunk idle timeout (resets after each chunk received)
            // If no chunk is received for CHUNK_IDLE_TIMEOUT, transfer is stalled
            chunkTimeout = setTimeout(() => {
              try {
                stream.abort(new Error('Chunk receive timeout - no data received for 60 seconds'));
              } catch (error: unknown) {
                generalErrorHandler(error, 'Error aborting stream');
              }
            }, CHUNK_IDLE_TIMEOUT);

          } else if (message.type === 'file_chunk') {
            if (!offer) throw new Error('Received chunk before offer');
            if (!session) throw new Error('Received chunk without active session');
            if (!chat) throw new Error('Received chunk without chat');

            const fileChunk = message;

            // Validate chunk index bounds
            if (fileChunk.index < 0 || fileChunk.index >= offer.totalChunks) {
              throw new Error(`Invalid chunk index ${fileChunk.index} (expected 0-${offer.totalChunks - 1})`);
            }

            // Detect duplicate chunks (potential memory exhaustion attack)
            if (receivedChunks.has(fileChunk.index)) {
              throw new Error(`Duplicate chunk ${fileChunk.index}`);
            }

            // Decrypt chunk
            const nonce = Buffer.from(fileChunk.nonce, 'base64');
            const encrypted = Buffer.from(fileChunk.data, 'base64');
            const cipher = xchacha20poly1305(session.receivingKey, nonce);
            const decrypted = Buffer.from(cipher.decrypt(encrypted));
            this.messageHandler.getSessionManager().updateSessionUsage(senderPeerId);

            // Verify chunk hash
            const actualHash = blake3(decrypted).toString('hex');
            if (actualHash !== fileChunk.hash) {
              throw new Error(`Chunk ${fileChunk.index} hash mismatch`);
            }

            receivedChunks.set(fileChunk.index, decrypted);

            if (chunkTimeout) {
              clearTimeout(chunkTimeout);
              const currentChunk = fileChunk.index + 1;
              const totalChunks = offer.totalChunks;
              chunkTimeout = setTimeout(() => {
                try {
                  stream.abort(new Error(`Chunk receive timeout - stalled at chunk ${currentChunk}/${totalChunks}`));
                } catch (error: unknown) {
                  generalErrorHandler(error, 'Error aborting stream');
                }
              }, CHUNK_IDLE_TIMEOUT);
            }

            // Emit progress event (throttled: first 5 chunks, then every 10%)
            if (this.onFileTransferProgress) {
              const { shouldEmit, newPercentage } = this.#shouldEmitProgress(
                fileChunk.index + 1,
                offer.totalChunks,
                lastEmittedPercentage
              );
              if (shouldEmit) {
                lastEmittedPercentage = newPercentage;
                const progress = Math.floor(((fileChunk.index + 1) / offer.totalChunks) * 100);
                this.database.updateMessageTransfer(offer.fileId, {
                  transfer_status: 'in_progress',
                  transfer_progress: progress,
                });
                this.onFileTransferProgress({
                  chatId: chat.id,
                  messageId: offer.fileId,
                  current: fileChunk.index + 1,
                  total: offer.totalChunks,
                  filename: offer.filename,
                  size: offer.size
                });
              }
            }
          }
        }
      }

      this.trace(
        'RECV',
        senderPeerId,
        offer?.fileId ?? null,
        'SOURCE_ENDED',
        `offerSeen=${!!offer} receivedChunks=${receivedChunks.size}${offer ? `/${offer.totalChunks}` : ''} bufferedBytes=${buffer.length}`,
      );

      if (!offer) throw new Error('No offer received');

      const fileBuffer = Buffer.concat(
        Array.from({ length: offer.totalChunks }, (_, i) => {
          const chunk = receivedChunks.get(i);
          if (!chunk) throw new Error('Chunk not found');
          return chunk;
        })
      );

      const actualChecksum = blake3(fileBuffer).toString('hex');
      if (actualChecksum !== offer.checksum) {
        throw new Error(`File checksum mismatch`);
      }

      // Clear chunk timeout on successful completion
      if (chunkTimeout) {
        clearTimeout(chunkTimeout);
        chunkTimeout = null;
      }

      // Get downloads directory from settings or use default
      const configuredDownloadsDir = this.database.getSetting('downloads_directory') || DOWNLOADS_DIR;
      const downloadsDir = isAbsolute(configuredDownloadsDir)
        ? configuredDownloadsDir
        : resolve(process.cwd(), configuredDownloadsDir);
      await mkdir(downloadsDir, { recursive: true });

      // Find unique filename by adding "_copy_MMDD_HHMMSS_mm" when a collision exists.
      const sanitizedFilename = basename(offer.filename);
      let savePath = `${downloadsDir}/${sanitizedFilename}`;
      const ext = extname(sanitizedFilename);
      const nameWithoutExt = basename(sanitizedFilename, ext);
      let originalExists = false;
      try {
        await access(savePath);
        originalExists = true;
      } catch {
        originalExists = false;
      }

      if (originalExists) {
        let found = false;
        for (let attempt = 0; attempt < 1000; attempt++) {
          const timestampSuffix = `_copy_${formatCopyTimestamp(new Date())}`;
          const attemptSuffix = attempt > 0 ? `_${attempt}` : '';
          const candidate = `${downloadsDir}/${nameWithoutExt}${timestampSuffix}${attemptSuffix}${ext}`;
          try {
            // eslint-disable-next-line no-await-in-loop
            await access(candidate);
          } catch {
            savePath = candidate;
            found = true;
            break;
          }
        }

        if (!found) {
          throw new Error('Unable to allocate a unique filename');
        }
      }

      await writeFile(savePath, fileBuffer);
      const messageId = offer.fileId;
        this.database.updateMessageTransfer(messageId, {
          file_name: offer.filename,
          file_size: offer.size,
          file_path: savePath,
          transfer_status: 'completed',
          transfer_progress: 100
        });

      // Emit completion event
      if (this.onFileTransferComplete && chat) {
        this.onFileTransferComplete({
          chatId: chat.id,
          messageId: messageId,
          filePath: savePath
        });
      }

      if (offerAccepted) {
        const confirm: FileTransferConfirm = {
          type: FILE_TRANSFER_CONFIRM,
          fileId: offer.fileId,
          success: true,
        };
        this.trace('RECV', senderPeerId, offer.fileId, 'CONFIRM_SUCCESS_SENT');
        writable.push(this.#encodeMessage(confirm));
      }
    } catch (error: unknown) {
      this.trace('RECV', senderPeerId, offer?.fileId ?? null, 'ERROR', `err=${errStr(error, 'unknown')}`);
      // Emit failure event
      if (offer && this.onFileTransferFailed && chat) {
        this.onFileTransferFailed({
          chatId: chat.id,
          messageId: offer.fileId,
          error: errStr(error, 'Unknown error')
        });
      }

      if (offer && (error instanceof Error)) {
        if (offerAccepted) {
          const confirm: FileTransferConfirm = {
            type: FILE_TRANSFER_CONFIRM,
            fileId: offer.fileId,
            success: false,
            error: error.message,
          };
          try {
            this.trace('RECV', senderPeerId, offer.fileId, 'CONFIRM_FAILURE_SENT', `reason=${error.message}`);
            writable.push(this.#encodeMessage(confirm));
          } catch (pushError: unknown) {
            this.trace('RECV', senderPeerId, offer.fileId, 'CONFIRM_FAILURE_SEND_FAILED', `err=${errStr(pushError, 'unknown')}`);
          }
        } else {
          const response: FileOfferResponse = {
            type: FILE_OFFER_RESPONSE,
            fileId: offer.fileId,
            accepted: false,
            reason: error.message,
          };
          try {
            this.trace('RECV', senderPeerId, offer.fileId, 'OFFER_REJECTION_SENT', `reason=${error.message}`);
            writable.push(this.#encodeMessage(response));
          } catch (pushError: unknown) {
            this.trace('RECV', senderPeerId, offer.fileId, 'OFFER_REJECTION_SEND_FAILED', `err=${errStr(pushError, 'unknown')}`);
          }
        }
      }
      throw error;
    } finally {
      // Clear chunk timeout if still active
      if (chunkTimeout) {
        clearTimeout(chunkTimeout);
      }

      // Clean up pending acceptance if exists
      if (offer) {
        this.pendingFileAcceptances.delete(offer.fileId);
      }
      if (offer && activePeerTransferStarted) {
        this.endPeerTransfer(senderPeerId, offer.fileId);
      }
      if (offer) {
        this.untrackTransferStream(offer.fileId);
      }
      if (pinnedSessionPeerId) {
        this.messageHandler.getSessionManager().unpinSession(pinnedSessionPeerId);
      }

      this.trace('RECV', senderPeerId, offer?.fileId ?? null, 'WRITABLE_END');
      writable.end();
      await sinkPromise;
      this.trace('RECV', senderPeerId, offer?.fileId ?? null, 'SINK_RESOLVED');
    }
  }

  async #loadFileMetadata(filePath: string): Promise<FileMetadata> {
    const fileStats = await stat(filePath);
    const buffer = await readFile(filePath);
    const filename = basename(filePath);
    const checksum = blake3(buffer).toString('hex');
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);
    const mimeType = mime.lookup(filename) || 'application/octet-stream';

    return {
      buffer,
      filename,
      mimeType,
      size: fileStats.size,
      checksum,
      totalChunks,
    };
  }

  #createEncryptedChunks(
    buffer: Buffer,
    fileId: string,
    session: ConversationSession
  ): FileChunk[] {
    const chunks: FileChunk[] = [];
    const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, buffer.length);
      const chunkData = buffer.subarray(start, end);

      // Verification
      const hash = blake3(chunkData).toString('hex');

      const nonce = randomBytes(24);
      const cipher = xchacha20poly1305(session.sendingKey, nonce);
      const encrypted = cipher.encrypt(chunkData);

      chunks.push({
        type: 'file_chunk',
        fileId,
        index: i,
        nonce: Buffer.from(nonce).toString('base64'),
        data: Buffer.from(encrypted).toString('base64'),
        hash,
      });
    }

    return chunks;
  }

  // Length-prefixed message: [4 bytes length][JSON data]
  #encodeMessage(message: FileTransferMessage): Uint8Array {
    const json = JSON.stringify(message);
    const jsonBytes = new TextEncoder().encode(json);
    const result = new Uint8Array(4 + jsonBytes.length);
    const view = new DataView(result.buffer);
    view.setUint32(0, jsonBytes.length, false); // big-endian
    result.set(jsonBytes, 4);
    return result;
  }

  #decodeMessage(data: Uint8Array): { message: FileTransferMessage; bytesRead: number } | null {
    if (data.length < 4) return null;
    const view = new DataView(data.buffer, data.byteOffset);
    const length = view.getUint32(0, false);
    if (data.length < 4 + length) return null;
    const jsonBytes = data.slice(4, 4 + length);
    const json = new TextDecoder().decode(jsonBytes);
    try {
      return { message: JSON.parse(json) as FileTransferMessage, bytesRead: 4 + length };
    } catch (error: unknown) {
      console.warn(`[FILE][DECODE][PARSE_ERROR] frameLength=${length} bufferLength=${data.length} err=${errStr(error, 'unknown')}`);
      throw error;
    }
  }

  async sendFile(targetUsername: string, filePath: string, providedFileId?: string, replyToCidInput?: string): Promise<void> {
    let chat: any = null;
    let fileId: string = '';
    let stream: Stream | null = null;
    let pinnedSessionPeerId: string | null = null;
    let activePeerId: string | null = null;
    try {
      const outgoingContext = await this.#createOutgoingTransferContext(targetUsername, filePath, providedFileId, replyToCidInput);
      const { chat: ensuredChat, session, targetPeerId, targetPeerIdStr, metadata, fileId: preparedFileId, replyToCid } = outgoingContext;
      chat = ensuredChat;
      fileId = preparedFileId;
      pinnedSessionPeerId = targetPeerIdStr;
      if (!this.tryBeginPeerTransfer(targetPeerIdStr, fileId, 'send')) {
        throw new Error('Another file transfer is already active with this peer');
      }
      activePeerId = targetPeerIdStr;

      stream = await dialProtocolWithRelayFallback({
        node: this.node,
        database: this.database,
        targetPeerId,
        protocol: this.fileTransferProtocol,
        context: 'file_transfer_send',
      });
      this.trackTransferStream(fileId, stream);
      this.trace('SEND', targetPeerIdStr, fileId, 'STREAM_OPEN');

      const activeStream = stream;
      const writable = pushable();
      const sinkPromise = pipe(writable, activeStream.sink);
      let controlBuffer = new Uint8Array(0);
      const sourceIterator = activeStream.source[Symbol.asyncIterator]();
      const readNextControlMessage = async (): Promise<FileTransferMessage> => {
        for (;;) {
          let decoded: { message: FileTransferMessage; bytesRead: number } | null;
          try {
            decoded = this.#decodeMessage(controlBuffer);
          } catch (error: unknown) {
            this.trace('SEND', targetPeerIdStr, fileId, 'DECODE_ERROR', `bufferBytes=${controlBuffer.length} err=${errStr(error, 'unknown')}`);
            throw error;
          }
          if (decoded) {
            controlBuffer = controlBuffer.slice(decoded.bytesRead);
            return decoded.message;
          }

          const next = await sourceIterator.next();
          if (next.done) {
            this.trace('SEND', targetPeerIdStr, fileId, 'SOURCE_ENDED_WAITING_CONTROL', `bufferBytes=${controlBuffer.length}`);
            throw new Error('Stream closed before expected file transfer message');
          }

          const chunkData = (next.value as unknown as Uint8Array).subarray();
          const newBuffer = new Uint8Array(controlBuffer.length + chunkData.length);
          newBuffer.set(controlBuffer);
          newBuffer.set(chunkData, controlBuffer.length);
          controlBuffer = newBuffer;
        }
      };
      let transferQueued = false;

      try {
        await this.#persistOutgoingPendingTransferMessage(chat.id, fileId, metadata, replyToCid);
        const offer = this.#createSignedFileOffer(fileId, metadata, replyToCid);
        writable.push(this.#encodeMessage(offer));
        this.database.updateMessageTransfer(fileId, {
          transfer_status: 'awaiting_acceptance',
          transfer_progress: 0,
        });
        this.onOutgoingFileOfferPending({
          chatId: chat.id,
          messageId: fileId,
          expiresAt: offer.expiresAt,
        });
        this.trace('SEND', targetPeerIdStr, fileId, 'OFFER_SENT', `size=${metadata.size} chunks=${metadata.totalChunks}`);

        const readNextMessage = async (): Promise<FileTransferMessage> => {
          return readNextControlMessage();
        };

        const readOfferResponse = async (): Promise<FileOfferResponse> => {
          for (;;) {
            const message = await readNextMessage();
            if (message.type === FILE_OFFER_RESPONSE && message.fileId === fileId) {
              return message;
            }
            if (message.type === FILE_TRANSFER_CONFIRM && message.fileId === fileId && !message.success) {
              throw new Error(message.error || 'File transfer failed before acceptance');
            }
          }
        };

        const response = await this.#awaitFileOfferResponse(readOfferResponse);

        if (!response.accepted) {
          const reason = response.reason || 'Rejected';
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'rejected',
            transfer_progress: 0,
            transfer_error: `Offer rejected: ${reason}`
          });
          throw new Error(`File rejected: ${reason}`);
        }
        this.trace('SEND', targetPeerIdStr, fileId, 'OFFER_ACCEPTED');
        this.messageHandler.getSessionManager().updateSessionUsage(targetPeerIdStr);
        this.database.updateMessageTransfer(fileId, {
          transfer_status: 'in_progress',
          transfer_progress: 0,
        });
        await this.#sendEncryptedFileChunks({
          writable,
          targetPeerIdStr,
          fileId,
          chatId: chat.id,
          metadata,
          session,
        });
        transferQueued = true;
      } finally {
        this.trace('SEND', targetPeerIdStr, fileId, 'WRITABLE_END');
        writable.end();
        await sinkPromise;
        this.trace('SEND', targetPeerIdStr, fileId, 'SINK_RESOLVED');
      }

      if (transferQueued) {
        const completedTransfer = await this.#awaitOutgoingTransferConfirmation({
          readNextControlMessage,
          targetPeerIdStr,
          fileId,
          chatId: chat.id,
          metadata,
          filePath,
        });

        if (this.onFileTransferComplete) {
          this.onFileTransferComplete({
            chatId: chat.id,
            messageId: completedTransfer.messageId,
            filePath: completedTransfer.filePath // For sender, filePath is the source file
          });
        }
      }
    } catch (error: unknown) {
      const errorText = errStr(error, 'Unknown error');
      this.trace('SEND', activePeerId ?? '', fileId || null, 'ERROR', `err=${errorText}`);
      if ((errorText.toLowerCase().includes('timeout waiting for file acceptance') || errorText.toLowerCase().includes('timeout waiting for transfer confirmation')) && stream) {
        try {
          stream.abort(new Error('File transfer timeout'));
        } catch {
          // best-effort stream cleanup
        }
      }
      if (fileId) {
        if (errorText.toLowerCase().includes('timeout waiting for file acceptance')) {
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'expired',
            transfer_progress: 0,
            transfer_error: 'Offer expired'
          });
        } else if (errorText.toLowerCase().includes('file rejected')) {
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'rejected',
            transfer_progress: 0,
            transfer_error: errorText
          });
        } else {
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'failed',
            transfer_progress: 0,
            transfer_error: errorText
          });
        }
      }
      if (this.onFileTransferFailed && chat) {
        this.onFileTransferFailed({
          chatId: chat.id,
          messageId: fileId,
          error: errorText
        });
      }

      generalErrorHandler(error);
      throw error;
    } finally {
      this.trace('SEND', activePeerId ?? '', fileId || null, 'FINALIZE');
      if (activePeerId && fileId) {
        this.endPeerTransfer(activePeerId, fileId);
      }
      if (fileId) {
        this.untrackTransferStream(fileId);
      }
      if (pinnedSessionPeerId) {
        this.messageHandler.getSessionManager().unpinSession(pinnedSessionPeerId);
      }
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

    for (const [fileId, pending] of this.pendingFileAcceptances.entries()) {
      try {
        pending.decision = 'shutdown';
        pending.resolve(false);
      } catch {
        // no-op
      } finally {
        this.pendingFileAcceptances.delete(fileId);
      }
    }

    const failed = this.database.failNonTerminalFileTransfers('Transfer interrupted (app shutdown)');
    if (failed > 0) {
      console.log(`[FileHandler] Shutdown cleanup marked ${failed} transfer(s) as failed`);
    }
  }

  async #createOutgoingTransferContext(
    targetUsername: string,
    filePath: string,
    providedFileId?: string,
    replyToCidInput?: string,
  ): Promise<OutgoingFileTransferContext> {
    const { session, peerId: targetPeerId } = await this.messageHandler.ensureUserSession(targetUsername, '', true);
    const targetPeerIdStr = targetPeerId.toString();
    if (!this.messageHandler.getSessionManager().pinSession(targetPeerIdStr)) {
      throw new Error('No active session');
    }
    this.messageHandler.getSessionManager().updateSessionUsage(targetPeerIdStr);
    const chat = this.database.getChatByPeerId(targetPeerIdStr);
    if (chat?.type !== 'direct' || !chat.id) throw new Error('Chat not found');

    // Validate file size before loading metadata
    const fileStats = await stat(filePath);
    const maxFileSize = this.getMaxFileSize();
    if (fileStats.size > maxFileSize) {
      throw new Error(`File too large (${fileStats.size} bytes, max ${maxFileSize} bytes)`);
    }
    if (fileStats.size <= 0) {
      throw new Error('File is empty');
    }

    const metadata = await this.#loadFileMetadata(filePath);
    const fileId = providedFileId && providedFileId.trim() ? providedFileId : randomUUID();
    const replyToCid = isValidCid(replyToCidInput) ? replyToCidInput : undefined;

    return {
      chat,
      session,
      targetPeerId,
      targetPeerIdStr,
      metadata,
      fileId,
      replyToCid,
    };
  }

  async #persistOutgoingPendingTransferMessage(chatId: number, fileId: string, metadata: FileMetadata, replyToCid?: string): Promise<void> {
    await this.database.createMessage({
      id: fileId,
      client_msg_id: fileId,
      reply_to_client_id: replyToCid ?? null,
      chat_id: chatId,
      sender_peer_id: this.node.peerId.toString(),
      content: `${metadata.filename} (${metadata.size} bytes)`,
      message_type: 'file',
      file_name: metadata.filename,
      file_size: metadata.size,
      transfer_status: 'connecting',
      transfer_progress: 0,
      timestamp: new Date(),
    });
  }

  async #sendEncryptedFileChunks(params: {
    writable: ReturnType<typeof pushable<Uint8Array>>;
    targetPeerIdStr: string;
    fileId: string;
    chatId: number;
    metadata: FileMetadata;
    session: ConversationSession;
  }): Promise<void> {
    const { writable, targetPeerIdStr, fileId, chatId, metadata, session } = params;

    // Send chunks sequentially
    const chunks = this.#createEncryptedChunks(metadata.buffer, fileId, session);
    let lastEmittedPercentage = 0;
    for (const chunk of chunks) {
      writable.push(this.#encodeMessage(chunk));
      this.messageHandler.getSessionManager().updateSessionUsage(targetPeerIdStr);

      // Emit progress event (throttled: first 5 chunks, then every 10%)
      if (this.onFileTransferProgress) {
        const { shouldEmit, newPercentage } = this.#shouldEmitProgress(
          chunk.index + 1,
          chunks.length,
          lastEmittedPercentage
        );
        if (shouldEmit) {
          lastEmittedPercentage = newPercentage;
          const progress = Math.floor(((chunk.index + 1) / chunks.length) * 100);
          this.database.updateMessageTransfer(fileId, {
            transfer_status: 'in_progress',
            transfer_progress: progress,
          });
          this.onFileTransferProgress({
            chatId,
            messageId: fileId,
            current: chunk.index + 1,
            total: chunks.length,
            filename: metadata.filename,
            size: metadata.size
          });
        }
      }
    }

    this.trace('SEND', targetPeerIdStr, fileId, 'ALL_CHUNKS_SENT');
  }

  #createSignedFileOffer(
    fileId: string,
    metadata: FileMetadata,
    replyToCid?: string,
  ): FileOffer & { timestamp: number; expiresAt: number; signature: string } {
    const timestamp = Date.now();
    const expiresAt = timestamp + FILE_ACCEPTANCE_TIMEOUT;
    const offer: FileOffer & { timestamp: number; expiresAt: number } = {
      type: FILE_OFFER,
      fileId,
      filename: metadata.filename,
      mimeType: metadata.mimeType,
      size: metadata.size,
      checksum: metadata.checksum,
      totalChunks: metadata.totalChunks,
      ...(replyToCid ? { replyToCid } : {}),
      timestamp,
      expiresAt,
    };
    const userIdentity = this.messageHandler.getUserIdentity();
    if (!userIdentity) {
      throw new Error('No user identity available');
    }
    const offerPayload = this.buildSignedFileOfferPayload(offer);
    const signature = userIdentity.sign(JSON.stringify(offerPayload));
    return {
      ...offer,
      signature: Buffer.from(signature).toString('base64'),
    };
  }

  async #awaitFileOfferResponse(readOfferResponse: () => Promise<FileOfferResponse>): Promise<FileOfferResponse> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => { reject(new Error('Timeout waiting for file acceptance')); }, FILE_ACCEPTANCE_TIMEOUT);
    });

    try {
      return await Promise.race([readOfferResponse(), timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async #awaitOutgoingTransferConfirmation(params: {
    readNextControlMessage: () => Promise<FileTransferMessage>;
    targetPeerIdStr: string;
    fileId: string;
    chatId: number;
    metadata: FileMetadata;
    filePath: string;
  }): Promise<OutgoingTransferResult> {
    const { readNextControlMessage, targetPeerIdStr, fileId, chatId, metadata, filePath } = params;

    this.database.updateMessageTransfer(fileId, {
      file_name: metadata.filename,
      file_size: metadata.size,
      file_path: filePath,
      transfer_status: 'in_progress',
      transfer_progress: 100
    });

    this.trace('SEND', targetPeerIdStr, fileId, 'WAITING_CONFIRM');
    let confirmTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const confirmTimeoutPromise = new Promise<never>((_, reject) => {
      confirmTimeoutId = setTimeout(
        () => reject(new Error('Timeout waiting for transfer confirmation')),
        CHUNK_RECEIVE_TIMEOUT
      );
    });

    let transferConfirm: FileTransferConfirm;
    try {
      const readTransferConfirm = async (): Promise<FileTransferConfirm> => {
        for (;;) {
          const message = await readNextControlMessage();
          if (message.type === FILE_TRANSFER_CONFIRM && message.fileId === fileId) {
            return message;
          }
          if (message.type === FILE_OFFER_RESPONSE && message.fileId === fileId && !message.accepted) {
            throw new Error(message.reason || 'Transfer rejected after acceptance');
          }
        }
      };

      transferConfirm = await Promise.race([readTransferConfirm(), confirmTimeoutPromise]);
    } finally {
      if (confirmTimeoutId) {
        clearTimeout(confirmTimeoutId);
      }
    }

    if (!transferConfirm.success) {
      throw new Error(transferConfirm.error || 'Recipient failed to save file');
    }
    this.trace('SEND', targetPeerIdStr, fileId, 'CONFIRM_SUCCESS_RECEIVED');

    const messageId = fileId;
    this.database.updateMessageTransfer(messageId, {
      file_name: metadata.filename,
      file_size: metadata.size,
      file_path: filePath,
      transfer_status: 'completed',
      transfer_progress: 100
    });

    return {
      filePath,
      messageId,
      filename: metadata.filename,
      size: metadata.size,
    };
  }

  async #evaluateIncomingFileOffer(
    senderPeerId: string,
    offerMsg: FileOffer,
  ): Promise<IncomingOfferEvaluation> {
    // Global pending files limit
    const maxPendingTotal = this.getMaxPendingFilesTotal();
    if (this.getTotalPendingFiles() >= maxPendingTotal) {
      this.globalPendingRejectionsCount++;

      // After N rejections, switch to silent rejection (save bandwidth)
      const silentThreshold = this.getSilentRejectionThresholdGlobal();
      if (this.globalPendingRejectionsCount > silentThreshold) {
        return { kind: 'silent-reject' };
      }

      // Normal rejection (first 20 times)
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=too_many_pending_total current=${this.getTotalPendingFiles()} limit=${maxPendingTotal}`);
      return { kind: 'reject', reason: 'Too many pending file transfers' };
    }

    // Per-peer pending files limit
    const pendingFromPeer = this.getPendingFilesFromPeer(senderPeerId);
    const maxPendingPerPeer = this.getMaxPendingFilesPerPeer();
    if (pendingFromPeer >= maxPendingPerPeer) {
      const rejectionCount = (this.perPeerPendingRejections.get(senderPeerId) ?? 0) + 1;
      this.perPeerPendingRejections.set(senderPeerId, rejectionCount);

      // After N rejections to this peer, switch to silent rejection (save bandwidth)
      const silentThreshold = this.getSilentRejectionThresholdPerPeer();
      if (rejectionCount > silentThreshold) {
        return { kind: 'silent-reject' };
      }

      // Normal rejection (first 5 times)
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=too_many_pending_from_peer current=${pendingFromPeer} limit=${maxPendingPerPeer}`);
      return { kind: 'reject', reason: 'Too many pending files from you' };
    }

    // Rate limiting check (offers per minute)
    if (this.isFileOfferRateLimitExceeded(senderPeerId)) {
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=rate_limit_exceeded`);
      return { kind: 'reject', reason: 'Rate limit exceeded' };
    }

    // Track this file offer
    this.trackFileOffer(senderPeerId);

    // Validate filename - reject path traversal attempts
    const sanitizedFilename = basename(offerMsg.filename);
    if (sanitizedFilename !== offerMsg.filename) {
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=invalid_filename_path_traversal`);
      return { kind: 'reject', reason: 'Invalid filename' };
    }

    // Validate filename length
    if (sanitizedFilename.length > 255 || sanitizedFilename.length === 0) {
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=invalid_filename_length`);
      return { kind: 'reject', reason: 'Invalid filename length' };
    }

    const sender = this.database.getUserByPeerId(senderPeerId);
    if (!sender) {
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=sender_not_in_contacts`);
      return { kind: 'reject', reason: 'Sender not in contacts' };
    }

    // Validate file size
    const maxFileSize = this.getMaxFileSize();
    if (offerMsg.size > maxFileSize || offerMsg.size <= 0) {
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=invalid_size size=${offerMsg.size} max=${maxFileSize}`);
      return { kind: 'reject', reason: 'File size invalid' };
    }

    // Validate totalChunks
    const expectedChunks = Math.ceil(offerMsg.size / CHUNK_SIZE);
    if (offerMsg.totalChunks !== expectedChunks || offerMsg.totalChunks <= 0) {
      console.warn(`[FILE][OFFER][REJECT] peer=*${senderPeerId.slice(-8)} reason=invalid_chunk_count expected=${expectedChunks} actual=${offerMsg.totalChunks}`);
      return { kind: 'reject', reason: 'Invalid chunk count' };
    }

    // Drop silently on malformed/unsigned offers to avoid helping attackers.
    if (!offerMsg.signature || !offerMsg.timestamp || !offerMsg.expiresAt) {
      return { kind: 'silent-reject' };
    }

    // Reject stale/replayed offers before any expensive work.
    const now = Date.now();
    if (offerMsg.expiresAt <= now || offerMsg.timestamp > now + 60_000) {
      return { kind: 'silent-reject' };
    }

    if (this.database.messageExists(offerMsg.fileId)) {
      return { kind: 'silent-reject' };
    }

    if (!sender.signing_public_key) {
      return { kind: 'silent-reject' };
    }

    if (!this.isFileOfferSignatureValid(offerMsg, sender.signing_public_key)) {
      return { kind: 'silent-reject' };
    }

    if (this.isPeerTransferActive(senderPeerId)) {
      return { kind: 'reject', reason: 'Another file transfer is already active with this peer' };
    }

    // Require an existing direct chat and active session before accepting file transfers.
    // We intentionally send an explicit rejection so sender does not hang waiting for response.
    const chat = this.database.getChatByPeerId(senderPeerId);
    const session = this.messageHandler.getSessionManager().getSession(senderPeerId);
    if (!chat || !session) {
      return { kind: 'reject', reason: 'No active session' };
    }
    if (!this.messageHandler.getSessionManager().pinSession(senderPeerId)) {
      return { kind: 'reject', reason: 'No active session' };
    }
    this.messageHandler.getSessionManager().updateSessionUsage(senderPeerId);

    return {
      kind: 'ready',
      sender,
      chat,
      session,
      pinnedSessionPeerId: senderPeerId,
      expiresAt: offerMsg.expiresAt ?? (Date.now() + FILE_ACCEPTANCE_TIMEOUT),
    };
  }

  async #persistPendingIncomingOffer(
    offerMsg: FileOffer,
    senderPeerId: string,
    sender: User,
    chat: Chat,
    expiresAt: number,
  ): Promise<void> {
    // Persist pending offer as a message (single row per file)
    await this.database.createMessage({
      id: offerMsg.fileId,
      client_msg_id: offerMsg.fileId,
      reply_to_client_id: offerMsg.replyToCid ?? null,
      chat_id: chat.id,
      sender_peer_id: senderPeerId,
      content: `${offerMsg.filename} (${offerMsg.size} bytes)`,
      message_type: 'file',
      file_name: offerMsg.filename,
      file_size: offerMsg.size,
      transfer_status: 'incoming_pending_user',
      transfer_progress: 0,
      timestamp: new Date(),
    });

    // Emit pending file received event
    if (this.onPendingFileReceived) {
      this.onPendingFileReceived({
        chatId: chat.id,
        fileId: offerMsg.fileId,
        filename: offerMsg.filename,
        size: offerMsg.size,
        senderId: senderPeerId,
        senderUsername: sender.username,
        expiresAt,
        ...(offerMsg.replyToCid ? { replyToClientId: offerMsg.replyToCid } : {}),
      });
    }
  }

  async #waitForIncomingOfferDecision(
    offerMsg: FileOffer,
    senderPeerId: string,
    senderUsername: string,
    expiresAt: number,
  ): Promise<IncomingOfferDecision> {
    const acceptancePromise = new Promise<boolean>((resolve, reject) => {
      this.pendingFileAcceptances.set(offerMsg.fileId, {
        resolve,
        reject,
        offer: offerMsg,
        senderId: senderPeerId,
        senderUsername,
        expiresAt
      });
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<boolean>((resolve) => {
      const msUntilExpire = Math.max(0, expiresAt - Date.now());
      timeoutId = setTimeout(() => {
        const pending = this.pendingFileAcceptances.get(offerMsg.fileId);
        if (pending) {
          pending.decision = 'expired';
        }
        resolve(false);
      }, msUntilExpire);
    });

    const accepted = await Promise.race([acceptancePromise, timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (accepted) {
      return { accepted: true, decision: 'accepted' };
    }

    const pending = this.pendingFileAcceptances.get(offerMsg.fileId);
    return {
      accepted: false,
      decision: pending?.decision ?? 'expired',
    };
  }
}
