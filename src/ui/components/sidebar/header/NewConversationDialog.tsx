import { useState, useEffect } from "react";
import { AtSign, AlertCircle, Plus, Info, Mail } from "lucide-react";
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


interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewConversation: (identifier: string, message: string) => Promise<void>;
  backendError?: string;
  setError: React.Dispatch<React.SetStateAction<string | undefined>>;
}

const NewConversationDialog = ({ open, onOpenChange, onNewConversation, backendError, setError }: NewConversationDialogProps) => {
  const [peerIdOrUsername, setPeerIdOrUsername] = useState("");
  const [message, setMessage] = useState("");
  const [usernameValidationError, setUsernameValidationError] = useState("");
  const [messageValidationError, setMessageValidationError] = useState("");
  const [isSending, setIsSending] = useState(false);

  const isConnected = useSelector((state: RootState) => state.user.connected);

  const validateUsername = (value: string) => {
    if (value.length < 3) {
      return "Username/PeerID must be at least 3 characters";
    }
    if (value.length > 100) {
      return "Username must be less than 100 characters";
    }
    if (!/^[a-zA-Z0-9_]+$/.test(value)) {
      return "Only letters, numbers, and underscores allowed";
    }
    return "";
  };

  const validateMessage = (value: string) => {
    if (value.length < 1) {
      return "Initial greeting must be at least 1 character";
    }
    if (value.length > 128) {
      return "Initial greeting must be less than 128 characters";
    }
    return "";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let error = validateUsername(peerIdOrUsername);
    if (error) {
      setUsernameValidationError(error);
      return;
    }
    error = validateMessage(message);
    if (error) {
      setMessageValidationError(error);
      return;
    }

    setIsSending(true);
    try {
      await onNewConversation(peerIdOrUsername, message);
    } finally {
      setIsSending(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPeerIdOrUsername(e.target.value);
    if (usernameValidationError) setUsernameValidationError("");
  };

  const handleMessageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessage(e.target.value);
    if (messageValidationError) setMessageValidationError("");
  };

  useEffect(() => {
    if (!open) {
      setPeerIdOrUsername("");
      setUsernameValidationError("");
      setMessageValidationError("");
      setMessage("");
      setIsSending(false);
      setError(undefined)
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
              <Plus className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>New Conversation</DialogTitle>
              <DialogDescription>
                Send an invite for a new conversation
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4">
            <div>
              <label className="block text-sm font-bold text-foreground mb-2">
                Peer ID or Username (case-sensitive)
              </label>
              <Input
                placeholder="Enter peer ID or username..."
                value={peerIdOrUsername}
                onChange={handleChange}
                icon={<AtSign className="w-4 h-4" />}
                autoFocus
                disabled={!isConnected}
                spellCheck={false}
              />
              {usernameValidationError && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>{usernameValidationError}</span>
                </div>
              )}
              {!isConnected && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>Connect to the network to send a message</span>
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Message
              </label>
              <Input
                placeholder="Compose an inital greeting..."
                value={message}
                onChange={handleMessageChange}
                icon={<Mail className="w-4 h-4" />}
                disabled={!isConnected}
                spellCheck={false}
              />
              {messageValidationError && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>{messageValidationError}</span>
                </div>
              )}
              {backendError && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>{backendError}</span>
                </div>
              )}
            </div>

            <div className="p-3 rounded-md bg-secondary/50 border border-border">
              <div className="flex items-start gap-2">
              <div className="w-5">
              <Info size={70} className="text-primary h-5 w-fit mt-0.5" />
                </div>
                <div className="text-s text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">About invitations</p>
                  <p className="text-sm">
                    The first message is sent as a conversation request. 
                    The recipient has 5 minutes to accept or reject it. 
                    If they accept, the conversation is created and your message is delivered. 
                    If the request expires, you can try again after the cooldown.
                  </p>
                </div>
              </div>
            </div>
            <div className="p-3 rounded-md bg-secondary/50 border border-border">
              <div className="flex items-start gap-2">
                <div className="w-5">
                  <Info size={70} className="text-primary h-5 w-fit mt-0.5" />
                </div>
                <div className="text-s text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Note</p>
                  <p className="text-sm">
                    If you are trying to send a message to a new user who has the same username as one of your contacts, use their Peer ID.
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
              Close
            </Button>
            <Button type="submit" disabled={!isConnected || !!usernameValidationError || !!messageValidationError || isSending}>
              {isSending ? 'Sending...' : 'Send'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default NewConversationDialog;
