import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatHeader } from "./header/ChatHeader";
import { useSelector } from "react-redux";
import type { RootState } from "../../state/store";
import { MessagesContainer } from "./messages/MessagesContainer";
import { createPendingMessage } from "../../utils/general";
import { ChatInput } from "./input/ChatInput";
import { InvitationManager } from "./input/InvitationManager";
import { EmptyState } from "./messages/EmptyState";
import { PendingKxManager } from "./input/PendingKxManager";
import { getGroupCreatorLinkState, type GroupCreatorLinkState } from "../../utils/groupCreatorLinkHealth";
import { OfflineInboxCapacity } from "./OfflineInboxCapacity";
import { MessageSelectionBar } from "./MessageSelectionBar";

const OFFLINE_INBOX_COLLAPSED_CLEARANCE_PX = 44;
const OFFLINE_INBOX_EXPANDED_CLEARANCE_PX = 120;

type MessageSelectionState = {
  chatId: number;
  messageIds: Set<string>;
};

const ChatWrapper = () => {
  const activeChat = useSelector((state: RootState) => state.chat.activeChat);
  const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const messages = useSelector((state: RootState) => state.chat.messages);
  const sendingMessages = useSelector((state: RootState) => state.chat.sendingMessages);
  const chats = useSelector((state: RootState) => state.chat.chats);
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const [offlineInboxExpandedByChatId, setOfflineInboxExpandedByChatId] = useState<Record<number, boolean>>({});
  const [messageSelection, setMessageSelection] = useState<MessageSelectionState | null>(null);
  const activeMessageSelection =
    messageSelection && messageSelection.chatId === activeChat?.id
      ? messageSelection
      : null;
  const selectionMode = activeMessageSelection !== null;
  const selectedMessageCount = activeMessageSelection?.messageIds.size ?? 0;

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

  const toggleOfflineInbox = useCallback(() => {
    if (!activeChat) return;
    setOfflineInboxExpandedByChatId((prev) => ({
      ...prev,
      [activeChat.id]: !prev[activeChat.id],
    }));
  }, [activeChat]);

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

  const enterSelectionMode = useCallback(() => {
    if (!activeChat) return;
    setMessageSelection({
      chatId: activeChat.id,
      messageIds: new Set(),
    });
  }, [activeChat]);

  const exitSelectionMode = useCallback(() => {
    setMessageSelection(null);
  }, []);

  useEffect(() => {
    if (!selectionMode) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      exitSelectionMode();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [exitSelectionMode, selectionMode]);

  useEffect(() => {
    if (!messageSelection || messageSelection.chatId === activeChat?.id) return;

    const staleSelection = messageSelection;
    // The derived mode turns off immediately; clear the stale owner after this
    // render so returning to the chat cannot revive an old selection.
    queueMicrotask(() => {
      setMessageSelection((current) => current === staleSelection ? null : current);
    });
  }, [activeChat?.id, messageSelection]);

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
          />
          {selectionMode && (
            <MessageSelectionBar
              selectedCount={selectedMessageCount}
              onClose={exitSelectionMode}
            />
          )}
        </>
      );
    }
    return null;
  }, [
    activePendingKeyExchange,
    activeContactAttempt,
    activeChat,
    exitSelectionMode,
    openOfflineInbox,
    selectedMessageCount,
    selectionMode,
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
            onSelectMessages={activeChat ? enterSelectionMode : undefined}
          />
          {groupCreatorLinkState.broken && (
            <div className="mx-6 mb-2 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              You do not have a direct chat with {creatorLabel || 'the group creator'}, so you cannot receive future group updates.
              Existing messages may still work until the next group update.
              To fix this: make sure {groupCreatorLinkState.creatorName || 'the creator'} also deletes you, then establish a new conversation.
            </div>
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <MessagesContainer
              messages={messagesToDisplay}
              isPending={!!activeContactAttempt || !!activePendingKeyExchange}
              onOfflineInboxRelevant={openOfflineInbox}
              bottomOverlayClearancePx={activeChat
                ? (isOfflineInboxExpanded
                  ? OFFLINE_INBOX_EXPANDED_CLEARANCE_PX
                  : OFFLINE_INBOX_COLLAPSED_CLEARANCE_PX)
                : 0}
            />
            <div className="relative">
              {activeChat && (
                <div className="pointer-events-none absolute bottom-full left-0 z-30">
                  <div className="pointer-events-auto">
                    <OfflineInboxCapacity
                      chatId={activeChat.id}
                      expanded={isOfflineInboxExpanded}
                      onToggle={toggleOfflineInbox}
                    />
                  </div>
                </div>
              )}
              {FooterToDisplay}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ChatWrapper;
