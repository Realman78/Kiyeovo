import { randomUUID } from 'crypto';
import os from 'os';
import { peerIdFromString } from '@libp2p/peer-id';
import { NETWORK_MODES, getNetworkModeRuntime } from '../constants.js';
import type {
  AdmissionToken,
  CallGroupJoinRequestSignal,
  CallGroupJoinResponseSignal,
  CallGroupRosterSignal,
  ChatNode,
  GroupCallControlSignalForRenderer,
  GroupCallControlSignalMessage,
  GroupCallControlSignalReceivedEvent,
  GroupCallControlSignalWithoutSignature,
  GroupCallErrorEvent,
  GroupCallJoinFailureReason,
  GroupCallPairSignalForRenderer,
  GroupCallPairSignalMessage,
  GroupCallPairSignalOutgoingInput,
  GroupCallPairSignalReceivedEvent,
  GroupCallPairSignalWithoutSignature,
  GroupCallParticipant,
  GroupCallRole,
  GroupCallState,
  GroupCallStateChangedEvent,
  GroupCallQueryResponseSignal,
  GroupMembersUpdatedEvent,
} from '../types.js';
import { log } from '../../shared/logger.js';
import type { Chat } from '../db/database.js';
import { ChatDatabase } from '../db/database.js';
import { CallActivityRegistry } from './call-activity-registry.js';
import {
  GROUP_CALL_SIGNAL_DEDUPE_MAX_ENTRIES,
  GROUP_CALL_SIGNAL_DEDUPE_TTL_MS,
  GROUP_CALL_SIGNAL_MAX_FUTURE_SKEW_MS,
  assertGroupCallSignalAllowed,
  buildSignedAdmissionToken,
  buildSignedGroupCallSignal,
  isGroupCallControlSignalMessage,
  isGroupCallPairSignalMessage,
  verifyAdmissionToken,
  verifyIncomingGroupCallSignal,
} from './group-call-signaling.js';
import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import { dialProtocolWithRelayFallback } from '../transport/protocol-dialer.js';
import { errStr } from '../utils/general-error.js';

const CONTROL_SIGNAL_TIMEOUT_MS = 5_000;
const DISCOVERY_QUERY_TIMEOUT_MS = 10_000;
const DISCOVERY_SETTLE_AFTER_FIRST_MS = 1_000;
const DISCOVERY_CONFLICT_RETRY_DELAY_MS = 2_000;
const DISCOVERY_CACHE_TTL_MS = 3_000;
const DEFERRED_QUERY_TTL_MS = 10_000;
const MAX_DEFERRED_QUERY_PEERS_PER_GROUP = 5;
const JOIN_REQUEST_TIMEOUT_MS = 10_000;
const ROSTER_BROADCAST_DEBOUNCE_MS = 2_000;
const MAX_GROUP_CALL_PARTICIPANTS = 10;
const ADMISSION_TOKEN_MAX_AGE_MS = 30_000;
const RECENT_WRITER_SET_MAX_ENTRIES = 3;
const PEER_DISCONNECT_GRACE_MS = 30_000;
const HOST_RECONNECTING_RETRY_SECONDS = Math.ceil(PEER_DISCONNECT_GRACE_MS / 1_000);
const HOST_RECONNECTING_MESSAGE = `The host is reconnecting. Please try again in ${HOST_RECONNECTING_RETRY_SECONDS} seconds`;
const LOCAL_NETWORK_CHANGE_DEBOUNCE_MS = 500;
const LOCAL_NETWORK_INTERFACE_POLL_MS = 2_000;
const LOCAL_NETWORK_INTERFACE_CONFIRMATION_COUNT = 2;
const LOCAL_NETWORK_INTERFACE_SKIP_PATTERNS = /^(lo|virbr|vnet|docker|br-|vboxnet|vmnet|tun|tap|zt|wg|ppp|awdl|utun|cni|podman)/;
const LOCAL_NETWORK_RECOVERY_JOIN_ATTEMPTS = 4;
const LOCAL_NETWORK_RECOVERY_RETRY_DELAY_MS = 3_000;
const LOCAL_NETWORK_RECOVERY_POST_GIVEUP_WINDOW_MS = 30_000;
const LOCAL_NETWORK_CHANGE_SUPPRESS_FALLBACK_MS = 60_000;
const LOCAL_NETWORK_RECOVERY_DEDUP_MS = 3_000;

type GroupCallActionResult = {
  success: boolean;
  error: string | null;
  reason?: string;
  outcome?: 'created' | 'existing';
  callId?: string;
};

type GroupCallSession = {
  chatId: number;
  groupId: string;
  callId: string;
  rosterVersion: number;
  currentWriterPeerId: string;
  authoritativeParticipants: GroupCallParticipant[];
  connectionParticipants: string[];
  role: GroupCallRole;
  state: GroupCallState;
  recentWriterPeerIds: string[];
};

type QueryWinner = {
  callId: string;
  rosterVersion: number;
  participants: GroupCallParticipant[];
  writerPeerId: string;
  writerResponded: boolean;
  timestamp: number;
};

type QueryResolution =
  | { kind: 'unreachable' }
  | { kind: 'zero' }
  | { kind: 'conflict' }
  | { kind: 'winner'; winner: QueryWinner };

type CollectedQueryResponses = {
  responses: GroupCallQueryResponseSignal[];
  sentCount: number;
  settledCount: number;
  responseCount: number;
};

type PendingQuery = {
  groupId: string;
  requestId: string;
  responses: GroupCallQueryResponseSignal[];
  targetCount: number;
  sentCount: number;
  settledCount: number;
  respondedPeerIds: Set<string>;
  resolve: (result: CollectedQueryResponses) => void;
  settleTimer: ReturnType<typeof setTimeout> | null;
  hardTimer: ReturnType<typeof setTimeout>;
};

