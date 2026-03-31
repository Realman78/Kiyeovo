import { useState, useEffect } from "react";
import { AtSign, Shield, AlertCircle, Copy, Check, User, Edit2, X, Download, Lock, Key, ChevronDown, CheckCircle, Loader2 } from "lucide-react";
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
import { generateSharedSecretValue } from "../../../utils/general";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";


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
    const [autoRegister, setAutoRegister] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [isUnregistering, setIsUnregistering] = useState(false);
    const [isExportExpanded, setIsExportExpanded] = useState(false);
    const [exportPassword, setExportPassword] = useState("");
    const [exportPasswordConfirm, setExportPasswordConfirm] = useState("");
    const [sharedSecret, setSharedSecret] = useState("");
    const [generatedSharedSecret, setGeneratedSharedSecret] = useState("");
    const [confirmCustomSecretRisk, setConfirmCustomSecretRisk] = useState(false);
    const [exportError, setExportError] = useState("");
    const [exportSuccess, setExportSuccess] = useState(false);
    const [exportedFingerprint, setExportedFingerprint] = useState("");
    const [exportedFilePath, setExportedFilePath] = useState("");
    const [fingerprintCopied, setFingerprintCopied] = useState(false);
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
            setIsExportExpanded(false);
            setExportError("");
            setExportPassword("");
            setExportPasswordConfirm("");
            setSharedSecret("");
            setGeneratedSharedSecret("");
            setConfirmCustomSecretRisk(false);
            setExportSuccess(false);
            setExportedFingerprint("");
            setExportedFilePath("");
            setFingerprintCopied(false);
        } else {
            // Load auto-register setting when dialog opens
            const loadAutoRegister = async () => {
                const result = await window.kiyeovoAPI.getAutoRegister();
                setAutoRegister(result.autoRegister);
            };
            loadAutoRegister();
            const generatedSecret = generateSharedSecretValue();
            setSharedSecret(generatedSecret);
            setGeneratedSharedSecret(generatedSecret);
            setConfirmCustomSecretRisk(false);
        }
    }, [open]);

    useEffect(() => {
        setNewUsername(user.username ?? "");
    }, [open, user.username])

    const handleAutoRegisterToggle = async (enabled: boolean) => {
        setAutoRegister(enabled);
        await window.kiyeovoAPI.setAutoRegister(enabled);
    };

    const handleCloseExportSuccess = () => {
        setExportSuccess(false);
        setExportedFingerprint("");
        setExportedFilePath("");
        setFingerprintCopied(false);
        setIsExportExpanded(false);
        onOpenChange(false);
    };

    const handleCopyFingerprint = async () => {
        if (exportedFingerprint) {
            await navigator.clipboard.writeText(exportedFingerprint);
            setFingerprintCopied(true);
            setTimeout(() => setFingerprintCopied(false), 2000);
        }
    };

    const handleExportProfile = async () => {
        setExportError("");
        const normalizedSharedSecret = sharedSecret.trim();
        const isCustomSharedSecret = normalizedSharedSecret !== generatedSharedSecret;

        // Validate inputs
        if (!exportPassword) {
            setExportError("Password is required");
            return;
        }

        if (exportPassword !== exportPasswordConfirm) {
            setExportError("Passwords do not match");
            return;
        }

        if (!normalizedSharedSecret) {
            setExportError("Shared secret is required");
            return;
        }

        if (isCustomSharedSecret && !confirmCustomSecretRisk) {
            setExportError("Please confirm the custom shared-secret warning before export.");
            return;
        }

        if (exportPassword.length < 8) {
            setExportError("Password must be at least 8 characters");
            return;
        }

        setIsExporting(true);

        try {
            const reuseResult = await window.kiyeovoAPI.checkTrustedSecretReuse(normalizedSharedSecret);
            if (reuseResult.success && reuseResult.isReused) {
                setExportError(
                    `This shared secret is already used in ${reuseResult.count} trusted chat${reuseResult.count === 1 ? "" : "s"}. ` +
                    "Reusing it can share one outgoing bucket across contacts and ACKs may prune pending messages for the wrong recipient. Generate a unique secret."
                );
                return;
            }
            if (!reuseResult.success) {
                console.warn("Shared secret reuse check failed:", reuseResult.error);
            }

            const result = await window.kiyeovoAPI.exportProfile(exportPassword, normalizedSharedSecret);

            if (result.success && result.filePath && result.fingerprint) {
                // Show success dialog with security warnings
                setExportedFilePath(result.filePath);
                setExportedFingerprint(result.fingerprint);
                setExportSuccess(true);

                // Reset form
                setExportPassword("");
                setExportPasswordConfirm("");
                const generatedSecret = generateSharedSecretValue();
                setSharedSecret(generatedSecret);
                setGeneratedSharedSecret(generatedSecret);
                setConfirmCustomSecretRisk(false);
            } else {
                setExportError(result.error || "Failed to export profile");
            }
        } catch (error) {
            console.error("Failed to export profile:", error);
            setExportError(errStr(error, UNEXPECTED_ERROR));
        } finally {
            setIsExporting(false);
        }
    };

    const handleGenerateSharedSecret = () => {
        const generatedSecret = generateSharedSecretValue();
        setSharedSecret(generatedSecret);
        setGeneratedSharedSecret(generatedSecret);
        setConfirmCustomSecretRisk(false);
        if (exportError) {
            setExportError("");
        }
    };

    const handleSharedSecretChange = (value: string) => {
        setSharedSecret(value);
        setConfirmCustomSecretRisk(false);
        if (exportError) {
            setExportError("");
        }
    };

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

                        <div className="pt-2 pb-2 border-t border-b border-border">
                            <div className="flex items-center justify-between">
                                <div>
                                    <label className="block text-sm font-medium text-foreground mb-1">
                                        Auto-register username
                                    </label>
                                    <p className="text-xs text-muted-foreground">
                                        Automatically restore your username when the app starts
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleAutoRegisterToggle(!autoRegister)}
                                    className={`relative cursor-pointer inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                        autoRegister ? 'bg-primary' : 'bg-input'
                                    } ${autoRegister ? 'hover:bg-primary/80' : 'hover:bg-input/80'}`}
                                >
                                    <span
                                        className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                                            autoRegister ? 'translate-x-6' : 'translate-x-1'
                                        }`}
                                    />
                                </button>
                            </div>
                        </div>

                        <div className="pt-2 pb-2 border-b border-border">
                            <button
                                type="button"
                                onClick={() => setIsExportExpanded(!isExportExpanded)}
                                className="w-full cursor-pointer flex items-center justify-between py-1 hover:bg-secondary/50 transition-colors rounded pr-2"
                            >
                                <div>
                                    <div className="text-sm font-medium text-foreground text-left">
                                        Export Profile
                                    </div>
                                    <p className="text-xs text-muted-foreground text-left">
                                        Share your encrypted profile with trusted contacts
                                    </p>
                                </div>
                                <ChevronDown
                                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isExportExpanded ? '' : '-rotate-90'}`}
                                />
                            </button>

                            <div
                                className={`transition-all duration-300 ease-in-out overflow-hidden ${isExportExpanded ? 'max-h-[600px]' : 'max-h-0'}`}
                            >
                                {!exportSuccess ? (
                                    <div className="space-y-3 pt-3">
                                        <Input
                                            type="password"
                                            placeholder="Enter password..."
                                            value={exportPassword}
                                            onChange={(e) => setExportPassword(e.target.value)}
                                            icon={<Lock className="w-4 h-4" />}
                                            spellCheck={false}
                                            autoComplete="new-password"
                                        />
                                        <Input
                                            type="password"
                                            placeholder="Confirm password..."
                                            value={exportPasswordConfirm}
                                            onChange={(e) => setExportPasswordConfirm(e.target.value)}
                                            icon={<Lock className="w-4 h-4" />}
                                            spellCheck={false}
                                            autoComplete="new-password"
                                        />
                                        <div className="space-y-2">
                                            <div className="flex items-center gap-2">
                                                <div className="flex-1">
                                                    <Input
                                                        type="text"
                                                        placeholder="Shared secret (coordinate with recipient)..."
                                                        value={sharedSecret}
                                                        onChange={(e) => handleSharedSecretChange(e.target.value)}
                                                        icon={<Key className="w-4 h-4" />}
                                                        spellCheck={false}
                                                    />
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={handleGenerateSharedSecret}
                                                    disabled={isExporting}
                                                >
                                                    Generate
                                                </Button>
                                            </div>
                                            <p className="text-xs text-muted-foreground">
                                                Use a unique secret per recipient. Reusing a secret can make multiple trusted contacts share one outgoing bucket and ACK-based cleanup can prune pending messages for the wrong contact.
                                            </p>
                                            {sharedSecret.trim() !== generatedSharedSecret && (
                                                <label className="flex items-start gap-2 text-xs text-foreground">
                                                    <input
                                                        type="checkbox"
                                                        className="mt-0.5"
                                                        checked={confirmCustomSecretRisk}
                                                        onChange={(e) => setConfirmCustomSecretRisk(e.target.checked)}
                                                        disabled={isExporting}
                                                    />
                                                    <span>
                                                        I understand this custom shared secret is risky if reused and can cause shared-bucket metadata overlap and ACK-based pruning across contacts.
                                                    </span>
                                                </label>
                                            )}
                                        </div>
                                        {exportError && (
                                            <div className="flex items-center gap-2 text-destructive text-sm">
                                                <AlertCircle className="w-4 h-4" />
                                                <span>{exportError}</span>
                                            </div>
                                        )}
                                        <Button
                                            type="button"
                                            size="sm"
                                            onClick={handleExportProfile}
                                            disabled={
                                                isExporting ||
                                                !exportPassword ||
                                                !sharedSecret ||
                                                (sharedSecret.trim() !== generatedSharedSecret && !confirmCustomSecretRisk)
                                            }
                                            className="w-full"
                                        >
                                            <Download className="w-3 h-3 mr-2" />
                                            {isExporting ? 'Exporting...' : 'Export Profile'}
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="space-y-4 pt-3">
                                        {/* Success Message */}
                                        <div className="flex items-center gap-2 text-success">
                                            <CheckCircle className="w-5 h-5" />
                                            <span className="font-medium">Profile exported successfully!</span>
                                        </div>

                                        {/* File Location */}
                                        <div>
                                            <label className="block text-xs font-medium text-muted-foreground mb-1">
                                                Saved to
                                            </label>
                                            <div className="p-2 rounded-md bg-secondary/50 border border-border">
                                                <p className="text-xs font-mono break-all">{exportedFilePath}</p>
                                            </div>
                                        </div>

                                        {/* Security Warning */}
                                        <div className="p-3 rounded-md bg-warning/10 border border-warning/50">
                                            <div className="flex items-start gap-2">
                                                <AlertCircle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                                                <div className="space-y-2">
                                                    <p className="font-medium text-foreground text-sm">SECURITY NOTICE</p>
                                                    <p className="text-xs text-muted-foreground">
                                                        This profile allows anyone with the file and password to:
                                                    </p>
                                                    <ul className="text-xs text-muted-foreground space-y-1 ml-4 list-disc">
                                                        <li>Send you offline messages</li>
                                                        <li>Impersonate lookups (if they have your peerId)</li>
                                                        <li>Cause cross-contact bucket sharing; reused shared secrets can leak metadata and ACK cleanup can remove pending messages for the wrong contact</li>
                                                    </ul>
                                                    <p className="text-xs text-muted-foreground font-medium">
                                                        Only share this with people you trust. Communicate the password separately (phone, video call, etc.).
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Fingerprint */}
                                        <div>
                                            <label className="block text-xs font-medium text-muted-foreground mb-1">
                                                Fingerprint (verify with recipient)
                                            </label>
                                            <div className="p-2 rounded-md bg-secondary/50 border border-border font-mono text-xs break-all">
                                                {exportedFingerprint}
                                            </div>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                onClick={handleCopyFingerprint}
                                                className="w-full mt-2"
                                            >
                                                {fingerprintCopied ? (
                                                    <>
                                                        <Check className="w-3 h-3 mr-2" />
                                                        Copied!
                                                    </>
                                                ) : (
                                                    <>
                                                        <Copy className="w-3 h-3 mr-2" />
                                                        Copy Fingerprint
                                                    </>
                                                )}
                                            </Button>
                                        </div>

                                        {/* Close Button */}
                                        <Button
                                            type="button"
                                            onClick={handleCloseExportSuccess}
                                            className="w-full"
                                        >
                                            I Understand
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="p-3 rounded-md bg-secondary/50 border border-border">
                            <div className="flex items-start gap-2">
                                <Shield size={55} className="text-primary h-fit mt-0.5" />
                                <div className="text-s text-muted-foreground">
                                    <p className="font-medium text-foreground mb-1">Important</p>
                                    <p className="text-sm mb-2">
                                        Your username is published through the DHT so other users can find you.
                                        Usernames are convenient, but Peer IDs and trusted profiles give stronger recipient verification when you need to target an exact user.
                                    </p>
                                    <p className="text-sm">
                                        In profile export, the password encrypts the file itself.
                                        The shared secret is separate: it defines the recipient's offline bucket until both of you connect online.
                                        Always use a different shared secret for each trusted recipient and verify it out-of-band.
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
