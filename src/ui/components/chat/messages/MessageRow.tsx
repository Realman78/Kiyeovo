import { memo, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Info, ListChecks, Loader2, Reply } from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinuteEu } from "../../../utils/dateUtils";
import { FileMessage } from "./FileMessage";
import { setReplyTarget, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { RetryStatus } from "./RetryStatus";
import { DropdownMenu, DropdownMenuItem } from "../../ui/DropdownMenu";

export type MessageRowProps = {
  message: ChatMessage;
  myPeerId: string | null | undefined;
  hasActivePendingKeyExchange: boolean;
  showSenderLabel: boolean;
  isFirstInSeries?: boolean;
  membershipInfoTooltip: string | null;
  onRetry: (message: ChatMessage) => void;
  onJumpToMessage?: (clientMsgId: string) => void;
  canReply?: boolean;
  selectionMode?: boolean;
  isSelectable?: boolean;
  isSelected?: boolean;
  isActiveSearchResult?: boolean;
  onToggleSelect?: (messageId: string) => void;
  onEnterSelection?: (messageId: string) => void;
};

// Short text shown for a message inside a reply quote / compose bar.
function quoteExcerpt(m: { messageType: string; content: string; fileName?: string }): string {
  if (m.messageType === 'file' || m.messageType === 'image') {
    return m.fileName || (m.messageType === 'image' ? 'Photo' : 'File');
  }
  return m.content;
}

type FetchedQuote = {
  senderPeerId: string;
  senderUsername?: string;
  messageType: string;
  content: string;
  fileName?: string;
};

export const MessageRow = memo(({
  message,
  myPeerId,
  hasActivePendingKeyExchange,
  showSenderLabel,
  isFirstInSeries = false,
  membershipInfoTooltip,
  onRetry,
  onJumpToMessage,
  canReply = true,
  selectionMode = false,
  isSelectable = false,
  isSelected = false,
  isActiveSearchResult = false,
  onToggleSelect,
  onEnterSelection,
}: MessageRowProps) => {
  const dispatch = useDispatch();
  const [isCopied, setIsCopied] = useState(false);
  const [messageMenuOpen, setMessageMenuOpen] = useState(false);
  const [messageMenuSide, setMessageMenuSide] = useState<'top' | 'bottom'>('bottom');
  const rowRef = useRef<HTMLDivElement>(null);
  const isSystemMessage = message.messageType === 'system';

  useEffect(() => {
    if (!isCopied) return;

    const timeoutId = window.setTimeout(() => {
      setIsCopied(false);
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [isCopied]);

  const replyToCid = message.replyToClientId;
  const loadedOriginal = useSelector((s: RootState) =>
    replyToCid
      ? s.chat.messages.find((m) => m.chatId === message.chatId && m.clientMsgId === replyToCid)
      : undefined,
  );
  const quoteKey = replyToCid ? `${message.chatId}:${replyToCid}` : null;
  const [fetchedQuoteState, setFetchedQuoteState] = useState<{
    key: string;
    value: FetchedQuote | 'deleted';
  } | null>(null);
  const fetchedQuote = quoteKey && fetchedQuoteState?.key === quoteKey
    ? fetchedQuoteState.value
    : null;

  useEffect(() => {
    if (!replyToCid || loadedOriginal) {
      return;
    }
    const requestKey = `${message.chatId}:${replyToCid}`;
    let cancelled = false;
    window.kiyeovoAPI
      .getMessagePreviewByCid(message.chatId, replyToCid)
      .then((res) => {
        if (cancelled) return;
        const value: FetchedQuote | 'deleted' = res.success && res.preview
          ? {
              ...res.preview,
              senderUsername: res.preview.senderUsername ?? undefined,
              fileName: res.preview.fileName ?? undefined,
            }
          : 'deleted';
        setFetchedQuoteState({ key: requestKey, value });
      })
      .catch(() => {
        if (!cancelled) {
          setFetchedQuoteState({ key: requestKey, value: 'deleted' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [replyToCid, loadedOriginal, message.chatId]);

  if (isSystemMessage) {
    return (
      <div className="w-full flex flex-col items-center animate-fade-in">
        <div
          className="max-w-[80%] rounded-md px-3 py-1.5 bg-muted/50 text-muted-foreground text-xs text-center"
          style={{ wordBreak: "break-word" }}
        >
          {message.content}
        </div>
        <span className="text-xs text-muted-foreground mt-1 font-mono inline-flex items-center gap-1">
          {formatTimestampToHourMinuteEu(message.timestamp)}
          {membershipInfoTooltip && (
            <span className="relative inline-flex items-center group">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-full p-0.5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={membershipInfoTooltip}
              >
                <Info className="w-3 h-3" />
              </button>
              <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-72 -translate-x-1/2 rounded-md border bg-popover px-2 py-1.5 text-left text-[11px] text-popover-foreground shadow-md group-hover:block group-focus-within:block">
                {membershipInfoTooltip}
              </span>
            </span>
          )}
        </span>
      </div>
    );
  }

  const isOwnMessage = message.senderPeerId === myPeerId || hasActivePendingKeyExchange;
  const isCopyableTextMessage = message.messageType === 'text' && message.content.length > 0;

  const senderName = (peerId: string, username?: string) =>
    peerId === myPeerId ? 'You' : (username || `user_${peerId.slice(-8)}`);

  // The quote to render above this bubble (when this message is itself a reply).
  let replyQuote: { sender: string; text: string } | 'deleted' | null = null;
  if (replyToCid) {
    if (loadedOriginal) {
      replyQuote = { sender: senderName(loadedOriginal.senderPeerId, loadedOriginal.senderUsername), text: quoteExcerpt(loadedOriginal) };
    } else if (fetchedQuote === 'deleted') {
      replyQuote = 'deleted';
    } else if (fetchedQuote) {
      replyQuote = { sender: senderName(fetchedQuote.senderPeerId, fetchedQuote.senderUsername), text: quoteExcerpt(fetchedQuote) };
    }
  }

  const handleReply = () => {
    if (!message.clientMsgId) return;
    dispatch(setReplyTarget({
      chatId: message.chatId,
      target: {
        cid: message.clientMsgId,
        sender: senderName(message.senderPeerId, message.senderUsername),
        excerpt: quoteExcerpt(message),
      },
    }));
  };

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setIsCopied(true);
      setMessageMenuOpen(false);
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  };

  const isFileLike = message.messageType === 'file' || message.messageType === 'image';
  const fileReplyAllowed = !isFileLike || message.transferStatus === 'completed';
  const isReplyable = canReply && !!message.clientMsgId && !message.localSendState && fileReplyAllowed;
  const replyButton = !selectionMode && isReplyable ? (
    <button
      type="button"
      onClick={handleReply}
      className="inline-flex cursor-pointer shrink-0 self-center items-center justify-center rounded-full p-1 transition-opacity hover:bg-background/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      aria-label="Reply to message"
      title="Reply"
    >
      <Reply className="w-3 h-3" />
    </button>
  ) : null;

  const handleEnterSelection = () => {
    if (!isSelectable) return;
    setMessageMenuOpen(false);
    onEnterSelection?.(message.id);
  };

  const handleMessageMenuOpenChange = (open: boolean) => {
    if (open) {
      const rowRect = rowRef.current?.getBoundingClientRect();
      if (rowRect) {
        const rowCenter = rowRect.top + (rowRect.height / 2);
        setMessageMenuSide(rowCenter > window.innerHeight / 2 ? 'top' : 'bottom');
      }
    }
    setMessageMenuOpen(open);
  };

  const hasMessageMenu = isCopyableTextMessage || isSelectable;
  const messageMenu = !selectionMode && hasMessageMenu ? (
    <div className={`absolute right-1 top-1 z-70 transition-[opacity,transform] duration-200 ease-out ${
      messageMenuOpen
        ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
        : "pointer-events-none -translate-y-1 scale-90 opacity-0 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:translate-y-0 group-focus-within:scale-100 group-focus-within:opacity-100"
    }`}>
      <DropdownMenu
        open={messageMenuOpen}
        onOpenChange={handleMessageMenuOpenChange}
        align={isOwnMessage ? "end" : "start"}
        side={messageMenuSide}
        minWidthClass="min-w-36"
        portal
        trigger={(
          <button
            type="button"
            className="inline-flex cursor-pointer items-center justify-center rounded-full bg-background/30 p-1 text-current shadow-sm backdrop-blur-[1px] transition-colors hover:bg-background/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Open message actions"
            title="Message actions"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        )}
      >
        {isCopyableTextMessage && (
          <DropdownMenuItem
            icon={isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            onClick={() => void handleCopyMessage()}
          >
            {isCopied ? 'Copied' : 'Copy'}
          </DropdownMenuItem>
        )}
        {isSelectable && (
          <DropdownMenuItem
            icon={<ListChecks className="h-4 w-4" />}
            onClick={handleEnterSelection}
          >
            Select
          </DropdownMenuItem>
        )}
      </DropdownMenu>
    </div>
  ) : null;

  const toggleSelection = () => {
    if (!selectionMode || !isSelectable) return;
    onToggleSelect?.(message.id);
  };

  const handleSelectionKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selectionMode || !isSelectable) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleSelection();
  };

  const handleSelectionClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!selectionMode) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSelection();
  };

  return (
    <div
      ref={rowRef}
      data-cid={message.clientMsgId}
      role={selectionMode && isSelectable ? "checkbox" : undefined}
      aria-checked={selectionMode && isSelectable ? isSelected : undefined}
      aria-disabled={selectionMode && !isSelectable ? true : undefined}
      tabIndex={selectionMode && isSelectable ? 0 : undefined}
      onClickCapture={handleSelectionClickCapture}
      onKeyDown={handleSelectionKeyDown}
      className={`relative -mx-2 flex flex-col rounded-lg px-2 animate-fade-in transition-colors ${isOwnMessage ? "items-end" : "items-start"} ${
        selectionMode && isSelectable ? "cursor-pointer py-px hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60" : ""
      } ${isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : ""}`}
    >
      {isSelected && (
        <span
          className={`pointer-events-none absolute top-1/2 z-10 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow ${
            isOwnMessage ? "left-2" : "right-2"
          }`}
          aria-hidden="true"
        >
          <Check className="h-3 w-3" />
        </span>
      )}
      <div
        className={`contents ${selectionMode ? "pointer-events-none select-none" : ""}`}
        inert={selectionMode ? true : undefined}
      >
        {showSenderLabel &&
          <span className="text-xs text-muted-foreground font-mono">{message.senderUsername ?? message.senderPeerId}</span>
        }
        <div className={`group flex w-full items-center gap-2 ${isOwnMessage ? "justify-end" : "justify-start"}`}>
          {replyButton && (
            <div className={`flex items-center gap-1 ${isOwnMessage ? "order-1" : "order-2"}`}>
              {replyButton}
            </div>
          )}
          <div
            data-message-bubble
            className={`relative max-w-[70%] rounded-lg ${
              replyQuote ? "px-1 pt-1" : "pl-[9px] pr-[7px] pt-1.5"
            } ${
              message.messageType === 'file' ? "pb-5" : "pb-2.5"
            } ${isOwnMessage
              ? `order-2 bg-message-sent text-message-sent-foreground${isFirstInSeries ? " rounded-tr-none" : ""}`
              : `order-1 bg-message-received text-message-received-foreground${isFirstInSeries ? " rounded-tl-none" : ""}`} ${
              isActiveSearchResult ? "search-result-active-highlight" : ""
            }`}
            style={{ wordBreak: "break-word" }}
          >
            {isFirstInSeries && (
              <span
                aria-hidden="true"
                className={`absolute top-0 h-2 w-2 ${
                  isOwnMessage
                    ? "right-0 translate-x-full bg-message-sent [clip-path:polygon(0_0,0_100%,100%_0)]"
                    : "left-0 -translate-x-full bg-message-received [clip-path:polygon(100%_0,100%_100%,0_0)]"
                }`}
              />
            )}
            {messageMenu}
            {replyQuote && (
              <button
                type="button"
                disabled={replyQuote === 'deleted'}
                onClick={() => { if (replyQuote !== 'deleted' && replyToCid) onJumpToMessage?.(replyToCid); }}
                className={`mb-1 flex w-full min-w-0 flex-col rounded-md border-l-2 px-2 py-1 text-left text-xs ${replyQuote === 'deleted'
                  ? "border-muted text-muted-foreground italic cursor-default"
                  : "border-primary/60 bg-muted/40 text-muted-foreground hover:bg-muted/70 cursor-pointer"}`}
              >
                {replyQuote === 'deleted' ? (
                  <span>Original message unavailable.</span>
                ) : (
                  <>
                    <span className="font-medium text-foreground/80">{replyQuote.sender}</span>
                    <span className="truncate">{replyQuote.text}</span>
                  </>
                )}
              </button>
            )}
            <div className={replyQuote ? "pl-[5px] pr-[3px]" : undefined}>
              {message.messageType === 'file' && message.fileName ? (
                <FileMessage
                  fileId={message.id}
                  chatId={message.chatId}
                  fileName={message.fileName}
                  fileSize={message.fileSize || 0}
                  filePath={message.filePath}
                  transferStatus={message.transferStatus || 'pending'}
                  transferProgress={message.transferProgress}
                  transferError={message.transferError}
                  transferExpiresAt={message.transferExpiresAt}
                  isFromCurrentUser={message.senderPeerId === myPeerId}
                />
              ) : (
                <p className="text-left text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
                  {message.content}
                  <span className="inline-block w-10" aria-hidden="true" />
                </p>
              )}
            </div>
            <span className="pointer-events-none absolute bottom-0.5 right-2 font-mono text-[10px] leading-none opacity-60">
              {formatTimestampToHourMinuteEu(message.timestamp)}
            </span>
          </div>
        </div>
        {(message.localSendState || message.messageSentStatus === 'offline') && (
          <span className="text-xs text-muted-foreground mt-1 font-mono inline-flex items-center gap-1">
            {message.localSendState === 'sending' && (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Sending...</span>
              </>
            )}
            {message.localSendState === 'queued' && "Queued for sending"}
            {!message.localSendState && message.messageSentStatus === 'offline' && "offline"}
            <RetryStatus message={message} onRetry={onRetry} />
          </span>
        )}
      </div>
    </div>
  );
});
