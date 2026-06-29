import { ChatNode, FileTransferProgressEvent, FileTransferCompleteEvent, FileTransferFailedEvent, OutgoingFileOfferPendingEvent, OutgoingFileOfferTerminalEvent, PendingFileReceivedEvent, PendingFileOfferDeferredEvent, PendingFileInboxSnapshot, StreamHandlerContext } from "../types";
import type { Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { ChatDatabase } from "../db/database";
import { readFile, stat } from "fs/promises";
import { basename } from "path";
import { blake3 } from "@napi-rs/blake-hash";
import { randomUUID } from "crypto";
import mime from "mime-types";
import {
  CHUNK_SIZE, MAX_FILE_SIZE, FILE_OFFER_RATE_LIMIT, FILE_OFFER_RATE_LIMIT_WINDOW,
  MAX_PENDING_FILES_PER_PEER, MAX_PENDING_FILES_TOTAL, MAX_ACTIVE_FILE_OFFERS_PER_CHAT,
  MAX_CONCURRENT_FILE_SERVES, MAX_CONCURRENT_FILE_SERVES_PER_PEER,
  MAX_PREAUTH_STREAMS_GLOBAL, MAX_PREAUTH_STREAMS_PER_PEER,
  FILE_PULL_FIRST_FRAME_TIMEOUT_FAST, FILE_PULL_FIRST_FRAME_TIMEOUT_ANON,
  FILE_PULL_AUTH_TIMEOUT_FAST, FILE_PULL_AUTH_TIMEOUT_ANON, FILE_PULL_CONFIRM_TIMEOUT,
  CHUNK_RECEIVE_TIMEOUT, CHUNK_IDLE_TIMEOUT, NETWORK_MODES, getNetworkModeRuntime,
} from "../constants.js";
import { MessageHandler } from "./message-handler.js";
import { ServedFileRegistry, type ServedFileMeta } from "./served-file-registry.js";
import { LeasePool, type Lease } from "./lease-pool.js";
import { FrameStreamReader } from "./frame-stream.js";
import { ChunkReassembler, createFileChunks, encodePullFrame } from "./file-transfer.js";
import { resolveConfiguredDownloadsDirectory, writeFileWithCopySuffix } from "./file-storage.js";
import { StreamHandler } from "../transport/stream-handler.js";
import { dialProtocolWithRelayFallback } from "../transport/protocol-dialer.js";
import { errStr, generalErrorHandler } from "../utils/general-error.js";
import { EncryptedUserIdentity } from "../identity/encrypted-user-identity.js";
import { isDebugModeEnabled, log } from "../../shared/logger.js";
import {
  MESSAGE_ENVELOPE_VERSION,
  isValidCid,
  type FileOfferApplicationPayload,
  type FileOfferCancelApplicationPayload,
  type FileOfferNackApplicationPayload,
  type FileOfferNackReason,
} from "../protocol/message-envelope.js";
import type { InboundApplicationMessageContext } from "../protocol/application-message.js";
import {
  createFileOfferSignaturePayload,
  validateIncomingFileOffer,
} from "../protocol/file-offer-validation.js";
import {
  createFileOfferCancelSignaturePayload,
  createFileOfferNackSignaturePayload,
  getFileOfferNackOutcome,
  validateFileOfferCancel,
  validateFileOfferNack,
} from "../protocol/file-offer-control.js";
import {
  PullChallengeStore,
  createFilePullAuthSignaturePayload,
  evaluateFilePullAuth,
  isFileChunk,
  isFilePullAuth,
  isFilePullChallenge,
  isFilePullInit,
  isFilePullReject,
  isFileTransferConfirm,
  type FileTransferConfirmReason,
  type FilePullRejectReason,
} from "../protocol/file-pull-protocol.js";

interface FileMetadata {
  buffer: Buffer
  filename: string
  mimeType: string
  size: number
  checksum: string
  totalChunks: number
}

type ServeGateDecision =
  | { kind: 'reject'; reason: FilePullRejectReason }
  | {
    kind: 'serve';
    buffer: Buffer;
    chatId: number;
    fileId: string;
    filename: string;
    size: number;
    totalChunks: number;
    isGroup: boolean;
  };

type IncomingPullClaim = NonNullable<ReturnType<ChatDatabase['claimIncomingFilePull']>>;

type PullAuthFrame =
  | {
    type: 'file_pull_auth';
    offerId: string;
    senderPeerId: string;
    requesterPeerId: string;
    challenge: string;
    signature: string;
  }
  | null;

type PullConfirmFrame =
  | {
    type: 'file_transfer_confirm';
    offerId: string;
    success: boolean;
    reason?: FileTransferConfirmReason;
  }
  | null;

const FILE_PULL_INTERRUPTED_CONFIRM_GRACE_MS = 1500;

export class FileHandler {
  private static readonly TRACE_ENABLED = isDebugModeEnabled();
  private node: ChatNode;
  private messageHandler: MessageHandler;
  private database: ChatDatabase;
  private fileOfferTimestamps = new Map<string, number[]>();
  private fileOfferRateLimitNackAt = new Map<string, number>();
  private servedFiles = new ServedFileRegistry(MAX_ACTIVE_FILE_OFFERS_PER_CHAT);
  private pullChallenges = new PullChallengeStore();
  private preAuthLeases = new LeasePool(MAX_PREAUTH_STREAMS_GLOBAL, MAX_PREAUTH_STREAMS_PER_PEER);
  private serveLeases = new LeasePool(MAX_CONCURRENT_FILE_SERVES, MAX_CONCURRENT_FILE_SERVES_PER_PEER);
  private servingDirectOffers = new Set<string>(); // direct offerIds with a serve in flight
  private servingGroupOfferPullers = new Map<string, Set<string>>(); // offerId -> requester peerIds
  private activeServeStreams = new Set<Stream>();
  private activeServeTasks = new Set<Promise<void>>();
  private shuttingDown = false;
  private readonly fileTransferProtocol: string;
  private activeTransfersByPeer = new Map<string, { fileId: string; direction: 'send' | 'receive' }>();
  private activeTransferStreams = new Map<string, Stream>();
  private activeIncomingCancelSignals = new Map<string, () => Promise<boolean>>();
  private canceledIncomingDownloads = new Set<string>();
  private onFileTransferProgress: (data: FileTransferProgressEvent) => void;
  private onFileTransferComplete: (data: FileTransferCompleteEvent) => void;
  private onFileTransferFailed: (data: FileTransferFailedEvent) => void;
  private onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void;
  private onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => void;
  private onPendingFileReceived: (data: PendingFileReceivedEvent) => void;
  private onPendingFileOfferDeferred: (data: PendingFileOfferDeferredEvent) => void;

  constructor(
    node: ChatNode,
    messageHandler: MessageHandler,
    database: ChatDatabase,
    onFileTransferProgress: (data: FileTransferProgressEvent) => void,
    onFileTransferComplete: (data: FileTransferCompleteEvent) => void,
    onFileTransferFailed: (data: FileTransferFailedEvent) => void,
    onOutgoingFileOfferPending: (data: OutgoingFileOfferPendingEvent) => void,
    onOutgoingFileOfferTerminal: (data: OutgoingFileOfferTerminalEvent) => void,
    onPendingFileReceived: (data: PendingFileReceivedEvent) => void,
    onPendingFileOfferDeferred: (data: PendingFileOfferDeferredEvent) => void
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
    this.onPendingFileOfferDeferred = onPendingFileOfferDeferred;
    this.fileTransferProtocol = getNetworkModeRuntime(this.database.getSessionNetworkMode()).config.fileTransferProtocol;
    const failedCount = this.database.failNonTerminalFileTransfers('Transfer interrupted (app restart/close)');
    if (failedCount > 0) {
      console.log(`[FileHandler] Marked ${failedCount} non-terminal file transfer(s) as failed on startup`);
    }
    this.#registerServeHandler();
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

  getPendingFileInboxSnapshot(): PendingFileInboxSnapshot {
    return this.database.getPendingFileInboxSnapshot({
      maxPendingFilesPerPeer: this.getMaxPendingFilesPerPeer(),
      maxPendingFilesTotal: this.getMaxPendingFilesTotal(),
    });
  }

  private trace(scope: 'SEND' | 'RECV' | 'CORE', peerId: string, fileId: string | null, event: string, extra?: string): void {
    if (!FileHandler.TRACE_ENABLED) return;
    const peerSuffix = peerId ? peerId.slice(-8) : 'unknown';
    const fileLabel = fileId && fileId.trim() ? fileId : 'n/a';
    const details = extra ? ` ${extra}` : '';
    log(`[FILE][TRACE][${scope}] peer=*${peerSuffix} file=${fileLabel} event=${event}${details}`);
  }

  private tempOfferDiag(event: string, details: string): void {
    // TEMP_LOG: temporary inbound file-offer diagnostics; remove after Phase 2a delivery debugging.
    log(`[TEMP_LOG][FILE-OFFER][RECV] event=${event} ${details}`);
  }

  private isOfferBeingServed(offerId: string): boolean {
    return this.servingDirectOffers.has(offerId)
      || ((this.servingGroupOfferPullers.get(offerId)?.size ?? 0) > 0);
  }

  private tryAcquireOfferServeLock(
    offerId: string,
    requesterPeerId: string,
    isGroup: boolean,
  ): { release: () => void } | null {
    let released = false;

    if (!isGroup) {
      if (this.servingDirectOffers.has(offerId)) {
        return null;
      }
      this.servingDirectOffers.add(offerId);
      return {
        release: () => {
          if (released) return;
          released = true;
          this.servingDirectOffers.delete(offerId);
        },
      };
    }

    let servingPullers = this.servingGroupOfferPullers.get(offerId);
    if (!servingPullers) {
      servingPullers = new Set<string>();
      this.servingGroupOfferPullers.set(offerId, servingPullers);
    }
    if (servingPullers.has(requesterPeerId)) {
      return null;
    }
    servingPullers.add(requesterPeerId);

    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.servingGroupOfferPullers.get(offerId);
        if (!current) return;
        current.delete(requesterPeerId);
        if (current.size === 0) {
          this.servingGroupOfferPullers.delete(offerId);
        }
      },
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

  /**
   * Claim the single rate-limit-NACK attempt allowed per window for this peer. Marking *before*
   * signature validation is deliberate and load-bearing: it bounds the expensive Ed25519 verify to
   * once per window, so an over-limit peer flooding malformed offers cannot force a verify per
   * offer. The cost is that a forged offer can burn that window's courtesy NACK — an acceptable
   * trade against the CPU-DoS. (Do not move the claim after validation.)
   */
  private claimRateLimitNackSlot(peerId: string): boolean {
    const now = Date.now();
    const lastClaim = this.fileOfferRateLimitNackAt.get(peerId) ?? 0;
    if (now - lastClaim < FILE_OFFER_RATE_LIMIT_WINDOW) {
      return false;
    }
    this.fileOfferRateLimitNackAt.set(peerId, now);
    return true;
  }

  /** True while this peer is still serving the given offer (slot occupied). */
  hasActiveOffer(offerId: string): boolean {
    return this.servedFiles.has(offerId);
  }

  // ── Sender serve handler (pull model) ──────────────────────────────────────────────────────

  #registerServeHandler(): void {
    void this.node.handle(this.fileTransferProtocol, (context: StreamHandlerContext) => {
      const { remoteId, stream } = StreamHandler.getRemotePeerInfo(context);
      if (this.shuttingDown || this.database.isBlocked(remoteId)) {
        try { stream.abort(new Error('serve unavailable')); } catch { /* best-effort */ }
        return;
      }
      // Pre-auth gate: bound concurrent unauthenticated handshake streams (global + per peer).
      const preAuthLease = this.preAuthLeases.tryAcquire(remoteId);
      if (!preAuthLease) {
        try { stream.abort(new Error('pull handshake capacity reached')); } catch { /* best-effort */ }
        return;
      }
      // Track the serve so cleanup() can abort it and wait for it to unwind before the DB closes.
      const task = (async () => {
        try {
          await this.#serveStream(remoteId, stream, preAuthLease);
        } catch (error: unknown) {
          this.trace('SEND', remoteId, null, 'SERVE_STREAM_FAILED', `err=${errStr(error, 'unknown')}`);
        } finally {
          preAuthLease.release(); // idempotent — already released at the auth hand-off on the serve path
          try { await stream.close(); } catch { /* best-effort */ }
        }
      })();
      this.activeServeStreams.add(stream);
      this.activeServeTasks.add(task);
      void task.finally(() => {
        this.activeServeStreams.delete(stream);
        this.activeServeTasks.delete(task);
      });
    }, { runOnLimitedConnection: true });
  }

  async #serveStream(remoteId: string, stream: Stream, preAuthLease: Lease): Promise<void> {
    const isAnon = this.database.getSessionNetworkMode() === NETWORK_MODES.ANONYMOUS;
    const reader = new FrameStreamReader(stream);
    const onProgress = this.onFileTransferProgress;

    const initFrame = await reader.readFrame(
      isAnon ? FILE_PULL_FIRST_FRAME_TIMEOUT_ANON : FILE_PULL_FIRST_FRAME_TIMEOUT_FAST,
    );
    if (!isFilePullInit(initFrame)) {
      try { stream.abort(new Error('expected file_pull_init')); } catch { /* best-effort */ }
      return;
    }
    const offerId = initFrame.offerId;
    const challenge = this.pullChallenges.issue(offerId);

    // The sink is driven by a single generator so chunks are pulled lazily (real backpressure):
    // it sends the challenge, parks on `gate` until auth is decided, then yields either a reject
    // frame or the chunks one at a time.
    let resolveGate: (decision: ServeGateDecision) => void = () => {};
    let gateSettled = false;
    const gate = new Promise<ServeGateDecision>((resolve) => { resolveGate = resolve; });
    const settle = (decision: ServeGateDecision): void => {
      if (!gateSettled) { gateSettled = true; resolveGate(decision); }
    };
    // Rearmed each time a chunk is accepted by the sink (i.e. drained); the one-shot idle watchdog
    // fires exactly CHUNK_IDLE_TIMEOUT after the last drained chunk (set up in the serve phase).
    const idle: { rearm: () => void } = { rearm: () => {} };

    const sinkDone = stream.sink((async function* () {
      yield encodePullFrame({ type: 'file_pull_challenge', offerId, challenge });
      const decision = await gate;
      if (decision.kind === 'reject') {
        yield encodePullFrame({ type: 'file_pull_reject', offerId, reason: decision.reason });
        return;
      }
      let index = 0;
      for (const chunk of createFileChunks(decision.buffer, offerId)) {
        yield encodePullFrame(chunk);
        idle.rearm();
        index += 1;
        if (!decision.isGroup) {
          onProgress({
            chatId: decision.chatId,
            messageId: decision.fileId,
            current: index,
            total: decision.totalChunks,
            filename: decision.filename,
            size: decision.size,
          });
        }
      }
    })());
    sinkDone.catch(() => undefined);

    let serveLease: Lease | null = null;
    let offerServeLock: { release: () => void } | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const authFrame = await reader.readFrame(isAnon ? FILE_PULL_AUTH_TIMEOUT_ANON : FILE_PULL_AUTH_TIMEOUT_FAST);
      if (!isFilePullAuth(authFrame)) {
        settle({ kind: 'reject', reason: 'unauthorized' });
        await sinkDone;
        return;
      }
      const decision = this.#decidePull(authFrame, remoteId, offerId, challenge);
      if (!decision.ok) {
        settle({ kind: 'reject', reason: decision.reason });
        await sinkDone;
        return;
      }

      const meta = this.servedFiles.getMeta(offerId);
      if (!meta) {
        settle({ kind: 'reject', reason: 'unavailable' });
        await sinkDone;
        return;
      }

      // Auth passed: take an offer serve lock plus a global/per-peer serve slot. Direct offers stay
      // single-serve; group offers allow concurrent different requesters but reject a duplicate
      // same-recipient pull for the same offer as `busy`.
      offerServeLock = this.tryAcquireOfferServeLock(offerId, authFrame.requesterPeerId, meta.isGroup);
      if (!offerServeLock) {
        settle({ kind: 'reject', reason: 'busy' });
        await sinkDone;
        return;
      }
      serveLease = this.serveLeases.tryAcquire(remoteId);
      if (!serveLease) {
        offerServeLock.release();
        offerServeLock = null;
        settle({ kind: 'reject', reason: 'busy' });
        await sinkDone;
        return;
      }
      preAuthLease.release();

      // Lazy re-read + verify against the offer-time snapshot.
      let buffer: Buffer;
      try {
        buffer = await readFile(meta.filePath);
      } catch {
        this.#failServedOffer(offerId, meta.fileId, meta.chatId, 'File no longer available');
        settle({ kind: 'reject', reason: 'source_changed' });
        await sinkDone;
        return;
      }
      if (buffer.length !== meta.size || blake3(buffer).toString('hex') !== meta.checksum) {
        this.#failServedOffer(offerId, meta.fileId, meta.chatId, 'File no longer available');
        settle({ kind: 'reject', reason: 'source_changed' });
        await sinkDone;
        return;
      }

      // Bound the serve two ways: a hard total cap, and a resettable one-shot chunk-idle watchdog
      // that fires CHUNK_IDLE_TIMEOUT after the last drained chunk (rearmed per chunk by the sink),
      // so a stalled puller is cut off at the idle bound — not after up to ~2× a polling interval.
      totalTimer = setTimeout(() => {
        try { stream.abort(new Error('total transfer timeout')); } catch { /* best-effort */ }
      }, CHUNK_RECEIVE_TIMEOUT);
      idle.rearm = (): void => {
        if (idleTimer) { clearTimeout(idleTimer); }
        idleTimer = setTimeout(() => {
          try { stream.abort(new Error('chunk idle timeout')); } catch { /* best-effort */ }
        }, CHUNK_IDLE_TIMEOUT);
      };
      idle.rearm(); // arm before the first chunk so an immediate stall is still bounded

      settle({
        kind: 'serve',
        buffer,
        chatId: meta.chatId,
        fileId: meta.fileId,
        filename: basename(meta.filePath),
        size: meta.size,
        totalChunks: Math.ceil(meta.size / CHUNK_SIZE),
        isGroup: meta.isGroup,
      });
      try {
        await sinkDone;
      } catch (error: unknown) {
        const applied = await this.#readAndApplyServeConfirm(
          reader,
          offerId,
          meta,
          authFrame.requesterPeerId,
          FILE_PULL_INTERRUPTED_CONFIRM_GRACE_MS,
        );
        if (!applied) {
          this.#resetServedOfferToAwaitingAcceptance(
            offerId,
            meta,
            'Recipient disconnected before confirming the transfer',
          );
          throw error;
        }
        return;
      }

      const applied = await this.#readAndApplyServeConfirm(
        reader,
        offerId,
        meta,
        authFrame.requesterPeerId,
        FILE_PULL_CONFIRM_TIMEOUT,
      );
      if (!applied) {
        this.#resetServedOfferToAwaitingAcceptance(
          offerId,
          meta,
          'Recipient did not confirm the transfer',
        );
      }
    } finally {
      if (totalTimer) { clearTimeout(totalTimer); }
      if (idleTimer) { clearTimeout(idleTimer); }
      idle.rearm = () => {}; // a late sink rearm after teardown must not resurrect the timer
      settle({ kind: 'reject', reason: 'unavailable' }); // unblock the generator if we errored pre-settle
      this.pullChallenges.discard(offerId, challenge);
      offerServeLock?.release();
      serveLease?.release();
      preAuthLease.release();
    }
  }

  #decidePull(
    auth: { offerId: string; requesterPeerId: string; challenge: string; signature: string; senderPeerId: string },
    remoteId: string,
    offerId: string,
    streamChallenge: string,
  ): { ok: true } | { ok: false; reason: FilePullRejectReason } {
    // Bind to THIS stream's exact challenge, not merely any outstanding one for the offer.
    if (auth.challenge !== streamChallenge) {
      return { ok: false, reason: 'unauthorized' };
    }
    const decision = evaluateFilePullAuth({
      auth: { type: 'file_pull_auth', ...auth },
      offerExists: !!this.servedFiles.getMeta(offerId),
      authorizedSigningKey: this.servedFiles.getAuthorizedKey(offerId, auth.requesterPeerId),
      localSenderPeerId: this.node.peerId.toString(),
      remotePeerId: remoteId,
      consumeChallenge: (oId, c) => this.pullChallenges.consume(oId, c),
      verifySignature: (sig, payload, key) => EncryptedUserIdentity.verifyKeyExchangeSignature(sig, payload, key),
    });
    return decision.ok ? { ok: true } : { ok: false, reason: decision.reason };
  }

  #failServedOffer(offerId: string, fileId: string, chatId: number, error: string): void {
    this.servedFiles.release(offerId);
    // CAS: only emit/transition if the row is still serving — a prior NACK terminal state wins.
    if (this.database.terminalizeServedFileIfActive(fileId, 'failed', 0, error)) {
      this.onFileTransferFailed({ chatId, messageId: fileId, error });
    }
  }

  #applyServeConfirm(
    offerId: string,
    meta: ServedFileMeta,
    requesterPeerId: string,
    confirmFrame: unknown,
  ): boolean {
    // The confirm must name THIS offer, with the success/reason invariant the guard enforces.
    if (!isFileTransferConfirm(confirmFrame) || confirmFrame.offerId !== offerId) {
      return false; // malformed/absent/cross-offer confirm: keep the offer (slot released in finally)
    }
    if (confirmFrame.success) {
      this.applySuccessfulServedPull(offerId, meta, requesterPeerId);
      return true;
    }
    if (confirmFrame.reason === 'integrity') {
      // The file itself is bad → the offer is dead.
      this.#failServedOffer(offerId, meta.fileId, meta.chatId, 'Recipient integrity check failed');
      return true;
    }
    if (confirmFrame.reason === 'canceled') {
      this.applyCanceledServedPull(offerId, meta, requesterPeerId);
      return true;
    }
    // disk/other failure: the recipient's local problem; keep the offer for a re-pull.
    this.#resetServedOfferToAwaitingAcceptance(
      offerId,
      meta,
      confirmFrame.reason === 'disk'
        ? 'Recipient could not save the file'
        : 'Recipient did not complete the transfer',
    );
    return true;
  }

  async #readAndApplyServeConfirm(
    reader: FrameStreamReader,
    offerId: string,
    meta: ServedFileMeta,
    requesterPeerId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      const confirmFrame = await reader.readFrame(timeoutMs);
      return this.#applyServeConfirm(offerId, meta, requesterPeerId, confirmFrame);
    } catch {
      return false;
    }
  }

  private applySuccessfulServedPull(
    offerId: string,
    meta: ServedFileMeta,
    requesterPeerId: string,
  ): void {
    if (!meta.isGroup) {
      this.servedFiles.release(offerId);
      if (this.database.terminalizeServedFileIfActive(meta.fileId, 'completed', 100, null)) {
        this.onFileTransferComplete({ chatId: meta.chatId, messageId: meta.fileId, filePath: meta.filePath });
      }
      return;
    }

    const result = this.servedFiles.removePuller(offerId, requesterPeerId);
    if (!result.removed) {
      return;
    }
    const counts = this.database.recordGroupServedFileDownloadIfActive(meta.fileId);
    if (result.emptied) {
      const completed = counts?.completed ?? meta.authorizedPullerCount ?? 0;
      const total = counts?.total ?? meta.authorizedPullerCount ?? completed;
      const status = completed >= total ? 'completed' : 'partially_completed';
      if (this.database.terminalizeServedFileIfActive(meta.fileId, status, 100, null)) {
        this.onFileTransferComplete({
          chatId: meta.chatId,
          messageId: meta.fileId,
          filePath: meta.filePath,
          status,
          groupDownloadTotal: total,
          groupDownloadCompleted: completed,
        });
      }
      return;
    }

    this.onOutgoingFileOfferPending({
      chatId: meta.chatId,
      messageId: meta.fileId,
      ...(counts ? {
        groupDownloadTotal: counts.total,
        groupDownloadCompleted: counts.completed,
      } : {}),
    });
  }

  private applyCanceledServedPull(
    offerId: string,
    meta: ServedFileMeta,
    requesterPeerId: string,
  ): void {
    if (!meta.isGroup) {
      // User intent on the recipient side is terminal for a direct offer.
      this.#failServedOffer(offerId, meta.fileId, meta.chatId, 'Recipient canceled the download');
      return;
    }

    const result = this.servedFiles.removePuller(offerId, requesterPeerId);
    if (!result.removed) {
      return;
    }
    if (result.emptied) {
      const row = this.database.getFileMessageById(meta.fileId);
      const completed = row?.file_group_download_completed ?? 0;
      const total = row?.file_group_download_total ?? meta.authorizedPullerCount ?? completed;
      if (completed > 0) {
        if (this.database.terminalizeServedFileIfActive(meta.fileId, 'partially_completed', 100, null)) {
          this.onFileTransferComplete({
            chatId: meta.chatId,
            messageId: meta.fileId,
            filePath: meta.filePath,
            status: 'partially_completed',
            groupDownloadTotal: total,
            groupDownloadCompleted: completed,
          });
        }
        return;
      }
      if (this.database.terminalizeServedFileIfActive(meta.fileId, 'cancelled', 0, 'Recipient canceled the download')) {
        this.onFileTransferFailed({
          chatId: meta.chatId,
          messageId: meta.fileId,
          error: 'Recipient canceled the download',
          status: 'cancelled',
        });
      }
      return;
    }

    const row = this.database.getFileMessageById(meta.fileId);
    this.onOutgoingFileOfferPending({
      chatId: meta.chatId,
      messageId: meta.fileId,
      ...(row?.file_group_download_total !== undefined && row.file_group_download_total !== null ? {
        groupDownloadTotal: row.file_group_download_total,
        groupDownloadCompleted: row.file_group_download_completed ?? 0,
      } : {}),
    });
  }

  #resetServedOfferToAwaitingAcceptance(
    offerId: string,
    meta: { fileId: string; chatId: number },
    error: string,
  ): void {
    if (!this.servedFiles.has(offerId)) {
      return;
    }
    this.onFileTransferFailed({
      chatId: meta.chatId,
      messageId: meta.fileId,
      error,
      status: 'awaiting_acceptance',
    });
  }

  acceptPendingFile(fileId: string): void {
    const claim = this.database.claimIncomingFilePull(fileId);
    if (!claim) {
      const message = this.database.getFileMessageById(fileId);
      if (message?.transfer_status === 'in_progress') {
        throw new Error('File download already in progress');
      }
      throw new Error('Pending file offer not found');
    }

    void this.#pullIncomingFile(claim);
  }

  rejectPendingFile(fileId: string): boolean {
    const rejected = this.database.rejectPendingIncomingFileOffer(fileId);
    if (!rejected) {
      return false;
    }

    const chat = this.database.getChats([rejected.chatId])[0];
    if (chat?.type === 'direct') {
      void this.#sendFileOfferNack(rejected.senderPeerId, rejected.offerId, 'declined');
    } else if (chat?.type === 'group' && chat.group_id) {
      void this.#sendGroupFileOfferNack(chat.group_id, rejected.offerId, 'declined');
    }
    return true;
  }

  async cancelOutgoingFileOffer(fileId: string): Promise<boolean> {
    const current = this.database.getFileMessageById(fileId);
    if (!current?.file_offer_id || this.isOfferBeingServed(current.file_offer_id)) {
      return false;
    }

    const chat = this.database.getChats([current.chat_id])[0];
    if (chat?.type === 'group' && chat.group_id) {
      const cancelled = this.database.cancelOutgoingGroupFileOffer({
        fileId,
        localPeerId: this.node.peerId.toString(),
      });
      if (!cancelled) {
        return false;
      }

      this.servedFiles.release(cancelled.offerId);
      void this.#sendGroupFileOfferCancel(cancelled.groupId, cancelled.offerId);
      if (cancelled.status === 'partially_completed') {
        this.onFileTransferComplete({
          chatId: cancelled.chatId,
          messageId: fileId,
          filePath: current.file_path ?? '',
          status: 'partially_completed',
          groupDownloadTotal: cancelled.groupDownloadTotal,
          groupDownloadCompleted: cancelled.groupDownloadCompleted,
        });
      } else {
        this.onOutgoingFileOfferTerminal({
          chatId: cancelled.chatId,
          messageId: fileId,
          filename: cancelled.filename,
          status: 'cancelled',
          error: 'Offer cancelled',
        });
      }
      return true;
    }

    const cancelled = this.database.cancelOutgoingFileOffer({
      fileId,
      localPeerId: this.node.peerId.toString(),
    });
    if (!cancelled) {
      return false;
    }

    this.servedFiles.release(cancelled.offerId);
    void this.#sendFileOfferCancel(cancelled.targetPeerId, cancelled.offerId);
    this.onOutgoingFileOfferTerminal({
      chatId: cancelled.chatId,
      messageId: fileId,
      filename: cancelled.filename,
      status: 'cancelled',
      error: 'Offer cancelled',
    });
    return true;
  }

  async cancelIncomingFileDownload(fileId: string): Promise<boolean> {
    const stream = this.activeTransferStreams.get(fileId);
    if (!stream) {
      return false;
    }

    const transferEntry = Array.from(this.activeTransfersByPeer.values()).find((entry) => entry.fileId === fileId);
    if (!transferEntry || transferEntry.direction !== 'receive') {
      return false;
    }

    if (!this.database.cancelIncomingFilePull(fileId, 'Download canceled by user')) {
      return false;
    }
    this.canceledIncomingDownloads.add(fileId);

    const sendCancelSignal = this.activeIncomingCancelSignals.get(fileId);
    if (sendCancelSignal) {
      await sendCancelSignal();
    }

    try {
      stream.abort(new Error('Download canceled by user'));
      this.trace('RECV', '', fileId, 'CANCEL_REQUESTED_BY_USER');
      return true;
    } catch (error: unknown) {
      this.trace('RECV', '', fileId, 'CANCEL_ABORT_FAILED', 'err=' + (errStr(error, 'unknown')));
      return true;
    }
  }

  async #pullIncomingFile(claim: IncomingPullClaim): Promise<void> {
    const isAnon = this.database.getSessionNetworkMode() === NETWORK_MODES.ANONYMOUS;
    const transferKey = `receive:${claim.messageId}`;
    let stream: Stream | null = null;
    let sinkDone: Promise<void> | null = null;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    let outcomeApplied = false;

    let authSettled = false;
    let resolveAuthGate: (frame: PullAuthFrame) => void = () => {};
    const authGate = new Promise<PullAuthFrame>((resolve) => { resolveAuthGate = resolve; });
    const settleAuth = (frame: PullAuthFrame): void => {
      if (!authSettled) {
        authSettled = true;
        resolveAuthGate(frame);
      }
    };

    let confirmSettled = false;
    let resolveConfirmGate: (frame: PullConfirmFrame) => void = () => {};
    const confirmGate = new Promise<PullConfirmFrame>((resolve) => { resolveConfirmGate = resolve; });
    const settleConfirm = (frame: PullConfirmFrame): void => {
      if (!confirmSettled) {
        confirmSettled = true;
        resolveConfirmGate(frame);
      }
    };

    try {
      if (claim.size <= 0 || claim.totalChunks <= 0) {
        outcomeApplied = true;
        this.#failIncomingPull(claim, 'Invalid file offer metadata');
        return;
      }

      try {
        stream = await dialProtocolWithRelayFallback({
          node: this.node,
          database: this.database,
          targetPeerId: peerIdFromString(claim.senderPeerId),
          protocol: this.fileTransferProtocol,
          context: 'file_pull',
        });
      } catch (error: unknown) {
        outcomeApplied = true;
        this.#resetIncomingPullToPending(claim, 'Sender offline');
        this.trace('RECV', claim.senderPeerId, claim.messageId, 'PULL_DIAL_FAILED', `err=${errStr(error, 'unknown')}`);
        return;
      }

      if (this.canceledIncomingDownloads.has(claim.messageId)) {
        outcomeApplied = true;
        return;
      }

      this.activeTransferStreams.set(claim.messageId, stream);
      this.activeTransfersByPeer.set(transferKey, { fileId: claim.messageId, direction: 'receive' });

      const reader = new FrameStreamReader(stream);
      sinkDone = stream.sink((async function* () {
        yield encodePullFrame({ type: 'file_pull_init', offerId: claim.offerId });
        const authFrame = await authGate;
        if (!authFrame) {
          return;
        }
        yield encodePullFrame(authFrame);
        const confirmFrame = await confirmGate;
        if (!confirmFrame) {
          return;
        }
        yield encodePullFrame(confirmFrame);
      })());
      sinkDone.catch(() => undefined);
      this.activeIncomingCancelSignals.set(claim.messageId, async () => {
        if (confirmSettled) {
          return false;
        }
        return this.#sendPullConfirmBestEffort(
          settleConfirm,
          sinkDone,
          { type: 'file_transfer_confirm', offerId: claim.offerId, success: false, reason: 'canceled' },
          FILE_PULL_INTERRUPTED_CONFIRM_GRACE_MS,
        );
      });

      const challengeFrame = await reader.readFrame(
        isAnon ? FILE_PULL_AUTH_TIMEOUT_ANON : FILE_PULL_AUTH_TIMEOUT_FAST,
      );
      if (!isFilePullChallenge(challengeFrame) || challengeFrame.offerId !== claim.offerId) {
        outcomeApplied = true;
        this.#failIncomingPull(claim, 'Invalid file transfer challenge');
        return;
      }

      const identity = this.messageHandler.getUserIdentity();
      if (!identity) {
        outcomeApplied = true;
        this.#resetIncomingPullToPending(claim, 'No user identity available');
        return;
      }
      const requesterPeerId = this.node.peerId.toString();
      const unsignedAuth = {
        offerId: claim.offerId,
        senderPeerId: claim.senderPeerId,
        requesterPeerId,
        challenge: challengeFrame.challenge,
      };
      const signature = identity.sign(JSON.stringify(createFilePullAuthSignaturePayload(unsignedAuth)));
      settleAuth({
        type: 'file_pull_auth',
        ...unsignedAuth,
        signature: Buffer.from(signature).toString('base64'),
      });

      totalTimer = setTimeout(() => {
        console.warn(
          `[FILE][PULL][RECV][TOTAL_TIMEOUT] peer=${claim.senderPeerId.slice(-8)} ` +
          `file=${claim.messageId} offer=${claim.offerId}`,
        );
        try { stream?.abort(new Error('total transfer timeout')); } catch { /* best-effort */ }
      }, CHUNK_RECEIVE_TIMEOUT);

      const reassembler = new ChunkReassembler({
        offerId: claim.offerId,
        totalChunks: claim.totalChunks,
        size: claim.size,
        checksum: claim.checksum,
      });

      for (;;) {
        const frame = await reader.readFrame(CHUNK_IDLE_TIMEOUT);
        if (isFilePullReject(frame)) {
          outcomeApplied = true;
          this.#applyPullReject(claim, frame.offerId === claim.offerId ? frame.reason : 'unauthorized');
          settleConfirm(null);
          await sinkDone.catch(() => undefined);
          return;
        }
        if (!isFileChunk(frame)) {
          await this.#sendPullConfirm(settleConfirm, sinkDone, { type: 'file_transfer_confirm', offerId: claim.offerId, success: false, reason: 'integrity' });
          outcomeApplied = true;
          this.#failIncomingPull(claim, 'Invalid file transfer frame');
          return;
        }

        const accepted = reassembler.accept(frame);
        if (!accepted.ok) {
          await this.#sendPullConfirm(settleConfirm, sinkDone, { type: 'file_transfer_confirm', offerId: claim.offerId, success: false, reason: 'integrity' });
          outcomeApplied = true;
          this.#failIncomingPull(claim, `File integrity check failed (${accepted.reason})`);
          return;
        }

        const current = frame.index + 1;
        this.database.updateIncomingFilePullProgress(
          claim.messageId,
          Math.min(99, Math.floor((current / claim.totalChunks) * 100)),
        );
        this.onFileTransferProgress({
          chatId: claim.chatId,
          messageId: claim.messageId,
          current,
          total: claim.totalChunks,
          filename: claim.fileName,
          size: claim.size,
        });

        if (accepted.complete) {
          break;
        }
      }

      const finalized = reassembler.finalize();
      if (!finalized.ok) {
        await this.#sendPullConfirm(settleConfirm, sinkDone, { type: 'file_transfer_confirm', offerId: claim.offerId, success: false, reason: 'integrity' });
        outcomeApplied = true;
        this.#failIncomingPull(claim, `File integrity check failed (${finalized.reason})`);
        return;
      }

      let savedPath: string;
      try {
        const downloadsDir = resolveConfiguredDownloadsDirectory(this.database.getSetting('downloads_directory'));
        savedPath = await writeFileWithCopySuffix(downloadsDir, claim.fileName, finalized.buffer);
      } catch (error: unknown) {
        await this.#sendPullConfirm(settleConfirm, sinkDone, { type: 'file_transfer_confirm', offerId: claim.offerId, success: false, reason: 'disk' });
        outcomeApplied = true;
        this.#resetIncomingPullToPending(claim, `Could not save file, retry: ${errStr(error, 'unknown')}`);
        return;
      }

      await this.#sendPullConfirm(settleConfirm, sinkDone, { type: 'file_transfer_confirm', offerId: claim.offerId, success: true });
      outcomeApplied = true;
      this.#completeIncomingPull(claim, savedPath);
      this.trace('RECV', claim.senderPeerId, claim.messageId, 'PULL_COMPLETED', `offer=${claim.offerId}`);
    } catch (error: unknown) {
      if (this.canceledIncomingDownloads.has(claim.messageId)) {
        outcomeApplied = true;
        return;
      }
      if (!outcomeApplied) {
        console.warn(
          `[FILE][PULL][RECV][INTERRUPTED] peer=${claim.senderPeerId.slice(-8)} ` +
          `file=${claim.messageId} offer=${claim.offerId} err=${errStr(error, 'unknown')}`,
        );
        this.#resetIncomingPullToPending(claim, 'Transfer interrupted');
      }
      this.trace('RECV', claim.senderPeerId, claim.messageId, 'PULL_FAILED', `offer=${claim.offerId} err=${errStr(error, 'unknown')}`);
    } finally {
      if (totalTimer) { clearTimeout(totalTimer); }
      settleAuth(null);
      settleConfirm(null);
      this.activeIncomingCancelSignals.delete(claim.messageId);
      this.activeTransferStreams.delete(claim.messageId);
      this.activeTransfersByPeer.delete(transferKey);
      this.canceledIncomingDownloads.delete(claim.messageId);
      if (stream) {
        try { await stream.close(); } catch { /* best-effort */ }
      }
    }
  }

  async #sendPullConfirm(
    settleConfirm: (frame: PullConfirmFrame) => void,
    sinkDone: Promise<void> | null,
    frame: Exclude<PullConfirmFrame, null>,
  ): Promise<void> {
    settleConfirm(frame);
    await sinkDone?.catch(() => undefined);
  }

  async #sendPullConfirmBestEffort(
    settleConfirm: (frame: PullConfirmFrame) => void,
    sinkDone: Promise<void> | null,
    frame: Exclude<PullConfirmFrame, null>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        this.#sendPullConfirm(settleConfirm, sinkDone, frame),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
      return !timedOut;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  #applyPullReject(claim: IncomingPullClaim, reason: FilePullRejectReason): void {
    switch (reason) {
      case 'busy':
        this.#resetIncomingPullToPending(claim, 'Offerer is busy currently, try again soon');
        return;
      case 'unavailable':
        this.#failIncomingPull(claim, 'File offer is no longer available');
        return;
      case 'source_changed':
        this.#failIncomingPull(claim, 'File no longer available');
        return;
      case 'unauthorized':
        this.#failIncomingPull(claim, 'File offer authorization failed');
        return;
    }
  }

  #resetIncomingPullToPending(claim: IncomingPullClaim, error: string): void {
    if (this.database.resetIncomingFilePullToPending(claim.messageId, error)) {
      this.onFileTransferFailed({
        chatId: claim.chatId,
        messageId: claim.messageId,
        error,
        status: 'incoming_pending_user',
      });
    }
  }

  #failIncomingPull(claim: IncomingPullClaim, error: string): void {
    if (this.database.failIncomingFilePull(claim.messageId, error)) {
      this.onFileTransferFailed({
        chatId: claim.chatId,
        messageId: claim.messageId,
        error,
        status: 'failed',
      });
    }
  }

  #completeIncomingPull(claim: IncomingPullClaim, filePath: string): void {
    if (this.database.completeIncomingFilePull(claim.messageId, filePath)) {
      this.onFileTransferComplete({
        chatId: claim.chatId,
        messageId: claim.messageId,
        filePath,
      });
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

  #createFileOfferNackPayload(
    offerId: string,
    reason: FileOfferNackReason,
  ): FileOfferNackApplicationPayload {
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
    return {
      ...unsignedNack,
      signature: Buffer.from(signature).toString('base64'),
    };
  }

  async #sendFileOfferNack(
    targetPeerId: string,
    offerId: string,
    reason: FileOfferNackReason,
  ): Promise<void> {
    try {
      const payload = this.#createFileOfferNackPayload(offerId, reason);
      await this.messageHandler.sendApplicationMessage(
        { type: 'direct', peerId: targetPeerId },
        {
          message: {
            cid: randomUUID(),
            kind: 'file_offer_nack',
            payload,
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

  async #sendGroupFileOfferNack(
    groupId: string,
    offerId: string,
    reason: FileOfferNackReason,
  ): Promise<void> {
    try {
      const payload = this.#createFileOfferNackPayload(offerId, reason);
      await this.messageHandler.sendApplicationMessage(
        { type: 'group', groupId },
        {
          message: {
            cid: randomUUID(),
            kind: 'file_offer_nack',
            payload,
          },
          persistence: { owner: 'none' },
        },
      );
      this.trace('SEND', groupId, null, 'GROUP_OFFER_NACK_SENT', `offer=${offerId} reason=${reason}`);
    } catch (error: unknown) {
      console.warn(
        `[FILE][NACK][GROUP_DELIVERY_FAILED] group=${groupId.slice(0, 8)} `
        + `offer=${offerId} reason=${reason} err=${errStr(error, 'unknown')}`,
      );
    }
  }

  #createFileOfferCancelPayload(offerId: string): FileOfferCancelApplicationPayload {
    const identity = this.messageHandler.getUserIdentity();
    if (!identity) {
      throw new Error('No user identity available');
    }
    const unsignedCancel = {
      type: 'file_offer_cancel' as const,
      offerId,
    };
    const signature = identity.sign(
      JSON.stringify(createFileOfferCancelSignaturePayload(unsignedCancel)),
    );
    return {
      ...unsignedCancel,
      signature: Buffer.from(signature).toString('base64'),
    };
  }

  async #sendFileOfferCancel(targetPeerId: string, offerId: string): Promise<void> {
    try {
      const payload = this.#createFileOfferCancelPayload(offerId);
      await this.messageHandler.sendApplicationMessage(
        { type: 'direct', peerId: targetPeerId },
        {
          message: {
            cid: randomUUID(),
            kind: 'file_offer_cancel',
            payload,
          },
          persistence: { owner: 'none' },
        },
      );
      this.trace('SEND', targetPeerId, null, 'OFFER_CANCEL_SENT', `offer=${offerId}`);
    } catch (error: unknown) {
      console.warn(
        `[FILE][CANCEL][DELIVERY_FAILED] peer=*${targetPeerId.slice(-8)} `
        + `offer=${offerId} err=${errStr(error, 'unknown')}`,
      );
    }
  }

  async #sendGroupFileOfferCancel(groupId: string, offerId: string): Promise<void> {
    try {
      const payload = this.#createFileOfferCancelPayload(offerId);
      await this.messageHandler.sendApplicationMessage(
        { type: 'group', groupId },
        {
          message: {
            cid: randomUUID(),
            kind: 'file_offer_cancel',
            payload,
          },
          persistence: { owner: 'none' },
        },
      );
      this.trace('SEND', groupId, null, 'GROUP_OFFER_CANCEL_SENT', `offer=${offerId}`);
    } catch (error: unknown) {
      console.warn(
        `[FILE][CANCEL][GROUP_DELIVERY_FAILED] group=${groupId.slice(0, 8)} `
        + `offer=${offerId} err=${errStr(error, 'unknown')}`,
      );
    }
  }

  #handleFileOfferCancel(
    context: InboundApplicationMessageContext,
    cancel: FileOfferCancelApplicationPayload,
  ): boolean {
    const isDirectRoute = context.route === 'direct_online' || context.route === 'direct_offline';
    const isGroupRoute = context.route === 'group_realtime' || context.route === 'group_offline';
    if (!isDirectRoute && !isGroupRoute) {
      return false;
    }
    const sender = this.database.getUserByPeerId(context.senderPeerId);
    if (!sender) {
      return true;
    }
    if (!validateFileOfferCancel({
      cancel,
      verifySignature: (signature, payload) => EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature,
        payload,
        sender.signing_public_key,
      ),
    })) {
      return true;
    }

    const chat = isDirectRoute
      ? this.database.getChatByPeerId(context.senderPeerId)
      : this.database.getChats([context.chatId])[0];
    if (!chat || (isDirectRoute && chat.type !== 'direct') || (isGroupRoute && chat.type !== 'group')) {
      return true;
    }

    this.database.recordFileOfferCancellationTombstone({
      offerId: cancel.offerId,
      senderPeerId: context.senderPeerId,
    });

    const cancelled = this.database.cancelPendingIncomingFileOfferByOfferId({
      offerId: cancel.offerId,
      chatId: chat.id,
      senderPeerId: context.senderPeerId,
    });
    if (!cancelled) {
      return true;
    }

    this.onFileTransferFailed({
      chatId: chat.id,
      messageId: cancelled.messageId,
      error: 'Offer cancelled',
      status: 'cancelled',
    });
    this.trace('RECV', context.senderPeerId, cancelled.messageId, 'OFFER_CANCEL_APPLIED', `offer=${cancel.offerId}`);
    return true;
  }

  #handleFileOfferNack(
    context: InboundApplicationMessageContext,
    nack: FileOfferNackApplicationPayload,
  ): boolean {
    const isDirectRoute = context.route === 'direct_online' || context.route === 'direct_offline';
    const isGroupRoute = context.route === 'group_realtime' || context.route === 'group_offline';
    if (!isDirectRoute && !isGroupRoute) {
      return false;
    }
    const sender = this.database.getUserByPeerId(context.senderPeerId);
    if (!sender) {
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

    if (isGroupRoute) {
      if (nack.reason !== 'declined') {
        return true;
      }
      const meta = this.servedFiles.getMeta(nack.offerId);
      if (
        !meta
        || !meta.isGroup
        || meta.chatId !== context.chatId
        || !this.servedFiles.getAuthorizedKey(nack.offerId, context.senderPeerId)
      ) {
        return true;
      }
      this.applyCanceledServedPull(nack.offerId, meta, context.senderPeerId);
      this.trace('RECV', context.senderPeerId, meta.fileId, 'GROUP_OFFER_NACK_APPLIED', `offer=${nack.offerId} reason=${nack.reason}`);
      return true;
    }

    const chat = this.database.getChatByPeerId(context.senderPeerId);
    if (!chat || chat.type !== 'direct') {
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

    // A direct offer is consumed by this terminal NACK; free its sender slot.
    this.servedFiles.release(nack.offerId);

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
    if (context.message.kind === 'file_offer_cancel') {
      return this.#handleFileOfferCancel(context, context.message.payload);
    }
    if (context.message.kind === 'file_offer_nack') {
      return this.#handleFileOfferNack(context, context.message.payload);
    }
    if (context.message.kind !== 'file_offer') {
      return false;
    }
    const isDirectRoute = context.route === 'direct_online' || context.route === 'direct_offline';
    const isGroupRoute = context.route === 'group_realtime' || context.route === 'group_offline';
    if (!isDirectRoute && !isGroupRoute) {
      this.tempOfferDiag(
        'drop_invalid_route',
        `route=${context.route} cid=${context.message.cid} peer=${context.senderPeerId.slice(-8)}`,
      );
      return false;
    }

    const offer = context.message.payload;
    this.tempOfferDiag(
      'start',
      `route=${context.route} chatId=${context.chatId} peer=${context.senderPeerId.slice(-8)} `
      + `cid=${context.message.cid} fileId=${offer.fileId} offer=${offer.offerId} `
      + `name=${offer.filename} size=${offer.size} chunks=${offer.totalChunks}`,
    );
    const chat = isDirectRoute
      ? this.database.getChatByPeerId(context.senderPeerId)
      : this.database.getChats([context.chatId])[0] ?? null;
    const sender = this.database.getUserByPeerId(context.senderPeerId);
    if (!chat || !sender) {
      this.tempOfferDiag(
        'drop_missing_context',
        `route=${context.route} cid=${context.message.cid} chatFound=${!!chat} senderFound=${!!sender}`,
      );
      return true;
    }
    if (isDirectRoute && chat.type !== 'direct') {
      this.tempOfferDiag(
        'drop_direct_chat_type_mismatch',
        `route=${context.route} cid=${context.message.cid} chatId=${chat.id} chatType=${chat.type}`,
      );
      return true;
    }
    if (isGroupRoute && chat.type !== 'group') {
      this.tempOfferDiag(
        'drop_group_chat_type_mismatch',
        `route=${context.route} cid=${context.message.cid} chatId=${chat.id} chatType=${chat.type}`,
      );
      return true;
    }
    if (isGroupRoute) {
      const participants = this.database.getChatParticipants(chat.id);
      if (!participants.some((participant) => participant.peer_id === context.senderPeerId)) {
        this.tempOfferDiag(
          'drop_sender_not_participant',
          `route=${context.route} cid=${context.message.cid} chatId=${chat.id} participants=${participants.length}`,
        );
        return true;
      }
    }
    if (chat.id !== context.chatId && isGroupRoute) {
      this.tempOfferDiag(
        'drop_group_chat_id_mismatch',
        `route=${context.route} cid=${context.message.cid} contextChatId=${context.chatId} resolvedChatId=${chat.id}`,
      );
      return true;
    }

    const existing = this.database.getFileMessageById(offer.fileId);
    if (existing) {
      this.tempOfferDiag(
        'drop_existing_row',
        `route=${context.route} cid=${context.message.cid} fileId=${offer.fileId} `
        + `existingChatId=${existing.chat_id} existingStatus=${existing.transfer_status ?? 'n/a'}`,
      );
      return true;
    }
    const pending = this.database.getPendingIncomingFileOffers()
      .filter((message) => !message.transfer_error);
    const pendingFromSender = pending.filter((message) => message.sender_peer_id === context.senderPeerId).length;
    const maxPendingTotal = this.getMaxPendingFilesTotal();
    const maxPendingPerPeer = this.getMaxPendingFilesPerPeer();
    const pendingCapacityFull =
      pending.length >= maxPendingTotal
      || pendingFromSender >= maxPendingPerPeer;
    this.tempOfferDiag(
      'capacity_snapshot',
      `route=${context.route} cid=${context.message.cid} pendingTotal=${pending.length}/${maxPendingTotal} `
      + `pendingFromSender=${pendingFromSender}/${maxPendingPerPeer} full=${pendingCapacityFull}`,
    );
    if (this.isFileOfferRateLimitExceeded(context.senderPeerId)) {
      if (isDirectRoute && this.claimRateLimitNackSlot(context.senderPeerId)) {
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
          if (this.database.hasFileOfferCancellationTombstone({
            offerId: offer.offerId,
            senderPeerId: context.senderPeerId,
          })) {
            this.tempOfferDiag(
              'drop_rate_limited_tombstone',
              `route=${context.route} cid=${context.message.cid} offer=${offer.offerId}`,
            );
            return true;
          }
          void this.#sendFileOfferNack(
            context.senderPeerId,
            offer.offerId,
            pendingCapacityFull ? 'inbox_full' : 'rate_limited',
          );
          this.tempOfferDiag(
            'drop_rate_limited_nack_sent',
            `route=${context.route} cid=${context.message.cid} offer=${offer.offerId} `
            + `reason=${pendingCapacityFull ? 'inbox_full' : 'rate_limited'}`,
          );
        } else {
          this.tempOfferDiag(
            'drop_rate_limited_invalid_offer',
            `route=${context.route} cid=${context.message.cid} offer=${offer.offerId} reason=${validation.reason}`,
          );
        }
      } else {
        this.tempOfferDiag(
          'drop_rate_limited_silent',
          `route=${context.route} cid=${context.message.cid} offer=${offer.offerId} isDirect=${isDirectRoute}`,
        );
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
      this.tempOfferDiag(
        'drop_validation_failed',
        `route=${context.route} cid=${context.message.cid} fileId=${offer.fileId} offer=${offer.offerId} `
        + `reason=${validation.reason} size=${offer.size} maxFileSize=${this.getMaxFileSize()}`,
      );
      return true;
    }

    if (this.database.hasFileOfferCancellationTombstone({
      offerId: offer.offerId,
      senderPeerId: context.senderPeerId,
    })) {
      this.tempOfferDiag(
        'drop_tombstone',
        `route=${context.route} cid=${context.message.cid} offer=${offer.offerId}`,
      );
      return true;
    }

    if (pendingCapacityFull) {
      if (isDirectRoute) {
        void this.#sendFileOfferNack(context.senderPeerId, offer.offerId, 'inbox_full');
      } else {
        this.onPendingFileOfferDeferred({
          chatId: chat.id,
          senderId: context.senderPeerId,
          senderUsername: sender.username,
          reason: 'inbox_full',
          pendingTotal: pending.length,
          maxPendingTotal,
          pendingFromSender,
          maxPendingPerPeer,
        });
      }
      this.tempOfferDiag(
        'drop_capacity_full',
        `route=${context.route} cid=${context.message.cid} offer=${offer.offerId} `
        + `directNack=${isDirectRoute} pendingTotal=${pending.length}/${maxPendingTotal} `
        + `pendingFromSender=${pendingFromSender}/${maxPendingPerPeer}`,
      );
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
      this.tempOfferDiag(
        'drop_insert_dedupe',
        `route=${context.route} cid=${context.message.cid} fileId=${offer.fileId} chatId=${chat.id}`,
      );
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
    this.tempOfferDiag(
      'persisted_and_emitted',
      `route=${context.route} cid=${context.message.cid} fileId=${offer.fileId} offer=${offer.offerId} chatId=${chat.id}`,
    );
    this.trace('RECV', context.senderPeerId, offer.fileId, 'OFFER_MESSAGE_PERSISTED', `offer=${offer.offerId}`);
    return true;
  }

  async sendGroupFile(chatId: number, filePath: string, providedFileId?: string, replyToCidInput?: string): Promise<void> {
    const chat = this.database.getChats([chatId])[0];
    if (!chat || chat.type !== 'group' || !chat.group_id) {
      throw new Error('Group chat not found');
    }
    if (chat.status !== 'active' || chat.group_status !== 'active') {
      throw new Error('Group chat is not active');
    }
    if (providedFileId !== undefined && !isValidCid(providedFileId)) {
      throw new Error('Invalid file message id');
    }

    const localPeerId = this.node.peerId.toString();
    const authorizedPullers = new Map<string, string>();
    for (const participant of this.database.getChatParticipants(chat.id)) {
      if (participant.peer_id === localPeerId) {
        continue;
      }
      const user = this.database.getUserByPeerId(participant.peer_id);
      if (!user) {
        throw new Error('Group member identity not found');
      }
      authorizedPullers.set(user.peer_id, user.signing_public_key);
    }
    if (authorizedPullers.size === 0) {
      throw new Error('Cannot send file: group has no other members');
    }

    const fileId = providedFileId ?? randomUUID();
    const offerId = randomUUID();

    // Atomic sender-cap reservation for the group chat before any file I/O.
    if (!this.servedFiles.reserve(offerId, chat.id)) {
      throw new Error(`Too many active file offers in this chat (max ${this.servedFiles.maxPerChat})`);
    }

    let rowPersisted = false;
    try {
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
      const replyToCid = isValidCid(replyToCidInput) ? replyToCidInput : undefined;
      const offer = this.#createApplicationFileOffer({
        offerId,
        fileId,
        metadata,
        ...(replyToCid ? { replyToCid } : {}),
      });

      // Snapshot the offer-time group roster's app signing keys. Later membership changes must
      // not silently widen or narrow this offer's authorization set.
      this.servedFiles.finalize(offerId, {
        fileId,
        filePath,
        size: metadata.size,
        checksum: metadata.checksum,
        authorizedPullers,
        isGroup: true,
      });

      await this.database.createMessage({
        id: fileId,
        client_msg_id: fileId,
        reply_to_client_id: replyToCid ?? null,
        chat_id: chat.id,
        sender_peer_id: localPeerId,
        content: `${metadata.filename} (${metadata.size} bytes)`,
        message_type: 'file',
        file_name: metadata.filename,
        file_size: metadata.size,
        file_path: filePath,
        file_offer_id: offerId,
        file_checksum: metadata.checksum,
        file_total_chunks: metadata.totalChunks,
        file_protocol_version: MESSAGE_ENVELOPE_VERSION,
        file_group_download_total: authorizedPullers.size,
        file_group_download_completed: 0,
        transfer_status: 'awaiting_acceptance',
        transfer_progress: 0,
        timestamp: new Date(),
      });
      rowPersisted = true;

      await this.messageHandler.sendApplicationMessage(
        { type: 'group', groupId: chat.group_id },
        {
          message: { cid: fileId, kind: 'file_offer', payload: offer },
          persistence: { owner: 'caller' },
        },
      );
      if (this.database.getFileMessageById(fileId)?.transfer_status === 'awaiting_acceptance') {
        this.onOutgoingFileOfferPending({
          chatId: chat.id,
          messageId: fileId,
          groupDownloadTotal: authorizedPullers.size,
          groupDownloadCompleted: 0,
        });
      }
      this.trace('SEND', chat.group_id, fileId, 'GROUP_OFFER_MESSAGE_SENT', `offer=${offerId}`);
    } catch (error: unknown) {
      this.servedFiles.release(offerId);
      const errorText = errStr(error, 'Unknown error');
      if (rowPersisted) {
        this.database.updateMessageTransfer(fileId, {
          transfer_status: 'failed',
          transfer_progress: 0,
          transfer_error: errorText,
        });
        this.onFileTransferFailed({ chatId: chat.id, messageId: fileId, error: errorText });
      }
      generalErrorHandler(error);
      throw error;
    }
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
    if (providedFileId !== undefined && !isValidCid(providedFileId)) {
      throw new Error('Invalid file message id');
    }
    const fileId = providedFileId ?? randomUUID();
    const offerId = randomUUID();

    // Atomic sender-cap reservation: synchronous count-and-insert before any await, so two
    // concurrent sends cannot both pass the check and exceed MAX_ACTIVE_FILE_OFFERS_PER_CHAT.
    if (!this.servedFiles.reserve(offerId, chat.id)) {
      throw new Error(`Too many active file offers in this chat (max ${this.servedFiles.maxPerChat})`);
    }

    let rowPersisted = false;
    try {
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
      const replyToCid = isValidCid(replyToCidInput) ? replyToCidInput : undefined;
      const offer = this.#createApplicationFileOffer({
        offerId,
        fileId,
        metadata,
        ...(replyToCid ? { replyToCid } : {}),
      });

      // Register the served file (snapshot the recipient's app signing key) before persistence and
      // transport, so the offer is pullable the moment the recipient receives it.
      this.servedFiles.finalize(offerId, {
        fileId,
        filePath,
        size: metadata.size,
        checksum: metadata.checksum,
        authorizedPullers: new Map([[user.peer_id, user.signing_public_key]]),
        isGroup: false,
      });

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
      // Roll back the reservation/registry entry so a failed send never leaks a sender slot.
      this.servedFiles.release(offerId);
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

  async cleanup(): Promise<void> {
    this.shuttingDown = true;
    // Stop accepting new serve streams, then abort and DRAIN in-flight serves before returning —
    // the caller closes the database immediately after cleanup(), so a still-running serve handler
    // must not be left able to touch a closed DB.
    try {
      await this.node.unhandle(this.fileTransferProtocol);
    } catch {
      // best-effort: node may already be stopping
    }
    for (const stream of this.activeServeStreams) {
      try { stream.abort(new Error('application shutdown')); } catch { /* best-effort */ }
    }
    await Promise.allSettled([...this.activeServeTasks]);

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
    this.servingDirectOffers.clear();
    this.servingGroupOfferPullers.clear();
    this.servedFiles.clear();
    this.pullChallenges.clear();

    const failed = this.database.failNonTerminalFileTransfers('Transfer interrupted (app shutdown)');
    if (failed > 0) {
      console.log(`[FileHandler] Shutdown cleanup marked ${failed} transfer(s) as failed`);
    }
  }

}
