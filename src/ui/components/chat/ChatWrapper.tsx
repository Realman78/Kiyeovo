import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatHeader } from "./header/ChatHeader";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../state/store";
import {
  MessagesContainer,
  type MessageJumpOutcome,
  type MessageJumpRequest,
  type MessageHistoryRefreshRequest,
} from "./messages/MessagesContainer";
import { createPendingMessage } from "../../utils/general";
import { ChatInput } from "./input/ChatInput";
import { InvitationManager } from "./input/InvitationManager";
import { EmptyState } from "./messages/EmptyState";
import { PendingKxManager } from "./input/PendingKxManager";
import { getGroupCreatorLinkState, type GroupCreatorLinkState } from "../../utils/groupCreatorLinkHealth";
import { OfflineInboxCapacity } from "./OfflineInboxCapacity";
import { PendingFileInboxIndicator } from "./PendingFileInboxIndicator";
import { MessageSelectionBar } from "./MessageSelectionBar";
import { DeleteSelectedMessagesDialog } from "./DeleteSelectedMessagesDialog";
import { applyPinnedMessage, removeMessagesByIds, removeSendingMessagesByIds, updateChat, type ChatMessage } from "../../state/slices/chatSlice";
import { useToast } from "../ui/use-toast";
import { ConversationSearchNavigation } from "./ConversationSearchNavigation";
import { PinnedMessageBar } from "./messages/PinnedMessageBar";
import type {
  ChatMessageSearchCursor,
  ChatMessageSearchResult,
} from "../../../shared/kiyeovo-api";
import type { PinnedMessagePreview } from "../../../core/db/database";

const OFFLINE_INBOX_COLLAPSED_CLEARANCE_PX = 44;
const OFFLINE_INBOX_EXPANDED_CLEARANCE_PX = 120;
const SEARCH_PAGE_SIZE = 20;

type MessageSelectionState = {
  chatId: number;
  messageIds: Set<string>;
};

type ConversationSearchState = {
  open: boolean;
  chatId: number | null;
  query: string;
  results: ChatMessageSearchResult[];
  total: number;
  selectedIndex: number;
  loading: boolean;
  loadingMore: boolean;
  jumpPending: boolean;
  error: string | null;
  snapshotMaxRowid: number;
  nextCursor: ChatMessageSearchCursor | null;
};

const createClosedSearchState = (): ConversationSearchState => ({
  open: false,
  chatId: null,
  query: '',
  results: [],
  total: 0,
  selectedIndex: -1,
  loading: false,
  loadingMore: false,
  jumpPending: false,
  error: null,
  snapshotMaxRowid: 0,
  nextCursor: null,
});

