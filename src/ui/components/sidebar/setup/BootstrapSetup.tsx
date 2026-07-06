import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { BootstrapConnectResult } from '../../../../core/types';
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from '../../../constants';
import { useRefreshSetupReadiness } from '../../../hooks/useSetupReadiness';
import { useToast } from '../../ui/use-toast';
import { RadioTower } from 'lucide-react';
import { SetupNodesView } from './SetupNodesView';
import { store, type RootState } from '../../../state/store';
import { applyLiveness, bumpSetupGeneration, mergeConfiguredNodes, setSetupNodes } from '../../../state/slices/setupNodesSlice';

const SECTION = 'bootstrap' as const;

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

export function BootstrapSetup() {
  const { toast } = useToast();
  const refreshSetupReadiness = useRefreshSetupReadiness();
  const dispatch = useDispatch();
  const nodes = useSelector((state: RootState) => state.setupNodes.bootstrap.nodes);
  const loadedOnce = useSelector((state: RootState) => state.setupNodes.bootstrap.loadedOnce);
  const [newAddress, setNewAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(!loadedOnce);
  const [retrying, setRetrying] = useState(false);
  const [reordering, setReordering] = useState(false);
  const reorderInFlightRef = useRef(false);

  const refreshNodeLiveness = async (addresses: string[]) => {
    if (addresses.length === 0) return;

    try {
      const { statuses } = await window.kiyeovoAPI.getNodesLiveness(addresses);
      dispatch(applyLiveness({
        section: SECTION,
        statuses: statuses.map((status) => ({ address: status.address, connected: status.connected })),
      }));
    } catch {
      // Preserve the last-known status when a liveness probe fails.
    }
  };

  const refreshNodes = async () => {
    const requestGeneration = store.getState().setupNodes[SECTION].generation;
    const { nodes: configuredNodes } = unwrapIpcResult(
      await window.kiyeovoAPI.getBootstrapNodes(),
      'Failed to fetch bootstrap nodes',
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
      console.warn('[BootstrapSetup] Poll refresh failed:', refreshError);
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

  const showError = (message: string) => {
    setError(message);
    toast.error(message);
  };

  const handleRetryResult = (result: BootstrapConnectResult | null) => {
    switch (result?.status) {
      case 'connected':
        toast.success(
          `Connected to ${result.connectedCount} bootstrap node${result.connectedCount === 1 ? '' : 's'}`,
        );
        break;
      case 'no_candidates':
        showError('No bootstrap nodes configured');
        break;
      case 'all_failed':
        showError('All configured bootstrap nodes failed');
        break;
      case 'aborted':
        showError('Bootstrap retry was aborted');
        break;
      case 'retry_in_progress':
        toast.info('A reconnection attempt is already running — give it a moment');
        break;
      default:
        toast.success('Bootstrap retry complete');
    }
  };

  const refreshAfterRetry = async () => {
    await refreshNodes();
    await new Promise((resolve) => setTimeout(resolve, 900));

    try {
      await refreshNodes();
    } catch (refreshError) {
      console.warn('[BootstrapSetup] Delayed connectivity refresh failed:', refreshError);
    }
  };

  const handleRetry = async () => {
    setRetrying(true);
    setError(null);

    try {
      const { result } = unwrapIpcResult(
        await window.kiyeovoAPI.retryBootstrap(),
        'Failed to retry bootstrap connection',
      );
      await refreshAfterRetry();
      handleRetryResult(result);
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
      toast.error('That bootstrap server is already in your list');
      return false;
    }

    setError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.addBootstrapNode(normalizedAddress),
        'Failed to add bootstrap node',
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
        await window.kiyeovoAPI.removeBootstrapNode(address),
        'Failed to remove bootstrap node',
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
        await window.kiyeovoAPI.reorderBootstrapNodes(reorderedNodes.map((node) => node.address)),
        'Failed to reorder bootstrap nodes',
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
      icon={RadioTower}
      title="Bootstrap servers"
      description="Bootstrap servers connect you to the network so you can discover people, participate in groups, receive & send offline messages."
      nodesTitle="Configured servers"
      nodeSingular="bootstrap server"
      emptyTitle="No bootstrap servers configured"
      emptyDescription="Add at least one bootstrap server before trying to connect to the network."
      addTitle="Add bootstrap server"
      addDescription="Enter the complete peer multiaddress provided by the person or organization running the server."
      addPlaceholder="/ip4/1.2.3.4/tcp/4001/p2p/12D3Koo..."
      addButtonLabel="Add server"
      retryLabel="Retry connection"
      loadingLabel="Loading bootstrap servers..."
      nodes={entries}
      loading={loading}
      error={error}
      copiedAddress={copiedAddress}
      newAddress={newAddress}
      retrying={retrying}
      reordering={reordering}
      retryDisabled={retrying || loading || nodes.length === 0}
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
