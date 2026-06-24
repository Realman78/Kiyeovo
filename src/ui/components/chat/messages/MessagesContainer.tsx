import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { finalizeSendingMessage, markOfflineFetched, markOfflineFetchFailed, prependMessages, replaceMessagesForChat, resolveMessageSendOutcome, setMessages, setOfflineFetchStatus, updateChat, updateLocalMessageSendState, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinuteEu } from "../../../utils/dateUtils";
import { PendingNotifications } from "./PendingNotifications";
import { MessageRow } from "./MessageRow";
import type { MessageSentStatus } from "../../../types";
import type { FileTransferStatus } from "../../../../core/types";
import { FILE_ACCEPTANCE_TIMEOUT, INITIAL_MESSAGES_LIMIT, LOAD_MORE_MESSAGES_LIMIT } from "../../../constants";
import { useToast } from "../../ui/use-toast";
import { useOfflineSendWarning } from "../../../hooks/useOfflineSendWarning";
import type { Message } from "../../../../core/db/database";
import { errStr } from '../../../../core/utils/general-error';
import { useConnectivityGuidance } from "../../../hooks/useConnectivityGuidance";
import { ChevronDown } from "lucide-react";

type MessagesContainerProps = {
  messages: ChatMessage[];
  isPending: boolean;
  selectionMode?: boolean;
  selectedMessageIds?: ReadonlySet<string>;
  onToggleMessageSelection?: (messageId: string) => void;
  onEnterMessageSelection?: (messageId: string) => void;
  historyRefreshRequest?: MessageHistoryRefreshRequest | null;
  onHistoryRefreshHandled?: (requestId: number) => void;
  onOfflineInboxRelevant?: () => void;
  bottomOverlayClearancePx?: number;
}

export type MessageHistoryRefreshRequest = {
  requestId: number;
  chatId: number;
  visibleCount: number;
};

type LoadMoreResult = 'loaded' | 'exhausted' | 'cancelled' | 'error';
const TERMINAL_FILE_TRANSFER_STATUSES = new Set<FileTransferStatus>([
  'completed',
  'failed',
  'expired',
  'rejected',
]);

function mapDbMessage(msg: Message & { sender_username?: string }): ChatMessage {
  let fileName = msg.file_name;
  let fileSize = msg.file_size;
  if (msg.message_type === 'file' && (!fileName || fileSize === undefined)) {
    const match = msg.content?.match(/^(.*)\s+\((\d+)\s+bytes\)$/);
    if (match) {
      fileName = fileName || match[1];
      if (fileSize === undefined) fileSize = Number(match[2]);
    }
  }
  const inferredTransferStatus =
    msg.transfer_status ??
    (msg.message_type === 'file' ? 'completed' : undefined);

  const transferExpiresAt =
    msg.message_type === 'file' && (
      msg.transfer_status === 'pending' ||
      msg.transfer_status === 'awaiting_acceptance' ||
      msg.transfer_status === 'incoming_pending_user'
    )
      ? msg.timestamp.getTime() + FILE_ACCEPTANCE_TIMEOUT
      : undefined;

  return {
    id: msg.id,
    chatId: msg.chat_id,
    senderPeerId: msg.sender_peer_id,
    senderUsername: msg.sender_username || 'UNKNOWN',
    content: msg.content,
    timestamp: msg.timestamp.getTime(),
    eventTimestamp: msg.event_timestamp ? msg.event_timestamp.getTime() : undefined,
    messageType: msg.message_type as 'text' | 'file' | 'image' | 'system',
    messageSentStatus: 'online' as MessageSentStatus,
    clientMsgId: msg.client_msg_id,
    replyToClientId: msg.reply_to_client_id ?? undefined,
    fileName,
    fileSize,
    filePath: msg.file_path,
    transferStatus: inferredTransferStatus as FileTransferStatus | undefined,
    transferProgress: msg.transfer_progress,
    transferError: msg.transfer_error,
    transferExpiresAt,
    // Restore outbound send lifecycle (incl. the retry cooldown, so a
    // group-rekey block survives a restart instead of becoming immediately
    // retryable).
    localSendState: msg.local_send_state ?? undefined,
    failedReason: (msg.failed_reason as ChatMessage['failedReason']) ?? undefined,
    retryAfterTs: msg.retry_after_ts ?? undefined,
  };
}

