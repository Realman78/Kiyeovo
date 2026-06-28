import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stream } from '@libp2p/interface';
import { FrameStreamReader } from './frame-stream.js';
import { MAX_PULL_FRAME_LENGTH, encodePullFrame } from './file-transfer.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeStream {
  stream: Stream;
  wasAborted: () => boolean;
}

/** A stream whose source yields the given byte groups, optionally with a per-yield delay. */
function fakeStream(groups: Uint8Array[], opts: { delayMs?: number; hangAtEnd?: boolean } = {}): FakeStream {
  let aborted = false;
  async function* source(): AsyncGenerator<{ subarray(): Uint8Array }> {
    for (const group of groups) {
      if (opts.delayMs) {
        await sleep(opts.delayMs);
      }
      if (aborted) return;
      yield { subarray: () => group };
    }
    if (opts.hangAtEnd) {
      await new Promise<void>(() => undefined);
    }
  }
  const stream = { source: source(), abort: () => { aborted = true; } } as unknown as Stream;
  return { stream, wasAborted: () => aborted };
}

function bytes(values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

test('reassembles a frame split across multiple source chunks', async () => {
  const frame = encodePullFrame({ type: 'file_pull_init', offerId: 'offer_1' });
  const { stream } = fakeStream([frame.subarray(0, 2), frame.subarray(2, 5), frame.subarray(5)]);
  const reader = new FrameStreamReader(stream);
  assert.deepEqual(await reader.readFrame(1000), { type: 'file_pull_init', offerId: 'offer_1' });
});

test('reads two frames pipelined within a single source chunk', async () => {
  const a = encodePullFrame({ n: 1 });
  const b = encodePullFrame({ n: 2 });
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  const reader = new FrameStreamReader(fakeStream([joined]).stream);
  assert.deepEqual(await reader.readFrame(1000), { n: 1 });
  assert.deepEqual(await reader.readFrame(1000), { n: 2 });
});

test('aborts on an oversize declared length', async () => {
  const header = bytes([0, 0, 0, 0]);
  new DataView(header.buffer).setUint32(0, MAX_PULL_FRAME_LENGTH + 1, false);
  const fake = fakeStream([header], { hangAtEnd: true });
  const reader = new FrameStreamReader(fake.stream);
  await assert.rejects(reader.readFrame(1000), /exceeds cap/);
  assert.equal(fake.wasAborted(), true);
});

test('reads several legal frames coalesced in one chunk whose combined size exceeds one frame cap', async () => {
  // Each frame is well under the per-frame cap, but two of them together exceed it. Framing must
  // not reject the chunk for its aggregate size — it must segment and process each frame.
  const big = 'x'.repeat(Math.floor(MAX_PULL_FRAME_LENGTH * 0.6));
  const a = encodePullFrame({ type: 'file_chunk', data: big, index: 0 });
  const b = encodePullFrame({ type: 'file_chunk', data: big, index: 1 });
  assert.ok(a.length + b.length > MAX_PULL_FRAME_LENGTH, 'combined size must exceed one frame cap');
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  const fake = fakeStream([joined]);
  const reader = new FrameStreamReader(fake.stream);
  assert.deepEqual(await reader.readFrame(1000), { type: 'file_chunk', data: big, index: 0 });
  assert.deepEqual(await reader.readFrame(1000), { type: 'file_chunk', data: big, index: 1 });
  assert.equal(fake.wasAborted(), false);
});

test('still rejects a single frame that declares more than the per-frame cap', async () => {
  const header = bytes([0, 0, 0, 0]);
  new DataView(header.buffer).setUint32(0, MAX_PULL_FRAME_LENGTH + 1, false);
  const fake = fakeStream([header], { hangAtEnd: true });
  const reader = new FrameStreamReader(fake.stream);
  await assert.rejects(reader.readFrame(1000), /exceeds cap/);
  assert.equal(fake.wasAborted(), true);
});

test('validates a split oversize header without allocating an aggregate source-chunk buffer', async () => {
  const header = bytes([0, 0, 0, 0]);
  new DataView(header.buffer).setUint32(0, MAX_PULL_FRAME_LENGTH + 1, false);
  const secondChunk = new Uint8Array(MAX_PULL_FRAME_LENGTH + 32);
  secondChunk[0] = header[3] ?? 0;
  const aggregateAllocationSize = 3 + secondChunk.length;

  const originalUint8Array = globalThis.Uint8Array;
  const allocations: number[] = [];
  const proxyUint8Array = new Proxy(originalUint8Array, {
    construct(target, args, newTarget) {
      if (typeof args[0] === 'number') {
        allocations.push(args[0]);
      }
      return Reflect.construct(target, args, newTarget);
    },
  }) as unknown as Uint8ArrayConstructor;

  Object.defineProperty(globalThis, 'Uint8Array', { value: proxyUint8Array, configurable: true, writable: true });
  try {
    const fake = fakeStream([header.subarray(0, 3), secondChunk], { hangAtEnd: true });
    const reader = new FrameStreamReader(fake.stream);
    await assert.rejects(reader.readFrame(1000), /exceeds cap/);
    assert.equal(fake.wasAborted(), true);
  } finally {
    Object.defineProperty(globalThis, 'Uint8Array', { value: originalUint8Array, configurable: true, writable: true });
  }

  assert.equal(allocations.includes(aggregateAllocationSize), false);
});

test('enforces ONE absolute deadline per frame (slow-loris defense)', async () => {
  // One byte every 15ms; a 60ms deadline must fire even though no single gap exceeds it.
  const frame = encodePullFrame({ type: 'file_pull_init', offerId: 'offer_1' });
  const groups = Array.from(frame, (b) => bytes([b]));
  const fake = fakeStream(groups, { delayMs: 15 });
  const reader = new FrameStreamReader(fake.stream);
  const start = Date.now();
  await assert.rejects(reader.readFrame(60), /timed out/);
  assert.equal(fake.wasAborted(), true);
  // It must give up around the deadline, not after assembling the whole (much longer) frame.
  assert.ok(Date.now() - start < frame.length * 15, 'should not have waited for the full drip');
});

test('throws when the stream ends before a full frame', async () => {
  const frame = encodePullFrame({ n: 1 });
  const reader = new FrameStreamReader(fakeStream([frame.subarray(0, 3)]).stream);
  await assert.rejects(reader.readFrame(1000), /ended before a complete frame/);
});
