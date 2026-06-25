import type { ReactNode } from "react";
import { highlightText } from "./highlightText";
import { CodeBlock } from "../components/chat/messages/CodeBlock";

type Segment =
  | { type: 'text'; value: string }
  | { type: 'inline'; value: string }
  | { type: 'block'; value: string; language?: string };

// Split into language hint + the code.
function parseFencedBody(body: string): { language?: string; code: string } {
  const firstNewline = body.indexOf('\n');
  if (firstNewline === -1) {
    return { code: body };
  }

  const language = body.slice(0, firstNewline).trim() || undefined;
  let code = body.slice(firstNewline + 1);
  if (code.endsWith('\n')) code = code.slice(0, -1);
  return { language, code };
}

// Left-to-right scanner: fenced ``` blocks first, then `inline` spans
function tokenize(content: string): Segment[] {
  const segments: Segment[] = [];
  let textStart = 0;
  let i = 0;

  const flushText = (end: number) => {
    if (end > textStart) {
      segments.push({ type: 'text', value: content.slice(textStart, end) });
    }
  };

  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const close = content.indexOf('```', i + 3);
      if (close !== -1) {
        flushText(i);
        const { language, code } = parseFencedBody(content.slice(i + 3, close));
        segments.push({ type: 'block', value: code, language });
        i = close + 3;
        textStart = i;
        continue;
      }
      // No closing fence — leave as literal text.
      i += 3;
      continue;
    }

    if (content[i] === '`') {
      const close = content.indexOf('`', i + 1);
      if (close !== -1 && close > i + 1) {
        flushText(i);
        segments.push({ type: 'inline', value: content.slice(i + 1, close) });
        i = close + 1;
        textStart = i;
        continue;
      }
      // No closer, or empty `` — render literally.
      i += 1;
      continue;
    }

    i += 1;
  }

  flushText(content.length);
  return segments;
}

export function endsWithCodeBlock(content: string): boolean {
  if (!content.includes('```')) return false;
  const segments = tokenize(content);
  return segments[segments.length - 1]?.type === 'block';
}

export function renderMessageText(content: string, searchQuery: string | undefined): ReactNode {
  if (!content) return content;
  if (!content.includes('`')) return highlightText(content, searchQuery);

  const segments = tokenize(content);
  if (segments.length === 1 && segments[0].type === 'text') {
    return highlightText(content, searchQuery);
  }

  return segments.map((segment, index) => {
    if (segment.type === 'block') {
      return (
        <CodeBlock
          key={index}
          code={segment.value}
          language={segment.language}
          highlighted={highlightText(segment.value, searchQuery)}
        />
      );
    }
    if (segment.type === 'inline') {
      return (
        <code key={index} className="rounded bg-background/15 px-1 py-0.5 font-mono text-[0.85em]">
          {highlightText(segment.value, searchQuery)}
        </code>
      );
    }
    return <span key={index}>{highlightText(segment.value, searchQuery)}</span>;
  });
}
