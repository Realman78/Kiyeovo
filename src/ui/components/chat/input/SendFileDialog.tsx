import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { FileUp, X } from 'lucide-react';
import { useAppSelector } from '../../../state/hooks';

interface SendFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSend: (
    filePath: string,
    fileName: string,
    fileSize: number,
    mediaToken?: string | null,
  ) => Promise<void>;
  transferBlocked?: boolean;
  transferBlockedReason?: string;
}

interface SelectedFile {
  path: string;
  name: string;
  size: number;
  mediaToken: string | null;
}

interface SendFileDialogContentProps {
  onOpenChange: (open: boolean) => void;
  onSend: SendFileDialogProps['onSend'];
  transferBlocked: boolean;
  transferBlockedReason: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
};

const SendFileDialogContent: React.FC<SendFileDialogContentProps> = ({
  onOpenChange,
  onSend,
  transferBlocked,
  transferBlockedReason,
}) => {
  const maxFileSize = useAppSelector((state) => state.appConfig.config.maxFileSize);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const sizeError = selectedFile && selectedFile.size > maxFileSize
    ? `File exceeds size limit (${formatFileSize(maxFileSize)} max)`
    : null;

  const handleBrowse = async () => {
    if (transferBlocked) return;
    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select File',
        filters: [
          { name: 'All Files', extensions: ['*'] }
        ]
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
        setPreviewFailed(false);
      }
    } catch (error) {
      console.error('Error selecting file:', error);
    }
  };

  const handleSend = () => {
    if (transferBlocked || !selectedFile || sizeError) return;

    const filePath = selectedFile.path;
    const fileName = selectedFile.name;
    const fileSize = selectedFile.size;
    const mediaToken = selectedFile.mediaToken;

    onOpenChange(false);
    void onSend(filePath, fileName, fileSize, mediaToken).catch(err => {
      console.error('Error sending file:', err);
    });
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleCloseAnimationComplete = () => {
    setSelectedFile(null);
    setPreviewFailed(false);
  };

  return (
    <DialogContent onCloseAutoFocus={handleCloseAnimationComplete}>
      <DialogHeader>
        <DialogTitle>Send File</DialogTitle>
      </DialogHeader>

      <DialogBody>
        {transferBlocked && (
          <div className="border border-amber-500/30 rounded-lg p-3 bg-amber-500/10 text-amber-300 text-sm mb-3">
            {transferBlockedReason}
          </div>
        )}
        {selectedFile ? (
          <div className="border border-border rounded-lg p-4 bg-muted">
            {selectedFile.mediaToken && !previewFailed && (
              <div className="mb-4 flex max-h-[280px] w-full items-center justify-center overflow-hidden rounded-lg bg-background/30">
                <img
                  src={`kiyeovo-media://media/${encodeURIComponent(selectedFile.mediaToken)}`}
                  alt={`Preview of ${selectedFile.name}`}
                  className="block max-h-[280px] max-w-full object-contain"
                  onError={() => setPreviewFailed(true)}
                />
              </div>
            )}
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground mt-1">{selectedFile.path}</p>
                <p className="text-xs text-muted-foreground mt-1">{formatFileSize(selectedFile.size)}</p>
              </div>
              <button
                onClick={() => {
                  setSelectedFile(null);
                  setPreviewFailed(false);
                }}
                className="ml-2 text-muted-foreground hover:text-destructive cursor-pointer"
                aria-label="Clear selected file"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {sizeError && (
              <p className="text-xs text-destructive mt-2">{sizeError}</p>
            )}
          </div>
        ) : (
          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
            <p className="text-muted-foreground mb-3">No file selected</p>
            <Button onClick={handleBrowse} variant="outline" disabled={transferBlocked}>
              <FileUp className="w-4 h-4 mr-2" />
              Browse Files
            </Button>
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        <Button
          onClick={handleCancel}
          variant="outline"
        >
          Close
        </Button>
        <Button
          onClick={handleSend}
          disabled={transferBlocked || !selectedFile || !!sizeError}
        >
          Send
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};

export const SendFileDialog: React.FC<SendFileDialogProps> = ({
  open,
  onOpenChange,
  onSend,
  transferBlocked = false,
  transferBlockedReason = 'Another file transfer is already active in this chat.',
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <SendFileDialogContent
      onOpenChange={onOpenChange}
      onSend={onSend}
      transferBlocked={transferBlocked}
      transferBlockedReason={transferBlockedReason}
    />
  </Dialog>
);