type PendingJoinResponse = {
  groupId: string;
  callId: string;
  writerPeerId: string;
  resolve: (resolution:
    | { kind: 'response'; response: CallGroupJoinResponseSignal }
    | { kind: 'timeout' }
    | { kind: 'aborted' }
  ) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DeferredQuery = {
  signal: Extract<GroupCallControlSignalMessage, { type: 'GROUP_CALL_QUERY' }>;
  receivedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type GroupCallOrchestratorConfig = {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: Pick<EncryptedUserIdentity, 'sign'>;
  callActivityRegistry: CallActivityRegistry;
  requestImmediateReconnect?: () => Promise<boolean>;
  onControlSignalReceived?: (data: GroupCallControlSignalReceivedEvent) => void;
  onPairSignalReceived?: (data: GroupCallPairSignalReceivedEvent) => void;
  onStateChanged?: (data: GroupCallStateChangedEvent) => void;
  onError?: (data: GroupCallErrorEvent) => void;
};

type RosterAcceptanceCase = 'normal' | 'handover_final' | 'successor_rebroadcast';

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

function summarizeParticipants(participants: GroupCallParticipant[]): string {
  return sortParticipants(participants)
    .map((participant) => participant.peerId.slice(-8))
    .join(',');
}

function hasParticipant(participants: GroupCallParticipant[], peerId: string): boolean {
  return participants.some((participant) => participant.peerId === peerId);
}

function isActiveQueryResponse(
  response: GroupCallQueryResponseSignal,
): response is GroupCallQueryResponseSignal & { active: true } {
  return response.active;
}

function describeQueryResolution(result: QueryResolution): string {
  if (result.kind === 'unreachable') {
    return 'unreachable';
  }
  if (result.kind === 'zero') {
    return 'zero';
  }
  if (result.kind === 'conflict') {
    return 'conflict';
  }
  return `winner call=${result.winner.callId.slice(0, 8)} version=${result.winner.rosterVersion} writer=${result.winner.writerPeerId.slice(-8)} participants=${summarizeParticipants(result.winner.participants)}`;
}

export class GroupCallOrchestrator {
  private readonly node: ChatNode;
  private readonly database: ChatDatabase;
  private readonly userIdentity: Pick<EncryptedUserIdentity, 'sign'>;
  private readonly callActivityRegistry: CallActivityRegistry;
  private readonly requestImmediateReconnect: (() => Promise<boolean>) | null;
  private readonly callSignalProtocol: string;
  private readonly onControlSignalReceived: (data: GroupCallControlSignalReceivedEvent) => void;
  private readonly onPairSignalReceived: (data: GroupCallPairSignalReceivedEvent) => void;
  private readonly onStateChanged: (data: GroupCallStateChangedEvent) => void;
  private readonly onError: (data: GroupCallErrorEvent) => void;
  private readonly seenSignalSignatures = new Map<string, number>();
  private readonly pendingQueriesByGroupId = new Map<string, Promise<QueryResolution>>();
  private readonly pendingQueriesByRequestId = new Map<string, PendingQuery>();
  private readonly recentQueryResults = new Map<string, { resolvedAt: number; result: QueryResolution }>();
  private readonly pendingDurableHintGroups = new Set<string>();
  private readonly recentDurableHintResults = new Map<string, number>();
  private readonly deferredQueriesByKey = new Map<string, DeferredQuery>();
  private readonly pendingPeerDisconnectTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; expiresAt: number }>();
  private readonly localTransportResetPeerIds = new Set<string>();
  private readonly peerConnectHandler: EventListener = (event) => {
    const peerId = (event as CustomEvent<unknown>).detail?.toString?.();
    if (peerId) {
      void this.handlePeerConnect(peerId).catch((err) => {
        log(`[GROUP-CALL][PEER_CONNECT][ERROR] peer=${peerId.slice(-8)} reason=${errStr(err)}`);
      });
    }
  };
  private readonly peerDisconnectHandler: EventListener = (event) => {
    const peerId = (event as CustomEvent<unknown>).detail?.toString?.();
    if (peerId) {
      this.handlePeerDisconnect(peerId);
    }
  };
  private readonly selfPeerUpdateHandler: EventListener = () => {
    this.scheduleLocalNetworkChangeRecovery();
  };
  private session: GroupCallSession | null = null;
  private storeDurableHint: ((groupId: string) => Promise<void>) | null = null;
  private pendingJoinResponse: PendingJoinResponse | null = null;
  private pendingRosterBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private joinRequestQueue: Promise<void> = Promise.resolve();
  private localNetworkChangeTimer: ReturnType<typeof setTimeout> | null = null;
  private localNetworkRecoveryInProgress = false;
  private interfacePollTimer: ReturnType<typeof setInterval> | null = null;
  private lastInterfaceSignature: string | null = null;
  private candidateInterfaceSignature: string | null = null;
  private candidateInterfaceSeenCount = 0;
  private postGiveupRetryHandler: EventListener | null = null;
  private postGiveupRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLocalNetworkChangeAt = 0;
  private lastTransportResetAt = 0;

  constructor(config: GroupCallOrchestratorConfig) {
    this.node = config.node;
    this.database = config.database;
    this.userIdentity = config.userIdentity;
    this.callActivityRegistry = config.callActivityRegistry;
    this.requestImmediateReconnect = config.requestImmediateReconnect ?? null;
    this.callSignalProtocol = getNetworkModeRuntime(this.database.getSessionNetworkMode()).config.callSignalProtocol;
    this.onControlSignalReceived = config.onControlSignalReceived ?? (() => undefined);
    this.onPairSignalReceived = config.onPairSignalReceived ?? (() => undefined);
    this.onStateChanged = config.onStateChanged ?? (() => undefined);
    this.onError = config.onError ?? (() => undefined);
    this.node.addEventListener('peer:connect', this.peerConnectHandler);
    this.node.addEventListener('peer:disconnect', this.peerDisconnectHandler);
    this.node.addEventListener('self:peer:update', this.selfPeerUpdateHandler);
  }

  setDurableHintStorage(storeDurableHint: ((groupId: string) => Promise<void>) | null): void {
    this.storeDurableHint = storeDurableHint;
  }

  cleanup(): void {
    this.node.removeEventListener('peer:connect', this.peerConnectHandler);
    this.node.removeEventListener('peer:disconnect', this.peerDisconnectHandler);
    this.node.removeEventListener('self:peer:update', this.selfPeerUpdateHandler);
    this.clearLocalNetworkChangeTimer();
    this.clearPostGiveupRetry();
    this.stopInterfacePolling();
    this.clearAllPeerDisconnectTimers();
    this.localTransportResetPeerIds.clear();
    this.clearDeferredQueries();
  }

  async handleGroupChatActivated(chatId: number): Promise<void> {
    if (this.session?.chatId === chatId) {
      return;
    }

    let chat: Chat;
    try {
      chat = this.requireEligibleGroupChat(chatId);
    } catch {
      return;
    }

    const queryResolution = await this.discoverActiveCall(chat, { bypassCache: true });
    if (queryResolution.kind === 'winner') {
      this.writePersistentCallEvidence(chat.id, queryResolution.winner.callId, queryResolution.winner.timestamp, 'group-activated-winner');
      return;
    }
    if (queryResolution.kind === 'zero' && chat.last_known_active_call_id) {
      this.clearPersistentCallEvidence(chat.id, 'group-activated-zero');
    }
  }

  handleGroupMembersUpdated(event: GroupMembersUpdatedEvent): void {
    const activeSession = this.session;
    const chat = this.database.getChatByGroupId(event.groupId);
    const currentMemberPeerIds = new Set(
      chat ? this.database.getChatParticipants(chat.id).map((participant) => participant.peer_id) : [],
    );
    const localStillMember = currentMemberPeerIds.has(this.localPeerId());
    const affectedPeerStillMember = currentMemberPeerIds.has(event.memberPeerId);
    const terminalStatus = chat?.group_status === 'removed'
      || chat?.group_status === 'left'
      || chat?.group_status === 'disbanded';

    if (
      !terminalStatus
      && localStillMember
      && affectedPeerStillMember
    ) {
      this.flushDeferredQueriesForMember(event.groupId, event.memberPeerId);
    }

    if (!activeSession || activeSession.groupId !== event.groupId) {
      if (chat && terminalStatus && chat.last_known_active_call_id) {
        this.clearPersistentCallEvidence(chat.id, 'membership-terminal');
      }
      return;
    }

    if (terminalStatus || !localStillMember || (event.memberPeerId === this.localPeerId() && !affectedPeerStillMember)) {
      if (chat) {
        this.clearPersistentCallEvidence(chat.id, 'membership-self-removed');
      }
      this.endLocalSession(chat?.group_status === 'disbanded' ? 'group_disbanded' : 'group_membership_removed');
      return;
    }

    if (affectedPeerStillMember) {
      const memberAlreadyInCall = activeSession.authoritativeParticipants.some(
        (participant) => participant.peerId === event.memberPeerId,
      );
      if (
        !memberAlreadyInCall
        && event.memberPeerId !== this.localPeerId()
        && activeSession.role === 'writer'
      ) {
        void this.seedDiscoveryForRejoinedMember(activeSession, event.memberPeerId);
      }
      return;
    }

    const removedPeerWasInCall = activeSession.authoritativeParticipants.some(
      (participant) => participant.peerId === event.memberPeerId,
    );
    if (!removedPeerWasInCall) {
      return;
    }

    this.clearPeerDisconnectTimer(event.memberPeerId);

    const nextParticipants = activeSession.authoritativeParticipants
      .filter((participant) => participant.peerId !== event.memberPeerId);

    if (event.memberPeerId === activeSession.currentWriterPeerId) {
      if (!chat) {
        return;
      }
      const nextWriterPeerId = this.failoverWriterPeerId(chat, nextParticipants);
      if (!nextWriterPeerId) {
        this.endLocalSession('group_membership_removed');
        return;
      }

      this.clearPendingRosterBroadcast();
      this.adoptAuthoritativeState(nextParticipants, activeSession.rosterVersion + 1, nextWriterPeerId);
      this.emitStateChanged(activeSession.state, { reason: 'membership_removed' });
      if (nextWriterPeerId === this.localPeerId()) {
        void this.broadcastRoster(chat);
      }
      return;
    }

    if (activeSession.role !== 'writer' || !chat) {
      return;
    }

    // Membership removals are authoritative immediately for the writer, even before the debounced roster fanout.
    this.adoptAuthoritativeState(nextParticipants, activeSession.rosterVersion + 1, activeSession.currentWriterPeerId);
    this.scheduleRosterBroadcast(chat);
    this.emitStateChanged(activeSession.state, { reason: 'membership_removed' });
  }

  private async seedDiscoveryForRejoinedMember(session: GroupCallSession, peerId: string): Promise<void> {
    const chat = this.database.getChats([session.chatId])[0];
    if (!chat?.group_id || this.session?.callId !== session.callId || this.session?.groupId !== session.groupId) {
      return;
    }

    const sent = await this.trySendControlSignal({
      type: 'CALL_GROUP_STARTED',
      groupId: session.groupId,
      callId: session.callId,
      fromPeerId: this.localPeerId(),
      toPeerId: peerId,
      timestamp: Date.now(),
    });
    // TEMP_LOG
    log(
      `[GROUP-CALL][DISCOVERY][RESEED] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} peer=${peerId.slice(-8)} via=${sent ? 'started' : 'hint'}`,
    );
    if (sent || !this.storeDurableHint) {
      return;
    }

    try {
      await this.storeDurableHint(session.groupId);
    } catch (error: unknown) {
      this.emitError(errStr(error, 'Failed to store durable group call hint'), {
        chatId: chat.id,
        groupId: session.groupId,
        callId: session.callId,
        code: 'GROUP_CALL_HINT_STORE_FAILED',
      });
    }
  }

  hasActiveCall(): boolean {
    return this.callActivityRegistry.hasGroupCall();
  }

  // Chat ID of the currently-active group call session
  getActiveCallChatId(): number | null {
    return this.session?.chatId ?? null;
  }

  async startGroupCall(chatId: number): Promise<GroupCallActionResult> {
    try {
      const chat = this.requireEligibleGroupChat(chatId);
      const gate = this.callActivityRegistry.canUseGroupCall({ groupId: chat.group_id! });
      if (!gate.allowed) {
        // TEMP_LOG
        log(
          `[GROUP-CALL][GATE][DENY] action=start group=${chat.group_id?.slice(0, 8)} direct=${this.callActivityRegistry.getDirectCall()?.callId ?? 'none'} localGroup=${this.callActivityRegistry.getGroupCall()?.callId ?? 'none'} sessionGroup=${this.session?.groupId ?? 'none'} sessionCall=${this.session?.callId ?? 'none'}`,
        );
        return { success: false, error: gate.error };
      }

      if (this.session && this.session.groupId === chat.group_id) {
        return { success: true, error: null, outcome: 'existing', callId: this.session.callId };
      }

      const queryStartedAt = Date.now();
      const queryResolution = await this.discoverActiveCall(chat);
      if (queryResolution.kind === 'unreachable') {
        return { success: false, error: 'Could not reach group members' };
      }
      if (queryResolution.kind === 'winner') {
        this.writePersistentCallEvidence(chat.id, queryResolution.winner.callId, queryResolution.winner.timestamp, 'start-discovered-existing');
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

      const refreshedChat = this.database.getChats([chat.id])[0];
      if (
        refreshedChat?.last_known_active_call_id
        && refreshedChat.last_known_active_call_seen_at
        && refreshedChat.last_known_active_call_seen_at >= queryStartedAt
      ) {
        // TEMP_LOG
        log(
          `[GROUP-CALL][START][EVIDENCE_WIN] chat=${chat.id} call=${refreshedChat.last_known_active_call_id.slice(0, 8)} seenAt=${refreshedChat.last_known_active_call_seen_at}`,
        );
        return {
          success: true,
          error: null,
          outcome: 'existing',
          callId: refreshedChat.last_known_active_call_id,
        };
      }

      const callId = randomUUID();
      const joinedAt = Date.now();
      const participants: GroupCallParticipant[] = [{ peerId: this.localPeerId(), joinedAt }];
      this.session = {
        chatId: chat.id,
        groupId: chat.group_id!,
        callId,
        rosterVersion: 1,
        currentWriterPeerId: this.localPeerId(),
        authoritativeParticipants: participants,
        connectionParticipants: [this.localPeerId()],
        role: 'writer',
        state: 'waiting',
        recentWriterPeerIds: [this.localPeerId()],
      };
      this.callActivityRegistry.setGroupCall({ callId, groupId: chat.group_id! });
      this.startInterfacePolling();
      this.writePersistentCallEvidence(chat.id, callId, joinedAt, 'local-start');
      this.emitStateChanged('waiting', { reason: 'started' });

      void this.broadcastStartedSignal(chat, callId, participants, 1);
      return { success: true, error: null, outcome: 'created', callId };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start group call' };
    }
  }

  async joinGroupCall(
    chatId: number,
    options?: { keepEvidenceOnZero?: boolean; allowWriterRecovery?: boolean; forceRejoin?: boolean },
  ): Promise<GroupCallActionResult> {
    try {
      const chat = this.requireEligibleGroupChat(chatId);
      const gate = this.callActivityRegistry.canUseGroupCall({ groupId: chat.group_id! });
      if (!gate.allowed) {
        // TEMP_LOG
        log(
          `[GROUP-CALL][GATE][DENY] action=join group=${chat.group_id?.slice(0, 8)} direct=${this.callActivityRegistry.getDirectCall()?.callId ?? 'none'} localGroup=${this.callActivityRegistry.getGroupCall()?.callId ?? 'none'} sessionGroup=${this.session?.groupId ?? 'none'} sessionCall=${this.session?.callId ?? 'none'}`,
        );
        return { success: false, error: gate.error };
      }

      if (this.session && this.session.groupId === chat.group_id && !options?.forceRejoin) {
        return { success: true, error: null, outcome: 'existing', callId: this.session.callId };
      }

      const queryResolution = await this.discoverActiveCall(chat, { bypassCache: true });
      if (queryResolution.kind === 'unreachable') {
        return { success: false, error: 'Could not reach group members', reason: 'join_unreachable' };
      }
      if (queryResolution.kind === 'zero') {
        if (!options?.keepEvidenceOnZero) {
          this.clearPersistentCallEvidence(chat.id, 'join-query-zero');
        }
        if (options?.forceRejoin && this.session?.chatId === chat.id) {
          this.endLocalSession('call_ended_during_partition');
        }
        return { success: false, error: 'This call may have ended', reason: 'join_query_zero' };
      }
      if (queryResolution.kind === 'conflict') {
        return { success: false, error: 'Call state conflict - please try again', reason: 'join_conflict' };
      }
      if (queryResolution.winner.writerPeerId === this.localPeerId()) {
        if (options?.allowWriterRecovery === false) {
          return { success: false, error: 'This call may have ended', reason: 'writer_recovery_disallowed' };
        }
        return this.recoverWriterAfterReconnect(chat, queryResolution.winner);
      }

      this.beginJoiningSession(chat, queryResolution.winner);
      const joinResult = await this.requestJoinWithRetry(chat, queryResolution.winner);
      if (!joinResult.success) {
        if (joinResult.clearEvidence) {
          this.clearPersistentCallEvidence(chat.id, 'join-failure-clear');
        }
        if (this.session?.chatId === chat.id) {
          this.endLocalSession(joinResult.reason);
        }
        return {
          success: false,
          error: joinResult.error ?? 'Failed to join group call',
          reason: joinResult.reason,
        };
      }

      if (!this.session) {
        return { success: false, error: 'Failed to finalize group call join', reason: 'join_finalize_failed' };
      }

      this.writePersistentCallEvidence(chat.id, this.session.callId, Date.now(), 'join-success');
      this.session.state = 'waiting';
      this.emitStateChanged('waiting', { reason: 'joined' });
      void this.broadcastStartedSignal(
        chat,
        this.session.callId,
        this.session.authoritativeParticipants,
        this.session.rosterVersion,
      );
      return { success: true, error: null, callId: this.session.callId, reason: 'joined' };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to join group call' };
    }
  }

  async leaveGroupCall(chatId: number): Promise<GroupCallActionResult> {
    try {
      const chat = this.requireEligibleGroupChat(chatId);
      if (!this.session || this.session.chatId !== chatId || !this.callActivityRegistry.hasGroupCall()) {
        return { success: false, error: 'No active group call' };
      }

      const session = this.session;
      if (session.state === 'joining') {
        this.endLocalSession('join_aborted');
        return { success: true, error: null, callId: session.callId, reason: 'join_aborted' };
      }

      const remainingParticipants = session.authoritativeParticipants
        .filter((participant) => participant.peerId !== this.localPeerId());

      if (remainingParticipants.length === 0) {
        void this.broadcastEndedSignal(chat.group_id!, session.callId, this.getGroupMemberPeerIds(chat.id));
        this.clearPersistentCallEvidence(chat.id, 'left-last');
        this.endLocalSession('left');
        return { success: true, error: null, callId: session.callId };
      }

      const peers = remainingParticipants.map((participant) => participant.peerId);
      if (session.role === 'writer') {
        const nextWriterPeerId = this.failoverWriterPeerId(chat, remainingParticipants);
        const nextRosterVersion = session.rosterVersion + 1;
        // Hand over authority before we disappear so the rest of the call can converge ASAP.
        void this.broadcastWriterHandoverAndLeaveSignal(
          session.groupId,
          session.callId,
          remainingParticipants,
          nextRosterVersion,
          nextWriterPeerId,
        );
        log(
          `[GROUP-CALL][HANDOVER][FINAL] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} writer=${nextWriterPeerId.slice(-8)} participants=${remainingParticipants.length}`,
        );
      } else {
        void this.broadcastLeaveSignal(session.groupId, session.callId, peers);
      }
      this.endLocalSession('left');
      return { success: true, error: null, callId: session.callId };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to leave group call' };
    }
  }

  async fallbackWriterRecovery(chatId: number): Promise<GroupCallActionResult> {
    const chat = this.requireEligibleGroupChat(chatId);
    if (!this.session || this.session.chatId !== chatId || this.session.role !== 'writer') {
      return { success: false, error: 'No recovering writer session' };
    }

    // If a local network change happened recently, the renderer's 10s writer-recover
    // timeout is firing during what is really an in-flight network transition.
    // Don't destroy the session — arm post-giveup retry; the banner only fires
    // if that window also expires without recovery. Return success so the
    // renderer doesn't surface this as a user-facing error.
    const sinceLocalChange = Date.now() - this.lastLocalNetworkChangeAt;
    if (this.lastLocalNetworkChangeAt > 0 && sinceLocalChange < LOCAL_NETWORK_CHANGE_SUPPRESS_FALLBACK_MS) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][RECOVER][WRITER_FALLBACK_SUPPRESSED] group=${chat.group_id?.slice(0, 8)} call=${this.session.callId.slice(0, 8)} sinceLocalChangeMs=${sinceLocalChange}`,
      );
      this.armPostGiveupRetry(this.session);
      return { success: true, error: null, callId: this.session.callId, reason: 'writer_fallback_deferred' };
    }

    const callId = this.session.callId;
    this.endLocalSession('writer_reconnect_fallback');
    // TEMP_LOG
    log(
      `[GROUP-CALL][RECOVER][WRITER_FALLBACK] group=${chat.group_id?.slice(0, 8)} call=${callId.slice(0, 8)}`,
    );
    return this.joinGroupCall(chatId, {
      keepEvidenceOnZero: true,
      allowWriterRecovery: false,
    });
  }

  async sendPairSignal(signal: GroupCallPairSignalOutgoingInput): Promise<{ success: boolean; error: string | null }> {
    if (!this.session) {
      // TEMP_LOG
      log(`[GROUP-CALL][PAIR][SEND][SKIP] type=${signal.type} to=${signal.toPeerId.slice(-8)} reason=no_session`);
      return { success: false, error: 'No active group call' };
    }
    if (signal.groupId !== this.session.groupId || signal.callId !== this.session.callId) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][SEND][SKIP] type=${signal.type} to=${signal.toPeerId.slice(-8)} reason=session_mismatch activeGroup=${this.session.groupId.slice(0, 8)} activeCall=${this.session.callId.slice(0, 8)} signalGroup=${signal.groupId.slice(0, 8)} signalCall=${signal.callId.slice(0, 8)}`,
      );
      return { success: false, error: 'Group call pair signal does not match the active call' };
    }

    const timestamp = signal.timestamp ?? Date.now();
    // TEMP_LOG
    log(
      `[GROUP-CALL][PAIR][SEND][START] type=${signal.type} to=${signal.toPeerId.slice(-8)} call=${signal.callId.slice(0, 8)} ts=${timestamp}`,
    );
    const sent = signal.type === 'CALL_OFFER'
      ? await this.trySendPairSignal({
        ...signal,
        fromPeerId: this.localPeerId(),
        mediaType: signal.mediaType ?? 'audio',
        timestamp,
      })
      : signal.type === 'CALL_ANSWER'
        ? await this.trySendPairSignal({
          ...signal,
          fromPeerId: this.localPeerId(),
          timestamp,
        })
        : await this.trySendPairSignal({
          ...signal,
        fromPeerId: this.localPeerId(),
        timestamp,
      });
    // TEMP_LOG
    log(
      `[GROUP-CALL][PAIR][SEND][RESULT] type=${signal.type} to=${signal.toPeerId.slice(-8)} call=${signal.callId.slice(0, 8)} sent=${String(sent)}`,
    );
    return sent
      ? { success: true, error: null }
      : { success: false, error: 'Failed to send group call pair signal' };
  }

  async handleDurableHint(groupId: string): Promise<void> {
    if (this.session?.groupId === groupId) {
      return;
    }
    if (this.pendingDurableHintGroups.has(groupId)) {
      // TEMP_LOG
      log(`[GROUP-CALL][HINT][SKIP] group=${groupId.slice(0, 8)} reason=in_flight`);
      return;
    }
    const recentResolvedAt = this.recentDurableHintResults.get(groupId);
    if (recentResolvedAt && recentResolvedAt >= Date.now() - DISCOVERY_CACHE_TTL_MS) {
      // TEMP_LOG
      log(`[GROUP-CALL][HINT][SKIP] group=${groupId.slice(0, 8)} reason=recent_result`);
      return;
    }

    const chat = this.database.getChatByGroupId(groupId);
    if (!chat || chat.type !== 'group') {
      return;
    }
    if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') {
      return;
    }

    this.pendingDurableHintGroups.add(groupId);
    try {
      // TEMP_LOG
      log(`[GROUP-CALL][HINT] Received durable hint for group=${groupId.slice(0, 8)}`);
      const queryResolution = await this.discoverActiveCall(chat);
      // TEMP_LOG
      log(
        `[GROUP-CALL][HINT][QUERY_RESULT] group=${groupId.slice(0, 8)} result=${describeQueryResolution(queryResolution)}`,
      );
      if (queryResolution.kind === 'winner') {
        this.writePersistentCallEvidence(chat.id, queryResolution.winner.callId, queryResolution.winner.timestamp, 'durable-hint-winner');
        return;
      }
      if (queryResolution.kind === 'zero') {
        this.clearPersistentCallEvidence(chat.id, 'durable-hint-zero');
      }
    } finally {
      this.pendingDurableHintGroups.delete(groupId);
      this.recentDurableHintResults.set(groupId, Date.now());
    }
  }

  async handleIncomingControlSignal(remotePeerId: string, signal: unknown): Promise<boolean> {
    if (!isGroupCallControlSignalMessage(signal)) {
      return false;
    }
    if (!this.verifyAndRecordIncomingSignal(remotePeerId, signal)) {
      return true;
    }

    this.maybeClearDisconnectGraceFromSignal(signal);

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
    // TEMP_LOG
    log(
      `[GROUP-CALL][PAIR][IN][RAW] type=${signal.type} from=${remotePeerId.slice(-8)} to=${signal.toPeerId.slice(-8)} group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} ts=${signal.timestamp}`,
    );
    if (!this.verifyAndRecordIncomingSignal(remotePeerId, signal)) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][IN][DROP] type=${signal.type} from=${remotePeerId.slice(-8)} reason=verify_or_dedupe_failed group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)}`,
      );
      return true;
    }
    if (!this.validateIncomingPairSignal(signal)) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][IN][DROP] type=${signal.type} from=${remotePeerId.slice(-8)} reason=pair_validation_failed group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)}`,
      );
      return true;
    }

    this.maybeClearDisconnectGraceFromSignal(signal);

    // TEMP_LOG
    log(
      `[GROUP-CALL][PAIR][IN][ACCEPT] type=${signal.type} from=${remotePeerId.slice(-8)} to=${signal.toPeerId.slice(-8)} group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)}`,
    );
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
      case 'CALL_GROUP_JOIN_REQUEST':
        await this.handleJoinRequest(signal);
        return;
      case 'CALL_GROUP_JOIN_RESPONSE':
        this.handleJoinResponse(signal);
        return;
      case 'CALL_GROUP_ROSTER':
        this.handleRosterSignal(signal);
        return;
      case 'CALL_GROUP_LEAVE':
        this.handleLeaveSignal(signal);
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

    let autoJoinWinningCall = false;
    let supersededCallId: string | null = null;
    if (this.session?.groupId === signal.groupId && this.session.callId !== signal.callId) {
      if (compareStrings(signal.callId, this.session.callId) < 0) {
        autoJoinWinningCall = this.isAutoSupersessionCandidate(this.session);
        supersededCallId = this.session.callId;
        // TEMP_LOG
        log(
          `[GROUP-CALL][DISCOVERY] Superseded local call group=${signal.groupId.slice(0, 8)} old=${this.session.callId.slice(0, 8)} new=${signal.callId.slice(0, 8)}`,
        );
        this.endLocalSession('superseded');
        if (!autoJoinWinningCall) {
          this.emitError('Another group call took precedence. Click Join to switch.', {
            chatId: chat.id,
            groupId: signal.groupId,
            callId: signal.callId,
            code: 'GROUP_CALL_SUPERSEDED_MANUAL_RECOVERY',
          });
        }
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

    this.writePersistentCallEvidence(chat.id, signal.callId, Date.now(), 'started-signal');
    if (autoJoinWinningCall && supersededCallId) {
      void this.autoJoinWinningCallAfterSuperseded(chat.id, supersededCallId, signal.callId);
    }
  }

  private async respondToQuery(signal: GroupCallControlSignalMessage & { type: 'GROUP_CALL_QUERY' }): Promise<void> {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return;
    }

    const memberPeerIds = new Set(
      this.database.getChatParticipants(chat.id).map((participant) => participant.peer_id),
    );
    if (!memberPeerIds.has(this.localPeerId())) {
      return;
    }
    if (this.session && this.session.groupId === signal.groupId && this.session.state === 'joining') {
      return;
    }

    const activeSession = this.session
      && this.session.groupId === signal.groupId
      && this.session.state !== 'joining'
      && this.session.authoritativeParticipants.some((participant) => participant.peerId === this.localPeerId())
      ? this.session
      : null;
    const response: GroupCallControlSignalWithoutSignature = activeSession
      ? {
        type: 'GROUP_CALL_QUERY_RESPONSE',
        active: true,
        groupId: signal.groupId,
        callId: activeSession.callId,
        requestId: signal.requestId,
        rosterVersion: activeSession.rosterVersion,
        writerPeerId: activeSession.currentWriterPeerId,
        participants: activeSession.authoritativeParticipants,
        fromPeerId: this.localPeerId(),
        toPeerId: signal.fromPeerId,
        timestamp: Date.now(),
      }
      : {
        type: 'GROUP_CALL_QUERY_RESPONSE',
        active: false,
        groupId: signal.groupId,
        requestId: signal.requestId,
        fromPeerId: this.localPeerId(),
        toPeerId: signal.fromPeerId,
        timestamp: Date.now(),
      };
    // TEMP_LOG
    log(
      activeSession
        ? `[GROUP-CALL][QUERY][RESPOND] group=${signal.groupId.slice(0, 8)} active=true call=${activeSession.callId.slice(0, 8)} local=${this.localPeerId().slice(-8)} to=${signal.fromPeerId.slice(-8)} version=${activeSession.rosterVersion} participants=${summarizeParticipants(activeSession.authoritativeParticipants)} creator=${chat.group_creator_peer_id?.slice(-8) ?? 'none'}`
        : `[GROUP-CALL][QUERY][RESPOND] group=${signal.groupId.slice(0, 8)} active=false local=${this.localPeerId().slice(-8)} to=${signal.fromPeerId.slice(-8)} creator=${chat.group_creator_peer_id?.slice(-8) ?? 'none'}`,
    );
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
    if (pending.respondedPeerIds.has(signal.fromPeerId)) {
      return;
    }

    const chat = this.database.getChatByGroupId(signal.groupId);
    // TEMP_LOG
    log(
      signal.active
        ? `[GROUP-CALL][QUERY][RESPONSE] group=${signal.groupId.slice(0, 8)} request=${signal.requestId.slice(0, 8)} from=${signal.fromPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} active=true call=${signal.callId.slice(0, 8)} version=${signal.rosterVersion} writer=${signal.writerPeerId.slice(-8)} selfWriter=${String(signal.writerPeerId === this.localPeerId())} participants=${summarizeParticipants(signal.participants)} creator=${chat?.group_creator_peer_id?.slice(-8) ?? 'none'}`
        : `[GROUP-CALL][QUERY][RESPONSE] group=${signal.groupId.slice(0, 8)} request=${signal.requestId.slice(0, 8)} from=${signal.fromPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} active=false creator=${chat?.group_creator_peer_id?.slice(-8) ?? 'none'}`,
    );
    pending.respondedPeerIds.add(signal.fromPeerId);
    pending.responses.push(signal);
    if (signal.active && !pending.settleTimer) {
      pending.settleTimer = setTimeout(() => {
        this.resolvePendingQuery(signal.requestId);
      }, DISCOVERY_SETTLE_AFTER_FIRST_MS);
    }
    this.checkEarlyResolve(signal.requestId);
  }

  private async handleJoinRequest(signal: CallGroupJoinRequestSignal): Promise<void> {
    const queued = this.joinRequestQueue.then(() => this.handleJoinRequestImpl(signal));
    this.joinRequestQueue = queued.catch(() => undefined);
    await queued;
  }

  private async handleJoinRequestImpl(signal: CallGroupJoinRequestSignal): Promise<void> {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return;
    }
    if (!this.session || this.session.groupId !== signal.groupId || this.session.callId !== signal.callId || this.session.role !== 'writer') {
      await this.sendRejectedJoinResponse(chat, signal, 'call_not_active');
      return;
    }

    const memberPeerIds = new Set(
      this.database.getChatParticipants(chat.id).map((participant) => participant.peer_id),
    );
    if (!memberPeerIds.has(signal.fromPeerId)) {
      await this.sendRejectedJoinResponse(chat, signal, 'not_a_member');
      return;
    }

    const existingParticipant = this.session.authoritativeParticipants.find(
      (participant) => participant.peerId === signal.fromPeerId,
    );
    if (existingParticipant) {
      const token = this.issueAdmissionToken(signal.callId, signal.fromPeerId);
      await this.sendAcceptedJoinResponse(
        chat,
        signal,
        this.session.authoritativeParticipants,
        this.session.rosterVersion,
        this.session.currentWriterPeerId,
        token,
      );
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][REFRESH] group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} peer=${signal.fromPeerId.slice(-8)}`,
      );
      return;
    }

    if (this.session.authoritativeParticipants.length >= MAX_GROUP_CALL_PARTICIPANTS) {
      await this.sendRejectedJoinResponse(chat, signal, 'full');
      return;
    }

    const nextParticipants = [
      ...this.session.authoritativeParticipants,
      { peerId: signal.fromPeerId, joinedAt: Date.now() },
    ];
    const nextRosterVersion = this.session.rosterVersion + 1;
    const token = this.issueAdmissionToken(signal.callId, signal.fromPeerId);
    const sent = await this.sendAcceptedJoinResponse(
      chat,
      signal,
      nextParticipants,
      nextRosterVersion,
      this.session.currentWriterPeerId,
      token,
    );
    if (!sent) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][ACCEPT_SEND_FAIL] group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} peer=${signal.fromPeerId.slice(-8)}`,
      );
      return;
    }

    this.adoptAuthoritativeState(nextParticipants, nextRosterVersion, this.session.currentWriterPeerId);
    this.scheduleRosterBroadcast(chat);
    this.emitStateChanged(this.session.state, { reason: 'roster_updated' });
    // TEMP_LOG
    log(
      `[GROUP-CALL][JOIN][ACCEPT] group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} peer=${signal.fromPeerId.slice(-8)} participants=${nextParticipants.length}`,
    );
  }

  private handleJoinResponse(signal: CallGroupJoinResponseSignal): void {
    if (
      !this.pendingJoinResponse
      || this.pendingJoinResponse.groupId !== signal.groupId
      || this.pendingJoinResponse.callId !== signal.callId
      || this.pendingJoinResponse.writerPeerId !== signal.fromPeerId
    ) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][RESPONSE_IGNORED] group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} writer=${signal.fromPeerId.slice(-8)} accepted=${String(signal.accepted)}`,
      );
      return;
    }

    const pending = this.pendingJoinResponse;
    this.pendingJoinResponse = null;
    clearTimeout(pending.timer);
    pending.resolve({ kind: 'response', response: signal });
  }

  private handleRosterSignal(signal: CallGroupRosterSignal): void {
    if (!this.session || this.session.groupId !== signal.groupId || this.session.callId !== signal.callId) {
      return;
    }

    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return;
    }
    const acceptanceCase = this.getRosterAcceptanceCase(chat, signal);
    if (!acceptanceCase) {
      return;
    }
    if (signal.rosterVersion < this.session.rosterVersion) {
      return;
    }
    if (
      signal.rosterVersion === this.session.rosterVersion
      && signal.writerPeerId === this.session.currentWriterPeerId
      && sameParticipantRoster(signal.participants, this.session.authoritativeParticipants)
    ) {
      return;
    }

    this.adoptAuthoritativeState(signal.participants, signal.rosterVersion, signal.writerPeerId);
    this.emitStateChanged(this.session.state, { reason: 'roster_updated' });
    if (acceptanceCase === 'handover_final' && this.session.role === 'writer') {
      // Successor re-broadcast closes the gap for peers that missed the departing writer's final roster.
      // TEMP_LOG
      log(
        `[GROUP-CALL][HANDOVER][REBROADCAST] group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} version=${signal.rosterVersion}`,
      );
      void this.broadcastRoster(chat);
    }
    // TEMP_LOG
    log(
      `[GROUP-CALL][ROSTER][ACCEPT] case=${acceptanceCase} group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} version=${signal.rosterVersion} writer=${signal.writerPeerId.slice(-8)} signer=${signal.fromPeerId.slice(-8)} participants=${signal.participants.length}`,
    );
  }

  private handleLeaveSignal(signal: GroupCallControlSignalMessage & { type: 'CALL_GROUP_LEAVE' }): void {
    if (!this.session || this.session.groupId !== signal.groupId || this.session.callId !== signal.callId) {
      return;
    }
    if (signal.fromPeerId === this.localPeerId() || this.session.role !== 'writer') {
      return;
    }

    const nextParticipants = this.session.authoritativeParticipants
      .filter((participant) => participant.peerId !== signal.fromPeerId);
    if (nextParticipants.length === this.session.authoritativeParticipants.length) {
      return;
    }

    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return;
    }

    this.adoptAuthoritativeState(nextParticipants, this.session.rosterVersion + 1, this.session.currentWriterPeerId);
    this.scheduleRosterBroadcast(chat);
    this.emitStateChanged(this.session.state, { reason: 'roster_updated' });
    // TEMP_LOG
    log(
      `[GROUP-CALL][LEAVE][REMOTE] group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)} peer=${signal.fromPeerId.slice(-8)} participants=${nextParticipants.length}`,
    );
  }

  private handleEndedSignal(signal: GroupCallControlSignalMessage & { type: 'CALL_GROUP_ENDED' }): void {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat || chat.last_known_active_call_id !== signal.callId) {
      return;
    }
    this.clearPersistentCallEvidence(chat.id, 'ended-signal');
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
      // TEMP_LOG
      log(
        `[GROUP-CALL][QUERY][CACHE_HIT] group=${chat.group_id?.slice(0, 8)} result=${describeQueryResolution(cached.result)}`,
      );
      return cached.result;
    }

    const existing = this.pendingQueriesByGroupId.get(chat.group_id!);
    if (!options?.bypassCache && existing) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][QUERY][REUSE_IN_FLIGHT] group=${chat.group_id?.slice(0, 8)}`,
      );
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
    const firstCollected = await this.collectQueryResponses(chat);
    const firstResolution = this.resolveQueryResponses(chat, firstCollected);
    if (firstResolution.kind !== 'conflict') {
      return firstResolution;
    }

    await delay(DISCOVERY_CONFLICT_RETRY_DELAY_MS);
    const secondCollected = await this.collectQueryResponses(chat);
    return this.resolveQueryResponses(chat, secondCollected);
  }

  private async collectQueryResponses(
    chat: Chat,
    explicitTargets?: string[],
  ): Promise<CollectedQueryResponses> {
    const targets = explicitTargets
      ? [...new Set(explicitTargets.filter((peerId) => peerId && peerId !== this.localPeerId()))]
      : this.getGroupMemberPeerIds(chat.id);
    if (targets.length === 0) {
      return { responses: [], sentCount: 0, settledCount: 0, responseCount: 0 };
    }

    const requestId = randomUUID();
    const responsePromise = new Promise<CollectedQueryResponses>((resolve) => {
      const hardTimer = setTimeout(() => {
        this.resolvePendingQuery(requestId);
      }, DISCOVERY_QUERY_TIMEOUT_MS);

      this.pendingQueriesByRequestId.set(requestId, {
        groupId: chat.group_id!,
        requestId,
        responses: [],
        targetCount: targets.length,
        sentCount: 0,
        settledCount: 0,
        respondedPeerIds: new Set<string>(),
        resolve,
        settleTimer: null,
        hardTimer,
      });
    });

    void Promise.allSettled(
      targets.map(async (peerId) => {
        const sent = await this.trySendControlSignal({
          type: 'GROUP_CALL_QUERY',
          groupId: chat.group_id!,
          requestId,
          fromPeerId: this.localPeerId(),
          toPeerId: peerId,
          timestamp: Date.now(),
        });
        const pending = this.pendingQueriesByRequestId.get(requestId);
        if (!pending) {
          return;
        }
        if (sent) {
          pending.sentCount += 1;
        }
        pending.settledCount += 1;
        this.checkEarlyResolve(requestId);
      }),
    );

    const result = await responsePromise;

    // TEMP_LOG
    log(
      `[GROUP-CALL][QUERY] group=${chat.group_id?.slice(0, 8)} request=${requestId.slice(0, 8)} targets=${targets.length} sent=${result.sentCount} settled=${result.settledCount} responses=${result.responseCount}`,
    );
    return result;
  }

  private checkEarlyResolve(requestId: string): void {
    const pending = this.pendingQueriesByRequestId.get(requestId);
    if (!pending || pending.settledCount !== pending.targetCount) {
      return;
    }
    if (pending.respondedPeerIds.size < pending.sentCount) {
      return;
    }
    this.resolvePendingQuery(requestId);
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
    pending.resolve({
      responses: pending.responses,
      sentCount: pending.sentCount,
      settledCount: pending.settledCount,
      responseCount: pending.respondedPeerIds.size,
    });
  }

  private resolveQueryResponses(chat: Chat, collected: CollectedQueryResponses): QueryResolution {
    const { responses } = collected;
    if (responses.length === 0) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][QUERY][RESOLVE] group=${chat.group_id?.slice(0, 8)} responses=0 sent=${collected.sentCount} settled=${collected.settledCount} positives=0 outcome=unreachable`,
      );
      return { kind: 'unreachable' };
    }

    const positiveResponses = responses.filter(isActiveQueryResponse);
    if (positiveResponses.length === 0) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][QUERY][RESOLVE] group=${chat.group_id?.slice(0, 8)} responses=${responses.length} positives=0 outcome=zero`,
      );
      return { kind: 'zero' };
    }

    const responseSummary = positiveResponses
      .map((response) => `${response.callId.slice(0, 8)}:v${response.rosterVersion}:w${response.writerPeerId.slice(-8)}:${summarizeParticipants(response.participants)}`)
      .join(' | ');

    const byCallId = new Map<string, Array<GroupCallQueryResponseSignal & { active: true }>>();
    for (const response of positiveResponses) {
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
      // TEMP_LOG
      log(`[GROUP-CALL][QUERY][RESOLVE] group=${chat.group_id?.slice(0, 8)} responses=${responses.length} raw="${responseSummary}" outcome=zero_canonical_missing`);
      return { kind: 'zero' };
    }

    const conflicting = highestVersionResponses.some(
      (response) => response.writerPeerId !== canonical.writerPeerId
        || !sameParticipantRoster(response.participants, canonical.participants),
    );
    if (conflicting) {
      // TEMP_LOG
      log(`[GROUP-CALL][QUERY][RESOLVE] group=${chat.group_id?.slice(0, 8)} responses=${responses.length} raw="${responseSummary}" outcome=conflict`);
      return { kind: 'conflict' };
    }

    const winner: QueryWinner = {
      callId: canonical.callId,
      rosterVersion: canonical.rosterVersion,
      participants: sortParticipants(canonical.participants),
      writerPeerId: canonical.writerPeerId,
      writerResponded: winningCallResponses.some((response) => response.fromPeerId === canonical.writerPeerId),
      timestamp: canonical.timestamp,
    };
    // TEMP_LOG
    log(
      `[GROUP-CALL][QUERY][RESOLVE] group=${chat.group_id?.slice(0, 8)} responses=${responses.length} raw="${responseSummary}" outcome=winner call=${winner.callId.slice(0, 8)} version=${winner.rosterVersion} writer=${winner.writerPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} selfWriter=${String(winner.writerPeerId === this.localPeerId())} participants=${summarizeParticipants(winner.participants)} creator=${chat.group_creator_peer_id?.slice(-8) ?? 'none'}`,
    );
    return {
      kind: 'winner',
      winner,
    };
  }

  private isValidQueryResponse(signal: GroupCallQueryResponseSignal): boolean {
    const chat = this.database.getChatByGroupId(signal.groupId);
    if (!chat) {
      return false;
    }

    const currentMembers = new Set(
      this.database.getChatParticipants(chat.id).map((participant) => participant.peer_id),
    );
    // Query responses are only valid from current group members, even if the signature is otherwise valid.
    if (!currentMembers.has(signal.fromPeerId)) {
      return false;
    }
    if (!signal.active) {
      return true;
    }

    const seenPeerIds = new Set<string>();
    return signal.participants.every((participant) => {
      if (!currentMembers.has(participant.peerId) || seenPeerIds.has(participant.peerId)) {
        return false;
      }
      seenPeerIds.add(participant.peerId);
      return true;
    }) && currentMembers.has(signal.writerPeerId) && signal.participants.some((participant) => participant.peerId === signal.writerPeerId);
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

    // TEMP_LOG
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

  private beginJoiningSession(chat: Chat, winner: QueryWinner): void {
    const previousRecentWriters = this.session?.callId === winner.callId
      ? this.session.recentWriterPeerIds
      : [];

    this.clearPendingJoinResponse();
    this.clearPendingRosterBroadcast();
    this.clearAllPeerDisconnectTimers();

    this.session = {
      chatId: chat.id,
      groupId: chat.group_id!,
      callId: winner.callId,
      rosterVersion: winner.rosterVersion,
      currentWriterPeerId: winner.writerPeerId,
      authoritativeParticipants: sortParticipants(winner.participants),
      connectionParticipants: [this.localPeerId()],
      role: 'participant',
      state: 'joining',
      recentWriterPeerIds: [
        winner.writerPeerId,
        ...previousRecentWriters.filter((peerId) => peerId !== winner.writerPeerId),
      ].slice(0, RECENT_WRITER_SET_MAX_ENTRIES),
    };
    this.callActivityRegistry.setGroupCall({ callId: winner.callId, groupId: chat.group_id! });
    this.startInterfacePolling();
    this.emitStateChanged('joining', { reason: 'joining' });
    // TEMP_LOG
    log(
      `[GROUP-CALL][JOIN][BEGIN] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${winner.writerPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} selfWriter=${String(winner.writerPeerId === this.localPeerId())} participants=${summarizeParticipants(winner.participants)}`,
    );
  }

  private recoverWriterAfterReconnect(chat: Chat, winner: QueryWinner): GroupCallActionResult {
    if (!winner.participants.some((participant) => participant.peerId === this.localPeerId())) {
      return { success: false, error: 'Call state conflict - please try again', reason: 'join_conflict' };
    }

    this.clearPendingJoinResponse();
    this.clearPendingRosterBroadcast();
    this.clearAllPeerDisconnectTimers();

    const previousRecentWriters = this.session?.callId === winner.callId
      ? this.session.recentWriterPeerIds
      : [];

    this.session = {
      chatId: chat.id,
      groupId: chat.group_id!,
      callId: winner.callId,
      rosterVersion: winner.rosterVersion,
      currentWriterPeerId: this.localPeerId(),
      authoritativeParticipants: sortParticipants(winner.participants),
      connectionParticipants: [this.localPeerId()],
      role: 'writer',
      state: 'waiting',
      recentWriterPeerIds: [
        this.localPeerId(),
        ...previousRecentWriters.filter((peerId) => peerId !== this.localPeerId()),
      ].slice(0, RECENT_WRITER_SET_MAX_ENTRIES),
    };
    this.callActivityRegistry.setGroupCall({ callId: winner.callId, groupId: chat.group_id! });
    this.startInterfacePolling();
    this.writePersistentCallEvidence(chat.id, winner.callId, Date.now(), 'writer-reconnect-recover');
    // Restore the call as writer and let the renderer rebuild the peer mesh from the known roster.
    this.emitStateChanged('waiting', { reason: 'writer_reconnect_recover' });
    // TEMP_LOG
    log(
      `[GROUP-CALL][RECOVER][WRITER] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} participants=${summarizeParticipants(winner.participants)}`,
    );
    return { success: true, error: null, callId: winner.callId, reason: 'writer_reconnect_recover' };
  }

  private async requestJoinWithRetry(
    chat: Chat,
    winner: QueryWinner,
  ): Promise<{ success: boolean; error?: string; clearEvidence?: boolean; reason: string }> {
    const firstAttempt = await this.requestJoinFromWinner(chat, winner);
    if (firstAttempt.kind === 'accepted') {
      return { success: true, reason: 'joined' };
    }
    if (firstAttempt.kind === 'send_failed' && !winner.writerResponded) {
      return {
        success: false,
        error: HOST_RECONNECTING_MESSAGE,
        reason: 'host_reconnecting',
      };
    }
    if (firstAttempt.kind === 'aborted') {
      return { success: false, error: 'Group call join was cancelled', reason: 'join_aborted' };
    }
    if (firstAttempt.kind === 'rejected') {
      return {
        success: false,
        error: this.mapJoinFailureToMessage(firstAttempt.reason),
        clearEvidence: firstAttempt.reason === 'call_not_active',
        reason: firstAttempt.reason,
      };
    }

    if (
      !this.session
      || this.session.groupId !== chat.group_id
      || this.session.state !== 'joining'
    ) {
      return { success: false, error: 'Group call join was cancelled', reason: 'join_aborted' };
    }

    const retryResolution = await this.discoverActiveCall(chat, { bypassCache: true });
    if (retryResolution.kind === 'zero') {
      return { success: false, error: 'This call may have ended', clearEvidence: true, reason: 'join_timeout' };
    }
    if (retryResolution.kind === 'unreachable') {
      return { success: false, error: 'Could not reach group members', reason: 'join_unreachable' };
    }
    if (retryResolution.kind === 'conflict') {
      return { success: false, error: 'Call state conflict - please try again', reason: 'join_conflict' };
    }

    if (
      !this.session
      || this.session.groupId !== chat.group_id
      || this.session.state !== 'joining'
    ) {
      return { success: false, error: 'Group call join was cancelled', reason: 'join_aborted' };
    }

    if (
      this.session.callId !== retryResolution.winner.callId
      || this.session.currentWriterPeerId !== retryResolution.winner.writerPeerId
    ) {
      this.beginJoiningSession(chat, retryResolution.winner);
    }

    const secondAttempt = await this.requestJoinFromWinner(chat, retryResolution.winner);
    if (secondAttempt.kind === 'accepted') {
      return { success: true, reason: 'joined' };
    }
    if (secondAttempt.kind === 'send_failed' && !retryResolution.winner.writerResponded) {
      return {
        success: false,
        error: HOST_RECONNECTING_MESSAGE,
        reason: 'host_reconnecting',
      };
    }
    if (secondAttempt.kind === 'aborted') {
      return { success: false, error: 'Group call join was cancelled', reason: 'join_aborted' };
    }
    if (secondAttempt.kind === 'rejected') {
      return {
        success: false,
        error: this.mapJoinFailureToMessage(secondAttempt.reason),
        clearEvidence: secondAttempt.reason === 'call_not_active',
        reason: secondAttempt.reason,
      };
    }

    return { success: false, error: 'This call may have ended', clearEvidence: true, reason: 'join_timeout' };
  }

  private async requestJoinFromWinner(
    chat: Chat,
    winner: QueryWinner,
  ): Promise<
    | { kind: 'accepted' }
    | { kind: 'rejected'; reason: GroupCallJoinFailureReason }
    | { kind: 'send_failed' }
    | { kind: 'timeout' }
    | { kind: 'aborted' }
  > {
    if (
      !this.session
      || this.session.groupId !== chat.group_id
      || this.session.callId !== winner.callId
      || this.session.currentWriterPeerId !== winner.writerPeerId
      || this.session.state !== 'joining'
    ) {
      return { kind: 'rejected', reason: 'call_not_active' };
    }

    const responsePromise = new Promise<
      | { kind: 'response'; response: CallGroupJoinResponseSignal }
      | { kind: 'timeout' }
      | { kind: 'aborted' }
    >((resolve) => {
      this.clearPendingJoinResponse();
      this.pendingJoinResponse = {
        groupId: chat.group_id!,
        callId: winner.callId,
        writerPeerId: winner.writerPeerId,
        resolve,
        timer: setTimeout(() => {
          if (this.pendingJoinResponse?.callId === winner.callId && this.pendingJoinResponse.writerPeerId === winner.writerPeerId) {
            this.pendingJoinResponse = null;
            resolve({ kind: 'timeout' });
          }
        }, JOIN_REQUEST_TIMEOUT_MS),
      };
    });

    const sent = await this.trySendControlSignal({
      type: 'CALL_GROUP_JOIN_REQUEST',
      groupId: chat.group_id!,
      callId: winner.callId,
      fromPeerId: this.localPeerId(),
      toPeerId: winner.writerPeerId,
      timestamp: Date.now(),
    });
    if (!sent) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][SEND_FAIL] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${winner.writerPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} selfDial=${String(winner.writerPeerId === this.localPeerId())}`,
      );
      this.clearPendingJoinResponse();
      return { kind: 'send_failed' };
    }

    // TEMP_LOG
    log(
      `[GROUP-CALL][JOIN][REQUEST] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${winner.writerPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} selfDial=${String(winner.writerPeerId === this.localPeerId())}`,
    );

    const resolution = await responsePromise;
    if (resolution.kind === 'aborted') {
      return { kind: 'aborted' };
    }
    if (resolution.kind === 'timeout') {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][TIMEOUT] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${winner.writerPeerId.slice(-8)}`,
      );
      return { kind: 'timeout' };
    }
    const { response } = resolution;
    if (!response.accepted) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][REJECT] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${winner.writerPeerId.slice(-8)} reason=${response.reason}`,
      );
      return { kind: 'rejected', reason: response.reason };
    }

    // TEMP_LOG
    log(
      `[GROUP-CALL][JOIN][ACCEPTED_RESPONSE] group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${winner.writerPeerId.slice(-8)} responseWriter=${response.writerPeerId.slice(-8)} from=${response.fromPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} version=${response.rosterVersion} participants=${summarizeParticipants(response.participants)}`,
    );

    if (
      !this.session
      || this.session.groupId !== response.groupId
      || this.session.callId !== response.callId
      || this.session.state !== 'joining'
    ) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][ACCEPT_INVALID] reason=session_mismatch group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} local=${this.localPeerId().slice(-8)} sessionGroup=${this.session?.groupId ?? 'none'} sessionCall=${this.session?.callId ?? 'none'}`,
      );
      return { kind: 'rejected', reason: 'call_not_active' };
    }

    if (!response.participants.some((participant) => participant.peerId === this.localPeerId())) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][ACCEPT_INVALID] reason=local_missing_from_roster group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} writer=${response.fromPeerId.slice(-8)} local=${this.localPeerId().slice(-8)} participants=${summarizeParticipants(response.participants)}`,
      );
      return { kind: 'rejected', reason: 'call_not_active' };
    }

    if (response.writerPeerId !== response.fromPeerId) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][JOIN][ACCEPT_INVALID] reason=writer_identity_mismatch group=${chat.group_id?.slice(0, 8)} call=${winner.callId.slice(0, 8)} responseWriter=${response.writerPeerId.slice(-8)} responseFrom=${response.fromPeerId.slice(-8)} local=${this.localPeerId().slice(-8)}`,
      );
      return { kind: 'rejected', reason: 'call_not_active' };
    }

    this.recordRecentWriter(response.writerPeerId);
    this.adoptAuthoritativeState(response.participants, response.rosterVersion, response.writerPeerId);
    return { kind: 'accepted' };
  }

  private issueAdmissionToken(callId: string, admittedPeerId: string): AdmissionToken {
    return buildSignedAdmissionToken({
      callId,
      admittedPeerId,
      issuedAt: Date.now(),
      issuerPeerId: this.localPeerId(),
    }, this.userIdentity);
  }

  private async sendAcceptedJoinResponse(
    chat: Chat,
    request: CallGroupJoinRequestSignal,
    participants: GroupCallParticipant[],
    rosterVersion: number,
    writerPeerId: string,
    admissionToken: AdmissionToken,
  ): Promise<boolean> {
    return this.trySendControlSignal({
      type: 'CALL_GROUP_JOIN_RESPONSE',
      groupId: chat.group_id!,
      callId: request.callId,
      accepted: true,
      rosterVersion,
      writerPeerId,
      participants,
      admissionToken,
      fromPeerId: this.localPeerId(),
      toPeerId: request.fromPeerId,
      timestamp: Date.now(),
    });
  }

  private async sendRejectedJoinResponse(
    chat: Chat,
    request: CallGroupJoinRequestSignal,
    reason: GroupCallJoinFailureReason,
  ): Promise<void> {
    await this.trySendControlSignal({
      type: 'CALL_GROUP_JOIN_RESPONSE',
      groupId: chat.group_id!,
      callId: request.callId,
      accepted: false,
      reason,
      fromPeerId: this.localPeerId(),
      toPeerId: request.fromPeerId,
      timestamp: Date.now(),
    });
  }

  private scheduleRosterBroadcast(chat: Chat): void {
    if (this.pendingRosterBroadcastTimer) {
      return;
    }

    this.pendingRosterBroadcastTimer = setTimeout(() => {
      this.pendingRosterBroadcastTimer = null;
      void this.broadcastRoster(chat);
    }, ROSTER_BROADCAST_DEBOUNCE_MS);
  }

  private async broadcastRoster(chat: Chat): Promise<void> {
    // The debounce may fire after a handover or local end, so re-check authority here.
    if (!this.session || this.session.chatId !== chat.id || this.session.role !== 'writer') {
      return;
    }

    const participants = sortParticipants(this.session.authoritativeParticipants);
    const peers = participants
      .map((participant) => participant.peerId)
      .filter((peerId) => peerId !== this.localPeerId());

    const sendResults = await Promise.allSettled(
      peers.map(async (peerId) => this.trySendControlSignal({
        type: 'CALL_GROUP_ROSTER',
        groupId: chat.group_id!,
        callId: this.session!.callId,
        rosterVersion: this.session!.rosterVersion,
        writerPeerId: this.session!.currentWriterPeerId,
        participants,
        fromPeerId: this.localPeerId(),
        toPeerId: peerId,
        timestamp: Date.now(),
      })),
    );

    // TEMP_LOG
    log(
      `[GROUP-CALL][ROSTER][BROADCAST] group=${chat.group_id?.slice(0, 8)} call=${this.session.callId.slice(0, 8)} version=${this.session.rosterVersion} sent=${sendResults.filter((result) => result.status === 'fulfilled' && result.value).length}/${peers.length}`,
    );
  }

  private async broadcastLeaveSignal(groupId: string, callId: string, peers: string[]): Promise<void> {
    await Promise.allSettled(
      peers.map(async (peerId) => this.trySendControlSignal({
        type: 'CALL_GROUP_LEAVE',
        groupId,
        callId,
        fromPeerId: this.localPeerId(),
        toPeerId: peerId,
        timestamp: Date.now(),
      })),
    );
  }

  private async broadcastWriterHandoverAndLeaveSignal(
    groupId: string,
    callId: string,
    participants: GroupCallParticipant[],
    rosterVersion: number,
    writerPeerId: string,
  ): Promise<void> {
    const peers = participants.map((participant) => participant.peerId);
    await Promise.allSettled(
      peers.map(async (peerId) => {
        await this.trySendControlSignal({
          type: 'CALL_GROUP_ROSTER',
          groupId,
          callId,
          rosterVersion,
          writerPeerId,
          participants,
          fromPeerId: this.localPeerId(),
          toPeerId: peerId,
          timestamp: Date.now(),
        });
        await this.trySendControlSignal({
          type: 'CALL_GROUP_LEAVE',
          groupId,
          callId,
          fromPeerId: this.localPeerId(),
          toPeerId: peerId,
          timestamp: Date.now(),
        });
      }),
    );
  }

  private async broadcastEndedSignal(groupId: string, callId: string, peers: string[]): Promise<void> {
    await Promise.allSettled(
      peers.map(async (peerId) => this.trySendControlSignal({
        type: 'CALL_GROUP_ENDED',
        groupId,
        callId,
        fromPeerId: this.localPeerId(),
        toPeerId: peerId,
        timestamp: Date.now(),
      })),
    );
  }

  private validateIncomingPairSignal(signal: GroupCallPairSignalMessage): boolean {
    // A restarted or not-yet-rejoined participant can receive late offer/ICE traffic before
    // a local group-call session exists again. Drop that pair traffic quietly.
    if (!this.session) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=no_session group=${signal.groupId.slice(0, 8)} call=${signal.callId.slice(0, 8)}`,
      );
      return false;
    }

    if (this.session.groupId !== signal.groupId || this.session.callId !== signal.callId) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=session_mismatch activeGroup=${this.session.groupId.slice(0, 8)} activeCall=${this.session.callId.slice(0, 8)} signalGroup=${signal.groupId.slice(0, 8)} signalCall=${signal.callId.slice(0, 8)}`,
      );
      this.emitError('Unexpected group call pair signal', {
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_PAIR_UNEXPECTED',
      });
      return false;
    }

    if (signal.type !== 'CALL_OFFER') {
      return true;
    }

    const senderAlreadyAdmitted = this.session.authoritativeParticipants.some(
      (participant) => participant.peerId === signal.fromPeerId,
    );
    if (senderAlreadyAdmitted) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][ACCEPT] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=sender_already_admitted call=${signal.callId.slice(0, 8)}`,
      );
      return true;
    }
    if (!signal.admissionToken) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=missing_admission_token call=${signal.callId.slice(0, 8)}`,
      );
      this.emitError('Missing admission token for non-rostered group call offer', {
        chatId: this.session.chatId,
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_ADMISSION_TOKEN_MISSING',
      });
      return false;
    }

    const tokenVerification = verifyAdmissionToken(
      signal.admissionToken,
      (peerId) => this.database.getUserByPeerId(peerId)?.signing_public_key,
    );
    if (!tokenVerification.valid) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=invalid_admission_token detail=${tokenVerification.error ?? 'unknown'} call=${signal.callId.slice(0, 8)}`,
      );
      this.emitError(tokenVerification.error ?? 'Invalid admission token', {
        chatId: this.session.chatId,
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_ADMISSION_TOKEN_INVALID',
      });
      return false;
    }

    const now = Date.now();
    if (!this.session.recentWriterPeerIds.includes(signal.admissionToken.issuerPeerId)) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=stale_admission_issuer issuer=${signal.admissionToken.issuerPeerId.slice(-8)} call=${signal.callId.slice(0, 8)}`,
      );
      this.emitError('Admission token issuer is not a recent writer', {
        chatId: this.session.chatId,
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_ADMISSION_TOKEN_STALE',
      });
      return false;
    }
    if (signal.admissionToken.admittedPeerId !== signal.fromPeerId) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=admitted_peer_mismatch tokenPeer=${signal.admissionToken.admittedPeerId.slice(-8)} call=${signal.callId.slice(0, 8)}`,
      );
      this.emitError('Admission token does not match the offered peer', {
        chatId: this.session.chatId,
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_ADMISSION_TOKEN_MISMATCH',
      });
      return false;
    }
    if (signal.admissionToken.callId !== signal.callId || signal.admissionToken.callId !== this.session.callId) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=admission_call_mismatch tokenCall=${signal.admissionToken.callId.slice(0, 8)} signalCall=${signal.callId.slice(0, 8)} activeCall=${this.session.callId.slice(0, 8)}`,
      );
      this.emitError('Admission token call does not match the active call', {
        chatId: this.session.chatId,
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_ADMISSION_TOKEN_CALL_MISMATCH',
      });
      return false;
    }
    if (
      signal.admissionToken.issuedAt > now + GROUP_CALL_SIGNAL_MAX_FUTURE_SKEW_MS
      || now - signal.admissionToken.issuedAt > ADMISSION_TOKEN_MAX_AGE_MS
    ) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][VALIDATE][DROP] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=admission_token_age issuedAt=${signal.admissionToken.issuedAt} now=${now} call=${signal.callId.slice(0, 8)}`,
      );
      this.emitError('Admission token is too old', {
        chatId: this.session.chatId,
        groupId: signal.groupId,
        callId: signal.callId,
        peerId: signal.fromPeerId,
        code: 'GROUP_CALL_ADMISSION_TOKEN_EXPIRED',
      });
      return false;
    }

    // TEMP_LOG
    log(
      `[GROUP-CALL][PAIR][VALIDATE][ACCEPT] type=${signal.type} from=${signal.fromPeerId.slice(-8)} reason=admission_token_ok call=${signal.callId.slice(0, 8)}`,
    );
    return true;
  }

  private recordRecentWriter(peerId: string): void {
    if (!this.session) {
      return;
    }

    this.session.recentWriterPeerIds = [
      peerId,
      ...this.session.recentWriterPeerIds.filter((existingPeerId) => existingPeerId !== peerId),
    ].slice(0, RECENT_WRITER_SET_MAX_ENTRIES);
  }

  private adoptAuthoritativeState(
    participants: GroupCallParticipant[],
    rosterVersion: number,
    currentWriterPeerId: string,
  ): void {
    if (!this.session) {
      return;
    }

    this.session.authoritativeParticipants = sortParticipants(participants);
    this.session.rosterVersion = rosterVersion;
    this.session.currentWriterPeerId = currentWriterPeerId;
    this.session.role = currentWriterPeerId === this.localPeerId() ? 'writer' : 'participant';
    this.recordRecentWriter(currentWriterPeerId);
  }

  private isAutoSupersessionCandidate(session: GroupCallSession): boolean {
    return session.role === 'writer'
      && session.state === 'waiting'
      && session.authoritativeParticipants.length === 1
      && session.authoritativeParticipants[0]?.peerId === this.localPeerId();
  }

  private async autoJoinWinningCallAfterSuperseded(
    chatId: number,
    previousCallId: string,
    winningCallId: string,
  ): Promise<void> {
    // TEMP_LOG
    log(
      `[GROUP-CALL][DISCOVERY][AUTO_JOIN] chat=${chatId} old=${previousCallId.slice(0, 8)} new=${winningCallId.slice(0, 8)}`,
    );
    const result = await this.joinGroupCall(chatId, { keepEvidenceOnZero: true });
    if (result.success) {
      return;
    }

    const chat = this.database.getChats([chatId])[0];
    this.emitError(result.error || 'Failed to join the winning group call', {
      chatId,
      callId: winningCallId,
      ...(chat?.group_id ? { groupId: chat.group_id } : {}),
      code: 'GROUP_CALL_SUPERSEDED_AUTO_JOIN_FAILED',
    });
  }

  private getRosterAcceptanceCase(
    chat: Chat,
    signal: CallGroupRosterSignal,
  ): RosterAcceptanceCase | null {
    const session = this.session;
    if (!session || !hasParticipant(signal.participants, signal.writerPeerId)) {
      return null;
    }

    if (
      signal.fromPeerId === session.currentWriterPeerId
      && signal.writerPeerId === signal.fromPeerId
    ) {
      return 'normal';
    }

    if (
      signal.fromPeerId === session.currentWriterPeerId
      && signal.writerPeerId !== signal.fromPeerId
      && !hasParticipant(signal.participants, signal.fromPeerId)
      && this.failoverWriterPeerId(chat, signal.participants) === signal.writerPeerId
    ) {
      return 'handover_final';
    }

    if (signal.fromPeerId !== signal.writerPeerId) {
      return null;
    }

    const remainingParticipants = session.authoritativeParticipants
      .filter((participant) => participant.peerId !== session.currentWriterPeerId);
    if (this.failoverWriterPeerId(chat, remainingParticipants) === signal.writerPeerId) {
      return 'successor_rebroadcast';
    }

    return null;
  }

  private failoverWriterPeerId(chat: Chat, participants: GroupCallParticipant[]): string {
    if (participants.length === 0) {
      return '';
    }

    if (chat.group_creator_peer_id && hasParticipant(participants, chat.group_creator_peer_id)) {
      return chat.group_creator_peer_id;
    }

    return sortParticipants(participants)[0]?.peerId ?? '';
  }

  private mapJoinFailureToMessage(reason: GroupCallJoinFailureReason): string {
    switch (reason) {
      case 'full':
        return 'This call is full';
      case 'not_a_member':
        return 'You are no longer a member of this group';
      case 'busy':
        return 'Another call is already in progress';
      case 'call_not_active':
      default:
        return 'This call may have ended';
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
      // TEMP_LOG
      log(
        `[GROUP-CALL][SEND][FAIL] type=${unsignedSignal.type} to=${unsignedSignal.toPeerId.slice(-8)} reason=${errStr(error)}`,
      );
      return false;
    }
  }

  private async trySendPairSignal(unsignedSignal: GroupCallPairSignalWithoutSignature): Promise<boolean> {
    try {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][WIRE][START] type=${unsignedSignal.type} from=${unsignedSignal.fromPeerId.slice(-8)} to=${unsignedSignal.toPeerId.slice(-8)} call=${unsignedSignal.callId.slice(0, 8)}`,
      );
      const signedSignal = buildSignedGroupCallSignal(unsignedSignal, this.userIdentity);
      const stream = await this.openControlStream(unsignedSignal.toPeerId);
      const payloadBytes = new TextEncoder().encode(JSON.stringify(signedSignal));
      await stream.sink([payloadBytes]);
      await stream.close();
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][WIRE][SENT] type=${unsignedSignal.type} from=${unsignedSignal.fromPeerId.slice(-8)} to=${unsignedSignal.toPeerId.slice(-8)} call=${unsignedSignal.callId.slice(0, 8)} bytes=${payloadBytes.byteLength}`,
      );
      return true;
    } catch (error: unknown) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][PAIR][SEND][FAIL] type=${unsignedSignal.type} to=${unsignedSignal.toPeerId.slice(-8)} reason=${errStr(error)}`,
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

  private writePersistentCallEvidence(chatId: number, callId: string, seenAt: number, reason: string): void {
    // TEMP_LOG
    log(
      `[GROUP-CALL][EVIDENCE][SET] chat=${chatId} call=${callId.slice(0, 8)} seenAt=${seenAt} reason=${reason}`,
    );
    this.database.setLastKnownActiveCall(chatId, callId, seenAt);
    this.emitEvidenceChanged(chatId, callId, `set:${reason}`);
  }

  private clearPersistentCallEvidence(chatId: number, reason: string): void {
    // TEMP_LOG
    log(`[GROUP-CALL][EVIDENCE][CLEAR] chat=${chatId} reason=${reason}`);
    this.database.clearLastKnownActiveCall(chatId);
    this.emitEvidenceChanged(chatId, null, `clear:${reason}`);
  }

  private emitEvidenceChanged(chatId: number, callId: string | null, reason: string): void {
    const chat = this.database.getChats([chatId])[0];
    if (!chat?.group_id) {
      return;
    }

    this.onStateChanged({
      chatId,
      groupId: chat.group_id,
      callId,
      state: 'idle',
      role: this.session?.chatId === chatId ? this.session.role : null,
      reason,
      timestamp: Date.now(),
    });
  }

  private endLocalSession(reason: string): void {
    if (!this.session) {
      return;
    }

    const endedSession = this.session;
    this.session = null;
    this.clearLocalNetworkChangeTimer();
    this.clearPostGiveupRetry();
    this.stopInterfacePolling();
    this.localNetworkRecoveryInProgress = false;
    this.lastLocalNetworkChangeAt = 0;
    this.lastTransportResetAt = 0;
    this.localTransportResetPeerIds.clear();
    this.clearAllPeerDisconnectTimers();
    this.clearPendingJoinResponse();
    this.clearPendingRosterBroadcast();
    this.callActivityRegistry.setGroupCall(null);
    this.onStateChanged({
      chatId: endedSession.chatId,
      groupId: endedSession.groupId,
      callId: endedSession.callId,
      state: 'ended',
      role: endedSession.role,
      participants: endedSession.authoritativeParticipants,
      writerPeerId: endedSession.currentWriterPeerId,
      reason,
      timestamp: Date.now(),
    });
  }

  private clearPendingJoinResponse(): void {
    if (!this.pendingJoinResponse) {
      return;
    }

    const pending = this.pendingJoinResponse;
    clearTimeout(pending.timer);
    this.pendingJoinResponse = null;
    pending.resolve({ kind: 'aborted' });
  }

  private clearPendingRosterBroadcast(): void {
    if (!this.pendingRosterBroadcastTimer) {
      return;
    }

    clearTimeout(this.pendingRosterBroadcastTimer);
    this.pendingRosterBroadcastTimer = null;
  }

  private clearPeerDisconnectTimer(peerId: string): void {
    const entry = this.pendingPeerDisconnectTimers.get(peerId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    this.pendingPeerDisconnectTimers.delete(peerId);
  }

  private clearAllPeerDisconnectTimers(): void {
    this.pendingPeerDisconnectTimers.forEach((entry) => clearTimeout(entry.timer));
    this.pendingPeerDisconnectTimers.clear();
  }

  private clearLocalNetworkChangeTimer(): void {
    if (!this.localNetworkChangeTimer) {
      return;
    }
    clearTimeout(this.localNetworkChangeTimer);
    this.localNetworkChangeTimer = null;
  }

  private resetInterfacePollingCandidate(): void {
    this.candidateInterfaceSignature = null;
    this.candidateInterfaceSeenCount = 0;
  }

  private computeInterfaceSignature(): string {
    const entries: string[] = [];
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces).sort()) {
      if (LOCAL_NETWORK_INTERFACE_SKIP_PATTERNS.test(name)) {
        continue;
      }
      for (const address of interfaces[name] ?? []) {
        if (address.internal || address.family !== 'IPv4') {
          continue;
        }
        if (address.address === '0.0.0.0' || address.address.startsWith('169.254.')) {
          continue;
        }
        entries.push(`${name}:${address.address}`);
      }
    }
    return entries.join('|');
  }

  private handleInterfacePollTick(): void {
    let signature: string;
    try {
      signature = this.computeInterfaceSignature();
      console.log('SIGNATURE at T:', Date.now(), signature);
    } catch (error: unknown) {
      log(`[GROUP-CALL][NETWORK][POLL_ERROR] reason=${errStr(error)}`);
      return;
    }
    if (this.lastInterfaceSignature === null) {
      this.lastInterfaceSignature = signature;
      this.resetInterfacePollingCandidate();
      return;
    }

    if (signature === this.lastInterfaceSignature) {
      this.resetInterfacePollingCandidate();
      return;
    }

    if (signature !== this.candidateInterfaceSignature) {
      this.candidateInterfaceSignature = signature;
      this.candidateInterfaceSeenCount = 1;
      return;
    }

    this.candidateInterfaceSeenCount += 1;
    if (this.candidateInterfaceSeenCount < LOCAL_NETWORK_INTERFACE_CONFIRMATION_COUNT) {
      return;
    }

    const previousSignature = this.lastInterfaceSignature;
    this.lastInterfaceSignature = signature;
    this.resetInterfacePollingCandidate();
    log(`[GROUP-CALL][NETWORK][INTERFACE_CHANGE] from=${previousSignature || 'none'} to=${signature || 'none'}`);
    this.scheduleLocalNetworkChangeRecovery();
  }

  private startInterfacePolling(): void {
    if (this.interfacePollTimer) {
      return;
    }
    this.lastInterfaceSignature = this.computeInterfaceSignature();
    this.resetInterfacePollingCandidate();
    log(`[GROUP-CALL][NETWORK][POLL_START] initial=${this.lastInterfaceSignature || 'none'}`);
    this.interfacePollTimer = setInterval(() => {
      this.handleInterfacePollTick();
    }, LOCAL_NETWORK_INTERFACE_POLL_MS);
  }

  private stopInterfacePolling(): void {
    if (this.interfacePollTimer) {
      clearInterval(this.interfacePollTimer);
      this.interfacePollTimer = null;
    }
    if (this.lastInterfaceSignature !== null) {
      log(`[GROUP-CALL][NETWORK][POLL_STOP] last=${this.lastInterfaceSignature || 'none'}`);
    }
    this.lastInterfaceSignature = null;
    this.resetInterfacePollingCandidate();
  }

  private clearPostGiveupRetry(): void {
    if (this.postGiveupRetryHandler) {
      this.node.removeEventListener('peer:connect', this.postGiveupRetryHandler);
      this.postGiveupRetryHandler = null;
    }
    if (this.postGiveupRetryTimer) {
      clearTimeout(this.postGiveupRetryTimer);
      this.postGiveupRetryTimer = null;
    }
  }

  private armPostGiveupRetry(session: GroupCallSession): void {
    this.clearPostGiveupRetry();
    const targets = new Set(
      session.authoritativeParticipants
        .map((participant) => participant.peerId)
        .filter((peerId) => peerId !== this.localPeerId()),
    );
    if (targets.size === 0) {
      return;
    }

    const handler: EventListener = (event) => {
      const peerId = (event as CustomEvent<unknown>).detail?.toString?.();
      if (!peerId || !targets.has(peerId)) {
        return;
      }
      if (!this.session || this.session.callId !== session.callId) {
        this.clearPostGiveupRetry();
        return;
      }
      // TEMP_LOG
      log(`[GROUP-CALL][NETWORK][POST_GIVEUP_RETRY] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} peer=${peerId.slice(-8)}`);
      this.clearPostGiveupRetry();
      void this.joinGroupCall(session.chatId, {
        keepEvidenceOnZero: true,
        forceRejoin: true,
      }).catch((error: unknown) => {
        log(`[GROUP-CALL][NETWORK][POST_GIVEUP_RETRY_ERROR] reason=${errStr(error)}`);
      });
    };

    this.postGiveupRetryHandler = handler;
    this.node.addEventListener('peer:connect', handler);
    this.postGiveupRetryTimer = setTimeout(() => {
      // TEMP_LOG
      log(`[GROUP-CALL][NETWORK][POST_GIVEUP_RETRY_EXPIRED] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)}`);
      this.clearPostGiveupRetry();
      // Recovery has truly failed: retries exhausted AND no peer reconnected
      // within the post-giveup window. Now surface the banner.
      if (this.session && this.session.callId === session.callId) {
        this.emitStateChanged(this.session.state, { reason: 'recovery_failed' });
      }
    }, LOCAL_NETWORK_RECOVERY_POST_GIVEUP_WINDOW_MS);
    // TEMP_LOG
    log(`[GROUP-CALL][NETWORK][POST_GIVEUP_RETRY_ARMED] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} targets=${[...targets].map((p) => p.slice(-8)).join(',')} windowMs=${LOCAL_NETWORK_RECOVERY_POST_GIVEUP_WINDOW_MS}`);

    // If any target is already connected, fire immediately. The peer:connect
    // event may have fired before this listener was armed (between the failed
    // recovery probe and the giveup), so we'd otherwise wait the full window
    // for an event that already happened.
    for (const peerId of targets) {
      let isConnected = false;
      try {
        isConnected = this.node.getConnections(peerIdFromString(peerId)).length > 0;
      } catch {
        // Malformed peerId is implausible here, just skip.
      }
      if (!isConnected) {
        continue;
      }
      // TEMP_LOG
      log(`[GROUP-CALL][NETWORK][POST_GIVEUP_RETRY_IMMEDIATE] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} peer=${peerId.slice(-8)} reason=already_connected`);
      this.clearPostGiveupRetry();
      void this.joinGroupCall(session.chatId, {
        keepEvidenceOnZero: true,
        forceRejoin: true,
      }).catch((error: unknown) => {
        log(`[GROUP-CALL][NETWORK][POST_GIVEUP_RETRY_ERROR] reason=${errStr(error)}`);
      });
      return;
    }
  }

  private scheduleLocalNetworkChangeRecovery(): void {
    if (this.localNetworkRecoveryInProgress) {
      return;
    }
    this.clearLocalNetworkChangeTimer();
    this.localNetworkChangeTimer = setTimeout(() => {
      this.localNetworkChangeTimer = null;
      void this.handleLocalNetworkChangeRecovery().catch((error: unknown) => {
        log(`[GROUP-CALL][NETWORK][RESET][ERROR] reason=${errStr(error)}`);
      });
    }, LOCAL_NETWORK_CHANGE_DEBOUNCE_MS);
  }

  private async handleLocalNetworkChangeRecovery(): Promise<void> {
    if (this.localNetworkRecoveryInProgress || !this.session) {
      return;
    }

    const session = this.session;
    if (session.state === 'joining') {
      this.endLocalSession('join_aborted');
      return;
    }

    const remotePeerIds = session.authoritativeParticipants
      .map((participant) => participant.peerId)
      .filter((peerId) => peerId !== this.localPeerId());

    this.localNetworkRecoveryInProgress = true;
    this.lastLocalNetworkChangeAt = Date.now();
    this.clearPostGiveupRetry();
    remotePeerIds.forEach((peerId) => this.localTransportResetPeerIds.add(peerId));

    try {
      // Force libp2p to drop stale connections and rebuild bootstrap + relay.
      // Without this we sit for ~30s waiting for the periodic DHT probe gate.
      if (this.requestImmediateReconnect) {
        // TEMP_LOG
        log(`[GROUP-CALL][NETWORK][FORCE_RECONNECT_START] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)}`);
        try {
          await this.requestImmediateReconnect();
        } catch (error: unknown) {
          log(`[GROUP-CALL][NETWORK][FORCE_RECONNECT_ERROR] reason=${errStr(error)}`);
        }
        // TEMP_LOG
        log(`[GROUP-CALL][NETWORK][FORCE_RECONNECT_DONE] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)}`);
      }

      await Promise.allSettled(
        remotePeerIds.map(async (peerId) => this.node.hangUp(peerIdFromString(peerId))),
      );

      if (
        !this.session
        || this.session.groupId !== session.groupId
        || this.session.callId !== session.callId
        || this.session.role !== session.role
      ) {
        return;
      }

      // Suppress duplicate transport_reset cycles fired in quick succession.
      // libp2p's destructive reconnect itself emits self:peer:update (new
      // advertised addresses), which re-triggers our recovery handler. The
      // second cycle's force_reconnect is cooldown-skipped (libp2p didn't
      // do anything new), so re-emitting transport_reset just causes the
      // renderer to restart its writer probe and produce duplicate signaling
      // failures + toast spam. Within 3s of the last emission we treat the
      // previous one as still authoritative and skip the rest of the cycle.
      const sinceLastReset = Date.now() - this.lastTransportResetAt;
      if (this.lastTransportResetAt > 0 && sinceLastReset < LOCAL_NETWORK_RECOVERY_DEDUP_MS) {
        // TEMP_LOG
        log(`[GROUP-CALL][NETWORK][TRANSPORT_RESET_SKIP] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} reason=dedup sinceMs=${sinceLastReset}`);
        return;
      }

      this.clearAllPeerDisconnectTimers();
      this.lastTransportResetAt = Date.now();
      this.emitStateChanged(this.session.state, { reason: 'transport_reset' });

      if (session.role === 'participant') {
        for (let attempt = 1; attempt <= LOCAL_NETWORK_RECOVERY_JOIN_ATTEMPTS; attempt += 1) {
          if (
            !this.session
            || this.session.groupId !== session.groupId
            || this.session.callId !== session.callId
            || this.session.role !== 'participant'
          ) {
            return;
          }

          const result = await this.joinGroupCall(session.chatId, {
            keepEvidenceOnZero: true,
            forceRejoin: true,
          });
          if (result.success) {
            return;
          }
          if (result.reason === 'join_query_zero' || result.reason === 'join_aborted') {
            return;
          }
          if (attempt >= LOCAL_NETWORK_RECOVERY_JOIN_ATTEMPTS) {
            log(
              `[GROUP-CALL][NETWORK][RECOVERY_GIVEUP] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} attempts=${attempt} reason=${result.reason ?? 'unknown'}`,
            );
            // Stay silent for the user: we're arming a 30s post-giveup retry
            // that often succeeds. The banner only fires from the expired path.
            this.armPostGiveupRetry(session);
            return;
          }

          log(
            `[GROUP-CALL][NETWORK][RECOVERY_RETRY] group=${session.groupId.slice(0, 8)} call=${session.callId.slice(0, 8)} attempt=${attempt} reason=${result.reason ?? 'unknown'}`,
          );
          await delay(LOCAL_NETWORK_RECOVERY_RETRY_DELAY_MS);
        }
      }
    } finally {
      this.localNetworkRecoveryInProgress = false;
      this.localTransportResetPeerIds.clear();
    }
  }

  private maybeClearDisconnectGraceFromSignal(
    signal: GroupCallControlSignalMessage | GroupCallPairSignalMessage,
  ): void {
    if (
      !this.session
      || signal.groupId !== this.session.groupId
      || !('callId' in signal)
      || signal.callId !== this.session.callId
    ) {
      return;
    }

    if (!this.pendingPeerDisconnectTimers.has(signal.fromPeerId)) {
      return;
    }

    this.clearPeerDisconnectTimer(signal.fromPeerId);
    this.emitStateChanged(this.session.state, {
      reason: 'disconnect_grace_cleared',
      peerId: signal.fromPeerId,
    });
  }

  private currentPendingDisconnects(): { peerId: string; expiresAt: number }[] {
    return [...this.pendingPeerDisconnectTimers.entries()]
      .map(([peerId, entry]) => ({ peerId, expiresAt: entry.expiresAt }))
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  private isPeerCurrentlyConnected(peerId: string): boolean {
    return this.node.getConnections().some((connection) => (
      connection.remotePeer.toString() === peerId && connection.status === 'open'
    ));
  }

  private async queryPeerForActiveCall(
    chat: Chat,
    peerId: string,
  ): Promise<(GroupCallQueryResponseSignal & { active: true }) | null> {
    const collected = await this.collectQueryResponses(chat, [peerId]);
    const response = collected.responses.find(
      (candidate): candidate is GroupCallQueryResponseSignal & { active: true } => (
        candidate.fromPeerId === peerId && candidate.active
      ),
    );
    return response ?? null;
  }

  private async handlePeerConnect(peerId: string): Promise<void> {
    this.localTransportResetPeerIds.delete(peerId);
    const hadDisconnectTimer = this.pendingPeerDisconnectTimers.has(peerId);
    if (!hadDisconnectTimer || !this.session) {
      if (hadDisconnectTimer && !this.session) {
        // TEMP_LOG
        log(`[GROUP-CALL][RECOVER][PEER_CONNECT_SKIP] peer=${peerId.slice(-8)} reason=no_session hadDisconnectTimer=true`);
      }
      return;
    }

    if (this.session.role !== 'writer') {
      // TEMP_LOG
      log(
        `[GROUP-CALL][RECOVER][PEER_CONNECT_SKIP] peer=${peerId.slice(-8)} reason=not_writer role=${this.session.role} call=${this.session.callId.slice(0, 8)}`,
      );
      return;
    }

    const session = this.session;
    const chat = this.database.getChatByGroupId(session.groupId);
    if (!chat) {
      return;
    }

    const peerResponse = await this.queryPeerForActiveCall(chat, peerId);
    if (
      !peerResponse
      || peerResponse.callId !== session.callId
      || peerResponse.writerPeerId !== this.localPeerId()
    ) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][RECOVER][PEER_CONNECT_SKIP] peer=${peerId.slice(-8)} reason=${!peerResponse ? 'no_active_call_response' : peerResponse.callId !== session.callId ? 'call_mismatch' : 'writer_mismatch'} expectedCall=${session.callId.slice(0, 8)} gotCall=${peerResponse?.callId.slice(0, 8) ?? 'none'} expectedWriter=${this.localPeerId().slice(-8)} gotWriter=${peerResponse?.writerPeerId.slice(-8) ?? 'none'}`,
      );
      return;
    }
    if (
      !this.session
      || this.session.groupId !== session.groupId
      || this.session.callId !== session.callId
      || this.session.role !== 'writer'
    ) {
      return;
    }

    this.emitStateChanged(this.session.state, { reason: 'writer_reconnect_probe', peerId });
    // TEMP_LOG
    log(
      `[GROUP-CALL][RECOVER][WRITER_PROBE] group=${this.session.groupId.slice(0, 8)} call=${this.session.callId.slice(0, 8)} peer=${peerId.slice(-8)}`,
    );
  }

  private handlePeerDisconnect(peerId: string): void {
    if (this.localNetworkRecoveryInProgress && this.localTransportResetPeerIds.has(peerId)) {
      return;
    }
    if (
      !this.session
      || this.pendingPeerDisconnectTimers.has(peerId)
      || !hasParticipant(this.session.authoritativeParticipants, peerId)
    ) {
      return;
    }
    if (this.isPeerCurrentlyConnected(peerId)) {
      return;
    }

    // TEMP_LOG
    log(
      `[GROUP-CALL][DISCONNECT][SCHEDULE] group=${this.session.groupId.slice(0, 8)} call=${this.session.callId.slice(0, 8)} peer=${peerId.slice(-8)} role=${this.session.role}`,
    );
    const timer = setTimeout(() => {
      this.pendingPeerDisconnectTimers.delete(peerId);
      // TEMP_LOG
      log(
        `[GROUP-CALL][DISCONNECT][GRACE_FIRE] group=${this.session?.groupId.slice(0, 8) ?? 'none'} call=${this.session?.callId.slice(0, 8) ?? 'none'} peer=${peerId.slice(-8)} role=${this.session?.role ?? 'none'}`,
      );
      this.handlePeerDisconnectGraceExpired(peerId);
    }, PEER_DISCONNECT_GRACE_MS);
    this.pendingPeerDisconnectTimers.set(peerId, {
      timer,
      expiresAt: Date.now() + PEER_DISCONNECT_GRACE_MS,
    });
    this.emitStateChanged(this.session.state, { reason: 'disconnect_grace_started', peerId });
  }

  private handlePeerDisconnectGraceExpired(peerId: string): void {
    if (!this.session) {
      return;
    }
    if (!hasParticipant(this.session.authoritativeParticipants, peerId)) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][DISCONNECT][GRACE_SKIP] group=${this.session.groupId.slice(0, 8)} call=${this.session.callId.slice(0, 8)} peer=${peerId.slice(-8)} reason=not_in_authoritative_roster`,
      );
      this.emitStateChanged(this.session.state, { reason: 'disconnect_grace_cleared', peerId });
      return;
    }

    const chat = this.database.getChatByGroupId(this.session.groupId);
    if (!chat) {
      return;
    }

    if (this.session.role === 'writer') {
      const nextParticipants = this.session.authoritativeParticipants
        .filter((participant) => participant.peerId !== peerId);
      if (nextParticipants.length === this.session.authoritativeParticipants.length) {
        return;
      }

      this.adoptAuthoritativeState(nextParticipants, this.session.rosterVersion + 1, this.session.currentWriterPeerId);
      this.scheduleRosterBroadcast(chat);
      this.emitStateChanged(this.session.state, { reason: 'disconnect_evicted' });
      // TEMP_LOG
      log(
        `[GROUP-CALL][DISCONNECT][EVICT] group=${this.session.groupId.slice(0, 8)} call=${this.session.callId.slice(0, 8)} peer=${peerId.slice(-8)} participants=${nextParticipants.length}`,
      );
      return;
    }

    if (peerId !== this.session.currentWriterPeerId) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][DISCONNECT][GRACE_EXPIRE] group=${this.session.groupId.slice(0, 8)} call=${this.session.callId.slice(0, 8)} peer=${peerId.slice(-8)} role=${this.session.role} writer=${this.session.currentWriterPeerId.slice(-8)} action=wait_no_failover`,
      );
      this.emitStateChanged(this.session.state, { reason: 'disconnect_grace_expired', peerId });
      return;
    }

    const remainingParticipants = this.session.authoritativeParticipants
      .filter((participant) => participant.peerId !== peerId);
    const nextWriterPeerId = this.failoverWriterPeerId(chat, remainingParticipants);
    if (!nextWriterPeerId) {
      return;
    }

    this.clearPendingRosterBroadcast();
    this.adoptAuthoritativeState(remainingParticipants, this.session.rosterVersion + 1, nextWriterPeerId);
    this.emitStateChanged(this.session.state, { reason: 'writer_failover' });
    // TEMP_LOG
    log(
      `[GROUP-CALL][FAILOVER][WRITER] group=${this.session.groupId.slice(0, 8)} call=${this.session.callId.slice(0, 8)} old=${peerId.slice(-8)} new=${nextWriterPeerId.slice(-8)} participants=${remainingParticipants.length}`,
    );
    if (nextWriterPeerId === this.localPeerId()) {
      void this.broadcastRoster(chat);
    }
  }

  private emitStateChanged(state: GroupCallState, options?: { reason?: string; peerId?: string }): void {
    if (!this.session) {
      return;
    }

    const event: GroupCallStateChangedEvent = {
      chatId: this.session.chatId,
      groupId: this.session.groupId,
      callId: this.session.callId,
      state,
      role: this.session.role,
      participants: this.session.authoritativeParticipants,
      pendingDisconnects: this.currentPendingDisconnects(),
      writerPeerId: this.session.currentWriterPeerId,
      timestamp: Date.now(),
    };
    if (options?.reason) {
      event.reason = options.reason;
    }
    if (options?.peerId) {
      event.peerId = options.peerId;
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
      const chat = this.database.getChatByGroupId(signal.groupId);
      if (
        validation.error === 'Group is not eligible for call signaling'
        && (chat?.group_status === 'invited_pending' || chat?.group_status === 'awaiting_activation')
      ) {
        // TEMP_LOG
        log(
          `[GROUP-CALL][SIGNAL][SKIP] type=${signal.type} group=${signal.groupId.slice(0, 8)} reason=activating status=${chat.group_status}`,
        );
        return false;
      }
      if (
        signal.type === 'GROUP_CALL_QUERY'
        && validation.error === 'Sender is not a current member of this group'
        && this.tryDeferGroupQuery(remotePeerId, signal)
      ) {
        // TEMP_LOG
        log(
          `[GROUP-CALL][SIGNAL][SKIP] type=${signal.type} group=${signal.groupId.slice(0, 8)} reason=deferred_query from=${remotePeerId.slice(-8)}`,
        );
        return false;
      }
      // TEMP_LOG
      log(
        `[GROUP-CALL][SIGNAL][DROP] type=${signal.type} group=${signal.groupId.slice(0, 8)} call=${'callId' in signal ? signal.callId.slice(0, 8) : 'none'} from=${remotePeerId.slice(-8)} reason=${validation.error ?? 'validation_failed'}`,
      );
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

    if (!this.recordSeenSignalSignature(signal.signature, signal.type, remotePeerId)) {
      // TEMP_LOG
      log(
        `[GROUP-CALL][SIGNAL][DROP] type=${signal.type} group=${signal.groupId.slice(0, 8)} call=${'callId' in signal ? signal.callId.slice(0, 8) : 'none'} from=${remotePeerId.slice(-8)} reason=duplicate_signature`,
      );
      return false;
    }
    return true;
  }

  private recordSeenSignalSignature(signature: string, signalType: string, remotePeerId: string): boolean {
    const now = Date.now();
    this.pruneSeenSignalSignatures(now);
    const previousSeenAt = this.seenSignalSignatures.get(signature);
    if (previousSeenAt && previousSeenAt >= now - GROUP_CALL_SIGNAL_DEDUPE_TTL_MS) {
      return false;
    }

    this.seenSignalSignatures.set(signature, now);
    this.trimSeenSignalSignatures();
    return true;
  }

  private tryDeferGroupQuery(
    remotePeerId: string,
    signal: Extract<GroupCallControlSignalMessage, { type: 'GROUP_CALL_QUERY' }>,
  ): boolean {
    if (!this.verifyDeferredGroupQueryCandidate(remotePeerId, signal)) {
      return false;
    }
    if (!this.recordSeenSignalSignature(signal.signature, signal.type, remotePeerId)) {
      return true;
    }

    const key = this.deferredQueryKey(signal.groupId, signal.fromPeerId);
    const existing = this.deferredQueriesByKey.get(key);
    if (existing) {
      existing.signal = signal;
      return true;
    }
    if (this.deferredQueryCountForGroup(signal.groupId) >= MAX_DEFERRED_QUERY_PEERS_PER_GROUP) {
      return false;
    }
    const timer = setTimeout(() => {
      this.deferredQueriesByKey.delete(key);
    }, DEFERRED_QUERY_TTL_MS);
    this.deferredQueriesByKey.set(key, {
      signal,
      receivedAt: Date.now(),
      timer,
    });
    return true;
  }

  private verifyDeferredGroupQueryCandidate(
    remotePeerId: string,
    signal: Extract<GroupCallControlSignalMessage, { type: 'GROUP_CALL_QUERY' }>,
  ): boolean {
    const validation = verifyIncomingGroupCallSignal(remotePeerId, signal, {
      localPeerId: this.localPeerId(),
      getSigningPublicKey: (peerId) => this.database.getUserByPeerId(peerId)?.signing_public_key,
      assertSignalAllowed: (allowedSignal) => {
        if (this.database.getSessionNetworkMode() !== NETWORK_MODES.FAST) {
          throw new Error('Group calls require fast mode');
        }

        const chat = this.database.getChatByGroupId(allowedSignal.groupId);
        if (!chat || chat.type !== 'group') {
          throw new Error('Unknown group for group call signal');
        }
        if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') {
          throw new Error('Group is not eligible for call signaling');
        }

        const participantIds = new Set(
          this.database.getChatParticipants(chat.id).map((participant) => participant.peer_id),
        );
        if (!participantIds.has(this.localPeerId())) {
          throw new Error('Local user is not a current member of this group');
        }
      },
    });
    return validation.valid;
  }

  private deferredQueryKey(groupId: string, fromPeerId: string): string {
    return `${groupId}:${fromPeerId}`;
  }

  private deferredQueryCountForGroup(groupId: string): number {
    let count = 0;
    for (const deferred of this.deferredQueriesByKey.values()) {
      if (deferred.signal.groupId === groupId) {
        count += 1;
      }
    }
    return count;
  }

  private flushDeferredQueriesForMember(groupId: string, peerId: string): void {
    for (const [key, deferred] of this.deferredQueriesByKey) {
      if (deferred.signal.groupId !== groupId || deferred.signal.fromPeerId !== peerId) {
        continue;
      }
      clearTimeout(deferred.timer);
      this.deferredQueriesByKey.delete(key);
      void this.respondToQuery(deferred.signal);
    }
  }

  private clearDeferredQueries(): void {
    for (const deferred of this.deferredQueriesByKey.values()) {
      clearTimeout(deferred.timer);
    }
    this.deferredQueriesByKey.clear();
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
          const { signature, ...rest } = signal;
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
