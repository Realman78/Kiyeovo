import { randomUUID, privateDecrypt } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import type { QueryEvent } from '@libp2p/kad-dht';
import type { ChatNode, GroupChatActivatedEvent, GroupMembersUpdatedEvent, MessageReceivedEvent } from '../../types.js';
import type { ChatDatabase } from '../../db/database.js';
import type { EncryptedUserIdentity } from '../../identity/encrypted-user-identity.js';
import { OfflineMessageManager } from '../../direct/offline-message-manager.js';
import { toBase64Url } from '../../utils/miscellaneous.js';
import { GROUP_MESSAGE_MAX_FUTURE_SKEW_MS, getNetworkModeRuntime } from '../../constants.js';
import {
  GroupMessageType,
  type GroupInvite,
  type GroupInviteDeliveredAck,
  type GroupInviteResponse,
  type GroupInviteResponseAck,
  type GroupWelcome,
  type GroupStateUpdate,
  type GroupLeaveRequest,
  type GroupKick,
  type GroupDisband,
  type GroupStateResyncRequest,
  type GroupControlAck,
  type GroupInfoLatest,
  type GroupInfoVersioned,
  type GroupStatus,
} from '../types.js';
import { nudgeGroupRefetchIfKnownGroup } from '../dht/group-refetch-nudge.js';
import { log } from '../../../shared/logger.js';

const TERMINAL_STATES = ["removed", "left", "invite_expired", "disbanded"]

export interface GroupResponderDeps {
  node: ChatNode;
  database: ChatDatabase;
  userIdentity: EncryptedUserIdentity;
  myPeerId: string;
  myUsername: string;
  onGroupChatActivated?: (data: GroupChatActivatedEvent) => void;
  onGroupMembersUpdated?: (data: GroupMembersUpdatedEvent) => void;
  onMessageReceived?: (data: MessageReceivedEvent) => void;
  nudgeGroupRefetch?: (peerId: string, groupId: string) => void;
}

export class GroupResponder {
  private deps: GroupResponderDeps;
  private readonly directOfflineBucketPrefix: string;
  private readonly groupOfflineBucketPrefix: string;
  private readonly groupInfoLatestPrefix: string;
  private readonly groupInfoVersionPrefix: string;

  constructor(deps: GroupResponderDeps) {
    this.deps = deps;
    const runtime = getNetworkModeRuntime(this.deps.database.getSessionNetworkMode());
    this.directOfflineBucketPrefix = runtime.config.dhtNamespaces.offline;
    this.groupOfflineBucketPrefix = runtime.config.dhtNamespaces.groupOffline;
    this.groupInfoLatestPrefix = runtime.config.dhtNamespaces.groupInfoLatest;
    this.groupInfoVersionPrefix = runtime.config.dhtNamespaces.groupInfoVersion;
  }

  async handleGroupInvite(invite: GroupInvite): Promise<void> {
    const { database } = this.deps;
    const {groupId, inviterPeerId, expiresAt} = invite;
    log(`[GROUP][INVITE][IN] group=${groupId} from=${inviterPeerId.slice(-8)} expiresAt=${expiresAt}`);

    // Check blocked
    if (database.isBlocked(invite.inviterPeerId)) {
      log(`[GROUP][INVITE][DROP] group=${groupId} reason=blocked from=${inviterPeerId.slice(-8)}`);
      return;
    }

    // Verify inviter is a known contact
    const inviter = database.getUserByPeerId(inviterPeerId);
    if (!inviter) {
      log(`[GROUP][INVITE][DROP] group=${groupId} reason=unknown_sender from=${inviterPeerId.slice(-8)}`);
      return;
    }

    // Verify signature
    this.verifySignature(invite, inviter.signing_public_key);

    // Check expiry
    if (Date.now() > expiresAt) {
      log(
        `[GROUP][INVITE][DROP] group=${groupId} reason=expired now=${Date.now()} expiresAt=${expiresAt}`,
      );
      return;
    }

    const existing = database.getChatByGroupId(groupId);
    if (existing) {
      // `left` normally deletes the chat row, but just in case
      const canReactivate =
        existing.group_status === 'removed'
        || existing.group_status === 'left'
        || existing.group_status === 'invite_expired';

      if (canReactivate) this.createInviteNotificationIfMissing(invite);
      await this.trySendInviteDeliveredAck(invite, canReactivate ? 'reactivated' : 'duplicate');
      return;
    }

    // Create local group chat entry with invited_pending status
    const chatId = await database.createChat({
      type: 'group',
      name: invite.groupName,
      created_by: invite.inviterPeerId,
      offline_bucket_secret: '',
      notifications_bucket_key: '',
      group_id: invite.groupId,
      status: 'pending',
      offline_last_read_timestamp: 0,
      offline_last_ack_sent: 0,
      trusted_out_of_band: false,
      muted: false,
      key_version: 0,
      group_creator_peer_id: invite.inviterPeerId,
      group_status: 'invited_pending',
      created_at: new Date(),
      participants: [invite.inviterPeerId],
    });

    database.transitionChatGroupStatus(chatId, 'invited_pending' satisfies GroupStatus, 'invite_received');
    log(`[GROUP][INVITE][APPLY] group=${invite.groupId} chatId=${chatId} status=invited_pending`);

    // Notification for UI
    this.createInviteNotificationIfMissing(invite);

    await this.trySendInviteDeliveredAck(invite, 'new');
  }

  private async trySendInviteDeliveredAck(
    invite: GroupInvite,
    context: 'new' | 'reactivated' | 'duplicate',
  ): Promise<void> {
    try {
      await this.sendInviteDeliveredAck(invite);
    } catch (error: unknown) {
      console.warn(`[GROUP] Failed to send invite delivery ACK (${context}) for ${invite.groupId}`, error);
    }
  }

