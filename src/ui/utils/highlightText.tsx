import type { ReactNode } from "react";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function highlightText(text: string, query: string | undefined): ReactNode {
  const trimmed = query?.trim();
  if (!trimmed || !text) return text;

  const regex = new RegExp(`(${escapeRegExp(trimmed)})`, "gi");
  const parts = text.split(regex);
  if (parts.length === 1) return text;

  return parts.map((part, index) =>
    index % 2 === 1
      ? <mark key={index} className="search-text-highlight">{part}</mark>
      : part
  );
}
