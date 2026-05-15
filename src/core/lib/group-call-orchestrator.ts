import { NETWORK_MODES } from '../constants.js';
import type {
  ChatNode,
  GroupCallControlSignalForRenderer,
  GroupCallControlSignalMessage,
  GroupCallControlSignalReceivedEvent,
  GroupCallErrorEvent,
  GroupCallPairSignalForRenderer,
  GroupCallPairSignalMessage,
  GroupCallPairSignalOutgoingInput,
  GroupCallPairSignalReceivedEvent,
  GroupCallStateChangedEvent,
} from '../types.js';
import { log } from '../../shared/logger.js';
import type { Chat } from '../db/database.js';
import { ChatDatabase } from '../db/database.js';
import { CallActivityRegistry } from './call-activity-registry.js';
import {
  GROUP_CALL_SIGNAL_DEDUPE_MAX_ENTRIES,
  GROUP_CALL_SIGNAL_DEDUPE_TTL_MS,
  assertGroupCallSignalAllowed,
  isGroupCallControlSignalMessage,
  isGroupCallPairSignalMessage,
  verifyIncomingGroupCallSignal,
} from './group-call-signaling.js';

type GroupCallOrchestratorConfig = {
  node: ChatNode;
  database: ChatDatabase;
  callActivityRegistry: CallActivityRegistry;
  onControlSignalReceived?: (data: GroupCallControlSignalReceivedEvent) => void;
  onPairSignalReceived?: (data: GroupCallPairSignalReceivedEvent) => void;
  onStateChanged?: (data: GroupCallStateChangedEvent) => void;
  onError?: (data: GroupCallErrorEvent) => void;
};

export class GroupCallOrchestrator {
  private readonly node: ChatNode;
  private readonly database: ChatDatabase;
  private readonly callActivityRegistry: CallActivityRegistry;
  private readonly onControlSignalReceived: (data: GroupCallControlSignalReceivedEvent) => void;
  private readonly onPairSignalReceived: (data: GroupCallPairSignalReceivedEvent) => void;
  private readonly onStateChanged: (data: GroupCallStateChangedEvent) => void;
  private readonly onError: (data: GroupCallErrorEvent) => void;
  private readonly seenSignalSignatures = new Map<string, number>();

  constructor(config: GroupCallOrchestratorConfig) {
    this.node = config.node;
    this.database = config.database;
    this.callActivityRegistry = config.callActivityRegistry;
    this.onControlSignalReceived = config.onControlSignalReceived ?? (() => undefined);
    this.onPairSignalReceived = config.onPairSignalReceived ?? (() => undefined);
    this.onStateChanged = config.onStateChanged ?? (() => undefined);
    this.onError = config.onError ?? (() => undefined);
  }

  hasActiveCall(): boolean {
    return this.callActivityRegistry.hasGroupCall();
  }

  async startGroupCall(chatId: number): Promise<{ success: boolean; error: string | null }> {
    try {
      const chat = this.requireEligibleGroupChat(chatId);
      const gate = this.callActivityRegistry.canUseGroupCall({ groupId: chat.group_id! });
      if (!gate.allowed) {
        return { success: false, error: gate.error };
      }
      return { success: false, error: 'Group call start is not implemented yet' };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start group call' };
    }
  }

  async joinGroupCall(chatId: number): Promise<{ success: boolean; error: string | null }> {
    try {
      const chat = this.requireEligibleGroupChat(chatId);
      const gate = this.callActivityRegistry.canUseGroupCall({ groupId: chat.group_id! });
      if (!gate.allowed) {
        return { success: false, error: gate.error };
      }
      return { success: false, error: 'Group call join is not implemented yet' };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to join group call' };
    }
  }

  async leaveGroupCall(chatId: number): Promise<{ success: boolean; error: string | null }> {
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

  async handleIncomingControlSignal(remotePeerId: string, signal: unknown): Promise<boolean> {
    if (!isGroupCallControlSignalMessage(signal)) {
      return false;
    }
    if (!this.verifyAndRecordIncomingSignal(remotePeerId, signal)) {
      return true;
    }

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

  private verifyAndRecordIncomingSignal(
    remotePeerId: string,
    signal: Parameters<typeof verifyIncomingGroupCallSignal>[1],
  ): boolean {
    const validation = verifyIncomingGroupCallSignal(remotePeerId, signal, {
      localPeerId: this.node.peerId.toString(),
      getSigningPublicKey: (peerId) => this.database.getUserByPeerId(peerId)?.signing_public_key,
      assertSignalAllowed: (allowedSignal) => {
        assertGroupCallSignalAllowed(this.database, this.node.peerId.toString(), allowedSignal);
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
      this.emitError(validation.error ?? 'Group call signal validation failed', {
        ...errorContext,
      });
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
    context: Pick<GroupCallErrorEvent, 'groupId' | 'callId' | 'peerId' | 'code'>,
  ): void {
    this.onError({
      error,
      ...context,
      timestamp: Date.now(),
    });
  }
}
