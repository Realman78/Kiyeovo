import { randomUUID } from 'crypto';
import { peerIdFromString } from '@libp2p/peer-id';
import { NETWORK_MODES, getNetworkModeRuntime } from '../constants.js';
import type {
  ChatNode,
  GroupCallControlSignalForRenderer,
  GroupCallControlSignalMessage,
  GroupCallControlSignalReceivedEvent,
  GroupCallControlSignalWithoutSignature,
  GroupCallErrorEvent,
  GroupCallPairSignalForRenderer,
  GroupCallPairSignalMessage,
  GroupCallPairSignalOutgoingInput,
  GroupCallPairSignalReceivedEvent,
  GroupCallParticipant,
  GroupCallRole,
  GroupCallState,
  GroupCallStateChangedEvent,
  GroupCallQueryResponseSignal,
} from '../types.js';
import { log } from '../../shared/logger.js';
import type { Chat } from '../db/database.js';
import { ChatDatabase } from '../db/database.js';
import { CallActivityRegistry } from './call-activity-registry.js';
import {
  GROUP_CALL_SIGNAL_DEDUPE_MAX_ENTRIES,
  GROUP_CALL_SIGNAL_DEDUPE_TTL_MS,
  assertGroupCallSignalAllowed,
  buildSignedGroupCallSignal,
  isGroupCallControlSignalMessage,
  isGroupCallPairSignalMessage,
  verifyIncomingGroupCallSignal,
} from './group-call-signaling.js';
import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import { dialProtocolWithRelayFallback } from '../transport/protocol-dialer.js';
import { errStr } from '../utils/general-error.js';

const CONTROL_SIGNAL_TIMEOUT_MS = 5_000;
const DISCOVERY_QUERY_TIMEOUT_MS = 10_000;
const DISCOVERY_SETTLE_AFTER_FIRST_MS = 1_000;
const DISCOVERY_CONFLICT_RETRY_DELAY_MS = 2_000;
const DISCOVERY_CACHE_TTL_MS = 1_500;

type GroupCallActionResult = {
  success: boolean;
  error: string | null;
  outcome?: 'created' | 'existing';
  callId?: string;
};

type GroupCallSession = {
  chatId: number;
  groupId: string;
  callId: string;
  rosterVersion: number;
  authoritativeParticipants: GroupCallParticipant[];
  connectionParticipants: string[];
  role: GroupCallRole;
  state: GroupCallState;
};

type QueryWinner = {
  callId: string;
  rosterVersion: number;
  participants: GroupCallParticipant[];
  writerPeerId: string;
  timestamp: number;
};

type QueryResolution =
  | { kind: 'zero' }
  | { kind: 'conflict' }
  | { kind: 'winner'; winner: QueryWinner };

type PendingQuery = {
  groupId: string;
  requestId: string;
  responses: GroupCallQueryResponseSignal[];
  resolve: (responses: GroupCallQueryResponseSignal[]) => void;
  settleTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout>;
};

