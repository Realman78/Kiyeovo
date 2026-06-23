import { memo, useEffect, useState } from "react";
import { Check, Copy, Info, Loader2, Reply } from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { FileMessage } from "./FileMessage";
import { setReplyTarget, type ChatMessage } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { RetryStatus } from "./RetryStatus";

export type MessageRowProps = {
  message: ChatMessage;
  myPeerId: string | null | undefined;
  hasActivePendingKeyExchange: boolean;
  showSenderLabel: boolean;
  showTimestamp: boolean;
  membershipInfoTooltip: string | null;
  onRetry: (message: ChatMessage) => void;
  onJumpToMessage?: (clientMsgId: string) => void;
  canReply?: boolean;
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
  showTimestamp,
  membershipInfoTooltip,
  onRetry,
  onJumpToMessage,
  canReply = true,
}: MessageRowProps) => {
  const dispatch = useDispatch();
  const [isCopied, setIsCopied] = useState(false);
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
          {formatTimestampToHourMinute(message.timestamp)}
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
    } catch (error) {
      console.error("Failed to copy message:", error);
    }
  };

  const copyButton = isCopyableTextMessage ? (
    <button
      type="button"
      onClick={() => void handleCopyMessage()}
      className={`inline-flex cursor-pointer shrink-0 self-center items-center justify-center rounded-full p-1 transition-opacity hover:bg-background/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${isCopied ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}
      aria-label={isCopied ? "Message copied" : "Copy message"}
      title={isCopied ? "Copied" : "Copy message"}
    >
      {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  ) : null;

  const isFileLike = message.messageType === 'file' || message.messageType === 'image';
  const fileReplyAllowed = !isFileLike || message.transferStatus === 'completed';
  const isReplyable = canReply && !!message.clientMsgId && !message.localSendState && fileReplyAllowed;
  const replyButton = isReplyable ? (
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

  return (
    <div
      data-cid={message.clientMsgId}
      className={`flex flex-col animate-fade-in ${isOwnMessage ? "items-end" : "items-start"}`}
    >
      {showSenderLabel &&
        <span className="text-xs text-muted-foreground font-mono">{message.senderUsername ?? message.senderPeerId}</span>
      }
      {replyQuote && (
        <button
          type="button"
          disabled={replyQuote === 'deleted'}
          onClick={() => { if (replyQuote !== 'deleted' && replyToCid) onJumpToMessage?.(replyToCid); }}
          className={`mb-1 flex max-w-[70%] flex-col rounded-md border-l-2 px-2 py-1 text-left text-xs ${isOwnMessage ? "self-end" : "self-start"} ${replyQuote === 'deleted'
            ? "border-muted text-muted-foreground italic cursor-default"
            : "border-primary/60 bg-muted/40 text-muted-foreground hover:bg-muted/70 cursor-pointer"}`}
        >
          {replyQuote === 'deleted' ? (
            <span>Message deleted.</span>
          ) : (
            <>
              <span className="font-medium text-foreground/80">{replyQuote.sender}</span>
              <span className="truncate">{replyQuote.text}</span>
            </>
          )}
        </button>
      )}
      <div className={`group flex w-full items-center gap-2 ${isOwnMessage ? "justify-end" : "justify-start"}`}>
        {(replyButton || copyButton) && (
          <div className={`flex items-center gap-1 ${isOwnMessage ? "order-1" : "order-2"}`}>
            {replyButton}
            {copyButton}
          </div>
        )}
        <div
          data-message-bubble
          className={`max-w-[70%] rounded-lg px-4 py-2.5 ${isOwnMessage ? "order-2 bg-message-sent text-message-sent-foreground rounded-br-sm" : "order-1 bg-message-received text-message-received-foreground rounded-bl-sm"}`}
          style={{ wordBreak: "break-word" }}
        >
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
            <p className="text-left text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">{message.content}</p>
          )}
        </div>
      </div>
      {showTimestamp && (
        <span className="text-xs text-muted-foreground mt-1 font-mono inline-flex items-center gap-1">
          {formatTimestampToHourMinute(message.timestamp)}
          {message.localSendState === 'sending' && (
            <>
              <span>•</span>
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Sending...</span>
            </>
          )}
          {message.localSendState === 'queued' && " • Queued for sending"}
          {!message.localSendState && message.messageSentStatus === 'offline' && " • offline"}
          <RetryStatus message={message} onRetry={onRetry} />
        </span>
      )}
    </div>
  );
});
