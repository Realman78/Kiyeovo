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
  onConfirm: () => Promise<void>;
  saving: boolean;
};

export function SkipSetupConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  saving,
}: SkipSetupConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) {
          onOpenChange(nextOpen);
        }
      }}
    >
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
            onClick={() => { void onConfirm(); }}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Skip anyway'}
          </Button>
          <Button
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Keep setting up
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
