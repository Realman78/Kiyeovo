import type { ChatMessage } from "../state/slices/chatSlice";

export const formatRecoveryPhrase = (mnemonic: string): { num: number; word: string }[][] => {
    const words = mnemonic.split(' ');
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push([
        { num: i + 1, word: words[i] || '' },
        { num: i + 7, word: words[i + 6] || '' },
        { num: i + 13, word: words[i + 12] || '' },
        { num: i + 19, word: words[i + 18] || '' },
      ]);
    }
    return rows;
  };


  export const createPendingMessage = (message: string, chatId: number, peerId: string, username: string): ChatMessage => {
    return {
      id: crypto.randomUUID(),
      chatId: chatId,
      senderPeerId: peerId,
      senderUsername: username,
      content: message,
      timestamp: Date.now(),
      messageType: 'text',
      messageSentStatus: 'online',
    };
  };

  export const validateUsername = (value: string, peerId: string) => {
    if (value.length < 3) {
      return "Username must be at least 3 characters";
    }
    if (value.length > 32) {
      return "Username must be less than 32 characters";
    }
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return "Only letters, numbers, and underscores allowed";
    }
    if (value.toLowerCase() === peerId.toLowerCase()) {
      return "Username cannot be the same as your peer ID";
    }
    return "";
  };


const toBase64Url = (bytes: Uint8Array): string => {
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const generateSharedSecretValue = (): string => {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `sec_${toBase64Url(bytes)}`;
};