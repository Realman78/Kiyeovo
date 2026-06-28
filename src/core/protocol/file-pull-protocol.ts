import { randomBytes } from 'crypto';
import { CHUNK_SIZE } from '../constants.js';
import { isValidCid } from './message-envelope.js';

/**
 * Pull-stream protocol primitives (decision 4: Noise confidentiality + app-key challenge-response).
 *
 * The recipient dials and pulls; the sender challenges and the recipient signs with its application
 * signing key. This module is the *pure* layer: frame shapes, strict guards, the challenge
 * generator, the domain-separated signature payload, and the stateless authorization decision.
 *
 * NOTE (provisional): the wire frame shapes below are consumed by the direct pull state machine in
 * the next increment (1d). Field layout may still change once that handler is written; the
 * challenge/signature helper and `evaluateFilePullAuth` are stable (they anchor the offer-time app
 * key snapshot, which is this increment's core).
 */

export const FILE_PULL_SIGNATURE_DOMAIN = 'kiyeovo-file-pull-v2';
const FILE_PULL_CHALLENGE_BYTES = 32;
const MAX_PEER_ID_LENGTH = 256;
const MAX_CHALLENGE_LENGTH = 128;
const MAX_SIGNATURE_LENGTH = 512;
const MAX_CHUNK_HASH_LENGTH = 128;
// `data` carries one chunk's application bytes; cap it so a malformed frame can't claim an
// unbounded string. A 4/3 base64 ceiling over CHUNK_SIZE plus slack covers any plaintext/base64
// encoding 1d settles on. (Raw on-wire frame length is separately capped by the 1d stream reader.)
export const MAX_FILE_CHUNK_DATA_LENGTH = Math.ceil(CHUNK_SIZE / 3) * 4 + 1024;

export type FilePullRejectReason = 'unauthorized' | 'unavailable' | 'source_changed' | 'busy';

export interface FilePullInit {
  type: 'file_pull_init';
  offerId: string;
}

export interface FilePullChallenge {
  type: 'file_pull_challenge';
  offerId: string;
  challenge: string; // base64 random, per-stream
}

export interface FilePullAuth {
  type: 'file_pull_auth';
  offerId: string;
  senderPeerId: string;
  requesterPeerId: string;
  challenge: string;
  signature: string;
}

export interface FilePullReject {
  type: 'file_pull_reject';
  offerId: string;
  reason: FilePullRejectReason;
}

export interface FileChunk {
  type: 'file_chunk';
  offerId: string;
  index: number;
  data: string; // application plaintext (Noise encrypts the wire)
  hash: string; // per-chunk BLAKE3
}

export type FileTransferConfirmReason = 'integrity' | 'disk' | 'other';

export interface FileTransferConfirm {
  type: 'file_transfer_confirm';
  offerId: string;
  success: boolean;
  reason?: FileTransferConfirmReason; // present when success === false
}

/** Random per-stream challenge (base64). */
export function createFilePullChallenge(): string {
  return randomBytes(FILE_PULL_CHALLENGE_BYTES).toString('base64');
}

/** Deterministic, domain-separated payload the `FilePullAuth.signature` covers. */
export function createFilePullAuthSignaturePayload(input: {
  offerId: string;
  senderPeerId: string;
  requesterPeerId: string;
  challenge: string;
}): object {
  return {
    domain: FILE_PULL_SIGNATURE_DOMAIN,
    offerId: input.offerId,
    senderPeerId: input.senderPeerId,
    requesterPeerId: input.requesterPeerId,
    challenge: input.challenge,
  };
}

export type FilePullAuthDecision =
  | { ok: true; signingKey: string }
  | { ok: false; reason: FilePullRejectReason };

/**
 * Per-offer store of issued, not-yet-consumed pull challenges. Consumption is one-time: a
 * challenge is bound to the `offerId` it was issued for and can be accepted at most once, which is
 * what gives replay resistance (no replay cache beyond the outstanding-challenge set).
 */
export class PullChallengeStore {
  private byOffer = new Map<string, Set<string>>();

  issue(offerId: string): string {
    const challenge = createFilePullChallenge();
    const set = this.byOffer.get(offerId) ?? new Set<string>();
    set.add(challenge);
    this.byOffer.set(offerId, set);
    return challenge;
  }

  /** Atomically accept-and-remove a challenge for this offer. False if unknown/already consumed. */
  consume(offerId: string, challenge: string): boolean {
    const set = this.byOffer.get(offerId);
    if (!set || !set.delete(challenge)) {
      return false;
    }
    if (set.size === 0) {
      this.byOffer.delete(offerId);
    }
    return true;
  }

  /**
   * Per-stream cleanup: remove only *this* stream's challenge (no-op if already consumed). Use this
   * in the serve handler's `finally` so a timed-out/disconnected stream drops its own challenge
   * without disturbing other concurrent streams pulling the same offer.
   */
  discard(offerId: string, challenge: string): void {
    const set = this.byOffer.get(offerId);
    if (!set) {
      return;
    }
    set.delete(challenge);
    if (set.size === 0) {
      this.byOffer.delete(offerId);
    }
  }

