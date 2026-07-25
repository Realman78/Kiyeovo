import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from '../../../constants';
import { useRefreshSetupReadiness } from '../../../hooks/useSetupReadiness';
import { useToast } from '../../ui/use-toast';
import { Route } from 'lucide-react';
import { SetupNodesView } from './SetupNodesView';
import { store, type RootState } from '../../../state/store';
import { applyLiveness, bumpSetupGeneration, mergeConfiguredNodes, setSetupNodes } from '../../../state/slices/setupNodesSlice';
import { PREDEFINED_NODES_OFFERING_LABELS, isOfferingActive } from '../../../../core/predefined-nodes';
import { PredefinedNodesOfferingLink } from './PredefinedNodesOfferingLink';
import { getServerEntryWarning } from '../../../lib/server-entry-warnings';

const SECTION = 'relay' as const;

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
  const dispatch = useDispatch();
  const nodes = useSelector((state: RootState) => state.setupNodes.relay.nodes);
  const loadedOnce = useSelector((state: RootState) => state.setupNodes.relay.loadedOnce);
  const bootstrapAddresses = useSelector((state: RootState) => state.setupNodes.bootstrap.nodes.map((node) => node.address));
  const [newAddress, setNewAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(!loadedOnce);
  const [retrying, setRetrying] = useState(false);
  const [reordering, setReordering] = useState(false);
  const reorderInFlightRef = useRef(false);
  const livenessInFlightRef = useRef(false);

  const refreshNodeLiveness = async (addresses: string[]) => {
    if (addresses.length === 0 || livenessInFlightRef.current) return;

    livenessInFlightRef.current = true;
    try {
      const { statuses } = await window.kiyeovoAPI.getNodesLiveness(addresses);
      dispatch(applyLiveness({
        section: SECTION,
        statuses: statuses.map((status) => ({ address: status.address, connected: status.connected })),
      }));
    } catch {
      // Preserve the last-known status when a liveness probe fails.
    } finally {
      livenessInFlightRef.current = false;
    }
  };

  const refreshNodes = async () => {
    const requestGeneration = store.getState().setupNodes[SECTION].generation;
    const { nodes: configuredNodes } = unwrapIpcResult(
      await window.kiyeovoAPI.getRelayStatus(),
      'Failed to fetch relay nodes',
    );

    dispatch(mergeConfiguredNodes({
      section: SECTION,
      configured: configuredNodes.map((node) => ({ address: node.address, connected: node.connected })),
      requestGeneration,
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

  useEffect(() => {
    // One-time (non-polling) peek at the bootstrap list so cross-list-duplicate
    // warnings are correct even if this page is opened before Bootstrap Setup
    // has been visited this session — the whole point of the check is catching
    // an address that's already saved in the OTHER list.
    const requestGeneration = store.getState().setupNodes.bootstrap.generation;
    window.kiyeovoAPI.getBootstrapNodes()
      .then((result) => {
        if (!result.success) return;
        dispatch(mergeConfiguredNodes({
          section: 'bootstrap',
          configured: result.nodes.map((node) => ({ address: node.address, connected: node.connected })),
          requestGeneration,
        }));
      })
      .catch(() => {
        // Best-effort only; the warning just has no bootstrap data to compare against yet.
      });
  }, [dispatch]);

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
        showError('Could not connect to any relay server');
      } else {
        toast.success(
          `Connected to ${result.connected} of ${result.attempted} relay server${result.attempted === 1 ? '' : 's'}`,
        );
      }
    } catch (retryError) {
      showError(getUnexpectedErrorMessage(retryError));
    } finally {
      setRetrying(false);
    }
  };

  const handleAdd = async (): Promise<boolean> => {
    const normalizedAddress = newAddress.trim();
    if (!normalizedAddress) return false;

    if (nodes.some((node) => node.address === normalizedAddress)) {
      toast.error('That relay server is already in your list');
      return false;
    }

    setError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.addRelayNode(normalizedAddress),
        'Failed to add relay node',
      );
      dispatch(bumpSetupGeneration({ section: SECTION }));
      await refreshNodes();
      setNewAddress('');
      void refreshSetupReadiness();
      return true;
    } catch (addError) {
      toast.error(getUnexpectedErrorMessage(addError));
      return false;
    }
  };

  const handleRemove = async (address: string) => {
    setError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.removeRelayNode(address),
        'Failed to remove relay node',
      );
      dispatch(bumpSetupGeneration({ section: SECTION }));
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
    dispatch(setSetupNodes({ section: SECTION, nodes: reorderedNodes }));
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

  const entries = nodes.map((node) => ({
    key: node.address,
    address: node.address,
    connected: node.connected,
  }));

  return (
    <SetupNodesView
      icon={Route}
      title="Relay servers"
      description="Relay servers help your messages reach people when a direct peer-to-peer connection isn't available."
      belowDescription={isOfferingActive(Date.now()) ? (
        // Relay setup only exists in fast mode, so no external-link confirmation needed.
        <PredefinedNodesOfferingLink label={PREDEFINED_NODES_OFFERING_LABELS.relay} />
      ) : undefined}
      nodesTitle="Configured servers"
      nodeSingular="relay server"
      emptyTitle="No relay servers configured"
      emptyDescription="Add a relay server to improve message delivery when direct connections fail."
      addTitle="Add relay server"
      addDescription="Enter the complete peer multiaddress provided by the person or organization running the relay."
      addPlaceholder="/ip4/1.2.3.4/tcp/4002/p2p/12D3Koo..."
      addButtonLabel="Add server"
      retryLabel="Retry connection"
      loadingLabel="Loading relay servers..."
      nodes={entries}
      loading={loading}
      error={error}
      copiedAddress={copiedAddress}
      newAddress={newAddress}
      retrying={retrying}
      reordering={reordering}
      retryDisabled={retrying || loading || nodes.length === 0}
      getEntryWarning={(address) => getServerEntryWarning(address, 'relay', { bootstrap: bootstrapAddresses })}
      onNewAddressChange={setNewAddress}
      onAdd={handleAdd}
      onRetry={handleRetry}
      onCopy={handleCopy}
      onRemove={handleRemove}
      onMoveUp={(index) => handleMove(index, 'up')}
      onMoveDown={(index) => handleMove(index, 'down')}
    />
  );
}