const ChatWrapper = ({ active = true }: { active?: boolean }) => {
  const dispatch = useDispatch();
  const { toast } = useToast();
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const messages = useSelector((state: RootState) => state.chat.messages);
  const sendingMessages = useSelector((state: RootState) => state.chat.sendingMessages);
  const chats = useSelector((state: RootState) => state.chat.chats);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const [offlineInboxExpandedByChatId, setOfflineInboxExpandedByChatId] = useState<Record<number, boolean>>({});
  const [pendingFileInboxExpandedByChatId, setPendingFileInboxExpandedByChatId] = useState<Record<number, boolean>>({});
  const [messageSelection, setMessageSelection] = useState<MessageSelectionState | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [isDeletingMessages, setIsDeletingMessages] = useState(false);
  const [historyRefreshRequest, setHistoryRefreshRequest] = useState<MessageHistoryRefreshRequest | null>(null);
  const [conversationSearch, setConversationSearch] =
    useState<ConversationSearchState>(createClosedSearchState);
  const [messageJumpRequest, setMessageJumpRequest] = useState<MessageJumpRequest | null>(null);
  const [pinnedPreview, setPinnedPreview] = useState<PinnedMessagePreview | null>(null);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const nextHistoryRefreshRequestIdRef = useRef(0);
  const nextMessageJumpRequestIdRef = useRef(0);
  const activeSearchJumpRequestIdRef = useRef<number | null>(null);
  const searchRequestGenerationRef = useRef(0);
  const searchOperationInFlightRef = useRef(false);
  const activeChatIdRef = useRef<number | null>(activeChat?.id ?? null);
  activeChatIdRef.current = activeChat?.id ?? null;
  const activeMessageSelection =
    messageSelection && messageSelection.chatId === activeChat?.id
      ? messageSelection
      : null;
  const selectionMode = activeMessageSelection !== null;
  const selectedMessageCount = activeMessageSelection?.messageIds.size ?? 0;
  const searchMode =
    conversationSearch.open && conversationSearch.chatId === activeChat?.id;
  const activeSearchClientMsgId = searchMode
    ? (conversationSearch.results[conversationSearch.selectedIndex]?.clientMsgId ?? null)
    : null;

  const messagesToDisplay = useMemo(() => {
    if (activeContactAttempt) {
      return [createPendingMessage(activeContactAttempt.messageBody ?? activeContactAttempt.message, -78, activeContactAttempt.peerId, activeContactAttempt.username)]
    }
    if (activePendingKeyExchange) {
      return [createPendingMessage(activePendingKeyExchange.messageContent ?? "Message not found.", -78, activePendingKeyExchange.peerId, activePendingKeyExchange.username)]
    }
    if (!activeChat) return [];
    const persisted = messages.filter((m) => m.chatId === activeChat.id);
    const sending = sendingMessages.filter((m) => m.chatId === activeChat.id);
    return [...persisted, ...sending].sort((a, b) => a.timestamp - b.timestamp);
  }, [activePendingKeyExchange, activeContactAttempt, activeChat, messages, sendingMessages]);

  const groupCreatorLinkState = useMemo<GroupCreatorLinkState>(() => {
    if (!activeChat) return { broken: false };
    return getGroupCreatorLinkState(activeChat, chats, myPeerId);
  }, [activeChat, chats, myPeerId]);

  const creatorLabel = groupCreatorLinkState.creatorName
    ? `${groupCreatorLinkState.creatorName} (${groupCreatorLinkState.creatorPeerId})`
    : groupCreatorLinkState.creatorPeerId;

  const isOfflineInboxExpanded = activeChat ? !!offlineInboxExpandedByChatId[activeChat.id] : false;
  const isPendingFileInboxExpanded = activeChat ? !!pendingFileInboxExpandedByChatId[activeChat.id] : false;
  const isBottomOverlayExpanded = isOfflineInboxExpanded || isPendingFileInboxExpanded;

  const toggleOfflineInbox = useCallback(() => {
    if (!activeChat) return;
    setOfflineInboxExpandedByChatId((prev) => ({
      ...prev,
      [activeChat.id]: !prev[activeChat.id],
    }));
  }, [activeChat]);

  const togglePendingFileInbox = useCallback(() => {
    if (!activeChat) return;
    setPendingFileInboxExpandedByChatId((prev) => ({
      ...prev,
      [activeChat.id]: !prev[activeChat.id],
    }));
  }, [activeChat]);

  const clearPendingFileInboxAttention = useCallback(() => {
    if (!activeChat?.pendingFileInboxAttention) return;
    dispatch(updateChat({
      id: activeChat.id,
      updates: { pendingFileInboxAttention: false },
    }));
  }, [activeChat, dispatch]);

  const openOfflineInbox = useCallback(() => {
    if (!activeChat) return;
    setOfflineInboxExpandedByChatId((prev) => {
      if (prev[activeChat.id]) {
        return prev;
      }
      return {
        ...prev,
        [activeChat.id]: true,
      };
    });
  }, [activeChat]);

  const refreshPinnedPreview = useCallback(async (chatId: number) => {
    try {
      const res = await window.kiyeovoAPI.getPinnedMessage(chatId);
      // Ignore stale responses after the user switched chats.
      if (activeChatIdRef.current !== chatId) return;
      setPinnedPreview(res.success ? res.pinned : null);
    } catch (error) {
      console.error('[ChatWrapper] Failed to load pinned message:', error);
      if (activeChatIdRef.current === chatId) setPinnedPreview(null);
    }
  }, []);

  // Load the pinned message whenever the active chat changes.
  useEffect(() => {
    const chatId = activeChat?.id;
    if (chatId === undefined) {
      setPinnedPreview(null);
      return;
    }
    setPinnedPreview(null);
    void refreshPinnedPreview(chatId);
  }, [activeChat?.id, refreshPinnedPreview]);

  // When the pinned message is deleted, the pinned row is gone too
  const pinnedSyncRef = useRef<{ chatId: number | null; count: number }>({ chatId: null, count: 0 });
  useEffect(() => {
    const chatId = activeChat?.id ?? null;
    const count = chatId === null ? 0 : messages.filter((m) => m.chatId === chatId).length;
    const prev = pinnedSyncRef.current;
    if (prev.chatId === chatId && prev.count > 0 && count === 0 && pinnedPreview) {
      void refreshPinnedPreview(chatId as number);
    }
    pinnedSyncRef.current = { chatId, count };
  }, [messages, activeChat?.id, pinnedPreview, refreshPinnedPreview]);

  // Pin (with preview) or unpin (preview=null) a message in the active chat,
  // keeping the bar and the inline bubble icons in sync.
  const applyPin = useCallback(async (
    chatId: number,
    cid: string,
    nextPreview: PinnedMessagePreview | null,
  ) => {
    const pinned = nextPreview !== null;
    try {
      const res = await window.kiyeovoAPI.setMessagePinned(chatId, cid, pinned);
      if (!res.success) {
        toast.error(res.error || (pinned ? 'Failed to pin message' : 'Failed to unpin message'));
        return;
      }
      if (activeChatIdRef.current === chatId) {
        setPinnedPreview(nextPreview);
      }
      dispatch(applyPinnedMessage({ chatId, clientMsgId: pinned ? cid : null }));
    } catch (error) {
      console.error('[ChatWrapper] Failed to toggle pin:', error);
      toast.error(pinned ? 'Failed to pin message' : 'Failed to unpin message');
    }
  }, [dispatch, toast]);

  const handleTogglePin = useCallback((message: ChatMessage) => {
    const chatId = activeChat?.id;
    if (chatId === undefined || !message.clientMsgId) return;
    const cid = message.clientMsgId;
    const alreadyPinned = pinnedPreview?.clientMsgId === cid;
    void applyPin(chatId, cid, alreadyPinned ? null : {
      clientMsgId: cid,
      senderPeerId: message.senderPeerId,
      senderUsername: message.senderUsername,
      content: message.content,
      messageType: message.messageType,
      fileName: message.fileName,
    });
  }, [activeChat, pinnedPreview, applyPin]);

  const handleUnpinFromBar = useCallback(() => {
    const chatId = activeChat?.id;
    if (chatId === undefined || !pinnedPreview) return;
    void applyPin(chatId, pinnedPreview.clientMsgId, null);
  }, [activeChat, pinnedPreview, applyPin]);

  const handleJumpToPinned = useCallback(() => {
    const chatId = activeChat?.id;
    if (chatId === undefined || !pinnedPreview) return;
    const requestId = ++nextMessageJumpRequestIdRef.current;
    setMessageJumpRequest({ requestId, chatId, clientMsgId: pinnedPreview.clientMsgId });
  }, [activeChat, pinnedPreview]);

  const enterSelectionMode = useCallback((messageId: string) => {
    if (!activeChat) return;
    setMessageSelection({
      chatId: activeChat.id,
      messageIds: new Set([messageId]),
    });
  }, [activeChat]);

  const startSelectionMode = useCallback(() => {
    if (!activeChat) return;
    setMessageSelection({
      chatId: activeChat.id,
      messageIds: new Set(),
    });
  }, [activeChat]);

  const exitSelectionMode = useCallback(() => {
    setDeleteConfirmOpen(false);
    setMessageSelection(null);
  }, []);

  const closeConversationSearch = useCallback(() => {
    searchRequestGenerationRef.current += 1;
    searchOperationInFlightRef.current = false;
    activeSearchJumpRequestIdRef.current = null;
    setMessageJumpRequest(null);
    setConversationSearch(createClosedSearchState());
  }, []);

  const startConversationSearch = useCallback(() => {
    if (!activeChat || selectionMode) return;

    searchRequestGenerationRef.current += 1;
    searchOperationInFlightRef.current = false;
    activeSearchJumpRequestIdRef.current = null;
    setMessageJumpRequest(null);
    setConversationSearch({
      ...createClosedSearchState(),
      open: true,
      chatId: activeChat.id,
    });
    setSearchFocusRequest((current) => current + 1);
  }, [activeChat, selectionMode]);

  const updateConversationSearchQuery = useCallback((query: string) => {
    searchRequestGenerationRef.current += 1;
    searchOperationInFlightRef.current = false;
    activeSearchJumpRequestIdRef.current = null;
    setMessageJumpRequest(null);
    setConversationSearch((current) => {
      if (!current.open) return current;
      return {
        ...current,
        query,
        results: [],
        total: 0,
        selectedIndex: -1,
        loading: false,
        loadingMore: false,
        jumpPending: false,
        error: null,
        snapshotMaxRowid: 0,
        nextCursor: null,
      };
    });
  }, []);

  const queueSearchJump = useCallback((
    chatId: number,
    result: ChatMessageSearchResult,
    selectedIndex: number,
  ) => {
    if (!result.clientMsgId) {
      searchOperationInFlightRef.current = false;
      setConversationSearch((current) => ({
        ...current,
        selectedIndex,
        jumpPending: false,
        error: 'This result cannot be opened',
      }));
      return;
    }

    const requestId = ++nextMessageJumpRequestIdRef.current;
    const request: MessageJumpRequest = {
      requestId,
      chatId,
      clientMsgId: result.clientMsgId,
    };

    searchOperationInFlightRef.current = true;
    activeSearchJumpRequestIdRef.current = requestId;
    setConversationSearch((current) => ({
      ...current,
      selectedIndex,
      jumpPending: true,
      error: null,
    }));
    setMessageJumpRequest(request);
  }, []);

  // Leaving the Chats/Groups section (ChatWrapper stays mounted but hidden)
  // cancels transient modes so they can't linger invisibly.
  useEffect(() => {
    if (!active) {
      exitSelectionMode();
      closeConversationSearch();
    }
  }, [active, closeConversationSearch, exitSelectionMode]);

  useEffect(() => {
    if (!active || !activeChat) return;

    const handleSearchShortcuts = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (searchMode) {
          event.preventDefault();
          closeConversationSearch();
        }
        return;
      }

      if (
        event.altKey
        || (!event.ctrlKey && !event.metaKey)
        || event.key.toLowerCase() !== 'f'
      ) {
        return;
      }

      event.preventDefault();
      if (selectionMode) return;
      if (searchMode) {
        setSearchFocusRequest((current) => current + 1);
        return;
      }
      startConversationSearch();
    };

    document.addEventListener('keydown', handleSearchShortcuts);
    return () => document.removeEventListener('keydown', handleSearchShortcuts);
  }, [
    active,
    activeChat,
    closeConversationSearch,
    searchMode,
    selectionMode,
    startConversationSearch,
  ]);

  const toggleMessageSelection = useCallback((messageId: string) => {
    setMessageSelection((current) => {
      if (!current || current.chatId !== activeChat?.id) {
        return current;
      }

      const messageIds = new Set(current.messageIds);
      if (messageIds.has(messageId)) {
        messageIds.delete(messageId);
      } else {
        messageIds.add(messageId);
      }

      return {
        ...current,
        messageIds,
      };
    });
  }, [activeChat?.id]);

  useEffect(() => {
    if (!selectionMode) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (deleteConfirmOpen) return;
      event.preventDefault();
      exitSelectionMode();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [deleteConfirmOpen, exitSelectionMode, selectionMode]);

  useEffect(() => {
    if (!messageSelection || messageSelection.chatId === activeChat?.id) return;

    setDeleteConfirmOpen(false);
    const staleSelection = messageSelection;
    // The derived mode turns off immediately; clear the stale owner after this
    // render so returning to the chat cannot revive an old selection.
    queueMicrotask(() => {
      setMessageSelection((current) => current === staleSelection ? null : current);
    });
  }, [activeChat?.id, messageSelection]);

  useEffect(() => {
    if (!conversationSearch.open || conversationSearch.chatId === activeChat?.id) return;
    closeConversationSearch();
  }, [
    activeChat?.id,
    closeConversationSearch,
    conversationSearch.chatId,
    conversationSearch.open,
  ]);

  useEffect(() => {
    const chatId = activeChat?.id;
    if (!searchMode || !chatId) return;

    const query = conversationSearch.query.trim();
    const generation = ++searchRequestGenerationRef.current;
    if (!query) {
      setConversationSearch((current) => ({
        ...current,
        results: [],
        total: 0,
        selectedIndex: -1,
        loading: false,
        loadingMore: false,
        jumpPending: false,
        error: null,
        snapshotMaxRowid: 0,
        nextCursor: null,
      }));
      return;
    }

    let cancelled = false;
    setConversationSearch((current) => ({
      ...current,
      loading: true,
      error: null,
    }));

    void (async () => {
      try {
        const response = await window.kiyeovoAPI.searchChatMessages(
          chatId,
          query,
          { limit: SEARCH_PAGE_SIZE },
        );
        if (
          cancelled
          || searchRequestGenerationRef.current !== generation
        ) {
          return;
        }

        if (!response.success) {
          setConversationSearch((current) => ({
            ...current,
            loading: false,
            error: response.error || 'Search failed',
          }));
          return;
        }

        const firstResult = response.results[0];
        setConversationSearch((current) => ({
          ...current,
          results: response.results,
          total: response.total,
          selectedIndex: firstResult ? 0 : -1,
          loading: false,
          loadingMore: false,
          jumpPending: false,
          error: null,
          snapshotMaxRowid: response.snapshotMaxRowid,
          nextCursor: response.nextCursor,
        }));
        if (firstResult) {
          queueSearchJump(chatId, firstResult, 0);
        }
      } catch (error) {
        if (
          cancelled
          || searchRequestGenerationRef.current !== generation
        ) {
          return;
        }
        console.error('[ChatWrapper] Conversation search failed:', error);
        setConversationSearch((current) => ({
          ...current,
          loading: false,
          error: 'Search failed',
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeChat?.id,
    conversationSearch.query,
    queueSearchJump,
    searchMode,
  ]);

  const navigateConversationSearch = useCallback(async (direction: -1 | 1) => {
    if (
      !searchMode
      || !activeChat
      || searchOperationInFlightRef.current
      || conversationSearch.loading
      || conversationSearch.loadingMore
      || conversationSearch.jumpPending
    ) {
      return;
    }

    const targetIndex = conversationSearch.selectedIndex + direction;
    if (targetIndex < 0 || targetIndex >= conversationSearch.total) {
      return;
    }

    const loadedTarget = conversationSearch.results[targetIndex];
    if (loadedTarget) {
      queueSearchJump(activeChat.id, loadedTarget, targetIndex);
      return;
    }

    if (direction < 0 || !conversationSearch.nextCursor) {
      return;
    }

    const generation = searchRequestGenerationRef.current;
    searchOperationInFlightRef.current = true;
    setConversationSearch((current) => ({
      ...current,
      loadingMore: true,
      error: null,
    }));

    try {
      const response = await window.kiyeovoAPI.searchChatMessages(
        activeChat.id,
        conversationSearch.query.trim(),
        {
          limit: SEARCH_PAGE_SIZE,
          snapshotMaxRowid: conversationSearch.snapshotMaxRowid,
          cursor: conversationSearch.nextCursor,
        },
      );
      if (
        searchRequestGenerationRef.current !== generation
        || activeChatIdRef.current !== conversationSearch.chatId
      ) {
        return;
      }

      if (!response.success) {
        searchOperationInFlightRef.current = false;
        setConversationSearch((current) => ({
          ...current,
          loadingMore: false,
          error: response.error || 'Could not load more results',
        }));
        return;
      }

      const knownIds = new Set(conversationSearch.results.map((result) => result.id));
      const addedResults = response.results.filter((result) => !knownIds.has(result.id));
      const mergedResults = [...conversationSearch.results, ...addedResults];
      const nextResult = mergedResults[targetIndex];

      setConversationSearch((current) => ({
        ...current,
        results: mergedResults,
        total: response.total,
        loadingMore: false,
        snapshotMaxRowid: response.snapshotMaxRowid,
        nextCursor: response.nextCursor,
      }));

      if (nextResult) {
        searchOperationInFlightRef.current = false;
        queueSearchJump(activeChat.id, nextResult, targetIndex);
      } else {
        searchOperationInFlightRef.current = false;
        setConversationSearch((current) => ({
          ...current,
          total: Math.min(current.total, current.results.length),
          error: 'No more matches',
        }));
      }
    } catch (error) {
      if (searchRequestGenerationRef.current !== generation) return;
      console.error('[ChatWrapper] Failed to load more search results:', error);
      searchOperationInFlightRef.current = false;
      setConversationSearch((current) => ({
        ...current,
        loadingMore: false,
        error: 'Could not load more results',
      }));
    }
  }, [
    activeChat,
    conversationSearch,
    queueSearchJump,
    searchMode,
  ]);

  const handleMessageJumpHandled = useCallback((
    requestId: number,
    outcome: MessageJumpOutcome,
  ) => {
    setMessageJumpRequest((current) => {
      if (current?.requestId !== requestId) return current;
      return null;
    });

    if (activeSearchJumpRequestIdRef.current !== requestId) return;
    activeSearchJumpRequestIdRef.current = null;
    searchOperationInFlightRef.current = false;

    setConversationSearch((current) => {
      if (!current.open) return current;
      return {
        ...current,
        jumpPending: false,
        error: outcome === 'unavailable'
          ? 'Message is no longer available'
          : outcome === 'error'
            ? 'Could not load this message'
            : null,
      };
    });
  }, []);

  // Enter -> next match, Shift+Enter -> previous match, while search is open.
  useEffect(() => {
    if (!searchMode) return;

    const handleSearchNav = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      event.preventDefault();
      void navigateConversationSearch(event.shiftKey ? -1 : 1);
    };

    document.addEventListener('keydown', handleSearchNav);
    return () => document.removeEventListener('keydown', handleSearchNav);
  }, [navigateConversationSearch, searchMode]);

  const requestDeleteSelectedMessages = useCallback(() => {
    if (selectedMessageCount === 0 || isDeletingMessages) return;
    setDeleteConfirmOpen(true);
  }, [isDeletingMessages, selectedMessageCount]);

  const confirmDeleteSelectedMessages = useCallback(async () => {
    const selection = activeMessageSelection;
    if (!selection || selection.messageIds.size === 0 || isDeletingMessages) return;

    const chatId = selection.chatId;
    const messageIds = Array.from(selection.messageIds);
    const persistedMessageIds = messageIds.filter((messageId) =>
      messages.some((message) => message.chatId === chatId && message.id === messageId)
    );
    const rendererOnlyFailedIds = messageIds.filter((messageId) =>
      sendingMessages.some(
        (message) =>
          message.chatId === chatId
          && message.id === messageId
          && message.localSendState === 'failed'
      )
    );
    if (persistedMessageIds.length + rendererOnlyFailedIds.length !== messageIds.length) {
      toast.error('One or more selected messages changed. Review the selection and try again.');
      return;
    }

    const visibleCount = messages.filter((message) => message.chatId === chatId).length;
    setIsDeletingMessages(true);

    try {
      let latestRemaining = null;
      if (persistedMessageIds.length > 0) {
        const result = await window.kiyeovoAPI.deleteMessagesForMe(chatId, persistedMessageIds);
        if (!result.success) {
          toast.error(result.error || 'Failed to delete selected messages');
          return;
        }
        latestRemaining = result.latestRemaining;
      }

      if (persistedMessageIds.length > 0) {
        const refreshRequest: MessageHistoryRefreshRequest = {
          requestId: ++nextHistoryRefreshRequestIdRef.current,
          chatId,
          visibleCount,
        };
        setHistoryRefreshRequest(refreshRequest);
        dispatch(removeMessagesByIds({
          chatId,
          messageIds,
          latestRemaining,
        }));
      } else {
        dispatch(removeSendingMessagesByIds({
          chatId,
          messageIds: rendererOnlyFailedIds,
        }));
      }
      setDeleteConfirmOpen(false);
      setMessageSelection(null);
      // A deleted message takes its pin with it (the row is gone); re-sync the bar.
      if (persistedMessageIds.length > 0 && pinnedPreview) {
        void refreshPinnedPreview(chatId);
      }
      toast.success(messageIds.length === 1 ? 'Message deleted' : `${messageIds.length} messages deleted`);
    } catch (error) {
      console.error('[ChatWrapper] Failed to delete selected messages:', error);
      toast.error('Failed to delete selected messages');
    } finally {
      setIsDeletingMessages(false);
    }
  }, [activeMessageSelection, dispatch, isDeletingMessages, messages, sendingMessages, toast, pinnedPreview, refreshPinnedPreview]);

  const handleHistoryRefreshHandled = useCallback((requestId: number) => {
    setHistoryRefreshRequest((current) =>
      current?.requestId === requestId ? null : current
    );
  }, []);

  const FooterToDisplay = useMemo(() => {
    if (activeContactAttempt) {
      return <InvitationManager key={activeContactAttempt.peerId} peerId={activeContactAttempt.peerId} />
    }
    if (activePendingKeyExchange) {
      return <PendingKxManager peerId={activePendingKeyExchange.peerId} />
    }
    if (activeChat) {
      return (
        <>
          <ChatInput
            onOfflineInboxRelevant={openOfflineInbox}
            selectionMode={selectionMode}
            searchMode={searchMode}
          />
          {searchMode ? (
            <ConversationSearchNavigation
              query={conversationSearch.query}
              currentIndex={conversationSearch.selectedIndex}
              total={conversationSearch.total}
              loading={conversationSearch.loading || conversationSearch.loadingMore}
              pending={conversationSearch.jumpPending}
              error={conversationSearch.error}
              onPrevious={() => {
                void navigateConversationSearch(-1);
              }}
              onNext={() => {
                void navigateConversationSearch(1);
              }}
            />
          ) : selectionMode ? (
            <MessageSelectionBar
              selectedCount={selectedMessageCount}
              onDelete={requestDeleteSelectedMessages}
            />
          ) : null}
        </>
      );
    }
    return null;
  }, [
    activePendingKeyExchange,
    activeContactAttempt,
    activeChat,
    openOfflineInbox,
    conversationSearch,
    navigateConversationSearch,
    selectedMessageCount,
    searchMode,
    selectionMode,
    requestDeleteSelectedMessages,
  ]);

  return (
    <div className="min-w-12 flex-1 flex flex-col h-full bg-background">
      {!activeChat && !activeContactAttempt && !activePendingKeyExchange ? (
        <EmptyState />
      ) : (
        <>
          <ChatHeader
            username={activeChat?.name ?? activeContactAttempt?.username ?? activePendingKeyExchange?.username ?? ''}
            peerId={activeChat?.peerId ?? activeContactAttempt?.peerId ?? activePendingKeyExchange?.peerId ?? ''}
            chatType={activeChat?.type}
            groupStatus={activeChat?.groupStatus}
            chatId={activeChat?.id}
            onSelectMessages={activeChat ? startSelectionMode : undefined}
            selectionMode={selectionMode}
            onCancelSelection={exitSelectionMode}
            searchMode={searchMode}
            searchQuery={conversationSearch.query}
            searchLoading={conversationSearch.loading}
            searchFocusRequest={searchFocusRequest}
            onStartSearch={startConversationSearch}
            onSearchQueryChange={updateConversationSearchQuery}
            onCancelSearch={closeConversationSearch}
          />
          {groupCreatorLinkState.broken && (
            <div className="mx-6 mb-2 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              You do not have a direct chat with {creatorLabel || 'the group creator'}, so you cannot receive future group updates.
              Existing messages may still work until the next group update.
              To fix this: make sure {groupCreatorLinkState.creatorName || 'the creator'} also deletes you, then establish a new conversation.
            </div>
          )}
          {activeChat && pinnedPreview && (
            <PinnedMessageBar
              preview={pinnedPreview}
              myPeerId={myPeerId}
              onJump={handleJumpToPinned}
              onUnpin={handleUnpinFromBar}
            />
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <MessagesContainer
              messages={messagesToDisplay}
              isPending={!!activeContactAttempt || !!activePendingKeyExchange}
              selectionMode={selectionMode}
              selectedMessageIds={activeMessageSelection?.messageIds}
              onToggleMessageSelection={toggleMessageSelection}
              onEnterMessageSelection={enterSelectionMode}
              historyRefreshRequest={historyRefreshRequest}
              onHistoryRefreshHandled={handleHistoryRefreshHandled}
              messageJumpRequest={messageJumpRequest}
              onMessageJumpHandled={handleMessageJumpHandled}
              activeSearchClientMsgId={activeSearchClientMsgId}
              searchHighlightQuery={searchMode ? conversationSearch.query.trim() : ''}
              onOfflineInboxRelevant={openOfflineInbox}
              bottomOverlayClearancePx={activeChat
                ? (isBottomOverlayExpanded
                  ? OFFLINE_INBOX_EXPANDED_CLEARANCE_PX
                  : OFFLINE_INBOX_COLLAPSED_CLEARANCE_PX)
                : 0}
              onTogglePin={handleTogglePin}
            />
            <div className="relative">
              {activeChat && (
                <div className="pointer-events-none absolute bottom-full left-0 z-30">
                  <div className="pointer-events-auto flex items-end gap-0">
                    <OfflineInboxCapacity
                      chatId={activeChat.id}
                      expanded={isOfflineInboxExpanded}
                      onToggle={toggleOfflineInbox}
                    />
                    <PendingFileInboxIndicator
                      chatId={activeChat.id}
                      attention={!!activeChat.pendingFileInboxAttention}
                      expanded={isPendingFileInboxExpanded}
                      onToggle={togglePendingFileInbox}
                      onClearAttention={clearPendingFileInboxAttention}
                    />
                  </div>
                </div>
              )}
              {FooterToDisplay}
            </div>
          </div>
          <DeleteSelectedMessagesDialog
            open={deleteConfirmOpen}
            onOpenChange={setDeleteConfirmOpen}
            selectedCount={selectedMessageCount}
            deleting={isDeletingMessages}
            onConfirm={() => {
              void confirmDeleteSelectedMessages();
            }}
          />
        </>
      )}
    </div>
  );
};

export default ChatWrapper;
