import { Pin, X } from "lucide-react";
import type { PinnedMessagePreview } from "../../../../core/db/database";

type PinnedMessageBarProps = {
  preview: PinnedMessagePreview;
  myPeerId: string | null | undefined;
  onJump: () => void;
  onUnpin: () => void;
};

// One-line summary of the pinned message for the bar.
function pinnedExcerpt(preview: PinnedMessagePreview): string {
  if (preview.messageType === 'file' || preview.messageType === 'image') {
    return preview.fileName || (preview.messageType === 'image' ? 'Photo' : 'File');
  }
  return preview.content;
}

export const PinnedMessageBar = ({ preview, myPeerId, onJump, onUnpin }: PinnedMessageBarProps) => {
  const senderLabel = preview.senderPeerId === myPeerId
    ? 'You'
    : (preview.senderUsername || `user_${preview.senderPeerId.slice(-8)}`);
  return (
    <div className="mx-6 mb-1 mt-2 flex items-stretch gap-2 rounded-md border border-border bg-muted/40">
      <button
        type="button"
        onClick={onJump}
        className="flex cursor-pointer min-w-0 flex-1 items-center gap-2 rounded-l-md border-l-2 border-primary/60 px-3 py-1.5 text-left transition-colors hover:bg-muted/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title="Jump to pinned message"
      >
        <Pin className="h-3.5 w-3.5 shrink-0 fill-current text-primary" aria-hidden="true" />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[11px] font-medium text-primary">Pinned message</span>
          <span className="truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">{senderLabel}:</span>{' '}
            {pinnedExcerpt(preview)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onUnpin}
        className="flex shrink-0 items-center justify-center rounded-r-md px-2 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label="Unpin message"
        title="Unpin"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};
