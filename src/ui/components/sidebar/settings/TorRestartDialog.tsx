import { Loader2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';

type TorRestartDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  applying: boolean;
};

export function TorRestartDialog({
  open,
  onOpenChange,
  onCancel,
  onConfirm,
  applying,
}: TorRestartDialogProps) {
  const handleOpenChange = (nextOpen: boolean) => {
    if (applying) return;
    if (!nextOpen) {
      onCancel();
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Restart Required</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            Changing Tor transport settings requires a full app restart. Apply changes now?
          </p>
        </DialogBody>
        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={applying}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={applying}
            className="flex-1"
          >
            {applying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Restarting...
              </>
            ) : (
              'Apply & Restart'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
