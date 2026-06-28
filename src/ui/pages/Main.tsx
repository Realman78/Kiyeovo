import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Loader2 } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWrapper from '../components/chat/ChatWrapper';
import { setChats, addChat, removePendingKeyExchange, setActiveChat, markOfflineFetched, markOfflineFetchFailed, updateFileTransferProgress, updateFileTransferStatus, updateFileTransferError, setPendingFileStatus, updateChat, setActivePendingKeyExchange, setOfflineFetchStatus } from '../state/slices/chatSlice';
import { removeContactAttempt, setActiveContactAttempt, addMessage, resolveMessageSendOutcome, type Chat } from '../state/slices/chatSlice';
import { applyCameraState, applyCoreCallState, applyLocalCallState, applyScreenShareState, setCallError, setIncomingCall, setCallPeerName } from '../state/slices/callSlice';
import { useToast } from '../components/ui/use-toast';
import type { RootState } from '../state/store';
import { useNotifications } from '../hooks/useNotifications';
import { useCallRingtone } from '../hooks/useCallRingtone';
import { store } from '../state/store';
import { callService } from '../lib/call/callService';
import { groupCallService } from '../lib/call/groupCallService';
import { IncomingCallCard } from '../components/call/IncomingCallCard';
import { CallManagerCard } from '../components/call/CallManagerCard';
import { GroupCallManagerCard } from '../components/call/GroupCallManagerCard';
import { ScreenShareSourcePicker } from '../components/call/ScreenShareSourcePicker';
import type { SetupSection, SidebarSection } from '../components/sidebar/navigation';
import { BootstrapSetup } from '../components/sidebar/setup/BootstrapSetup';
import { RelaySetup } from '../components/sidebar/setup/RelaySetup';
import { IceSetup } from '../components/sidebar/setup/IceSetup';
import { SettingsPage } from '../components/sidebar/settings/SettingsPage';
import { ProfilePage } from '../components/sidebar/profile/ProfilePage';
import { HelpPage } from '../components/sidebar/help/HelpPage';
import { InitialSetupWelcome } from '../components/sidebar/setup/InitialSetupWelcome';
import { InitialSetupWizard } from '../components/sidebar/setup/InitialSetupWizard';
import { OPEN_REGISTER_DIALOG_EVENT, OPEN_SETUP_EVENT } from '../utils/uiSignals';
import type { InitialSetupStatus } from '../../shared/kiyeovo-api';
import { useSetupReadiness } from '../hooks/useSetupReadiness';
import { useConnectivityGuidance } from '../hooks/useConnectivityGuidance';
import { useDHTConnectionStatus } from '../hooks/useDHTConnectionStatus';

type InitialSetupSessionPhase = 'welcome' | 'guided' | 'dismissed';

type MainProps = {
  wakeRecoveryToken: number | null;
  onWakeRecoveryOfflineSyncSettled: (token: number) => void;
};

