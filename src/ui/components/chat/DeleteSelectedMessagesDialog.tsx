import { Loader2, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/Dialog";

type DeleteSelectedMessagesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  deleting: boolean;
  onConfirm: () => void;
};

export const DeleteSelectedMessagesDialog = ({
  open,
  onOpenChange,
  selectedCount,
  deleting,
  onConfirm,
}: DeleteSelectedMessagesDialogProps) => {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!deleting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete for me?</DialogTitle>
          <DialogDescription>
            {selectedCount === 1
              ? 'This message will be removed only for you. Recipient will still be able to read it.'
              : `These ${selectedCount} messages will be removed only for you. Recipient will still be able to read them.`}
            {' '}Other participants will keep their copies.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={deleting || selectedCount === 0}
          >
            {deleting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Delete
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
