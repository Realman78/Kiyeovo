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
import { Input } from "../../ui/Input";

type EditUsernameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string;
  newUsername: string;
  validationError: string;
  confirmDisabled: boolean;
  onUsernameChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export const EditUsernameDialog: FC<EditUsernameDialogProps> = ({
  open,
  onOpenChange,
  username,
  newUsername,
  validationError,
  confirmDisabled,
  onUsernameChange,
  onCancel,
  onConfirm,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}>
          <DialogHeader>
            <DialogTitle>Rename Contact</DialogTitle>
            <DialogDescription>
              Enter new username for {username}. This rename is only visible to you.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <label className="block text-sm font-medium text-foreground mb-2">
              New Username
            </label>
            <Input
              value={newUsername}
              onChange={(event) => onUsernameChange(event.target.value)}
              placeholder={username}
            />
            {validationError && (
              <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>{validationError}</span>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              disabled={confirmDisabled}
            >
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
