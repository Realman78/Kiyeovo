import { randomBytes, randomUUID, publicEncrypt } from 'crypto';
import { gunzipSync } from 'zlib';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import type { ChatNode, GroupMembersUpdatedEvent, MessageReceivedEvent } from '../../types.js';
import type { ChatDatabase } from '../../db/database.js';
import type { EncryptedUserIdentity } from '../../identity/encrypted-user-identity.js';
import { OfflineMessageManager } from '../../direct/offline-message-manager.js';
import { toBase64Url } from '../../utils/miscellaneous.js';
import {
  GROUP_INVITE_LIFETIME,
  GROUP_MAX_MEMBERS,
  GROUP_REINVITE_COOLDOWN_MS,
  GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY,
  GROUP_ROTATION_IO_CONCURRENCY,
  GROUP_MESSAGE_MAX_FUTURE_SKEW_MS,
  GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS,
  getNetworkModeRuntime,
  GROUP_PENDING_ACK_RETIRE_AGE_MS,
  GROUP_OFFLINE_STORE_MAX_DECOMPRESSED_BYTES,
} from '../../constants.js';
import {
  GroupMessageType,
  type GroupInvite,
  type GroupInviteDeliveredAck,
  type GroupInviteResponse,
  type GroupInviteResponseAck,
  type GroupLeaveRequest,
  type GroupKick,
  type GroupDisband,
  type GroupStateResyncRequest,
  type GroupWelcome,
  type GroupStateUpdate,
  type GroupControlAck,
  type GroupRosterEntry,
  type GroupInfoLatest,
  type GroupInfoVersioned,
  type GroupInfoVersionedMetadata,
  type GroupOfflineStore,
  type GroupStatus,
  type AckMessageType,
} from '../types.js';
import { putJsonToDHT } from '../dht/group-dht-publish.js';
import { nudgeGroupRefetchIfKnownGroup } from '../dht/group-refetch-nudge.js';
import { QueryEvent } from '@libp2p/kad-dht';
import { log } from '../../../shared/logger.js';
import { errStr } from '../../utils/general-error.js';

export interface GroupCreatorDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  myUsername: string;
  onGroupMembersUpdated?: (data: GroupMembersUpdatedEvent) => void;
  onMessageReceived?: (data: MessageReceivedEvent) => void;
  onOfflineInboxCapacityChanged?: (chatId: number) => void;
  nudgeGroupRefetch?: (peerId: string, groupId: string) => void;
  onRegisterPrevEpochGrace?: (groupId: string, keyVersion: number) => void;
}

export type GroupInviteDeliveryStatus = 'sent' | 'queued_for_retry';

export interface GroupInviteDelivery {
  peerId: string;
  username: string;
  status: GroupInviteDeliveryStatus;
  reason?: string;
}

export interface GroupCreateResult {
  groupId: string;
  inviteDeliveries: GroupInviteDelivery[];
}

export class GroupCreator {
  private deps: GroupCreatorDeps;
  private static reinviteCooldowns = new Map<string, number>();
  private static stateResyncRequestCooldowns = new Map<string, number>();
  private static readonly STATE_RESYNC_REQUEST_COOLDOWN_CACHE_MAX_ENTRIES = 1000;
  private readonly directOfflineBucketPrefix: string;
  private readonly groupOfflineBucketPrefix: string;
  private readonly groupInfoLatestPrefix: string;
  private readonly groupInfoVersionPrefix: string;

  constructor(deps: GroupCreatorDeps) {
    this.deps = deps;
    const runtime = getNetworkModeRuntime(this.deps.database.getSessionNetworkMode());
    this.directOfflineBucketPrefix = runtime.config.dhtNamespaces.offline;
    this.groupOfflineBucketPrefix = runtime.config.dhtNamespaces.groupOffline;
    this.groupInfoLatestPrefix = runtime.config.dhtNamespaces.groupInfoLatest;
    this.groupInfoVersionPrefix = runtime.config.dhtNamespaces.groupInfoVersion;
  }

  async createGroup(groupName: string, invitedPeerIds: string[]): Promise<GroupCreateResult> {
    const { database, myPeerId } = this.deps;

    if (invitedPeerIds.length + 1 > GROUP_MAX_MEMBERS) {
      throw new Error(`Group cannot exceed ${GROUP_MAX_MEMBERS} members`);
    }
    
    if (invitedPeerIds.length < 2) {
      throw new Error(`You must invite at least 2 people`);
    }

    // Verify all invitees are known contacts
    for (const peerId of invitedPeerIds) {
      const user = database.getUserByPeerId(peerId);
      if (!user) {
        throw new Error(`User ${peerId} not found in contacts`);
      }
    }

    const groupId = randomUUID();

    // Create the chat entry
    const chatId = await database.createChat({
      type: 'group',
      name: groupName,
      created_by: myPeerId,
      offline_bucket_secret: '',
      notifications_bucket_key: '',
      group_id: groupId,
      status: 'active',
      offline_last_read_timestamp: 0,
      offline_last_ack_sent: 0,
      trusted_out_of_band: false,
      muted: false,
      key_version: 0,
      group_creator_peer_id: myPeerId,
      group_status: 'invited_pending',
      created_at: new Date(),
      participants: [myPeerId],
    });

    database.transitionChatGroupStatus(chatId, 'invited_pending' satisfies GroupStatus, 'group_created');
    database.updateChatKeyVersion(chatId, 0);

    // Send invites
    const inviteDeliveries = await this.sendGroupInvites(groupId, groupName, invitedPeerIds);

    return { groupId, inviteDeliveries };
  }

  async inviteUsersToExistingGroup(chatId: number, invitedPeerIds: string[]): Promise<GroupInviteDelivery[]> {
    const { database, myPeerId } = this.deps;

    if (invitedPeerIds.length === 0) {
      throw new Error('Select at least one user to invite');
    }

    const chat = database.getChatByIdWithUsernameAndLastMsg(chatId, myPeerId);
    if (!chat || chat.type !== 'group' || !chat.group_id) {
      throw new Error('Group chat not found');
    }
    if (chat.created_by !== myPeerId) {
      throw new Error('Only the group creator can invite new users');
    }
    if (chat.status !== 'active' || chat.group_status !== 'active') {
      throw new Error(`Cannot invite users while group status is ${chat.group_status ?? chat.status}`);
    }

    const participants = database.getChatParticipants(chat.id).map((p) => p.peer_id);
    const participantSet = new Set(participants);
    const pendingInviteTargets = new Set(
      database.getPendingAcksForGroup(chat.group_id)
        .filter((ack) => ack.message_type === 'GROUP_INVITE')
        .map((ack) => ack.target_peer_id),
    );

    const uniqueTargets = Array.from(new Set(invitedPeerIds));
    const normalizedTargets: string[] = [];
    const skipped: GroupInviteDelivery[] = [];

    for (const peerId of uniqueTargets) {
      if (peerId === myPeerId) {
        skipped.push({
          peerId,
          username: peerId,
          status: 'queued_for_retry',
          reason: 'Cannot invite yourself',
        });
        continue;
      }

      const user = database.getUserByPeerId(peerId);
      if (!user) {
        skipped.push({
          peerId,
          username: peerId,
          status: 'queued_for_retry',
          reason: 'User not found in contacts',
        });
        continue;
      }

      if (participantSet.has(peerId)) {
        skipped.push({
          peerId,
          username: user.username,
          status: 'queued_for_retry',
          reason: 'User is already in the group',
        });
        continue;
      }

      if (pendingInviteTargets.has(peerId)) {
        skipped.push({
          peerId,
          username: user.username,
          status: 'queued_for_retry',
          reason: 'User already has a pending invite',
        });
        continue;
      }

      normalizedTargets.push(peerId);
    }

    const reservedByPendingInvites = Array.from(pendingInviteTargets)
      .filter((peerId) => !participantSet.has(peerId)).length;
    const usedSlots = participants.length + reservedByPendingInvites;
    const availableSlots = Math.max(0, GROUP_MAX_MEMBERS - usedSlots);
    if (availableSlots <= 0) {
      return [
        ...skipped,
        ...normalizedTargets.map((peerId) => {
          const user = database.getUserByPeerId(peerId);
          return {
            peerId,
            username: user?.username || peerId,
            status: 'queued_for_retry' as const,
            reason: `Group is full (${GROUP_MAX_MEMBERS} members max)`,
          };
        }),
      ];
    }

    const allowedTargets = normalizedTargets.slice(0, availableSlots);
    const overflowTargets = normalizedTargets.slice(availableSlots);
    const overflowDeliveries: GroupInviteDelivery[] = overflowTargets.map((peerId) => {
      const user = database.getUserByPeerId(peerId);
      return {
        peerId,
        username: user?.username || peerId,
        status: 'queued_for_retry',
        reason: `Group member limit reached (${GROUP_MAX_MEMBERS} max)`,
      };
    });

    const inviteDeliveries = await this.sendGroupInvites(chat.group_id, chat.name, allowedTargets);
    return [...inviteDeliveries, ...skipped, ...overflowDeliveries];
  }

  async reinviteUserToExistingGroup(chatId: number, peerId: string): Promise<GroupInviteDelivery> {
    const { database, myPeerId } = this.deps;
    const chat = database.getChatByIdWithUsernameAndLastMsg(chatId, myPeerId);
    if (!chat || chat.type !== 'group' || !chat.group_id) {
      throw new Error('Group chat not found');
    }
    if (chat.created_by !== myPeerId) {
      throw new Error('Only the group creator can re-invite users');
    }
    if (chat.status !== 'active' || chat.group_status !== 'active') {
      throw new Error(`Cannot re-invite users while group status is ${chat.group_status ?? chat.status}`);
    }

    const cooldownKey = `${chat.group_id}:${peerId}`;
    const now = Date.now();
    const lastReinviteAt = GroupCreator.reinviteCooldowns.get(cooldownKey) ?? 0;
    const elapsed = now - lastReinviteAt;
    if (elapsed < GROUP_REINVITE_COOLDOWN_MS) {
      const waitMs = GROUP_REINVITE_COOLDOWN_MS - elapsed;
      const waitSeconds = Math.ceil(waitMs / 1000);
      throw new Error(`Re-invite cooldown active. Try again in ${waitSeconds}s`);
    }

    const pendingInvite = database.getPendingAcksForGroup(chat.group_id).some(
      (ack) => ack.message_type === 'GROUP_INVITE' && ack.target_peer_id === peerId,
    );
    if (!pendingInvite) {
      throw new Error('No pending invite for this user');
    }

    database.removePendingAck(chat.group_id, peerId, 'GROUP_INVITE');
    GroupCreator.reinviteCooldowns.set(cooldownKey, now);
    const deliveries = await this.inviteUsersToExistingGroup(chatId, [peerId]);
    return deliveries[0] ?? {
      peerId,
      username: database.getUserByPeerId(peerId)?.username || peerId,
      status: 'queued_for_retry',
      reason: 'Re-invite queued for retry',
    };
  }

