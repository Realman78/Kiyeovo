import { ArrowRight, Network } from 'lucide-react';
import { Button } from '../../ui/Button';

type InitialSetupBannerProps = {
  onReturn: () => void;
};

export function InitialSetupBanner({
  onReturn,
}: InitialSetupBannerProps) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-4 border-b border-primary/25 bg-primary/10 px-5 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
          <Network className="h-4 w-4" />
        </div>
        <div className="min-w-0 text-left">
          <p className="text-sm font-medium text-foreground">Setup is still in progress</p>
          <p className="truncate text-xs text-muted-foreground">
            Finish connecting Kiyeovo to use messaging reliably.
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onReturn}
        className="shrink-0"
      >
        Return to setup
        <ArrowRight />
      </Button>
    </div>
  );
}
