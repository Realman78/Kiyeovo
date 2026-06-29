import { MAX_MESSAGE_CONTENT_LENGTH } from '../constants.js';

export function validateUsername(username: string): boolean {
    // Allow alphanumeric, underscore, hyphen
    // Length: 1-32 characters
    const usernameRegex = /^[a-zA-Z0-9_-]{1,32}$/;
    return usernameRegex.test(username);
}

export function validateFileId(fileId: string): boolean {
    // UUIDs are 36 characters with hyphens
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(fileId);
}

export function validateMessageLength(
    message: string,
    maxLength: number = MAX_MESSAGE_CONTENT_LENGTH,
): boolean {
    return message.length <= maxLength;
}

export function decodeBase64Strict(value: string): Uint8Array | null {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(trimmed)) return null;
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === 0) return null;
      if (decoded.toString("base64") !== trimmed) return null;
      return decoded;
    } catch {
      return null;
    }
  }
