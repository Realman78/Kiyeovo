import { FileKey, CheckCircle } from 'lucide-react';
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../ui/Dialog';
import { formatRecoveryPhrase } from '../../utils/general';

interface RecoveryPhraseDisplayDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recoveryPhrase?: string;
  onConfirm: () => void;
}

export function RecoveryPhraseDisplayDialog({
  open,
  onOpenChange,
  recoveryPhrase,
  onConfirm
}: RecoveryPhraseDisplayDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileKey className="w-5 h-5" />
            RECOVERY PHRASE - WRITE THIS DOWN NOW
          </DialogTitle>
          <DialogDescription>
            This phrase can recover your identity if you forget your password. Store it safely!
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {recoveryPhrase && (
            <>
              {/* Recovery phrase grid */}
              <div className="bg-secondary/50 border border-border rounded-lg p-4 font-mono text-sm">
                {formatRecoveryPhrase(recoveryPhrase).map((row, i) => (
                  <div key={i} className="flex gap-4 mb-2">
                    {row.map((item, j) => (
                      <div key={j} className="flex-1 flex items-center gap-2">
                        <span className="text-muted-foreground w-6 text-right">{item.num}.</span>
                        <span className="text-foreground font-medium">{item.word}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Important notes */}
              <div className="bg-warning/10 border border-warning/30 rounded-lg p-4 space-y-2">
                <p className="text-warning font-semibold text-sm">IMPORTANT:</p>
                <ul className="text-xs text-foreground space-y-1 list-disc list-inside">
                  <li>Write these words on paper (DO NOT take a screenshot)</li>
                  <li>Store in a safe place (safe, password manager, etc.)</li>
                  <li>This phrase can recover your identity if you forget your password</li>
                  <li>Keep your database backups safe as well</li>
                </ul>
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button onClick={onConfirm} className="w-full">
            <CheckCircle className="w-4 h-4" />
            I wrote it down
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
