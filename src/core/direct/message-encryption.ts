import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { privateDecrypt, publicEncrypt, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import type { ConversationSession, EncryptedMessage, OfflineMessage, OfflineSenderInfo } from '../types.js';
import { generalErrorHandler } from '../utils/general-error.js';

/**
 * Handles message encryption and decryption using session keys
 */
export class MessageEncryption {
  static encryptForRecipientOffline(
    content: string,
    recipientPublicKeyPem: string,
  ): {
    messageType: 'encrypted' | 'hybrid';
    content: string;
    encryptedAesKey?: string;
    aesIv?: string;
  } {
    // RSA-OAEP max plaintext for 2048-bit keys
    const RSA_MAX_PLAINTEXT = 214;
    const contentBytes = Buffer.from(content, 'utf8');

    if (contentBytes.byteLength <= RSA_MAX_PLAINTEXT) {
      const encryptedContent = publicEncrypt(recipientPublicKeyPem, contentBytes);
      return {
        messageType: 'encrypted',
        content: encryptedContent.toString('base64'),
      };
    }

    const aesKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(contentBytes), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      messageType: 'hybrid',
      content: Buffer.concat([authTag, ciphertext]).toString('base64'),
      encryptedAesKey: publicEncrypt(recipientPublicKeyPem, aesKey).toString('base64'),
      aesIv: iv.toString('base64'),
    };
  }

  static decryptFromRecipientOffline(
    payload: {
      messageType: 'encrypted' | 'hybrid';
      content: string;
      encryptedAesKey?: string;
      aesIv?: string;
    },
    recipientPrivateKeyPem: string,
  ): string {
    if (payload.messageType === 'hybrid') {
      if (!payload.encryptedAesKey || !payload.aesIv) {
        throw new Error('Malformed encrypted key exchange payload');
      }
      const aesKey = privateDecrypt(recipientPrivateKeyPem, Buffer.from(payload.encryptedAesKey, 'base64'));
      const iv = Buffer.from(payload.aesIv, 'base64');
      const combined = Buffer.from(payload.content, 'base64');
      const authTag = combined.subarray(0, 16);
      const ciphertext = combined.subarray(16);
      const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }

    const encryptedContent = Buffer.from(payload.content, 'base64');
    const decrypted = privateDecrypt(recipientPrivateKeyPem, encryptedContent);
    return decrypted.toString('utf8');
  }

  static encryptMessage(message: string, session: ConversationSession | undefined): EncryptedMessage {
    if (!session || session.sendingKey.length === 0) {
      throw new Error('Cannot encrypt direct message without a valid session');
    }

    try {
      const nonce = randomBytes(24); // XChaCha20-Poly1305 uses 24-byte nonce

      const messageBytes = new TextEncoder().encode(message);
      const cipher = xchacha20poly1305(session.sendingKey, nonce);
      const encryptedBytes = cipher.encrypt(messageBytes);

      // Clear sensitive data immediately after use
      messageBytes.fill(0);

      return {
        type: 'encrypted',
        content: Buffer.from(encryptedBytes).toString('base64'),
        nonce: Buffer.from(nonce).toString('base64'),
        timestamp: Date.now(),
        senderUsername: ''
      };
    } catch (error) {
      console.error('Failed to encrypt message');
      generalErrorHandler(error);
      throw error;
    }
  }

  static decryptMessage(message: EncryptedMessage, session: ConversationSession | undefined): string {
    if (!session || !message.nonce) {
      return '[Failed to decrypt - no session or missing nonce]';
    }

    try {
      const nonce = Buffer.from(message.nonce, 'base64');
      const encryptedBytes = Buffer.from(message.content, 'base64');

      const cipher = xchacha20poly1305(session.receivingKey, nonce);
      const decryptedBytes = cipher.decrypt(encryptedBytes);

      const decryptedText = new TextDecoder().decode(decryptedBytes);

      decryptedBytes.fill(0);

      return decryptedText;
    } catch (error) {
      console.error('Failed to decrypt message');
      generalErrorHandler(error);
      throw error;
    }
  }

  /**
  * Decrypt sender info from offline message
  */
  static decryptSenderInfo(message: OfflineMessage, recipientPrivateKey: string): OfflineSenderInfo | null {
    try {
      const encryptedSenderInfo = Buffer.from(message.encrypted_sender_info, 'base64');
      const decryptedSenderInfo = privateDecrypt(
        recipientPrivateKey,
        encryptedSenderInfo
      );

      const senderInfo: OfflineSenderInfo = JSON.parse(decryptedSenderInfo.toString('utf8'));
      return senderInfo;
    } catch (error: any) {
      console.error('Failed to decrypt sender info:', error.message);
      return null;
    }
  }

  /**
   * Decrypt an offline message using recipient's RSA private key
   */
  static decryptOfflineMessage(message: OfflineMessage, offlinePrivateKey: string): string {
    try {
      if (message.message_type === 'hybrid') {
        if (!message.encrypted_aes_key || !message.aes_iv) {
          return '[Malformed hybrid message: missing key or IV]';
        }
        const aesKey = privateDecrypt(offlinePrivateKey, Buffer.from(message.encrypted_aes_key, 'base64'));
        const iv = Buffer.from(message.aes_iv, 'base64');
        const combined = Buffer.from(message.content, 'base64');
        // First 16 bytes are the GCM auth tag, remainder is ciphertext
        const authTag = combined.subarray(0, 16);
        const ciphertext = combined.subarray(16);
        const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
        decipher.setAuthTag(authTag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      }

      // 'encrypted': RSA-decrypt directly
      const encryptedContent = Buffer.from(message.content, 'base64');
      const decryptedContent = privateDecrypt(
        offlinePrivateKey,
        encryptedContent
      );

      return decryptedContent.toString('utf8');
    } catch (error: unknown) {
      generalErrorHandler(error);
      return '[Failed to decrypt offline message]';
    }
  }

  static isKeyExchange(message: EncryptedMessage): boolean {
    return message.type === 'key_exchange';
  }
} 
