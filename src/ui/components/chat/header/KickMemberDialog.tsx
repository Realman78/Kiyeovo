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
import type { ChatHeaderGroupMember } from "./ChatHeaderDialogTypes";

type KickMemberDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: ChatHeaderGroupMember[];
  selectedPeerId: string | null;
  onSelectPeerId: (peerId: string) => void;
  isSubmitting: boolean;
  onConfirm: () => void;
};

export const KickMemberDialog: FC<KickMemberDialogProps> = ({
  open,
  onOpenChange,
  members,
  selectedPeerId,
  onSelectPeerId,
  isSubmitting,
  onConfirm,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove Member</DialogTitle>
          <DialogDescription>
            Select a member to remove from this group.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="max-h-56 overflow-y-auto border border-border rounded-md">
            {members.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">No removable members.</div>
            ) : (
              members.map((member) => {
                const isSelected = selectedPeerId === member.peerId;
                return (
                  <button
                    key={member.peerId}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => onSelectPeerId(member.peerId)}
                    className={`cursor-pointer w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors ${isSelected ? 'bg-destructive/10 text-destructive' : 'hover:bg-secondary/50'}`}
                  >
                    {member.username}
                  </button>
                );
              })
            )}
          </div>
          <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/30 rounded">
            <AlertCircle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
            <div className="text-sm text-warning">
              <p className="font-semibold mb-1">Consequences</p>
              <p className="text-xs">
                The member will lose access to new group messages immediately and can rejoin only through a new invite.
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
            disabled={isSubmitting || !selectedPeerId}
          >
            {isSubmitting ? 'Removing...' : 'Remove Member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
