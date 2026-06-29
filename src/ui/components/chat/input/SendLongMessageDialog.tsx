import React, { useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Reply } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { useAppSelector } from '../../../state/hooks';
import { MAX_MESSAGE_CONTENT_LENGTH } from '../../../constants';

export interface PendingLongMessage {
  chatId: number;
  peerId: string;
  recipientName: string;
  rawDraft: string;
  trimmedText: string;
  draftRevision: number;
  defaultFileName: string;
  replyTarget?: {
    cid: string;
    sender: string;
    excerpt: string;
  };
}

interface PreparedLongMessageFile {
  filePath: string;
  fileName: string;
  fileSize: number;
  uploadsDirSizeBytes: number;
}

interface SendLongMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: () => void;
  onPrepared: (
    file: PreparedLongMessageFile,
    source: PendingLongMessage,
  ) => Promise<void>;
  onUploadSaved: (
    savedFilePath: string,
    uploadsDirSizeBytes: number,
  ) => void;
  pendingMessage: PendingLongMessage | null;
  transferBlocked?: boolean;
  transferBlockedReason?: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, unitIndex);
  return `${Math.round(value * 100) / 100} ${units[unitIndex]}`;
};

interface SendLongMessageDialogContentProps {
  closeDialog: () => void;
  onClosed: () => void;
  onPrepared: SendLongMessageDialogProps['onPrepared'];
  onPreparingChange: (preparing: boolean) => void;
  onUploadSaved: SendLongMessageDialogProps['onUploadSaved'];
  pendingMessage: PendingLongMessage | null;
  preparing: boolean;
  transferBlocked: boolean;
  transferBlockedReason: string;
}

const SendLongMessageDialogContent: React.FC<SendLongMessageDialogContentProps> = ({
  closeDialog,
  onClosed,
  onPrepared,
  onPreparingChange,
  onUploadSaved,
  pendingMessage,
  preparing,
  transferBlocked,
  transferBlockedReason,
}) => {
  const maxFileSize = useAppSelector((state) => state.appConfig.config.maxFileSize);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setFileName(pendingMessage?.defaultFileName ?? '');
    setLocalError(null);

    if (!pendingMessage) return;
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frameId);
  }, [pendingMessage]);

  const textByteSize = pendingMessage
    ? new TextEncoder().encode(pendingMessage.trimmedText).byteLength
    : 0;
  const trimmedFileName = fileName.trim();
  const fileNameError = trimmedFileName && !trimmedFileName.toLowerCase().endsWith('.txt')
    ? 'Filename must end in .txt'
    : null;
  const sizeError = textByteSize > maxFileSize
    ? `Text exceeds the file-size limit (${formatFileSize(maxFileSize)} max)`
    : null;

  const handleSend = async () => {
    if (
      !pendingMessage
      || preparing
      || transferBlocked
      || !trimmedFileName
      || fileNameError
      || sizeError
    ) {
      return;
    }

    setLocalError(null);
    onPreparingChange(true);
    try {
      const result = await window.kiyeovoAPI.saveTextUpload(
        pendingMessage.trimmedText,
        trimmedFileName,
      );
      if (
        !result.success
        || !result.filePath
        || !result.fileName
        || result.fileSize <= 0
      ) {
        setLocalError(result.error || 'Failed to save text file');
        return;
      }

      onUploadSaved(result.filePath, result.uploadsDirSizeBytes);
      closeDialog();
      void onPrepared({
        filePath: result.filePath,
        fileName: result.fileName,
        fileSize: result.fileSize,
        uploadsDirSizeBytes: result.uploadsDirSizeBytes,
      }, pendingMessage).catch((error) => {
        console.error('Error sending generated text file:', error);
      });
    } catch (error) {
      console.error('Error preparing generated text file:', error);
      setLocalError('Failed to save text file');
    } finally {
      onPreparingChange(false);
    }
  };

  const handleCloseAnimationComplete = () => {
    setFileName('');
    setLocalError(null);
    onPreparingChange(false);
    onClosed();
  };

  return (
    <DialogContent
      className="max-w-lg"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
      onCloseAutoFocus={handleCloseAnimationComplete}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Send as text file?
        </DialogTitle>
        <DialogDescription>
          Your message is too long. Character limit is {MAX_MESSAGE_CONTENT_LENGTH.toLocaleString()}.
          {' '}Send it as a .txt file instead?
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="space-y-4">
        {pendingMessage?.replyTarget && (
          <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
            <Reply className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground/80">
                Replying to {pendingMessage.replyTarget.sender}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {pendingMessage.replyTarget.excerpt}
              </p>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground/80">
          {pendingMessage?.recipientName || 'The recipient'} can receive this offer later. The download starts when both of you are online.
        </div>

        {transferBlocked && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
            {transferBlockedReason}
          </div>
        )}

        <div className="rounded-lg border border-border bg-muted p-4">
          <p className="text-sm font-medium">
            {pendingMessage?.trimmedText.length.toLocaleString() ?? '0'} characters
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatFileSize(textByteSize)} as UTF-8 text
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="long-message-file-name" className="text-sm text-muted-foreground">
            Filename
          </label>
          <Input
            id="long-message-file-name"
            ref={inputRef}
            type="text"
            value={fileName}
            maxLength={255}
            disabled={preparing}
            aria-invalid={!!(fileNameError || localError)}
            onChange={(event) => {
              setFileName(event.target.value);
              setLocalError(null);
            }}
          />
          {(fileNameError || sizeError || localError) && (
            <p className="text-xs text-destructive">
              {fileNameError || sizeError || localError}
            </p>
          )}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={closeDialog}
          disabled={preparing}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void handleSend()}
          disabled={
            preparing
            || transferBlocked
            || !pendingMessage
            || !trimmedFileName
            || !!fileNameError
            || !!sizeError
          }
        >
          {preparing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing...
            </>
          ) : (
            'Send file'
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};

export const SendLongMessageDialog: React.FC<SendLongMessageDialogProps> = ({
  open,
  onOpenChange,
  onClosed,
  onPrepared,
  onUploadSaved,
  pendingMessage,
  transferBlocked = false,
  transferBlockedReason = 'Another file transfer is already active in this chat.',
}) => {
  const [preparing, setPreparing] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!preparing) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <SendLongMessageDialogContent
        closeDialog={() => onOpenChange(false)}
        onClosed={() => onClosed?.()}
        onPrepared={onPrepared}
        onPreparingChange={setPreparing}
        onUploadSaved={onUploadSaved}
        pendingMessage={pendingMessage}
        preparing={preparing}
        transferBlocked={transferBlocked}
        transferBlockedReason={transferBlockedReason}
      />
    </Dialog>
  );
};
