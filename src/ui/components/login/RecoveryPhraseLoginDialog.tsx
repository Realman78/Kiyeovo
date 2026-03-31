import { FileKey, Loader2, Shield } from 'lucide-react';
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog';

type RecoveryPhraseLoginDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recoveryPhraseInput: string;
  setRecoveryPhraseInput: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  isProcessingRecovery: boolean;
};

export function RecoveryPhraseLoginDialog({
  open,
  onOpenChange,
  recoveryPhraseInput,
  setRecoveryPhraseInput,
  onSubmit,
  onCancel,
  isSubmitting,
  isProcessingRecovery,
}: RecoveryPhraseLoginDialogProps) {
  const wordCount = recoveryPhraseInput.trim()
    ? recoveryPhraseInput.trim().split(/\s+/).length
    : 0;

  const wordCountClassName = wordCount === 24
    ? 'text-success'
    : wordCount < 24
      ? 'text-warning'
      : 'text-destructive';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileKey className="w-5 h-5" />
            Unlock with Recovery Phrase
          </DialogTitle>
          <DialogDescription>
            Enter your 24-word recovery phrase to unlock your identity
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">
              Recovery Phrase
            </label>
            <textarea
              className="w-full min-h-[120px] px-3 py-2 text-sm bg-input border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent resize-none font-mono"
              placeholder="Enter your 24-word recovery phrase separated by spaces"
              value={recoveryPhraseInput}
              onChange={(e) => setRecoveryPhraseInput(e.target.value)}
              disabled={isSubmitting || isProcessingRecovery}
              spellCheck="false"
            />
            <div className="text-xs text-muted-foreground">
              {recoveryPhraseInput.trim() ? (
                <span className={wordCountClassName}>
                  {wordCount} / 24 words
                </span>
              ) : (
                <span>0 / 24 words</span>
              )}
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1"
            disabled={isProcessingRecovery}
          >
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={!recoveryPhraseInput.trim() || isSubmitting || isProcessingRecovery || wordCount !== 24}
            className="flex-1"
          >
            {isProcessingRecovery ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                <Shield className="w-4 h-4" />
                Unlock Identity
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
