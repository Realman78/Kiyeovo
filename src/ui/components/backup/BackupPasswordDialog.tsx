import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2, Lock, Shield } from 'lucide-react';
import { Button } from '../ui/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog';
import { Input } from '../ui/Input';

type BackupPasswordDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  submittingLabel: string;
  requireConfirmation?: boolean;
  submitting?: boolean;
  error?: string | null;
  onSubmit: (password: string) => void;
};

type BackupPasswordDialogFormProps = Omit<BackupPasswordDialogProps, 'open' | 'onOpenChange'> & {
  onCancel: () => void;
};

const BACKUP_PASSWORD_MIN_LENGTH = 12;

// Mirrors the authoritative check in ChatDatabase.assertStrongBackupPassword; enforced
// only when creating a backup (requireConfirmation), never on restore.
function validateBackupPasswordStrength(password: string): string | null {
  if (password.length < BACKUP_PASSWORD_MIN_LENGTH) {
    return `Backup password must be at least ${BACKUP_PASSWORD_MIN_LENGTH} characters`;
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 4) {
    return 'Backup password must include lowercase, uppercase, numbers, and a special character';
  }
  return null;
}

function BackupPasswordDialogForm({
  title,
  description,
  confirmLabel,
  submittingLabel,
  requireConfirmation = false,
  submitting = false,
  error = null,
  onSubmit,
  onCancel,
}: BackupPasswordDialogFormProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const mismatch = requireConfirmation && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = password.trim().length > 0
    && (!requireConfirmation || (confirmPassword.length > 0 && password === confirmPassword))
    && !submitting;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (password.trim().length === 0) {
      setLocalError('Enter a backup password');
      return;
    }
    if (requireConfirmation) {
      const strengthError = validateBackupPasswordStrength(password);
      if (strengthError) {
        setLocalError(strengthError);
        return;
      }
    }
    if (requireConfirmation && password !== confirmPassword) {
      setLocalError('Passwords do not match');
      return;
    }

    setLocalError(null);
    onSubmit(password);
  };

  return (
    <DialogContent className="max-w-md">
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">Backup Password</label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setLocalError(null);
                }}
                icon={<Lock className="h-4 w-4" />}
                disabled={submitting}
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                disabled={submitting}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {requireConfirmation && (
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Confirm Backup Password</label>
              <Input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setLocalError(null);
                }}
                icon={<Lock className="h-4 w-4" />}
                disabled={submitting}
              />
            </div>
          )}

          {(localError || error || mismatch) && (
            <p className="text-sm text-destructive">
              {localError || error || 'Passwords do not match'}
            </p>
          )}
        </DialogBody>

        <DialogFooter className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!canSubmit}
            className="flex-1"
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" />
                {submittingLabel}
              </>
            ) : (
              <>
                <Shield />
                {confirmLabel}
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

export function BackupPasswordDialog({
  open,
  onOpenChange,
  submitting = false,
  ...formProps
}: BackupPasswordDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) {
          onOpenChange(nextOpen);
        }
      }}
    >
      {open && (
        <BackupPasswordDialogForm
          {...formProps}
          submitting={submitting}
          onCancel={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}
