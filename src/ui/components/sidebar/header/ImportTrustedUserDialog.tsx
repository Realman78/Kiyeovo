import { useState, useEffect } from "react";
import { UserPlus, AlertCircle, FileUp, Lock, AtSign, Copy, CheckCircle, ChevronDown } from "lucide-react";
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
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";

interface ImportTrustedUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (chatId: number) => void;
}

const ImportTrustedUserDialog = ({ open, onOpenChange, onSuccess }: ImportTrustedUserDialogProps) => {
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [customName, setCustomName] = useState("");

  const [fileError, setFileError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [customNameError, setCustomNameError] = useState("");
  const [importError, setImportError] = useState("");

  const [isImporting, setIsImporting] = useState(false);
  const [isHelpExpanded, setIsHelpExpanded] = useState(false);
  const [importSuccess, setImportSuccess] = useState(false);
  const [importResult, setImportResult] = useState<{
    fingerprint?: string;
    chatId?: number;
    username?: string;
    peerId?: string;
  } | null>(null);
  const [fingerprintCopied, setFingerprintCopied] = useState(false);

  const validateCustomName = (value: string) => {
    if (!value) return "";
    if (value.length < 2) {
      return "Custom name must be at least 2 characters";
    }
    if (value.length > 64) {
      return "Custom name must be less than 64 characters";
    }
    return "";
  };

  const handleBrowseFile = async () => {
    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select Profile File',
        filters: [{ name: 'Kiyeovo Profile', extensions: ['kiyeovo', 'enc'] }]
      });

      if (!result.canceled && result.filePath) {
        setSelectedFilePath(result.filePath);
        setFileError("");
      }
    } catch (error) {
      console.error('Failed to open file dialog:', error);
      setFileError('Failed to open file dialog');
    }
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (passwordError) setPasswordError("");
    if (importError) setImportError("");
  };

  const handleCustomNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCustomName(e.target.value);
    if (customNameError) setCustomNameError("");
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedFilePath) {
      setFileError("Please select a profile file");
      return;
    }

    if (!password) {
      setPasswordError("Password is required");
      return;
    }

    if (customName) {
      const nameError = validateCustomName(customName);
      if (nameError) {
        setCustomNameError(nameError);
        return;
      }
    }

    setIsImporting(true);
    setImportError("");

    try {
      const result = await window.kiyeovoAPI.importTrustedUser(
        selectedFilePath,
        password,
        customName || undefined
      );

      if (result.success) {
        setImportSuccess(true);
        setImportResult(result);
      } else {
        setImportError(result.error || "Failed to import trusted user");
      }
    } catch (err) {
      console.error("Failed to import trusted user:", err);
      setImportError(errStr(err, UNEXPECTED_ERROR));
    } finally {
      setIsImporting(false);
    }
  };

  const handleCopyFingerprint = async () => {
    if (importResult?.fingerprint) {
      await navigator.clipboard.writeText(importResult.fingerprint);
      setFingerprintCopied(true);
      setTimeout(() => setFingerprintCopied(false), 2000);
    }
  };

  const handleDone = () => {
    if (importResult?.chatId && onSuccess) {
      onSuccess(importResult.chatId);
    }
    onOpenChange(false);
  };

  useEffect(() => {
    if (!open) {
      setSelectedFilePath(null);
      setPassword("");
      setCustomName("");
      setFileError("");
      setPasswordError("");
      setCustomNameError("");
      setImportError("");
      setIsImporting(false);
      setIsHelpExpanded(false);
      setImportSuccess(false);
      setImportResult(null);
      setFingerprintCopied(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/20 border border-primary/50 flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle>Add user from file</DialogTitle>
              <DialogDescription>
                {importSuccess ? "Verify fingerprint" : "Add a contact from the profile file they shared"}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!importSuccess ? (
          <form onSubmit={handleImport}>
            <DialogBody className="space-y-4">
              {/* How does this work? */}
              <div className="rounded-md border border-border bg-secondary/30">
                <button
                  type="button"
                  onClick={() => setIsHelpExpanded(!isHelpExpanded)}
                  aria-expanded={isHelpExpanded}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-foreground"
                >
                  How does this work?
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isHelpExpanded ? '' : '-rotate-90'}`}
                  />
                </button>
                <div
                  className={`overflow-hidden transition-all duration-300 ease-in-out ${isHelpExpanded ? 'max-h-80' : 'max-h-0'}`}
                >
                  <p className="px-3 pb-3 text-xs leading-5 text-muted-foreground">
                    Ask your contact to{' '}
                    <span className="font-medium text-foreground">export their profile</span> by registering
                    & selecting the "Export profile" option in the profile tab; they&apos;ll get an encrypted file and a password to send
                    you through a channel you trust (in person, a call, etc.). Select that file here
                    and enter the password. After importing, you&apos;ll{' '}
                    <span className="font-medium text-foreground">verify a fingerprint</span>{' '}
                    together to confirm it&apos;s really them.
                  </p>
                </div>
              </div>

              {/* File Input */}
              <div>
                <label className="block text-sm font-bold text-foreground mb-2">
                  Profile File
                </label>
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleBrowseFile}
                    className="w-full justify-start"
                  >
                    <FileUp className="w-4 h-4 mr-2" />
                    {selectedFilePath ? 'Change File' : 'Browse...'}
                  </Button>
                  {selectedFilePath && (
                    <p className="text-xs text-muted-foreground truncate" title={selectedFilePath}>
                      {selectedFilePath.split(/[\\/]/).pop()}
                    </p>
                  )}
                </div>
                {fileError && (
                  <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>{fileError}</span>
                  </div>
                )}
              </div>

              {/* Password Input */}
              <div>
                <label className="block text-sm font-bold text-foreground mb-2">
                  Password
                </label>
                <Input
                  type="password"
                  placeholder="Enter profile password..."
                  value={password}
                  onChange={handlePasswordChange}
                  icon={<Lock className="w-4 h-4" />}
                  autoComplete="off"
                  spellCheck={false}
                />
                {passwordError && (
                  <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>{passwordError}</span>
                  </div>
                )}
              </div>

              {/* Custom Name Input */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Custom Name (optional)
                </label>
                <Input
                  placeholder="Leave empty to use name from file..."
                  value={customName}
                  onChange={handleCustomNameChange}
                  icon={<AtSign className="w-4 h-4" />}
                  spellCheck={false}
                />
                {customNameError && (
                  <div className="flex items-center gap-2 mt-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>{customNameError}</span>
                  </div>
                )}
              </div>

              {/* Import Error */}
              {importError && (
                <div className="p-3 rounded-md bg-destructive/10 border border-destructive/50">
                  <div className="flex items-center gap-2 text-destructive text-sm">
                    <AlertCircle className="w-4 h-4" />
                    <span>{importError}</span>
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
                Close
              </Button>
              <Button type="submit" disabled={isImporting}>
                {isImporting ? "Importing..." : "Import"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div>
            <DialogBody className="space-y-4">
              {/* Success Message */}
              <div className="p-3 rounded-md bg-success/10 border border-success/50">
                <div className="flex items-center gap-2 text-success text-sm">
                  <CheckCircle className="w-4 h-4" />
                  <span>Profile imported successfully!</span>
                </div>
              </div>

              {/* User Info */}
              <div className="space-y-2">
                <div className="text-sm">
                  <span className="text-muted-foreground">Username: </span>
                  <span className="font-medium">{importResult?.username}</span>
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Peer ID: </span>
                  <span className="font-mono text-xs">{importResult?.peerId}...</span>
                </div>
              </div>

              {/* Fingerprint */}
              <div>
                <label className="block text-sm font-bold text-foreground mb-2">
                  Fingerprint
                </label>
                <p className="text-xs text-muted-foreground mb-2">
                  Verify this fingerprint with the user over a secure channel (phone, video call)
                </p>
                <div className="p-3 rounded-md bg-secondary/50 border border-border font-mono text-xs break-all">
                  {importResult?.fingerprint}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleCopyFingerprint}
                  className="mt-2 w-full"
                >
                  <Copy className="w-3 h-3 mr-2" />
                  {fingerprintCopied ? "Copied!" : "Copy Fingerprint"}
                </Button>
              </div>
            </DialogBody>

            <DialogFooter>
              <Button onClick={handleDone}>
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ImportTrustedUserDialog;
