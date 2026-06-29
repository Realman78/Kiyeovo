import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, FolderOpen, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/use-toast';

interface ImagePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mediaUrl: string;
  fileName: string;
  canOpenFile: boolean;
  onOpenFile: () => Promise<void>;
  canCopyImage?: boolean;
  onCopyImage?: () => Promise<boolean>;
}

export const ImagePreviewDialog: React.FC<ImagePreviewDialogProps> = ({
  open,
  onOpenChange,
  mediaUrl,
  fileName,
  canOpenFile,
  onOpenFile,
  canCopyImage = false,
  onCopyImage,
}) => {
  const { toast } = useToast();
  const [previewFailed, setPreviewFailed] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedResetTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedResetTimeoutRef.current !== null) {
        window.clearTimeout(copiedResetTimeoutRef.current);
      }
    };
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    if (copiedResetTimeoutRef.current !== null) {
      window.clearTimeout(copiedResetTimeoutRef.current);
      copiedResetTimeoutRef.current = null;
    }
    if (nextOpen) {
      setPreviewFailed(false);
    }
    setCopied(false);
    onOpenChange(nextOpen);
  };

  const handleCopyImage = async () => {
    if (!onCopyImage || copying) return;

    setCopying(true);
    try {
      const success = await onCopyImage();
      if (copiedResetTimeoutRef.current !== null) {
        window.clearTimeout(copiedResetTimeoutRef.current);
        copiedResetTimeoutRef.current = null;
      }
      setCopied(success);
      if (success) {
        copiedResetTimeoutRef.current = window.setTimeout(() => {
          setCopied(false);
          copiedResetTimeoutRef.current = null;
        }, 2000);
      } else {
        toast.error('Failed to copy image to clipboard');
      }
    } finally {
      setCopying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[90vh] h-fit max-w-[94vw]! flex-col overflow-hidden bg-black/95! p-0"
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
          {canCopyImage && onCopyImage && (
            <Button
              type="button"
              onClick={() => void handleCopyImage()}
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={copying}
            >
              {copying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              {copied ? 'Copied' : 'Copy image'}
            </Button>
          )}
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
