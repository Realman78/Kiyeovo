import assert from 'node:assert/strict';
import test from 'node:test';
import type { Stream } from '@libp2p/interface';
import { StreamHandler } from './stream-handler.js';

interface FakeStream {
  stream: Stream;
  wasAborted: () => boolean;
  abortReason: () => Error | undefined;
  yieldedCount: () => number;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function encodeJson(value: unknown): Uint8Array {
  return bytes(JSON.stringify(value));
}

function fakeStream(groups: Uint8Array[]): FakeStream {
  let aborted = false;
  let reason: Error | undefined;
  let yielded = 0;

  async function* source(): AsyncGenerator<{ subarray(): Uint8Array }> {
    for (const group of groups) {
      if (aborted) return;
      yielded += 1;
      yield { subarray: () => group };
    }
  }

  const stream = {
    source: source(),
    abort: (error: Error) => {
      aborted = true;
      reason = error;
    },
  } as unknown as Stream;

  return {
    stream,
    wasAborted: () => aborted,
    abortReason: () => reason,
    yieldedCount: () => yielded,
  };
}

function hangingStream(): FakeStream {
  let aborted = false;
  let reason: Error | undefined;
  let resume: (() => void) | undefined;

  const source: AsyncIterable<{ subarray(): Uint8Array }> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<{ subarray(): Uint8Array }>> {
          if (!aborted) {
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
          return { done: true, value: undefined };
        },
      };
    },
  };

  const stream = {
    source,
    abort: (error: Error) => {
      aborted = true;
      reason = error;
      resume?.();
    },
  } as unknown as Stream;

  return {
    stream,
    wasAborted: () => aborted,
    abortReason: () => reason,
    yieldedCount: () => 0,
  };
}

test('readMessageFromStream aborts as soon as the byte cap is exceeded', async () => {
  const fake = fakeStream([
    bytes('{"value":"'),
    bytes('0123456789'),
    bytes('this chunk must not be pulled'),
  ]);

  await assert.rejects(
    StreamHandler.readMessageFromStream(fake.stream, { maxBytes: 12, timeoutMs: 1000 }),
    /exceeds cap/,
  );

  assert.equal(fake.wasAborted(), true);
  assert.match(fake.abortReason()?.message ?? '', /exceeds cap/);
  assert.equal(fake.yieldedCount(), 2, 'reader must stop pulling chunks after the cap trips');
});

test('readMessageFromStream aborts a stalled inbound stream at the read timeout', async () => {
  const fake = hangingStream();
  const startedAt = Date.now();

  await assert.rejects(
    StreamHandler.readMessageFromStream(fake.stream, { maxBytes: 1024, timeoutMs: 25 }),
    /timed out/,
  );

  assert.equal(fake.wasAborted(), true);
  assert.match(fake.abortReason()?.message ?? '', /timed out/);
  assert.ok(Date.now() - startedAt < 500, 'timeout should not wait for the source to close naturally');
});

test('readMessageFromStream round-trips a normal JSON envelope', async () => {
  const envelope = {
    type: 'encrypted',
    content: 'ciphertext',
    timestamp: 123,
    senderUsername: 'alice',
  };
  const encoded = encodeJson(envelope);
  const fake = fakeStream([encoded.subarray(0, 5), encoded.subarray(5)]);

  const parsed = await StreamHandler.readMessageFromStream<typeof envelope>(fake.stream, {
    maxBytes: 1024,
    timeoutMs: 1000,
  });

  assert.deepEqual(parsed, envelope);
  assert.equal(fake.wasAborted(), false);
  assert.equal(fake.yieldedCount(), 2);
});
