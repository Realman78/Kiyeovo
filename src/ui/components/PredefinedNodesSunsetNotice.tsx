import { useEffect, useState } from 'react';
import { RadioTower } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from './ui/Dialog';
import { Button } from './ui/Button';
import {
  PREDEFINED_NODES_README_URL,
  PREDEFINED_NODES_SUNSET_BODY,
  PREDEFINED_NODES_SUNSET_CTA_LABEL,
  PREDEFINED_NODES_SUNSET_DISMISS_LABEL,
  PREDEFINED_NODES_SUNSET_TITLE,
  hasSavedPredefinedNode,
  isSunsetActive,
  type PredefinedNodeKind,
} from '../../core/predefined-nodes';

type SavedNode = { kind: PredefinedNodeKind | 'turns'; value: string };

/**
 * Gather every node value the user currently has SAVED, across bootstrap,
 * relay, and ICE (STUN/TURN). Uses only existing IPCs. A failure of any single
 * source is non-fatal — we just contribute fewer candidates.
 */
async function collectSavedNodes(): Promise<SavedNode[]> {
  const saved: SavedNode[] = [];

  const [bootstrap, relay, ice] = await Promise.allSettled([
    window.kiyeovoAPI.getBootstrapNodes(),
    window.kiyeovoAPI.getRelayStatus(),
    window.kiyeovoAPI.getIceServers(),
  ]);

  if (bootstrap.status === 'fulfilled' && bootstrap.value.success) {
    for (const node of bootstrap.value.nodes) {
      saved.push({ kind: 'bootstrap', value: node.address });
    }
  }
  if (relay.status === 'fulfilled' && relay.value.success) {
    for (const node of relay.value.nodes) {
      saved.push({ kind: 'relay', value: node.address });
    }
  }
  if (ice.status === 'fulfilled' && ice.value.success) {
    for (const server of ice.value.servers) {
      // server.type is 'stun' | 'turn' | 'turns'; matcher treats 'turns' as 'turn'.
      saved.push({ kind: server.type, value: server.url });
    }
  }

  return saved;
}

/**
 * One-time notice shown after the predefined-nodes sunset, but ONLY when the
 * user still has at least one predefined Kiyeovo node saved. Re-show policy:
 * evaluated once per app start; dismissing (any close) persists a DB flag so it
 * never appears again.
 */
export function PredefinedNodesSunsetNotice() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const evaluate = async () => {
      if (!isSunsetActive(Date.now())) {
        return;
      }

      try {
        const dismissedResult = await window.kiyeovoAPI.getPredefinedNodesSunsetDismissed();
        if (dismissedResult.success && dismissedResult.dismissed) {
          return;
        }

        const saved = await collectSavedNodes();
        if (!cancelled && hasSavedPredefinedNode(saved)) {
          setOpen(true);
        }
      } catch {
        // On any failure, stay silent — the notice is advisory, not critical.
      }
    };

    void evaluate();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistDismissed = () => {
    void window.kiyeovoAPI.setPredefinedNodesSunsetDismissed(true).catch(() => {
      // Best-effort: if persistence fails the notice may reappear next launch.
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      persistDismissed();
    }
  };

  const handleDismiss = () => {
    handleOpenChange(false);
  };

  const handleOpenReadme = () => {
    // window.open is intercepted by the main process' setWindowOpenHandler and
    // routed through the external-URL allowlist to shell.openExternal.
    window.open(PREDEFINED_NODES_README_URL, '_blank', 'noopener');
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RadioTower className="h-5 w-5 text-primary" />
            {PREDEFINED_NODES_SUNSET_TITLE}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">{PREDEFINED_NODES_SUNSET_BODY}</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={handleDismiss}>
            {PREDEFINED_NODES_SUNSET_DISMISS_LABEL}
          </Button>
          <Button onClick={handleOpenReadme}>
            {PREDEFINED_NODES_SUNSET_CTA_LABEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
