import { blake3 } from '@napi-rs/blake-hash';
import { CHUNK_SIZE } from '../constants.js';
import { MAX_FILE_CHUNK_DATA_LENGTH, type FileChunk } from '../protocol/file-pull-protocol.js';

/**
 * Pure transfer core for the pull stream (1d): chunking, the memory-bounded reassembler, and the
 * length-prefixed frame codec. No libp2p, no fs — all of it is deterministic and unit-tested. The
 * reassembler is the defense that keeps a malicious sender from exceeding the offered size by
 * streaming unlimited valid-sized frames.
 */

const FRAME_HEADER_BYTES = 4;

/**
 * Raw on-wire frame cap (the bound 1c deferred to "the 1d stream reader"). The largest legitimate
 * frame is a `FileChunk` carrying base64 chunk data; every other frame is tiny. Reject anything
 * larger *before* allocating/parsing.
 */
export const MAX_PULL_FRAME_LENGTH = MAX_FILE_CHUNK_DATA_LENGTH + 4096;

export function encodePullFrame(message: object): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(message));
  if (jsonBytes.length > MAX_PULL_FRAME_LENGTH) {
    // Symmetric with the decoder's cap: a frame this large is unreadable by the peer, so refuse to
    // emit it rather than write something that will be rejected/abort the stream.
    throw new Error(`encodePullFrame: frame of ${jsonBytes.length} bytes exceeds MAX_PULL_FRAME_LENGTH (${MAX_PULL_FRAME_LENGTH})`);
  }
  const result = new Uint8Array(FRAME_HEADER_BYTES + jsonBytes.length);
  new DataView(result.buffer).setUint32(0, jsonBytes.length, false); // big-endian length prefix
  result.set(jsonBytes, FRAME_HEADER_BYTES);
  return result;
}

export type FrameDecodeResult =
  | { status: 'incomplete' }
  | { status: 'oversize'; declaredLength: number }
  | { status: 'invalid' }
  | { status: 'frame'; value: unknown; bytesRead: number };

/**
 * Decode one frame from the head of `buffer`. `incomplete` ⇒ read more bytes and retry;
 * `oversize`/`invalid` ⇒ the stream reader must abort. The oversize check runs on the *declared*
 * length before any allocation, so a hostile length prefix can't force a large read.
 */
export function decodePullFrame(buffer: Uint8Array<ArrayBufferLike>): FrameDecodeResult {
  if (buffer.length < FRAME_HEADER_BYTES) {
    return { status: 'incomplete' };
  }
  const declaredLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false);
  if (declaredLength > MAX_PULL_FRAME_LENGTH) {
    return { status: 'oversize', declaredLength };
  }
  if (buffer.length < FRAME_HEADER_BYTES + declaredLength) {
    return { status: 'incomplete' };
  }
  const jsonBytes = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + declaredLength);
  try {
    return { status: 'frame', value: JSON.parse(new TextDecoder().decode(jsonBytes)), bytesRead: FRAME_HEADER_BYTES + declaredLength };
  } catch {
    return { status: 'invalid' };
  }
}

/**
 * Lazily yield `FileChunk`s with a per-chunk BLAKE3 hash (plaintext bytes, base64 for JSON). This
 * is a **generator** on purpose: the serve handler encodes/sends one chunk at a time, so resident
 * RAM per serve stays ~one chunk above the file buffer rather than materializing a second full
 * (base64-inflated) copy — which is what keeps the `serves × MAX_FILE_SIZE` budget honest.
 */
export function* createFileChunks(buffer: Buffer, offerId: string): Generator<FileChunk> {
  const totalChunks = Math.ceil(buffer.length / CHUNK_SIZE);
  for (let index = 0; index < totalChunks; index++) {
    const slice = Buffer.from(buffer.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
    yield {
      type: 'file_chunk',
      offerId,
      index,
      data: slice.toString('base64'),
      hash: blake3(slice).toString('hex'),
    };
  }
}

export interface ReassemblySpec {
  offerId: string;
  totalChunks: number;
  size: number;
  checksum: string;
}

export type ChunkAcceptResult =
  | { ok: true; complete: boolean }
  | { ok: false; reason: ChunkRejectReason };

export type ChunkRejectReason =
  | 'wrong_offer'
  | 'extra_chunk'
  | 'non_contiguous'
  | 'bad_encoding'
  | 'chunk_hash_mismatch'
  | 'over_size';

/** Canonical-base64 check: lenient decoders silently accept junk, so require an exact re-encode. */
function decodeCanonicalBase64(data: string): Buffer | null {
  const bytes = Buffer.from(data, 'base64');
  return bytes.toString('base64') === data ? bytes : null;
}

export type ReassemblyFinalizeResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: 'missing_chunks' | 'size_mismatch' | 'checksum_mismatch' };

/**
 * Reassembles incoming `FileChunk`s under strict bounds so a hostile sender cannot exceed the
 * offered size: chunks must arrive contiguously from index 0, never more than `totalChunks`, each
 * with a matching per-chunk hash, with cumulative bytes never exceeding `size`. `finalize` then
 * requires exactly `totalChunks`, exact `size`, and a matching full-file checksum.
 */
export class ChunkReassembler {
  private nextIndex = 0;
  private receivedBytes = 0;
  private parts: Buffer[] = [];

  constructor(private readonly spec: ReassemblySpec) {}

  accept(chunk: FileChunk): ChunkAcceptResult {
    if (chunk.offerId !== this.spec.offerId) {
      return { ok: false, reason: 'wrong_offer' };
    }
    if (this.nextIndex >= this.spec.totalChunks) {
      return { ok: false, reason: 'extra_chunk' };
    }
    // Contiguity rejects out-of-order, gaps, and duplicates (any already-seen index < nextIndex).
    if (chunk.index !== this.nextIndex) {
      return { ok: false, reason: 'non_contiguous' };
    }
    const bytes = decodeCanonicalBase64(chunk.data);
    if (!bytes) {
      return { ok: false, reason: 'bad_encoding' };
    }
    if (blake3(bytes).toString('hex') !== chunk.hash) {
      return { ok: false, reason: 'chunk_hash_mismatch' };
    }
    if (this.receivedBytes + bytes.length > this.spec.size) {
      return { ok: false, reason: 'over_size' };
    }
    this.parts.push(bytes);
    this.receivedBytes += bytes.length;
    this.nextIndex++;
    return { ok: true, complete: this.nextIndex === this.spec.totalChunks };
  }

  finalize(): ReassemblyFinalizeResult {
    if (this.nextIndex !== this.spec.totalChunks) {
      return { ok: false, reason: 'missing_chunks' };
    }
    if (this.receivedBytes !== this.spec.size) {
      return { ok: false, reason: 'size_mismatch' };
    }
    const buffer = Buffer.concat(this.parts);
    if (blake3(buffer).toString('hex') !== this.spec.checksum) {
      return { ok: false, reason: 'checksum_mismatch' };
    }
    return { ok: true, buffer };
  }
}
