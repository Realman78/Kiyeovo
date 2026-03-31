import type { FC } from "react";
import { AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";

type DeleteGroupChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDeleting: boolean;
  onConfirm: () => void;
};

export const DeleteGroupChatDialog: FC<DeleteGroupChatDialogProps> = ({
  open,
  onOpenChange,
  isDeleting,
  onConfirm,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Group Chat</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this group chat? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
            <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="text-sm text-warning">
              <p className="font-semibold mb-1">Local action</p>
              <p className="text-xs">
                This only removes the chat from your device.
              </p>
            </div>
          </div>
        </DialogBody>
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
            {isDeleting ? 'Deleting...' : 'Delete Chat'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
