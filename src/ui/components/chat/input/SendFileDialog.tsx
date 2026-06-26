import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { FileUp, Loader2, Reply, X } from 'lucide-react';
import { useAppSelector } from '../../../state/hooks';

export interface PastedImageFile {
  bytes: Uint8Array;
  mime: string;
  name: string;
  size: number;
}

export interface FileReplyTargetPreview {
  sender: string;
  excerpt: string;
}

interface SendFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosed?: () => void;
  onSend: (
    filePath: string,
    fileName: string,
    fileSize: number,
    mediaToken?: string | null,
  ) => Promise<void>;
  pastedFile?: PastedImageFile | null;
  transferBlocked?: boolean;
  transferBlockedReason?: string;
  onUploadSaved?: (
    savedFilePath: string,
    uploadsDirSizeBytes: number,
  ) => void;
  replyTarget?: FileReplyTargetPreview | null;
}

interface SelectedFile {
  path: string;
  name: string;
  size: number;
  mediaToken: string | null;
}

interface SendFileDialogContentProps {
  closeDialog: () => void;
  onClosed: () => void;
  onSend: SendFileDialogProps['onSend'];
  onPreparingChange: (preparing: boolean) => void;
  onUploadSaved?: SendFileDialogProps['onUploadSaved'];
  pastedFile: PastedImageFile | null;
  preparing: boolean;
  transferBlocked: boolean;
  transferBlockedReason: string;
  replyTarget: FileReplyTargetPreview | null;
}

const formatFileSize = (bytes: number): string => {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
};

const PreviewImage: React.FC<{
  source: string;
  fileName: string;
}> = ({ source, fileName }) => {
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <div className="mb-4 flex max-h-[280px] w-full items-center justify-center overflow-hidden rounded-lg bg-background/30">
      <img
        src={source}
        alt={`Preview of ${fileName}`}
        className="block max-h-[280px] max-w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
};

