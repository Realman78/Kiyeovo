import type { FC } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";

type DeleteAllMessagesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDeleting: boolean;
  onConfirm: () => void;
};

export const DeleteAllMessagesDialog: FC<DeleteAllMessagesDialogProps> = ({
  open,
  onOpenChange,
  isDeleting,
  onConfirm,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete All Messages</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete all messages in this chat? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting...' : 'Delete All'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
