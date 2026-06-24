import { useState, useEffect, useRef } from "react";
import { useSelector, useDispatch } from "react-redux";
import type { RootState } from "../../../state/store";
import { UserPlus, AlertCircle, Users, Clock, Phone, PhoneOff, Loader2 } from "lucide-react";
import { updateChat, clearMessages, removeChat, setOfflineFetchStatus, markOfflineFetched, markOfflineFetchFailed } from "../../../state/slices/chatSlice";
import { AboutUserModal } from "./AboutUserModal";
import { useToast } from "../../ui/use-toast";
import { validateUsername } from "../../../utils/general";
import { InviteUsersDialog, type GroupInviteDeliveryView } from "./InviteUsersDialog";
import { INBOUND_INACTIVITY_WARNING_MS, MAX_GROUP_MEMBERS } from "../../../constants";
import { getGroupStatusMessage, isGroupStatusWaiting } from "../../../utils/groupStatusMessages";
import { getGroupCreatorLinkState } from "../../../utils/groupCreatorLinkHealth";
import { callService } from "../../../lib/call/callService";
import { groupCallService } from "../../../lib/call/groupCallService";
import type { NetworkMode } from "../../../../core/types";
import type { ChatHeaderGroupMember, GroupInfoDetails } from "./ChatHeaderDialogTypes";
import { DeleteAllMessagesDialog } from "./DeleteAllMessagesDialog";
import { DeleteChatAndUserDialog } from "./DeleteChatAndUserDialog";
import { DeleteGroupChatDialog } from "./DeleteGroupChatDialog";
import { LeaveGroupDialog } from "./LeaveGroupDialog";
import { GroupInfoDialog } from "./GroupInfoDialog";
import { KickMemberDialog } from "./KickMemberDialog";
import { EditUsernameDialog } from "./EditUsernameDialog";
import { ChatHeaderCallControls } from "./ChatHeaderCallControls";
import { ChatHeaderMenu } from "./ChatHeaderMenu";
import { errStr } from '../../../../core/utils/general-error';
import { Button } from "../../ui/Button";
import { useConnectivityGuidance } from "../../../hooks/useConnectivityGuidance";

type ChatHeaderProps = {
  username: string;
  peerId: string;
  chatType?: 'direct' | 'group';
  groupStatus?: string;
  chatId?: number;
  onSelectMessages?: () => void;
}