const PastedImagePreview: React.FC<{
  pastedFile: PastedImageFile;
}> = ({ pastedFile }) => {
  const [objectUrl] = useState(() => {
    const bytes = new Uint8Array(pastedFile.bytes.length);
    bytes.set(pastedFile.bytes);
    return URL.createObjectURL(new Blob([bytes], { type: pastedFile.mime }));
  });

  useEffect(() => {
    return () => URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  return <PreviewImage source={objectUrl} fileName={pastedFile.name} />;
};

const SendFileDialogContent: React.FC<SendFileDialogContentProps> = ({
  closeDialog,
  onClosed,
  onSend,
  onPreparingChange,
  onUploadSaved,
  pastedFile,
  preparing,
  transferBlocked,
  transferBlockedReason,
  replyTarget,
}) => {
  const maxFileSize = useAppSelector((state) => state.appConfig.config.maxFileSize);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const activeFile = pastedFile ?? selectedFile;
  const sizeError = activeFile && activeFile.size > maxFileSize
    ? `File exceeds size limit (${formatFileSize(maxFileSize)} max)`
    : null;

  const handleBrowse = async () => {
    if (transferBlocked || preparing) return;
    setLocalError(null);

    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select File',
        filters: [
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (!result.canceled && result.filePath) {
        let fileSize = 0;
        let fileName = result.filePath.split(/[\\/]/).pop() || 'Unknown';
        try {
          const meta = await window.kiyeovoAPI.getFileMetadata(result.filePath);
          if (meta.success) {
            fileSize = meta.size || 0;
            fileName = meta.name || fileName;
          }
        } catch (metaError) {
          console.error('Error loading file metadata:', metaError);
        }
        setSelectedFile({
          path: result.filePath,
          name: fileName,
          size: fileSize,
          mediaToken: result.mediaToken,
        });
      }
    } catch (error) {
      console.error('Error selecting file:', error);
      setLocalError('Failed to select file');
    }
  };

  const handleSend = async () => {
    if (transferBlocked || preparing || !activeFile || sizeError) return;
    setLocalError(null);

    if (!pastedFile) {
      closeDialog();
      void onSend(
        selectedFile!.path,
        selectedFile!.name,
        selectedFile!.size,
        selectedFile!.mediaToken,
      ).catch((error) => {
        console.error('Error sending file:', error);
      });
      return;
    }

    onPreparingChange(true);
    try {
      const result = await window.kiyeovoAPI.saveUpload(
        pastedFile.bytes,
        pastedFile.name,
      );
      if (!result.success || !result.filePath) {
        setLocalError(result.error || 'Failed to save pasted image');
        return;
      }

      onUploadSaved?.(result.filePath, result.uploadsDirSizeBytes);

      closeDialog();
      void onSend(
        result.filePath,
        pastedFile.name,
        pastedFile.size,
        result.mediaToken,
      ).catch((error) => {
        console.error('Error sending pasted image:', error);
      });
    } catch (error) {
      console.error('Error preparing pasted image:', error);
      setLocalError('Failed to save pasted image');
    } finally {
      onPreparingChange(false);
    }
  };

  const handleCloseAnimationComplete = () => {
    setSelectedFile(null);
    setLocalError(null);
    onPreparingChange(false);
    onClosed();
  };

  return (
    <DialogContent onCloseAutoFocus={handleCloseAnimationComplete}>
      <DialogHeader>
        <DialogTitle>{pastedFile ? 'Send Pasted Image' : 'Send File'}</DialogTitle>
      </DialogHeader>

      <DialogBody>
        {replyTarget && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm">
            <Reply className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground/80">
                Replying to {replyTarget.sender}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {replyTarget.excerpt}
              </p>
            </div>
          </div>
        )}

        {transferBlocked && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
            {transferBlockedReason}
          </div>
        )}
        {activeFile ? (
          <div className="rounded-lg border border-border bg-muted p-4">
            {pastedFile ? (
              <PastedImagePreview
                key={`${pastedFile.name}:${pastedFile.size}:${pastedFile.mime}`}
                pastedFile={pastedFile}
              />
            ) : selectedFile?.mediaToken ? (
              <PreviewImage
                key={selectedFile.mediaToken}
                source={`kiyeovo-media://media/${encodeURIComponent(selectedFile.mediaToken)}`}
                fileName={selectedFile.name}
              />
            ) : null}
            <div className="flex items-start justify-between">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{activeFile.name}</p>
                {!pastedFile && selectedFile && (
                  <p className="mt-1 text-xs text-muted-foreground">{selectedFile.path}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">{formatFileSize(activeFile.size)}</p>
              </div>
              {!pastedFile && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFile(null);
                    setLocalError(null);
                  }}
                  className="ml-2 cursor-pointer text-muted-foreground hover:text-destructive"
                  aria-label="Clear selected file"
                  disabled={preparing}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            {(sizeError || localError) && (
              <p className="mt-2 text-xs text-destructive">{sizeError || localError}</p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border-2 border-dashed border-border p-8 text-center">
            <p className="mb-3 text-muted-foreground">No file selected</p>
            <Button
              onClick={() => void handleBrowse()}
              variant="outline"
              disabled={transferBlocked || preparing}
            >
              <FileUp className="mr-2 h-4 w-4" />
              Browse Files
            </Button>
            {localError && (
              <p className="mt-3 text-xs text-destructive">{localError}</p>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button
          onClick={closeDialog}
          variant="outline"
          disabled={preparing}
        >
          Close
        </Button>
        <Button
          onClick={() => void handleSend()}
          disabled={transferBlocked || preparing || !activeFile || !!sizeError}
        >
          {preparing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing...
            </>
          ) : (
            'Send'
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};

export const SendFileDialog: React.FC<SendFileDialogProps> = ({
  open,
  onOpenChange,
  onClosed,
  onSend,
  pastedFile = null,
  transferBlocked = false,
  transferBlockedReason = 'Another file transfer is already active in this chat.',
  onUploadSaved,
  replyTarget = null,
}) => {
  const [preparing, setPreparing] = useState(false);

  const handleRootOpenChange = (nextOpen: boolean) => {
    if (!preparing) {
      onOpenChange(nextOpen);
    }
  };

  const handleClosed = () => {
    onClosed?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleRootOpenChange}>
      <SendFileDialogContent
        closeDialog={() => onOpenChange(false)}
        onClosed={handleClosed}
        onSend={onSend}
        onPreparingChange={setPreparing}
        onUploadSaved={onUploadSaved}
        pastedFile={pastedFile}
        preparing={preparing}
        transferBlocked={transferBlocked}
        transferBlockedReason={transferBlockedReason}
        replyTarget={replyTarget}
      />
    </Dialog>
  );
};