type GroupCallOrchestratorConfig = {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: Pick<EncryptedUserIdentity, 'sign'>;
  callActivityRegistry: CallActivityRegistry;
  onControlSignalReceived?: (data: GroupCallControlSignalReceivedEvent) => void;
  onPairSignalReceived?: (data: GroupCallPairSignalReceivedEvent) => void;
  onStateChanged?: (data: GroupCallStateChangedEvent) => void;
  onError?: (data: GroupCallErrorEvent) => void;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortParticipants(participants: GroupCallParticipant[]): GroupCallParticipant[] {
  return [...participants].sort((left, right) => compareStrings(left.peerId, right.peerId));
}

function sameParticipantRoster(
  left: GroupCallParticipant[],
  right: GroupCallParticipant[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = sortParticipants(left);
  const sortedRight = sortParticipants(right);
  return sortedLeft.every((participant, index) => participant.peerId === sortedRight[index]?.peerId);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroupCallOrchestrator {
  private readonly node: ChatNode;
  private readonly database: ChatDatabase;
  private readonly userIdentity: Pick<EncryptedUserIdentity, 'sign'>;
  private readonly callActivityRegistry: CallActivityRegistry;
  private readonly callSignalProtocol: string;
  private readonly onControlSignalReceived: (data: GroupCallControlSignalReceivedEvent) => void;
  private readonly onPairSignalReceived: (data: GroupCallPairSignalReceivedEvent) => void;
  private readonly onStateChanged: (data: GroupCallStateChangedEvent) => void;
  private readonly onError: (data: GroupCallErrorEvent) => void;
  private readonly seenSignalSignatures = new Map<string, number>();
  private readonly pendingQueriesByGroupId = new Map<string, Promise<QueryResolution>>();
  private readonly pendingQueriesByRequestId = new Map<string, PendingQuery>();
  private readonly recentQueryResults = new Map<string, { resolvedAt: number; result: QueryResolution }>();
  private session: GroupCallSession | null = null;
  private storeDurableHint: ((groupId: string) => Promise<void>) | null = null;

  constructor(config: GroupCallOrchestratorConfig) {
    this.node = config.node;
    this.database = config.database;
    this.userIdentity = config.userIdentity;
    this.callActivityRegistry = config.callActivityRegistry;
    this.callSignalProtocol = getNetworkModeRuntime(this.database.getSessionNetworkMode()).config.callSignalProtocol;
    this.onControlSignalReceived = config.onControlSignalReceived ?? (() => undefined);
    this.onPairSignalReceived = config.onPairSignalReceived ?? (() => undefined);
    this.onStateChanged = config.onStateChanged ?? (() => undefined);
    this.onError = config.onError ?? (() => undefined);
  }

  setDurableHintStorage(storeDurableHint: ((groupId: string) => Promise<void>) | null): void {
    this.storeDurableHint = storeDurableHint;
  }

  hasActiveCall(): boolean {
    return this.callActivityRegistry.hasGroupCall();
  }

  async startGroupCall(chatId: number): Promise<GroupCallActionResult> {
    try {
      const chat = this.requireEligibleGroupChat(chatId);
      const gate = this.callActivityRegistry.canUseGroupCall({ groupId: chat.group_id! });
      if (!gate.allowed) {
        return { success: false, error: gate.error };
      }

      if (this.session && this.session.groupId === chat.group_id) {
        return { success: true, error: null, outcome: 'created', callId: this.session.callId };
      }

      const queryResolution = await this.discoverActiveCall(chat);
      if (queryResolution.kind === 'winner') {
        this.writePersistentCallEvidence(chat.id, queryResolution.winner.callId, queryResolution.winner.timestamp);
        return {
          success: true,
          error: null,
          outcome: 'existing',
          callId: queryResolution.winner.callId,
        };
      }
      if (queryResolution.kind === 'conflict') {
        return { success: false, error: 'Call state conflict - please try again' };
      }

      const callId = randomUUID();
      const joinedAt = Date.now();
      const participants: GroupCallParticipant[] = [{ peerId: this.localPeerId(), joinedAt }];
      this.session = {
        chatId: chat.id,
        groupId: chat.group_id!,
        callId,
        rosterVersion: 1,
        authoritativeParticipants: participants,
        connectionParticipants: [this.localPeerId()],
        role: 'writer',
        state: 'waiting',
      };
      this.callActivityRegistry.setGroupCall({ callId, groupId: chat.group_id! });
      this.writePersistentCallEvidence(chat.id, callId, joinedAt);
      this.emitStateChanged('waiting', { reason: 'started' });

      void this.broadcastStartedSignal(chat, callId, participants, 1);
      return { success: true, error: null, outcome: 'created', callId };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start group call' };
    }
  }

  async joinGroupCall(_chatId: number): Promise<GroupCallActionResult> {
    return { success: false, error: 'Group call join is not implemented yet' };
  }

  async leaveGroupCall(chatId: number): Promise<GroupCallActionResult> {
    try {
      this.requireEligibleGroupChat(chatId);
      if (!this.callActivityRegistry.hasGroupCall()) {
        return { success: false, error: 'No active group call' };
      }
      return { success: false, error: 'Group call leave is not implemented yet' };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to leave group call' };
    }
  }

  async sendPairSignal(_signal: GroupCallPairSignalOutgoingInput): Promise<{ success: boolean; error: string | null }> {
    return { success: false, error: 'Group call pair signaling is not implemented yet' };
  }

  async handleDurableHint(groupId: string): Promise<void> {
    if (this.session?.groupId === groupId) {
      return;
    }

    const chat = this.database.getChatByGroupId(groupId);
    if (!chat || chat.type !== 'group') {
      return;
    }
    if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') {
      return;
    }

    log(`[GROUP-CALL][HINT] Received durable hint for group=${groupId.slice(0, 8)}`);
    const queryResolution = await this.discoverActiveCall(chat);
    if (queryResolution.kind === 'winner') {
      this.writePersistentCallEvidence(chat.id, queryResolution.winner.callId, queryResolution.winner.timestamp);
      return;
    }
    if (queryResolution.kind === 'zero') {
      this.clearPersistentCallEvidence(chat.id);
    }
  }

  async handleIncomingControlSignal(remotePeerId: string, signal: unknown): Promise<boolean> {
    if (!isGroupCallControlSignalMessage(signal)) {
      return false;
    }
    if (!this.verifyAndRecordIncomingSignal(remotePeerId, signal)) {
      return true;
    }

    await this.applyIncomingControlSignal(signal);
    this.onControlSignalReceived({
      signal: this.stripControlSignalSignature(signal),
      receivedAt: Date.now(),
    });
    return true;
  }

  async handleIncomingPairSignal(remotePeerId: string, signal: unknown): Promise<boolean> {
    if (!isGroupCallPairSignalMessage(signal)) {
      return false;
    }
    if (!this.verifyAndRecordIncomingSignal(remotePeerId, signal)) {
      return true;
    }

    this.onPairSignalReceived({
      signal: this.stripPairSignalSecrets(signal),
      receivedAt: Date.now(),
    });
    return true;
  }

  private async applyIncomingControlSignal(signal: GroupCallControlSignalMessage): Promise<void> {
    switch (signal.type) {
      case 'CALL_GROUP_STARTED':
        this.handleStartedSignal(signal);
        return;
      case 'GROUP_CALL_QUERY':
        await this.respondToQuery(signal);
        return;
      case 'GROUP_CALL_QUERY_RESPONSE':
        this.handleQueryResponse(signal);
        return;
      case 'CALL_GROUP_ENDED':
        this.handleEndedSignal(signal);
        return;
      default:
        return;
    }
  }

  private handleStartedSignal(signal: GroupCallControlSignalMessage & { type: 'CALL_GROUP_STARTED' }): void {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return;
    }

    if (this.session?.groupId === signal.groupId && this.session.callId !== signal.callId) {
      if (compareStrings(signal.callId, this.session.callId) < 0) {
        log(
          `[GROUP-CALL][DISCOVERY] Superseded local call group=${signal.groupId.slice(0, 8)} old=${this.session.callId.slice(0, 8)} new=${signal.callId.slice(0, 8)}`,
        );
        this.endLocalSession('superseded');
      } else {
        return;
      }
    }

    if (
      chat.last_known_active_call_id
      && chat.last_known_active_call_id !== signal.callId
      && compareStrings(signal.callId, chat.last_known_active_call_id) > 0
    ) {
      return;
    }

    this.writePersistentCallEvidence(chat.id, signal.callId, signal.timestamp);
  }

  private async respondToQuery(signal: GroupCallControlSignalMessage & { type: 'GROUP_CALL_QUERY' }): Promise<void> {
    if (!this.session || this.session.groupId !== signal.groupId) {
      return;
    }

    const response: GroupCallControlSignalWithoutSignature = {
      type: 'GROUP_CALL_QUERY_RESPONSE',
      groupId: signal.groupId,
      callId: this.session.callId,
      requestId: signal.requestId,
      rosterVersion: this.session.rosterVersion,
      participants: this.session.authoritativeParticipants,
      fromPeerId: this.localPeerId(),
      toPeerId: signal.fromPeerId,
      timestamp: Date.now(),
    };
    await this.trySendControlSignal(response);
  }

  private handleQueryResponse(signal: GroupCallControlSignalMessage & { type: 'GROUP_CALL_QUERY_RESPONSE' }): void {
    const pending = this.pendingQueriesByRequestId.get(signal.requestId);
    if (!pending || pending.groupId !== signal.groupId) {
      return;
    }
    if (!this.isValidQueryResponse(signal)) {
      return;
    }

    pending.responses.push(signal);
    if (!pending.settleTimer) {
      pending.settleTimer = setTimeout(() => {
        this.resolvePendingQuery(signal.requestId);
      }, DISCOVERY_SETTLE_AFTER_FIRST_MS);
    }
  }

  private handleEndedSignal(signal: GroupCallControlSignalMessage & { type: 'CALL_GROUP_ENDED' }): void {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat || chat.last_known_active_call_id !== signal.callId) {
      return;
    }
    this.clearPersistentCallEvidence(chat.id);
  }

  private async discoverActiveCall(
    chat: Chat,
    options?: { bypassCache?: boolean },
  ): Promise<QueryResolution> {
    const cached = this.recentQueryResults.get(chat.group_id!);
    if (
      !options?.bypassCache
      && cached
      && cached.resolvedAt >= Date.now() - DISCOVERY_CACHE_TTL_MS
    ) {
      return cached.result;
    }

    const existing = this.pendingQueriesByGroupId.get(chat.group_id!);
    if (!options?.bypassCache && existing) {
      return existing;
    }

    const queryPromise = this.runDiscoveryQuery(chat)
      .finally(() => {
        this.pendingQueriesByGroupId.delete(chat.group_id!);
      });

    this.pendingQueriesByGroupId.set(chat.group_id!, queryPromise);
    const result = await queryPromise;
    this.recentQueryResults.set(chat.group_id!, { resolvedAt: Date.now(), result });
    return result;
  }

  private async runDiscoveryQuery(chat: Chat): Promise<QueryResolution> {
    const firstResponses = await this.collectQueryResponses(chat);
    const firstResolution = this.resolveQueryResponses(chat, firstResponses);
    if (firstResolution.kind !== 'conflict') {
      return firstResolution;
    }

    await delay(DISCOVERY_CONFLICT_RETRY_DELAY_MS);
    const secondResponses = await this.collectQueryResponses(chat);
    return this.resolveQueryResponses(chat, secondResponses);
  }

  private async collectQueryResponses(chat: Chat): Promise<GroupCallQueryResponseSignal[]> {
    const targets = this.getGroupMemberPeerIds(chat.id);
    if (targets.length === 0) {
      return [];
    }

    const requestId = randomUUID();
    const responsePromise = new Promise<GroupCallQueryResponseSignal[]>((resolve) => {
      const hardTimer = setTimeout(() => {
        this.resolvePendingQuery(requestId);
      }, DISCOVERY_QUERY_TIMEOUT_MS);

      this.pendingQueriesByRequestId.set(requestId, {
        groupId: chat.group_id!,
        requestId,
        responses: [],
        resolve,
        settleTimer: null,
        hardTimer,
      });
    });

    const sendResults = await Promise.allSettled(
      targets.map(async (peerId) => this.trySendControlSignal({
        type: 'GROUP_CALL_QUERY',
        groupId: chat.group_id!,
        requestId,
        fromPeerId: this.localPeerId(),
        toPeerId: peerId,
        timestamp: Date.now(),
      })),
    );

    const sentCount = sendResults.filter((result) => result.status === 'fulfilled' && result.value).length;
    if (sentCount === 0) {
      this.resolvePendingQuery(requestId);
    }

    const responses = await responsePromise;

    log(
      `[GROUP-CALL][QUERY] group=${chat.group_id?.slice(0, 8)} request=${requestId.slice(0, 8)} targets=${targets.length} sent=${sentCount} responses=${responses.length}`,
    );
    return responses;
  }

  private resolvePendingQuery(requestId: string): void {
    const pending = this.pendingQueriesByRequestId.get(requestId);
    if (!pending) {
      return;
    }

    if (pending.settleTimer) {
      clearTimeout(pending.settleTimer);
    }
    clearTimeout(pending.hardTimer);
    this.pendingQueriesByRequestId.delete(requestId);
    pending.resolve(pending.responses);
  }

  private resolveQueryResponses(chat: Chat, responses: GroupCallQueryResponseSignal[]): QueryResolution {
    if (responses.length === 0) {
      return { kind: 'zero' };
    }

    const byCallId = new Map<string, GroupCallQueryResponseSignal[]>();
    for (const response of responses) {
      const existing = byCallId.get(response.callId) ?? [];
      existing.push(response);
      byCallId.set(response.callId, existing);
    }

    const winningCallId = [...byCallId.keys()].sort(compareStrings)[0];
    if (!winningCallId) {
      return { kind: 'zero' };
    }
    const winningCallResponses = byCallId.get(winningCallId);
    if (!winningCallResponses || winningCallResponses.length === 0) {
      return { kind: 'zero' };
    }

    const highestRosterVersion = Math.max(...winningCallResponses.map((response) => response.rosterVersion));
    const highestVersionResponses = winningCallResponses.filter((response) => response.rosterVersion === highestRosterVersion);
    const canonical = highestVersionResponses[0];
    if (!canonical) {
      return { kind: 'zero' };
    }

    const conflicting = highestVersionResponses.some(
      (response) => !sameParticipantRoster(response.participants, canonical.participants),
    );
    if (conflicting) {
      return { kind: 'conflict' };
    }

    return {
      kind: 'winner',
      winner: {
        callId: canonical.callId,
        rosterVersion: canonical.rosterVersion,
        participants: sortParticipants(canonical.participants),
        writerPeerId: this.deriveWriterPeerId(chat, canonical.participants),
        timestamp: canonical.timestamp,
      },
    };
  }

  private deriveWriterPeerId(chat: Chat, participants: GroupCallParticipant[]): string {
    const participantPeerIds = participants.map((participant) => participant.peerId);
    if (chat.group_creator_peer_id && participantPeerIds.includes(chat.group_creator_peer_id)) {
      return chat.group_creator_peer_id;
    }

    return [...participantPeerIds].sort(compareStrings)[0] ?? '';
  }

  private isValidQueryResponse(signal: GroupCallQueryResponseSignal): boolean {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return false;
    }

    const currentMembers = new Set(
      this.database.getChatParticipants(chat.id).map((participant) => participant.peer_id),
    );
    const seenPeerIds = new Set<string>();
    return signal.participants.every((participant) => {
      if (!currentMembers.has(participant.peerId) || seenPeerIds.has(participant.peerId)) {
        return false;
      }
      seenPeerIds.add(participant.peerId);
      return true;
    });
  }

  private async broadcastStartedSignal(
    chat: Chat,
    callId: string,
    participants: GroupCallParticipant[],
    rosterVersion: number,
  ): Promise<void> {
    const peers = this.getGroupMemberPeerIds(chat.id);
    const sendResults = await Promise.allSettled(
      peers.map(async (peerId) => this.trySendControlSignal({
        type: 'CALL_GROUP_STARTED',
        groupId: chat.group_id!,
        callId,
        fromPeerId: this.localPeerId(),
        toPeerId: peerId,
        timestamp: Date.now(),
      })),
    );
    const sentStarted = sendResults.filter((result) => result.status === 'fulfilled' && result.value).length;

    log(
      `[GROUP-CALL][START] group=${chat.group_id?.slice(0, 8)} call=${callId.slice(0, 8)} startedFanout=${sentStarted}/${peers.length} rosterVersion=${rosterVersion} participants=${participants.length}`,
    );

    if (this.storeDurableHint) {
      try {
        await this.storeDurableHint(chat.group_id!);
      } catch (error: unknown) {
        this.emitError(errStr(error, 'Failed to store durable group call hint'), {
          chatId: chat.id,
          groupId: chat.group_id!,
          callId,
          code: 'GROUP_CALL_HINT_STORE_FAILED',
        });
      }
    }
  }

  private async openControlStream(targetPeerId: string): Promise<Awaited<ReturnType<ChatNode['dialProtocol']>>> {
    const connections = this.node
      .getConnections()
      .filter((conn) => conn.remotePeer.toString() === targetPeerId && conn.status === 'open');

    for (const conn of connections) {
      try {
        return await conn.newStream(this.callSignalProtocol, {
          signal: AbortSignal.timeout(CONTROL_SIGNAL_TIMEOUT_MS),
          runOnLimitedConnection: true,
        });
      } catch {
        // Try next connection, then fall back to a dial attempt.
      }
    }

    return dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId: peerIdFromString(targetPeerId),
      protocol: this.callSignalProtocol,
      context: 'group_call_signal',
    });
  }

  private async trySendControlSignal(unsignedSignal: GroupCallControlSignalWithoutSignature): Promise<boolean> {
    try {
      const signedSignal = buildSignedGroupCallSignal(unsignedSignal, this.userIdentity);
      const stream = await this.openControlStream(unsignedSignal.toPeerId);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(signedSignal));
      await stream.sink([payloadBytes]);
      await stream.close();
      return true;
    } catch (error: unknown) {
      log(
        `[GROUP-CALL][SEND][FAIL] type=${unsignedSignal.type} to=${unsignedSignal.toPeerId.slice(-8)} reason=${errStr(error)}`,
      );
      return false;
    }
  }

  private getGroupMemberPeerIds(chatId: number): string[] {
    return this.database.getChatParticipants(chatId)
      .map((participant) => participant.peer_id)
      .filter((peerId) => peerId !== this.localPeerId());
  }

  private localPeerId(): string {
    return this.node.peerId.toString();
  }

  private writePersistentCallEvidence(chatId: number, callId: string, seenAt: number): void {
    this.database.setLastKnownActiveCall(chatId, callId, seenAt);
  }

  private clearPersistentCallEvidence(chatId: number): void {
    this.database.clearLastKnownActiveCall(chatId);
  }

  private endLocalSession(reason: string): void {
    if (!this.session) {
      return;
    }

    const endedSession = this.session;
    this.session = null;
    this.callActivityRegistry.setGroupCall(null);
    this.onStateChanged({
      chatId: endedSession.chatId,
      groupId: endedSession.groupId,
      callId: endedSession.callId,
      state: 'ended',
      role: endedSession.role,
      reason,
      timestamp: Date.now(),
    });
  }

  private emitStateChanged(state: GroupCallState, options?: { reason?: string }): void {
    if (!this.session) {
      return;
    }

    const event: GroupCallStateChangedEvent = {
      chatId: this.session.chatId,
      groupId: this.session.groupId,
      callId: this.session.callId,
      state,
      role: this.session.role,
      timestamp: Date.now(),
    };
    if (options?.reason) {
      event.reason = options.reason;
    }
    this.onStateChanged(event);
  }

  private verifyAndRecordIncomingSignal(
    remotePeerId: string,
    signal: Parameters<typeof verifyIncomingGroupCallSignal>[1],
  ): boolean {
    const validation = verifyIncomingGroupCallSignal(remotePeerId, signal, {
      localPeerId: this.localPeerId(),
      getSigningPublicKey: (peerId) => this.database.getUserByPeerId(peerId)?.signing_public_key,
      assertSignalAllowed: (allowedSignal) => {
        assertGroupCallSignalAllowed(this.database, this.localPeerId(), allowedSignal);
      },
    });
    if (!validation.valid) {
      const errorContext: Pick<GroupCallErrorEvent, 'groupId' | 'peerId' | 'code'> & { callId?: string } = {
        groupId: signal.groupId,
        peerId: remotePeerId,
        code: 'GROUP_CALL_INVALID',
      };
      if ('callId' in signal) {
        errorContext.callId = signal.callId;
      }
      this.emitError(validation.error ?? 'Group call signal validation failed', errorContext);
      return false;
    }

    const now = Date.now();
    this.pruneSeenSignalSignatures(now);
    const previousSeenAt = this.seenSignalSignatures.get(signal.signature);
    if (previousSeenAt && previousSeenAt >= now - GROUP_CALL_SIGNAL_DEDUPE_TTL_MS) {
      log(
        `[GROUP-CALL] Dropping duplicate signal type=${signal.type} peer=${remotePeerId.slice(-8)} signature=${signal.signature.slice(0, 8)}`,
      );
      return false;
    }

    this.seenSignalSignatures.set(signal.signature, now);
    this.trimSeenSignalSignatures();
    return true;
  }

  private pruneSeenSignalSignatures(now: number): void {
    const cutoff = now - GROUP_CALL_SIGNAL_DEDUPE_TTL_MS;
    for (const [signature, seenAt] of this.seenSignalSignatures) {
      if (seenAt < cutoff) {
        this.seenSignalSignatures.delete(signature);
      }
    }
  }

  private trimSeenSignalSignatures(): void {
    if (this.seenSignalSignatures.size <= GROUP_CALL_SIGNAL_DEDUPE_MAX_ENTRIES) {
      return;
    }

    const entries = [...this.seenSignalSignatures.entries()].sort((left, right) => left[1] - right[1]);
    const toDrop = this.seenSignalSignatures.size - GROUP_CALL_SIGNAL_DEDUPE_MAX_ENTRIES;
    for (let index = 0; index < toDrop; index += 1) {
      const entry = entries[index];
      if (entry) {
        this.seenSignalSignatures.delete(entry[0]);
      }
    }
  }

  private requireEligibleGroupChat(chatId: number): Chat {
    if (this.database.getSessionNetworkMode() !== NETWORK_MODES.FAST) {
      throw new Error('Group calls require fast mode');
    }

    const chat = this.database.getChats([chatId])[0];
    if (!chat) {
      throw new Error('Group chat not found');
    }
    if (chat.type !== 'group' || !chat.group_id) {
      throw new Error('Chat is not a group chat');
    }
    if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') {
      throw new Error('Group is not eligible for calls');
    }
    return chat;
  }

  private stripControlSignalSignature(signal: GroupCallControlSignalMessage): GroupCallControlSignalForRenderer {
    switch (signal.type) {
      case 'CALL_GROUP_JOIN_RESPONSE':
        if (signal.accepted) {
          const { signature, admissionToken, ...rest } = signal;
          return rest;
        }
        {
          const { signature, ...rest } = signal;
          return rest;
        }
      default: {
        const { signature, ...rest } = signal;
        return rest;
      }
    }
  }

  private stripPairSignalSecrets(signal: GroupCallPairSignalMessage): GroupCallPairSignalForRenderer {
    switch (signal.type) {
      case 'CALL_OFFER': {
        const { signature, admissionToken, ...rest } = signal;
        return rest;
      }
      default: {
        const { signature, ...rest } = signal;
        return rest;
      }
    }
  }

  private emitError(
    error: string,
    context: Pick<GroupCallErrorEvent, 'chatId' | 'groupId' | 'callId' | 'peerId' | 'code'>,
  ): void {
    this.onError({
      error,
      ...context,
      timestamp: Date.now(),
    });
  }
}
