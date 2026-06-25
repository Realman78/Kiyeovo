import type { FC, ReactNode } from "react";
import type { ChatMessage } from "../../../state/slices/chatSlice";
import { formatFullDateTime } from "../../../utils/dateUtils";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";

type ReplyQuote = { sender: string; text: string } | "deleted" | null;

type MessageInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: ChatMessage;
  isOwnMessage: boolean;
  replyQuote: ReplyQuote;
};

const TYPE_LABELS: Record<ChatMessage["messageType"], string> = {
  text: "Text",
  file: "File",
  image: "Image",
  system: "System",
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
};

const deriveStatus = (message: ChatMessage): string | null => {
  switch (message.localSendState) {
    case "sending":
      return "Sending";
    case "queued":
      return "Queued";
    case "failed":
      return "Failed";
  }
  if (message.messageSentStatus === "offline") return "Delivered while offline";
  if (message.messageSentStatus === "online") return "Delivered while online";
  return null;
};

const InfoRow: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex items-start justify-between gap-4 py-2 border-b border-border/40 last:border-b-0">
    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground shrink-0">
      {label}
    </span>
    <span className="text-sm text-foreground text-right min-w-0 wrap-break-word">{children}</span>
  </div>
);

export const MessageInfoDialog: FC<MessageInfoDialogProps> = ({
  open,
  onOpenChange,
  message,
  isOwnMessage,
  replyQuote,
}) => {
  const status = deriveStatus(message);
  const isFileLike = message.messageType === "file" || message.messageType === "image";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Message info</DialogTitle>
        </DialogHeader>
        <DialogBody className="pt-2">
          <div className="flex flex-col">
            <InfoRow label="Type">{TYPE_LABELS[message.messageType]}</InfoRow>
            <InfoRow label="From">{isOwnMessage ? "You" : message.senderUsername}</InfoRow>
            <InfoRow label="Sent">{formatFullDateTime(message.timestamp)}</InfoRow>
            {status && <InfoRow label="Status">{status}</InfoRow>}
            {replyQuote && (
              <InfoRow label="Replying to">
                {replyQuote === "deleted" ? (
                  <span className="italic text-muted-foreground">Original message unavailable</span>
                ) : (
                  <span>
                    <span className="font-medium">{replyQuote.sender}</span>
                    {": "}
                    {replyQuote.text}
                  </span>
                )}
              </InfoRow>
            )}
            {isFileLike && message.fileName && (
              <InfoRow label="File name">{message.fileName}</InfoRow>
            )}
            {isFileLike && message.fileSize !== undefined && (
              <InfoRow label="Size">{formatFileSize(message.fileSize)}</InfoRow>
            )}
            {isFileLike && message.transferStatus && (
              <InfoRow label="Transfer">{message.transferStatus}</InfoRow>
            )}
            {message.pinnedAt !== undefined && (
              <InfoRow label="Pinned">{formatFullDateTime(message.pinnedAt)}</InfoRow>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
