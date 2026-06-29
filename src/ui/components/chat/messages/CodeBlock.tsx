import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

const MAX_LANGUAGE_LABEL_LENGTH = 10;

type CodeBlockProps = {
  code: string;
  language?: string;
  highlighted: ReactNode;
};

export const CodeBlock = ({ code, language, highlighted }: CodeBlockProps) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const displayLanguage = language && language.length > MAX_LANGUAGE_LABEL_LENGTH
    ? `${language.slice(0, MAX_LANGUAGE_LABEL_LENGTH)}…`
    : language;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch (error) {
      console.error("Failed to copy code block:", error);
    }
  };

  return (
    <div className="my-1 w-fit max-w-full overflow-hidden rounded-md bg-background/15">
      <div className="flex items-center justify-between gap-3 border-b border-foreground/10 px-2 py-1">
        <span className="font-mono text-[0.65rem] uppercase tracking-wide opacity-50" title={language}>
          {displayLanguage || "txt"}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-[0.65rem] opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="block w-full overflow-x-auto whitespace-pre px-2 py-1.5 font-mono text-[0.85em]">
        <code>{highlighted}</code>
      </pre>
    </div>
  );
};
