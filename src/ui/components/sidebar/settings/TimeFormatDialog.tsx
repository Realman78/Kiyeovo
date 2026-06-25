import type { FC } from 'react';
import { Check } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../../state/store';
import { setTimeFormat, type TimeFormat } from '../../../state/slices/uiPrefsSlice';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';

type TimeFormatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const OPTIONS: { value: TimeFormat; label: string; sample: string }[] = [
  { value: '24h', label: '24-hour', sample: '14:30' },
  { value: '12h', label: '12-hour (AM/PM)', sample: '02:30 PM' },
];

export const TimeFormatDialog: FC<TimeFormatDialogProps> = ({ open, onOpenChange }) => {
  const dispatch = useDispatch();
  const current = useSelector((state: RootState) => state.uiPrefs.timeFormat);

  const select = (value: TimeFormat) => {
    if (value !== current) {
      dispatch(setTimeFormat(value));
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Time format</DialogTitle>
          <DialogDescription>
            Choose how times are displayed throughout the app.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          {OPTIONS.map((option) => {
            const selected = option.value === current;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => select(option.value)}
                className={`flex cursor-pointer w-full items-center justify-between gap-4 rounded-lg border p-4 text-left transition-colors ${
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background/60 hover:bg-sidebar-accent'
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{option.label}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{option.sample}</p>
                </div>
                {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
