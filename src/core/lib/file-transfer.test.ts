import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { blake3 } from '@napi-rs/blake-hash';
import { CHUNK_SIZE } from '../constants.js';
import type { FileChunk } from '../protocol/file-pull-protocol.js';
import {
  ChunkReassembler,
  MAX_PULL_FRAME_LENGTH,
  createFileChunks,
  decodePullFrame,
  encodePullFrame,
  type ReassemblySpec,
} from './file-transfer.js';

const OFFER = 'offer_1';

function specFor(buffer: Buffer): ReassemblySpec {
  return {
    offerId: OFFER,
    totalChunks: Math.ceil(buffer.length / CHUNK_SIZE),
    size: buffer.length,
    checksum: blake3(buffer).toString('hex'),
  };
}

function chunksOf(buffer: Buffer, offerId = OFFER): FileChunk[] {
  return [...createFileChunks(buffer, offerId)];
}

test('createFileChunks lazily yields ceil(size/CHUNK_SIZE) hashed chunks', () => {
  const buffer = randomBytes(CHUNK_SIZE * 2 + 17);
  const chunks = chunksOf(buffer);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.index, 0);
  assert.equal(chunks[2]!.index, 2);
  for (const chunk of chunks) {
    assert.equal(chunk.offerId, OFFER);
    assert.equal(blake3(Buffer.from(chunk.data, 'base64')).toString('hex'), chunk.hash);
  }
});

test('round-trips a file through chunking and reassembly', () => {
  const buffer = randomBytes(CHUNK_SIZE + 1234);
  const reassembler = new ChunkReassembler(specFor(buffer));

  let complete = false;
  for (const chunk of createFileChunks(buffer, OFFER)) {
    const result = reassembler.accept(chunk);
    assert.equal(result.ok, true);
    if (result.ok) complete = result.complete;
  }
  assert.equal(complete, true);

  const finalized = reassembler.finalize();
  assert.ok(finalized.ok);
  assert.deepEqual(finalized.buffer, buffer);
});

test('rejects a chunk addressed to a different offer', () => {
  const buffer = randomBytes(CHUNK_SIZE);
  const foreign = chunksOf(buffer, 'other_offer')[0]!;
  assert.deepEqual(new ChunkReassembler(specFor(buffer)).accept(foreign), { ok: false, reason: 'wrong_offer' });
});

test('rejects a non-contiguous index, a duplicate, and an extra chunk', () => {
  const buffer = randomBytes(CHUNK_SIZE * 2);
  const chunks = chunksOf(buffer); // 2 chunks

  // Skipped index.
  let r = new ChunkReassembler(specFor(buffer));
  assert.deepEqual(r.accept(chunks[1]!), { ok: false, reason: 'non_contiguous' });

  // Duplicate of index 0.
  r = new ChunkReassembler(specFor(buffer));
  assert.equal(r.accept(chunks[0]!).ok, true);
  assert.deepEqual(r.accept(chunks[0]!), { ok: false, reason: 'non_contiguous' });

  // Extra chunk beyond totalChunks.
  r = new ChunkReassembler(specFor(buffer));
  r.accept(chunks[0]!);
  r.accept(chunks[1]!);
  const extra: FileChunk = { type: 'file_chunk', offerId: OFFER, index: 2, data: '', hash: blake3(Buffer.alloc(0)).toString('hex') };
  assert.deepEqual(r.accept(extra), { ok: false, reason: 'extra_chunk' });
});

test('rejects non-canonical base64 (junk, whitespace, bad padding)', () => {
  const spec: ReassemblySpec = { offerId: OFFER, totalChunks: 1, size: 4, checksum: 'a'.repeat(64) };
  for (const data of ['!!!!', 'YWJj ', 'YW Jj', 'YWJjZA', 'a']) {
    const chunk: FileChunk = { type: 'file_chunk', offerId: OFFER, index: 0, data, hash: 'x' };
    assert.deepEqual(new ChunkReassembler(spec).accept(chunk), { ok: false, reason: 'bad_encoding' }, `data=${JSON.stringify(data)}`);
  }
});

test('rejects a chunk whose decoded bytes overflow the offered size', () => {
  const spec: ReassemblySpec = { offerId: OFFER, totalChunks: 1, size: 10, checksum: 'a'.repeat(64) };
  const big = randomBytes(CHUNK_SIZE);
  const chunk: FileChunk = {
    type: 'file_chunk', offerId: OFFER, index: 0,
    data: big.toString('base64'), hash: blake3(big).toString('hex'),
  };
  assert.deepEqual(new ChunkReassembler(spec).accept(chunk), { ok: false, reason: 'over_size' });
});

