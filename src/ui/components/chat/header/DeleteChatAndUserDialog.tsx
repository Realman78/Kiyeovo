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

type DeleteChatAndUserDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDeleting: boolean;
  username: string;
  onConfirm: () => void;
};

export const DeleteChatAndUserDialog: FC<DeleteChatAndUserDialogProps> = ({
  open,
  onOpenChange,
  isDeleting,
  username,
  onConfirm,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Chat & User</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this chat and user? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
            <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="text-sm text-warning">
              <p className="font-semibold mb-1">Warning: Offline messages will not work immediately</p>
              <p className="text-xs">
                If you make contact with <span className="font-semibold">{username}</span> again, offline delivery and group updates in groups that <span className="font-semibold">{username}</span> is the creator of (or you are the creator of and the user is in those groups) WILL NOT WORK unless <span className="font-semibold">{username}</span> also deletes your account and then you establish a new contact.
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
