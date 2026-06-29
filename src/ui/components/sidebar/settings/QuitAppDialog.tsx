import { Loader2, Power } from 'lucide-react';
import { Button } from '../../ui/Button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';

type QuitAppDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  quitting: boolean;
};

export function QuitAppDialog({
  open,
  onOpenChange,
  onConfirm,
  quitting,
}: QuitAppDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!quitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Power className="h-5 w-5" />
            Are you sure you want to quit?
          </DialogTitle>
        </DialogHeader>
        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={quitting}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={quitting}
            className="flex-1"
          >
            {quitting ? (
              <>
                <Loader2 className="animate-spin" />
                Quitting...
              </>
            ) : (
              <>
                <Power />
                Quit
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
