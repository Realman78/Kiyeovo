import { type FC, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";

type DeleteAccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export const DeleteAccountDialog: FC<DeleteAccountDialogProps> = ({
  open,
  onOpenChange,
  onConfirm
}) => {
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  const isDeleteConfirmed = deleteConfirmText === "I want to delete my account";

  const handleClose = () => {
    setDeleteConfirmText("");
    onOpenChange(false);
  };

  const handleConfirm = () => {
    onOpenChange(false);
    setDeleteConfirmText("");
    onConfirm();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete Account and All Data</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This action is <span className="font-semibold text-destructive">irreversible</span>. Your account will be deleted and all information including:
            </p>
            <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
              <li>All conversations and messages</li>
              <li>Your identity and keys</li>
              <li>All settings and preferences</li>
              <li>Contact information</li>
            </ul>
            <p className="text-sm text-muted-foreground">
              will be permanently lost.
            </p>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                Type "<span className="font-mono">I want to delete my account</span>" to confirm:
              </label>
              <input
                type="text"
                className="w-full border border-border rounded px-3 py-2 bg-background text-sm"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="I want to delete my account"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleClose}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!isDeleteConfirmed}
                onClick={handleConfirm}
              >
                Delete Everything
              </Button>
            </div>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