test('rejects a chunk whose hash does not match its bytes', () => {
  const spec: ReassemblySpec = { offerId: OFFER, totalChunks: 1, size: 4, checksum: 'a'.repeat(64) };
  const chunk: FileChunk = { type: 'file_chunk', offerId: OFFER, index: 0, data: Buffer.from('abcd').toString('base64'), hash: 'b'.repeat(64) };
  assert.deepEqual(new ChunkReassembler(spec).accept(chunk), { ok: false, reason: 'chunk_hash_mismatch' });
});

test('finalize fails on missing chunks, short bytes, and checksum mismatch', () => {
  const buffer = randomBytes(CHUNK_SIZE * 2);
  const chunks = chunksOf(buffer);

  // Missing the last chunk.
  let r = new ChunkReassembler(specFor(buffer));
  r.accept(chunks[0]!);
  assert.deepEqual(r.finalize(), { ok: false, reason: 'missing_chunks' });

  // Right count, but the offer lied about size (claims more than delivered).
  const abc = Buffer.from('abc');
  const c: FileChunk = { type: 'file_chunk', offerId: OFFER, index: 0, data: abc.toString('base64'), hash: blake3(abc).toString('hex') };
  r = new ChunkReassembler({ offerId: OFFER, totalChunks: 1, size: 999, checksum: blake3(abc).toString('hex') });
  r.accept(c);
  assert.deepEqual(r.finalize(), { ok: false, reason: 'size_mismatch' });

  // Bytes complete and sized, but the full-file checksum is wrong.
  r = new ChunkReassembler({ offerId: OFFER, totalChunks: 1, size: 3, checksum: 'f'.repeat(64) });
  r.accept(c);
  assert.deepEqual(r.finalize(), { ok: false, reason: 'checksum_mismatch' });
});

test('frame codec round-trips and reports incomplete buffers', () => {
  const encoded = encodePullFrame({ type: 'file_pull_init', offerId: OFFER });
  const decoded = decodePullFrame(encoded);
  assert.equal(decoded.status, 'frame');
  if (decoded.status === 'frame') {
    assert.deepEqual(decoded.value, { type: 'file_pull_init', offerId: OFFER });
    assert.equal(decoded.bytesRead, encoded.length);
  }
  assert.deepEqual(decodePullFrame(encoded.subarray(0, encoded.length - 3)), { status: 'incomplete' });
  assert.deepEqual(decodePullFrame(new Uint8Array(2)), { status: 'incomplete' });
});

test('frame codec decodes consecutive frames at the right offset', () => {
  const a = encodePullFrame({ n: 1 });
  const b = encodePullFrame({ n: 2 });
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  const first = decodePullFrame(joined);
  assert.equal(first.status, 'frame');
  if (first.status === 'frame') {
    assert.equal(first.bytesRead, a.length);
    const second = decodePullFrame(joined.subarray(first.bytesRead));
    assert.equal(second.status, 'frame');
    if (second.status === 'frame') assert.deepEqual(second.value, { n: 2 });
  }
});

test('encodePullFrame throws when the encoded JSON exceeds the frame cap', () => {
  const oversize = { type: 'file_chunk', offerId: 'o', index: 0, hash: 'h', data: 'a'.repeat(MAX_PULL_FRAME_LENGTH) };
  assert.throws(() => encodePullFrame(oversize), /exceeds MAX_PULL_FRAME_LENGTH/);
  // A frame at/below the cap still encodes.
  assert.ok(encodePullFrame({ type: 'file_pull_init', offerId: 'o' }).length > 0);
});

test('frame codec rejects an oversize declared length before allocating', () => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_PULL_FRAME_LENGTH + 1, false);
  assert.deepEqual(decodePullFrame(header), { status: 'oversize', declaredLength: MAX_PULL_FRAME_LENGTH + 1 });
});

test('frame codec reports invalid JSON', () => {
  const garbage = new TextEncoder().encode('not json');
  const framed = new Uint8Array(4 + garbage.length);
  new DataView(framed.buffer).setUint32(0, garbage.length, false);
  framed.set(garbage, 4);
  assert.deepEqual(decodePullFrame(framed), { status: 'invalid' });
});
