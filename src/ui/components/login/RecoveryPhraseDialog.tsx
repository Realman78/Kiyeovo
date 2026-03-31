import { useState, useRef, useEffect } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { FileKey, CheckCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../ui/Dialog';

type RecoveryPhraseDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (phrase: string) => void;
}

export function RecoveryPhraseDialog({ open, onOpenChange, onSubmit }: RecoveryPhraseDialogProps) {
  const [words, setWords] = useState<string[]>(Array(24).fill(''));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Focus first input when dialog opens
  useEffect(() => {
    if (open) {
      setWords(Array(24).fill(''));
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    }
  }, [open]);

  const handleWordChange = (index: number, value: string) => {
    const newWords = [...words];
    // Only allow lowercase letters and spaces (trim spaces)
    const cleanValue = value.toLowerCase().trim();
    newWords[index] = cleanValue;
    setWords(newWords);

    // Auto-focus next input on space or when word is complete
    if (value.endsWith(' ') || (cleanValue.length > 2 && index < 23)) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && index < 23) {
      e.preventDefault();
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Backspace' && words[index] === '' && index > 0) {
      e.preventDefault();
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = () => {
    const phrase = words.map(w => w.trim()).join(' ');
    if (words.every(w => w.trim().length > 0)) {
      onSubmit(phrase);
      onOpenChange(false);
    }
  };

  const isComplete = words.every(w => w.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileKey className="w-5 h-5" />
            Enter Recovery Phrase
          </DialogTitle>
          <DialogDescription>
            Enter your 24-word recovery phrase to restore your identity
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 24 }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-6 text-right">{i + 1}.</span>
                <Input
                  ref={(el) => {
                    inputRefs.current[i] = el;
                    return;
                  }}
                  type="text"
                  value={words[i]}
                  onChange={(e) => handleWordChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  placeholder={`Word ${i + 1}`}
                  className="text-sm"
                  autoComplete="off"
                />
              </div>
            ))}
          </div>

          <div className="bg-warning/10 border border-warning/30 rounded-lg p-3">
            <p className="text-warning text-xs">
              Make sure you enter the words in the correct order. Each word must match exactly.
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isComplete}
          >
            <CheckCircle className="w-4 h-4" />
            Verify & Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
