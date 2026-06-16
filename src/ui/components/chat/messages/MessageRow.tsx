import { memo, useEffect, useState } from "react";
import { Check, Copy, Info, Loader2 } from "lucide-react";
import { formatTimestampToHourMinute } from "../../../utils/dateUtils";
import { FileMessage } from "./FileMessage";
import type { ChatMessage } from "../../../state/slices/chatSlice";
import { RetryStatus } from "./RetryStatus";

export type MessageRowProps = {
  message: ChatMessage;
  myPeerId: string | null | undefined;
  hasActivePendingKeyExchange: boolean;
  showSenderLabel: boolean;
  showTimestamp: boolean;
  membershipInfoTooltip: string | null;
  onRetry: (message: ChatMessage) => void;
};

export const MessageRow = memo(({
  message,
  myPeerId,
  hasActivePendingKeyExchange,
  showSenderLabel,
  showTimestamp,
  membershipInfoTooltip,
  onRetry,
}: MessageRowProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const isSystemMessage = message.messageType === 'system';

  useEffect(() => {
    if (!isCopied) return;

    const timeoutId = window.setTimeout(() => {
      setIsCopied(false);
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [isCopied]);

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

  return (
    <div
      className={`flex flex-col animate-fade-in ${isOwnMessage ? "items-end" : "items-start"}`}
    >
      {showSenderLabel &&
        <span className="text-xs text-muted-foreground font-mono">{message.senderUsername ?? message.senderPeerId}</span>
      }
      <div className={`group flex w-full items-center gap-2 ${isOwnMessage ? "justify-end" : "justify-start"}`}>
        {copyButton && (
          <div className={isOwnMessage ? "order-1" : "order-2"}>
            {copyButton}
          </div>
        )}
        <div
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
