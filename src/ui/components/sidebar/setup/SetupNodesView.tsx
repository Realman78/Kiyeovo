import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Dot,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

export type SetupNodeEntry = {
  key: string;
  address: string;
  connected: boolean | null;
};

type SetupNodesViewProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  nodesTitle: string;
  nodeSingular: string;
  emptyTitle: string;
  emptyDescription: string;
  addTitle: string;
  addDescription: string;
  addPlaceholder: string;
  addButtonLabel: string;
  retryLabel: string;
  loadingLabel: string;
  nodes: SetupNodeEntry[];
  loading: boolean;
  error: string | null;
  copiedAddress: string | null;
  newAddress: string;
  retrying: boolean;
  reordering?: boolean;
  addDisabled?: boolean;
  retryDisabled?: boolean;
  onNewAddressChange: (value: string) => void;
  onAdd: () => Promise<boolean>;
  onRetry: () => void;
  onCopy: (address: string) => void;
  onRemove: (address: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
};

type AddressSummary = {
  primary: string;
  peerId: string | null;
  isRaw: boolean;
};

// Turn a raw multiaddr into a human-readable host:port plus a short peer id.
// Falls back to showing the full address when it cannot be parsed.
function summarizeAddress(address: string): AddressSummary {
  const segments = address.split('/').filter((segment) => segment.length > 0);
  let host: string | null = null;
  let port: string | null = null;
  let peerId: string | null = null;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const proto = segments[i];
    const value = segments[i + 1];
    if (!host && (proto === 'ip4' || proto === 'ip6' || proto === 'dns' || proto === 'dns4' || proto === 'dns6' || proto === 'dnsaddr')) {
      host = value;
    } else if (!port && (proto === 'tcp' || proto === 'udp')) {
      port = value;
    } else if (proto === 'p2p' || proto === 'ipfs') {
      peerId = value;
    }
  }

  const shortPeerId = peerId && peerId.length > 16
    ? `${peerId.slice(0, 8)}…${peerId.slice(-8)}`
    : peerId;

  if (host) {
    return { primary: port ? `${host}:${port}` : host, peerId: shortPeerId, isRaw: false };
  }
  return { primary: address, peerId: null, isRaw: true };
}

type StatusTone = 'success' | 'destructive' | 'warning' | 'muted';

const STATUS_DOT: Record<StatusTone, string> = {
  success: 'bg-success',
  destructive: 'bg-destructive',
  warning: 'bg-warning',
  muted: 'bg-muted-foreground',
};

