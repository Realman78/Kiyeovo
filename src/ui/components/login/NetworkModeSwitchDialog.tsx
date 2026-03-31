import { ArrowLeftRight, Loader2 } from 'lucide-react';
import type { NetworkMode } from '../../../core/types';
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

type NetworkModeSwitchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetMode: NetworkMode;
  targetModeLabel: string;
  onConfirm: (nextMode: NetworkMode) => Promise<void>;
  isSwitchingNetworkMode: boolean;
};

export function NetworkModeSwitchDialog({
  open,
  onOpenChange,
  targetMode,
  targetModeLabel,
  onConfirm,
  isSwitchingNetworkMode,
}: NetworkModeSwitchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowLeftRight className="w-5 h-5" />
            Switch Network Mode
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to switch to {targetModeLabel} mode?
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2 text-sm text-muted-foreground">
          <p>The app will restart to apply the new network mode.</p>
        </DialogBody>
        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="flex-1"
            disabled={isSwitchingNetworkMode}
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              await onConfirm(targetMode);
            }}
            className="flex-1"
            disabled={isSwitchingNetworkMode}
          >
            {isSwitchingNetworkMode ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Restarting...
              </>
            ) : (
              'Confirm & Restart'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
