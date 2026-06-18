import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from '../../../constants';
import { useRefreshSetupReadiness } from '../../../hooks/useSetupReadiness';
import { useToast } from '../../ui/use-toast';
import { ConnectionNodesTab } from '../header/ConnectionNodesTab';

type RelayNode = {
  address: string;
  connected: boolean | null;
};

function getUnexpectedErrorMessage(error: unknown): string {
  return errStr(error, UNEXPECTED_ERROR);
}

function unwrapIpcResult<T extends { success: boolean; error: string | null }>(
  result: T,
  fallbackMessage: string,
): Omit<T, 'success' | 'error'> {
  if (!result.success) {
    throw new Error(result.error || fallbackMessage);
  }

  const payload = { ...result };
  Reflect.deleteProperty(payload, 'success');
  Reflect.deleteProperty(payload, 'error');
  return payload;
}

export function RelaySetup() {
  const { toast } = useToast();
  const refreshSetupReadiness = useRefreshSetupReadiness();
  const [nodes, setNodes] = useState<RelayNode[]>([]);
  const [newAddress, setNewAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [reordering, setReordering] = useState(false);
  const reorderInFlightRef = useRef(false);

  const refreshNodeLiveness = async (addresses: string[]) => {
    if (addresses.length === 0) return;

    try {
      const { statuses } = await window.kiyeovoAPI.getNodesLiveness(addresses);
      const statusByAddress = new Map(statuses.map((status) => [status.address, status.connected]));
      setNodes((current) => current.map((node) => (
        statusByAddress.has(node.address)
          ? { ...node, connected: statusByAddress.get(node.address)! }
          : node
      )));
    } catch {
      // Preserve the last-known status when a liveness probe fails.
    }
  };

  const refreshNodes = async () => {
    const { nodes: configuredNodes } = unwrapIpcResult(
      await window.kiyeovoAPI.getRelayStatus(),
      'Failed to fetch relay nodes',
    );

    setNodes((current) => configuredNodes.map((node) => {
      const existing = current.find((entry) => entry.address === node.address);
      return {
        address: node.address,
        connected: existing ? existing.connected : node.connected,
      };
    }));
    void refreshNodeLiveness(configuredNodes.map((node) => node.address));
  };

  const refreshNodesFromEffect = useEffectEvent(refreshNodes);
  const pollNodes = useEffectEvent(() => {
    if (retrying || reorderInFlightRef.current) return;
    void refreshNodes().catch((refreshError) => {
      console.warn('[RelaySetup] Poll refresh failed:', refreshError);
    });
  });

  useEffect(() => {
    const loadNodes = async () => {
      setLoading(true);
      setError(null);

      try {
        await refreshNodesFromEffect();
      } catch (loadError) {
        setError(getUnexpectedErrorMessage(loadError));
      } finally {
        setLoading(false);
      }
    };

    void loadNodes();

    const timerId = setInterval(() => {
      pollNodes();
    }, 3000);

    return () => {
      clearInterval(timerId);
    };
  }, []);

  const showError = (message: string) => {
    setError(message);
    toast.error(message);
  };

  const refreshAfterRetry = async () => {
    await refreshNodes();
    await new Promise((resolve) => setTimeout(resolve, 900));

    try {
      await refreshNodes();
    } catch (refreshError) {
      console.warn('[RelaySetup] Delayed connectivity refresh failed:', refreshError);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    setError(null);

    try {
      const result = unwrapIpcResult(
        await window.kiyeovoAPI.retryRelays(),
        'Failed to retry relay reservations',
      );
      await refreshAfterRetry();
      if (result.connected === 0) {
        showError('All relay reservations failed');
      } else {
        toast.success(`Relay retry complete (${result.connected}/${result.attempted})`);
      }
    } catch (retryError) {
      showError(getUnexpectedErrorMessage(retryError));
    } finally {
      setRetrying(false);
    }
  };

  const handleAdd = async () => {
    const normalizedAddress = newAddress.trim();
    if (!normalizedAddress) return;

    if (nodes.some((node) => node.address === normalizedAddress)) {
      setError('Relay node already exists');
      return;
    }

    setError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.addRelayNode(normalizedAddress),
        'Failed to add relay node',
      );
      await refreshNodes();
      setNewAddress('');
      void refreshSetupReadiness();
    } catch (addError) {
      showError(getUnexpectedErrorMessage(addError));
    }
  };

  const handleRemove = async (address: string) => {
    setError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.removeRelayNode(address),
        'Failed to remove relay node',
      );
      await refreshNodes();
      void refreshSetupReadiness();
    } catch (removeError) {
      showError(getUnexpectedErrorMessage(removeError));
    }
  };

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    if (reorderInFlightRef.current) return;

    const reorderedNodes = [...nodes];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= reorderedNodes.length) return;

    [reorderedNodes[index]!, reorderedNodes[swapIndex]!] = [
      reorderedNodes[swapIndex]!,
      reorderedNodes[index]!,
    ];
    setNodes(reorderedNodes);
    setError(null);
    reorderInFlightRef.current = true;
    setReordering(true);

    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.reorderRelayNodes(reorderedNodes.map((node) => node.address)),
        'Failed to reorder relay nodes',
      );
    } catch (reorderError) {
      showError(getUnexpectedErrorMessage(reorderError));
      await refreshNodes();
    } finally {
      reorderInFlightRef.current = false;
      setReordering(false);
    }
  };

  const handleCopy = (address: string) => {
    setCopiedAddress(address);
    void navigator.clipboard.writeText(address);
    setTimeout(() => {
      setCopiedAddress((current) => (current === address ? null : current));
    }, 2000);
  };

  const connectedCount = nodes.filter((node) => node.connected).length;
  const entries = nodes.map((node) => ({
    key: node.address,
    address: node.address,
    connected: node.connected,
  }));

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <header>
          <h1 className="text-2xl font-semibold text-foreground">Relay servers</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Relay servers help messages reach people when a direct peer-to-peer connection is unavailable.
          </p>
        </header>

        <div className="mt-8 space-y-6 rounded-lg border border-border bg-card p-6">
          <ConnectionNodesTab
            sectionLabel="Relay Nodes"
            addLabel="Add Relay Node"
            addPlaceholder="/ip4/1.2.3.4/tcp/4002/p2p/12D3Koo..."
            retryLabel="Retry Relay Reservations"
            loadingLabel="Loading relay nodes..."
            emptyLabel="No relay nodes configured"
            nodes={entries}
            loading={loading}
            error={error}
            copiedAddress={copiedAddress}
            newAddress={newAddress}
            retrying={retrying}
            retryDisabled={retrying || loading || nodes.length === 0}
            onNewAddressChange={setNewAddress}
            onAdd={handleAdd}
            onRetry={handleRetry}
            onCopy={handleCopy}
            onRemove={handleRemove}
            onMoveUp={(index) => handleMove(index, 'up')}
            onMoveDown={(index) => handleMove(index, 'down')}
            moveDisabled={reordering}
            nodeListClassName="max-h-[calc(100vh-25rem)]"
          />

          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">Relay Nodes Connected</span>
              <span className="text-foreground">{connectedCount}/{nodes.length}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
