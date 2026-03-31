import type { Stream } from '@libp2p/interface';
import type { StreamHandlerContext, EncryptedMessage } from '../types.js';
import * as fs from 'fs/promises';
import { log } from '../../shared/logger.js';

export class StreamHandler {
  static async readMessageFromStream<T>(stream: Stream): Promise<T> {
    const chunks: Uint8Array[] = [];
    
    for await (const chunk of stream.source) {
      chunks.push((chunk as any).subarray());
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    const messageJson = new TextDecoder().decode(combined);
    return JSON.parse(messageJson) as T;
  }

  static async readFileFromStream(stream: Stream): Promise<any> {
    const chunks: Uint8Array[] = [];
    
    for await (const chunk of stream.source) {
      chunks.push((chunk as any).subarray());
    }

    fs.writeFile('gottenfile.txt', chunks.join(''));
    return true;
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
