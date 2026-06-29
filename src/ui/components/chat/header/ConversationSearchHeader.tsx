import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";

const SEARCH_DEBOUNCE_MS = 250;

type ConversationSearchHeaderProps = {
  query: string;
  loading: boolean;
  focusRequest: number;
  onQueryChange: (query: string) => void;
  onCancel: () => void;
};

export const ConversationSearchHeader = ({
  query,
  loading,
  focusRequest,
  onQueryChange,
  onCancel,
}: ConversationSearchHeaderProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputQuery, setInputQuery] = useState(query);

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      onQueryChange(inputQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [inputQuery, onQueryChange]);

  return (
    <div className="flex h-16 items-center gap-3 border-b border-border bg-card/50 px-6">
      <Input
        ref={inputRef}
        value={inputQuery}
        onChange={(event) => setInputQuery(event.target.value)}
        placeholder="Search messages and filenames..."
        icon={loading
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Search className="h-4 w-4" />}
        parentClassName="min-w-0 flex-1"
        className="bg-sidebar-accent border-sidebar-border"
        aria-label="Search this conversation"
      />
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
};