  async republishPendingInvitesForPeer(groupId: string, targetPeerId: string): Promise<number> {
    const pendingInvites = this.deps.database
      .getPendingAcksForGroup(groupId)
      .filter(
        (pending) =>
          pending.message_type === 'GROUP_INVITE' &&
          pending.target_peer_id === targetPeerId,
      );

    let republished = 0;
    for (const pendingInvite of pendingInvites) {
      // eslint-disable-next-line no-await-in-loop
      await this.republishPendingControl(targetPeerId, pendingInvite.message_payload);
      this.deps.database.updatePendingAckLastPublished(groupId, targetPeerId, 'GROUP_INVITE');
      republished++;
    }
    return republished;
  }

  private async sendGroupInvites(groupId: string, groupName: string, invitedPeerIds: string[]): Promise<GroupInviteDelivery[]> {
    const { database, myPeerId } = this.deps;
    const now = Date.now();
    let sent = 0;
    let queued = 0;
    const deliveries: GroupInviteDelivery[] = [];
    const batchSize = 3;

    for (let i = 0; i < Math.min(invitedPeerIds.length, 9); i += batchSize) {
      const batch = invitedPeerIds.slice(i, i + batchSize);
      const round = Math.floor(i / batchSize) + 1;
      log(`[GROUP][TRACE][INVITE][ROUND_START] group=${groupId} round=${round} size=${batch.length}`);

      const roundResults = await Promise.all(batch.map(async (peerId): Promise<GroupInviteDelivery> => {
        const inviteId = randomUUID();
        const expiresAt = now + GROUP_INVITE_LIFETIME;
        const invitee = database.getUserByPeerId(peerId);
        const username = invitee?.username || peerId;

        try {
          const invite: Omit<GroupInvite, 'signature'> = {
            type: GroupMessageType.GROUP_INVITE,
            groupId,
            groupName,
            inviterPeerId: myPeerId,
            inviteePeerId: peerId,
            inviteId,
            createdAt: now,
            expiresAt,
          };

          const signature = this.sign(invite);
          const signedInvite: GroupInvite = { ...invite, signature };

          // Store in pending ACKs first, then send
          database.insertPendingAck(groupId, peerId, 'GROUP_INVITE', JSON.stringify(signedInvite));
          log(
            `[GROUP][TRACE][INVITE][CREATE] group=${groupId} inviteId=${inviteId} to=${username} expiresAt=${expiresAt}`,
          );

          await this.sendControlMessageToPeer(peerId, signedInvite);
          log(
            `[GROUP][TRACE][INVITE][SENT] group=${groupId} inviteId=${inviteId} to=${username}`,
          );
          return { peerId, username, status: 'sent' };
        } catch (error: unknown) {
          const reason = errStr(error);
          console.warn(`[GROUP] Invite to ${peerId} queued for retry: ${reason}`);
          return { peerId, username, status: 'queued_for_retry', reason };
        }
      }));

      for (const result of roundResults) {
        deliveries.push(result);
        if (result.status === 'sent') sent++;
        else queued++;
      }

      log(`[GROUP][TRACE][INVITE][ROUND_DONE] group=${groupId} round=${round} sent=${sent} queued=${queued}`);
    }

    if (queued > 0) {
      log(`[GROUP] Group ${groupId}: invites sent now=${sent}, queued for retry=${queued}`);
    }
    return deliveries;
  }

