import type { FC } from "react";
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

type GroupInfoDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  groupName: string;
  groupStatus: string;
  keyVersion: number;
  creatorName: string;
  creatorPeerId: string;
  createdAtLabel: string;
  memberCount: number;
  invitedOrPendingCount: number;
  isCurrentUserGroupCreator: boolean;
  members: ChatHeaderGroupMember[];
};

export const GroupInfoDialog: FC<GroupInfoDialogProps> = ({
  open,
  onOpenChange,
  loading,
  groupName,
  groupStatus,
  keyVersion,
  creatorName,
  creatorPeerId,
  createdAtLabel,
  memberCount,
  invitedOrPendingCount,
  isCurrentUserGroupCreator,
  members,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Group Info</DialogTitle>
          <DialogDescription>
            Details about this group and its members.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[60vh] overflow-y-auto space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium text-right">{groupName}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Status</span>
                  <span className="text-right">{groupStatus}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Key version</span>
                  <span className="font-mono text-right">{keyVersion}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Creator</span>
                  <span className="text-right">{creatorName}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Creator peer ID</span>
                  <span className="font-mono text-xs text-right break-all">{creatorPeerId}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Created</span>
                  <span className="text-right">{createdAtLabel}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Members</span>
                  <span className="text-right">{memberCount}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Invited/Pending</span>
                  <span className="text-right">{invitedOrPendingCount}</span>
                </div>
              </div>
              <div className="border-t border-border pt-3 space-y-2">
                <h4 className="text-sm font-medium">Member list</h4>
                <div className="max-h-56 overflow-y-auto border border-border rounded-md">
                  <div className="px-3 py-2.5 border-b border-border text-sm flex items-center justify-between">
                    <span>You</span>
                    <span className="text-xs text-muted-foreground">{isCurrentUserGroupCreator ? 'creator' : 'member'}</span>
                  </div>
                  {members.length === 0 ? (
                    <div className="p-3 text-sm text-muted-foreground">No other members yet.</div>
                  ) : (
                    members
                      .slice()
                      .sort((a, b) => a.username.localeCompare(b.username))
                      .map((member) => (
                        <div key={member.peerId} className="px-3 py-2.5 border-b border-border last:border-b-0 text-sm flex items-center justify-between gap-3">
                          <span className="truncate">{member.username}</span>
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {member.status === 'confirmed' ? 'member' : member.status === 'accepted' ? 'awaiting activation' : 'invited'}
                          </span>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
