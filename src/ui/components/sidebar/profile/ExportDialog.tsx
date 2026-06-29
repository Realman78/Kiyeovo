import { useEffect, useState } from "react";
import { AlertCircle, Check, CheckCircle, Copy, Download, Key, Lock, Tag } from "lucide-react";
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
import { generateSharedSecretValue } from "../../../utils/general";
import { errStr } from "../../../../core/utils/general-error";
import { UNEXPECTED_ERROR } from "../../../constants";

interface ExportDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

const LABEL_MIN = 2;
const LABEL_MAX = 64;

const ExportDialog = ({ open, onOpenChange }: ExportDialogProps) => {
    const user = useSelector((state: RootState) => state.user);
    const [label, setLabel] = useState("");
    const [exportPassword, setExportPassword] = useState("");
    const [exportPasswordConfirm, setExportPasswordConfirm] = useState("");
    const [sharedSecret, setSharedSecret] = useState("");
    const [generatedSharedSecret, setGeneratedSharedSecret] = useState("");
    const [confirmCustomSecretRisk, setConfirmCustomSecretRisk] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [exportError, setExportError] = useState("");
    const [exportSuccess, setExportSuccess] = useState(false);
    const [exportedFingerprint, setExportedFingerprint] = useState("");
    const [exportedFilePath, setExportedFilePath] = useState("");
    const [fingerprintCopied, setFingerprintCopied] = useState(false);

    useEffect(() => {
        if (!open) {
            // Clear sensitive values when the dialog closes so they don't linger in memory.
            setLabel("");
            setExportPassword("");
            setExportPasswordConfirm("");
            setSharedSecret("");
            setGeneratedSharedSecret("");
            setConfirmCustomSecretRisk(false);
            setExportError("");
            setExportSuccess(false);
            setExportedFingerprint("");
            setExportedFilePath("");
            setFingerprintCopied(false);
            return;
        }
        // Reset and seed a fresh shared secret each time the dialog opens.
        setLabel(user.username || "");
        setExportPassword("");
        setExportPasswordConfirm("");
        setConfirmCustomSecretRisk(false);
        setExportError("");
        setExportSuccess(false);
        setExportedFingerprint("");
        setExportedFilePath("");
        setFingerprintCopied(false);
        const generatedSecret = generateSharedSecretValue();
        setSharedSecret(generatedSecret);
        setGeneratedSharedSecret(generatedSecret);
    }, [open, user.username]);

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
        const trimmedLabel = label.trim();

        // Validate inputs
        if (!trimmedLabel) {
            setExportError("Display label is required");
            return;
        }

        if (trimmedLabel.length < LABEL_MIN || trimmedLabel.length > LABEL_MAX) {
            setExportError(`Display label must be between ${LABEL_MIN} and ${LABEL_MAX} characters`);
            return;
        }

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

            const suggestedFilename = (
                trimmedLabel
                    .replace(/[\\/:*?"<>|]/g, "_")
                    .replace(/^\.+/, "")
                    .trim()
                || "kiyeovo-profile"
            ).slice(0, 64);

            const saveResult = await window.kiyeovoAPI.showSaveDialog({
                title: "Export trusted profile",
                defaultPath: `${suggestedFilename}.kiyeovo`,
                filters: [
                    { name: "Kiyeovo profile", extensions: ["kiyeovo"] },
                    { name: "All Files", extensions: ["*"] },
                ],
            });
            if (saveResult.canceled || !saveResult.filePath) {
                return;
            }

            const result = await window.kiyeovoAPI.exportProfile(
                exportPassword,
                normalizedSharedSecret,
                saveResult.filePath,
                trimmedLabel,
            );

            if (result.success && result.filePath && result.fingerprint) {
                // Show success state with security warnings
                setExportedFilePath(result.filePath);
                setExportedFingerprint(result.fingerprint);
                setExportSuccess(true);

                // Reset sensitive form fields
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

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
                            <Download className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <DialogTitle>Export trusted profile</DialogTitle>
                            <DialogDescription>
                                Share your encrypted profile with a trusted contact
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <DialogBody className="space-y-4 max-h-[60vh] overflow-y-auto">
                    {!exportSuccess ? (
                        <div className="space-y-2">
                            <div>
                                <label className="block text-sm font-medium text-foreground mb-1.5">
                                    Username
                                </label>
                                <Input
                                    type="text"
                                    placeholder="Name the recipient will see..."
                                    value={label}
                                    onChange={(e) => setLabel(e.target.value)}
                                    icon={<Tag className="w-4 h-4" />}
                                    spellCheck={false}
                                    className="mb-4"
                                />
                            </div>
                            <label className="block text-sm font-medium text-foreground mb-1.5">
                                Encryption password
                            </label>
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
                            <div className="space-y-2 mt-4">
                                <label className="block text-sm font-medium text-foreground mb-1.5">
                                    Shared secret
                                </label>
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
                                    !label.trim() ||
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
                        <div className="space-y-4">
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
                        </div>
                    )}
                </DialogBody>

                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {exportSuccess ? 'Done' : 'Close'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default ExportDialog;
