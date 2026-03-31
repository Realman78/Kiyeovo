import { useState, useEffect, useMemo } from "react";
import { AlertCircle, Info, Users, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { MAX_GROUP_MEMBERS } from "../../../constants";
import { errStr } from '../../../../core/utils/general-error';

interface Contact {
  peerId: string;
  username: string;
}

export interface GroupInviteDeliveryView {
  peerId: string;
  username: string;
  status: 'sent' | 'queued_for_retry';
  reason?: string;
}

interface NewGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (groupId: string, chatId: number, inviteDeliveries: GroupInviteDeliveryView[]) => void;
}

const MAX_GROUP_NAME_LENGTH = 50;
const MAX_SELECTABLE = MAX_GROUP_MEMBERS - 1;

const NewGroupDialog = ({ open, onOpenChange, onSuccess }: NewGroupDialogProps) => {
  const chats = useSelector((state: RootState) => state.chat.chats);
  const [groupName, setGroupName] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedPeerIds, setSelectedPeerIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      // Preserve in-flight submit state when dialog is temporarily closed.
      // This lets the user reopen and still see "Creating...".
      if (isSubmitting) {
        return;
      }

      setGroupName("");
      setContacts([]);
      setSelectedPeerIds(new Set());
      setIsLoading(false);
      setIsSubmitting(false);
      setError(null);
      setLoadError(null);
      return;
    }

    const loadContacts = async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const result = await window.kiyeovoAPI.getContacts();
        if (result.success) {
          setContacts(result.contacts);
        } else {
          setLoadError(result.error || "Failed to load contacts");
        }
      } catch (err) {
        setLoadError(errStr(err, "Failed to load contacts"));
      } finally {
        setIsLoading(false);
      }
    };

    void loadContacts();
  }, [open, isSubmitting]);

  const toggleContact = (peerId: string) => {
    setSelectedPeerIds(prev => {
      const next = new Set(prev);
      if (next.has(peerId)) {
        next.delete(peerId);
      } else if (next.size < MAX_SELECTABLE) {
        next.add(peerId);
      }
      return next;
    });
  };

  const duplicateName = useMemo(() => {
    const trimmed = groupName.trim().toLowerCase();
    if (!trimmed) return false;
    return chats.some(c => c.type === 'group' && c.name.toLowerCase() === trimmed);
  }, [groupName, chats]);

  const canSubmit = groupName.trim().length > 0 && selectedPeerIds.size > 1 && !isSubmitting && !duplicateName;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await window.kiyeovoAPI.createGroup(
        groupName.trim(),
        Array.from(selectedPeerIds)
      );

      if (result.success && result.groupId && result.chatId) {
        onOpenChange(false);
        onSuccess?.(result.groupId, result.chatId, result.inviteDeliveries ?? []);
      } else {
        setError(result.error || "Failed to create group");
      }
    } catch (err) {
      setError(errStr(err, "Failed to create group"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedContacts = contacts.filter(c => selectedPeerIds.has(c.peerId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
              <Users className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>New Group</DialogTitle>
              <DialogDescription>
                Create a group and invite contacts
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-foreground mb-2">
                Group Name
              </label>
              <Input
                placeholder="Enter group name..."
                value={groupName}
                onChange={(e) => setGroupName(e.target.value.slice(0, MAX_GROUP_NAME_LENGTH))}
                autoFocus
                spellCheck={false}
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground mt-1">
                {groupName.length}/{MAX_GROUP_NAME_LENGTH}
              </p>
              {duplicateName && (
                <div className="flex items-center gap-2 mt-1 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>A group with this name already exists</span>
                </div>
              )}
            </div>

            {selectedContacts.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Selected ({selectedContacts.length})
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {selectedContacts.map(c => (
                    <button
                      key={c.peerId}
                      disabled={isSubmitting}
                      type="button"
                      onClick={() => toggleContact(c.peerId)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 transition-colors"
                    >
                      {c.username}
                      <span className="text-primary/60">&times;</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Contacts
              </label>
              <div className="max-h-48 overflow-y-auto border border-border rounded-md">
                {isLoading ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    Loading contacts...
                  </div>
                ) : loadError ? (
                  <div className="p-4 text-center text-sm text-destructive flex items-center justify-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    {loadError}
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No contacts found. Add contacts first by starting a conversation.
                  </div>
                ) : (
                  contacts.map(contact => {
                    const isSelected = selectedPeerIds.has(contact.peerId);
                    const isDisabled = (!isSelected && selectedPeerIds.size >= MAX_SELECTABLE) || isSubmitting;
                    return (
                      <button
                        key={contact.peerId}
                        type="button"
                        onClick={() => !isDisabled && toggleContact(contact.peerId)}
                        disabled={isDisabled}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors border-b border-border last:border-b-0 ${
                          isSelected
                            ? "bg-primary/10"
                            : isDisabled
                            ? "opacity-50 cursor-not-allowed"
                            : "hover:bg-secondary/50 cursor-pointer"
                        }`}
                      >
                        <div className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
                          isSelected
                            ? "bg-primary border-primary"
                            : "border-muted-foreground/40"
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                        </div>
                        <span className="text-sm text-foreground truncate">
                          {contact.username}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
              {selectedPeerIds.size >= MAX_SELECTABLE && (
                <p className="text-xs text-muted-foreground mt-1">
                  Maximum {MAX_SELECTABLE} members can be selected (groups support up to 10 members including you).
                </p>
              )}
            </div>

            {error && (
              <div className="flex items-center gap-2 text-destructive text-sm">
                <AlertCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}

            <div className="p-3 rounded-md bg-secondary/50 border border-border">
              <div className="flex items-start gap-2">
                <div className="w-5">
                  <Info size={70} className="text-primary h-5 w-fit mt-0.5" />
                </div>
                <div className="text-s text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">About group invitations</p>
                  <p className="text-sm">
                    Invitations are delivered individually (via the DHT) and each invited contact must accept before joining. 
                    The group becomes active after at least one user joins.
                  </p>
                </div>
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? "Creating..." : "Send Invites"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default NewGroupDialog;
