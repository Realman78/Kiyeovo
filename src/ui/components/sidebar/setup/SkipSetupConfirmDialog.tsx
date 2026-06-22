import { Button } from '../../ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';

type SkipSetupConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function SkipSetupConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: SkipSetupConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skip setup?</DialogTitle>
          <DialogDescription>
            You can&apos;t send or receive messages until the setup is
            configured. You can finish setup anytime from the Setup tab.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Skip anyway
          </Button>
          <Button onClick={() => onOpenChange(false)}>
            Keep setting up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
