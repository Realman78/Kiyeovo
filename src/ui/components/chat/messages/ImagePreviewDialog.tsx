import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';

interface ImagePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaUrl: string;
  fileName: string;
  canOpenFile: boolean;
  onOpenFile: () => Promise<void>;
}

export const ImagePreviewDialog: React.FC<ImagePreviewDialogProps> = ({
  open,
  onOpenChange,
  mediaUrl,
  fileName,
  canOpenFile,
  onOpenFile,
}) => {
  const [previewFailed, setPreviewFailed] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setPreviewFailed(false);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[90vh] w-[94vw]! max-w-[94vw]! flex-col overflow-hidden bg-black/95! p-0"
      >
        <DialogTitle className="sr-only">Preview {fileName}</DialogTitle>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 pt-12">
          {previewFailed ? (
            <p className="text-sm text-muted-foreground">Image preview unavailable</p>
          ) : (
            <img
              src={mediaUrl}
              alt={fileName}
              className="block max-h-full max-w-full object-contain"
              onError={() => setPreviewFailed(true)}
            />
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border/60 bg-card/90 px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-sm font-medium" title={fileName}>
            {fileName}
          </p>
          {canOpenFile && (
            <Button
              type="button"
              onClick={() => void onOpenFile()}
              variant="outline"
              size="sm"
              className="shrink-0"
            >
              <FolderOpen className="h-4 w-4" />
              Show in folder
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
