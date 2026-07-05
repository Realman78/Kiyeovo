import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageHandler } from './message-handler.js';
import { GroupCallOrchestrator } from './group-call-orchestrator.js';
import { SessionManager } from '../direct/session-manager.js';
import { CallActivityRegistry } from './call-activity-registry.js';
import type { CallStateChangedEvent, GroupCallPairSignalOutgoingInput } from '../types.js';

const LOCAL_PEER = 'local_peer';
const BLOCKED_PEER = 'blocked_peer';
const OTHER_PEER = 'other_peer';

type TeardownHarness = Record<string, unknown> & {
  teardownBlockedPeer: (peerId: string) => Promise<void>;
};

type GroupCallHarness = Record<string, unknown> & {
  sendPairSignal: (signal: GroupCallPairSignalOutgoingInput) => Promise<{ success: boolean; error: string | null }>;
  handleIncomingControlSignal: (remotePeerId: string, signal: unknown) => Promise<boolean>;
  handleIncomingPairSignal: (remotePeerId: string, signal: unknown) => Promise<boolean>;
};

function createMessageHandlerHarness(): {
  handler: TeardownHarness;
  sessionManager: SessionManager;
  closedPeers: string[];
  callStateEvents: CallStateChangedEvent[];
} {
  const sessionManager = new SessionManager();
  sessionManager.storeSession(BLOCKED_PEER, {
    peerId: BLOCKED_PEER,
    ephemeralPrivateKey: new Uint8Array([1]),
    ephemeralPublicKey: new Uint8Array([2]),
    sendingKey: new Uint8Array([3]),
    receivingKey: new Uint8Array([4]),
    messageCount: 1,
    lastUsed: Date.now(),
  });
  sessionManager.storePendingKeyExchange(BLOCKED_PEER, {
    timestamp: Date.now(),
    ephemeralPrivateKey: new Uint8Array([5]),
    ephemeralPublicKey: new Uint8Array([6]),
  });

  const closedPeers: string[] = [];
  const callStateEvents: CallStateChangedEvent[] = [];
  const handler = Object.create(MessageHandler.prototype) as TeardownHarness;
  handler.activeCall = {
    callId: 'call-1',
    peerId: BLOCKED_PEER,
    direction: 'incoming',
    mediaType: 'audio',
    state: 'active',
  };
  handler.activeCallLastControlSignalTs = null;
  handler.activeCallRingWatchdogTimer = null;
  handler.activeCallPeerDisconnectTimer = null;
  handler.callActivityRegistry = new CallActivityRegistry();
  handler.sessionManager = sessionManager;
  handler.onCallStateChanged = (event: CallStateChangedEvent) => {
    callStateEvents.push(event);
  };
  handler.node = {
    getConnections: () => [
      {
        remotePeer: { toString: () => BLOCKED_PEER },
        close: async () => {
          closedPeers.push(BLOCKED_PEER);
        },
      },
      {
        remotePeer: { toString: () => OTHER_PEER },
        close: async () => {
          closedPeers.push(OTHER_PEER);
        },
      },
    ],
  };
  handler.sendCallSignal = async () => ({ success: false, error: 'Peer is blocked' });

  return { handler, sessionManager, closedPeers, callStateEvents };
}

test('blocking teardown clears active direct call, session state, and peer connections', async () => {
  const { handler, sessionManager, closedPeers, callStateEvents } = createMessageHandlerHarness();
  const originalWarn = console.warn;
  const warnings: string[] = [];

  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    await handler.teardownBlockedPeer(BLOCKED_PEER);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(handler.activeCall, null);
  assert.equal(sessionManager.getSession(BLOCKED_PEER), null);
  assert.equal(sessionManager.getPendingKeyExchange(BLOCKED_PEER), undefined);
  assert.deepEqual(closedPeers, [BLOCKED_PEER]);
  assert.match(warnings[0] ?? '', /Active call teardown signal failed/);
  assert.equal(callStateEvents.length, 1);
  assert.equal(callStateEvents[0]?.peerId, BLOCKED_PEER);
  assert.equal(callStateEvents[0]?.callId, 'call-1');
  assert.equal(callStateEvents[0]?.state, 'ended');
  assert.equal(callStateEvents[0]?.reason, 'hangup');
});

function createGroupCallHarness(): {
  orchestrator: GroupCallHarness;
  controlEvents: unknown[];
  pairEvents: unknown[];
} {
  const controlEvents: unknown[] = [];
  const pairEvents: unknown[] = [];
  const orchestrator = Object.create(GroupCallOrchestrator.prototype) as GroupCallHarness;
  orchestrator.database = {
    isBlocked: (peerId: string) => peerId === BLOCKED_PEER,
    getChatByGroupId: () => {
      throw new Error('blocked signals must not reach group membership validation');
    },
    getUserByPeerId: () => {
      throw new Error('blocked signals must not reach signature validation');
    },
  };
  orchestrator.onControlSignalReceived = (event: unknown) => {
    controlEvents.push(event);
  };
  orchestrator.onPairSignalReceived = (event: unknown) => {
    pairEvents.push(event);
  };
  return { orchestrator, controlEvents, pairEvents };
}

test('group-call signals from blocked peers are dropped before renderer notification', async () => {
  const { orchestrator, controlEvents, pairEvents } = createGroupCallHarness();
  const timestamp = Date.now();

  const handledControl = await orchestrator.handleIncomingControlSignal(BLOCKED_PEER, {
    type: 'CALL_GROUP_STARTED',
    groupId: 'group-1',
    callId: 'call-1',
    fromPeerId: BLOCKED_PEER,
    toPeerId: LOCAL_PEER,
    timestamp,
    signature: 'signature',
  });

  const handledPair = await orchestrator.handleIncomingPairSignal(BLOCKED_PEER, {
    type: 'CALL_OFFER',
    groupId: 'group-1',
    callId: 'call-1',
    offerSdp: 'v=0',
    mediaType: 'audio',
    fromPeerId: BLOCKED_PEER,
    toPeerId: LOCAL_PEER,
    timestamp,
    signature: 'signature',
  });

  assert.equal(handledControl, true);
  assert.equal(handledPair, true);
  assert.deepEqual(controlEvents, []);
  assert.deepEqual(pairEvents, []);
});

test('group-call pair signals to blocked peers are dropped before wire send', async () => {
  const { orchestrator } = createGroupCallHarness();
  const sentSignals: unknown[] = [];
  orchestrator.session = {
    groupId: 'group-1',
    callId: 'call-1',
  };
  orchestrator.trySendPairSignal = async (signal: unknown) => {
    sentSignals.push(signal);
    return true;
  };

  const result = await orchestrator.sendPairSignal({
    type: 'CALL_OFFER',
    groupId: 'group-1',
    callId: 'call-1',
    toPeerId: BLOCKED_PEER,
    offerSdp: 'v=0',
    mediaType: 'audio',
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'peer is blocked');
  assert.deepEqual(sentSignals, []);
});
