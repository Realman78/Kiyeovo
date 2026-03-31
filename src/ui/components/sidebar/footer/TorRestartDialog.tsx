import type { FC } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";

type TorRestartDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  message?: string;
};

export const TorRestartDialog: FC<TorRestartDialogProps> = ({
  open,
  onOpenChange,
  onCancel,
  onConfirm,
  message = 'Changing Tor transport settings requires a full app restart. Apply changes now?'
}) => {
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      onCancel();
    }
    onOpenChange(newOpen);
  };

  const handleConfirm = () => {
    onOpenChange(false);
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Restart Required</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            {message}
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirm}>
              Restart
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