  /**
   * Offer-level teardown: drop *every* outstanding challenge for an offer at once. Correct only
   * when the offer itself is gone (withdrawal/cancel/`source_changed`) — never for per-stream
   * cleanup, where it would wrongly invalidate concurrent streams for the same offer.
   */
  dropOffer(offerId: string): void {
    this.byOffer.delete(offerId);
  }

  clear(): void {
    this.byOffer.clear();
  }
}

/**
 * Stateless authorization decision for an incoming `FilePullAuth`, in the order the serve handler
 * must apply it — before acquiring a serve slot or touching disk:
 *   1. the offer exists in our registry (else `unavailable`);
 *   2. the auth names us as sender, and the Noise-authenticated dialer is the named requester;
 *   3. that requester is in the offer's authorization snapshot — `authorizedSigningKey`, the key the
 *      registry holds for `auth.requesterPeerId` *under `auth.offerId`* (else `unauthorized`);
 *   4. the signature verifies under that snapshotted app key (else `unauthorized`);
 *   5. the challenge was issued for *this* offer and is unconsumed — `consumeChallenge` binds it to
 *      `auth.offerId` and removes it atomically so a replay fails (else `unauthorized`).
 * The caller resolves `offerExists`/`authorizedSigningKey` from the registry by `auth.offerId` (the
 * mutable authorization map never leaves the registry) and acquires the serve slot afterwards.
 */
export function evaluateFilePullAuth(input: {
  auth: FilePullAuth;
  offerExists: boolean; // registry has auth.offerId
  authorizedSigningKey: string | undefined; // snapshot key for auth.requesterPeerId under auth.offerId
  localSenderPeerId: string;
  remotePeerId: string; // Noise-authenticated dialer
  consumeChallenge: (offerId: string, challenge: string) => boolean;
  verifySignature: (signature: string, payload: object, signingKey: string) => boolean;
}): FilePullAuthDecision {
  const { auth, offerExists, authorizedSigningKey, localSenderPeerId, remotePeerId, consumeChallenge, verifySignature } = input;

  if (!offerExists) {
    return { ok: false, reason: 'unavailable' };
  }
  if (auth.senderPeerId !== localSenderPeerId || remotePeerId !== auth.requesterPeerId) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (!authorizedSigningKey) {
    return { ok: false, reason: 'unauthorized' };
  }
  const payload = createFilePullAuthSignaturePayload({
    offerId: auth.offerId,
    senderPeerId: auth.senderPeerId,
    requesterPeerId: auth.requesterPeerId,
    challenge: auth.challenge,
  });
  if (!verifySignature(auth.signature, payload, authorizedSigningKey)) {
    return { ok: false, reason: 'unauthorized' };
  }
  // Consume last (after the signature checks out) so a bad-signature attempt cannot burn a
  // legitimate outstanding challenge.
  if (!consumeChallenge(auth.offerId, auth.challenge)) {
    return { ok: false, reason: 'unauthorized' };
  }
  return { ok: true, signingKey: authorizedSigningKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFilePullInit(value: unknown): value is FilePullInit {
  return isRecord(value) && value.type === 'file_pull_init' && isValidCid(value.offerId);
}

export function isFilePullChallenge(value: unknown): value is FilePullChallenge {
  return isRecord(value)
    && value.type === 'file_pull_challenge'
    && isValidCid(value.offerId)
    && isBoundedString(value.challenge, MAX_CHALLENGE_LENGTH);
}

export function isFilePullAuth(value: unknown): value is FilePullAuth {
  return isRecord(value)
    && value.type === 'file_pull_auth'
    && isValidCid(value.offerId)
    && isBoundedString(value.senderPeerId, MAX_PEER_ID_LENGTH)
    && isBoundedString(value.requesterPeerId, MAX_PEER_ID_LENGTH)
    && isBoundedString(value.challenge, MAX_CHALLENGE_LENGTH)
    && isBoundedString(value.signature, MAX_SIGNATURE_LENGTH);
}

export function isFilePullReject(value: unknown): value is FilePullReject {
  return isRecord(value)
    && value.type === 'file_pull_reject'
    && isValidCid(value.offerId)
    && isFilePullRejectReason(value.reason);
}

export function isFileChunk(value: unknown): value is FileChunk {
  return isRecord(value)
    && value.type === 'file_chunk'
    && isValidCid(value.offerId)
    && isNonNegativeSafeInteger(value.index)
    && typeof value.data === 'string'
    && value.data.length <= MAX_FILE_CHUNK_DATA_LENGTH
    && isBoundedString(value.hash, MAX_CHUNK_HASH_LENGTH);
}

export function isFileTransferConfirm(value: unknown): value is FileTransferConfirm {
  if (!isRecord(value) || value.type !== 'file_transfer_confirm' || !isValidCid(value.offerId) || typeof value.success !== 'boolean') {
    return false;
  }
  // success ⇒ no reason; failure ⇒ a valid reason. Reject any other combination.
  return value.success
    ? value.reason === undefined
    : (value.reason === 'integrity' || value.reason === 'disk' || value.reason === 'other');
}

function isFilePullRejectReason(value: unknown): value is FilePullRejectReason {
  return value === 'unauthorized'
    || value === 'unavailable'
    || value === 'source_changed'
    || value === 'busy';
}