export const Main = ({ wakeRecoveryToken, onWakeRecoveryOfflineSyncSettled }: MainProps) => {
  const [activeSection, setActiveSection] = useState<SidebarSection>('chats');
  const [activeSetupSection, setActiveSetupSection] = useState<SetupSection>('bootstrap');
  const [initialSetupSessionPhase, setInitialSetupSessionPhase] =
    useState<InitialSetupSessionPhase | null>(null);
  const [persistedInitialSetupStatus, setPersistedInitialSetupStatus] =
    useState<InitialSetupStatus | null>(null);
  const [initialSetupSaving, setInitialSetupSaving] = useState(false);
  const initialSetupTransitionInFlightRef = useRef(false);
  const dispatch = useDispatch();
  const { toast } = useToast();
  const setupReadiness = useSetupReadiness();
  const {
    showCallConnectionFailure,
    showMessageFailureGuidance,
  } = useConnectivityGuidance();
  const isConnected = useSelector((state: RootState) => state.user.connected);
  const networkOnline = useSelector((state: RootState) => state.user.networkOnline);
  const canFetchOffline = !!isConnected && networkOnline;
  const chats = useSelector((state: RootState) => state.chat.chats);
  const activeCall = useSelector((state: RootState) => state.call.activeCall);
  const incomingCall = useSelector((state: RootState) => state.call.incomingCall);

  useNotifications();
  useCallRingtone();
  // Keep user.connected fresh everywhere
  useDHTConnectionStatus();

  const guideCallConnectionFailure = useEffectEvent(() => {
    return showCallConnectionFailure();
  });

  const guideMessageFailure = useEffectEvent((
    reason: Parameters<typeof showMessageFailureGuidance>[0],
  ) => {
    showMessageFailureGuidance(reason);
  });

  useEffect(() => {
    let disposed = false;

    const loadInitialSetupStatus = async () => {
      try {
        const result = await window.kiyeovoAPI.getInitialSetupStatus();
        if (disposed) return;
        if (!result.success) {
          console.error('Failed to load initial setup status:', result.error);
        }

        setPersistedInitialSetupStatus(result.success ? result.status : 'not_started');
      } catch (error) {
        if (!disposed) {
          console.error('Failed to load initial setup status:', error);
          setPersistedInitialSetupStatus('not_started');
        }
      }
    };

    void loadInitialSetupStatus();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (initialSetupSessionPhase !== null || persistedInitialSetupStatus === null) return;

    if (persistedInitialSetupStatus === 'completed' || persistedInitialSetupStatus === 'skipped') {
      setInitialSetupSessionPhase('dismissed');
      return;
    }

    if (persistedInitialSetupStatus === 'not_started') {
      setActiveSetupSection('bootstrap');
      setActiveSection('setup');
      setInitialSetupSessionPhase('welcome');
      return;
    }

    if (!setupReadiness) return;

    const resumeSection: SetupSection = setupReadiness.bootstrap !== 'configured'
      ? 'bootstrap'
      : setupReadiness.mode === 'fast' && setupReadiness.relay !== 'configured'
        ? 'relay'
        : setupReadiness.mode === 'fast'
          ? 'ice'
          : 'bootstrap';

    setActiveSetupSection(resumeSection);
    setActiveSection('setup');
    setInitialSetupSessionPhase('guided');
  }, [initialSetupSessionPhase, persistedInitialSetupStatus, setupReadiness]);

  // Let other parts of the tree (e.g. the empty chat area) jump to setup.
  useEffect(() => {
    const handler = (event: Event) => {
      const requestedSection = event instanceof CustomEvent
        && (event.detail === 'bootstrap' || event.detail === 'relay' || event.detail === 'ice')
        ? event.detail
        : 'bootstrap';
      setActiveSetupSection(requestedSection);
      setActiveSection('setup');
    };
    window.addEventListener(OPEN_SETUP_EVENT, handler);
    return () => window.removeEventListener(OPEN_SETUP_EVENT, handler);
  }, []);

  useEffect(() => {
    const handler = () => setActiveSection('profile');
    window.addEventListener(OPEN_REGISTER_DIALOG_EVENT, handler);
    return () => window.removeEventListener(OPEN_REGISTER_DIALOG_EVENT, handler);
  }, []);

  const resolvePeerName = (peerId: string): string => {
    const state = store.getState();
    const directChat = state.chat.chats.find((chat) => chat.type === 'direct' && chat.peerId === peerId);
    if (directChat?.name) return directChat.name;
    const user = state.chat.chats.find((chat) => chat.peerId === peerId && chat.username);
    return user?.username ?? `user_${peerId.slice(-8)}`;
  };

  const mapDbChatToUiChat = (dbChat: any, overrides?: Partial<Chat>): Chat => ({
    id: dbChat.id,
    type: dbChat.type,
    name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
    groupId: dbChat.group_id,
    groupCreatorPeerId: dbChat.group_creator_peer_id,
    groupCreatorUsername: dbChat.group_creator_username,
    peerId: dbChat.other_peer_id,
    lastMessage: dbChat.last_message_content || 'SYSTEM: No messages yet',
    lastMessageTimestamp: dbChat.last_message_timestamp
      ? new Date(dbChat.last_message_timestamp).getTime()
      : new Date(dbChat.updated_at).getTime(),
    lastInboundActivityTimestamp: dbChat.last_inbound_activity_timestamp
      ? new Date(dbChat.last_inbound_activity_timestamp).getTime()
      : undefined,
    unreadCount: 0,
    status: dbChat.status,
    fetchedOffline: dbChat.type === 'group'
      ? dbChat.group_status !== 'active'
      : false,
    isFetchingOffline: false,
    offlineFetchNeedsSync: false,
    blocked: dbChat.blocked,
    muted: dbChat.muted,
    groupStatus: dbChat.group_status,
    needsRemovedCatchup: Boolean(dbChat.needs_removed_catchup),
    lastKnownActiveCallId: dbChat.last_known_active_call_id ?? null,
    lastKnownActiveCallSeenAt: dbChat.last_known_active_call_seen_at ?? null,
    ...overrides,
  });

  const syncChatCallEvidenceFromDb = async (chatId: number) => {
    const result = await window.kiyeovoAPI.getChatById(chatId);
    if (!result.success || !result.chat) {
      return;
    }

    dispatch(updateChat({
      id: chatId,
      updates: {
        lastKnownActiveCallId: result.chat.last_known_active_call_id ?? null,
        lastKnownActiveCallSeenAt: result.chat.last_known_active_call_seen_at ?? null,
      },
    }));
  };

  useEffect(() => {
    if (activeCall) {
      dispatch(setCallPeerName({
        peerId: activeCall.peerId,
        peerName: resolvePeerName(activeCall.peerId),
      }));
    }
    if (incomingCall) {
      dispatch(setCallPeerName({
        peerId: incomingCall.peerId,
        peerName: resolvePeerName(incomingCall.peerId),
      }));
    }
  }, [dispatch, chats, activeCall?.peerId, incomingCall?.peerId]);

  useEffect(() => {
    if (!incomingCall) return;
    const timer = setTimeout(() => {
      const currentIncoming = store.getState().call.incomingCall;
      if (!currentIncoming) return;
      if (
        currentIncoming.callId !== incomingCall.callId
        || currentIncoming.peerId !== incomingCall.peerId
      ) {
        return;
      }
      void (async () => {
        const result = await callService.rejectIncomingCall(
          currentIncoming.peerId,
          currentIncoming.callId,
          'timeout',
        );
        if (!result.success) {
          const message = result.error || 'Failed to timeout incoming call';
          dispatch(setCallError(message));
          toast.error(message);
        }
      })();
    }, 30_000);

    return () => clearTimeout(timer);
  }, [dispatch, incomingCall?.callId, incomingCall?.peerId, toast]);

  useEffect(() => {
    const unsubKeyExchangeFailed = window.kiyeovoAPI.onKeyExchangeFailed((data) => {
      if (data.error.includes("ended pushable")) {
        toast.error(`${data.username} went offline`);
      } else if (data.error.includes("No pending acceptance found")) {
        toast.error(data.error);
      } else if (data.error.includes("rejected")) {
        toast.error(`${data.username} rejected your contact request`);
      } else {
        toast.error(`Key exchange with ${data.username} failed or timed out`);
      }

      const currentState = store.getState();
      const wasViewingPending = currentState.chat.activePendingKeyExchange?.peerId === data.peerId;
      const wasViewingContact = currentState.chat.activeContactAttempt?.peerId === data.peerId;

      dispatch(removeContactAttempt(data.peerId));
      dispatch(removePendingKeyExchange(data.peerId));

      if (wasViewingPending) {
        dispatch(setActivePendingKeyExchange(null));
      }
      if (wasViewingContact) {
        dispatch(setActiveContactAttempt(null));
      }
    });

    const unsubMessageReceived = window.kiyeovoAPI.onMessageReceived((data) => {
      const currentPeerId = store.getState().user.peerId;

      dispatch(addMessage({
        id: data.messageId,
        chatId: data.chatId,
        senderPeerId: data.senderPeerId,
        senderUsername: data.senderUsername,
        content: data.content,
        timestamp: data.timestamp,
        eventTimestamp: data.eventTimestamp,
        messageType: data.messageType || 'text',
        messageSentStatus: data.messageSentStatus,
        currentUserPeerId: currentPeerId,
        clientMsgId: data.clientMsgId,
        replyToClientId: data.replyToClientId,
        // File transfer fields (if present)
        fileName: data.fileName,
        fileSize: data.fileSize,
        filePath: data.filePath,
        transferStatus: data.transferStatus,
        transferProgress: data.transferProgress,
        transferError: data.transferError
      }));
    });

    // Core-driven send-state outcome for backgrounded sends (offline DHT write, etc).
    const unsubMessageSendStateChanged = window.kiyeovoAPI.onMessageSendStateChanged((data) => {
      dispatch(resolveMessageSendOutcome({
        messageId: data.messageId,
        outcome: data.outcome,
        messageSentStatus: data.messageSentStatus,
        failedReason: data.failedReason,
        retryAfterTs: data.retryAfterTs,
      }));
      if (data.outcome === 'failed' && data.connectivityFailure) {
        guideMessageFailure(data.connectivityFailure);
      }
    });

    // Group chat activated — receiver processed GROUP_WELCOME, update Redux so chat appears in sidebar
    const unsubGroupChatActivated = window.kiyeovoAPI.onGroupChatActivated((data) => {
      const existing = store.getState().chat.chats.find(c => c.id === data.chatId);
      if (!existing) {
        // Chat may exist in DB but not in Redux yet (e.g. invite arrived while sidebar state was stale).
        // Upsert from DB so activation is reflected immediately without restart.
        void (async () => {
          try {
            const result = await window.kiyeovoAPI.getChatById(data.chatId);
            if (result.success && result.chat) {
              const dbChat = result.chat;
              const newChat: Chat = mapDbChatToUiChat(dbChat, {
                status: 'active',
                fetchedOffline: false,
                isFetchingOffline: false,
                offlineFetchNeedsSync: false,
                groupStatus: 'active',
              });
              dispatch(addChat(newChat));
            }
          } catch (error) {
            console.error(`[UI] Failed to upsert activated group chat ${data.chatId}:`, error);
          }
        })();
        return;
      }
      void (async () => {
        try {
          const result = await window.kiyeovoAPI.getChatById(data.chatId);
          if (result.success && result.chat) {
            const dbChat = result.chat;
            dispatch(updateChat({
              id: data.chatId,
              updates: {
                name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
                groupId: dbChat.group_id,
                groupCreatorPeerId: dbChat.group_creator_peer_id,
                groupCreatorUsername: dbChat.group_creator_username,
                peerId: dbChat.other_peer_id,
                lastInboundActivityTimestamp: dbChat.last_inbound_activity_timestamp
                  ? new Date(dbChat.last_inbound_activity_timestamp).getTime()
                  : undefined,
                status: 'active',
                groupStatus: 'active',
                fetchedOffline: false,
                isFetchingOffline: false,
                offlineFetchNeedsSync: false,
                needsRemovedCatchup: Boolean(dbChat.needs_removed_catchup),
              },
            }));
            return;
          }
        } catch (error) {
          console.error(`[UI] Failed to hydrate activated group chat ${data.chatId}:`, error);
        }
        dispatch(updateChat({
          id: data.chatId,
          updates: { status: 'active', groupStatus: 'active', fetchedOffline: false, isFetchingOffline: false, offlineFetchNeedsSync: false },
        }));
      })();
    });

    // Group members updated — creator/member-side roster changes.
    // Keep chat status/groupStatus in sync even if this chat is not currently selected.
    const unsubGroupMembersUpdated = window.kiyeovoAPI.onGroupMembersUpdated((data) => {
      void (async () => {
        try {
          const result = await window.kiyeovoAPI.getChatById(data.chatId);
          if (!result.success || !result.chat) return;

          const dbChat = result.chat;
          const existing = store.getState().chat.chats.find(c => c.id === data.chatId);

          if (!existing) {
            const newChat: Chat = mapDbChatToUiChat(dbChat, {
              fetchedOffline: dbChat.type === 'group'
                ? !(dbChat.status === 'active' && dbChat.group_status === 'active')
                : false,
            });
            dispatch(addChat(newChat));
            return;
          }

          dispatch(updateChat({
            id: data.chatId,
            updates: {
              name: dbChat.type === 'group' ? dbChat.name : (dbChat.username || dbChat.name),
              groupId: dbChat.group_id,
              groupCreatorPeerId: dbChat.group_creator_peer_id,
              groupCreatorUsername: dbChat.group_creator_username,
              peerId: dbChat.other_peer_id,
              lastInboundActivityTimestamp: dbChat.last_inbound_activity_timestamp
                ? new Date(dbChat.last_inbound_activity_timestamp).getTime()
                : undefined,
              status: dbChat.status,
              groupStatus: dbChat.group_status,
              needsRemovedCatchup: Boolean(dbChat.needs_removed_catchup),
            },
          }));
        } catch (error) {
          console.error(`[UI] Failed to sync group status for chat ${data.chatId}:`, error);
        }
      })();
    });

    const unsubChatCreated = window.kiyeovoAPI.onChatCreated((data) => {
      // Read current state first so we can carry contact-attempt message into the new chat preview/UI.
      const currentState = store.getState();
      const sourceContactAttempt = currentState.chat.contactAttempts.find((attempt) => attempt.peerId === data.peerId);
      const sourcePendingExchange = currentState.chat.pendingKeyExchanges.find((pending) => pending.peerId === data.peerId);
      const initialMessage = sourceContactAttempt?.messageBody || sourceContactAttempt?.message || sourcePendingExchange?.messageContent || '';
      const now = Date.now();
      const currentPeerId = currentState.user.peerId;
      const currentUsername = currentState.user.username;
      const seededSenderPeerId = sourceContactAttempt ? data.peerId : (currentPeerId || data.peerId);
      const seededSenderUsername = sourceContactAttempt ? data.username : (currentUsername || 'You');

      const newChat: Chat = {
        id: data.chatId,
        type: 'direct',
        name: data.username,
        peerId: data.peerId,
        lastMessage: initialMessage,
        lastMessageTimestamp: now,
        unreadCount: 0,
        status: 'active',
        justCreated: true,
        fetchedOffline: true,
        isFetchingOffline: false,
        offlineFetchNeedsSync: false,
      };

      const wasViewingContact = currentState.chat.activeContactAttempt?.peerId === data.peerId;
      const wasViewingPending = currentState.chat.activePendingKeyExchange?.peerId === data.peerId;

      dispatch(addChat(newChat));
      if (initialMessage) {
        dispatch(addMessage({
          id: `contact-attempt-${data.chatId}-${now}`,
          chatId: data.chatId,
          senderPeerId: seededSenderPeerId,
          senderUsername: seededSenderUsername,
          content: initialMessage,
          timestamp: now,
          messageType: 'text',
          messageSentStatus: 'online',
          currentUserPeerId: currentPeerId
        }));
      }
      dispatch(removeContactAttempt(data.peerId));
      dispatch(removePendingKeyExchange(data.peerId));

      // Auto-open chat if user was actively viewing this contact attempt or pending key exchange
      if (wasViewingContact || wasViewingPending) {
        dispatch(setActiveChat(data.chatId));
      }
    });

    const unsubFileTransferProgress = window.kiyeovoAPI.onFileTransferProgress((data) => {
      dispatch(updateFileTransferProgress({
        messageId: data.messageId,
        progress: Math.floor((data.current / data.total) * 100),
        chatId: data.chatId,
        filename: data.filename,
        size: data.size
      }));
    });

    const unsubFileTransferComplete = window.kiyeovoAPI.onFileTransferComplete((data) => {
      dispatch(updateFileTransferStatus({
        messageId: data.messageId,
        status: 'completed',
        filePath: data.filePath
      }));
      toast.success('File transfer completed');
    });

    const unsubFileTransferFailed = window.kiyeovoAPI.onFileTransferFailed((data) => {
      const errorText = data.error || 'Unknown error';
      if (data.status && data.status !== 'failed') {
        dispatch(updateFileTransferStatus({
          messageId: data.messageId,
          status: data.status,
          transferError: errorText,
        }));
        if (data.status === 'incoming_pending_user') {
          dispatch(setPendingFileStatus({ chatId: data.chatId, hasPendingFile: true }));
        }
        if (data.status === 'cancelled' || data.status === 'rejected') {
          const hasOtherPending = store.getState().chat.messages.some(
            (message) =>
              message.chatId === data.chatId &&
              message.id !== data.messageId &&
              message.transferStatus === 'incoming_pending_user',
          );
          dispatch(setPendingFileStatus({ chatId: data.chatId, hasPendingFile: hasOtherPending }));
        }
      } else {
        dispatch(updateFileTransferError({
          messageId: data.messageId,
          error: errorText
        }));
      }

      if (errorText.toLowerCase().includes('download canceled by user')) {
        toast.info('File transfer canceled');
        return;
      }

      if (data.status === 'awaiting_acceptance') {
        return;
      }

      if (data.status === 'cancelled') {
        toast.info('File offer cancelled');
        return;
      }

      toast.error((data.status && data.status !== 'failed' ? 'File download not completed: ' : 'File transfer failed: ') + errorText);
    });

    const unsubOutgoingFileOfferPending = window.kiyeovoAPI.onOutgoingFileOfferPending((data) => {
      dispatch(updateFileTransferStatus({
        messageId: data.messageId,
        status: 'awaiting_acceptance'
      }));
    });

    const unsubOutgoingFileOfferTerminal = window.kiyeovoAPI.onOutgoingFileOfferTerminal((data) => {
      dispatch(updateFileTransferStatus({
        messageId: data.messageId,
        status: data.status,
        transferError: data.error,
      }));
      const toastMessage =
        data.status === 'rejected'
          ? `${data.filename} was declined`
          : data.status === 'cancelled'
            ? `${data.filename} offer cancelled`
            : data.error === 'Recipient file inbox is full'
              ? 'Recipient file inbox is full. They need to accept, reject, or clear older pending file offers before you can send more.'
              : `File offer failed: ${data.error}`;
      toast.info(toastMessage);
    });

    const unsubPendingFileReceived = window.kiyeovoAPI.onPendingFileReceived((data) => {
      const currentPeerId = store.getState().user.peerId;
      dispatch(addMessage({
        id: data.fileId,
        chatId: data.chatId,
        senderPeerId: data.senderId,
        senderUsername: data.senderUsername,
        content: `${data.filename} (${data.size} bytes)`,
        timestamp: Date.now(),
        messageType: 'file',
        messageSentStatus: 'online',
        currentUserPeerId: currentPeerId,
        clientMsgId: data.fileId,
        fileName: data.filename,
        fileSize: data.size,
        transferStatus: 'incoming_pending_user',
        transferProgress: 0,
        ...(data.replyToClientId ? { replyToClientId: data.replyToClientId } : {}),
      }));
      dispatch(updateChat({
        id: data.chatId,
        updates: {
          lastMessage: `File offer: ${data.filename}`,
          lastMessageTimestamp: Date.now()
        }
      }));
      // Unread count is handled by addMessage reducer for non-active chats.
      dispatch(setPendingFileStatus({ chatId: data.chatId, hasPendingFile: true }));
      toast.info(`${data.senderUsername} wants to send you a file: ${data.filename}`);
    });

    const unsubCallIncoming = window.kiyeovoAPI.onCallIncoming((data) => {
      const peerName = resolvePeerName(data.signal.fromPeerId);
      dispatch(setIncomingCall({
        callId: data.signal.callId,
        peerId: data.signal.fromPeerId,
        peerName,
        offerSdp: data.signal.offerSdp,
        receivedAt: data.receivedAt,
      }));
    });

    const unsubCallSignalReceived = window.kiyeovoAPI.onCallSignalReceived((data) => {
      void callService.handleSignal(data.signal);
    });

    const unsubCallStateChanged = window.kiyeovoAPI.onCallStateChanged((data) => {
      const peerName = resolvePeerName(data.peerId);
      dispatch(applyCoreCallState({
        callId: data.callId,
        peerId: data.peerId,
        peerName,
        direction: data.direction,
        state: data.state,
        reason: data.reason,
        timestamp: data.timestamp,
      }));
      callService.syncWithCoreState(data);
    });

    const unsubCallError = window.kiyeovoAPI.onCallError((data) => {
      dispatch(setCallError(data.error));
      toast.error(data.error);
    });

    const unsubGroupCallControlSignalReceived = window.kiyeovoAPI.onGroupCallControlSignalReceived((data) => {
      void groupCallService.handleControlSignal(data.signal);

      const currentChats = store.getState().chat.chats;
      const chat = currentChats.find((candidate) => candidate.groupId === data.signal.groupId);
      if (!chat) {
        return;
      }

      if (data.signal.type === 'CALL_GROUP_STARTED') {
        if (
          chat.lastKnownActiveCallId
          && chat.lastKnownActiveCallId !== data.signal.callId
          && chat.lastKnownActiveCallId < data.signal.callId
        ) {
          return;
        }
        dispatch(updateChat({
          id: chat.id,
          updates: {
            lastKnownActiveCallId: data.signal.callId,
            lastKnownActiveCallSeenAt: data.signal.timestamp,
          },
        }));
        return;
      }

      if (data.signal.type === 'CALL_GROUP_ENDED' && chat.lastKnownActiveCallId === data.signal.callId) {
        dispatch(updateChat({
          id: chat.id,
          updates: {
            lastKnownActiveCallId: null,
            lastKnownActiveCallSeenAt: null,
          },
        }));
      }
    });

    const unsubGroupCallPairSignalReceived = window.kiyeovoAPI.onGroupCallPairSignalReceived((data) => {
      void groupCallService.handlePairSignal(data.signal);
    });

    const unsubGroupCallStateChanged = window.kiyeovoAPI.onGroupCallStateChanged((data) => {
      groupCallService.syncWithCoreState(data);
      if (typeof data.chatId === 'number') {
        void syncChatCallEvidenceFromDb(data.chatId);
      }
    });

    const unsubGroupCallError = window.kiyeovoAPI.onGroupCallError((data) => {
      toast.error(data.error);
    });

    const unsubCallService = callService.subscribe((event) => {
      if (event.type === 'error') {
        dispatch(setCallError(event.message));
        toast.error(event.message);
        return;
      }

      if (event.type === 'state') {
        dispatch(applyLocalCallState({
          callId: event.callId,
          peerId: event.peerId,
          state: event.state,
          reason: event.reason,
        }));
        if (event.state === 'ended' && event.reason === 'failed') {
          if (!guideCallConnectionFailure()) {
            toast.error('Call connection failed');
          }
        }
        return;
      }

      if (event.type === 'screen-share') {
        dispatch(applyScreenShareState({
          callId: event.callId,
          peerId: event.peerId,
          localState: event.localState,
          remoteSharing: event.remoteSharing,
        }));
        return;
      }

      if (event.type === 'camera') {
        dispatch(applyCameraState({
          callId: event.callId,
          peerId: event.peerId,
          localState: event.localState,
          remoteEnabled: event.remoteEnabled,
        }));
      }
    });

    const unsubGroupCallService = groupCallService.subscribe((event) => {
      if (event.type === 'error') {
        if (
          event.reason !== 'connection_failed'
          || !guideCallConnectionFailure()
        ) {
          toast.error(event.message);
        }
        return;
      }
      if (event.type !== 'state') {
        return;
      }
      if (event.previousState !== 'active' && event.snapshot.state === 'active') {
        toast.success('Group call audio connected');
      }
    });

    return () => {
      unsubKeyExchangeFailed();
      unsubMessageReceived();
      unsubMessageSendStateChanged();
      unsubGroupChatActivated();
      unsubGroupMembersUpdated();
      unsubChatCreated();
      unsubFileTransferProgress();
      unsubFileTransferComplete();
      unsubFileTransferFailed();
      unsubOutgoingFileOfferPending();
      unsubOutgoingFileOfferTerminal();
      unsubPendingFileReceived();
      unsubCallIncoming();
      unsubCallSignalReceived();
      unsubCallStateChanged();
      unsubCallError();
      unsubGroupCallControlSignalReceived();
      unsubGroupCallPairSignalReceived();
      unsubGroupCallStateChanged();
      unsubGroupCallError();
      unsubCallService();
      unsubGroupCallService();
      callService.dispose();
      groupCallService.dispose();
    };
  }, [])

  const syncRecentOfflineMessages = useEffectEvent(async (wakeToken: number | null) => {
    try {
      const result = await window.kiyeovoAPI.getChats();
      if (!result.success) {
        console.error('[UI] Failed to fetch chats:', result.error);
        return;
      }

      const mappedChats = result.chats.map((dbChat: any) => mapDbChatToUiChat(dbChat));

      dispatch(setChats(mappedChats));

      // Unified startup scope: latest 15 chats total (direct + group), then split by type.
      const startupChats = [...mappedChats]
        .sort((a: any, b: any) => b.lastMessageTimestamp - a.lastMessageTimestamp)
        .slice(0, 15);

      const topStartupGroupChats = startupChats
        .filter((c: any) => c.type === 'group' && (
          c.groupStatus === 'active'
          || c.groupStatus === 'rekeying'
          || (c.groupStatus === 'removed' && c.needsRemovedCatchup)
        ));
      const topGroupChatIds = topStartupGroupChats.map((chat: any) => chat.id);

      const topDirectChatIdSet = new Set<number>(
        startupChats
          .filter((c: any) => c.type === 'direct')
          .map((chat: any) => chat.id),
      );

      // Ensure creator direct chats are included so GROUP_STATE_UPDATE control
      // messages are ingested before group-offline epoch scanning.
      for (const groupChat of topStartupGroupChats) {
        const creatorPeerId = groupChat.groupCreatorPeerId;
        if (!creatorPeerId) continue;
        const creatorDirectChat = mappedChats.find(
          (c: any) => c.type === 'direct' && c.peerId === creatorPeerId,
        );
        if (creatorDirectChat) {
          topDirectChatIdSet.add(creatorDirectChat.id);
        }
      }

      const topDirectChatIds = Array.from(topDirectChatIdSet);

      const groupCheckTask = async () => {
        if (topGroupChatIds.length === 0 || !canFetchOffline) {
          return;
        }

        topGroupChatIds.forEach((chatId) => {
          dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));
        });
        try {
          const groupResult = await window.kiyeovoAPI.checkGroupOfflineMessages(topGroupChatIds);
          if (!groupResult.success) {
            dispatch(markOfflineFetchFailed(topGroupChatIds));
            return;
          }
          console.log(`Group offline message check complete`);
          const failedChatIds = groupResult.failedChatIds ?? [];
          const failedSet = new Set(failedChatIds);
          const doneChatIds = topGroupChatIds.filter((chatId) => !failedSet.has(chatId));
          if (doneChatIds.length > 0) {
            dispatch(markOfflineFetched(doneChatIds));
          }
          if (failedChatIds.length > 0) {
            dispatch(markOfflineFetchFailed(failedChatIds));
            toast.warning(`Offline sync needs retry for ${failedChatIds.length} group chat${failedChatIds.length === 1 ? '' : 's'}`);
          }

          const refreshResult = await window.kiyeovoAPI.getChats();
          if (refreshResult.success) {
            const currentChats = store.getState().chat.chats;
            const currentUnreadByChatId = new Map(currentChats.map((chat) => [chat.id, chat.unreadCount]));
            const refreshedChats = refreshResult.chats.map((dbChat: any) => mapDbChatToUiChat(dbChat, {
              unreadCount: currentUnreadByChatId.get(dbChat.id) ?? 0,
              fetchedOffline: currentChats.find((chat) => chat.id === dbChat.id)?.fetchedOffline
                ?? (dbChat.type === 'group' ? dbChat.group_status !== 'active' : false),
              isFetchingOffline: currentChats.find((chat) => chat.id === dbChat.id)?.isFetchingOffline ?? false,
              offlineFetchNeedsSync: currentChats.find((chat) => chat.id === dbChat.id)?.offlineFetchNeedsSync ?? false,
            }));
            dispatch(setChats(refreshedChats));
          }

          const unreadMap = groupResult.unreadFromChats instanceof Map
            ? groupResult.unreadFromChats
            : new Map<number, number>();
          const unreadCount = Array.from(unreadMap.values())
            .reduce((sum, count) => sum + count, 0);
          if (unreadCount > 0) {
            toast.info(`Fetched ${unreadCount} missed group message${unreadCount === 1 ? '' : 's'}`);
          }
          if (groupResult.gapWarnings.length > 0) {
            toast.warning(`Detected ${groupResult.gapWarnings.length} group sequence gap(s); some old messages may be missing`);
          }
        } catch (error) {
          dispatch(markOfflineFetchFailed(topGroupChatIds));
          console.error('[UI] Failed to check group offline messages:', error);
        }
      };

      const directCheckTask = async () => {
        if (topDirectChatIds.length === 0 || !canFetchOffline) {
          return;
        }

        topDirectChatIds.forEach((chatId) => {
          dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));
        });

        try {
          const result = await window.kiyeovoAPI.checkOfflineMessages(topDirectChatIds);
          if (result.success) {
            const fetchedChatIds = result.checkedChatIds.length > 0 ? result.checkedChatIds : topDirectChatIds;
            console.log(`Offline message check complete - checked ${fetchedChatIds.length} chats`);
            dispatch(markOfflineFetched(fetchedChatIds));

            const refreshResult = await window.kiyeovoAPI.getChats();
            if (refreshResult.success) {
              const currentChats = store.getState().chat.chats;
              const currentUnreadByChatId = new Map(currentChats.map((c) => [c.id, c.unreadCount]));
              const refreshedChats = refreshResult.chats.map((dbChat: any) => mapDbChatToUiChat(dbChat, {
                unreadCount: currentUnreadByChatId.get(dbChat.id) ?? 0,
                fetchedOffline: currentChats.find(c => c.id === dbChat.id)?.fetchedOffline
                  ?? (dbChat.type === 'group'
                    ? dbChat.group_status !== 'active'
                    : fetchedChatIds.includes(dbChat.id)),
                isFetchingOffline: currentChats.find(c => c.id === dbChat.id)?.isFetchingOffline ?? false,
                offlineFetchNeedsSync: currentChats.find(c => c.id === dbChat.id)?.offlineFetchNeedsSync ?? false,
              }));
              dispatch(setChats(refreshedChats));
            }
          } else {
            console.error('[UI] Failed to check offline messages:', result.error);
            dispatch(markOfflineFetchFailed(topDirectChatIds));
          }
        } catch (error) {
          console.error('[UI] Failed to check offline messages:', error);
          dispatch(markOfflineFetchFailed(topDirectChatIds));
        }
      };

      await directCheckTask();
      await groupCheckTask();
    } catch (error) {
      console.error('[UI] Error fetching chats:', error);
    } finally {
      if (wakeToken !== null) {
        onWakeRecoveryOfflineSyncSettled(wakeToken);
      }
    }
  });

  useEffect(() => {
    void syncRecentOfflineMessages(wakeRecoveryToken !== null && canFetchOffline ? wakeRecoveryToken : null);
  }, [canFetchOffline, isConnected, networkOnline, wakeRecoveryToken]);

  const onboardingLoading = initialSetupSessionPhase === null;
  const navigationReady = !onboardingLoading;
  const isChatSection = navigationReady
    && (activeSection === 'chats' || activeSection === 'groups');
  const showInitialSetupWelcome = initialSetupSessionPhase === 'welcome';
  const showInitialSetupWizard = initialSetupSessionPhase === 'guided';
  const onboardingActive =
    onboardingLoading || showInitialSetupWelcome || showInitialSetupWizard;

  const persistInitialSetupStatus = async (status: InitialSetupStatus): Promise<boolean> => {
    if (initialSetupTransitionInFlightRef.current) return false;

    initialSetupTransitionInFlightRef.current = true;
    setInitialSetupSaving(true);
    try {
      const result = await window.kiyeovoAPI.setInitialSetupStatus(status);
      if (!result.success) {
        toast.error(result.error || 'Failed to save setup progress');
        return false;
      }
      return true;
    } catch (error) {
      console.error('Failed to save initial setup status:', error);
      toast.error('Failed to save setup progress');
      return false;
    } finally {
      initialSetupTransitionInFlightRef.current = false;
      setInitialSetupSaving(false);
    }
  };

  const handleStartInitialSetup = async (): Promise<void> => {
    if (!(await persistInitialSetupStatus('in_progress'))) return;

    setInitialSetupSessionPhase('guided');
    setActiveSetupSection('bootstrap');
    setActiveSection('setup');
  };

  const handleSkipInitialSetup = async (): Promise<void> => {
    if (!(await persistInitialSetupStatus('skipped'))) return;

    setInitialSetupSessionPhase('dismissed');
    setActiveSection('chats');
  };

  const handleFinishInitialSetup = async (): Promise<void> => {
    if (!(await persistInitialSetupStatus('completed'))) return;

    setInitialSetupSessionPhase('dismissed');
    setActiveSection('chats');
  };

  return (
    <div className='h-screen w-screen flex overflow-hidden'>
      <div
        className='flex min-w-0 flex-1'
        inert={onboardingActive}
        aria-hidden={onboardingActive || undefined}
      >
        <Sidebar
          activeSection={activeSection}
          activeSetupSection={activeSetupSection}
          onSelectSection={setActiveSection}
          onSelectSetupSection={setActiveSetupSection}
        />
        <div className='relative min-w-12 flex-1'>
          <div
            className={`absolute inset-0 flex ${isChatSection ? 'visible pointer-events-auto' : 'invisible pointer-events-none'}`}
            aria-hidden={!isChatSection}
          >
            <ChatWrapper active={isChatSection} />
          </div>
          {!isChatSection && (
            <div
              className={`absolute inset-0 ${activeSection === 'setup' ? 'bg-sidebar-accent' : 'bg-background'}`}
              data-setup-section={activeSection === 'setup' ? activeSetupSection : undefined}
            >
              {activeSection === 'setup' && initialSetupSessionPhase === 'dismissed' && activeSetupSection === 'bootstrap' && (
                <BootstrapSetup />
              )}
              {activeSection === 'setup' && initialSetupSessionPhase === 'dismissed' && activeSetupSection === 'relay' && (
                <RelaySetup />
              )}
              {activeSection === 'setup' && initialSetupSessionPhase === 'dismissed' && activeSetupSection === 'ice' && (
                <IceSetup />
              )}
              {activeSection === 'settings' && (
                <SettingsPage />
              )}
              {activeSection === 'profile' && (
                <ProfilePage />
              )}
              {activeSection === 'help' && (
                <HelpPage />
              )}
            </div>
          )}
        </div>
      </div>

      {/*
        First-run onboarding
      */}
      {onboardingLoading && (
        <div className='fixed inset-0 z-80 flex items-center justify-center bg-sidebar-accent'>
          <div className='flex items-center gap-3 text-sm text-muted-foreground'>
            <Loader2 className='h-4 w-4 animate-spin' />
            Loading...
          </div>
        </div>
      )}
      {showInitialSetupWelcome && (
        <div className='fixed inset-0 z-80'>
          <InitialSetupWelcome
            onStart={handleStartInitialSetup}
            onSkip={handleSkipInitialSetup}
            saving={initialSetupSaving}
          />
        </div>
      )}
      {showInitialSetupWizard && (
        <div className='fixed inset-0 z-80'>
          <InitialSetupWizard
            activeSection={activeSetupSection}
            onSelectSection={setActiveSetupSection}
            onSkip={handleSkipInitialSetup}
            onFinish={handleFinishInitialSetup}
            saving={initialSetupSaving}
          >
            {activeSetupSection === 'bootstrap' && <BootstrapSetup />}
            {activeSetupSection === 'relay' && <RelaySetup />}
            {activeSetupSection === 'ice' && <IceSetup />}
          </InitialSetupWizard>
        </div>
      )}

      <IncomingCallCard />
      <CallManagerCard />
      <GroupCallManagerCard />
      <ScreenShareSourcePicker />
    </div>
  )
}
