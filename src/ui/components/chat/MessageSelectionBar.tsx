import { Trash2, X } from "lucide-react";
import { Button } from "../ui/Button";

type MessageSelectionBarProps = {
  selectedCount: number;
  onClose: () => void;
  onDelete?: () => void;
};

export const MessageSelectionBar = ({
  selectedCount,
  onClose,
  onDelete,
}: MessageSelectionBarProps) => {
  return (
    <div className="flex min-h-20 items-center gap-3 border-t border-border bg-background px-4 py-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onClose}
        aria-label="Exit message selection"
        title="Exit selection"
      >
        <X className="h-4 w-4" />
      </Button>

      <span className="min-w-0 flex-1 font-mono text-sm text-foreground">
        {selectedCount} selected
      </span>

      <Button
        type="button"
        variant="destructive"
        disabled={selectedCount === 0 || !onDelete}
        onClick={onDelete}
        aria-label="Delete selected messages"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </Button>
    </div>
  );
};
