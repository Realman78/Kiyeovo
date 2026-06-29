import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { Button } from "../ui/Button";

type ConversationSearchNavigationProps = {
  query: string;
  currentIndex: number;
  total: number;
  loading: boolean;
  pending: boolean;
  error: string | null;
  onPrevious: () => void;
  onNext: () => void;
};

export const ConversationSearchNavigation = ({
  query,
  currentIndex,
  total,
  loading,
  pending,
  error,
  onPrevious,
  onNext,
}: ConversationSearchNavigationProps) => {
  const trimmedQuery = query.trim();
  const busy = loading || pending;
  const hasResult = currentIndex >= 0 && total > 0;
  const status = error
    ?? (trimmedQuery.length === 0
      ? "Search query is empty"
      : loading
        ? "Searching..."
        : hasResult
          ? `${currentIndex + 1} of ${total}`
          : "No matches");

  return (
    <div className="flex min-h-20 items-center justify-between gap-3 border-t border-border bg-background px-4 py-3">
      <span
        className={`min-w-0 text-left font-mono text-sm ${error ? "text-destructive" : "text-muted-foreground"
          }`}
        aria-live="polite"
      >
        {busy && <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" />}
        {status}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy || !hasResult || currentIndex >= total - 1}
          onClick={onNext}
          aria-label="Next search result"
          title="Next result"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={busy || !hasResult || currentIndex === 0}
          onClick={onPrevious}
          aria-label="Previous search result"
          title="Previous result"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>

      </div>
    </div>
  );
};
