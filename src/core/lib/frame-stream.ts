import type { Stream } from '@libp2p/interface';
import { MAX_PULL_FRAME_LENGTH } from './file-transfer.js';

const FRAME_HEADER_BYTES = 4;

/**
 * Reads length-prefixed frames from a libp2p stream, header-first and memory-bounded, with a single
 * absolute deadline per frame.
 *
 * - The timeout is **one deadline for the whole frame**, not restarted per network chunk, so a peer
 *   dripping one byte at a time cannot stall forever.
 * - The size bound is applied **per declared frame** (`declaredLength <= MAX_PULL_FRAME_LENGTH`),
 *   read from the header before the frame body is allocated. Source chunks are queued as segments
 *   instead of concatenated wholesale, so a muxer chunk carrying several legal frames is processed
 *   frame-by-frame rather than rejected for its aggregate size.
 * - The timeout/oversize/invalid paths **abort the underlying stream** (not just lose a
 *   `Promise.race`), so the source iteration is genuinely cancelled.
 */
export class FrameStreamReader {
  private readonly iterator: AsyncIterator<unknown>;
  private segments: Uint8Array<ArrayBufferLike>[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private bufferedBytes = 0;

  constructor(private readonly stream: Stream) {
    this.iterator = stream.source[Symbol.asyncIterator]();
  }

  /** Read the next complete frame under a single absolute deadline; throw on timeout/oversize/invalid/end. */
  async readFrame(timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    await this.fillUntil(FRAME_HEADER_BYTES, deadline);

    const declaredLength = this.peekUint32();
    if (declaredLength > MAX_PULL_FRAME_LENGTH) {
      this.abort('oversize frame');
      throw new Error(`pull frame exceeds cap (${declaredLength} bytes)`);
    }

    await this.fillUntil(FRAME_HEADER_BYTES + declaredLength, deadline);
    this.advance(FRAME_HEADER_BYTES);
    const jsonBytes = this.consume(declaredLength);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch {
      this.abort('invalid frame');
      throw new Error('invalid pull frame');
    }
    return value;
  }

  private async fillUntil(byteCount: number, deadline: number): Promise<void> {
    while (this.bufferedBytes < byteCount) {
      await this.pull(deadline);
    }
  }

  private async pull(deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.abort('read deadline exceeded');
      throw new Error('pull read timed out');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = this.iterator.next();
    next.catch(() => undefined); // swallow a late rejection if the deadline wins (stream is aborted anyway)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.abort('read deadline exceeded');
        reject(new Error('pull read timed out'));
      }, remaining);
    });
    let result: IteratorResult<unknown>;
    try {
      result = await Promise.race([next, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (result.done) {
      throw new Error('stream ended before a complete frame');
    }
    const view = (result.value as { subarray(): Uint8Array }).subarray();
    if (view.length === 0) {
      return;
    }
    this.segments.push(view);
    this.bufferedBytes += view.length;
  }

  private peekUint32(): number {
    const header = this.copyQueuedBytes(FRAME_HEADER_BYTES);
    return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, false);
  }

  private copyQueuedBytes(count: number): Uint8Array {
    if (count > this.bufferedBytes) {
      throw new Error('internal frame reader underflow');
    }
    const output = new Uint8Array(count);
    let written = 0;
    let segmentIndex = this.headIndex;
    let segmentOffset = this.headOffset;

    while (written < count) {
      const segment = this.segments[segmentIndex];
      if (!segment) {
        throw new Error('internal frame reader underflow');
      }
      const available = segment.length - segmentOffset;
      const take = Math.min(count - written, available);
      output.set(segment.subarray(segmentOffset, segmentOffset + take), written);
      written += take;
      segmentIndex += segmentOffset + take === segment.length ? 1 : 0;
      segmentOffset = segmentOffset + take === segment.length ? 0 : segmentOffset + take;
    }
    return output;
  }

  private consume(count: number): Uint8Array {
    const output = this.copyQueuedBytes(count);
    this.advance(count);
    return output;
  }

  private advance(count: number): void {
    if (count > this.bufferedBytes) {
      throw new Error('internal frame reader underflow');
    }
    let remaining = count;
    while (remaining > 0) {
      const segment = this.segments[this.headIndex];
      if (!segment) {
        throw new Error('internal frame reader underflow');
      }
      const available = segment.length - this.headOffset;
      const take = Math.min(remaining, available);
      this.headOffset += take;
      this.bufferedBytes -= take;
      remaining -= take;
      if (this.headOffset === segment.length) {
        this.headIndex += 1;
        this.headOffset = 0;
      }
    }
    this.compactConsumedSegments();
  }

  private compactConsumedSegments(): void {
    if (this.headIndex === 0) {
      return;
    }
    if (this.headIndex === this.segments.length) {
      this.segments = [];
      this.headIndex = 0;
      return;
    }
    if (this.headIndex >= 64 && this.headIndex * 2 >= this.segments.length) {
      this.segments = this.segments.slice(this.headIndex);
      this.headIndex = 0;
    }
  }

  private abort(reason: string): void {
    try {
      this.stream.abort(new Error(reason));
    } catch {
      // best-effort
    }
  }
}