export const ChatHeader = ({
  username,
  peerId,
  chatType,
  groupStatus,
  chatId,
  onSelectMessages,
}: ChatHeaderProps) => {
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const chats = useSelector((state: RootState) => state.chat.chats);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const activeCall = useSelector((state: RootState) => state.call.activeCall);
  const dispatch = useDispatch();
  const { toast } = useToast();
  const { confirmCallAttempt } = useConnectivityGuidance();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteChatAndUserConfirmOpen, setDeleteChatAndUserConfirmOpen] = useState(false);
  const [deleteGroupChatConfirmOpen, setDeleteGroupChatConfirmOpen] = useState(false);
  const [leaveGroupConfirmOpen, setLeaveGroupConfirmOpen] = useState(false);
  const [isLeavingGroup, setIsLeavingGroup] = useState(false);
  const [kickMemberDialogOpen, setKickMemberDialogOpen] = useState(false);
  const [selectedKickPeerId, setSelectedKickPeerId] = useState<string | null>(null);
  const [isKickingMember, setIsKickingMember] = useState(false);
  const [inviteUsersDialogOpen, setInviteUsersDialogOpen] = useState(false);
  const [isRequestingGroupUpdate, setIsRequestingGroupUpdate] = useState(false);
  const [isCurrentUserGroupCreator, setIsCurrentUserGroupCreator] = useState(false);
  const [groupInfoDialogOpen, setGroupInfoDialogOpen] = useState(false);
  const [groupInfoLoading, setGroupInfoLoading] = useState(false);
  const [groupInfoDetails, setGroupInfoDetails] = useState<GroupInfoDetails | null>(null);
  const [editUsernameModalOpen, setEditUsernameModalOpen] = useState(false);
  const [isStartingGroupCall, setIsStartingGroupCall] = useState(false);
  const [isJoiningGroupCall, setIsJoiningGroupCall] = useState(false);
  const [isLeavingGroupCall, setIsLeavingGroupCall] = useState(false);
  const [groupCallSnapshot, setGroupCallSnapshot] = useState(() => groupCallService.getSnapshot());
  const [newUsername, setNewUsername] = useState('');
  const [networkMode, setNetworkMode] = useState<NetworkMode | null>(null);
  const [validationError, setValidationError] = useState("");
  const [groupMembers, setGroupMembers] = useState<ChatHeaderGroupMember[]>([]);
  const creatorPermissionRequestRef = useRef(0);

  const fetchGroupMembers = async () => {
    if (chatType !== 'group' || !chatId) return;
    try {
      const result = await window.kiyeovoAPI.getGroupMembers(chatId);
      if (result.success) {
        setGroupMembers(result.members);
      }
    } catch (error) {
      console.error('Failed to fetch group members:', error);
    }
  };

  useEffect(() => {
    fetchGroupMembers();
  }, [chatType, chatId]);

  useEffect(() => {
    let cancelled = false;
    const loadNetworkMode = async () => {
      try {
        const result = await window.kiyeovoAPI.getNetworkMode();
        if (!cancelled && result.success) {
          setNetworkMode(result.mode);
        }
      } catch (error) {
        console.error('Failed to fetch network mode for call controls:', error);
      }
    };

    void loadNetworkMode();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return groupCallService.subscribe((event) => {
      if (event.type === 'state') {
        setGroupCallSnapshot(event.snapshot);
      }
    });
  }, []);

  useEffect(() => {
    if (!isLeavingGroupCall) {
      return;
    }
    if (
      !activeChat?.groupId
      || groupCallSnapshot.groupId !== activeChat.groupId
      || groupCallSnapshot.state === 'idle'
      || groupCallSnapshot.state === 'ended'
    ) {
      console.info(
        `[GROUP-CALL][UI][HEADER_BUTTON][LEAVE_CLEAR] chat=${chatId ?? 'none'} activeGroup=${activeChat?.groupId ?? 'none'} ` +
        `snapshotGroup=${groupCallSnapshot.groupId || 'none'} snapshotState=${groupCallSnapshot.state}`,
      );
      setIsLeavingGroupCall(false);
    }
  }, [activeChat?.groupId, chatId, groupCallSnapshot.groupId, groupCallSnapshot.state, isLeavingGroupCall]);

  useEffect(() => {
    setNewUsername('');
    setValidationError('');
  }, [peerId, username]);

  const loadGroupInfo = async () => {
    if (chatType !== 'group' || !chatId) return;
    setGroupInfoLoading(true);
    try {
      const [chatResult, membersResult] = await Promise.all([
        window.kiyeovoAPI.getChatById(chatId),
        window.kiyeovoAPI.getGroupMembers(chatId),
      ]);

      if (membersResult.success) {
        setGroupMembers(membersResult.members);
      }

      if (chatResult.success && chatResult.chat) {
        const chat = chatResult.chat;
        setGroupInfoDetails({
          groupId: chat.group_id || '',
          keyVersion: chat.key_version ?? 0,
          groupStatus: chat.group_status || chat.status || 'unknown',
          createdByPeerId: chat.group_creator_peer_id || chat.created_by || '',
          creatorUsername: chat.group_creator_username || activeChat?.groupCreatorUsername || '',
          createdAt: chat.created_at ? new Date(chat.created_at) : null,
        });
      } else {
        setGroupInfoDetails(null);
      }
    } catch (error) {
      console.error('Failed to load group info:', error);
      setGroupInfoDetails(null);
    } finally {
      setGroupInfoLoading(false);
    }
  };

  useEffect(() => {
    if (!groupInfoDialogOpen) return;
    void loadGroupInfo();
  }, [groupInfoDialogOpen, chatType, chatId]);

  const refreshGroupCreatorPermission = async () => {
    if (chatType !== 'group' || !chatId) {
      setIsCurrentUserGroupCreator(false);
      return;
    }

    const requestId = ++creatorPermissionRequestRef.current;
    try {
      const chatResult = await window.kiyeovoAPI.getChatById(chatId);
      if (requestId !== creatorPermissionRequestRef.current) return;
      if (!chatResult.success || !chatResult.chat || !myPeerId) {
        setIsCurrentUserGroupCreator(false);
        return;
      }

      setIsCurrentUserGroupCreator(chatResult.chat.created_by === myPeerId);
    } catch (error) {
      if (requestId !== creatorPermissionRequestRef.current) return;
      console.error('Failed to resolve group creator permission:', error);
      setIsCurrentUserGroupCreator(false);
    }
  };

  useEffect(() => {
    void refreshGroupCreatorPermission();
  }, [chatType, chatId, myPeerId]);

  // Refresh member list whenever an offline-message fetch completes (invite responses arrive)
  useEffect(() => {
    if (chatType !== 'group') return;
    const unsub = window.kiyeovoAPI.onOfflineMessagesFetchComplete(() => {
      void fetchGroupMembers();
    });
    return unsub;
  }, [chatType, chatId]);

  // Refresh member list immediately when creator-side membership updates are processed.
  useEffect(() => {
    if (chatType !== 'group' || !chatId) return;
    const unsub = window.kiyeovoAPI.onGroupMembersUpdated((data) => {
      if (data.chatId === chatId) {
        void (async () => {
          await fetchGroupMembers();
          await refreshGroupCreatorPermission();

          // Keep group status in sync without requiring app restart.
          const chatResult = await window.kiyeovoAPI.getChatById(chatId);
          if (chatResult.success && chatResult.chat) {
            dispatch(updateChat({
              id: chatId,
              updates: {
                status: chatResult.chat.status,
                groupStatus: chatResult.chat.group_status,
              }
            }));
          }
        })();
      }
    });
    return unsub;
  }, [chatType, chatId, dispatch]);

  useEffect(() => {
    const checkBlockedStatus = async () => {
      if (!peerId || !activeChat) return;

      try {
        const result = await window.kiyeovoAPI.isUserBlocked(peerId);
        if (result.success) {
          setIsBlocked(result.blocked);
          dispatch(updateChat({
            id: activeChat.id,
            updates: { blocked: result.blocked }
          }));
        }
      } catch (error) {
        console.error('Failed to check blocked status:', error);
      }
    };

    checkBlockedStatus();
  }, [peerId, activeChat?.id, dispatch]);

  const handleToggleMute = async () => {
    if (!activeChat) return;

    try {
      const result = await window.kiyeovoAPI.toggleChatMute(activeChat.id);
      if (result.success) {
        dispatch(updateChat({
          id: activeChat.id,
          updates: { muted: result.muted }
        }));
      }
    } catch (error) {
      console.error('Failed to toggle mute:', error);
    }
    setDropdownOpen(false);
  };

  const handleToggleBlock = async () => {
    if (!peerId || !activeChat) return;

    try {
      if (isBlocked) {
        const result = await window.kiyeovoAPI.unblockUser(peerId);
        if (result.success) {
          setIsBlocked(false);
          dispatch(updateChat({
            id: activeChat.id,
            updates: { blocked: false }
          }));
        }
      } else {
        const result = await window.kiyeovoAPI.blockUser(peerId, username, null);
        if (result.success) {
          setIsBlocked(true);
          dispatch(updateChat({
            id: activeChat.id,
            updates: { blocked: true }
          }));
        }
      }
    } catch (error) {
      console.error('Failed to toggle block:', error);
    }
    setDropdownOpen(false);
  };

  const handleAboutUser = () => {
    setAboutModalOpen(true);
    setDropdownOpen(false);
  };

  const handleDeleteAllMessages = () => {
    setDeleteConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleDeleteChatAndUser = () => {
    setDeleteChatAndUserConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleSelectMessages = () => {
    onSelectMessages?.();
    setDropdownOpen(false);
  };

  const handleDeleteGroupChat = () => {
    setDeleteGroupChatConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleEditUsername = () => {
    setNewUsername('');
    setValidationError('');
    setEditUsernameModalOpen(true);
    setDropdownOpen(false);
  };

  const handleLeaveGroup = () => {
    setLeaveGroupConfirmOpen(true);
    setDropdownOpen(false);
  };

  const handleAboutGroup = () => {
    setGroupInfoDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleKickMember = () => {
    setSelectedKickPeerId(null);
    setKickMemberDialogOpen(true);
    setDropdownOpen(false);
  };

  const handleInviteUsers = () => {
    const run = async () => {
      if (!chatId || !myPeerId) {
        toast.error('Only the group creator can invite users');
        setDropdownOpen(false);
        return;
      }

      try {
        const chatResult = await window.kiyeovoAPI.getChatById(chatId);
        const canInvite = Boolean(chatResult.success && chatResult.chat && chatResult.chat.created_by === myPeerId);
        if (!canInvite) {
          setIsCurrentUserGroupCreator(false);
          toast.error('Only the group creator can invite users');
          setDropdownOpen(false);
          return;
        }
      } catch (error) {
        console.error('Failed to verify creator permission for invite:', error);
        toast.error('Failed to verify invite permissions');
        setDropdownOpen(false);
        return;
      }

      if (availableInviteSlots <= 0) {
        toast.info('Group member limit reached');
        setDropdownOpen(false);
        return;
      }

      setInviteUsersDialogOpen(true);
      setDropdownOpen(false);
    };
    void run();
  };

  const handleInviteUsersSuccess = async (inviteDeliveries: GroupInviteDeliveryView[]) => {
    const sentCount = inviteDeliveries.filter((delivery) => delivery.status === 'sent').length;
    const queuedCount = inviteDeliveries.filter((delivery) => delivery.status === 'queued_for_retry').length;

    if (sentCount > 0 && queuedCount === 0) {
      toast.success(`Sent ${sentCount} invite(s)`);
    } else {
      const parts: string[] = [];
      if (sentCount > 0) parts.push(`Sent ${sentCount}`);
      if (queuedCount > 0) parts.push(`queued ${queuedCount} for retry`);
      toast.warning(parts.length > 0 ? `${parts.join(', ')} invite(s)` : 'No users were invited');
    }

    await fetchGroupMembers();
  };

  const handleReinviteUser = async (targetPeerId: string): Promise<{ success: boolean; error?: string }> => {
    if (!chatId) {
      return { success: false, error: 'Group chat not found' };
    }
    try {
      const result = await window.kiyeovoAPI.reinviteUserToGroup(chatId, targetPeerId);
      if (!result.success) {
        const error = result.error || 'Failed to re-invite user';
        toast.error(error);
        return { success: false, error };
      }
      const targetUsername = groupMembers.find((m) => m.peerId === targetPeerId)?.username ?? targetPeerId;
      toast.success(`Re-invited ${targetUsername}`);
      await fetchGroupMembers();
      return { success: true };
    } catch (error) {
      const errorMessage = errStr(error, 'Failed to re-invite user');
      toast.error(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const handleCheckMissedGroupMessages = async () => {
    if (!chatId) return;
    setDropdownOpen(false);
    dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));

    try {
      const result = await window.kiyeovoAPI.checkGroupOfflineMessagesForChat(chatId);
      if (!result.success) {
        toast.error(result.error || 'Failed to check missed group messages');
        dispatch(markOfflineFetchFailed(chatId));
        return;
      }

      if ((result.failedChatIds ?? []).includes(chatId)) {
        dispatch(markOfflineFetchFailed(chatId));
        toast.error('Failed to fetch offline messages');
        return;
      }
      dispatch(markOfflineFetched(chatId));

      const unreadMap = result.unreadFromChats instanceof Map
        ? result.unreadFromChats
        : new Map<number, number>();
      const unread = unreadMap.get(chatId) ?? 0;
      const chatWarnings = result.gapWarnings.filter(w => w.chatId === chatId);

      if (unread > 0) {
        toast.success(`Fetched ${unread} missed group message${unread === 1 ? '' : 's'}`);
      } else {
        toast.info('No missed group messages found');
      }

      if (chatWarnings.length > 0) {
        toast.warning(`Detected ${chatWarnings.length} sequence gap(s); some old messages may be missing`);
      }

      await syncGroupCallEvidence(chatId);
      await fetchGroupMembers();
    } catch (error) {
      console.error('Failed to check missed group messages:', error);
      toast.error('Failed to check missed group messages');
      dispatch(markOfflineFetchFailed(chatId));
    }
  };

  const syncGroupCallEvidence = async (targetChatId: number) => {
    const chatResult = await window.kiyeovoAPI.getChatById(targetChatId);
    if (!chatResult.success || !chatResult.chat) {
      return null;
    }

    dispatch(updateChat({
      id: targetChatId,
      updates: {
        lastKnownActiveCallId: chatResult.chat.last_known_active_call_id ?? null,
        lastKnownActiveCallSeenAt: chatResult.chat.last_known_active_call_seen_at ?? null,
      },
    }));
    return chatResult.chat;
  };

  const handleStartGroupCall = async () => {
    if (!chatId) return;

    setIsStartingGroupCall(true);
    try {
      const audioReady = await groupCallService.prepareLocalAudio();
      if (!audioReady.success) {
        toast.error(audioReady.error || 'Microphone access is required for group calls');
        return;
      }
      const result = await window.kiyeovoAPI.startGroupCall(chatId);
      await syncGroupCallEvidence(chatId);

      if (!result.success) {
        groupCallService.releasePreparedLocalAudio();
        toast.error(result.error || 'Failed to start group call');
        return;
      }

      if (result.outcome === 'existing') {
        const snapshot = groupCallService.getSnapshot();
        if (
          result.callId
          && snapshot.groupId === activeChat?.groupId
          && snapshot.callId === result.callId
          && snapshot.state !== 'idle'
          && snapshot.state !== 'ended'
        ) {
          toast.info('You are already in this group call.');
          return;
        }

        const joinOutcome = await handleJoinGroupCall({ suppressStaleClearedToast: true });
        if (joinOutcome === 'stale_cleared') {
          toast.info('This call may have ended. Try starting again.');
        }
        return;
      }

      toast.success('Group call started. Waiting for participants.');
    } catch (error) {
      groupCallService.releasePreparedLocalAudio();
      console.error('Failed to start group call:', error);
      toast.error('Failed to start group call');
    } finally {
      setIsStartingGroupCall(false);
    }
  };

  const handleJoinGroupCall = async (
    options?: { suppressStaleClearedToast?: boolean },
  ): Promise<'joined' | 'existing' | 'stale_cleared' | 'failed'> => {
    if (!chatId) return 'failed';

    setIsJoiningGroupCall(true);
    try {
      const audioReady = await groupCallService.prepareLocalAudio();
      if (!audioReady.success) {
        toast.error(audioReady.error || 'Microphone access is required for group calls');
        return 'failed';
      }
      const result = await window.kiyeovoAPI.joinGroupCall(chatId);
      const refreshedChat = await syncGroupCallEvidence(chatId);

      if (!result.success) {
        groupCallService.releasePreparedLocalAudio();
        if (result.reason === 'host_reconnecting') {
          toast.info(result.error || 'The host is reconnecting. Please try again shortly.');
          return 'failed';
        }
        if (
          result.error === 'This call may have ended'
          && !refreshedChat?.last_known_active_call_id
        ) {
          if (!options?.suppressStaleClearedToast) {
            toast.info('Stale call info cleared. Click again to start a new call.');
          }
          return 'stale_cleared';
        }
        toast.error(result.error || 'Failed to join group call');
        return 'failed';
      }

      if (result.outcome === 'existing') {
        toast.info('You are already in this group call.');
        return 'existing';
      }

      toast.success('Joined group call. Connecting audio...');
      return 'joined';
    } catch (error) {
      groupCallService.releasePreparedLocalAudio();
      console.error('Failed to join group call:', error);
      toast.error('Failed to join group call');
      return 'failed';
    } finally {
      setIsJoiningGroupCall(false);
    }
  };

  const handleGroupCallButtonClick = async () => {
    if (!chatId) return;

    if (
      groupCallSnapshot.groupId
      && groupCallSnapshot.groupId === activeChat?.groupId
      && groupCallSnapshot.state !== 'idle'
      && groupCallSnapshot.state !== 'ended'
    ) {
      setIsLeavingGroupCall(true);
      try {
        const result = await groupCallService.leave();
        if (!result.success) {
          setIsLeavingGroupCall(false);
          toast.error(result.error || 'Failed to leave group call');
        }
      } catch (error) {
        setIsLeavingGroupCall(false);
        toast.error(errStr(error, 'Failed to leave group call'));
      }
      return;
    }

    if (!(await confirmCallAttempt())) {
      return;
    }

    const freshChat = await syncGroupCallEvidence(chatId);
    const latestKnownCallId = freshChat?.last_known_active_call_id ?? null;

    if (latestKnownCallId) {
      const joinOutcome = await handleJoinGroupCall({ suppressStaleClearedToast: true });
      if (joinOutcome === 'stale_cleared') {
        const refreshedChat = await syncGroupCallEvidence(chatId);
        if (refreshedChat?.last_known_active_call_id) {
          toast.info('A group call is already active in this chat.');
          return;
        }
        await handleStartGroupCall();
      }
      return;
    }

    await handleStartGroupCall();
  };

  const handleCheckMissedDirectMessages = async () => {
    if (!chatId) return;
    setDropdownOpen(false);
    dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));

    try {
      const result = await window.kiyeovoAPI.checkOfflineMessagesForChat(chatId);
      if (!result.success) {
        toast.error(result.error || 'Failed to check missed messages');
        dispatch(markOfflineFetchFailed(chatId));
        return;
      }

      dispatch(markOfflineFetched(chatId));

      const unreadMap = result.unreadFromChats instanceof Map
        ? result.unreadFromChats
        : new Map<number, number>();
      const unread = unreadMap.get(chatId) ?? 0;

      if (unread > 0) {
        toast.success(`Fetched ${unread} missed message${unread === 1 ? '' : 's'}`);
      } else {
        toast.info('No missed messages found');
      }
    } catch (error) {
      console.error('Failed to check missed messages:', error);
      toast.error('Failed to check missed messages');
      dispatch(markOfflineFetchFailed(chatId));
    }
  };

  const handleRequestGroupUpdate = async () => {
    if (!chatId || isRequestingGroupUpdate) return;
    setDropdownOpen(false);
    setIsRequestingGroupUpdate(true);
    try {
      const result = await window.kiyeovoAPI.requestGroupUpdate(chatId);
      if (!result.success) {
        toast.error(result.error || 'Failed to request group update');
        return;
      }
      toast.info('Group update request sent');
    } catch (error) {
      toast.error(errStr(error, 'Failed to request group update'));
    } finally {
      setIsRequestingGroupUpdate(false);
    }
  };

  const handleStartCallClick = async () => {
    if (!peerId || !activeChat || activeChat.type !== 'direct') return;
    if (isBlocked) {
      toast.error('Cannot call a blocked user');
      return;
    }

    const isSamePeerActiveCall = Boolean(
      activeCall
      && activeCall.peerId === peerId
      && activeCall.callId
    );

    if (isSamePeerActiveCall && activeCall) {
      const hangup = await callService.hangupCall(peerId, activeCall.callId, 'hangup');
      if (!hangup.success) {
        toast.error(hangup.error || 'Failed to end call');
      }
      return;
    }
    if (!(await confirmCallAttempt())) {
      return;
    }
    const start = await callService.startOutgoingCall(peerId);
    if (!start.success) {
      toast.error(start.error || 'Failed to start call');
    }
  };

  const handleCallClick = () => {
    void handleStartCallClick();
  };

  const confirmDeleteAllMessages = async () => {
    if (!activeChat) return;

    setIsDeleting(true);
    try {
      const result = await window.kiyeovoAPI.deleteAllMessages(activeChat.id);
      if (result.success) {
        dispatch(clearMessages(activeChat.id));
        dispatch(updateChat({
          id: activeChat.id,
          updates: {
            lastMessage: "SYSTEM: No messages yet",
            lastMessageTimestamp: Date.now()
          }
        }));
      }
    } catch (error) {
      console.error('Failed to delete all messages:', error);
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };
  const confirmDeleteChatAndUser = async () => {
    if (!activeChat || !activeChat.peerId) return;

    setIsDeleting(true);
    try {
      const result = await window.kiyeovoAPI.deleteChatAndUser(activeChat.id, activeChat.peerId);
      if (result.success) {
        dispatch(removeChat(activeChat.id));
        toast.info("Chat and user deleted successfully");
      }
    } catch (error) {
      console.error('Failed to delete all messages:', error);
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
    }
  };

  const confirmDeleteGroupChat = async () => {
    if (!activeChat || activeChat.type !== 'group') return;

    setIsDeleting(true);
    try {
      const result = await window.kiyeovoAPI.deleteChat(activeChat.id);
      if (!result.success) {
        toast.error(result.error || 'Failed to delete chat');
        return;
      }
      dispatch(removeChat(activeChat.id));
      toast.info('Chat deleted');
      setDeleteGroupChatConfirmOpen(false);
    } catch (error) {
      console.error('Failed to delete group chat:', error);
      toast.error('Failed to delete chat');
    } finally {
      setIsDeleting(false);
    }
  };

  const confirmEditUsername = async () => {
    if (!activeChat || !activeChat.peerId) return;
    const error = validateUsername(newUsername, activeChat.peerId);
    if (error) {
      setValidationError(error);
      return;
    }
    if (chats.find((chat) => chat.username === newUsername || chat.name === newUsername)) {
      setValidationError("Username already exists");
      return;
    }
    const result = await window.kiyeovoAPI.updateUsername(activeChat.peerId, newUsername);
    if (result.success) {
      toast.info("Contact updated successfully");
      setEditUsernameModalOpen(false);
      setValidationError("");
      dispatch(updateChat({
        id: activeChat.id,
        updates: { username: newUsername, name: newUsername }
      }));
    } else {
      toast.error("Failed to update username");
    }
  };

  const confirmLeaveGroup = async () => {
    if (!activeChat || activeChat.type !== 'group') return;

    setIsLeavingGroup(true);
    try {
      const result = isCurrentUserGroupCreator
        ? await window.kiyeovoAPI.disbandGroup(activeChat.id)
        : await window.kiyeovoAPI.leaveGroup(activeChat.id);
      if (!result.success) {
        toast.error(result.error || (isCurrentUserGroupCreator ? 'Failed to disband group' : 'Failed to leave group'));
        return;
      }

      if (isCurrentUserGroupCreator) {
        const refreshed = await window.kiyeovoAPI.getChatById(activeChat.id);
        if (refreshed.success && refreshed.chat) {
          dispatch(updateChat({
            id: activeChat.id,
            updates: {
              status: refreshed.chat.status,
              groupStatus: refreshed.chat.group_status,
            },
          }));
        } else {
          dispatch(updateChat({
            id: activeChat.id,
            updates: { groupStatus: 'disbanded' },
          }));
        }
      } else {
        dispatch(removeChat(activeChat.id));
      }
      toast.info(isCurrentUserGroupCreator ? 'Group disbanded' : 'You left the group');
      setLeaveGroupConfirmOpen(false);
    } catch (error) {
      console.error('Failed to leave group:', error);
      toast.error(isCurrentUserGroupCreator ? 'Failed to disband group' : 'Failed to leave group');
    } finally {
      setIsLeavingGroup(false);
    }
  };

  const confirmKickMember = async () => {
    if (!activeChat || activeChat.type !== 'group' || !selectedKickPeerId) return;

    setIsKickingMember(true);
    try {
      const result = await window.kiyeovoAPI.kickGroupMember(activeChat.id, selectedKickPeerId);
      if (!result.success) {
        toast.error(result.error || 'Failed to remove member');
        return;
      }

      const targetName = groupMembers.find((m) => m.peerId === selectedKickPeerId)?.username ?? 'Member';
      toast.info(`${targetName} was removed from the group`);
      setKickMemberDialogOpen(false);
      setSelectedKickPeerId(null);
      await fetchGroupMembers();
      await refreshGroupCreatorPermission();
    } catch (error) {
      console.error('Failed to remove group member:', error);
      toast.error('Failed to remove member');
    } finally {
      setIsKickingMember(false);
    }
  };

  const isGroup = chatType === 'group';
  const resolvedGroupStatus = groupStatus ?? activeChat?.groupStatus;
  const hasActiveCallWithThisPeer = Boolean(
    activeCall
    && activeCall.peerId === peerId
  );
  const canShowCallButtons = !isGroup && networkMode === 'fast';
  const canShowGroupCallButton = isGroup && networkMode === 'fast';
  const canStartDirectCall = !isGroup
    && activeChat?.status === 'active'
    && !isBlocked
    && Boolean(peerId);
  const canStartGroupCall = isGroup
    && activeChat?.status === 'active'
    && (resolvedGroupStatus === 'active' || resolvedGroupStatus === 'rekeying')
    && !activeCall;
  const isGroupCallSyncBlocked = isGroup && (
    activeChat?.fetchedOffline !== true
    || activeChat?.isFetchingOffline === true
    || activeChat?.offlineFetchNeedsSync === true
  );
  const hasKnownGroupCall = Boolean(activeChat?.lastKnownActiveCallId);
  const isInThisGroupCall = Boolean(
    activeChat?.groupId
    && groupCallSnapshot.groupId === activeChat.groupId
    && groupCallSnapshot.state !== 'idle'
    && groupCallSnapshot.state !== 'ended',
  );
  const hasAnotherPeerActiveCall = Boolean(activeCall) && !hasActiveCallWithThisPeer;
  const startCallDisabled = !canStartDirectCall || hasAnotherPeerActiveCall;
  const groupCallActionDisabled = isInThisGroupCall
    ? isLeavingGroupCall
    : !canStartGroupCall || isGroupCallSyncBlocked || isStartingGroupCall || isJoiningGroupCall;
  const callButtonTitle = startCallDisabled
    ? 'User is offline or another call is active'
    : 'Start call';

  const groupCallButtonTitle = groupCallActionDisabled
    ? isLeavingGroupCall
      ? 'Leaving group call'
      : isStartingGroupCall
        ? 'Starting group call'
        : isJoiningGroupCall
          ? 'Joining group call'
          : isGroupCallSyncBlocked
            ? activeChat?.offlineFetchNeedsSync
              ? 'Sync group updates before using group calls'
              : 'Wait for group updates to finish syncing before using group calls'
            : 'Group call is unavailable right now'
    : isInThisGroupCall
      ? 'Leave group call'
      : hasKnownGroupCall
        ? 'Join group call'
        : 'Start group call';
  // const groupCallButtonLabel = isStartingGroupCall
  //   ? 'Starting...'
  //   : isJoiningGroupCall
  //     ? 'Joining...'
  //     : isInThisGroupCall
  //       ? 'In Call'
  //       : hasKnownGroupCall
  //         ? 'Join Call'
  //         : 'Start Call';
  const groupCallStatusTone = isStartingGroupCall || isJoiningGroupCall || isLeavingGroupCall
    ? 'text-primary'
    : isGroupCallSyncBlocked
      ? 'text-warning'
      : isInThisGroupCall || hasKnownGroupCall
        ? 'text-emerald-600'
        : 'text-muted-foreground';

  const groupCallStatusMessage = isLeavingGroupCall
    ? 'Leaving group call...'
    : isStartingGroupCall
      ? 'Starting group call... wait up to 10 seconds'
      : isJoiningGroupCall
        ? 'Joining group call... wait up to 10 seconds'
        : isInThisGroupCall
          ? null
          : isGroupCallSyncBlocked
            ? activeChat?.offlineFetchNeedsSync
              ? 'Sync group updates before joining a call'
              : 'Syncing group updates...'
            : hasKnownGroupCall
              ? 'Group call may already be active'
              : null;
  const showGroupCallStatusMessage = isGroup && Boolean(groupCallStatusMessage);
  const groupCallButtonVisualState = isLeavingGroupCall
    ? 'leaving'
    : isStartingGroupCall
      ? 'starting'
      : isJoiningGroupCall
        ? 'joining'
        : isInThisGroupCall
          ? 'hangup'
          : hasKnownGroupCall
            ? 'join'
            : 'start';
  const groupCreatorLinkState = activeChat
    ? getGroupCreatorLinkState(activeChat, chats, myPeerId)
    : { broken: false };
  const isFetchingGroupUpdates = isGroup && activeChat?.isFetchingOffline === true;
  const groupStatusMessage = !isGroup ? null : getGroupStatusMessage(groupStatus);
  const showGroupStateMessage = Boolean(groupStatusMessage);
  const showDirectInactivityWarning = !isGroup
    && typeof activeChat?.lastInboundActivityTimestamp === 'number'
    && (Date.now() - activeChat.lastInboundActivityTimestamp) >= INBOUND_INACTIVITY_WARNING_MS;

  useEffect(() => {
    if (!isGroup) {
      return;
    }
    console.info(
      `[GROUP-CALL][UI][HEADER_BUTTON] chat=${chatId ?? 'none'} activeGroup=${activeChat?.groupId ?? 'none'} ` +
      `snapshotGroup=${groupCallSnapshot.groupId || 'none'} snapshotState=${groupCallSnapshot.state} ` +
      `inThis=${String(isInThisGroupCall)} starting=${String(isStartingGroupCall)} ` +
      `joining=${String(isJoiningGroupCall)} leaving=${String(isLeavingGroupCall)} ` +
      `syncBlocked=${String(isGroupCallSyncBlocked)} disabled=${String(groupCallActionDisabled)} ` +
      `visual=${groupCallButtonVisualState}`,
    );
  }, [
    activeChat?.groupId,
    chatId,
    groupCallActionDisabled,
    groupCallButtonVisualState,
    groupCallSnapshot.groupId,
    groupCallSnapshot.state,
    isGroup,
    isGroupCallSyncBlocked,
    isInThisGroupCall,
    isJoiningGroupCall,
    isLeavingGroupCall,
    isStartingGroupCall,
  ]);

  const memberSummary = groupMembers.length > 0
    ? groupMembers.map(m => m.status === 'pending' ? `${m.username} (invited)` : m.username).sort().join(', ')
    : 'No members yet';
  const availableInviteSlots = Math.max(0, MAX_GROUP_MEMBERS - (groupMembers.length + 1));
  const disabledInvitePeers = groupMembers.map((member) => ({
    peerId: member.peerId,
    reason: member.status === 'pending' ? 'Invite pending' : 'Already in group',
  }));
  const pendingInvitePeers = groupMembers
    .filter((member) => member.status === 'pending')
    .map((member) => ({ peerId: member.peerId, username: member.username }));
  const kickableMembers = groupMembers.filter(
    (member) => member.status === 'confirmed' || member.status === 'accepted',
  );
  const groupInfoCreatorName = isCurrentUserGroupCreator
    ? 'You'
    : (groupInfoDetails?.creatorUsername || activeChat?.groupCreatorUsername || 'Unknown');
  const groupInfoCreatorPeerId = groupInfoDetails?.createdByPeerId || activeChat?.groupCreatorPeerId || 'Unknown';
  const groupInfoStatus = groupInfoDetails?.groupStatus || groupStatus || 'unknown';
  const groupInfoCreatedAt = groupInfoDetails?.createdAt
    ? groupInfoDetails.createdAt.toLocaleString()
    : 'Unknown';
  const confirmedGroupMemberCount = groupMembers.filter((member) => member.status === 'confirmed').length;
  const invitedOrPendingGroupMemberCount = groupMembers.filter((member) => member.status !== 'confirmed').length;
  const groupInfoMemberCount = confirmedGroupMemberCount + 1; // Include current user
  const leaveDialogTitle = isCurrentUserGroupCreator ? 'Disband Group' : 'Leave Group';
  const leaveDialogDescription = isCurrentUserGroupCreator
    ? 'Are you sure you want to disband this group?'
    : 'Are you sure you want to leave this group?';
  const leaveConfirmLabel = isCurrentUserGroupCreator
    ? (isLeavingGroup ? 'Disbanding...' : 'Disband Group')
    : (isLeavingGroup ? 'Leaving...' : 'Leave Group');
  const canShowLeaveOrDisband = isCurrentUserGroupCreator
    ? resolvedGroupStatus !== 'rekeying' && resolvedGroupStatus !== 'disbanded'
    : resolvedGroupStatus === 'active';
  const canRequestGroupUpdate = isGroup
    && !isCurrentUserGroupCreator
    && !groupCreatorLinkState.broken
    && resolvedGroupStatus !== 'invited_pending'
    && resolvedGroupStatus !== 'left'
    && resolvedGroupStatus !== 'removed'
    && resolvedGroupStatus !== 'disbanded';
  const canDeleteGroupChat = isGroup
    && (resolvedGroupStatus === 'disbanded' || groupCreatorLinkState.broken);

  return <div className={`${showGroupStateMessage || showDirectInactivityWarning ? 'h-20' : 'h-16'} px-6 flex items-center justify-between border-b border-border ${activeChat?.status === 'pending' ? "" : "bg-card/50"}`}>
    <div className="flex min-w-12 flex-1 items-center gap-3">
      {isGroup ? (
        <div className="w-10 h-10 shrink-0 rounded-full bg-primary/20 flex items-center justify-center">
          <Users className="w-5 h-5 text-primary" />
        </div>
      ) : activeChat?.status === 'pending' ? (
        <div className="w-10 h-10 shrink-0 rounded-full bg-warning/20 flex items-center justify-center">
          <UserPlus className="w-5 h-5 text-warning" />
        </div>
      ) : null}
      <div className="min-w-4 flex-1">
        <h3 className="flex min-w-4 items-center gap-2 text-left font-medium text-foreground">
          <span className="block min-w-4 flex-1 truncate" title={username}>
            {username}
            {isFetchingGroupUpdates && (
              <span className="inline-flex ml-2 shrink-0 items-center gap-1 text-[11px] font-normal text-muted-foreground">
                <span className="w-3 h-3 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
                fetching group updates
              </span>
            )}
          </span>

        </h3>
        {isGroup ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground truncate max-w-xs text-left" title={memberSummary}>
              {memberSummary}
            </span>
            {showGroupStateMessage && (
              <div className="flex items-center gap-1">
                {isGroupStatusWaiting(groupStatus) ? (
                  <Clock className="w-3 h-3 text-warning" />
                ) : (
                  <AlertCircle className="w-3 h-3 text-warning" />
                )}
                <span className="text-xs text-warning">{groupStatusMessage}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground font-mono truncate">
                Peer ID: {peerId}
              </span>
            </div>
            {showDirectInactivityWarning && (
              <div className="flex items-center gap-1">
                <AlertCircle className="w-3 h-3 text-warning" />
                <span className="text-xs text-warning">
                  No activity from this contact for over 30 days.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>

    <div className="flex shrink-0 items-center gap-1">
      <ChatHeaderCallControls
        canShowCallButtons={canShowCallButtons}
        hasActiveCallWithThisPeer={hasActiveCallWithThisPeer}
        startCallDisabled={startCallDisabled}
        callButtonTitle={callButtonTitle}
        onCallClick={handleCallClick}
      />
      {canShowGroupCallButton && <>
        {showGroupCallStatusMessage && (
          <div className={`flex items-center gap-1.5 text-xs mr-2 ${groupCallStatusTone}`}>
            {(isStartingGroupCall || isJoiningGroupCall || isLeavingGroupCall) ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Phone className="w-3 h-3" />
            )}
            <span>{groupCallStatusMessage}</span>
          </div>
        )}
        <Button
          variant={isInThisGroupCall ? "destructive" : hasKnownGroupCall ? "outline" : "ghost"}
          size="icon"
          className={isInThisGroupCall ? '' : 'text-muted-foreground hover:text-foreground'}
          onClick={() => { void handleGroupCallButtonClick(); }}
          title={groupCallButtonTitle}
          disabled={groupCallActionDisabled}
        >
          {(isStartingGroupCall || isJoiningGroupCall || isLeavingGroupCall) ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : isInThisGroupCall ? (
            <PhoneOff className="w-4 h-4" />
          ) : (
            <Phone className="w-4 h-4" />
          )}
        </Button>
      </>
      }
      <ChatHeaderMenu
        open={dropdownOpen}
        onOpenChange={setDropdownOpen}
        isGroup={isGroup}
        activeChatMuted={activeChat?.muted}
        groupStatus={groupStatus}
        activeChatStatus={activeChat?.status}
        isBlocked={isBlocked}
        canRequestGroupUpdate={canRequestGroupUpdate}
        isRequestingGroupUpdate={isRequestingGroupUpdate}
        isCurrentUserGroupCreator={isCurrentUserGroupCreator}
        kickableMembersCount={kickableMembers.length}
        canShowLeaveOrDisband={canShowLeaveOrDisband}
        canDeleteGroupChat={canDeleteGroupChat}
        canSelectMessages={!!activeChat && !!onSelectMessages}
        onAboutGroup={handleAboutGroup}
        onAboutUser={handleAboutUser}
        onEditUsername={handleEditUsername}
        onToggleMute={handleToggleMute}
        onCheckMissedGroupMessages={handleCheckMissedGroupMessages}
        onCheckMissedDirectMessages={handleCheckMissedDirectMessages}
        onRequestGroupUpdate={handleRequestGroupUpdate}
        onInviteUsers={handleInviteUsers}
        onKickMember={handleKickMember}
        onLeaveGroup={handleLeaveGroup}
        onDeleteGroupChat={handleDeleteGroupChat}
        onToggleBlock={handleToggleBlock}
        onSelectMessages={handleSelectMessages}
        onDeleteAllMessages={handleDeleteAllMessages}
        onDeleteChatAndUser={handleDeleteChatAndUser}
      />
    </div>

    {activeChat && (
      <>
        <AboutUserModal
          open={aboutModalOpen}
          onOpenChange={setAboutModalOpen}
          peerId={peerId}
          chatId={activeChat.id}
        />
        {isGroup && chatId && (
          <InviteUsersDialog
            open={inviteUsersDialogOpen}
            onOpenChange={setInviteUsersDialogOpen}
            chatId={chatId}
            groupName={username}
            disabledPeers={disabledInvitePeers}
            pendingInvitePeers={pendingInvitePeers}
            maxSelectable={availableInviteSlots}
            onSuccess={handleInviteUsersSuccess}
            onReinvite={handleReinviteUser}
          />
        )}
        <DeleteAllMessagesDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          isDeleting={isDeleting}
          onConfirm={() => { void confirmDeleteAllMessages(); }}
        />
        <DeleteChatAndUserDialog
          open={deleteChatAndUserConfirmOpen}
          onOpenChange={setDeleteChatAndUserConfirmOpen}
          isDeleting={isDeleting}
          username={username}
          onConfirm={() => { void confirmDeleteChatAndUser(); }}
        />
        <DeleteGroupChatDialog
          open={deleteGroupChatConfirmOpen}
          onOpenChange={setDeleteGroupChatConfirmOpen}
          isDeleting={isDeleting}
          onConfirm={() => { void confirmDeleteGroupChat(); }}
        />
        <LeaveGroupDialog
          open={leaveGroupConfirmOpen}
          onOpenChange={setLeaveGroupConfirmOpen}
          title={leaveDialogTitle}
          description={leaveDialogDescription}
          confirmLabel={leaveConfirmLabel}
          isCreator={isCurrentUserGroupCreator}
          isSubmitting={isLeavingGroup}
          onConfirm={() => { void confirmLeaveGroup(); }}
        />
        <GroupInfoDialog
          open={groupInfoDialogOpen}
          onOpenChange={setGroupInfoDialogOpen}
          loading={groupInfoLoading}
          groupName={username}
          groupStatus={groupInfoStatus}
          keyVersion={groupInfoDetails?.keyVersion ?? 0}
          creatorName={groupInfoCreatorName}
          creatorPeerId={groupInfoCreatorPeerId}
          createdAtLabel={groupInfoCreatedAt}
          memberCount={groupInfoMemberCount}
          invitedOrPendingCount={invitedOrPendingGroupMemberCount}
          isCurrentUserGroupCreator={isCurrentUserGroupCreator}
          members={groupMembers}
        />
        <KickMemberDialog
          open={kickMemberDialogOpen}
          onOpenChange={setKickMemberDialogOpen}
          members={kickableMembers}
          selectedPeerId={selectedKickPeerId}
          onSelectPeerId={setSelectedKickPeerId}
          isSubmitting={isKickingMember}
          onConfirm={() => { void confirmKickMember(); }}
        />
        <EditUsernameDialog
          open={editUsernameModalOpen}
          onOpenChange={(open) => {
            setEditUsernameModalOpen(open);
            if (!open) {
              setNewUsername('');
              setValidationError('');
            }
          }}
          username={username}
          newUsername={newUsername}
          validationError={validationError}
          confirmDisabled={validateUsername(newUsername, peerId) !== ""}
          onUsernameChange={setNewUsername}
          onCancel={() => {
            setEditUsernameModalOpen(false);
            setNewUsername('');
            setValidationError('');
          }}
          onConfirm={() => { void confirmEditUsername(); }}
        />
      </>
    )}
  </div>
}
