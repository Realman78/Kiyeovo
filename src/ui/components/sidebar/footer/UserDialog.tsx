import { useState, useEffect } from "react";
import { AtSign, Shield, AlertCircle, Copy, Check, User, Edit2, X, Loader2 } from "lucide-react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogBody,
    DialogFooter,
} from "../../ui/Dialog";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { useToast } from "../../ui/use-toast";
import { setRegistered, setUsername } from "../../../state/slices/userSlice";


interface UserDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRegister: (username: string) => Promise<void>;
    backendError?: string;
    isRegistering?: boolean;
}

const UserDialog = ({ open, onOpenChange, onRegister, backendError, isRegistering }: UserDialogProps) => {
    const [validationError, setValidationError] = useState("");
    const [unregisterError, setUnregisterError] = useState("");
    const [isCopied, setIsCopied] = useState(false);
    const [isEditingUsername, setIsEditingUsername] = useState(false);
    const [isUnregistering, setIsUnregistering] = useState(false);
    const { toast } = useToast();
    const user = useSelector((state: RootState) => state.user);
    const [newUsername, setNewUsername] = useState(user.username || "");
    const dispatch = useDispatch();

    const validateUsername = (value: string) => {
        if (value.length < 3) {
            return "Username must be at least 3 characters";
        }
        if (value.length > 32) {
            return "Username must be less than 32 characters";
        }
        if (!/^[a-zA-Z0-9_]+$/.test(value)) {
            return "Only letters, numbers, and underscores allowed";
        }
        return "";
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const error = validateUsername(newUsername);
        if (error) {
            setValidationError(error);
            return;
        }
        await onRegister(newUsername);
    };

    const handleUnregister = async () => {
        if (!user.username) {
            setUnregisterError("Username not found");
            return;
        }
        setIsUnregistering(true);
        setUnregisterError("");
        try {
            const result = await window.kiyeovoAPI.unregister();
            if (result.usernameUnregistered && result.peerIdUnregistered) {
                onOpenChange(false);
                toast.info("Username and peer ID unregistered successfully");
            } else if (result.usernameUnregistered) {
                toast.info("Username unregistered successfully. Peer ID is still registered");
            } else if (result.peerIdUnregistered) {
                toast.info("Peer ID unregistered successfully. Username is still registered");
            } else {
                setUnregisterError("Failed to unregister username and peer ID");
            }

            if (result.usernameUnregistered || result.peerIdUnregistered) {
                dispatch(setUsername(""));
                dispatch(setRegistered(false));
            }
        } finally {
            setIsUnregistering(false);
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setNewUsername(e.target.value);
        if (validationError) setValidationError("");
    };

    useEffect(() => {
        if (!open) {
            setNewUsername("");
            setValidationError("");
            setIsEditingUsername(false);
        }
    }, [open]);

    useEffect(() => {
        setNewUsername(user.username ?? "");
    }, [open, user.username])

    const displayError = backendError || validationError;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
                            <User className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <DialogTitle>{user.username}</DialogTitle>
                            {/* <DialogDescription>
                Create a unique username
              </DialogDescription> */}
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
                                <p className="text-sm font-medium text-foreground break-all">{user.peerId}</p>
                                <button
                                    type="button"
                                    className="text-sm cursor-pointer text-muted-foreground hover:text-foreground shrink-0"
                                    onClick={() => {
                                        setIsCopied(true);
                                        navigator.clipboard.writeText(user.peerId);
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
                            <label className="block text-sm font-bold text-foreground mb-2">
                                Username
                            </label>
                            <div className="flex items-center gap-3">
                                <p className="text-sm font-medium text-foreground">{user.username}</p>
                                {!isEditingUsername && (
                                    <button
                                        type="button"
                                        onClick={() => setIsEditingUsername(true)}
                                        className="text-sm cursor-pointer text-primary hover:text-primary/80 flex items-center gap-1"
                                    >
                                        <Edit2 className="w-3 h-3" />
                                        <span>Change</span>
                                    </button>
                                )}
                            </div>
                            {isEditingUsername && (
                                <div className="mt-3 space-y-2">
                                    <Input
                                        placeholder="Enter new username..."
                                        value={newUsername}
                                        onChange={handleChange}
                                        icon={<AtSign className="w-4 h-4" />}
                                        spellCheck={false}
                                        autoFocus
                                    />
                                    {displayError && (
                                        <div className="flex items-center gap-2 text-destructive text-sm">
                                            <AlertCircle className="w-4 h-4" />
                                            <span>{displayError}</span>
                                        </div>
                                    )}
                                    <div className="flex gap-2">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            onClick={() => {
                                                setIsEditingUsername(false);
                                                setNewUsername(user.username || "");
                                                setValidationError("");
                                            }}
                                        >
                                            <X className="w-3 h-3 mr-1" />
                                            Close
                                        </Button>
                                        <Button
                                            type="submit"
                                            size="sm"
                                            disabled={!newUsername || isRegistering || newUsername === user.username}
                                        >
                                            {isRegistering ? 'Saving...' : 'Save'}
                                        </Button>
                                    </div>
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

                        {!!unregisterError && (
                            <div className="flex items-center gap-2 text-destructive text-sm">
                                <AlertCircle className="w-4 h-4" />
                                <span>{unregisterError}</span>
                            </div>
                        )}
                    </DialogBody>

                    <DialogFooter>
                        <div className="flex flex-1 items-center justify-between">
                            <Button
                                type="button"
                                variant="destructive"
                                onClick={() => handleUnregister()}
                                disabled={isUnregistering}
                            >
                                {isUnregistering ? (
                                    <>
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        Unregistering...
                                    </>
                                ) : (
                                    "Unregister"
                                )}
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                Close
                            </Button>
                        </div>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};

export default UserDialog;