export function SetupNodesView({
  icon: Icon,
  title,
  description,
  nodesTitle,
  nodeSingular,
  emptyTitle,
  emptyDescription,
  addTitle,
  addDescription,
  addPlaceholder,
  addButtonLabel,
  retryLabel,
  loadingLabel,
  nodes,
  loading,
  error,
  copiedAddress,
  newAddress,
  retrying,
  reordering = false,
  addDisabled = false,
  retryDisabled = false,
  onNewAddressChange,
  onAdd,
  onRetry,
  onCopy,
  onRemove,
  onMoveUp,
  onMoveDown,
}: SetupNodesViewProps) {
  const total = nodes.length;
  const connectedCount = nodes.filter((node) => node.connected === true).length;
  const checking = nodes.some((node) => node.connected === null);
  const plural = total === 1 ? '' : 's';

  let status: { tone: StatusTone; title: string; detail: string };
  if (loading) {
    status = { tone: 'muted', title: 'Checking…', detail: '' };
  } else if (total === 0) {
    status = { tone: 'warning', title: 'No servers configured', detail: `Add a ${nodeSingular} below to get started.` };
  } else if (checking && connectedCount === 0) {
    status = { tone: 'muted', title: 'Checking reachability…', detail: `${total} server${plural} configured` };
  } else if (connectedCount > 0) {
    status = { tone: 'success', title: 'Connected', detail: `Reachable through ${connectedCount} of ${total} server${plural}` };
  } else {
    status = { tone: 'destructive', title: 'Not reachable', detail: `${total} server${plural} configured, none reachable` };
  }

  const [isAdding, setIsAdding] = useState(false);

  const handleCancelAdd = () => {
    setIsAdding(false);
    onNewAddressChange('');
  };

  const handleSaveAdd = async () => {
    if (await onAdd()) {
      setIsAdding(false);
    }
  };

  return (
    <div className="h-full py-8 overflow-y-auto bg-sidebar-accent">
      <div className="mx-auto w-full max-w-5xl px-8 py-10 lg:py-12">
        <header className="flex items-start flex-col gap-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Icon className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          </div>
          <p className="mt-0.5 text-md text-muted-foreground text-left">{description}</p>
        </header>

        {!!error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <section className="mt-8" aria-labelledby="configured-nodes-title">
          <div className="flex items-baseline justify-between gap-4">
            <h2
              id="configured-nodes-title"
              className="text-[11px] font-mono font-medium uppercase tracking-widest text-muted-foreground"
            >
              {nodesTitle}
            </h2>
            {!loading && total > 1 && (
              <span className="shrink-0 text-[11px] font-mono text-muted-foreground">tried in order</span>
            )}
          </div>

          <div className="mt-3 divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card/40">
            {loading ? (
              <div className="flex min-h-24 items-center justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-sm">{loadingLabel}</span>
              </div>
            ) : (
              <>
                {total === 0 && !isAdding && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
                    <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                      {emptyDescription}
                    </p>
                  </div>
                )}

                {nodes.map((node, index) => {
                  const summary = summarizeAddress(node.address);
                  const statusLabel = node.connected === null
                    ? 'Checking'
                    : node.connected
                      ? 'Reachable'
                      : 'Unavailable';
                  const dotClass = node.connected === null
                    ? 'bg-muted-foreground/50'
                    : node.connected
                      ? 'bg-success'
                      : 'bg-destructive';

                  return (
                    <div key={node.key} className="group flex items-center gap-3 px-4 py-3">
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {node.connected === null ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Checking connectivity" />
                        ) : (
                          <span className={`h-2 w-2 rounded-full ${dotClass}`} role="img" aria-label={statusLabel} title={statusLabel} />
                        )}
                      </span>

                      <div className="min-w-0 flex-1 flex flex-col items-start">
                        <div className={`truncate text-sm ${summary.isRaw ? 'font-mono' : 'font-medium'} text-foreground`}>
                          {summary.primary}
                        </div>
                        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={node.address}>
                          <span className="lg:hidden">{summary.peerId ?? node.address}</span>
                          <span className="hidden lg:inline">{node.address}</span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {total > 1 && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => onMoveUp(index)}
                              disabled={reordering || index === 0}
                              className="h-8 w-8"
                              aria-label={`Move ${nodeSingular} up`}
                            >
                              <ChevronUp />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => onMoveDown(index)}
                              disabled={reordering || index === total - 1}
                              className="h-8 w-8"
                              aria-label={`Move ${nodeSingular} down`}
                            >
                              <ChevronDown />
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onCopy(node.address)}
                          className="h-8 w-8"
                          aria-label={`Copy ${nodeSingular} address`}
                        >
                          {copiedAddress === node.address ? <Check className="text-success" /> : <Copy />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onRemove(node.address)}
                          className="h-8 w-8 hover:text-destructive"
                          aria-label={`Remove ${nodeSingular}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  );
                })}

                {isAdding ? (
                  <div className="space-y-3 px-4 py-3">
                    <p className="text-xs leading-5 text-muted-foreground">{addDescription}</p>
                    <Input
                      autoFocus
                      placeholder={addPlaceholder}
                      value={newAddress}
                      onChange={(event) => onNewAddressChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void handleSaveAdd();
                        if (event.key === 'Escape') handleCancelAdd();
                      }}
                      parentClassName="w-full"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={handleCancelAdd}>
                        <X />
                        Cancel
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => void handleSaveAdd()}
                        disabled={addDisabled || !newAddress.trim()}
                      >
                        <Plus />
                        {addButtonLabel}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsAdding(true)}
                    className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    {addTitle}
                  </button>
                )}
              </>
            )}
          </div>

          {!loading && total > 0 && (
            <div className="mt-4 w-full flex justify-end">
              <div className="flex flex-row flex-wrap gap-5 px-1 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.75 w-1.75 rounded-full bg-success" aria-hidden />
                  Reachable
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.75 w-1.75 rounded-full bg-destructive" aria-hidden />
                  Unavailable
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.75 w-1.75 rounded-full bg-muted-foreground/50" aria-hidden />
                  Checking
                </span>
              </div>
            </div>
          )}
        </section>

        <section
          className="mt-4 flex items-center justify-between gap-4 border-t-2 border-x-0 border-border/70 py-4"
          aria-label={`${title} status`}
        >
          <div className="flex items-center gap-3">
            {status.tone === 'muted' && (loading || checking) ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : (
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status.tone]}`} aria-hidden />
            )}
            <div>
              <div className="text-sm font-medium text-foreground flex items-center">
                {status.title} {status.detail && (
                <span className="mt-0.5 flex items-center text-xs text-muted-foreground"> <Dot /> {status.detail}</span>
              )}</div>

            </div>
          </div>

          <Button variant="outline" size="sm" onClick={onRetry} disabled={retryDisabled} className="shrink-0">
            {retrying ? (
              <>
                <Loader2 className="animate-spin" />
                Retrying…
              </>
            ) : (
              <>
                <RefreshCw />
                {retryLabel}
              </>
            )}
          </Button>
        </section>
      </div>
    </div>
  );
}
