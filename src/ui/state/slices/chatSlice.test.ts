import assert from 'node:assert/strict';
import test from 'node:test';
import chatReducer, {
  addMessage,
  removeMessagesByIds,
  resolveMessageSendOutcome,
  setActiveChat,
  setChats,
  setMessages,
  setReplyTarget,
  updateFileTransferProgress,
  updateFileTransferStatus,
  type Chat,
  type ChatMessage,
} from './chatSlice.js';

function makeChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 1,
    type: 'direct',
    name: 'Alice',
    peerId: 'peer-alice',
    lastMessage: 'SYSTEM: No messages yet',
    lastMessageTimestamp: 0,
    unreadCount: 0,
    status: 'active',
    ...overrides,
  };
}

function withoutConsoleLog<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return run();
  } finally {
    console.log = originalLog;
  }
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    chatId: 1,
    senderPeerId: 'peer-alice',
    senderUsername: 'Alice',
    content: 'hello',
    timestamp: 1_000,
    messageType: 'text',
    messageSentStatus: 'online',
    currentUserPeerId: 'local-peer',
    ...overrides,
  };
}

test('addMessage updates unread and inbound activity only for inactive inbound messages', () => {
  let state = chatReducer(undefined, setChats([
    makeChat({ id: 1, justCreated: true }),
    makeChat({ id: 2, name: 'Bob', lastMessageTimestamp: 50 }),
  ]));
  state = chatReducer(state, setActiveChat(2));

  state = chatReducer(state, addMessage(makeMessage({
    id: 'inbound-1',
    chatId: 1,
    senderPeerId: 'peer-alice',
    currentUserPeerId: 'local-peer',
    content: 'inbound',
    timestamp: 100,
  })));

  let chat = state.chats.find((candidate) => candidate.id === 1);
  assert.equal(chat?.unreadCount, 1);
  assert.equal(chat?.lastInboundActivityTimestamp, 100);
  assert.equal(chat?.justCreated, false);

  state = withoutConsoleLog(() => chatReducer(state, addMessage(makeMessage({
    id: 'inbound-1',
    chatId: 1,
    senderPeerId: 'peer-alice',
    currentUserPeerId: 'local-peer',
    content: 'inbound',
    timestamp: 100,
  }))));
  chat = state.chats.find((candidate) => candidate.id === 1);
  assert.equal(chat?.unreadCount, 1);

  state = chatReducer(state, addMessage(makeMessage({
    id: 'self-1',
    chatId: 1,
    senderPeerId: 'local-peer',
    currentUserPeerId: 'local-peer',
    content: 'self send',
    timestamp: 200,
  })));
  chat = state.chats.find((candidate) => candidate.id === 1);
  assert.equal(chat?.unreadCount, 1);
  assert.equal(chat?.lastInboundActivityTimestamp, 100);
});

test('removeMessagesByIds clears deleted reply targets and keeps the newest settled Redux preview', () => {
  let state = chatReducer(undefined, setChats([
    makeChat({ id: 1, lastMessage: 'newer', lastMessageTimestamp: 300 }),
  ]));
  state = chatReducer(state, setMessages([
    makeMessage({ id: 'old', clientMsgId: 'cid-old', content: 'old', timestamp: 100 }),
    makeMessage({ id: 'newer', clientMsgId: 'cid-newer', content: 'newer', timestamp: 300 }),
    makeMessage({
      id: 'queued',
      clientMsgId: 'cid-queued',
      content: 'queued',
      timestamp: 400,
      localSendState: 'sending',
    }),
  ]));
  state = chatReducer(state, setReplyTarget({
    chatId: 1,
    target: { cid: 'cid-old', sender: 'Alice', excerpt: 'old' },
  }));

  state = chatReducer(state, removeMessagesByIds({
    chatId: 1,
    messageIds: ['old'],
    latestRemaining: { content: 'database older', timestamp: 200 },
  }));

  assert.equal(state.replyTargetByChatId[1], undefined);
  assert.equal(state.chats[0].lastMessage, 'newer');
  assert.equal(state.chats[0].lastMessageTimestamp, 300);
});

test('file transfer reducers ignore progress after terminal state and finalize completed paths', () => {
  let state = chatReducer(undefined, setMessages([
    makeMessage({
      id: 'terminal-file',
      messageType: 'file',
      transferStatus: 'completed',
      transferProgress: 100,
      fileName: 'done.txt',
      fileSize: 10,
    }),
    makeMessage({
      id: 'pending-file',
      messageType: 'file',
      transferStatus: 'incoming_pending_user',
      transferProgress: 0,
    }),
  ]));

  state = chatReducer(state, updateFileTransferProgress({
    messageId: 'terminal-file',
    chatId: 1,
    filename: 'done.txt',
    size: 10,
    progress: 20,
  }));
  assert.equal(state.messages.find((message) => message.id === 'terminal-file')?.transferProgress, 100);

  state = chatReducer(state, updateFileTransferProgress({
    messageId: 'pending-file',
    chatId: 1,
    filename: 'pending.txt',
    size: 20,
    progress: 25,
  }));
  let pending = state.messages.find((message) => message.id === 'pending-file');
  assert.equal(pending?.transferStatus, 'in_progress');
  assert.equal(pending?.transferProgress, 25);

  state = chatReducer(state, updateFileTransferStatus({
    messageId: 'pending-file',
    status: 'completed',
    filePath: '/downloads/pending.txt',
  }));
  pending = state.messages.find((message) => message.id === 'pending-file');
  assert.equal(pending?.transferStatus, 'completed');
  assert.equal(pending?.transferProgress, 100);
  assert.equal(pending?.filePath, '/downloads/pending.txt');
});

test('resolveMessageSendOutcome clears retry state and does not regress a newer chat preview', () => {
  let state = chatReducer(undefined, setChats([
    makeChat({ id: 1, lastMessage: 'new inbound', lastMessageTimestamp: 500 }),
  ]));
  state = chatReducer(state, setMessages([
    makeMessage({
      id: 'offline-send',
      content: 'offline send',
      timestamp: 400,
      localSendState: 'failed',
      failedReason: 'group_rekeying',
      retryAfterTs: 1_000,
      messageSentStatus: 'offline',
    }),
  ]));

  state = chatReducer(state, resolveMessageSendOutcome({
    messageId: 'offline-send',
    outcome: 'delivered',
    messageSentStatus: 'offline',
  }));

  const message = state.messages.find((candidate) => candidate.id === 'offline-send');
  assert.equal(message?.localSendState, undefined);
  assert.equal(message?.failedReason, undefined);
  assert.equal(message?.retryAfterTs, undefined);
  assert.equal(state.chats[0].lastMessage, 'new inbound');
  assert.equal(state.chats[0].lastMessageTimestamp, 500);
});
