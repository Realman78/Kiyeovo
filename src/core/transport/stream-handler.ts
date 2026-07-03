import type { Stream } from '@libp2p/interface';
import type { StreamHandlerContext, EncryptedMessage } from '../types.js';
import { log } from '../../shared/logger.js';

export interface ReadMessageFromStreamOptions {
  maxBytes: number;
  timeoutMs: number;
}

export class StreamHandler {
  static async readMessageFromStream<T>(stream: Stream, options: ReadMessageFromStreamOptions): Promise<T> {
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    const deadline = Date.now() + options.timeoutMs;
    const iterator = stream.source[Symbol.asyncIterator]();
    let timeoutError: Error | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`inbound stream read timed out after ${options.timeoutMs}ms`);
        timeoutError = error;
        StreamHandler.abortInboundRead(stream, error);
        reject(error);
      }, options.timeoutMs);
    });

    try {
      while (true) {
        if (Date.now() >= deadline) {
          const error = new Error(`inbound stream read timed out after ${options.timeoutMs}ms`);
          timeoutError = error;
          StreamHandler.abortInboundRead(stream, error);
          throw error;
        }

        const next = iterator.next();
        next.catch(() => undefined);
        const result = await Promise.race([next, timeoutPromise]);
        if (result.done) break;

        const bytes = StreamHandler.chunkToBytes(result.value);
        totalLength += bytes.length;
        if (totalLength > options.maxBytes) {
          const error = new Error(`inbound stream exceeds cap (${options.maxBytes} bytes)`);
          StreamHandler.abortInboundRead(stream, error);
          throw error;
        }
        chunks.push(bytes);
      }
    } catch (error: unknown) {
      if (timeoutError !== undefined) {
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const messageJson = new TextDecoder().decode(combined);
    return JSON.parse(messageJson) as T;
  }

  private static chunkToBytes(chunk: unknown): Uint8Array {
    if (chunk instanceof Uint8Array) {
      return chunk.subarray();
    }
    const value = chunk as { subarray?: () => Uint8Array };
    if (typeof value.subarray === 'function') {
      return value.subarray();
    }
    throw new Error('inbound stream yielded a non-byte chunk');
  }

  private static abortInboundRead(stream: Stream, error: Error): void {
    const candidate = stream as Partial<Pick<Stream, 'abort' | 'close' | 'closeRead'>>;
    try {
      if (typeof candidate.abort === 'function') {
        candidate.abort(error);
        return;
      }
    } catch {
      // Fall through to close fallbacks.
    }

    try {
      StreamHandler.ignoreRejectedClose(candidate.closeRead?.());
    } catch {
      // best-effort
    }
    try {
      StreamHandler.ignoreRejectedClose(candidate.close?.());
    } catch {
      // best-effort
    }
  }

  private static ignoreRejectedClose(result: Promise<void> | void | undefined): void {
    if (result !== undefined && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch(() => undefined);
    }
  }

  /**
   * Write a message to a stream
   */
  static async writeMessageToStream(stream: Stream, message: EncryptedMessage): Promise<void> {
    const messageJson = JSON.stringify(message);
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(messageJson)]);
  }

  static async writeFileToStream(stream: Stream, file: Uint8Array): Promise<void> {
    await stream.sink([file]);
  }

  /**
   * Process a stream context and extract remote peer info
   */
  static getRemotePeerInfo(context: StreamHandlerContext): {
    remoteId: string
    stream: Stream
  } {
    const remoteId = context.connection.remotePeer.toString();
    return {
      remoteId,
      stream: context.stream
    };
  }

  /**
   * Log incoming connection information
   */
  static logIncomingConnection(remoteId: string, protocol: string): void {
    log(`[STREAM][IN] peer=*${remoteId.slice(-8)} protocol=${protocol}`);
  }

  /**
   * Log received message information
   */
  static logReceivedMessage(message: EncryptedMessage): void {
    if (message.type !== 'key_exchange') return
    log(`[STREAM][MSG] type=${message.type} content=${message.content} sender=${message.senderUsername}`);
  }

  /**
   * Log decrypted message content
   */
  static logDecryptedMessage(remoteId: string, content: string): void {
    log(`[STREAM][DECRYPTED] peer=*${remoteId.slice(-8)} length=${content.length}`);
  }
}