export const MessagesContainer = ({
  messages,
  isPending,
  selectionMode = false,
  selectedMessageIds,
  onToggleMessageSelection,
  onEnterMessageSelection,
  historyRefreshRequest,
  onHistoryRefreshHandled,
  onOfflineInboxRelevant,
  bottomOverlayClearancePx = 0,
}: MessagesContainerProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Inner content wrapper observed for height changes (stick-to-bottom on async growth).
  const contentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  // Current vs. last-observed message count, to tell a real new/removed message
  // (count change → handled by the smooth auto-scroll / loadMore) apart from async
  // content growth at a stable count (e.g. a reply quote resolving late).
  const messagesLengthRef = useRef(0);
  const observerSeenLengthRef = useRef(0);
  const skipNextAutoScrollRef = useRef(false);
  // Jump-to-message: suppress the bottom auto-scroll while we page back to a quote
  const isJumpingRef = useRef(false);
  const jumpGenerationRef = useRef(0);
  const pulseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingMoreRef = useRef(false);
  const loadMoreInFlightRef = useRef<{
    chatId: number;
    requestId: symbol;
    promise: Promise<LoadMoreResult>;
  } | null>(null);
  const activeChatIdRef = useRef<number | null>(null);
  const loadTokenRef = useRef(0);
  const topZoneActiveRef = useRef(false);
  const hasUserInteractedRef = useRef(false);
  const suppressTopLoadRef = useRef(false);
  const suppressTopLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const persistedMessages = useSelector((state: RootState) => state.chat.messages);
  const dispatch = useDispatch();
  const { toast } = useToast();
  const { showMessageFailureGuidance } = useConnectivityGuidance();
  const warnOfflineSend = useOfflineSendWarning();

  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isScrollable, setIsScrollable] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const offsetRef = useRef(0);
  const latestDisplayedMessagesRef = useRef(messages);
  const persistedMessagesRef = useRef(persistedMessages);
  const showEmptyState = !isPending && messages.length === 0;
  // Kept current synchronously (during render) so the ResizeObserver callback,
  // which runs before paint, reads an up-to-date count.
  messagesLengthRef.current = messages.length;

  const isMessageSelectable = useCallback((message: ChatMessage): boolean => {
    if (
      message.messageType === 'system'
      || message.localSendState === 'queued'
      || message.localSendState === 'sending'
    ) {
      return false;
    }
    if (message.messageType === 'file' || message.messageType === 'image') {
      return message.transferStatus !== undefined
        && TERMINAL_FILE_TRANSFER_STATUSES.has(message.transferStatus);
    }
    return true;
  }, []);

  const getMembershipInfoTooltip = (message: ChatMessage): string | null => {
    if (message.messageType !== 'system' || !message.eventTimestamp) {
      return null;
    }
    const normalized = message.content.toLowerCase();
    const isMembershipEvent =
      normalized.includes('joined the group') ||
      normalized.includes('left the group') ||
      normalized.includes('was removed from the group');
    if (!isMembershipEvent) {
      return null;
    }
    return `${message.content} at ${formatTimestampToHourMinuteEu(message.eventTimestamp)}.${normalized.includes('joined the group') ? ' This member can only see your messages after this system message, not strictly after the join time.' : ''}`;
  };

  const suppressTopLoadTemporarily = useCallback((durationMs = 180) => {
    suppressTopLoadRef.current = true;
    if (suppressTopLoadTimerRef.current) {
      clearTimeout(suppressTopLoadTimerRef.current);
    }
    suppressTopLoadTimerRef.current = setTimeout(() => {
      suppressTopLoadRef.current = false;
      suppressTopLoadTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (suppressTopLoadTimerRef.current) {
        clearTimeout(suppressTopLoadTimerRef.current);
        suppressTopLoadTimerRef.current = null;
      }
    };
  }, []);

  const markUserInteraction = useCallback(() => {
    hasUserInteractedRef.current = true;
  }, []);

  const updateBottomState = useCallback((container: HTMLElement) => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const atBottom = distanceFromBottom <= 64;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  // Stick to the bottom when content grows underneath the viewport at a *stable*
  // message count — e.g. a reply quote resolving async after the initial scroll has
  // already landed — so the latest message stays fully visible. New/removed messages
  // (count change) are left to the smooth auto-scroll effect and loadMore's restore.
  useEffect(() => {
    const container = scrollContainerRef.current;
    const content = contentRef.current;
    if (!container || !content || typeof ResizeObserver === 'undefined') return;
    observerSeenLengthRef.current = messagesLengthRef.current;
    const observer = new ResizeObserver(() => {
      const len = messagesLengthRef.current;
      const countChanged = len !== observerSeenLengthRef.current;
      observerSeenLengthRef.current = len;
      if (countChanged) return;
      if (isJumpingRef.current || isLoadingMoreRef.current || !isAtBottomRef.current) return;
      container.scrollTop = container.scrollHeight;
      setIsAtBottom(true);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [activeChat?.id]);

  useEffect(() => {
    latestDisplayedMessagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    persistedMessagesRef.current = persistedMessages;
  }, [persistedMessages]);

  useLayoutEffect(() => {
    jumpGenerationRef.current += 1;
    isJumpingRef.current = false;
    skipNextAutoScrollRef.current = false;
    loadMoreInFlightRef.current = null;
    activeChatIdRef.current = activeChat?.id ?? null;
    loadTokenRef.current += 1;
  }, [activeChat?.id]);

  // Initial fetch
  useEffect(() => {
    const chatId = activeChat?.id ?? null;
    const requestToken = loadTokenRef.current;
    setError(null);
    setHasMore(true);
    setIsLoadingMore(false);
    isLoadingMoreRef.current = false;
    offsetRef.current = 0;
    topZoneActiveRef.current = false;
    hasUserInteractedRef.current = false;
    suppressTopLoadRef.current = false;

    const fetchMessages = async () => {
      if (!chatId) return;
      const result = await window.kiyeovoAPI.getMessages(chatId, INITIAL_MESSAGES_LIMIT, 0);
      if (loadTokenRef.current !== requestToken || activeChatIdRef.current !== chatId) {
        return;
      }
      if (result.success) {
        const mapped = result.messages.map(mapDbMessage);
        const hasOptimisticContactSeed = latestDisplayedMessagesRef.current.some(
          (msg) => msg.chatId === chatId && msg.id.startsWith('contact-attempt-' + chatId + '-'),
        );

        if (mapped.length === 0 && hasOptimisticContactSeed) {
          offsetRef.current = 0;
          setHasMore(false);
          return;
        }

        dispatch(setMessages(mapped));
        offsetRef.current = mapped.length;
        setHasMore(mapped.length >= INITIAL_MESSAGES_LIMIT);
      } else {
        setError(result.error || 'Failed to fetch messages');
      }
    }
    void fetchMessages();
  }, [activeChat?.id, dispatch]);

  useLayoutEffect(() => {
    if (!historyRefreshRequest) return;
    skipNextAutoScrollRef.current = true;
  }, [historyRefreshRequest]);

  const refreshMessagesAfterDelete = useEffectEvent(async (
    request: MessageHistoryRefreshRequest,
    chatId: number,
    isCancelled: () => boolean,
  ) => {
      const requestToken = ++loadTokenRef.current;
      loadMoreInFlightRef.current = null;
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
      jumpGenerationRef.current += 1;
      isJumpingRef.current = false;
      skipNextAutoScrollRef.current = true;

      const startingIds = new Set(
        persistedMessagesRef.current
          .filter((message) => message.chatId === chatId)
          .map((message) => message.id)
      );
      const limit = Math.max(INITIAL_MESSAGES_LIMIT, request.visibleCount);
      const container = scrollContainerRef.current;
      const previousScrollTop = container?.scrollTop ?? 0;
      const wasAtBottom = isAtBottomRef.current;

      try {
        const result = await window.kiyeovoAPI.getMessages(chatId, limit, 0);
        if (
          isCancelled()
          || loadTokenRef.current !== requestToken
          || activeChatIdRef.current !== chatId
        ) {
          return;
        }
        if (!result.success) {
          toast.error(result.error || 'Messages were deleted, but history could not be refreshed');
          return;
        }

        const refreshed = result.messages.map(mapDbMessage);
        const refreshedIds = new Set(refreshed.map((message) => message.id));
        const messagesAddedDuringRefresh = persistedMessagesRef.current.filter(
          (message) =>
            message.chatId === chatId
            && !startingIds.has(message.id)
            && !refreshedIds.has(message.id)
        );
        const merged = [...refreshed, ...messagesAddedDuringRefresh]
          .sort((a, b) => a.timestamp - b.timestamp);

        skipNextAutoScrollRef.current = true;
        dispatch(replaceMessagesForChat({ chatId, messages: merged }));
        offsetRef.current = refreshed.length;
        setHasMore(refreshed.length >= limit);

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            if (
              !isCancelled()
              && loadTokenRef.current === requestToken
              && activeChatIdRef.current === chatId
              && container
            ) {
              suppressTopLoadTemporarily();
              container.scrollTop = wasAtBottom
                ? container.scrollHeight
                : Math.min(previousScrollTop, Math.max(0, container.scrollHeight - container.clientHeight));
              updateBottomState(container);
            }
            resolve();
          });
        });
      } catch (error) {
        if (!isCancelled()) {
          console.error('[MessagesContainer] Failed to refresh messages after deletion:', error);
          toast.error('Messages were deleted, but history could not be refreshed');
        }
      } finally {
        if (!isCancelled()) {
          onHistoryRefreshHandled?.(request.requestId);
        }
      }
  });

  const markHistoryRefreshHandled = useEffectEvent((requestId: number) => {
    onHistoryRefreshHandled?.(requestId);
  });

  useEffect(() => {
    if (!historyRefreshRequest) return;
    const request = historyRefreshRequest;
    const chatId = activeChat?.id;
    if (chatId !== request.chatId) {
      markHistoryRefreshHandled(request.requestId);
      return;
    }

    let cancelled = false;
    void refreshMessagesAfterDelete(request, chatId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [activeChat?.id, historyRefreshRequest]);

  // Load more on scroll to top
  const loadMore = useCallback((): Promise<LoadMoreResult> => {
    const chatId = activeChat?.id;
    if (!chatId) return Promise.resolve('cancelled');

    const inFlight = loadMoreInFlightRef.current;
    if (inFlight?.chatId === chatId) {
      return inFlight.promise;
    }
    if (!hasMore) return Promise.resolve('exhausted');

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const requestToken = loadTokenRef.current;
    const requestId = Symbol('load-more');
    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    const promise = (async (): Promise<LoadMoreResult> => {
      try {
        const result = await window.kiyeovoAPI.getMessages(chatId, LOAD_MORE_MESSAGES_LIMIT, offsetRef.current);
        if (loadTokenRef.current !== requestToken || activeChatIdRef.current !== chatId) {
          return 'cancelled';
        }
        if (!result.success) {
          console.error('[MessagesContainer] Failed to load more messages:', result.error);
          return 'error';
        }

        const mapped = result.messages.map(mapDbMessage);
        if (mapped.length > 0) {
          skipNextAutoScrollRef.current = true;
          dispatch(prependMessages(mapped));
          offsetRef.current += mapped.length;

          // Restore scroll position after DOM update
          requestAnimationFrame(() => {
            if (
              !container
              || loadTokenRef.current !== requestToken
              || activeChatIdRef.current !== chatId
              || scrollContainerRef.current !== container
            ) return;

            suppressTopLoadTemporarily();
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - prevScrollHeight;
          });
        }
        const exhausted = mapped.length < LOAD_MORE_MESSAGES_LIMIT;
        if (exhausted) {
          setHasMore(false);
        }
        return exhausted ? 'exhausted' : 'loaded';
      } catch (err) {
        console.error('[MessagesContainer] Failed to load more messages:', err);
        return 'error';
      } finally {
        if (loadMoreInFlightRef.current?.requestId === requestId) {
          loadMoreInFlightRef.current = null;
        }
        if (loadTokenRef.current === requestToken && activeChatIdRef.current === chatId) {
          isLoadingMoreRef.current = false;
          setIsLoadingMore(false);
        }
      }
    })();

    loadMoreInFlightRef.current = { chatId, requestId, promise };
    return promise;
  }, [activeChat?.id, hasMore, dispatch, suppressTopLoadTemporarily]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setIsScrollable(true);
      return;
    }

    let frameId: number | null = null;
    const updateScrollable = () => {
      setIsScrollable(container.scrollHeight > container.clientHeight + 1);
      updateBottomState(container);
    };

    frameId = requestAnimationFrame(updateScrollable);
    const onResize = () => updateScrollable();
    window.addEventListener('resize', onResize);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener('resize', onResize);
    };
  }, [activeChat?.id, messages.length, isLoadingMore, hasMore, showEmptyState, updateBottomState]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const thresholdPx = Math.min(120, Math.max(24, container.clientHeight * 0.08));
    const inTopZone = container.scrollTop <= thresholdPx;
    const wasInTopZone = topZoneActiveRef.current;
    topZoneActiveRef.current = inTopZone;
    updateBottomState(container);

    if (suppressTopLoadRef.current || !hasUserInteractedRef.current) {
      return;
    }

    if (!wasInTopZone && inTopZone && hasMore && !isLoadingMoreRef.current) {
      void loadMore();
    }
  }, [hasMore, loadMore, updateBottomState]);

  const scrollToBottom = useCallback(() => {
    suppressTopLoadTemporarily();
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [suppressTopLoadTemporarily]);

  useEffect(() => {
    if (activeChat?.justCreated && messages.length === 0) {
      const timeout = setTimeout(() => {
        if (messages.length === 0) {
          dispatch(updateChat({
            id: activeChat.id,
            updates: { justCreated: false }
          }));
        }
      }, 10000);

      return () => clearTimeout(timeout);
    }
  }, [activeChat?.justCreated, activeChat?.id, messages.length, dispatch]);

  useEffect(() => {
    if (isJumpingRef.current) return;
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    if (messagesEndRef.current) {
      suppressTopLoadTemporarily();
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, suppressTopLoadTemporarily]);

  useEffect(() => () => {
    jumpGenerationRef.current += 1;
    isJumpingRef.current = false;
    skipNextAutoScrollRef.current = false;
    if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
  }, []);

  const isTrustedOutOfBand = activeChat?.trusted_out_of_band;
  let previousSenderPeerId: string | null = null;
  let senderStreak = 0;

  // Briefly tint the target bubble so the eye lands on it after a jump.
  const pulseRow = useCallback((rowEl: HTMLElement) => {
    const bubble = rowEl.querySelector<HTMLElement>('[data-message-bubble]') ?? rowEl;
    bubble.classList.remove('reply-pulse-highlight');
    void bubble.offsetWidth; // force reflow so the animation restarts on a repeat jump
    bubble.classList.add('reply-pulse-highlight');
    if (pulseTimeoutRef.current) clearTimeout(pulseTimeoutRef.current);
    pulseTimeoutRef.current = setTimeout(() => {
      bubble.classList.remove('reply-pulse-highlight');
      pulseTimeoutRef.current = null;
    }, 2600);
  }, []);

  const waitForJumpTarget = useCallback((
    rowEl: HTMLElement,
    container: HTMLElement,
    isCurrentJump: () => boolean,
  ): Promise<boolean> => new Promise((resolve) => {
    const startedAt = performance.now();
    let previousScrollTop = container.scrollTop;
    let stableFrames = 0;

    const checkVisibility = () => {
      if (!isCurrentJump() || !rowEl.isConnected) {
        resolve(false);
        return;
      }

      const rowRect = rowEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const isVisible = rowRect.bottom > containerRect.top && rowRect.top < containerRect.bottom;
      const currentScrollTop = container.scrollTop;

      stableFrames = isVisible && Math.abs(currentScrollTop - previousScrollTop) < 0.5
        ? stableFrames + 1
        : 0;
      previousScrollTop = currentScrollTop;

      if (stableFrames >= 2) {
        resolve(true);
        return;
      }
      if (performance.now() - startedAt >= 5000) {
        resolve(isVisible);
        return;
      }

      requestAnimationFrame(checkVisibility);
    };

    requestAnimationFrame(checkVisibility);
  }), []);

  const handleJumpToMessage = useCallback(async (clientMsgId: string) => {
    const chatId = activeChat?.id;
    const container = scrollContainerRef.current;
    if (!chatId || !container) return;
    const requestToken = loadTokenRef.current;
    const jumpGeneration = ++jumpGenerationRef.current;
    const findRow = () => container.querySelector<HTMLElement>(`[data-cid="${CSS.escape(clientMsgId)}"]`);
    const isCurrentJump = () =>
      jumpGenerationRef.current === jumpGeneration
      && activeChatIdRef.current === chatId
      && loadTokenRef.current === requestToken
      && scrollContainerRef.current === container;

    isJumpingRef.current = true;
    try {
      let row = findRow();
      const MAX_PAGES = 200;
      let pages = 0;
      let exhausted = false;
      while (!row && pages < MAX_PAGES) {
        const result = await loadMore();
        if (!isCurrentJump()) return;

        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!isCurrentJump()) return;

        row = findRow();
        if (row) break;
        if (result === 'loaded') {
          pages++;
          continue;
        }
        if (result === 'exhausted') {
          exhausted = true;
          break;
        }
        if (result === 'error') {
          toast.error('Could not load older messages');
        }
        return;
      }

      if (!isCurrentJump()) return;
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const isVisible = await waitForJumpTarget(row, container, isCurrentJump);
        if (!isVisible || !isCurrentJump()) return;
        pulseRow(row);
      } else if (exhausted) {
        toast.info('Original message is no longer available');
      } else {
        toast.info('Could not search the full message history');
      }
    } finally {
      if (jumpGenerationRef.current === jumpGeneration) {
        isJumpingRef.current = false;
        skipNextAutoScrollRef.current = false;
      }
    }
  }, [activeChat?.id, loadMore, pulseRow, toast, waitForJumpTarget]);

  const handleRetryFailedMessage = useCallback(async (message: ChatMessage) => {
    if (!activeChat) return;
    const retryBlockedByRekeyCooldown =
      message.failedReason === 'group_rekeying' &&
      !!message.retryAfterTs &&
      Date.now() < message.retryAfterTs;
    if (retryBlockedByRekeyCooldown) {
      const seconds = Math.ceil((message.retryAfterTs! - Date.now()) / 1000);
      toast.info(`Group is rekeying. Retry available in ${seconds}s.`);
      return;
    }

    // Delivered online; only the offline backup failed → re-store the backup,
    // do NOT re-send the message (online members already have it).
    if (message.failedReason === 'offline_backup') {
      dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'sending' }));
      try {
        const res = await window.kiyeovoAPI.retryGroupOfflineBackup(activeChat.id, message.id);
        if (res.success) {
          dispatch(resolveMessageSendOutcome({ messageId: message.id, outcome: 'delivered' }));
          toast.success('Offline backup synced');
        } else {
          dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed', failedReason: 'offline_backup' }));
          toast.error(res.error || 'Failed to retry offline backup');
        }
      } catch (err) {
        dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed', failedReason: 'offline_backup' }));
        toast.error(errStr(err, 'Failed to retry offline backup'));
      }
      return;
    }

    dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'sending' }));

    try {
      if (activeChat.type === 'group') {
        const { success, error, warning, offlineBackupRetry, message: sentMessage, messageSentStatus } = await window.kiyeovoAPI.sendGroupMessage(
          activeChat.id,
          message.content,
          { rekeyRetryHint: message.failedReason === 'group_rekeying', replyToCid: message.replyToClientId },
        );
        if (!success) {
          const isRekeyFailure =
            (error || '').includes('is not active') &&
            activeChat.groupStatus === 'rekeying';
          dispatch(updateLocalMessageSendState({
            messageId: message.id,
            state: 'failed',
            failedReason: isRekeyFailure ? 'group_rekeying' : 'other',
            retryAfterTs: isRekeyFailure ? Date.now() + 30_000 : undefined,
          }));
          toast.error(error || 'Failed to resend group message');
          return;
        }
        warnOfflineSend();
        const backupFailed = !!(warning && offlineBackupRetry);
        if (backupFailed) {
          toast.warning(warning!);
        }
        if (sentMessage?.messageId) {
          onOfflineInboxRelevant?.();
          dispatch(finalizeSendingMessage({
            localMessageId: message.id,
            finalMessage: {
              ...message,
              id: sentMessage.messageId,
              timestamp: sentMessage.timestamp ?? Date.now(),
              messageSentStatus: messageSentStatus ?? 'online',
              localSendState: undefined,
              clientMsgId: sentMessage.clientMsgId,
              replyToClientId: message.replyToClientId,
            },
          }));
          // Delivered online but backup failed again → re-show the dedicated affordance.
          if (backupFailed) {
            dispatch(updateLocalMessageSendState({
              messageId: sentMessage.messageId,
              state: 'failed',
              failedReason: 'offline_backup',
            }));
          }
        }
        return;
      }

      if (!activeChat.peerId) {
        dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
        toast.error('No peer ID found for active chat');
        return;
      }

      // A persisted offline-queue send (real backend id) is requeued + reflushed in
      // place — re-sending would create a duplicate row. A never-persisted optimistic
      // row (local-send-… id) is re-sent from scratch.
      if (!message.id.startsWith('local-send-')) {
        const res = await window.kiyeovoAPI.retryOfflineSend(message.id);
        if (!res.success) {
          dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
          toast.error(res.error || 'Failed to retry message');
        } else {
          onOfflineInboxRelevant?.();
        }
        // success → backend emits 'sending' then the settled outcome via events.
        return;
      }

      const {
        success,
        error,
        message: sentMessage,
        messageSentStatus,
        localSendState,
        connectivityFailure,
      } = await window.kiyeovoAPI.sendMessage(activeChat.peerId, message.content, message.replyToClientId);
      if (!success) {
        dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
        if (error === 'OFFLINE_BUCKET_FULL') {
          onOfflineInboxRelevant?.();
          if (activeChat.type === 'direct' && activeChat.peerId) {
            void window.kiyeovoAPI.requestOfflineInboxRecovery(activeChat.peerId).catch(() => undefined);
          }
        }
        if (!connectivityFailure || !showMessageFailureGuidance(connectivityFailure)) {
          toast.error(error || 'Failed to resend message');
        }
      } else if (sentMessage?.messageId) {
        const stillSending = localSendState === 'sending';
        if (!stillSending) warnOfflineSend();
        if (messageSentStatus === 'offline') {
          onOfflineInboxRelevant?.();
        }
        dispatch(finalizeSendingMessage({
          localMessageId: message.id,
          finalMessage: {
            ...message,
            id: sentMessage.messageId,
            timestamp: sentMessage.timestamp ?? Date.now(),
            messageSentStatus: stillSending ? null : (messageSentStatus ?? 'online'),
            localSendState: stillSending ? 'sending' : undefined,
            // Adopt the cid the backend minted on this (re)send; the spread above
            // would otherwise keep the optimistic row's stale/empty clientMsgId.
            clientMsgId: sentMessage.clientMsgId,
          },
        }));
      }
    } catch (err) {
      dispatch(updateLocalMessageSendState({ messageId: message.id, state: 'failed' }));
      toast.error(errStr(err, 'Unexpected resend error'));
    }
  }, [
    activeChat,
    dispatch,
    onOfflineInboxRelevant,
    showMessageFailureGuidance,
    toast,
    warnOfflineSend,
  ]);

  const handleRetryOfflineFetch = useCallback(async () => {
    if (!activeChat?.id) return;
    const chatId = activeChat.id;
    dispatch(setOfflineFetchStatus({ chatId, isFetching: true }));

    try {
      if (activeChat.type === 'group') {
        const result = await window.kiyeovoAPI.checkGroupOfflineMessagesForChat(chatId);
        if (!result.success || (result.failedChatIds ?? []).includes(chatId)) {
          dispatch(markOfflineFetchFailed(chatId));
          toast.error(result.error || 'Failed to fetch offline messages');
          return;
        }

        dispatch(markOfflineFetched(chatId));
        const unreadMap = result.unreadFromChats instanceof Map
          ? result.unreadFromChats
          : new Map<number, number>();
        const unread = unreadMap.get(chatId) ?? 0;
        if (unread > 0) {
          toast.success(`Fetched ${unread} missed group message${unread === 1 ? '' : 's'}`);
        } else {
          toast.success('Offline messages synced');
        }
        const chatWarnings = result.gapWarnings.filter(w => w.chatId === chatId);
        if (chatWarnings.length > 0) {
          toast.warning(`Detected ${chatWarnings.length} sequence gap(s); some old messages may be missing`);
        }
        return;
      }

      const result = await window.kiyeovoAPI.checkOfflineMessagesForChat(chatId);
      if (!result.success) {
        dispatch(markOfflineFetchFailed(chatId));
        toast.error(result.error || 'Failed to fetch offline messages');
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
        toast.success('Offline messages synced');
      }
    } catch (error) {
      dispatch(markOfflineFetchFailed(chatId));
      toast.error(errStr(error, 'Failed to fetch offline messages'));
    }
  }, [activeChat, dispatch, toast]);

  return <div className="relative min-h-0 flex-1">
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      onWheel={markUserInteraction}
      onTouchStart={markUserInteraction}
      onPointerDown={markUserInteraction}
      className="h-full overflow-y-auto p-6"
      style={{ paddingBottom: `${bottomOverlayClearancePx}px` }}
    >
    <div ref={contentRef} className="min-h-full space-y-2">
    {activeChat?.offlineFetchNeedsSync && !activeChat.blocked && (
      <div className="sticky top-2 z-20 mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <span>Failed to fetch offline messages.</span>
        <button
          type="button"
          className="rounded border border-destructive/50 px-2 py-1 text-[11px] font-medium hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={activeChat.isFetchingOffline === true}
          onClick={() => {
            void handleRetryOfflineFetch();
          }}
        >
          {activeChat.isFetchingOffline ? 'Retrying...' : 'Retry'}
        </button>
      </div>
    )}
    {/* Sentinel for loading older messages */}
    {hasMore && !showEmptyState && (isLoadingMore || !isScrollable) && (
      <div className="flex justify-center py-2">
        {isLoadingMore && (
          <span className="text-xs text-muted-foreground">Loading older messages...</span>
        )}
        {!isLoadingMore && !isScrollable && (
          <button
            type="button"
            className="text-xs rounded border border-border px-3 py-1 text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
            onClick={() => {
              markUserInteraction();
              void loadMore();
            }}
          >
            Load older messages
          </button>
        )}
      </div>
    )}
    {showEmptyState && (
      <div className="w-full flex justify-center items-center h-full">
        <div className="text-center max-w-md">
          {isTrustedOutOfBand ? (
            <>
              <div className="text-muted-foreground text-sm mb-2">
                Created chat with trusted user {activeChat?.username}
              </div>
              <div className="text-muted-foreground text-xs">
                If {activeChat?.username || activeChat.peerId || "the other user"} imported your profile, you can start sending messages. <br />
                If {activeChat?.username || activeChat.peerId || "the other user"} did not import your profile, any messages you send will be lost.
              </div>
            </>
          ) : (
            <div className="text-muted-foreground text-sm">
              {activeChat?.blocked ? (
                <div className="text-muted-foreground text-sm mb-2">
                  You have blocked this user.
                </div>
              ) : (
                <div className="text-muted-foreground text-sm mb-2">
                  No messages yet. Say hi! 👋
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )}
    {isPending && <PendingNotifications senderUsername={messages[0].senderUsername} senderPeerId={messages[0].senderPeerId} />}
    {error && <div className="w-full flex justify-center">
      <div className="text-foreground relative text-center w-1/2 border p-6 rounded-lg border-warning/50 bg-warning/20" style={{ wordBreak: "break-word" }}>
        {error}
      </div>
    </div>}
    {messages.map((message) => {
      const isSystemMessage = message.messageType === 'system';
      if (isSystemMessage) {
        // Break sender grouping across system events.
        previousSenderPeerId = null;
        senderStreak = 0;
      }

      const senderChanged =
        !isSystemMessage && (previousSenderPeerId === null || previousSenderPeerId !== message.senderPeerId);
      if (!isSystemMessage) {
        senderStreak = senderChanged ? 1 : senderStreak + 1;
        previousSenderPeerId = message.senderPeerId;
      }

      const showSenderLabel =
        !isSystemMessage &&
        message.senderPeerId !== myPeerId &&
        !!activeChat?.groupId &&
        (senderChanged || senderStreak % 10 === 0);
      const isSelectable = !isPending && isMessageSelectable(message);
      return (
        <MessageRow
          key={message.id}
          message={message}
          myPeerId={myPeerId}
          hasActivePendingKeyExchange={!!activePendingKeyExchange}
          showSenderLabel={showSenderLabel}
          isFirstInSeries={senderChanged}
          membershipInfoTooltip={getMembershipInfoTooltip(message)}
          onRetry={handleRetryFailedMessage}
          onJumpToMessage={handleJumpToMessage}
          selectionMode={selectionMode}
          isSelectable={isSelectable}
          isSelected={isSelectable && selectedMessageIds?.has(message.id) === true}
          onToggleSelect={onToggleMessageSelection}
          onEnterSelection={onEnterMessageSelection}
        />
      );
    })}
      <div ref={messagesEndRef} />
    </div>
    </div>
    {!isAtBottom && !showEmptyState && (
      <button
        type="button"
        onClick={scrollToBottom}
        className="absolute cursor-pointer left-1/2 -translate-x-1/2 z-30 inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/95 text-muted-foreground shadow-lg backdrop-blur-sm transition-colors hover:border-primary/50 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        style={{ bottom: `${bottomOverlayClearancePx + 16}px` }}
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
      >
        <ChevronDown className="h-5 w-5" />
      </button>
    )}
  </div>
}
