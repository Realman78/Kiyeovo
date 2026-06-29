import { useState, useEffect, useRef } from "react";
import { UserPlus, AtSign, Shield, AlertCircle, Copy, Check, Shuffle, Info } from "lucide-react";
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
import { validateUsername } from "../../../utils/general";
import { generateRandomUsername } from "../../../utils/random-username";


interface RegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegister: (username: string, rememberMe: boolean) => Promise<void>;
  backendError?: string;
  isRegistering?: boolean;
  initialUsername?: string;
}

const RegisterDialog = ({
  open,
  onOpenChange,
  onRegister,
  backendError,
  isRegistering,
  initialUsername
}: RegisterDialogProps) => {
  const [username, setUsername] = useState("");
  const [validationError, setValidationError] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const peerId = useSelector((state: RootState) => state.user.peerId);
  const isConnected = useSelector((state: RootState) => state.user.connected);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const error = validateUsername(username, peerId);
    if (error) {
      setValidationError(error);
      return;
    }
    await onRegister(username, rememberMe);
  };

  const validationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setUsername(newValue);
    if (validationTimerRef.current) clearTimeout(validationTimerRef.current);
    if (newValue) {
      validationTimerRef.current = setTimeout(() => {
        setValidationError(validateUsername(newValue, peerId));
      }, 300);
    } else {
      setValidationError("");
    }
  };

  const handleGenerateUsername = () => {
    const randomName = generateRandomUsername();
    setUsername(randomName);
    if (validationError) setValidationError("");
  };

  useEffect(() => {
    if (open) {
      const initial = initialUsername || "";
      setUsername(initial);
      setValidationError("");
      if (!initial) {
        void window.kiyeovoAPI.getLastUsername().then((result) => {
          if (result.username) {
            setUsername(result.username);
          }
        });
      }
      return;
    }

    if (!isRegistering) {
      setUsername("");
      setValidationError("");
    }
  }, [open, isRegistering, initialUsername]);

  useEffect(() => {
    if (open) {
      const loadAutoRegister = async () => {
        const result = await window.kiyeovoAPI.getAutoRegister();
        setRememberMe(result.autoRegister);
      };
      loadAutoRegister();
    }
  }, [open]);

  const displayError = backendError || validationError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>Register Identity</DialogTitle>
              <DialogDescription>
                Create a unique username
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogBody className="space-y-4 max-h-[60vh] overflow-y-auto">
            <div>
              <label className="block text-sm font-bold text-foreground mb-2">
                Peer ID
              </label>
              <div className="flex items-center gap-3">
                <p className="text-sm font-medium text-foreground">{peerId}</p>
                <button
                  type="button"
                  className="text-sm cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setIsCopied(true);
                    navigator.clipboard.writeText(peerId);
                    setTimeout(() => {
                      setIsCopied(false);
                    }, 2000);
                  }}
                >
                  {isCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Username
              </label>
              <div className="relative">
                <Input
                  placeholder="Enter username..."
                  value={username}
                  onChange={handleChange}
                  icon={<AtSign className="w-4 h-4" />}
                  autoFocus
                  disabled={!isConnected || isRegistering}
                  spellCheck={false}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={handleGenerateUsername}
                  disabled={!isConnected || isRegistering}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded hover:bg-secondary/80 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Generate random username"
                >
                  <Shuffle className="w-4 h-4" />
                </button>
              </div>
              <label className="flex items-start gap-2 cursor-pointer group mt-3">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  disabled={!isConnected || isRegistering}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border bg-input text-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors leading-relaxed">
                  Auto-register on startup if username not taken
                </span>
              </label>
              {displayError && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>{displayError}</span>
                </div>
              )}
              {!isConnected && (
                <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4" />
                  <span>Connect to the network to register</span>
                </div>
              )}
            </div>

            <div className="p-3 rounded-md bg-secondary/50 border border-border">
              <div className="flex items-start gap-2">
                <Shield size={55} className="text-primary h-fit mt-0.5" />
                <div className="text-s text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Important</p>
                  <p className="text-sm">
                    Your username is published through the DHT so other users can find you.
                    Usernames are convenient, but Peer IDs and trusted profiles give stronger recipient verification when you need to target an exact user.
                  </p>
                </div>
              </div>
            </div>
            <div className="p-3 rounded-md bg-secondary/50 border border-border">
              <div className="flex items-start gap-2">
                <Info size={40} className="text-primary h-fit mt-[3px]" />
                <div className="text-s text-muted-foreground">
                  <p className="font-medium text-foreground mb-1">Registering is optional</p>
                  <p className="text-sm">
                    If you want to discover other users or let other users discover you, you MUST register.
                    However, if you want to talk to already existing contacts, you don't have to register.
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
            <Button type="submit" disabled={isRegistering || !isConnected || !username || !!validateUsername(username, peerId)}>
              {isRegistering ? 'Registering...' : 'Register'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default RegisterDialog;