  async respondToInvite(groupId: string, accept: boolean): Promise<void> {
    const { database, myPeerId } = this.deps;
    log(
      `[GROUP][RESP_SEND][START] group=${groupId} decision=${accept ? 'accept' : 'reject'}`,
    );

    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);
    const isTerminalStatus = TERMINAL_STATES.includes(chat.group_status || '')
    if (chat.group_status !== 'invited_pending' && !isTerminalStatus) {
      throw new Error(`Cannot respond to group ${groupId} in status ${chat.group_status}`);
    }

    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) throw new Error(`Group ${groupId} has no creator`);
    log(
      `[GROUP][RESP_SEND][CHAT] group=${groupId} chatId=${chat.id} creator=${creatorPeerId.slice(-8)} status=${chat.group_status}`,
    );

    // Find newest pending invite notification for this group
    const notifications = database.getPendingGroupInvitationNotifications();
    const inviteNotification = notifications.find(n => {
      try {
        const data = JSON.parse(n.notification_data) as { groupId?: string };
        return data.groupId === groupId;
      } catch {
        return false;
      }
    });

    if (!inviteNotification) {
      throw new Error(`No invite notification found for group ${groupId}`);
    }

    const inviteData = JSON.parse(inviteNotification.notification_data) as {
      inviteId: string;
      expiresAt: number;
    };

    if (Date.now() > inviteData.expiresAt) {
      database.updateNotificationStatus(inviteNotification.id, 'expired');
      if (chat.group_status === 'invited_pending') {
        database.transitionChatGroupStatus(chat.id, 'invite_expired' satisfies GroupStatus, 'respond_invite_expired');
      }
      throw new Error(`Invite for group ${groupId} has expired`);
    }
    log(
      `[GROUP][RESP_SEND][INVITE] group=${groupId} inviteId=${inviteData.inviteId} notificationId=${inviteNotification.id} expiresAt=${inviteData.expiresAt}`,
    );

    const response: Omit<GroupInviteResponse, 'signature'> = {
      type: GroupMessageType.GROUP_INVITE_RESPONSE,
      groupId,
      inviteId: inviteData.inviteId,
      messageId: randomUUID(),
      responderPeerId: myPeerId,
      response: accept ? 'accept' : 'reject',
      timestamp: Date.now(),
    };

    const signature = this.sign(response);
    const signedResponse: GroupInviteResponse = { ...response, signature };
    log(
      `[GROUP][RESP_SEND][PAYLOAD] group=${groupId} inviteId=${signedResponse.inviteId} msgId=${signedResponse.messageId} to=${creatorPeerId.slice(-8)} decision=${signedResponse.response}`,
    );

    // Persist response for re-publish before first send (durability across crashes/restarts).
    database.insertPendingAck(
      groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE', JSON.stringify(signedResponse),
    );
    log(
      `[GROUP][RESP_SEND][PENDING] group=${groupId} inviteId=${signedResponse.inviteId} msgId=${signedResponse.messageId} target=${creatorPeerId.slice(-8)} stored=true`,
    );

    // Update local UI state immediately after local intent is persisted.
    database.updateNotificationStatus(inviteNotification.id, accept ? 'accepted' : 'rejected');
    const nextGroupStatus: GroupStatus = accept
      ? 'awaiting_activation'
      : (chat.group_status === 'invited_pending' ? 'invite_expired' : 'removed');
    database.transitionChatGroupStatus(chat.id, nextGroupStatus, 'respond_invite_local_state');

    if (accept && isTerminalStatus) {
      database.resetGroupRuntimeForReinvite(chat.id, groupId);
    }
    log(
      `[GROUP][RESP_SEND][LOCAL_STATE] group=${groupId} chatId=${chat.id} groupStatus=${nextGroupStatus} notification=${accept ? 'accepted' : 'rejected'}`,
    );

    // Send via pairwise offline bucket to creator
    await this.sendControlMessageToPeer(creatorPeerId, signedResponse);
    log(
      `[GROUP][RESP_SEND][DONE] group=${groupId} inviteId=${signedResponse.inviteId} msgId=${signedResponse.messageId} target=${creatorPeerId.slice(-8)}`,
    );
  }

  async leaveGroup(groupId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    const chat = database.getChatByGroupId(groupId);
    if (!chat) throw new Error(`Group ${groupId} not found`);
    if (chat.type !== 'group') throw new Error(`Chat ${groupId} is not a group`);

    if (chat.group_status === 'left') {
      this.applyLocalGroupLeaveState(chat.id, groupId);
      return;
    }
    if (chat.group_status === 'removed') {
      this.applyLocalGroupRemovedState(chat.id, groupId);
      return;
    }
    if (chat.group_status === 'disbanded') {
      this.applyLocalGroupDisbandedState(chat.id, groupId);
      return;
    }

    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) throw new Error(`Group ${groupId} has no creator`);
    if (creatorPeerId === myPeerId) {
      throw new Error('Creator leave flow is not supported yet');
    }

    const isParticipant = database.getChatParticipants(chat.id).some((p) => p.peer_id === myPeerId);
    if (!isParticipant) {
      this.applyLocalGroupLeaveState(chat.id, groupId);
      return;
    }

    const leaveRequest: Omit<GroupLeaveRequest, 'signature'> = {
      type: GroupMessageType.GROUP_LEAVE_REQUEST,
      groupId,
      peerId: myPeerId,
      messageId: randomUUID(),
      timestamp: Date.now(),
    };
    const signedLeaveRequest: GroupLeaveRequest = {
      ...leaveRequest,
      signature: this.sign(leaveRequest),
    };

    await this.sendControlMessageToPeer(creatorPeerId, signedLeaveRequest);
    this.applyLocalGroupLeaveState(chat.id, groupId);
    log(
      `[GROUP][LEAVE][DONE] group=${groupId} creator=${creatorPeerId.slice(-8)} msgId=${signedLeaveRequest.messageId}`,
    );
  }

  async requestGroupStateResync(groupId: string): Promise<void> {
    const { database, myPeerId } = this.deps;
    const chat = database.getChatByGroupId(groupId);
    
    if (!chat) throw new Error(`Group ${groupId} not found`);
    if (chat.type !== 'group') throw new Error(`Chat ${groupId} is not a group`);
    if (chat.group_status === 'invited_pending') {
      throw new Error('Accept the invite first before requesting a group update');
    }
    if (chat.group_status === 'left' || chat.group_status === 'removed' || chat.group_status === 'disbanded') {
      throw new Error(`Cannot request group update while group status is ${chat.group_status}`);
    }

    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) throw new Error(`Group ${groupId} has no creator`);
    if (creatorPeerId === myPeerId) throw new Error('Group creator cannot request group update');

    const isParticipant = database.getChatParticipants(chat.id).some((participant) => participant.peer_id === myPeerId);
    if (!isParticipant && chat.group_status !== 'awaiting_activation') {
      throw new Error('You are not an active member of this group');
    }

    const request: Omit<GroupStateResyncRequest, 'signature'> = {
      type: GroupMessageType.GROUP_STATE_RESYNC_REQUEST,
      groupId,
      requesterPeerId: myPeerId,
      knownKeyVersion: chat.key_version ?? 0,
      messageId: randomUUID(),
      timestamp: Date.now(),
    };
    const signedRequest: GroupStateResyncRequest = {
      ...request,
      signature: this.sign(request),
    };

    await this.sendControlMessageToPeer(creatorPeerId, signedRequest);
    log(
      `[GROUP][RESYNC_REQ][SEND] group=${groupId} to=${creatorPeerId.slice(-8)} msgId=${signedRequest.messageId} knownKeyVersion=${signedRequest.knownKeyVersion}`,
    );
  }

  handleInviteResponseAck(ack: GroupInviteResponseAck): void {
    const { database } = this.deps;
    log(
      `[GROUP][RESP_ACK][IN] group=${ack.groupId} inviteId=${ack.inviteId} ackedMsgId=${ack.ackedMessageId} ackId=${ack.ackId}`,
    );

    const chat = database.getChatByGroupId(ack.groupId);
    if (!chat) {
      log(`[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=no_chat`);
      return;
    }

    // Verify creator signature
    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) {
      log(`[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=no_creator`);
      return;
    }

    const creator = database.getUserByPeerId(creatorPeerId);
    if (!creator) {
      log(`[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=unknown_creator creator=${creatorPeerId.slice(-8)}`);
      return;
    }

    this.verifySignature(ack, creator.signing_public_key);

    const pendingAcks = database.getPendingAcksForGroup(ack.groupId);
    const pendingResponse = pendingAcks.find(
      a => a.target_peer_id === creatorPeerId && a.message_type === 'GROUP_INVITE_RESPONSE',
    );
    if (!pendingResponse) {
      log(
        `[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=no_pending_response creator=${creatorPeerId.slice(-8)} pendingCount=${pendingAcks.length}`,
      );
      return;
    }

    let storedResponse: GroupInviteResponse;
    try {
      storedResponse = JSON.parse(pendingResponse.message_payload) as GroupInviteResponse;
    } catch {
      log(
        `[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=invalid_pending_payload creator=${creatorPeerId.slice(-8)}`,
      );
      return;
    }

    // ACK must match the currently pending response exactly.
    if (ack.ackedMessageId !== storedResponse.messageId) {
      log(
        `[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=message_id_mismatch pendingMsgId=${storedResponse.messageId} ackedMsgId=${ack.ackedMessageId}`,
      );
      return;
    }
    if (ack.inviteId !== storedResponse.inviteId) {
      log(
        `[GROUP][RESP_ACK][DROP] group=${ack.groupId} reason=invite_id_mismatch pendingInviteId=${storedResponse.inviteId} incomingInviteId=${ack.inviteId}`,
      );
      return;
    }

    // Remove response from pending ACKs (stop re-publishing)
    database.removePendingAck(ack.groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE');
    log(
      `[GROUP][RESP_ACK][APPLY] group=${ack.groupId} creator=${creatorPeerId.slice(-8)} inviteId=${ack.inviteId} ackedMsgId=${ack.ackedMessageId}`,
    );
  }

  async handleGroupWelcome(welcome: GroupWelcome): Promise<void> {
    const { database, userIdentity } = this.deps;

    const chat = database.getChatByGroupId(welcome.groupId);
    if (!chat) {
      log(`[GROUP][WELCOME][DROP] group=${welcome.groupId} reason=unknown_group`);
      return;
    }

    // Verify creator signature
    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) return;

    const creator = database.getUserByPeerId(creatorPeerId);
    if (!creator) return;

    this.verifySignature(welcome, creator.signing_public_key);
    if (
      welcome.groupInfoLatestDhtKey &&
      !welcome.groupInfoLatestDhtKey.startsWith(`${this.groupInfoLatestPrefix}/`)
    ) {
      console.warn(
        `[MODE-GUARD][REJECT][group_welcome] group=${welcome.groupId} ` +
        `reason=group_info_key_mode_mismatch expectedPrefix=${this.groupInfoLatestPrefix}/ ` +
        `got=${welcome.groupInfoLatestDhtKey.slice(0, 64)}...`
      );
      return;
    }

    // If already active, this is a duplicate welcome — just re-send the ACK
    if (chat.group_status === 'active') {
      if (creatorPeerId) {
        database.removePendingAck(welcome.groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE');
      }
      await this.sendWelcomeAck(welcome);
      log(
        `[GROUP][WELCOME][DUPLICATE] group=${welcome.groupId} msgId=${welcome.messageId} ackResent=true`,
      );
      return;
    }

    // Decrypt group key with our RSA private key
    const ourPrivateKeyPem = userIdentity.offlinePrivateKey;
    const groupKey = privateDecrypt(
      ourPrivateKeyPem,
      Buffer.from(welcome.encryptedGroupKey, 'base64'),
    ).toString('base64');
    const groupInfoMetadataKey = privateDecrypt(
      ourPrivateKeyPem,
      Buffer.from(welcome.encryptedGroupInfoMetadataKey, 'base64'),
    ).toString('base64');
    const welcomeMetadataKeyBytes = Buffer.from(groupInfoMetadataKey, 'base64');
    log('[GROUP-INFO][META][RECEIVE][WELCOME] group=' + welcome.groupId + ' keyVersion=' + String(welcome.keyVersion) + ' metadataKeyBytes=' + String(welcomeMetadataKeyBytes.length));

    // Store key in history
    database.insertGroupKeyHistory(welcome.groupId, welcome.keyVersion, groupKey, groupInfoMetadataKey);

    // Update chat with key version and group info DHT key
    database.updateChatKeyVersion(chat.id, welcome.keyVersion);
    if (welcome.groupInfoLatestDhtKey) {
      database.updateChatGroupInfoDhtKey(chat.id, welcome.groupInfoLatestDhtKey);
    }

    // Ensure all roster members exist in users table (required by chat_participants FK)
    for (const entry of welcome.roster) {
      if (entry.peerId === this.deps.myPeerId) continue;
      if (!database.getUserByPeerId(entry.peerId)) {
        await database.createUser({
          peer_id: entry.peerId,
          username: entry.username,
          signing_public_key: entry.signingPubKey,
          offline_public_key: entry.offlinePubKey,
          // No handshake signature for group-only contacts; empty string is safe because
          // key-exchange.ts treats a falsy signature as "not yet verified via direct KX"
          // and falls through to a full re-handshake if they ever become direct contacts.
          signature: '',
        });
      }
    }

    // Save roster to chat_participants
    const participantPeerIds = welcome.roster.map(r => r.peerId);
    database.updateGroupParticipants(chat.id, participantPeerIds);

    // Transition to active (both group_status and the top-level status so ChatList shows it)
    database.transitionChatGroupStatus(chat.id, 'active' satisfies GroupStatus, 'welcome_applied');
    database.updateChatStatus(chat.id, 'active');
    log(
      `[GROUP][WELCOME][APPLY] group=${welcome.groupId} chatId=${chat.id} keyVersion=${welcome.keyVersion} rosterSize=${welcome.roster.length} status=active`,
    );

    // Creator has definitely processed our invite response if they sent welcome.
    database.removePendingAck(welcome.groupId, creatorPeerId, 'GROUP_INVITE_RESPONSE');

    // Notify UI that this group chat is now active
    this.deps.onGroupChatActivated?.({ chatId: chat.id });

    // The joiner does not receive GROUP_STATE_UPDATE for their own join event.
    // Persist an equivalent local system message on welcome apply.
    await this.appendMembershipSystemMessage(
      chat.id,
      welcome.groupId,
      welcome.keyVersion,
      'join',
      this.deps.myPeerId,
      this.deps.myUsername,
      creatorPeerId,
      creator.username,
      Date.now(),
    );

    // Send ACK back to creator
    await this.sendWelcomeAck(welcome);
    log(
      `[GROUP][WELCOME][DONE] group=${welcome.groupId} msgId=${welcome.messageId} ackSent=true`,
    );
  }

  async handleGroupStateUpdate(update: GroupStateUpdate): Promise<void> {
    const { database, userIdentity } = this.deps;
    const inbound = this.resolveChatAndCreatorForInbound({
      groupId: update.groupId,
      messageId: update.messageId,
      dropTag: 'STATE_UPDATE',
    });
    if (!inbound) return;
    const { chat, creatorPeerId, creator } = inbound;

    const normalizedEventTimestamp = this.normalizeInboundTimestampOrDrop(
      update.timestamp,
      'STATE_UPDATE',
      update.groupId,
      update.messageId,
    );
    if (normalizedEventTimestamp === null) return;

    this.verifySignature(update, creator.signing_public_key);

    if (chat.group_status === 'left' || chat.group_status === 'removed' || chat.group_status === 'disbanded') {
      await this.sendControlAck(
        creatorPeerId,
        update.groupId,
        GroupMessageType.GROUP_STATE_UPDATE,
        update.messageId,
      );
      log(
        `[GROUP][STATE_UPDATE][DROP] group=${update.groupId} msgId=${update.messageId} reason=local_terminal_status status=${chat.group_status}`,
      );
      return;
    }

    const currentKeyVersion = chat.key_version ?? 0;
    if (currentKeyVersion >= update.keyVersion) {
      let recoveredTimeline = false;
      if (currentKeyVersion === update.keyVersion && !update.isResync) {
        await this.appendMembershipSystemMessage(
          chat.id,
          update.groupId,
          update.keyVersion,
          update.event,
          update.targetPeerId,
          update.roster.find((entry) => entry.peerId === update.targetPeerId)?.username,
          creatorPeerId,
          creator.username,
          normalizedEventTimestamp,
        );
        recoveredTimeline = true;
      }
      await this.sendControlAck(
        creatorPeerId,
        update.groupId,
        GroupMessageType.GROUP_STATE_UPDATE,
        update.messageId,
      );
      log(
        `[GROUP][STATE_UPDATE][DUPLICATE] group=${update.groupId} msgId=${update.messageId} currentKeyVersion=${currentKeyVersion} ` +
        `incomingKeyVersion=${update.keyVersion} recoveredTimeline=${recoveredTimeline}`,
      );
      return;
    }

    if (update.event === 'kick' && update.targetPeerId === this.deps.myPeerId) {
      this.applyLocalGroupRemovedState(chat.id, update.groupId);
      await this.appendMembershipSystemMessage(
        chat.id,
        update.groupId,
        update.keyVersion,
        'kick',
        update.targetPeerId,
        update.roster.find((entry) => entry.peerId === update.targetPeerId)?.username,
        creatorPeerId,
        creator.username,
        normalizedEventTimestamp,
      );
      await this.sendControlAck(
        creatorPeerId,
        update.groupId,
        GroupMessageType.GROUP_STATE_UPDATE,
        update.messageId,
      );
      log(
        `[GROUP][STATE_UPDATE][APPLY_SELF_KICK] group=${update.groupId} msgId=${update.messageId} keyVersion=${update.keyVersion}`,
      );
      return;
    }

    // Decrypt newly rotated group key
    const groupKey = privateDecrypt(
      userIdentity.offlinePrivateKey,
      Buffer.from(update.encryptedGroupKey, 'base64'),
    ).toString('base64');
    const groupInfoMetadataKey = privateDecrypt(
      userIdentity.offlinePrivateKey,
      Buffer.from(update.encryptedGroupInfoMetadataKey, 'base64'),
    ).toString('base64');
    const stateUpdateMetadataKeyBytes = Buffer.from(groupInfoMetadataKey, 'base64');
    log('[GROUP-INFO][META][RECEIVE][STATE_UPDATE] group=' + update.groupId + ' keyVersion=' + String(update.keyVersion) + ' metadataKeyBytes=' + String(stateUpdateMetadataKeyBytes.length));

    database.insertGroupKeyHistory(update.groupId, update.keyVersion, groupKey, groupInfoMetadataKey);

    // Ensure all roster members exist in users table (required by chat_participants FK)
    for (const entry of update.roster) {
      if (entry.peerId === this.deps.myPeerId) continue;
      if (!database.getUserByPeerId(entry.peerId)) {
        await database.createUser({
          peer_id: entry.peerId,
          username: entry.username,
          signing_public_key: entry.signingPubKey,
          offline_public_key: entry.offlinePubKey,
          signature: '',
        });
      }
    }

    const participantPeerIds = update.roster.map(r => r.peerId);
    database.updateGroupParticipants(chat.id, participantPeerIds);
    database.updateChatKeyVersion(chat.id, update.keyVersion);
    database.transitionChatGroupStatus(chat.id, 'active', 'state_update_applied');
    database.updateChatStatus(chat.id, 'active');

    if (chat.group_status !== 'active' || chat.status !== 'active') {
      this.deps.onGroupChatActivated?.({ chatId: chat.id });
    }
    if (!update.isResync) {
      this.deps.onGroupMembersUpdated?.({
        chatId: chat.id,
        groupId: update.groupId,
        memberPeerId: update.targetPeerId,
      });
    }
    if (!update.isResync) {
      await this.appendMembershipSystemMessage(
        chat.id,
        update.groupId,
        update.keyVersion,
        update.event,
        update.targetPeerId,
        update.roster.find((entry) => entry.peerId === update.targetPeerId)?.username,
        creatorPeerId,
        creator.username,
        normalizedEventTimestamp,
      );
    } else {
      log(
        `[GROUP][STATE_UPDATE][RESYNC_APPLY] group=${update.groupId} msgId=${update.messageId} keyVersion=${update.keyVersion}`,
      );
    }

    await this.sendControlAck(
      creatorPeerId,
      update.groupId,
      GroupMessageType.GROUP_STATE_UPDATE,
      update.messageId,
    );
    log(
      `[GROUP][STATE_UPDATE][APPLY] group=${update.groupId} msgId=${update.messageId} keyVersion=${update.keyVersion} rosterSize=${update.roster.length} event=${update.event} target=${update.targetPeerId.slice(-8)}`,
    );
  }

  async syncGroupInfoForLocalChat(groupId: string): Promise<void> {
    const chat = this.deps.database.getChatByGroupId(groupId);
    if (!chat) return;

    const localKeyVersion = chat.key_version ?? 0;
    if (localKeyVersion < 1) return;

    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) return;
    const creator = this.deps.database.getUserByPeerId(creatorPeerId);
    if (!creator) return;

    await this.syncGroupInfoChainFromDht(groupId, chat.id, localKeyVersion, creator.signing_public_key);
  }

  async handleGroupKick(kick: GroupKick): Promise<boolean> {
    const inbound = this.resolveChatAndCreatorForInbound({
      groupId: kick.groupId,
      messageId: kick.messageId,
      dropTag: 'KICK',
    });
    if (!inbound) return false;
    const { chat, creatorPeerId, creator } = inbound;

    const normalizedKickTimestamp = this.normalizeInboundTimestampOrDrop(
      kick.timestamp,
      'KICK',
      kick.groupId,
      kick.messageId,
    );
    if (normalizedKickTimestamp === null) return false;

    this.verifySignature(kick, creator.signing_public_key);

    if (kick.kickedPeerId !== this.deps.myPeerId) {
      log(
        `[GROUP][KICK][DROP] group=${kick.groupId} msgId=${kick.messageId} reason=not_target target=${kick.kickedPeerId.slice(-8)}`,
      );
      return false;
    }

    const currentKeyVersion = chat.key_version ?? 0;
    if (chat.group_status === 'removed' || chat.group_status === 'disbanded') {
      this.deps.onGroupMembersUpdated?.({
        chatId: chat.id,
        groupId: kick.groupId,
        memberPeerId: kick.kickedPeerId,
      });
      await this.sendControlAck(
        creatorPeerId,
        kick.groupId,
        GroupMessageType.GROUP_KICK,
        kick.messageId,
      );
      log(
        `[GROUP][KICK][DUPLICATE] group=${kick.groupId} msgId=${kick.messageId} currentKeyVersion=${currentKeyVersion} incomingKeyVersion=${kick.keyVersion}`,
      );
      return true;
    }
    if (currentKeyVersion >= kick.keyVersion) {
      await this.sendControlAck(
        creatorPeerId,
        kick.groupId,
        GroupMessageType.GROUP_KICK,
        kick.messageId,
      );
      log(
        `[GROUP][KICK][DROP] group=${kick.groupId} msgId=${kick.messageId} reason=stale_key_version currentKeyVersion=${currentKeyVersion} incomingKeyVersion=${kick.keyVersion}`,
      );
      return false;
    }

    this.applyLocalGroupRemovedState(chat.id, kick.groupId);
    this.deps.onGroupMembersUpdated?.({
      chatId: chat.id,
      groupId: kick.groupId,
      memberPeerId: kick.kickedPeerId,
    });
    await this.appendMembershipSystemMessage(
      chat.id,
      kick.groupId,
      kick.keyVersion,
      'kick',
      kick.kickedPeerId,
      this.deps.myUsername,
      creatorPeerId,
      creator.username,
      normalizedKickTimestamp,
    );
    await this.sendControlAck(
      creatorPeerId,
      kick.groupId,
      GroupMessageType.GROUP_KICK,
      kick.messageId,
    );
    log(
      `[GROUP][KICK][APPLY] group=${kick.groupId} msgId=${kick.messageId} keyVersion=${kick.keyVersion}`,
    );
    return true;
  }

  async handleGroupDisband(disband: GroupDisband): Promise<boolean> {
    const { database } = this.deps;
    const chat = database.getChatByGroupId(disband.groupId);
    const fallbackCreator = database.getUserByPeerId(disband.creatorPeerId);
    const normalizedDisbandTimestamp = this.normalizeInboundTimestampOrDrop(
      disband.timestamp,
      'DISBAND',
      disband.groupId,
      disband.messageId,
    );
    if (normalizedDisbandTimestamp === null) return false;

    if (!chat) {
      if (!fallbackCreator) {
        log(`[GROUP][DISBAND][DROP] group=${disband.groupId} reason=unknown_group_and_creator`);
        return false;
      }
      this.verifySignature(disband, fallbackCreator.signing_public_key);
      this.expirePendingGroupInviteNotifications(disband.groupId);
      await this.sendControlAck(
        disband.creatorPeerId,
        disband.groupId,
        GroupMessageType.GROUP_DISBAND,
        disband.messageId,
      );
      log(`[GROUP][DISBAND][ACK_ONLY_NO_CHAT] group=${disband.groupId} msgId=${disband.messageId}`);
      return true;
    }
    const inbound = this.resolveChatAndCreatorForInbound({
      groupId: disband.groupId,
      messageId: disband.messageId,
      dropTag: 'DISBAND',
      expectedCreatorPeerId: disband.creatorPeerId,
      preferredCreator: fallbackCreator,
    });
    if (!inbound) return false;
    const { chat: chatWithCreator, creatorPeerId, creator } = inbound;

    this.verifySignature(disband, creator.signing_public_key);

    if (chatWithCreator.group_status !== 'disbanded') {
      this.applyLocalGroupDisbandedState(chatWithCreator.id, disband.groupId);
      await this.appendDisbandSystemMessage(
        chatWithCreator.id,
        disband.groupId,
        creatorPeerId,
        creator.username,
        normalizedDisbandTimestamp,
      );
      this.deps.onGroupMembersUpdated?.({
        chatId: chatWithCreator.id,
        groupId: disband.groupId,
        memberPeerId: creatorPeerId,
      });
      log(
        `[GROUP][DISBAND][APPLY] group=${disband.groupId} msgId=${disband.messageId}`,
      );
    } else {
      log(
        `[GROUP][DISBAND][DUPLICATE] group=${disband.groupId} msgId=${disband.messageId}`,
      );
    }

    await this.sendControlAck(
      creatorPeerId,
      disband.groupId,
      GroupMessageType.GROUP_DISBAND,
      disband.messageId,
    );
    return true;
  }

  async republishPendingControl(targetPeerId: string, payloadJson: string): Promise<void> {
    let parsed: object;
    try {
      parsed = JSON.parse(payloadJson) as object;
    } catch {
      throw new Error(`Invalid pending ACK payload for ${targetPeerId}`);
    }
    log(
      `[GROUP][REPUBLISH][RESPONDER] target=${targetPeerId.slice(-8)} ${this.describeControlMessage(parsed)}`,
    );
    await this.sendControlMessageToPeer(targetPeerId, parsed);
  }

  private async sendWelcomeAck(welcome: GroupWelcome): Promise<void> {
    const creatorPeerId = this.deps.database.getChatByGroupId(welcome.groupId)?.group_creator_peer_id;
    if (!creatorPeerId) return;
    await this.sendControlAck(
      creatorPeerId,
      welcome.groupId,
      GroupMessageType.GROUP_WELCOME,
      welcome.messageId,
    );
    log(
      `[GROUP][WELCOME_ACK][SEND] group=${welcome.groupId} to=${creatorPeerId.slice(-8)} ackedMsgId=${welcome.messageId}`,
    );
  }

  private async sendInviteDeliveredAck(invite: GroupInvite): Promise<void> {
    const ack: Omit<GroupInviteDeliveredAck, 'signature'> = {
      type: GroupMessageType.GROUP_INVITE_DELIVERED_ACK,
      groupId: invite.groupId,
      inviteId: invite.inviteId,
      ackId: randomUUID(),
    };

    const signature = this.sign(ack);
    const signedAck: GroupInviteDeliveredAck = { ...ack, signature };
    log(
      `[GROUP][DELIVERED_ACK][SEND] group=${invite.groupId} inviteId=${invite.inviteId} to=${invite.inviterPeerId.slice(-8)} ackId=${signedAck.ackId}`,
    );
    await this.sendControlMessageToPeer(invite.inviterPeerId, signedAck);
  }

  private createInviteNotificationIfMissing(invite: GroupInvite): void {
    const existingNotification = this.deps.database.getNotificationById(invite.inviteId);
    if (existingNotification) return;

    this.deps.database.createNotification({
      id: invite.inviteId,
      notification_type: 'group_invitation',
      notification_data: JSON.stringify({
        groupId: invite.groupId,
        groupName: invite.groupName,
        inviterPeerId: invite.inviterPeerId,
        inviteId: invite.inviteId,
        expiresAt: invite.expiresAt,
      }),
      bucket_key: '',
      status: 'pending',
    });
  }

  // --- Helpers ---

  private resolveChatAndCreatorForInbound(options: {
    groupId: string;
    messageId: string;
    dropTag: 'STATE_UPDATE' | 'KICK' | 'DISBAND';
    expectedCreatorPeerId?: string;
    preferredCreator?: ReturnType<ChatDatabase['getUserByPeerId']> | null;
  }): {
    chat: NonNullable<ReturnType<ChatDatabase['getChatByGroupId']>>;
    creatorPeerId: string;
    creator: NonNullable<ReturnType<ChatDatabase['getUserByPeerId']>>;
  } | null {
    const { database } = this.deps;
    const chat = database.getChatByGroupId(options.groupId);
    if (!chat) {
      log(`[GROUP][${options.dropTag}][DROP] group=${options.groupId} reason=unknown_group`);
      return null;
    }

    const creatorPeerId = chat.group_creator_peer_id;
    if (!creatorPeerId) {
      log(`[GROUP][${options.dropTag}][DROP] group=${options.groupId} reason=no_creator`);
      return null;
    }

    if (options.expectedCreatorPeerId && creatorPeerId !== options.expectedCreatorPeerId) {
      log(
        `[GROUP][${options.dropTag}][DROP] group=${options.groupId} msgId=${options.messageId} reason=creator_mismatch expected=${creatorPeerId.slice(-8)} got=${options.expectedCreatorPeerId.slice(-8)}`,
      );
      return null;
    }

    const creator = (
      options.preferredCreator?.peer_id === creatorPeerId
        ? options.preferredCreator
        : database.getUserByPeerId(creatorPeerId)
    );
    if (!creator) {
      log(`[GROUP][${options.dropTag}][DROP] group=${options.groupId} reason=unknown_creator creator=${creatorPeerId.slice(-8)}`);
      return null;
    }

    return { chat, creatorPeerId, creator };
  }

  private normalizeInboundTimestampOrDrop(
    timestamp: number,
    messageType: 'STATE_UPDATE' | 'KICK' | 'DISBAND',
    groupId: string,
    messageId: string,
  ): number | null {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      log(`[GROUP][${messageType}][DROP] group=${groupId} msgId=${messageId} reason=invalid_timestamp`);
      return null;
    }

    return this.normalizeRemoteEventTimestamp(
      timestamp,
      messageType,
      groupId,
      messageId,
    );
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

  private async sendControlAck(
    peerId: string,
    groupId: string,
    ackedMessageType: string,
    ackedMessageId: string,
  ): Promise<void> {
    const ack: Omit<GroupControlAck, 'signature'> = {
      type: GroupMessageType.GROUP_CONTROL_ACK,
      groupId,
      ackedMessageType,
      ackedMessageId,
      ackId: randomUUID(),
    };

    const signature = this.sign(ack);
    const signedAck: GroupControlAck = { ...ack, signature };
    await this.sendControlMessageToPeer(peerId, signedAck);
  }

  private async sendControlMessageToPeer(peerId: string, message: object): Promise<void> {
    const { node, database, userIdentity, myPeerId, myUsername } = this.deps;

    const user = database.getUserByPeerId(peerId);
    if (!user) throw new Error(`User ${peerId} not found`);

    const bucketSecret = database.getOfflineBucketSecretByPeerId(peerId);
    if (!bucketSecret) {
      throw new Error(`No offline bucket secret for peer ${peerId}`);
    }

    const ourPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    const writeBucketKey = `${this.directOfflineBucketPrefix}/${bucketSecret}/${ourPubKeyBase64url}`;
    const bucketTag = writeBucketKey.slice(-12);

    const recipientPubKeyPem = Buffer.from(user.offline_public_key, 'base64').toString();
    const lastReadTimestamp = database.getOfflineLastReadTimestampByPeerId(peerId);
    const lastAckSent = database.getOfflineLastAckSentByPeerId(peerId);
    const shouldSendAck = lastReadTimestamp > lastAckSent;
    log(
      `[GROUP][SEND] to=${peerId.slice(-8)} bucket=*${bucketTag} shouldAck=${shouldSendAck} ackTs=${shouldSendAck ? lastReadTimestamp : 0} ${this.describeControlMessage(message)}`,
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
      { bypassControlReserve: true },
    );
    log(
      `[GROUP][SEND][DHT_OK] to=${peerId.slice(-8)} bucket=*${bucketTag} offlineMsgId=${offlineMessage.id} ${this.describeControlMessage(message)}`,
    );

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

  private async syncGroupInfoChainFromDht(
    groupId: string,
    chatId: number,
    localKeyVersion: number,
    creatorSigningPubKeyBase64: string,
  ): Promise<void> {
    const history = this.deps.database
      .getGroupKeyHistory(groupId)
      .filter((row) => row.key_version <= localKeyVersion);
    if (history.length === 0) return;

    const historyByVersion = new Map<number, typeof history[number]>();
    let minMissingVersion = Number.POSITIVE_INFINITY;
    let missingEpochCount = 0;
    for (const row of history) {
      historyByVersion.set(row.key_version, row);
      const needsStateHash = !row.state_hash;
      const needsUsedUntil = row.key_version < localKeyVersion && row.used_until == null;
      if (needsStateHash || needsUsedUntil) {
        missingEpochCount += 1;
        if (row.key_version < minMissingVersion) {
          minMissingVersion = row.key_version;
        }
      }
    }
    if (missingEpochCount === 0) return;
    log(`[GROUP-INFO][START] group=${groupId} localKeyVersion=${localKeyVersion} missingEpochs=${missingEpochCount}`);

    const creatorPubBytes = Buffer.from(creatorSigningPubKeyBase64, 'base64');
    const creatorPubKeyBase64url = toBase64Url(creatorPubBytes);
    const latestDhtKey = `${this.groupInfoLatestPrefix}/${groupId}/${creatorPubKeyBase64url}`;
    const latest = await this.fetchLatestGroupInfoRecord(latestDhtKey, groupId, creatorPubBytes);
    if (!latest) {
      log(
        `[GROUP-INFO][SYNC][SKIP] group=${groupId} chatId=${chatId} reason=latest_unavailable`,
      );
      return;
    }

    const latestVersion = latest.latestVersion;
    if (latestVersion < 1) {
      log(
        `[GROUP-INFO][SYNC][SKIP] group=${groupId} chatId=${chatId} reason=latest_version_invalid latestVersion=${latestVersion}`,
      );
      return;
    }

    const maxRelevantVersion = Math.min(latestVersion, localKeyVersion);
    if (minMissingVersion > maxRelevantVersion) {
      log(
        `[GROUP-INFO][SYNC][SKIP] group=${groupId} chatId=${chatId} reason=latest_behind_local latestVersion=${latestVersion} localKeyVersion=${localKeyVersion}`,
      );
      return;
    }

    let fetchStartVersion = minMissingVersion;
    let previousStateHash = '';
    if (fetchStartVersion > 1) {
      let anchorVersion = fetchStartVersion - 1;
      while (anchorVersion >= 1) {
        const anchorStateHash = historyByVersion.get(anchorVersion)?.state_hash;
        if (anchorStateHash) {
          fetchStartVersion = anchorVersion + 1;
          previousStateHash = anchorStateHash;
          break;
        }
        anchorVersion -= 1;
      }
      if (anchorVersion < 1) {
        fetchStartVersion = 1;
      }
    }

    log(`[GROUP-INFO][SYNC][FETCH_PLAN] group=${groupId} fetchRange=${fetchStartVersion}-${maxRelevantVersion}`);
    
    const fetchConcurrency = 5;
    const versionedRecords = await this.fetchVersionedRecordsRange(
      groupId,
      creatorPubKeyBase64url,
      creatorPubBytes,
      fetchStartVersion,
      maxRelevantVersion,
      fetchConcurrency,
    );
    if (!versionedRecords) {
      return;
    }

    // Check chain hash validity
    for (let version = fetchStartVersion; version <= maxRelevantVersion; version++) {
      const record = versionedRecords.get(version);
      if (!record) {
        console.warn(`[GROUP-INFO][SYNC][CHAIN_FAIL] group=${groupId} chatId=${chatId} reason=version_gap version=${version}`);
        return;
      }

      if (version === 1) {
        if (record.prevVersionHash !== '') {
          console.warn(
            `[GROUP-INFO][SYNC][CHAIN_FAIL] group=${groupId} chatId=${chatId} reason=invalid_genesis_prev_hash value=${record.prevVersionHash}`,
          );
          return;
        }
      } else if (record.prevVersionHash !== previousStateHash) {
        console.warn(
          `[GROUP-INFO][SYNC][CHAIN_FAIL] group=${groupId} chatId=${chatId} reason=prev_hash_mismatch version=${version}`,
        );
        return;
      }

      previousStateHash = record.stateHash;
    }

    if (latestVersion <= maxRelevantVersion) {
      const latestVersioned = versionedRecords.get(latestVersion);
      if (!latestVersioned || latestVersioned.stateHash !== latest.latestStateHash) {
        console.warn(
          `[GROUP-INFO][SYNC][CHAIN_FAIL] group=${groupId} chatId=${chatId} reason=latest_state_hash_mismatch latestVersion=${latestVersion}`,
        );
        return;
      }
    }

    for (let version = fetchStartVersion; version <= maxRelevantVersion; version++) {
      const localEpoch = historyByVersion.get(version);
      const record = versionedRecords.get(version);
      if (!localEpoch || !record) continue;

      if (localEpoch.state_hash !== record.stateHash) {
        this.deps.database.updateGroupKeyStateHash(groupId, version, record.stateHash);
      }

      if (version < localKeyVersion) {
        const nextRecord = versionedRecords.get(version + 1);
        if (nextRecord && localEpoch.used_until !== nextRecord.activatedAt) {
          this.deps.database.markGroupKeyUsedUntil(groupId, version, nextRecord.activatedAt);
        }
      }
    }

    this.deps.database.updateChatGroupInfoDhtKey(chatId, latestDhtKey);
    log(
      `[GROUP-INFO][SYNC][OK] group=${groupId} chatId=${chatId} localKeyVersion=${localKeyVersion} latestVersion=${latestVersion} fetchRange=${fetchStartVersion}-${maxRelevantVersion}`,
    );
  }

  private async fetchVersionedRecordsRange(
    groupId: string,
    creatorPubKeyBase64url: string,
    creatorPubKey: Uint8Array,
    startVersion: number,
    endVersion: number,
    concurrency: number,
  ): Promise<Map<number, GroupInfoVersioned> | null> {
    const versions: number[] = [];
    for (let version = startVersion; version <= endVersion; version++) {
      versions.push(version);
    }
    if (versions.length === 0) return new Map<number, GroupInfoVersioned>();

    const records = new Map<number, GroupInfoVersioned>();
    let index = 0;
    let failedVersion: number | null = null;
    const workerCount = Math.max(1, Math.min(concurrency, versions.length));

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= versions.length) break;
        if (failedVersion !== null) break;

        const version = versions[current];
        if (version === undefined) break;
        const dhtKey = `${this.groupInfoVersionPrefix}/${groupId}/${creatorPubKeyBase64url}/${version}`;
        const record = await this.fetchVersionedGroupInfoRecord(dhtKey, groupId, version, creatorPubKey);
        if (!record) {
          failedVersion = version;
          return;
        }
        records.set(version, record);
      }
    });

    await Promise.all(workers);

    if (failedVersion !== null) {
      console.warn(
        `[GROUP-INFO][SYNC][CHAIN_FAIL] group=${groupId} reason=missing_versioned_record version=${failedVersion} fetchRange=${startVersion}-${endVersion}`,
      );
      return null;
    }

    return records;
  }

  private async fetchLatestGroupInfoRecord(
    dhtKey: string,
    groupId: string,
    creatorPubKey: Uint8Array,
  ): Promise<GroupInfoLatest | null> {
    const keyBytes = new TextEncoder().encode(dhtKey);
    let best: GroupInfoLatest | null = null;

    try {
      for await (const event of this.deps.node.services.dht.get(keyBytes) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || event.value.length === 0) continue;
        try {
          const record = JSON.parse(new TextDecoder().decode(event.value)) as GroupInfoLatest;
          if (record.groupId !== groupId) continue;
          if (!this.verifyGroupInfoRecordSignature(record, creatorPubKey)) continue;
          if (!best
            || record.latestVersion > best.latestVersion
            || (record.latestVersion === best.latestVersion && record.lastUpdated > best.lastUpdated)
          ) {
            best = record;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }

    return best;
  }

  private async fetchVersionedGroupInfoRecord(
    dhtKey: string,
    groupId: string,
    version: number,
    creatorPubKey: Uint8Array,
  ): Promise<GroupInfoVersioned | null> {
    const keyBytes = new TextEncoder().encode(dhtKey);
    let best: GroupInfoVersioned | null = null;

    try {
      for await (const event of this.deps.node.services.dht.get(keyBytes) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || event.value.length === 0) continue;
        try {
          const record = JSON.parse(new TextDecoder().decode(event.value)) as GroupInfoVersioned;
          if (record.groupId !== groupId || record.version !== version) continue;
          if (!this.verifyGroupInfoRecordSignature(record, creatorPubKey)) continue;
          // Versioned key is immutable; any valid record is equivalent. Keep first valid.
          if (!best) {
            best = record;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }

    return best;
  }

  private verifyGroupInfoRecordSignature(
    record: GroupInfoLatest | GroupInfoVersioned,
    creatorPubKey: Uint8Array,
  ): boolean {
    try {
      const { creatorSignature, ...payload } = record;
      const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes = Buffer.from(creatorSignature, 'base64');
      return ed25519.verify(sigBytes, payloadBytes, creatorPubKey);
    } catch {
      return false;
    }
  }

  private applyLocalGroupLeaveState(chatId: number, groupId: string): void {
    const { database, myPeerId } = this.deps;
    database.transitionChatGroupStatus(chatId, 'left' satisfies GroupStatus, 'local_leave_applied');
    database.removePendingAcksForGroup(groupId);
    database.removeInviteDeliveryAcksForMember(groupId, myPeerId);
    database.deleteGroupOfflineCursors(groupId);
    database.deleteGroupSenderSeqs(groupId);
    database.deleteGroupMemberSeqs(groupId);
    database.deleteGroupKeyHistory(groupId);
    database.deleteGroupOfflineSentMessagesByPrefix(`${this.groupOfflineBucketPrefix}/${groupId}/`);
    database.deleteChatById(chatId);
  }

  private applyLocalGroupRemovedState(chatId: number, groupId: string): void {
    const { database, myPeerId } = this.deps;
    database.transitionChatGroupStatus(chatId, 'removed' satisfies GroupStatus, 'local_removed_applied');
    database.removePendingAcksForGroup(groupId);
    database.removeInviteDeliveryAcksForMember(groupId, myPeerId);
    // Keep cursors/seqs so post-removal catch-up can resume without rescanning from scratch.
    database.deleteGroupOfflineSentMessagesByPrefix(`${this.groupOfflineBucketPrefix}/${groupId}/`);
  }

  private applyLocalGroupDisbandedState(chatId: number, groupId: string): void {
    const { database, myPeerId } = this.deps;
    database.transitionChatGroupStatus(chatId, 'disbanded' satisfies GroupStatus, 'local_disband_applied');
    database.updateChatStatus(chatId, 'active');
    database.removePendingAcksForGroup(groupId);
    database.removeInviteDeliveryAcksForMember(groupId, myPeerId);
    database.deleteGroupOfflineSentMessagesByPrefix(`${this.groupOfflineBucketPrefix}/${groupId}/`);
    this.expirePendingGroupInviteNotifications(groupId);
  }

  private expirePendingGroupInviteNotifications(groupId: string): void {
    const notifications = this.deps.database.getPendingGroupInvitationNotifications();
    for (const notification of notifications) {
      try {
        const payload = JSON.parse(notification.notification_data) as { groupId?: string };
        if (payload.groupId === groupId) {
          this.deps.database.updateNotificationStatus(notification.id, 'expired');
        }
      } catch {
        continue;
      }
    }
  }

  private normalizeRemoteEventTimestamp(
    timestamp: number,
    messageType: 'STATE_UPDATE' | 'KICK' | 'DISBAND',
    groupId: string,
    messageId: string,
  ): number {
    const now = Date.now();
    if (timestamp > now + GROUP_MESSAGE_MAX_FUTURE_SKEW_MS) {
      console.warn(
        `[GROUP][${messageType}][TIMESTAMP_CLAMP] group=${groupId} msgId=${messageId} remoteTs=${timestamp} clampedTs=${now}`,
      );
      return now;
    }
    return timestamp;
  }

  private async appendMembershipSystemMessage(
    chatId: number,
    groupId: string,
    keyVersion: number,
    event: 'join' | 'leave' | 'kick',
    targetPeerId: string,
    targetUsername: string | undefined,
    senderPeerId: string,
    senderUsername: string,
    eventTimestamp: number,
  ): Promise<void> {
    const messageId = `group-system-${event}-${groupId}-${keyVersion}-${targetPeerId}`;
    if (this.deps.database.messageExists(messageId)) return;

    const resolvedUsername = targetUsername
      ?? this.deps.database.getUserByPeerId(targetPeerId)?.username
      ?? targetPeerId.slice(-8);
    const content = event === 'join'
      ? targetPeerId === this.deps.myPeerId
        ? 'You joined the group'
        : `${resolvedUsername} joined the group`
      : event === 'leave'
        ? `${resolvedUsername} left the group`
        : targetPeerId === this.deps.myPeerId
          ? 'You were removed from the group'
          : `${resolvedUsername} was removed from the group`;
    const appliedTimestamp = Date.now();

    await this.deps.database.createMessage({
      id: messageId,
      chat_id: chatId,
      sender_peer_id: senderPeerId,
      content,
      message_type: 'system',
      timestamp: new Date(appliedTimestamp),
      event_timestamp: new Date(eventTimestamp),
    });

    this.deps.onMessageReceived?.({
      chatId,
      messageId,
      content,
      senderPeerId,
      senderUsername,
      timestamp: appliedTimestamp,
      eventTimestamp,
      messageSentStatus: 'online',
      messageType: 'system',
    });
  }

  private async appendDisbandSystemMessage(
    chatId: number,
    groupId: string,
    senderPeerId: string,
    senderUsername: string,
    eventTimestamp: number,
  ): Promise<void> {
    const messageId = `group-system-disband-${groupId}`;
    if (this.deps.database.messageExists(messageId)) return;

    const content = 'This group was disbanded by the creator.';
    const appliedTimestamp = Date.now();
    await this.deps.database.createMessage({
      id: messageId,
      chat_id: chatId,
      sender_peer_id: senderPeerId,
      content,
      message_type: 'system',
      timestamp: new Date(appliedTimestamp),
      event_timestamp: new Date(eventTimestamp),
    });

    this.deps.onMessageReceived?.({
      chatId,
      messageId,
      content,
      senderPeerId,
      senderUsername,
      timestamp: appliedTimestamp,
      eventTimestamp,
      messageSentStatus: 'online',
      messageType: 'system',
    });
  }
}