  async processInviteResponse(response: GroupInviteResponse): Promise<void> {
    const { database, myPeerId } = this.deps;
    log(
      `[GROUP][TRACE][RESP][IN] group=${response.groupId} inviteId=${response.inviteId} msgId=${response.messageId} from=${response.responderPeerId.slice(-8)} response=${response.response} ts=${response.timestamp}`,
    );

    // Verify this is for a group we created
    const chat = database.getChatByGroupId(response.groupId);
    if (!chat || chat.created_by !== myPeerId) {
      throw new Error(`Not creator of group ${response.groupId}`);
    }

    // Group was disbanded locally; ACK responder so they stop retrying.
    if (chat.group_status === 'disbanded') {
      const responder = database.getUserByPeerId(response.responderPeerId);
      if (!responder) {
        return;
      }
      this.verifySignature(response, responder.signing_public_key);
      await this.sendInviteResponseAck(response);
      return;
    }

    // Reconstruct invite state from pending_acks (survives restart)
    const storedInvite = this.getStoredPendingInvite(response.groupId, response.responderPeerId);
    if (!storedInvite) {
      // No pending invite = already processed (dedup) or never sent
      log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} reason=no_pending_invite`,
      );
      return;
    }

    // Defense-in-depth: the pending invite is already keyed by target peer, but also
    // reject if the signed invitee binding doesn't match the responder.
    if (storedInvite.inviteePeerId !== response.responderPeerId) {
      log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} reason=invitee_binding_mismatch invitee=${storedInvite.inviteePeerId.slice(-8)}`,
      );
      return;
    }

    const timestampCheck = this.validateControlTimestamp(response.timestamp);
    if (!timestampCheck.ok) {
      throw new Error(
        `Invalid invite response timestamp (${timestampCheck.reason}) for group=${response.groupId} responder=${response.responderPeerId}`,
      );
    }

    if (response.inviteId !== storedInvite.inviteId) {
      const deliveredInviteExists = database.isInviteDeliveryAckReceived(
        response.groupId,
        response.responderPeerId,
        response.inviteId,
      );
      if (!deliveredInviteExists) {
        throw new Error(
          `Invite ID mismatch without delivery ACK: incoming=${response.inviteId} pending=${storedInvite.inviteId}`,
        );
      }
      log(
        `[GROUP][TRACE][RESP][INVITE_ID_FALLBACK] group=${response.groupId} from=${response.responderPeerId.slice(-8)} incomingInviteId=${response.inviteId} pendingInviteId=${storedInvite.inviteId} reason=delivered_ack_match`,
      );
    }

    if (Date.now() > storedInvite.expiresAt + GROUP_PENDING_ACK_RETIRE_AGE_MS) {
      log(
        `[GROUP][TRACE][RESP][DROP] group=${response.groupId} from=${response.responderPeerId.slice(-8)} reason=invite_expired expiresAt=${storedInvite.expiresAt + GROUP_PENDING_ACK_RETIRE_AGE_MS}`,
      );
      this.cleanupInvitePendingState(response.groupId, response.responderPeerId);
      return;
    }

    // Verify signature
    const responder = database.getUserByPeerId(response.responderPeerId);
    if (!responder) {
      throw new Error(`Responder ${response.responderPeerId} not found`);
    }
    this.verifySignature(response, responder.signing_public_key);

    // Send ACK back
    await this.sendInviteResponseAck(response);

    if (response.response === 'reject') {
      // Reject is terminal for this invite.
      this.cleanupInvitePendingState(response.groupId, response.responderPeerId);
      log(
        `[GROUP][TRACE][RESP][DONE] group=${response.groupId} from=${response.responderPeerId.slice(-8)} result=rejected`,
      );
      return;
    }

    // If already a participant, treat this as idempotent duplicate acceptance.
    const alreadyParticipant = this.isParticipant(chat.id, response.responderPeerId);
    if (alreadyParticipant) {
      this.cleanupInvitePendingState(response.groupId, response.responderPeerId);
      log(
        `[GROUP][TRACE][RESP][DONE] group=${response.groupId} from=${response.responderPeerId.slice(-8)} result=already_participant`,
      );
      return;
    }

    await this.sendGroupWelcome(response.groupId, response.responderPeerId, Date.now());

    // Remove invite only after welcome path succeeds.
    this.cleanupInvitePendingState(response.groupId, response.responderPeerId);
    log(
      `[GROUP][TRACE][RESP][DONE] group=${response.groupId} from=${response.responderPeerId.slice(-8)} result=accepted_pending_removed`,
    );
  }

  private getStoredPendingInvite(groupId: string, responderPeerId: string): GroupInvite | null {
    const pendingInvite = this.deps.database.getPendingAcksForGroup(groupId).find(
      (ack) => ack.target_peer_id === responderPeerId && ack.message_type === 'GROUP_INVITE',
    );
    if (!pendingInvite) return null;

    try {
      return JSON.parse(pendingInvite.message_payload) as GroupInvite;
    } catch {
      throw new Error('Invalid pending invite payload');
    }
  }

  private cleanupInvitePendingState(groupId: string, responderPeerId: string): void {
    this.deps.database.removePendingAck(groupId, responderPeerId, 'GROUP_INVITE');
    this.deps.database.removeInviteDeliveryAcksForMember(groupId, responderPeerId);
  }

  private isParticipant(chatId: number, peerId: string): boolean {
    return this.deps.database.getChatParticipants(chatId).some((participant) => participant.peer_id === peerId);
  }

  async processLeaveRequest(request: GroupLeaveRequest, senderPeerId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    log(
      `[GROUP][TRACE][LEAVE][IN] group=${request.groupId} from=${senderPeerId.slice(-8)} peerId=${request.peerId.slice(-8)} msgId=${request.messageId}`,
    );

    const validated = this.validateCreatorInboundGroupControl({
      traceTag: 'LEAVE',
      groupId: request.groupId,
      messageId: request.messageId,
      senderPeerId,
      payloadPeerId: request.peerId,
      disbandedReason: 'group_disbanded',
      requireTimestamp: false,
    });
    if (!validated.ok) return;
    const chat = validated.chat;

    const leavingUser = database.getUserByPeerId(request.peerId);
    if (!leavingUser) {
      log(
        `[GROUP][TRACE][LEAVE][DROP] group=${request.groupId} reason=unknown_sender sender=${senderPeerId.slice(-8)}`,
      );
      return;
    }
    this.verifySignature(request, leavingUser.signing_public_key);

    if (request.peerId === myPeerId) {
      log(`[GROUP][TRACE][LEAVE][DROP] group=${request.groupId} reason=creator_leave_not_supported`);
      return;
    }

    const isParticipant = database.getChatParticipants(chat.id).some((p) => p.peer_id === request.peerId);
    if (!isParticipant) {
      log(
        `[GROUP][TRACE][LEAVE][DUPLICATE] group=${request.groupId} peer=${request.peerId.slice(-8)} reason=already_removed`,
      );
      return;
    }

    // Avoid concurrent rotations (e.g. join and leave in flight at the same time).
    // Throwing here causes offline handler to keep the message for retry later.
    if (chat.group_status === 'rekeying') {
      throw new Error(`Group ${request.groupId} is already rekeying`);
    }

    const previousGroupStatus = (chat.group_status ?? 'active') as GroupStatus;
    let rotationCommitted = false;
    database.transitionChatGroupStatus(chat.id, 'rekeying', 'leave_request_rotation_start');

    try {
      const preRotationParticipants = database.getChatParticipants(chat.id).map((p) => p.peer_id);
      const prevVersion = chat.key_version ?? 0;
      const prevEpochBoundaries = prevVersion > 0
        ? await this.snapshotPrevEpochBoundaries(request.groupId, prevVersion, preRotationParticipants)
        : {};

      const { groupKey, keyVersion, groupInfoMetadataKey } = this.rotateGroupKey(request.groupId, request.peerId, 'leave');
      rotationCommitted = true;
      if (prevVersion >= 1) {
        this.deps.onRegisterPrevEpochGrace?.(request.groupId, prevVersion);
      }

      const participants = database.getChatParticipants(chat.id);
      const roster = this.buildRoster(participants.map((p) => p.peer_id));

      await this.sendGroupStateUpdate(
        request.groupId,
        keyVersion,
        groupKey,
        groupInfoMetadataKey,
        roster,
        'leave',
        request.peerId,
        request.timestamp,
      );

      database.removePendingAcksForMember(request.groupId, request.peerId);
      database.removeInviteDeliveryAcksForMember(request.groupId, request.peerId);
      database.transitionChatGroupStatus(chat.id, 'active', 'leave_request_rotation_done');

      await this.appendMembershipSystemMessage(
        chat.id,
        request.groupId,
        keyVersion,
        'leave',
        request.peerId,
        leavingUser.username,
        request.timestamp,
      );

      this.deps.onGroupMembersUpdated?.({
        chatId: chat.id,
        groupId: request.groupId,
        memberPeerId: request.peerId,
      });
      void this.publishGroupInfoRecords(request.groupId, keyVersion, roster, groupInfoMetadataKey, prevEpochBoundaries)
        .catch((error: unknown) => {
          console.warn(`[GROUP][TRACE][LEAVE][GROUP_INFO_RETRY_NEEDED] group=${request.groupId} keyVersion=${keyVersion} reason=${errStr(error)}`);
        });
      log(
        `[GROUP][TRACE][LEAVE][DONE] group=${request.groupId} peer=${request.peerId.slice(-8)} keyVersion=${keyVersion}`,
      );
    } catch (error: unknown) {
      if (rotationCommitted) {
        database.transitionChatGroupStatus(chat.id, 'active', 'leave_request_partial_failure_keep_active');
        console.warn(`[GROUP][TRACE][LEAVE][PARTIAL_FAILURE] group=${request.groupId} peer=${request.peerId.slice(-8)} status=active reason=${errStr(error)}`);
        return;
      }
      database.transitionChatGroupStatus(chat.id, previousGroupStatus, 'leave_request_rotation_rollback');
      throw error;
    }
  }

  async processStateResyncRequest(request: GroupStateResyncRequest, senderPeerId: string): Promise<void> {
    const { database } = this.deps;
    log(
      `[GROUP][TRACE][RESYNC_REQ][IN] group=${request.groupId} from=${senderPeerId.slice(-8)} requester=${request.requesterPeerId.slice(-8)} msgId=${request.messageId} knownKeyVersion=${request.knownKeyVersion}`,
    );

    const validation = this.validateStateResyncRequest(request, senderPeerId);
    if (!validation.ok) {
      return;
    }
    const chat = validation.chat;

    const requester = database.getUserByPeerId(request.requesterPeerId);
    if (!requester) {
      log(
        `[GROUP][TRACE][RESYNC_REQ][DROP] group=${request.groupId} reason=unknown_requester requester=${request.requesterPeerId.slice(-8)}`,
      );
      return;
    }
    this.verifySignature(request, requester.signing_public_key);

    const participantIds = database.getChatParticipants(chat.id).map((participant) => participant.peer_id);
    const isParticipant = participantIds.includes(request.requesterPeerId);
    const hasPendingWelcome = database.getPendingAcksForGroup(request.groupId).some(
      (pending) =>
        pending.target_peer_id === request.requesterPeerId
        && pending.message_type === 'GROUP_WELCOME',
    );

    if (!isParticipant && !hasPendingWelcome) {
      log(
        `[GROUP][TRACE][RESYNC_REQ][DROP] group=${request.groupId} requester=${request.requesterPeerId.slice(-8)} reason=not_member`,
      );
      return;
    }

    if ((chat.key_version ?? 0) <= 0) {
      log(
        `[GROUP][TRACE][RESYNC_REQ][SKIP] group=${request.groupId} requester=${request.requesterPeerId.slice(-8)} reason=no_active_key`,
      );
      return;
    }

    const now = Date.now();
    this.pruneStateResyncRequestCooldowns(now);
    const cooldownKey = `${request.groupId}|${request.requesterPeerId}`;
    const lastRequestAt = GroupCreator.stateResyncRequestCooldowns.get(cooldownKey) ?? 0;
    const elapsed = now - lastRequestAt;
    if (elapsed < GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS) {
      const waitMs = GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS - elapsed;
      log(
        `[GROUP][TRACE][RESYNC_REQ][RATE_LIMIT] group=${request.groupId} requester=${request.requesterPeerId.slice(-8)} waitMs=${waitMs}`,
      );
      return;
    }
    GroupCreator.stateResyncRequestCooldowns.set(cooldownKey, now);

    try {
      await this.resendCurrentStateToPeer(request.groupId, request.requesterPeerId, 'member_request');
      log(
        `[GROUP][TRACE][RESYNC_REQ][DONE] group=${request.groupId} requester=${request.requesterPeerId.slice(-8)} msgId=${request.messageId}`,
      );
    } catch (error: unknown) {
      console.warn(`[GROUP][TRACE][RESYNC_REQ][QUEUE_RETRY] group=${request.groupId} requester=${request.requesterPeerId.slice(-8)} reason=${errStr(error)}`);
    }
  }

  private validateStateResyncRequest(
    request: GroupStateResyncRequest,
    senderPeerId: string,
  ): { ok: true; chat: NonNullable<ReturnType<ChatDatabase['getChatByGroupId']>> } | { ok: false } {
    return this.validateCreatorInboundGroupControl({
      traceTag: 'RESYNC_REQ',
      groupId: request.groupId,
      messageId: request.messageId,
      senderPeerId,
      payloadPeerId: request.requesterPeerId,
      disbandedReason: 'disbanded',
      requireTimestamp: true,
      timestamp: request.timestamp,
    });
  }

  private validateControlTimestamp(
    timestamp: number,
  ): { ok: true } | { ok: false; reason: 'invalid_timestamp' | 'future_timestamp' } {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return { ok: false, reason: 'invalid_timestamp' };
    }
    if (timestamp > Date.now() + GROUP_MESSAGE_MAX_FUTURE_SKEW_MS) {
      return { ok: false, reason: 'future_timestamp' };
    }
    return { ok: true };
  }

  private validateCreatorInboundGroupControl(options: {
    traceTag: 'LEAVE' | 'RESYNC_REQ';
    groupId: string;
    messageId: string;
    senderPeerId: string;
    payloadPeerId: string;
    disbandedReason: 'group_disbanded' | 'disbanded';
    requireTimestamp: boolean;
    timestamp?: number;
  }): { ok: true; chat: NonNullable<ReturnType<ChatDatabase['getChatByGroupId']>> } | { ok: false } {
    const { database, myPeerId } = this.deps;
    const chat = database.getChatByGroupId(options.groupId);
    if (!chat || chat.created_by !== myPeerId) {
      log(
        `[GROUP][TRACE][${options.traceTag}][DROP] group=${options.groupId} reason=not_creator chatExists=${!!chat}`,
      );
      return { ok: false };
    }
    if (chat.group_status === 'disbanded') {
      const fromSuffix = options.traceTag === 'LEAVE'
        ? ` from=${options.senderPeerId.slice(-8)}`
        : '';
      log(
        `[GROUP][TRACE][${options.traceTag}][DROP] group=${options.groupId}${fromSuffix} reason=${options.disbandedReason}`,
      );
      return { ok: false };
    }
    if (options.payloadPeerId !== options.senderPeerId) {
      log(
        `[GROUP][TRACE][${options.traceTag}][DROP] group=${options.groupId} msgId=${options.messageId} reason=peer_mismatch payloadPeer=${options.payloadPeerId.slice(-8)} sender=${options.senderPeerId.slice(-8)}`,
      );
      return { ok: false };
    }
    if (options.requireTimestamp) {
      const timestampCheck = this.validateControlTimestamp(options.timestamp ?? NaN);
      if (!timestampCheck.ok) {
        const suffix = timestampCheck.reason === 'future_timestamp' && options.timestamp !== undefined
          ? ` ts=${options.timestamp}`
          : '';
        log(
          `[GROUP][TRACE][${options.traceTag}][DROP] group=${options.groupId} msgId=${options.messageId} reason=${timestampCheck.reason}${suffix}`,
        );
        return { ok: false };
      }
    }
    return { ok: true, chat };
  }

  async kickMember(groupId: string, targetPeerId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    const eventTimestamp = Date.now();
    const chat = database.getChatByGroupId(groupId);
    if (!chat || chat.created_by !== myPeerId) {
      throw new Error(`Not creator of group ${groupId}`);
    }
    if (chat.type !== 'group') {
      throw new Error(`Chat for group ${groupId} is not a group chat`);
    }
    if (targetPeerId === myPeerId) {
      throw new Error('Creator cannot kick themselves');
    }

    const chatParticipants = database.getChatParticipants(chat.id);

    const isParticipant = chatParticipants.some((p) => p.peer_id === targetPeerId);
    if (!isParticipant) {
      throw new Error('Target user is not an active member of this group');
    }
    if (chat.group_status === 'rekeying') {
      throw new Error(`Group ${groupId} is already rekeying`);
    }
    if (chat.group_status === 'disbanded') {
      throw new Error(`Group ${groupId} is already disbanded`);
    }

    const targetUser = database.getUserByPeerId(targetPeerId);
    const previousGroupStatus = (chat.group_status ?? 'active') as GroupStatus;
    let rotationCommitted = false;
    database.transitionChatGroupStatus(chat.id, 'rekeying', 'kick_rotation_start');

    try {
      const preRotationParticipants = chatParticipants.map((p) => p.peer_id);
      const prevVersion = chat.key_version ?? 0;
      const prevEpochBoundaries = prevVersion > 0
        ? await this.snapshotPrevEpochBoundaries(groupId, prevVersion, preRotationParticipants)
        : {};

      const { groupKey, keyVersion, groupInfoMetadataKey } = this.rotateGroupKey(groupId, targetPeerId, 'kick');
      rotationCommitted = true;
      if (prevVersion >= 1) {
        this.deps.onRegisterPrevEpochGrace?.(groupId, prevVersion);
      }

      const postRotationPeerIds = preRotationParticipants.filter((peerId) => peerId !== targetPeerId);
      const roster = this.buildRoster(postRotationPeerIds);
      const includesTargetInRoster = roster.some((entry) => entry.peerId === targetPeerId);
      log(
        `[GROUP][TRACE][KICK][ROSTER] group=${groupId} keyVersion=${keyVersion} ` +
        `count=${roster.length} includesTarget=${includesTargetInRoster}`,
      );

      await this.sendGroupStateUpdate(
        groupId,
        keyVersion,
        groupKey,
        groupInfoMetadataKey,
        roster,
        'kick',
        targetPeerId,
        eventTimestamp,
      );

      try {
        await this.sendGroupKick(groupId, targetPeerId, keyVersion, eventTimestamp);
      } catch (error: unknown) {
        console.warn(
          `[GROUP][TRACE][KICK][KICK_MSG_FAILED] group=${groupId} to=${targetPeerId.slice(-8)} reason=${errStr(error)}`,
        );
      }

      database.removePendingAck(groupId, targetPeerId, 'GROUP_INVITE');
      database.removePendingAck(groupId, targetPeerId, 'GROUP_WELCOME');
      database.removePendingAck(groupId, targetPeerId, 'GROUP_STATE_UPDATE');
      database.removeInviteDeliveryAcksForMember(groupId, targetPeerId);
      database.transitionChatGroupStatus(chat.id, 'active', 'kick_rotation_done');

      await this.appendMembershipSystemMessage(
        chat.id,
        groupId,
        keyVersion,
        'kick',
        targetPeerId,
        targetUser?.username,
        eventTimestamp,
      );

      this.deps.onGroupMembersUpdated?.({
        chatId: chat.id,
        groupId,
        memberPeerId: targetPeerId,
      });

      void this.publishGroupInfoRecords(groupId, keyVersion, roster, groupInfoMetadataKey, prevEpochBoundaries)
        .catch((error: unknown) => {
          console.warn(
            `[GROUP][TRACE][KICK][GROUP_INFO_RETRY_NEEDED] group=${groupId} keyVersion=${keyVersion} reason=${errStr(error)}`,
          );
        });

      log(
        `[GROUP][TRACE][KICK][DONE] group=${groupId} peer=${targetPeerId.slice(-8)} keyVersion=${keyVersion}`,
      );
    } catch (error: unknown) {
      if (rotationCommitted) {
        database.transitionChatGroupStatus(chat.id, 'active', 'kick_partial_failure_keep_active');
        console.warn(
          `[GROUP][TRACE][KICK][PARTIAL_FAILURE] group=${groupId} peer=${targetPeerId.slice(-8)} status=active reason=${errStr(error)}`,
        );
        return;
      }
      database.transitionChatGroupStatus(chat.id, previousGroupStatus, 'kick_rotation_rollback');
      throw error;
    }
  }

  private pruneStateResyncRequestCooldowns(now: number): void {
    const maxAgeMs = GROUP_STATE_RESYNC_REQUEST_COOLDOWN_MS * 4;
    for (const [key, timestamp] of GroupCreator.stateResyncRequestCooldowns.entries()) {
      if (now - timestamp > maxAgeMs) {
        GroupCreator.stateResyncRequestCooldowns.delete(key);
      }
    }

    if (GroupCreator.stateResyncRequestCooldowns.size <= GroupCreator.STATE_RESYNC_REQUEST_COOLDOWN_CACHE_MAX_ENTRIES) {
      return;
    }

    const sorted = Array.from(GroupCreator.stateResyncRequestCooldowns.entries())
      .sort((a, b) => a[1] - b[1]);
    const overflow = GroupCreator.stateResyncRequestCooldowns.size - GroupCreator.STATE_RESYNC_REQUEST_COOLDOWN_CACHE_MAX_ENTRIES;
    for (let index = 0; index < overflow; index++) {
      const entry = sorted[index];
      if (!entry) break;
      GroupCreator.stateResyncRequestCooldowns.delete(entry[0]);
    }
  }

  async disbandGroup(groupId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    const chat = database.getChatByGroupId(groupId);
    if (!chat || chat.created_by !== myPeerId) {
      throw new Error(`Not creator of group ${groupId}`);
    }
    if (chat.type !== 'group') {
      throw new Error(`Chat for group ${groupId} is not a group chat`);
    }
    if (chat.group_status === 'disbanded') {
      return;
    }
    if (chat.group_status === 'rekeying') {
      throw new Error(`Group ${groupId} is already rekeying`);
    }

    const participantPeerIds = database
      .getChatParticipants(chat.id)
      .map((participant) => participant.peer_id)
      .filter((peerId) => peerId !== myPeerId);
    const pendingInviteTargets = new Set(
      database.getPendingAcksForGroup(groupId)
        .filter((pending) => pending.message_type === 'GROUP_INVITE')
        .map((pending) => pending.target_peer_id),
    );
    const disbandTargets = Array.from(
      new Set([
        ...participantPeerIds,
        ...pendingInviteTargets,
      ]),
    ).filter((peerId) => peerId !== myPeerId);
    const disbandTimestamp = Date.now();

    // Drop stale queued controls for this group and keep only disband notifications.
    database.removePendingAcksForGroup(groupId);
    database.removeInviteDeliveryAcksForMember(groupId, myPeerId);
    for (const peerId of disbandTargets) {
      database.removeInviteDeliveryAcksForMember(groupId, peerId);
    }

    let sent = 0;
    let queued = 0;
    for (const targetPeerId of disbandTargets) {
      // eslint-disable-next-line no-await-in-loop
      const delivered = await this.sendGroupDisband(groupId, targetPeerId, disbandTimestamp);
      if (delivered) sent++;
      else queued++;
    }

    database.transitionChatGroupStatus(chat.id, 'disbanded', 'creator_disband_local');
    database.updateChatStatus(chat.id, 'active');
    await this.appendDisbandSystemMessage(chat.id, groupId, disbandTimestamp);
    this.deps.onGroupMembersUpdated?.({
      chatId: chat.id,
      groupId,
      memberPeerId: myPeerId,
    });

    log(
      `[GROUP][TRACE][DISBAND][DONE] group=${groupId} targets=${disbandTargets.length} sent=${sent} queued=${queued}`,
    );
  }

  async handleInviteDeliveredAck(ack: GroupInviteDeliveredAck, senderPeerId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    log(
      `[GROUP][TRACE][DELIVERED_ACK][IN] group=${ack.groupId} inviteId=${ack.inviteId} ackId=${ack.ackId} from=${senderPeerId.slice(-8)}`,
    );

    const chat = database.getChatByGroupId(ack.groupId);
    if (!chat || chat.created_by !== myPeerId) {
      log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=not_creator`,
      );
      return;
    }

    const sender = database.getUserByPeerId(senderPeerId);
    if (!sender) {
      log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=unknown_sender`,
      );
      return;
    }
    this.verifySignature(ack, sender.signing_public_key);

    const pendingAcks = database.getPendingAcksForGroup(ack.groupId);
    const pendingInvite = pendingAcks.find(
      a => a.target_peer_id === senderPeerId && a.message_type === 'GROUP_INVITE',
    );
    if (!pendingInvite) {
      log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=no_pending_invite`,
      );
      return;
    }

    try {
      const storedInvite = JSON.parse(pendingInvite.message_payload) as GroupInvite;
      if (storedInvite.inviteId !== ack.inviteId) {
        log(
          `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=invite_id_mismatch pendingInviteId=${storedInvite.inviteId} incomingInviteId=${ack.inviteId}`,
        );
        return;
      }
      database.markInviteDeliveryAckReceived(ack.groupId, senderPeerId, ack.inviteId);
      log(
        `[GROUP][TRACE][DELIVERED_ACK][APPLY] group=${ack.groupId} from=${senderPeerId.slice(-8)} inviteId=${ack.inviteId}`,
      );
    } catch {
      log(
        `[GROUP][TRACE][DELIVERED_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=invalid_pending_invite_payload`,
      );
      return;
    }
  }

  async handleControlAck(ack: GroupControlAck, senderPeerId: string): Promise<void> {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(ack.groupId);
    if (!chat || chat.created_by !== myPeerId) return;

    // Verify sender is a known participant
    const sender = database.getUserByPeerId(senderPeerId);
    if (!sender) return;
    this.verifySignature(ack, sender.signing_public_key);
    log(
      `[GROUP][TRACE][CONTROL_ACK][IN] group=${ack.groupId} from=${senderPeerId.slice(-8)} ackType=${ack.ackedMessageType} ackedMsgId=${ack.ackedMessageId} ackId=${ack.ackId}`,
    );

    // Map the acked message type to the pending ack type
    const ackType = ack.ackedMessageType as AckMessageType;
    if (ackType === 'GROUP_WELCOME' || ackType === 'GROUP_STATE_UPDATE' || ackType === 'GROUP_KICK' || ackType === 'GROUP_DISBAND') {
      // Verify the ACK matches the currently pending message to prevent stale/duplicate ACKs
      // from clearing a newer pending entry for the same member+type.
      const pendingAcks = database.getPendingAcksForGroup(ack.groupId);
      const pending = pendingAcks.find(
        a => a.target_peer_id === senderPeerId && a.message_type === ackType,
      );
      if (!pending) {
        log(
          `[GROUP][TRACE][CONTROL_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=no_pending_for_type ackType=${ackType}`,
        );
        return;
      }

      try {
        const stored = JSON.parse(pending.message_payload) as { messageId?: string };
        if (stored.messageId !== ack.ackedMessageId) {
          log(
            `[GROUP][TRACE][CONTROL_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=message_id_mismatch pendingMsgId=${stored.messageId ?? 'missing'} ackedMsgId=${ack.ackedMessageId}`,
          );
          return;
        }
      } catch {
        log(
          `[GROUP][TRACE][CONTROL_ACK][DROP] group=${ack.groupId} from=${senderPeerId.slice(-8)} reason=invalid_pending_payload`,
        );
        return;
      }

      database.removePendingAck(ack.groupId, senderPeerId, ackType);
      log(
        `[GROUP][TRACE][CONTROL_ACK][APPLY] group=${ack.groupId} from=${senderPeerId.slice(-8)} ackType=${ackType}`,
      );
    }
  }

  private async sendInviteResponseAck(response: GroupInviteResponse): Promise<void> {
    const ack: Omit<GroupInviteResponseAck, 'signature'> = {
      type: GroupMessageType.GROUP_INVITE_RESPONSE_ACK,
      groupId: response.groupId,
      inviteId: response.inviteId,
      ackedMessageId: response.messageId,
      ackId: randomUUID(),
    };

    const signature = this.sign(ack);
    const signedAck: GroupInviteResponseAck = { ...ack, signature };

    log(
      `[GROUP][TRACE][RESP_ACK][SEND] group=${response.groupId} inviteId=${response.inviteId} to=${response.responderPeerId.slice(-8)} ackedMsgId=${response.messageId} ackId=${signedAck.ackId}`,
    );
    await this.sendControlMessageToPeer(response.responderPeerId, signedAck);
  }

  async sendGroupWelcome(groupId: string, acceptedPeerId: string, eventTimestamp: number): Promise<void> {
    const { database, userIdentity } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);
    if (chat.group_status === 'rekeying') throw new Error(`Group ${groupId} is already rekeying`);

    // Get accepted user's info for RSA encryption
    const acceptedUser = database.getUserByPeerId(acceptedPeerId);
    if (!acceptedUser) throw new Error(`User ${acceptedPeerId} not found`);

    const previousGroupStatus = (chat.group_status ?? 'active') as GroupStatus;
    let rotationCommitted = false;
    database.transitionChatGroupStatus(chat.id, 'rekeying', 'welcome_rotation_start');

    try {
      const preRotationParticipants = database.getChatParticipants(chat.id).map(p => p.peer_id);
      const prevVersion = chat.key_version ?? 0;
      const prevEpochBoundaries = prevVersion > 0
        ? await this.snapshotPrevEpochBoundaries(groupId, prevVersion, preRotationParticipants)
        : {};

      // Rotate key (join always triggers rotation)
      const { groupKey, keyVersion, groupInfoMetadataKey } = this.rotateGroupKey(groupId, acceptedPeerId, 'join');
      rotationCommitted = true;
      if (prevVersion >= 1) {
        this.deps.onRegisterPrevEpochGrace?.(groupId, prevVersion);
      }

      // Build roster (creator + all existing active members + new joiner)
      const participants = database.getChatParticipants(chat.id);
      const roster = this.buildRoster(participants.map(p => p.peer_id));

      // RSA-encrypt group key for the new joiner
      const recipientPubKeyPem = Buffer.from(acceptedUser.offline_public_key, 'base64').toString();
      const encryptedGroupKey = publicEncrypt(
        recipientPubKeyPem,
        Buffer.from(groupKey, 'base64'),
      ).toString('base64');
      const encryptedGroupInfoMetadataKey = publicEncrypt(
        recipientPubKeyPem,
        Buffer.from(groupInfoMetadataKey, 'base64'),
      ).toString('base64');

      log('[GROUP-INFO][META][DISTRIBUTE][WELCOME] group=' + groupId + ' to=' + acceptedPeerId.slice(-8) + ' keyVersion=' + String(keyVersion) + ' encryptedMetadataKeyBytes=' + String(Buffer.from(encryptedGroupInfoMetadataKey, 'base64').length));

      // Construct GroupWelcome
      const creatorPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
      const groupInfoLatestDhtKey = `${this.groupInfoLatestPrefix}/${groupId}/${creatorPubKeyBase64url}`;

      const welcome: Omit<GroupWelcome, 'signature'> = {
        type: GroupMessageType.GROUP_WELCOME,
        groupId,
        groupName: chat.name,
        keyVersion,
        encryptedGroupKey,
        encryptedGroupInfoMetadataKey,
        roster,
        groupInfoLatestDhtKey,
        messageId: randomUUID(),
      };

      const signature = this.sign(welcome);
      const signedWelcome: GroupWelcome = { ...welcome, signature };

      // Store in pending ACKs first, then send. If send fails, re-publisher can still deliver later.
      database.insertPendingAck(groupId, acceptedPeerId, 'GROUP_WELCOME', JSON.stringify(signedWelcome));
      log(
        `[GROUP][TRACE][WELCOME][CREATE] group=${groupId} to=${acceptedPeerId.slice(-8)} msgId=${signedWelcome.messageId} keyVersion=${keyVersion}`,
      );

      // Deliver to new member via pairwise offline bucket (best effort, pending ACK persists retries).
      try {
        await this.sendControlMessageToPeer(acceptedPeerId, signedWelcome);
        log(
          `[GROUP][TRACE][WELCOME][SENT] group=${groupId} to=${acceptedPeerId.slice(-8)} msgId=${signedWelcome.messageId}`,
        );
      } catch (error: unknown) {
        console.warn(
          `[GROUP][TRACE][WELCOME][QUEUE_RETRY] group=${groupId} to=${acceptedPeerId.slice(-8)} reason=${errStr(error)}`,
        );
      }

      // Send GroupStateUpdate to all existing members (excluding new joiner — they get welcome).
      await this.sendGroupStateUpdate(
        groupId,
        keyVersion,
        groupKey,
        groupInfoMetadataKey,
        roster,
        'join',
        acceptedPeerId,
        eventTimestamp,
      );

      // Transition group_status to 'active' now that rotation pipeline has completed.
      database.transitionChatGroupStatus(chat.id, 'active', 'welcome_rotation_done');
      await this.appendMembershipSystemMessage(
        chat.id,
        groupId,
        keyVersion,
        'join',
        acceptedPeerId,
        acceptedUser.username,
        eventTimestamp,
      );
      log(
        `[GROUP][TRACE][WELCOME][DONE] group=${groupId} activated=true welcomedPeer=${acceptedPeerId.slice(-8)} keyVersion=${keyVersion}`,
      );
      this.deps.onGroupMembersUpdated?.({
        chatId: chat.id,
        groupId,
        memberPeerId: acceptedPeerId,
      });
      // Publish group-info DHT records in background (best effort). Do not block activation.
      void this.publishGroupInfoRecords(groupId, keyVersion, roster, groupInfoMetadataKey, prevEpochBoundaries)
        .catch((error: unknown) => {
          console.warn(
            `[GROUP][TRACE][WELCOME][GROUP_INFO_RETRY_NEEDED] group=${groupId} keyVersion=${keyVersion} reason=${errStr(error)}`,
          );
        });
    } catch (error: unknown) {
      if (rotationCommitted) {
        // Rotation already changed keyVersion/participants locally; don't roll status back to a pre-rotation value.
        // Keep group active and rely persisted pending ACKs / retries for eventual delivery.
        database.transitionChatGroupStatus(chat.id, 'active', 'welcome_partial_failure_keep_active');
        console.warn(
          `[GROUP][TRACE][WELCOME][PARTIAL_FAILURE] group=${groupId} welcomedPeer=${acceptedPeerId.slice(-8)} status=active reason=${errStr(error)}`,
        );
        return;
      }

      database.transitionChatGroupStatus(chat.id, previousGroupStatus, 'welcome_rotation_rollback');
      throw error;
    }
  }

  rotateGroupKey(
    groupId: string,
    targetPeerId: string,
    event: 'join' | 'leave' | 'kick',
  ): { groupKey: string; keyVersion: number; groupInfoMetadataKey: string } {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);

    // Generate new key
    const keyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(keyBytes);
    const groupKey = Buffer.from(keyBytes).toString('base64');
    const metadataKeyBytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(metadataKeyBytes);
    const groupInfoMetadataKey = Buffer.from(metadataKeyBytes).toString('base64');

    const keyVersion = (chat.key_version ?? 0) + 1;

    // Update roster based on event
    const participants = database.getChatParticipants(chat.id);
    let newParticipantPeerIds = participants.map(p => p.peer_id);

    if (event === 'join') {
      if (!newParticipantPeerIds.includes(targetPeerId)) {
        newParticipantPeerIds.push(targetPeerId);
      }
    } else {
      // leave or kick — remove target
      newParticipantPeerIds = newParticipantPeerIds.filter(id => id !== targetPeerId);
    }

    // Update chat participants
    database.updateGroupPermanentKey(chat.id, groupKey, newParticipantPeerIds, myPeerId);
    database.updateChatKeyVersion(chat.id, keyVersion);

    // Store key in history
    database.insertGroupKeyHistory(groupId, keyVersion, groupKey, groupInfoMetadataKey);

    log('[GROUP-INFO][META][ROTATE] group=' + groupId + ' event=' + event + ' keyVersion=' + String(keyVersion) + ' metadataKeyBytes=' + String(metadataKeyBytes.length));

    return { groupKey, keyVersion, groupInfoMetadataKey };
  }

  async republishPendingControl(targetPeerId: string, payloadJson: string): Promise<void> {
    let parsed: object;
    try {
      parsed = JSON.parse(payloadJson) as object;
    } catch {
      throw new Error(`Invalid pending ACK payload for ${targetPeerId}`);
    }
    log(
      `[GROUP][TRACE][REPUBLISH][CREATOR] target=${targetPeerId.slice(-8)} ${this.describeControlMessage(parsed)}`,
    );
    await this.sendControlMessageToPeer(targetPeerId, parsed);
  }

  async resendCurrentStateToPeer(groupId: string, targetPeerId: string, reason: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    const chat = database.getChatByGroupId(groupId);
    if (!chat) {
      throw new Error(`Group ${groupId} not found`);
    }
    if (chat.group_creator_peer_id !== myPeerId) {
      throw new Error(`Not group creator for ${groupId}`);
    }
    if ((chat.key_version ?? 0) <= 0) {
      throw new Error(`Group ${groupId} has no active key version`);
    }

    const participants = database.getChatParticipants(chat.id);
    const participantIds = participants.map((participant) => participant.peer_id);
    if (!participantIds.includes(targetPeerId)) {
      log(
        `[GROUP][TRACE][STATE_RESYNC][SKIP] group=${groupId} peer=${targetPeerId.slice(-8)} reason=not_participant`,
      );
      return;
    }

    const keyVersion = chat.key_version!;
    const groupKey = database.getGroupKeyForEpoch(groupId, keyVersion);
    if (!groupKey) {
      throw new Error(`Missing group key for ${groupId} v${keyVersion}`);
    }

    const roster = this.buildRoster(participantIds);
    const user = database.getUserByPeerId(targetPeerId);
    if (!user) {
      throw new Error(`User ${targetPeerId} not found`);
    }

    const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
    const encryptedGroupKey = publicEncrypt(
      recipientPubKeyPem,
      Buffer.from(groupKey, 'base64'),
    ).toString('base64');
    const groupInfoMetadataKey = database.getGroupInfoMetadataKeyForEpoch(groupId, keyVersion);
    if (!groupInfoMetadataKey) {
      throw new Error(`Missing group info metadata key for ${groupId} v${keyVersion}`);
    }
    const encryptedGroupInfoMetadataKey = publicEncrypt(
      recipientPubKeyPem,
      Buffer.from(groupInfoMetadataKey, 'base64'),
    ).toString('base64');

    log('[GROUP-INFO][META][DISTRIBUTE][RESYNC] group=' + groupId + ' to=' + targetPeerId.slice(-8) + ' keyVersion=' + String(keyVersion) + ' encryptedMetadataKeyBytes=' + String(Buffer.from(encryptedGroupInfoMetadataKey, 'base64').length));

    const update: Omit<GroupStateUpdate, 'signature'> = {
      type: GroupMessageType.GROUP_STATE_UPDATE,
      groupId,
      keyVersion,
      timestamp: Date.now(),
      encryptedGroupKey,
      encryptedGroupInfoMetadataKey,
      roster,
      // Event is intentionally informational when isResync=true; responder skips membership system text.
      event: 'join',
      targetPeerId,
      isResync: true,
      messageId: randomUUID(),
    };

    const signature = this.sign(update);
    const signedUpdate: GroupStateUpdate = { ...update, signature };

    const existingStateUpdatePending = database
      .getPendingAcksForGroup(groupId)
      .find(
        pending => pending.target_peer_id === targetPeerId && pending.message_type === 'GROUP_STATE_UPDATE',
      );
    if (!existingStateUpdatePending) {
      database.insertPendingAck(groupId, targetPeerId, 'GROUP_STATE_UPDATE', JSON.stringify(signedUpdate));
    }
    try {
      await this.sendControlMessageToPeer(targetPeerId, signedUpdate);
      log(
        `[GROUP][TRACE][STATE_RESYNC][SEND] group=${groupId} peer=${targetPeerId.slice(-8)} keyVersion=${keyVersion} reason=${reason}`,
      );
    } catch (error: unknown) {
      console.warn(
        `[GROUP][TRACE][STATE_RESYNC][QUEUE_RETRY] group=${groupId} peer=${targetPeerId.slice(-8)} keyVersion=${keyVersion} reason=${reason} error=${errStr(error)}`,
      );
      throw error;
    }
  }

  private async sendGroupStateUpdate(
    groupId: string,
    keyVersion: number,
    groupKey: string,
    groupInfoMetadataKey: string,
    roster: GroupRosterEntry[],
    event: 'join' | 'leave' | 'kick',
    targetPeerId: string,
    eventTimestamp: number,
  ): Promise<void> {
    const { database, myPeerId } = this.deps;

    const chat = database.getChatByGroupId(groupId);
    if (!chat) return;

    const participants = database.getChatParticipants(chat.id);

    const recipients = participants.filter(
      (participant) => participant.peer_id !== myPeerId && participant.peer_id !== targetPeerId,
    );
    let attempted = 0;
    let sent = 0;
    let failed = 0;
    let skippedMissingUser = 0;

    await this.mapWithConcurrency(
      recipients,
      GROUP_ROTATION_IO_CONCURRENCY,
      async (participant) => {
        attempted++;
        const user = database.getUserByPeerId(participant.peer_id);
        if (!user) {
          skippedMissingUser++;
          return;
        }

        // RSA-encrypt the new group key for this member
        const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
        const encryptedGroupKey = publicEncrypt(
          recipientPubKeyPem,
          Buffer.from(groupKey, 'base64'),
        ).toString('base64');
        const encryptedGroupInfoMetadataKey = publicEncrypt(
          recipientPubKeyPem,
          Buffer.from(groupInfoMetadataKey, 'base64'),
        ).toString('base64');

        log('[GROUP-INFO][META][DISTRIBUTE][STATE_UPDATE] group=' + groupId + ' event=' + event + ' to=' + participant.peer_id.slice(-8) + ' keyVersion=' + String(keyVersion) + ' encryptedMetadataKeyBytes=' + String(Buffer.from(encryptedGroupInfoMetadataKey, 'base64').length));

        const update: Omit<GroupStateUpdate, 'signature'> = {
          type: GroupMessageType.GROUP_STATE_UPDATE,
          groupId,
          keyVersion,
          timestamp: eventTimestamp,
          encryptedGroupKey,
          encryptedGroupInfoMetadataKey,
          roster,
          event,
          targetPeerId,
          messageId: randomUUID(),
        };

        const signature = this.sign(update);
        const signedUpdate: GroupStateUpdate = { ...update, signature };

        // Store in pending ACKs first, then send (best effort).
        database.insertPendingAck(groupId, participant.peer_id, 'GROUP_STATE_UPDATE', JSON.stringify(signedUpdate));
        try {
          await this.sendControlMessageToPeer(participant.peer_id, signedUpdate);
          sent++;
        } catch (error: unknown) {
          failed++;
          console.warn(
            `[GROUP][TRACE][STATE_UPDATE][QUEUE_RETRY] group=${groupId} to=${participant.peer_id.slice(-8)} reason=${errStr(error)}`,
          );
        }
      },
    );

    log(
      `[GROUP][TRACE][STATE_UPDATE][SUMMARY] group=${groupId} keyVersion=${keyVersion} ` +
      `attempted=${attempted} sent=${sent} failed=${failed} skippedMissingUser=${skippedMissingUser}`,
    );
  }

  private async sendGroupKick(
    groupId: string,
    targetPeerId: string,
    keyVersion: number,
    eventTimestamp: number,
  ): Promise<void> {
    const kick: Omit<GroupKick, 'signature'> = {
      type: GroupMessageType.GROUP_KICK,
      groupId,
      keyVersion,
      kickedPeerId: targetPeerId,
      messageId: randomUUID(),
      timestamp: eventTimestamp,
    };

    const signature = this.sign(kick);
    const signedKick: GroupKick = { ...kick, signature };
    this.deps.database.insertPendingAck(groupId, targetPeerId, 'GROUP_KICK', JSON.stringify(signedKick));
    await this.sendControlMessageToPeer(targetPeerId, signedKick);
    log(
      `[GROUP][TRACE][KICK][SEND] group=${groupId} to=${targetPeerId.slice(-8)} msgId=${signedKick.messageId} keyVersion=${keyVersion}`,
    );
  }

  private async sendGroupDisband(
    groupId: string,
    targetPeerId: string,
    disbandTimestamp: number,
  ): Promise<boolean> {
    const user = this.deps.database.getUserByPeerId(targetPeerId);
    if (!user) {
      console.warn(
        `[GROUP][TRACE][DISBAND][SKIP_UNKNOWN_USER] group=${groupId} to=${targetPeerId.slice(-8)}`,
      );
      return false;
    }

    const disband: Omit<GroupDisband, 'signature'> = {
      type: GroupMessageType.GROUP_DISBAND,
      groupId,
      creatorPeerId: this.deps.myPeerId,
      messageId: randomUUID(),
      timestamp: disbandTimestamp,
    };
    const signedDisband: GroupDisband = {
      ...disband,
      signature: this.sign(disband),
    };
    this.deps.database.insertPendingAck(groupId, targetPeerId, 'GROUP_DISBAND', JSON.stringify(signedDisband));

    try {
      await this.sendControlMessageToPeer(targetPeerId, signedDisband);
      return true;
    } catch (error: unknown) {
      console.warn(
        `[GROUP][TRACE][DISBAND][QUEUE_RETRY] group=${groupId} to=${targetPeerId.slice(-8)} reason=${errStr(error)}`,
      );
      return false;
    }
  }

  private async publishGroupInfoRecords(
    groupId: string,
    keyVersion: number,
    roster: GroupRosterEntry[],
    groupInfoMetadataKey: string,
    prevEpochBoundaries: Record<string, number>
  ): Promise<void> {
    const { database, userIdentity } = this.deps;
    const creatorPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);

    // Build versioned record
    const members = roster.map(r => r.peerId);
    // Get previous version's stateHash for hash chain
    const prevVersion = keyVersion - 1;
    let prevVersionHash = '';
    if (prevVersion >= 1) {
      const storedHash = database.getGroupKeyStateHash(groupId, prevVersion);
      if (storedHash) {
        prevVersionHash = storedHash;
      }
    }

    // Collect per-sender seq boundaries from previous key version
    // Includes observed seqs from all members (tracked on message receipt) + our own sending seq
    const senderSeqBoundaries: Record<string, number> = {};
    if (prevVersion >= 1) {
      for (const [peerId, seq] of Object.entries(prevEpochBoundaries)) {
        if (Number.isFinite(seq) && seq >= 0) {
          senderSeqBoundaries[peerId] = seq;
        }
      }
    }

    // Persist finalized boundaries for previous epoch locally.
    // Creator DB is authoritative for its own rotations; DHT is for distribution.
    if (prevVersion >= 1 && Object.keys(senderSeqBoundaries).length > 0) {
      database.upsertGroupEpochBoundaries(groupId, prevVersion, senderSeqBoundaries, 'creator_rotation');
    }

    const encryptedMetadata = this.encryptGroupInfoVersionedMetadata(
      {
        members,
        senderSeqBoundaries,
      },
      groupInfoMetadataKey,
    );
    log('[GROUP-INFO][META][PUBLISH_PREP] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' metadataCipherBytes=' + String(Buffer.from(encryptedMetadata.ciphertext, 'base64').length) + ' metadataNonceBytes=' + String(Buffer.from(encryptedMetadata.nonce, 'base64').length));
    const versionedPayload: Omit<GroupInfoVersioned, 'creatorSignature' | 'stateHash'> = {
      groupId,
      version: keyVersion,
      prevVersionHash,
      encryptedMetadata: encryptedMetadata.ciphertext,
      encryptedMetadataNonce: encryptedMetadata.nonce,
      activatedAt: Date.now(),
    };

    const stateHash = Buffer.from(
      sha256(new TextEncoder().encode(JSON.stringify(versionedPayload)))
    ).toString('base64');

    const versionedRecord: Omit<GroupInfoVersioned, 'creatorSignature'> = {
      ...versionedPayload,
      stateHash,
    };

    const versionedSignature = this.sign(versionedRecord);
    const signedVersioned: GroupInfoVersioned = { ...versionedRecord, creatorSignature: versionedSignature };

    // Publish versioned record
    const versionedDhtKey = `${this.groupInfoVersionPrefix}/${groupId}/${creatorPubKeyBase64url}/${keyVersion}`;

    // Publish latest pointer
    const latestPayload: Omit<GroupInfoLatest, 'creatorSignature'> = {
      groupId,
      latestVersion: keyVersion,
      latestStateHash: stateHash,
      lastUpdated: Date.now(),
    };

    const latestSignature = this.sign(latestPayload);
    const signedLatest: GroupInfoLatest = { ...latestPayload, creatorSignature: latestSignature };

    const latestDhtKey = `${this.groupInfoLatestPrefix}/${groupId}/${creatorPubKeyBase64url}`;
    const startedAt = Date.now();
    log(
      `[GROUP-INFO][PUBLISH][START] group=${groupId} keyVersion=${keyVersion} ` +
      `members=${members.length} boundaries=${Object.keys(senderSeqBoundaries).length}`
    );
    try {
      const versionedStart = Date.now();
      await putJsonToDHT(this.deps.node, versionedDhtKey, signedVersioned, { warnOnQueryError: true, warnPrefix: 'GROUP' });
      log(
        `[GROUP-INFO][PUBLISH][VERSIONED_OK] group=${groupId} keyVersion=${keyVersion} took=${Date.now() - versionedStart}ms`
      );

      const latestStart = Date.now();
      await putJsonToDHT(this.deps.node, latestDhtKey, signedLatest, { warnOnQueryError: true, warnPrefix: 'GROUP' });
      log(
        `[GROUP-INFO][PUBLISH][LATEST_OK] group=${groupId} keyVersion=${keyVersion} took=${Date.now() - latestStart}ms`
      );
    } catch (error: unknown) {
      const reason = errStr(error);
      try {
        database.upsertPendingGroupInfoPublish(
          groupId,
          keyVersion,
          versionedDhtKey,
          JSON.stringify(signedVersioned),
          latestDhtKey,
          JSON.stringify(signedLatest),
          Date.now() + GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY,
          reason,
        );
        console.warn(
          `[GROUP-INFO][PUBLISH][QUEUED_RETRY] group=${groupId} keyVersion=${keyVersion} reason=${reason}`
        );
      } catch (queueError: unknown) {
        const queueReason = errStr(queueError);
        console.error(
          `[GROUP-INFO][PUBLISH][QUEUE_RETRY_FAILED] group=${groupId} keyVersion=${keyVersion} ` +
          `publishReason=${reason} queueReason=${queueReason}`
        );
      }
      console.warn(
        `[GROUP-INFO][PUBLISH][FAIL] group=${groupId} keyVersion=${keyVersion} reason=${reason} took=${Date.now() - startedAt}ms`
      );
      throw error;
    }

    // Store stateHash locally for hash chain continuity
    database.updateGroupKeyStateHash(groupId, keyVersion, stateHash);

    // Mark previous version as superseded
    if (prevVersion >= 1) {
      database.markGroupKeyUsedUntil(groupId, prevVersion, Date.now());
    }

    database.removePendingGroupInfoPublish(groupId, keyVersion);
    log(
      `[GROUP-INFO][PUBLISH][DONE] group=${groupId} keyVersion=${keyVersion} took=${Date.now() - startedAt}ms`
    );
  }

  private encryptGroupInfoVersionedMetadata(
    metadata: GroupInfoVersionedMetadata,
    groupInfoMetadataKeyBase64: string,
  ): { ciphertext: string; nonce: string } {
    const key = Buffer.from(groupInfoMetadataKeyBase64, 'base64');
    if (key.length !== 32) {
      throw new Error('Invalid group info metadata key length');
    }
    const nonce = randomBytes(24);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(metadata));
    const cipher = xchacha20poly1305(key, nonce);
    const encrypted = cipher.encrypt(payloadBytes);
    return {
      ciphertext: Buffer.from(encrypted).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    };
  }

  private async snapshotPrevEpochBoundaries(
    groupId: string,
    prevVersion: number,
    participantPeerIds: string[],
  ): Promise<Record<string, number>> {
    const { database, myPeerId } = this.deps;
    const boundaries: Record<string, number> = {};
    const uniqueParticipants = [...new Set(participantPeerIds)];

    // Start with explicit 0 boundaries for all known members of previous epoch.
    // This makes boundary maps complete and prevents over-broad sender inference later.
    for (const peerId of uniqueParticipants) {
      boundaries[peerId] = 0;
    }
    if (boundaries[myPeerId] === undefined) {
      boundaries[myPeerId] = 0;
    }

    const observed = database.getAllMemberSeqs(groupId, prevVersion);
    for (const [peerId, seq] of Object.entries(observed)) {
      if (seq > 0) {
        boundaries[peerId] = Math.max(boundaries[peerId] ?? 0, seq);
      }
    }

    const mySeq = database.getCurrentSeq(groupId, prevVersion);
    if (mySeq > 0) {
      boundaries[myPeerId] = Math.max(boundaries[myPeerId] ?? 0, mySeq);
    }
    const dhtTargets = uniqueParticipants.filter((peerId) => peerId !== myPeerId);

    await this.mapWithConcurrency(
      dhtTargets,
      GROUP_ROTATION_IO_CONCURRENCY,
      async (peerId) => {
        try {
          const dhtHighest = await this.fetchHighestSeqFromSenderBucket(groupId, prevVersion, peerId);
          if (dhtHighest > 0) {
            boundaries[peerId] = Math.max(boundaries[peerId] ?? 0, dhtHighest);
          }
        } catch (error: unknown) {
          console.warn(
            `[GROUP][TRACE][ROTATE][BOUNDARY_DHT_READ_FAIL] group=${groupId} peer=${peerId.slice(-8)} keyVersion=${prevVersion} reason=${errStr(error)}`,
          );
        }
      },
    );

    log(
      `[GROUP][TRACE][ROTATE][BOUNDARIES] group=${groupId} prevVersion=${prevVersion} peers=${Object.keys(boundaries).length}`,
    );
    return boundaries;
  }

  private async fetchHighestSeqFromSenderBucket(
    groupId: string,
    keyVersion: number,
    senderPeerId: string,
  ): Promise<number> {
    const { database, node } = this.deps;
    const sender = database.getUserByPeerId(senderPeerId);
    if (!sender) return 0;

    const senderPubKeyBase64url = toBase64Url(Buffer.from(sender.signing_public_key, 'base64'));
    const bucketKey = `${this.groupOfflineBucketPrefix}/${groupId}/${keyVersion}/${senderPubKeyBase64url}`;
    const keyBytes = new TextEncoder().encode(bucketKey);

    let best: GroupOfflineStore | null = null;

    for await (const event of node.services.dht.get(keyBytes) as AsyncIterable<QueryEvent>) {
      if (event.name !== 'VALUE' || event.value.length === 0) continue;
      let parsed: GroupOfflineStore;
      try {
        const decompressed = gunzipSync(Buffer.from(event.value), { maxOutputLength: GROUP_OFFLINE_STORE_MAX_DECOMPRESSED_BYTES });
        parsed = JSON.parse(decompressed.toString('utf8')) as GroupOfflineStore;
      } catch {
        continue;
      }

      if (!this.verifyGroupOfflineStoreSignature(parsed, sender.signing_public_key, bucketKey)) {
        console.warn(
          `[GROUP][TRACE][ROTATE][BOUNDARY_DHT_VALUE_DROP] group=${groupId} peer=${senderPeerId.slice(-8)} keyVersion=${keyVersion} reason=signature_verification_failed`,
        );
        continue;
      }

      if (
        !best
        || parsed.version > best.version
        || (parsed.version === best.version && parsed.lastUpdated > best.lastUpdated)
      ) {
        best = parsed;
      }
    }

    if (!best) return 0;
    const maxSeqInMessages = best.messages.length > 0
      ? Math.max(...best.messages.map((m) => m.seq))
      : 0;
    return Math.max(best.highestSeq, maxSeqInMessages);
  }

  // --- Helpers ---

  private buildRoster(peerIds: string[]): GroupRosterEntry[] {
    const { database } = this.deps;
    const roster: GroupRosterEntry[] = [];

    for (const peerId of peerIds) {
      const user = database.getUserByPeerId(peerId);
      if (!user) continue;
      roster.push({
        peerId: user.peer_id,
        username: user.username,
        signingPubKey: user.signing_public_key,
        offlinePubKey: user.offline_public_key,
      });
    }

    return roster;
  }

  private sign(payload: object): string {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signatureBytes = ed25519.sign(payloadBytes, this.deps.userIdentity.signingPrivateKey);
    return Buffer.from(signatureBytes).toString('base64');
  }

  private verifySignature(message: object & { signature: string }, signingPubKeyBase64: string): void {
    const { signature, ...payload } = message as Record<string, unknown>;
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const sigBytes = Buffer.from(signature as string, 'base64');
    const pubKeyBytes = Buffer.from(signingPubKeyBase64, 'base64');

    if (!ed25519.verify(sigBytes, payloadBytes, pubKeyBytes)) {
      throw new Error('Signature verification failed');
    }
  }

  private verifyGroupOfflineStoreSignature(
    store: GroupOfflineStore,
    signingPubKeyBase64: string,
    expectedBucketKey: string,
  ): boolean {
    try {
      if (!store || typeof store !== 'object') return false;
      if (!Array.isArray(store.messages)) return false;
      if (typeof store.storeSignature !== 'string' || !store.storeSignature) return false;
      if (!store.storeSignedPayload || typeof store.storeSignedPayload !== 'object') return false;

      const payload = store.storeSignedPayload;
      if (!Array.isArray(payload.messageIds)) return false;
      if (!Number.isFinite(payload.highestSeq) || payload.highestSeq < 0) return false;
      if (!Number.isFinite(payload.version) || payload.version < 0) return false;
      if (!Number.isFinite(payload.timestamp) || payload.timestamp <= 0) return false;
      if (typeof payload.bucketKey !== 'string' || payload.bucketKey !== expectedBucketKey) return false;

      if (!Number.isFinite(store.highestSeq) || store.highestSeq < 0) return false;
      if (!Number.isFinite(store.version) || store.version < 0) return false;
      if (!Number.isFinite(store.lastUpdated) || store.lastUpdated <= 0) return false;

      if (payload.highestSeq !== store.highestSeq) return false;
      if (payload.version !== store.version) return false;
      if (payload.timestamp !== store.lastUpdated) return false;

      const messageIds = store.messages.map((message) => message.messageId);
      if (messageIds.length !== payload.messageIds.length) return false;
      for (let index = 0; index < messageIds.length; index++) {
        if (messageIds[index] !== payload.messageIds[index]) return false;
      }

      for (const message of store.messages) {
        if (!Number.isFinite(message.seq) || message.seq < 0) return false;
      }

      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const signatureBytes = Buffer.from(store.storeSignature, 'base64');
      const pubKeyBytes = Buffer.from(signingPubKeyBase64, 'base64');
      return ed25519.verify(signatureBytes, payloadBytes, pubKeyBytes);
    } catch {
      return false;
    }
  }

  private async sendControlMessageToPeer(peerId: string, message: object): Promise<void> {
    const { node, database, userIdentity, myPeerId, myUsername } = this.deps;

    const user = database.getUserByPeerId(peerId);
    if (!user) throw new Error(`User ${peerId} not found`);

    // Get the pairwise offline bucket for this peer
    const bucketSecret = database.getOfflineBucketSecretByPeerId(peerId);
    if (!bucketSecret) {
      throw new Error(`No offline bucket secret for peer ${peerId}`);
    }

    const ourPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    const writeBucketKey = `${this.directOfflineBucketPrefix}/${bucketSecret}/${ourPubKeyBase64url}`;
    const bucketTag = writeBucketKey.slice(-12);

    // Wrap the group control message as an offline message
    const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
    const lastReadTimestamp = database.getOfflineLastReadTimestampByPeerId(peerId);
    const lastAckSent = database.getOfflineLastAckSentByPeerId(peerId);
    const shouldSendAck = lastReadTimestamp > lastAckSent;
    log(
      `[GROUP][TRACE][SEND] to=${user.username} bucket=*${bucketTag} shouldAck=${shouldSendAck} ackTs=${shouldSendAck ? lastReadTimestamp : 0} ${this.describeControlMessage(message)}`,
    );

    const offlineMessage = OfflineMessageManager.createOfflineMessage(
      myPeerId,
      myUsername,
      JSON.stringify(message),
      recipientPubKeyPem,
      userIdentity.signingPrivateKey,
      writeBucketKey,
      shouldSendAck ? lastReadTimestamp : undefined,
    );

    await OfflineMessageManager.storeOfflineMessage(
      node,
      writeBucketKey,
      offlineMessage,
      userIdentity.signingPrivateKey,
      database,
      { bypassControlReserve: true, category: 'control' },
    );
    log(
      `[GROUP][TRACE][SEND][DHT_OK] to=${peerId.slice(-8)} bucket=*${bucketTag} offlineMsgId=${offlineMessage.id} ${this.describeControlMessage(message)}`,
    );

    const directChat = database.getChatByPeerId(peerId);
    if (directChat) {
      this.deps.onOfflineInboxCapacityChanged?.(directChat.id);
    }

    if (shouldSendAck) {
      database.updateOfflineLastAckSentByPeerId(peerId, lastReadTimestamp);
    }

    // DHT write succeeded — best-effort nudge so an online recipient checks their bucket immediately
    nudgeGroupRefetchIfKnownGroup(this.deps, peerId, message);
  }

  private describeControlMessage(message: object): string {
    const m = message as Record<string, unknown>;
    const type = typeof m.type === 'string' ? m.type : 'unknown';
    const groupId = typeof m.groupId === 'string' ? m.groupId : 'n/a';
    const inviteId = typeof m.inviteId === 'string' ? m.inviteId : 'n/a';
    const messageId = typeof m.messageId === 'string' ? m.messageId : 'n/a';
    const ackedMessageId = typeof m.ackedMessageId === 'string' ? m.ackedMessageId : 'n/a';
    const ackId = typeof m.ackId === 'string' ? m.ackId : 'n/a';
    return `type=${type} group=${groupId} inviteId=${inviteId} msgId=${messageId} ackedMsgId=${ackedMessageId} ackId=${ackId}`;
  }

  private async appendMembershipSystemMessage(
    chatId: number,
    groupId: string,
    keyVersion: number,
    event: 'join' | 'leave' | 'kick',
    targetPeerId: string,
    targetUsername: string | undefined,
    eventTimestamp: number,
  ): Promise<void> {
    const messageId = `group-system-${event}-${groupId}-${keyVersion}-${targetPeerId}`;
    if (this.deps.database.messageExists(messageId)) return;

    const resolvedUsername = targetUsername
      ?? this.deps.database.getUserByPeerId(targetPeerId)?.username
      ?? targetPeerId.slice(-8);
    const content = event === 'join'
      ? `${resolvedUsername} joined the group`
      : event === 'leave'
        ? `${resolvedUsername} left the group`
        : `${resolvedUsername} was removed from the group`;
    const appliedTimestamp = Date.now();

    await this.deps.database.createMessage({
      id: messageId,
      chat_id: chatId,
      sender_peer_id: this.deps.myPeerId,
      content,
      message_type: 'system',
      timestamp: new Date(appliedTimestamp),
      event_timestamp: new Date(eventTimestamp),
    });

    this.deps.onMessageReceived?.({
      chatId,
      messageId,
      content,
      senderPeerId: this.deps.myPeerId,
      senderUsername: this.deps.myUsername,
      timestamp: appliedTimestamp,
      eventTimestamp,
      messageSentStatus: 'online',
      messageType: 'system',
    });
  }

  private async appendDisbandSystemMessage(
    chatId: number,
    groupId: string,
    eventTimestamp: number,
  ): Promise<void> {
    const messageId = `group-system-disband-${groupId}`;
    if (this.deps.database.messageExists(messageId)) return;

    const content = 'You disbanded this group.';
    const appliedTimestamp = Date.now();
    await this.deps.database.createMessage({
      id: messageId,
      chat_id: chatId,
      sender_peer_id: this.deps.myPeerId,
      content,
      message_type: 'system',
      timestamp: new Date(appliedTimestamp),
      event_timestamp: new Date(eventTimestamp),
    });

    this.deps.onMessageReceived?.({
      chatId,
      messageId,
      content,
      senderPeerId: this.deps.myPeerId,
      senderUsername: this.deps.myUsername,
      timestamp: appliedTimestamp,
      eventTimestamp,
      messageSentStatus: 'online',
      messageType: 'system',
    });
  }

  private async mapWithConcurrency<T>(
    items: T[],
    maxConcurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return;
    const limit = Math.max(1, maxConcurrency);
    let cursor = 0;

    const runWorker = async () => {
      while (true) {
        const index = cursor;
        if (index >= items.length) return;
        cursor += 1;
        const item = items[index];
        if (item === undefined) {
          return;
        }
        await worker(item, index);
      }
    };

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
    await Promise.all(workers);
  }
}
