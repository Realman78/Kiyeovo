import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ContactAttempt } from '../../components/sidebar/contact-attempts/ContactAttemptItem';
import type { MessageSentStatus } from '../../types';
import type { FileTransferStatus } from '../../../core/types';

// PendingKeyExchange is used for showing messages on the UI (Key Exchange) 
// that are sent, but not accepted by the recipient
export interface PendingKeyExchange {
  username: string;
  peerId: string;
  messageContent?: string;
  expiresAt: number;
}
export interface ChatMessage {
  id: string;
  chatId: number;
  senderPeerId: string;
  senderUsername: string;
  content: string;
  timestamp: number;
  eventTimestamp?: number;
  messageType: 'text' | 'file' | 'image' | 'system';
  messageSentStatus: MessageSentStatus;
  currentUserPeerId?: string; // For determining if message is from current user
  // File transfer fields
  fileName?: string;
  fileSize?: number;
  filePath?: string;
  transferStatus?: FileTransferStatus;
  transferProgress?: number; // Percentage 0-100
  transferError?: string;
  transferExpiresAt?: number;
  localSendState?: 'queued' | 'sending' | 'failed';
  // 'offline_backup' = delivered online, only the DHT backup failed (retry re-stores, not re-sends)
  failedReason?: 'group_rekeying' | 'other' | 'offline_backup';
  retryAfterTs?: number;
}

export interface Chat {
  id: number;
  type: 'direct' | 'group';
  name: string;
  groupId?: string;
  groupCreatorPeerId?: string;
  groupCreatorUsername?: string;
  peerId?: string; // optional because of potential group chats
  lastMessage: string;
  lastMessageTimestamp: number;
  lastInboundActivityTimestamp?: number;
  unreadCount: number;
  status: 'active' | 'pending' | 'awaiting_acceptance';
  justCreated?: boolean; // Flag for newly created chats waiting for first message
  fetchedOffline?: boolean; // Whether offline messages have been checked for this chat
  isFetchingOffline?: boolean; // Whether offline messages are currently being fetched
  offlineFetchNeedsSync?: boolean; // Whether latest offline fetch failed and needs manual retry
  username?: string; // optional because of potential group chats
  trusted_out_of_band?: boolean; // Whether chat was established via out-of-band profile import
  muted?: boolean; // Whether notifications and sounds are muted for this chat
  blocked?: boolean; // Whether the other user is blocked
  hasPendingFile?: boolean; // Whether chat has a pending file request
  groupStatus?: string; // Group-specific status (invited_pending, active, etc.)
  needsRemovedCatchup?: boolean; // Removed-group startup one-time catchup flag
  lastKnownActiveCallId?: string | null;
  lastKnownActiveCallSeenAt?: number | null;
}

interface ChatState {
  chats: Chat[];
  contactAttempts: ContactAttempt[];
  activeChat: Chat | null;
  activeContactAttempt: ContactAttempt | null;
  activePendingKeyExchange: PendingKeyExchange | null;
  pendingKeyExchanges: PendingKeyExchange[];
  messages: ChatMessage[];
  sendingMessages: ChatMessage[];
  loading: boolean;
}

const initialState: ChatState = {
  chats: [],
  contactAttempts: [],
  activeChat: null,
  activeContactAttempt: null,
  activePendingKeyExchange: null,
  pendingKeyExchanges: [],
  messages: [],
  sendingMessages: [],
  loading: false,
};

const compareMessageOrder = (a: ChatMessage, b: ChatMessage): number => {
  return a.timestamp - b.timestamp;
};

const sortChatMessagesInPlace = (messages: ChatMessage[], chatId: number): void => {
  const chatIndexes: number[] = [];
  const chatMessages: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].chatId === chatId) {
      chatIndexes.push(i);
      chatMessages.push(messages[i]);
    }
  }

  if (chatMessages.length <= 1) return;
  chatMessages.sort(compareMessageOrder);

  for (let i = 0; i < chatIndexes.length; i++) {
    messages[chatIndexes[i]] = chatMessages[i];
  }
};

