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

type LeaveGroupDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  isCreator: boolean;
  isSubmitting: boolean;
  onConfirm: () => void;
};

export const LeaveGroupDialog: FC<LeaveGroupDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  isCreator,
  isSubmitting,
  onConfirm,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
            <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="text-sm text-warning">
              <p className="font-semibold mb-1">Consequences</p>
              <p className="text-xs">
                {isCreator
                  ? 'Members will receive a disband notification and this chat will become read-only with a disbanded status.'
                  : 'You will stop receiving new group messages and cannot send to this group. Rejoining requires a new invite from the group creator.'}
              </p>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isSubmitting}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
