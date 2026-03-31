import { memo } from "react";
import { Info, Loader2 } from "lucide-react";
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
  const isSystemMessage = message.messageType === 'system';

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

  return (
    <div
      className={`flex flex-col animate-fade-in ${isOwnMessage ? "items-end" : "items-start"}`}
    >
      {showSenderLabel &&
        <span className="text-xs text-muted-foreground font-mono">{message.senderUsername ?? message.senderPeerId}</span>
      }
      <div
        className={`max-w-[70%] rounded-lg px-4 py-2.5 ${isOwnMessage ? "bg-message-sent text-message-sent-foreground rounded-br-sm" : "bg-message-received text-message-received-foreground rounded-bl-sm"}`}
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
          <p className="text-sm text-left leading-relaxed">{message.content}</p>
        )}
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
