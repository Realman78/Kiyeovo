import { useState, useEffect, useRef } from "react";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/Dialog";
import { useToast } from "../../ui/use-toast";
import type { BootstrapConnectResult, IceServerConfig, IceServerType, NetworkMode } from "../../../../core/types";
import { ConnectionNodesTab } from "./ConnectionNodesTab";
import { IceServersTab } from "./IceServersTab";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";

interface BootstrapNode {
  id: string;
  address: string;
  connected: boolean;
}

interface RelayNode {
  address: string;
  connected: boolean;
}

type IceServerDraft = {
  id: string | null;
  type: IceServerType;
  url: string;
  username: string;
  credential: string;
};

interface ConnectionStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isConnected: boolean | null;
}

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

  const { success: _success, error: _error, ...payload } = result;
  return payload;
}

const EMPTY_ICE_SERVER_DRAFT: IceServerDraft = {
  id: null,
  type: 'stun',
  url: '',
  username: '',
  credential: '',
};

const ConnectionStatusDialog = ({
  open,
  onOpenChange,
  isConnected,
}: ConnectionStatusDialogProps) => {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'bootstrap' | 'relays' | 'ice'>('bootstrap');
  const [networkMode, setNetworkMode] = useState<NetworkMode>('fast');

  const [bootstrapNodes, setBootstrapNodes] = useState<BootstrapNode[]>([]);
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>([]);
  const [iceServers, setIceServers] = useState<IceServerConfig[]>([]);

  const [newBootstrapAddress, setNewBootstrapAddress] = useState("");
  const [newRelayAddress, setNewRelayAddress] = useState("");
  const [iceServerDraft, setIceServerDraft] = useState<IceServerDraft>(EMPTY_ICE_SERVER_DRAFT);

  const [isLoadingBootstrapNodes, setIsLoadingBootstrapNodes] = useState(true);
  const [isLoadingRelayNodes, setIsLoadingRelayNodes] = useState(true);
  const [isLoadingIceServers, setIsLoadingIceServers] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [iceError, setIceError] = useState<string | null>(null);
  const [isRetryingBootstrap, setIsRetryingBootstrap] = useState(false);
  const [isRetryingRelays, setIsRetryingRelays] = useState(false);
  const [isReorderingBootstrapNodes, setIsReorderingBootstrapNodes] = useState(false);
  const [isReorderingRelayNodes, setIsReorderingRelayNodes] = useState(false);
  const [isSavingIceServers, setIsSavingIceServers] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const bootstrapReorderInFlightRef = useRef(false);
  const relayReorderInFlightRef = useRef(false);

  const refreshBootstrapNodes = async () => {
    const { nodes } = unwrapIpcResult(
      await window.kiyeovoAPI.getBootstrapNodes(),
      'Failed to fetch bootstrap nodes',
    );
    const fetchedNodes: BootstrapNode[] = nodes.map((node, index) => ({
      id: `${index}`,
      address: node.address,
      connected: node.connected,
    }));
    setBootstrapNodes(fetchedNodes);
  };

  const refreshRelayNodes = async () => {
    const { nodes } = unwrapIpcResult(
      await window.kiyeovoAPI.getRelayStatus(),
      'Failed to fetch relay nodes',
    );
    setRelayNodes(nodes);
  };

  const refreshIceServers = async () => {
    const { servers } = unwrapIpcResult(
      await window.kiyeovoAPI.getIceServers(),
      'Failed to fetch ICE servers',
    );
    setIceServers(servers);
  };

  const resetIceServerDraft = () => {
    setIceServerDraft(EMPTY_ICE_SERVER_DRAFT);
  };

  const persistIceServers = async (servers: IceServerConfig[]) => {
    unwrapIpcResult(
      await window.kiyeovoAPI.setIceServers(servers),
      'Failed to save ICE servers',
    );
    await refreshIceServers();
  };

  const refreshConnectionSnapshot = async (modeOverride?: NetworkMode) => {
    const modeToUse = modeOverride ?? networkMode;
    await refreshBootstrapNodes();
    if (modeToUse === 'fast') {
      await refreshRelayNodes();
    } else {
      setRelayNodes([]);
    }
  };

  const refreshConnectionSnapshotAfterRetry = async (modeOverride?: NetworkMode) => {
    const modeToUse = modeOverride ?? networkMode;
    await refreshConnectionSnapshot(modeToUse);
    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      await refreshConnectionSnapshot(modeToUse);
    } catch (error) {
      console.warn('[ConnectionStatusDialog] Delayed connectivity refresh failed:', error);
    }
  };

  useEffect(() => {
    if (!open) return;

    const fetchDialogData = async () => {
      setIsLoadingBootstrapNodes(true);
      setIsLoadingRelayNodes(true);
      setIsLoadingIceServers(true);
      setBootstrapError(null);
      setRelayError(null);
      setIceError(null);

      try {
        const modeResult = await window.kiyeovoAPI.getNetworkMode();
        if (!modeResult.success) {
          throw new Error(modeResult.error || 'Failed to fetch network mode');
        }
        setNetworkMode(modeResult.mode);

        await refreshConnectionSnapshot(modeResult.mode);
        await refreshIceServers();
      } catch (error) {
        const message = getUnexpectedErrorMessage(error);
        setBootstrapError(message);
        setRelayError(message);
        setIceError(message);
      } finally {
        setIsLoadingBootstrapNodes(false);
        setIsLoadingRelayNodes(false);
        setIsLoadingIceServers(false);
      }
    };

    void fetchDialogData();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timerId = setInterval(() => {
      if (isRetryingBootstrap || isRetryingRelays) return;
      void (async () => {
        try {
          await refreshConnectionSnapshot();
        } catch (error) {
          console.warn('[ConnectionStatusDialog] Poll refresh failed:', error);
        }
      })();
    }, 3000);

    return () => {
      clearInterval(timerId);
    };
  }, [open, networkMode, isRetryingBootstrap, isRetryingRelays]);

  useEffect(() => {
    if (networkMode !== 'fast' && activeTab !== 'bootstrap') {
      setActiveTab('bootstrap');
    }
  }, [networkMode, activeTab]);

  useEffect(() => {
    if (open) return;
    setActiveTab('bootstrap');
    resetIceServerDraft();
    setIceError(null);
  }, [open]);

  const showBootstrapError = (message: string) => {
    setBootstrapError(message);
    toast.error(message);
  };

  const showRelayError = (message: string) => {
    setRelayError(message);
    toast.error(message);
  };

  const showIceError = (message: string) => {
    setIceError(message);
    toast.error(message);
  };

  const handleBootstrapRetryResult = (result: BootstrapConnectResult | null) => {
    switch (result?.status) {
      case 'connected':
        toast.success(
          `Connected to ${result.connectedCount} bootstrap node${result.connectedCount === 1 ? '' : 's'}`
        );
        break;
      case 'no_candidates':
        showBootstrapError('No bootstrap nodes configured');
        break;
      case 'all_failed':
        showBootstrapError('All configured bootstrap nodes failed');
        break;
      case 'aborted':
        showBootstrapError('Bootstrap retry was aborted');
        break;
      default:
        toast.success('Bootstrap retry complete');
    }
  };

  const handleRetryBootstrap = async () => {
    setIsRetryingBootstrap(true);
    setBootstrapError(null);

    try {
      const { result } = unwrapIpcResult(
        await window.kiyeovoAPI.retryBootstrap(),
        'Failed to retry bootstrap connection',
      );
      await refreshConnectionSnapshotAfterRetry(networkMode);
      handleBootstrapRetryResult(result);
    } catch (error) {
      const message = getUnexpectedErrorMessage(error);
      showBootstrapError(message);
    } finally {
      setIsRetryingBootstrap(false);
    }
  };

  const handleRetryRelays = async () => {
    setIsRetryingRelays(true);
    setRelayError(null);

    try {
      const result = unwrapIpcResult(
        await window.kiyeovoAPI.retryRelays(),
        'Failed to retry relay reservations',
      );
      await refreshConnectionSnapshotAfterRetry(networkMode);
      toast.success(`Relay retry complete (${result.connected}/${result.attempted})`);
    } catch (error) {
      const message = getUnexpectedErrorMessage(error);
      showRelayError(message);
    } finally {
      setIsRetryingRelays(false);
    }
  };

  const handleAddBootstrapNode = async () => {
    const normalizedAddress = newBootstrapAddress.trim();
    if (!normalizedAddress) return;

    if (bootstrapNodes.some(node => node.address === normalizedAddress)) {
      setBootstrapError('Bootstrap node already exists');
      return;
    }

    setBootstrapError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.addBootstrapNode(normalizedAddress),
        'Failed to add bootstrap node',
      );
      await refreshBootstrapNodes();
      setNewBootstrapAddress("");
    } catch (error) {
      setBootstrapError(getUnexpectedErrorMessage(error));
    }
  };

  const handleAddRelayNode = async () => {
    const normalizedAddress = newRelayAddress.trim();
    if (!normalizedAddress) return;

    if (relayNodes.some(node => node.address === normalizedAddress)) {
      setRelayError('Relay node already exists');
      return;
    }

    setRelayError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.addRelayNode(normalizedAddress),
        'Failed to add relay node',
      );
      await refreshRelayNodes();
      setNewRelayAddress("");
    } catch (error) {
      const message = getUnexpectedErrorMessage(error);
      showRelayError(message);
    }
  };

  const handleRemoveBootstrapNode = async (address: string) => {
    setBootstrapError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.removeBootstrapNode(address),
        'Failed to remove bootstrap node',
      );
      await refreshBootstrapNodes();
    } catch (error) {
      setBootstrapError(getUnexpectedErrorMessage(error));
    }
  };

  const handleRemoveRelayNode = async (address: string) => {
    setRelayError(null);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.removeRelayNode(address),
        'Failed to remove relay node',
      );
      await refreshRelayNodes();
    } catch (error) {
      const message = getUnexpectedErrorMessage(error);
      showRelayError(message);
    }
  };

  const handleMoveBootstrapNode = async (index: number, direction: 'up' | 'down') => {
    if (bootstrapReorderInFlightRef.current) return;
    const newNodes = [...bootstrapNodes];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newNodes.length) return;

    [newNodes[index]!, newNodes[swapIndex]!] = [newNodes[swapIndex]!, newNodes[index]!];
    setBootstrapNodes(newNodes);
    setBootstrapError(null);
    bootstrapReorderInFlightRef.current = true;
    setIsReorderingBootstrapNodes(true);

    try {
      const addresses = newNodes.map((n) => n.address);
      unwrapIpcResult(
        await window.kiyeovoAPI.reorderBootstrapNodes(addresses),
        'Failed to reorder bootstrap nodes',
      );
    } catch (error) {
      setBootstrapError(getUnexpectedErrorMessage(error));
      await refreshBootstrapNodes();
    } finally {
      bootstrapReorderInFlightRef.current = false;
      setIsReorderingBootstrapNodes(false);
    }
  };

  const handleMoveRelayNode = async (index: number, direction: 'up' | 'down') => {
    if (relayReorderInFlightRef.current) return;
    const newNodes = [...relayNodes];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= newNodes.length) return;

    [newNodes[index]!, newNodes[swapIndex]!] = [newNodes[swapIndex]!, newNodes[index]!];
    setRelayNodes(newNodes);
    setRelayError(null);
    relayReorderInFlightRef.current = true;
    setIsReorderingRelayNodes(true);

    try {
      const addresses = newNodes.map((n) => n.address);
      unwrapIpcResult(
        await window.kiyeovoAPI.reorderRelayNodes(addresses),
        'Failed to reorder relay nodes',
      );
    } catch (error) {
      setRelayError(getUnexpectedErrorMessage(error));
      await refreshRelayNodes();
    } finally {
      relayReorderInFlightRef.current = false;
      setIsReorderingRelayNodes(false);
    }
  };

  const handleIceDraftTypeChange = (type: IceServerType) => {
    setIceError(null);
    setIceServerDraft((current) => ({
      ...current,
      type,
      username: type === 'stun' ? '' : current.username,
      credential: type === 'stun' ? '' : current.credential,
    }));
  };

  const buildIceServerFromDraft = (): IceServerConfig => {
    const url = iceServerDraft.url.trim();
    if (!url) {
      throw new Error('ICE server URL is required');
    }

    const expectedPrefix = `${iceServerDraft.type}:`;
    if (!url.toLowerCase().startsWith(expectedPrefix)) {
      throw new Error(`ICE server URL must start with ${expectedPrefix}`);
    }

    if (iceServerDraft.type === 'stun') {
      return {
        id: iceServerDraft.id ?? crypto.randomUUID(),
        type: 'stun',
        url,
      };
    }

    const username = iceServerDraft.username.trim();
    const credential = iceServerDraft.credential.trim();
    if (!username || !credential) {
      throw new Error('TURN servers require username and credential');
    }

    return {
      id: iceServerDraft.id ?? crypto.randomUUID(),
      type: iceServerDraft.type,
      url,
      username,
      credential,
    };
  };

  const handleSaveIceServer = async () => {
    setIsSavingIceServers(true);
    setIceError(null);

    try {
      const nextServer = buildIceServerFromDraft();
      const duplicate = iceServers.find((server) => {
        if (server.id === nextServer.id) return false;
        const sameUrl = server.url.trim().toLowerCase() === nextServer.url.trim().toLowerCase();
        const sameType = server.type === nextServer.type;
        const sameUsername = (server.username ?? '') === (nextServer.username ?? '');
        return sameUrl && sameType && sameUsername;
      });

      if (duplicate) {
        throw new Error('ICE server already exists');
      }

      const nextServers = iceServerDraft.id
        ? iceServers.map((server) => (server.id === nextServer.id ? nextServer : server))
        : [...iceServers, nextServer];

      await persistIceServers(nextServers);
      resetIceServerDraft();
    } catch (error) {
      showIceError(getUnexpectedErrorMessage(error));
    } finally {
      setIsSavingIceServers(false);
    }
  };

  const handleEditIceServer = (server: IceServerConfig) => {
    setIceError(null);
    setIceServerDraft({
      id: server.id,
      type: server.type,
      url: server.url,
      username: server.username ?? '',
      credential: server.credential ?? '',
    });
  };

  const handleRemoveIceServer = async (id: string) => {
    setIsSavingIceServers(true);
    setIceError(null);

    try {
      const nextServers = iceServers.filter((server) => server.id !== id);
      await persistIceServers(nextServers);
      if (iceServerDraft.id === id) {
        resetIceServerDraft();
      }
    } catch (error) {
      showIceError(getUnexpectedErrorMessage(error));
    } finally {
      setIsSavingIceServers(false);
    }
  };

  const handleMoveIceServer = async (index: number, direction: 'up' | 'down') => {
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= iceServers.length) return;

    setIsSavingIceServers(true);
    setIceError(null);

    try {
      const nextServers = [...iceServers];
      [nextServers[index]!, nextServers[swapIndex]!] = [nextServers[swapIndex]!, nextServers[index]!];
      await persistIceServers(nextServers);
    } catch (error) {
      showIceError(getUnexpectedErrorMessage(error));
    } finally {
      setIsSavingIceServers(false);
    }
  };


  const handleCopy = (address: string) => {
    setCopiedAddress(address);
    navigator.clipboard.writeText(address);
    setTimeout(() => {
      setCopiedAddress((current) => (current === address ? null : current));
    }, 2000);
  };

  const bootstrapConnectedCount = bootstrapNodes.filter((node) => node.connected).length;
  const relayConnectedCount = relayNodes.filter((node) => node.connected).length;
  const bootstrapEntries = bootstrapNodes.map((node) => ({
    key: node.id,
    address: node.address,
    connected: node.connected,
  }));
  const relayEntries = relayNodes.map((node) => ({
    key: node.address,
    address: node.address,
    connected: node.connected,
  }));
  const isFastMode = networkMode === 'fast';
  const isRelayTab = activeTab === 'relays' && isFastMode;
  const isIceTab = activeTab === 'ice' && isFastMode;
  const isRetryingAny = isRetryingBootstrap || isRetryingRelays;
  const tabIndex = activeTab === 'bootstrap' ? 0 : activeTab === 'relays' ? 1 : 2;
  const networkStatusClassName = isRetryingAny
    ? 'text-muted-foreground'
    : isConnected === null
      ? 'text-muted-foreground'
      : isConnected
        ? 'text-success'
        : 'text-destructive';
  const networkStatusLabel = isRetryingAny
    ? 'RETRYING'
    : isConnected === null
      ? 'CONNECTING'
      : isConnected
        ? 'ONLINE'
        : 'OFFLINE';

  const headerDescription = isRetryingAny
    ? (isRelayTab ? 'Retrying relay reservations...' : 'Retrying bootstrap connection...')
    : isConnected === null
      ? 'Connecting to the DHT network...'
      : isConnected
        ? 'Connected to the DHT network'
        : 'Not connected to the DHT network';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl!">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isRetryingAny ? (
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            ) : isConnected === null ? (
              <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
            ) : isConnected ? (
              <Wifi className="w-5 h-5 text-success" />
            ) : (
              <WifiOff className="w-5 h-5 text-destructive" />
            )}
            DHT Network Status
          </DialogTitle>
          <DialogDescription>{headerDescription}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {isFastMode ? (
            <div className="relative grid grid-cols-3 border-b border-border">
              <div
                className="absolute bottom-0 h-[2px] w-1/3 bg-primary transition-transform duration-200 ease-in-out"
                style={{ transform: `translateX(${tabIndex * 100}%)` }}
              />
              <button
                type="button"
                onClick={() => setActiveTab('bootstrap')}
                className={`cursor-pointer px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'bootstrap' ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Bootstrap
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('relays')}
                className={`px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'relays'
                    ? 'text-primary cursor-pointer'
                    : 'text-muted-foreground hover:text-foreground cursor-pointer'
                }`}
              >
                Relays
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('ice')}
                className={`px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'ice'
                    ? 'text-primary cursor-pointer'
                    : 'text-muted-foreground hover:text-foreground cursor-pointer'
                }`}
              >
                Calls
              </button>
            </div>
          ) : null}

          {!isRelayTab && !isIceTab ? (
            <ConnectionNodesTab
              sectionLabel="Bootstrap Nodes"
              addLabel="Add Bootstrap Node"
              addPlaceholder="Peer address"
              retryLabel="Retry Bootstrap Connection"
              loadingLabel="Loading nodes..."
              emptyLabel="No bootstrap nodes configured"
              nodes={bootstrapEntries}
              loading={isLoadingBootstrapNodes}
              error={bootstrapError}
              copiedAddress={copiedAddress}
              newAddress={newBootstrapAddress}
              retrying={isRetryingBootstrap}
              retryDisabled={isRetryingBootstrap || isLoadingBootstrapNodes || bootstrapNodes.length === 0}
              onNewAddressChange={setNewBootstrapAddress}
              onAdd={handleAddBootstrapNode}
              onRetry={handleRetryBootstrap}
              onCopy={handleCopy}
              onRemove={handleRemoveBootstrapNode}
              onMoveUp={(index) => handleMoveBootstrapNode(index, 'up')}
              onMoveDown={(index) => handleMoveBootstrapNode(index, 'down')}
              moveDisabled={isReorderingBootstrapNodes}
            />
          ) : isRelayTab ? (
            <ConnectionNodesTab
              sectionLabel="Relay Nodes"
              addLabel="Add Relay Node"
              addPlaceholder="/ip4/1.2.3.4/tcp/4002/p2p/12D3Koo..."
              retryLabel="Retry Relay Reservations"
              loadingLabel="Loading relay nodes..."
              emptyLabel="No relay nodes configured"
              nodes={relayEntries}
              loading={isLoadingRelayNodes}
              error={relayError}
              copiedAddress={copiedAddress}
              newAddress={newRelayAddress}
              retrying={isRetryingRelays}
              retryDisabled={networkMode !== 'fast' || isRetryingRelays || isLoadingRelayNodes || relayNodes.length === 0}
              onNewAddressChange={setNewRelayAddress}
              onAdd={handleAddRelayNode}
              onRetry={handleRetryRelays}
              onCopy={handleCopy}
              onRemove={handleRemoveRelayNode}
              onMoveUp={(index) => handleMoveRelayNode(index, 'up')}
              onMoveDown={(index) => handleMoveRelayNode(index, 'down')}
              moveDisabled={isReorderingRelayNodes}
            />
          ) : (
            <IceServersTab
              servers={iceServers}
              loading={isLoadingIceServers}
              error={iceError}
              saving={isSavingIceServers}
              copiedAddress={copiedAddress}
              draftMode={iceServerDraft.id ? 'edit' : 'add'}
              draftType={iceServerDraft.type}
              draftUrl={iceServerDraft.url}
              draftUsername={iceServerDraft.username}
              draftCredential={iceServerDraft.credential}
              onDraftTypeChange={handleIceDraftTypeChange}
              onDraftUrlChange={(value) => setIceServerDraft((current) => ({ ...current, url: value }))}
              onDraftUsernameChange={(value) => setIceServerDraft((current) => ({ ...current, username: value }))}
              onDraftCredentialChange={(value) => setIceServerDraft((current) => ({ ...current, credential: value }))}
              onSave={handleSaveIceServer}
              onCancelEdit={resetIceServerDraft}
              onCopy={handleCopy}
              onEdit={handleEditIceServer}
              onRemove={handleRemoveIceServer}
              onMoveUp={(index) => handleMoveIceServer(index, 'up')}
              onMoveDown={(index) => handleMoveIceServer(index, 'down')}
            />
          )}

          <div className="pt-2 border-t border-border">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-muted-foreground">Network Status</span>
              <span className={networkStatusClassName}>{networkStatusLabel}</span>
            </div>
            <div className="flex items-center justify-between text-xs font-mono mt-1">
              <span className="text-muted-foreground">Bootstrap Nodes Connected</span>
              <span className="text-foreground">{bootstrapConnectedCount}</span>
            </div>
            {isFastMode ? (
              <div className="flex items-center justify-between text-xs font-mono mt-1">
                <span className="text-muted-foreground">Relay Nodes Connected</span>
                <span className="text-foreground">{relayConnectedCount}/{relayNodes.length}</span>
              </div>
            ) : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};

export default ConnectionStatusDialog;
