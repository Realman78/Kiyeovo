import { useEffect, useState } from 'react';
import { Monitor, PanelTop, ScreenShare } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog';
import { Button } from '../ui/Button';
import type { ScreenShareSource, ScreenShareSourceRequest } from '../../../shared/kiyeovo-api';

export function ScreenShareSourcePicker() {
  const [request, setRequest] = useState<ScreenShareSourceRequest | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const unsubscribe = window.kiyeovoAPI.onScreenShareSourceRequest((nextRequest) => {
      setRequest(nextRequest);
      setSelectedSourceId(nextRequest.sources[0]?.id ?? null);
      setIsSubmitting(false);
    });

    return unsubscribe;
  }, []);

  const respond = async (sourceId: string | null) => {
    if (!request || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await window.kiyeovoAPI.selectScreenShareSource(request.requestId, sourceId);
    } finally {
      setRequest(null);
      setSelectedSourceId(null);
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      void respond(null);
    }
  };

  const selectedSource = request?.sources.find((source) => source.id === selectedSourceId) ?? null;

  return (
    <Dialog open={!!request} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScreenShare className="h-5 w-5 text-primary" />
            Share Screen
          </DialogTitle>
          <DialogDescription>
            Choose exactly what Kiyeovo may share with this call.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="grid max-h-[55vh] grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
            {request?.sources.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                selected={source.id === selectedSourceId}
                onSelect={() => setSelectedSourceId(source.id)}
              />
            ))}
          </div>

          {request?.sources.length === 0 && (
            <div className="rounded-lg border border-border bg-muted/20 p-6 text-sm text-muted-foreground">
              No screens or windows are available to share.
            </div>
          )}
        </DialogBody>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void respond(null)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void respond(selectedSourceId)}
            disabled={!selectedSource || isSubmitting}
          >
            Share Selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({
  source,
  selected,
  onSelect,
}: {
  source: ScreenShareSource;
  selected: boolean;
  onSelect: () => void;
}) {
  const Icon = source.sourceType === 'screen' ? Monitor : PanelTop;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'group overflow-hidden rounded-lg border bg-card text-left transition',
        selected
          ? 'border-primary shadow-[0_0_0_1px_hsl(var(--primary))]'
          : 'border-border hover:border-primary/60 hover:bg-primary/5',
      ].join(' ')}
    >
      <div className="aspect-video bg-muted/30">
        {source.thumbnailDataUrl ? (
          <img
            src={source.thumbnailDataUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Icon className="h-8 w-8" />
          </div>
        )}
      </div>
      <div className="flex items-start gap-2 p-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{source.name}</div>
          <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
            {source.sourceType}
          </div>
        </div>
      </div>
    </button>
  );
}