const getLastChatMessage = (messages: ChatMessage[], chatId: number, excludeId?: string): ChatMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.chatId !== chatId) continue;
    if (excludeId && msg.id === excludeId) continue;
    return msg;
  }
  return null;
};

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    setActiveChat: (state, action: PayloadAction<number | null>) => {
      if (action.payload === null) {
        state.activeChat = null
        return
      }
      const chat = state.chats.find((c) => c.id === action.payload);
      if (chat) {
        chat.unreadCount = 0;
        state.activeContactAttempt = null;
        state.activePendingKeyExchange = null;
        state.activeChat = chat;
      }
    },
    setActiveContactAttempt: (state, action: PayloadAction<string | null>) => {
      if (action.payload === null) {
        state.activeContactAttempt = null
        return
      }
      const contactAttempt = state.contactAttempts.find((ca) => ca.peerId === action.payload);
      if (contactAttempt) {
        state.activeChat = null;
        state.activePendingKeyExchange = null;
        state.activeContactAttempt = contactAttempt;
      }
    },
    setActivePendingKeyExchange: (state, action: PayloadAction<string | null>) => {
      if (action.payload === null) {
        state.activePendingKeyExchange = null
        return
      }
      const pendingKeyExchange = state.pendingKeyExchanges.find((pk) => pk.peerId === action.payload);
      if (pendingKeyExchange) {
        state.activeChat = null;
        state.activeContactAttempt = null;
        state.activePendingKeyExchange = pendingKeyExchange;
      }
    },
    addMessage: (state, action: PayloadAction<ChatMessage>) => {
      const { chatId, id } = action.payload;
      const isFromCurrentUser = action.payload.currentUserPeerId &&
                                 action.payload.senderPeerId === action.payload.currentUserPeerId;
      const isOptimisticSeedId = id.startsWith('contact-attempt-' + chatId + '-');

      if (!isOptimisticSeedId) {
        state.messages = state.messages.filter((msg) => {
          if (msg.chatId !== chatId) return true;
          if (!msg.id.startsWith('contact-attempt-' + chatId + '-')) return true;
          if (msg.senderPeerId !== action.payload.senderPeerId) return true;
          return msg.content !== action.payload.content;
        });
      }

      let insertedOrUpdated = false;

      const isDuplicate = state.messages.some(msg => msg.id === id);

      if (isDuplicate) {
        console.log(`Message ${id} already exists, skipping duplicate but updating chat metadata`);
      } else {
        state.messages.push(action.payload);
        insertedOrUpdated = true;
      }

      if (insertedOrUpdated) {
        const chat = state.chats.find((c) => c.id === chatId);
        const lastMessageBeforeInsert = getLastChatMessage(state.messages, chatId, id);
        const isOutOfOrder =
          !!lastMessageBeforeInsert && compareMessageOrder(lastMessageBeforeInsert, action.payload) > 0;

        if (chat?.isFetchingOffline || isOutOfOrder) {
          sortChatMessagesInPlace(state.messages, chatId);
        }
      }

      const chatIndex = state.chats.findIndex((c) => c.id === chatId);
      if (chatIndex !== -1) {
        const chat = state.chats[chatIndex];

        chat.lastMessage = action.payload.content;
        chat.lastMessageTimestamp = action.payload.timestamp;
        if (!isFromCurrentUser) {
          const prevInboundTs = chat.lastInboundActivityTimestamp ?? 0;
          chat.lastInboundActivityTimestamp = Math.max(prevInboundTs, action.payload.timestamp);
        }

        if (chat.justCreated) {
          chat.justCreated = false;
        }

        // Only increment unread count if:
        // - Not a duplicate (already counted)
        // - Chat is not active
        // - Message is not from current user
        if (!isDuplicate && state.activeChat?.id !== chatId && !isFromCurrentUser) {
          chat.unreadCount += 1;
        }

        state.chats.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
      }
    },
    removeMessageById: (state, action: PayloadAction<{ messageId: string; chatId: number }>) => {
      const { messageId, chatId } = action.payload;
      const initialLength = state.messages.length;
      state.messages = state.messages.filter((m) => m.id !== messageId);
      state.sendingMessages = state.sendingMessages.filter((m) => m.id !== messageId);

      if (state.messages.length === initialLength) {
        return;
      }

      const chatIndex = state.chats.findIndex((c) => c.id === chatId);
      if (chatIndex !== -1) {
        const lastMessage = [...state.messages]
          .filter((m) => m.chatId === chatId)
          .sort((a, b) => b.timestamp - a.timestamp)[0];

        if (lastMessage) {
          state.chats[chatIndex].lastMessage = lastMessage.content;
          state.chats[chatIndex].lastMessageTimestamp = lastMessage.timestamp;
        } else {
          state.chats[chatIndex].lastMessage = 'SYSTEM: No messages yet';
        }
      }
    },
    setChats: (state, action: PayloadAction<Chat[]>) => {
      state.chats = action.payload;
      if (state.activeChat) {
        const refreshedActive = state.chats.find((c) => c.id === state.activeChat?.id);
        if (refreshedActive) {
          state.activeChat = refreshedActive;
        }
      }
    },
    addChat: (state, action: PayloadAction<Chat>) => {
      state.chats.push(action.payload);
      state.chats.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
    },
    updateChat: (state, action: PayloadAction<{ id: number; updates: Partial<Chat> }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.id);
      if (chat) {
        Object.assign(chat, action.payload.updates);
        if (state.activeChat?.id === action.payload.id) {
          Object.assign(state.activeChat, action.payload.updates);
        }
        if (action.payload.updates.lastMessageTimestamp !== undefined) {
          state.chats.sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
        }
      }
    },
    removeChat: (state, action: PayloadAction<number>) => {
      state.chats = state.chats.filter((chat) => chat.id !== action.payload);
      state.sendingMessages = state.sendingMessages.filter((m) => m.chatId !== action.payload);
      if (state.activeChat?.id === action.payload) {
        state.messages = [];
        state.sendingMessages = [];
        state.activeChat = null;
      }
    },
    clearMessages: (state, action: PayloadAction<number>) => {
      state.messages = state.messages.filter((m) => m.chatId !== action.payload);
      state.sendingMessages = state.sendingMessages.filter((m) => m.chatId !== action.payload);
    },
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    setContactAttempts: (state, action: PayloadAction<ContactAttempt[]>) => {
      state.contactAttempts = action.payload
    },
    addContactAttempt: (state, action: PayloadAction<ContactAttempt>) => {
      const existingIndex = state.contactAttempts.findIndex((attempt) => attempt.peerId === action.payload.peerId);
      if (existingIndex >= 0) {
        state.contactAttempts[existingIndex] = action.payload;
        if (state.activeContactAttempt?.peerId === action.payload.peerId) {
          state.activeContactAttempt = action.payload;
        }
        return;
      }
      state.contactAttempts.push(action.payload);
    },
    removeContactAttempt: (state, action: PayloadAction<string>) => {
      state.contactAttempts = state.contactAttempts.filter((ca) => ca.peerId !== action.payload);
      if (state.activeContactAttempt?.peerId === action.payload) {
        state.activeContactAttempt = null;
      }
    },
    setMessages: (state, action: PayloadAction<ChatMessage[]>) => {
      state.messages = [...action.payload].sort(compareMessageOrder);
    },
    prependMessages: (state, action: PayloadAction<ChatMessage[]>) => {
      const existingIds = new Set(state.messages.map(m => m.id));
      const newMessages = action.payload.filter(m => !existingIds.has(m.id));
      if (newMessages.length > 0) {
        state.messages = [...newMessages, ...state.messages].sort(compareMessageOrder);
      }
    },
    addSendingMessage: (state, action: PayloadAction<ChatMessage>) => {
      if (!state.sendingMessages.some((m) => m.id === action.payload.id)) {
        state.sendingMessages.push(action.payload);
      }
    },
    removeSendingMessage: (state, action: PayloadAction<string>) => {
      state.sendingMessages = state.sendingMessages.filter((m) => m.id !== action.payload);
    },
    finalizeSendingMessage: (state, action: PayloadAction<{ localMessageId: string; finalMessage: ChatMessage }>) => {
      state.sendingMessages = state.sendingMessages.filter((m) => m.id !== action.payload.localMessageId);
      const isDuplicate = state.messages.some((m) => m.id === action.payload.finalMessage.id);
      if (!isDuplicate) {
        state.messages.push({
          ...action.payload.finalMessage,
          failedReason: undefined,
          retryAfterTs: undefined,
        });
      }
      state.messages.sort(compareMessageOrder);
    },
    setPendingKeyExchanges: (state, action: PayloadAction<PendingKeyExchange[]>) => {
      state.pendingKeyExchanges = action.payload;
    },
    addPendingKeyExchange: (state, action: PayloadAction<PendingKeyExchange>) => {
      const existingIndex = state.pendingKeyExchanges.findIndex((pk) => pk.peerId === action.payload.peerId);
      if (existingIndex >= 0) {
        state.pendingKeyExchanges[existingIndex] = action.payload;
        if (state.activePendingKeyExchange?.peerId === action.payload.peerId) {
          state.activePendingKeyExchange = action.payload;
        }
        return;
      }
      state.pendingKeyExchanges.push(action.payload);
    },
    removePendingKeyExchange: (state, action: PayloadAction<string>) => {
      state.pendingKeyExchanges = state.pendingKeyExchanges.filter((pk) => pk.peerId !== action.payload);
      if (state.activePendingKeyExchange?.peerId === action.payload) {
        state.activePendingKeyExchange = null;
      }
    },
    setOfflineFetchStatus: (state, action: PayloadAction<{ chatId: number; isFetching: boolean }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.chatId);
      if (chat) {
        chat.isFetchingOffline = action.payload.isFetching;
        if (action.payload.isFetching) {
          chat.offlineFetchNeedsSync = false;
        }
        if (state.activeChat?.id === action.payload.chatId) {
          state.activeChat.isFetchingOffline = action.payload.isFetching;
          if (action.payload.isFetching) {
            state.activeChat.offlineFetchNeedsSync = false;
          }
        }
      }
    },
    markOfflineFetched: (state, action: PayloadAction<number | number[]>) => {
      const chatIds = Array.isArray(action.payload) ? action.payload : [action.payload];
      chatIds.forEach(chatId => {
        const chat = state.chats.find((c) => c.id === chatId);
        if (chat) {
          chat.fetchedOffline = true;
          chat.isFetchingOffline = false;
          chat.offlineFetchNeedsSync = false;
          if (state.activeChat?.id === chatId) {
            state.activeChat.fetchedOffline = true;
            state.activeChat.isFetchingOffline = false;
            state.activeChat.offlineFetchNeedsSync = false;
          }
        }
      });
    },
    markOfflineFetchFailed: (state, action: PayloadAction<number | number[]>) => {
      const chatIds = Array.isArray(action.payload) ? action.payload : [action.payload];
      chatIds.forEach(chatId => {
        const chat = state.chats.find((c) => c.id === chatId);
        if (chat) {
          chat.fetchedOffline = false;
          chat.isFetchingOffline = false;
          chat.offlineFetchNeedsSync = true;
          if (state.activeChat?.id === chatId) {
            state.activeChat.fetchedOffline = false;
            state.activeChat.isFetchingOffline = false;
            state.activeChat.offlineFetchNeedsSync = true;
          }
        }
      });
    },
    // File transfer actions
    updateFileTransferProgress: (state, action: PayloadAction<{ messageId: string; progress: number; chatId: number; filename: string; size: number }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        if (message.transferStatus === 'completed' || message.transferStatus === 'failed' || message.transferStatus === 'expired' || message.transferStatus === 'rejected') {
          return;
        }
        message.fileName = action.payload.filename;
        message.fileSize = action.payload.size;
        message.transferProgress = action.payload.progress;
        if (message.transferStatus !== 'in_progress') {
          message.transferStatus = 'in_progress';
        }
      }
    },
    updateFileTransferStatus: (state, action: PayloadAction<{
      messageId: string;
      status: FileTransferStatus;
      filePath?: string;
      transferError?: string;
      transferExpiresAt?: number;
    }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.transferStatus = action.payload.status;
        if (action.payload.transferExpiresAt !== undefined) {
          message.transferExpiresAt = action.payload.transferExpiresAt;
        }
        if (action.payload.status === 'completed' && action.payload.filePath) {
          message.filePath = action.payload.filePath;
        }
        if (action.payload.status === 'completed') {
          message.transferProgress = 100;
        }
        if (action.payload.transferError) {
          message.transferError = action.payload.transferError;
        }
      }
    },
    updateFileTransferError: (state, action: PayloadAction<{ messageId: string; error: string }>) => {
      const message = state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.transferStatus = 'failed';
        message.transferError = action.payload.error;
      }
    },
    updateLocalMessageSendState: (
      state,
      action: PayloadAction<{
        messageId: string;
        state: 'queued' | 'sending' | 'failed';
        failedReason?: 'group_rekeying' | 'other' | 'offline_backup';
        retryAfterTs?: number;
      }>
    ) => {
      const message = state.sendingMessages.find((m) => m.id === action.payload.messageId)
        ?? state.messages.find((m) => m.id === action.payload.messageId);
      if (message) {
        message.localSendState = action.payload.state;
        if (action.payload.state === 'failed') {
          message.failedReason = action.payload.failedReason ?? 'other';
          message.retryAfterTs = action.payload.retryAfterTs;
        } else {
          message.failedReason = undefined;
          message.retryAfterTs = undefined;
        }
      }
    },
    setPendingFileStatus: (state, action: PayloadAction<{ chatId: number; hasPendingFile: boolean }>) => {
      const chat = state.chats.find((c) => c.id === action.payload.chatId);
      if (chat) {
        chat.hasPendingFile = action.payload.hasPendingFile;
      }
    },
    // outcome for a backgrounded send (offline DHT write).
    // 'delivered' settles the row (clears the spinner, stamps messageSentStatus);
    // 'failed' surfaces Retry; 'sending' keeps it in flight.
    resolveMessageSendOutcome: (
      state,
      action: PayloadAction<{
        messageId: string;
        outcome: 'sending' | 'delivered' | 'failed';
        messageSentStatus?: MessageSentStatus;
        failedReason?: 'group_rekeying' | 'other' | 'offline_backup';
        retryAfterTs?: number;
      }>
    ) => {
      const message = state.sendingMessages.find((m) => m.id === action.payload.messageId)
        ?? state.messages.find((m) => m.id === action.payload.messageId);
      if (!message) {
        return;
      }
      if (action.payload.outcome === 'delivered') {
        message.localSendState = undefined;
        message.failedReason = undefined;
        message.retryAfterTs = undefined;
        if (action.payload.messageSentStatus !== undefined) {
          message.messageSentStatus = action.payload.messageSentStatus;
        }
      } else if (action.payload.outcome === 'failed') {
        message.localSendState = 'failed';
        message.failedReason = action.payload.failedReason ?? 'other';
        message.retryAfterTs = action.payload.retryAfterTs;
      } else {
        message.localSendState = 'sending';
        message.failedReason = undefined;
        message.retryAfterTs = undefined;
      }
    },
  },
});

export const {
  setActiveChat,
  setActiveContactAttempt,
  setActivePendingKeyExchange,
  addMessage,
  setChats,
  addChat,
  updateChat,
  removeChat,
  clearMessages,
  setLoading,
  setContactAttempts,
  addContactAttempt,
  removeContactAttempt,
  setMessages,
  prependMessages,
  addSendingMessage,
  removeSendingMessage,
  finalizeSendingMessage,
  setPendingKeyExchanges,
  addPendingKeyExchange,
  removePendingKeyExchange,
  setOfflineFetchStatus,
  markOfflineFetched,
  markOfflineFetchFailed,
  updateFileTransferProgress,
  updateFileTransferStatus,
  updateFileTransferError,
  updateLocalMessageSendState,
  resolveMessageSendOutcome,
  setPendingFileStatus,
  removeMessageById
} = chatSlice.actions;

export default chatSlice.reducer;
