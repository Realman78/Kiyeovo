import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { IceServerConfig, IceServerType } from '../../../../core/types';
import { PREDEFINED_NODES_OFFERING_LABELS, isOfferingActive } from '../../../../core/predefined-nodes';
import { PredefinedNodesOfferingLink } from './PredefinedNodesOfferingLink';
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from '../../../constants';
import { useRefreshSetupReadiness } from '../../../hooks/useSetupReadiness';
import { useAppDispatch, useAppSelector } from '../../../state/hooks';
import {
  clearIceServerTest,
  completeIceServerTest,
  completeIceServerTestAll,
  startIceServerTest,
  startIceServerTestAll,
  type IceServerTestState,
} from '../../../state/slices/iceSetupSlice';
import type { IceTestStatus } from '../../../types';
import { useToast } from '../../ui/use-toast';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';
import { testIceServer } from './iceServerTest';
import { ServerEntryWarningRow } from './ServerEntryWarningRow';
import { buildWarningDismissalKey, getServerEntryWarning } from '../../../lib/server-entry-warnings';

type IceServerDraft = {
  id: string | null;
  type: IceServerType;
  url: string;
  username: string;
  credential: string;
};

const EMPTY_DRAFT: IceServerDraft = {
  id: null,
  type: 'stun',
  url: '',
  username: '',
  credential: '',
};

const TYPE_OPTIONS: IceServerType[] = ['stun', 'turn', 'turns'];

const URL_PLACEHOLDER: Record<IceServerType, string> = {
  stun: 'stun:stun.l.google.com:19302',
  turn: 'turn:turn.example.com:3478',
  turns: 'turns:turn.example.com:5349',
};

const TEST_VISUAL: Record<IceTestStatus, { label: string; dot: string }> = {
  reachable: { label: 'Reachable', dot: 'bg-success' },
  unreachable: { label: 'Unreachable', dot: 'bg-destructive' },
  invalid_credentials: { label: 'Invalid credentials', dot: 'bg-warning' },
  indeterminate: { label: 'Inconclusive', dot: 'bg-muted-foreground' },
};

function formatTestAge(testedAt: number, now: number): string {
  const elapsedMinutes = Math.max(0, Math.floor((now - testedAt) / 60_000));
  if (elapsedMinutes < 1) return 'just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes} min ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} hr ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
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
  const payload = { ...result };
  Reflect.deleteProperty(payload, 'success');
  Reflect.deleteProperty(payload, 'error');
  return payload;
}

export function IceSetup() {
  const { toast } = useToast();
  const dispatch = useAppDispatch();
  const testResults = useAppSelector((state) => state.iceSetup.testResults);
  const activeTestAllRequestId = useAppSelector(
    (state) => state.iceSetup.activeTestAllRequestId,
  );
  const refreshSetupReadiness = useRefreshSetupReadiness();
  const [servers, setServers] = useState<IceServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<IceServerDraft>(EMPTY_DRAFT);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Session-scoped, per-(URL, warning-code) dismissal for misconfiguration
  // hints — not persisted, matches the "dismissable, not a blocker" nature
  // of these hints. Keying by code means a dismissed lower-priority warning
  // still resurfaces if it's later upgraded to a higher-priority one.
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(new Set());
  const reorderInFlightRef = useRef(false);

  const dismissWarning = (key: string) => {
    setDismissedWarnings((current) => new Set(current).add(key));
  };

  useEffect(() => {
    const hasCompletedTest = Object.values(testResults).some((result) => result.testedAt !== null);
    if (!hasCompletedTest) return;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 60_000);
    return () => clearInterval(timer);
  }, [testResults]);

  const refreshServers = async () => {
    const { servers: loaded } = unwrapIpcResult(
      await window.kiyeovoAPI.getIceServers(),
      'Failed to fetch STUN/TURN servers',
    );
    setServers(loaded);
  };

  useEffect(() => {
    const load = async () => {
      setError(null);
      try {
        await refreshServers();
        const ackResult = await window.kiyeovoAPI.getMissingIceWarningAcknowledged();
        if (ackResult.success) {
          setAcknowledged(ackResult.acknowledged);
        }
      } catch (loadError) {
        setError(getUnexpectedErrorMessage(loadError));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, []);

  const persistServers = async (next: IceServerConfig[]) => {
    unwrapIpcResult(
      await window.kiyeovoAPI.setIceServers(next),
      'Failed to save STUN/TURN servers',
    );
    await refreshServers();
  };

  const handleTypeChange = (type: IceServerType) => {
    setDraft((current) => ({
      ...current,
      type,
      username: type === 'stun' ? '' : current.username,
      credential: type === 'stun' ? '' : current.credential,
    }));
  };

  const buildFromDraft = (): IceServerConfig => {
    const url = draft.url.trim();
    if (!url) {
      throw new Error('Server URL is required');
    }
    const expectedPrefix = `${draft.type}:`;
    if (!url.toLowerCase().startsWith(expectedPrefix)) {
      throw new Error(`URL must start with ${expectedPrefix}`);
    }
    if (draft.type === 'stun') {
      return { id: draft.id ?? crypto.randomUUID(), type: 'stun', url };
    }
    const username = draft.username.trim();
    const credential = draft.credential.trim();
    if (!username || !credential) {
      throw new Error('TURN servers require a username and credential');
    }
    return { id: draft.id ?? crypto.randomUUID(), type: draft.type, url, username, credential };
  };

  const clearTestResult = (id: string) => {
    dispatch(clearIceServerTest({ serverId: id }));
  };

  const handleOpenAdd = () => {
    setDraft(EMPTY_DRAFT);
    setIsFormOpen(true);
  };

  const handleCancelForm = () => {
    setDraft(EMPTY_DRAFT);
    setIsFormOpen(false);
  };

  const handleEdit = (server: IceServerConfig) => {
    setDraft({
      id: server.id,
      type: server.type,
      url: server.url,
      username: server.username ?? '',
      credential: server.credential ?? '',
    });
    setIsFormOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const nextServer = buildFromDraft();
      const duplicate = servers.find((server) => {
        if (server.id === nextServer.id) return false;
        const sameUrl = server.url.trim().toLowerCase() === nextServer.url.trim().toLowerCase();
        const sameType = server.type === nextServer.type;
        const sameUsername = (server.username ?? '') === (nextServer.username ?? '');
        return sameUrl && sameType && sameUsername;
      });
      if (duplicate) {
        throw new Error('That STUN/TURN server is already in your list');
      }

      const wasEmpty = servers.length === 0;
      const next = draft.id
        ? servers.map((server) => (server.id === nextServer.id ? nextServer : server))
        : [...servers, nextServer];

      await persistServers(next);
      // The edited server's connection details changed, so a prior test result
      // no longer applies.
      clearTestResult(nextServer.id);
      handleCancelForm();
      if (wasEmpty) {
        void refreshSetupReadiness();
      }
    } catch (saveError) {
      toast.error(getUnexpectedErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await persistServers(servers.filter((server) => server.id !== id));
      clearTestResult(id);
      if (draft.id === id) {
        handleCancelForm();
      }
      void refreshSetupReadiness();
    } catch (removeError) {
      toast.error(getUnexpectedErrorMessage(removeError));
    }
  };

  const handleMove = async (index: number, direction: 'up' | 'down') => {
    if (reorderInFlightRef.current) return;
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= servers.length) return;

    const next = [...servers];
    [next[index]!, next[swapIndex]!] = [next[swapIndex]!, next[index]!];
    setServers(next);
    reorderInFlightRef.current = true;
    setReordering(true);
    try {
      await persistServers(next);
    } catch (moveError) {
      toast.error(getUnexpectedErrorMessage(moveError));
      await refreshServers();
    } finally {
      reorderInFlightRef.current = false;
      setReordering(false);
    }
  };

  const runTest = async (server: IceServerConfig) => {
    const requestId = crypto.randomUUID();
    dispatch(startIceServerTest({ serverId: server.id, requestId }));
    const result = await testIceServer(server);
    dispatch(completeIceServerTest({
      serverId: server.id,
      requestId,
      status: result.status,
      detail: result.detail,
      testedAt: Date.now(),
    }));
  };

  const handleTestOne = (server: IceServerConfig) => {
    void runTest(server);
  };

  const handleTestAll = async () => {
    const requestId = crypto.randomUUID();
    dispatch(startIceServerTestAll({ requestId }));
    try {
      await Promise.all(servers.map((server) => runTest(server)));
    } finally {
      dispatch(completeIceServerTestAll({ requestId }));
    }
  };

  const handleCopy = (server: IceServerConfig) => {
    setCopiedId(server.id);
    void navigator.clipboard.writeText(server.url);
    setTimeout(() => {
      setCopiedId((current) => (current === server.id ? null : current));
    }, 2000);
  };

  const handleToggleAcknowledge = async () => {
    const next = !acknowledged;
    setAcknowledged(next);
    try {
      unwrapIpcResult(
        await window.kiyeovoAPI.setMissingIceWarningAcknowledged(next),
        'Failed to save call setup preference',
      );
      void refreshSetupReadiness();
    } catch (ackError) {
      setAcknowledged(!next);
      toast.error(getUnexpectedErrorMessage(ackError));
    }
  };

  const renderStatus = (state: IceServerTestState | undefined) => {
    if (!state) {
      return (
        <span className="flex w-4 shrink-0 justify-center" role="img" aria-label="Not tested" title="Not tested">
          <span className="h-2 w-2 rounded-full border border-muted-foreground/50" />
        </span>
      );
    }
    if (state.status === 'testing') {
      return (
        <span className="flex w-4 shrink-0 justify-center" role="img" aria-label="Testing" title="Testing…">
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        </span>
      );
    }
    const visual = TEST_VISUAL[state.status];
    const title = state.detail ? `${visual.label} — ${state.detail}` : visual.label;
    return (
      <span className="flex w-4 shrink-0 justify-center" role="img" aria-label={title} title={title}>
        <span className={`h-2 w-2 rounded-full ${visual.dot}`} />
      </span>
    );
  };

  const isStun = draft.type === 'stun';
  const saveDisabled = saving || !draft.url.trim() || (!isStun && (!draft.username.trim() || !draft.credential.trim()));
  const testingAll = activeTestAllRequestId !== null;
  const anyTesting = servers.some((server) => testResults[server.id]?.status === 'testing');
  const reachableCount = servers.filter(
    (server) => testResults[server.id]?.status === 'reachable',
  ).length;

  return (
    <div className="h-full overflow-y-auto bg-sidebar-accent py-8">
      <div className="mx-auto w-full max-w-5xl px-8 py-10 lg:py-12">
        <header className="flex flex-col items-start gap-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Phone className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">STUN/TURN servers</h1>
          </div>
          <p className="text-md text-left text-muted-foreground">
            STUN and TURN servers help set up audio and video calls when a direct connection between
            you and the other person isn't possible.
          </p>
          {isOfferingActive(Date.now()) && (
            // ICE setup only exists in fast mode, so no external-link confirmation needed.
            <PredefinedNodesOfferingLink label={PREDEFINED_NODES_OFFERING_LABELS.ice} />
          )}
        </header>

        {!!error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <section className="mt-8" aria-labelledby="ice-servers-title">
          <div className="flex items-baseline justify-between gap-4">
            <h2
              id="ice-servers-title"
              className="text-[11px] font-mono font-medium uppercase tracking-widest text-muted-foreground"
            >
              Configured servers
            </h2>
          </div>

          <div className="mt-3 divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-card/40">
            {loading ? (
              <div className="flex min-h-24 items-center justify-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="ml-2 text-sm">Loading STUN/TURN servers…</span>
              </div>
            ) : (
              <>
                {servers.length === 0 && !isFormOpen && (
                  <div className="flex flex-col items-center px-4 py-10 text-center">
                    <p className="text-sm font-medium text-foreground">No STUN/TURN servers configured</p>
                    <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                      Add a STUN or TURN server to enable audio and video calls.
                    </p>
                    <Button className="mt-5" onClick={handleOpenAdd}>
                      <Plus />
                      Add STUN/TURN server
                    </Button>
                  </div>
                )}

                {servers.map((server, index) => {
                  const testState = testResults[server.id];
                  const entryWarning = getServerEntryWarning(server.url, server.type, {});
                  const entryWarningKey = entryWarning
                    ? buildWarningDismissalKey(server.url, entryWarning.code)
                    : null;
                  const showEntryWarning = !!entryWarning && !!entryWarningKey && !dismissedWarnings.has(entryWarningKey);
                  return (
                    <div key={server.id} className="px-4 py-3">
                      <div className="group flex items-center gap-3">
                        {renderStatus(testState)}
                        <div className="min-w-0 flex-1 pl-2">
                          <div className="truncate text-sm font-mono text-foreground text-left" title={server.url}>
                            {server.url}
                          </div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs">
                            <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-mono font-medium uppercase tracking-wide text-muted-foreground">
                              {server.type}
                            </span>
                            {server.type !== 'stun' && server.username && (
                              <>
                                <span className="shrink-0 text-muted-foreground/50">·</span>
                                <span
                                  className="min-w-0 truncate text-muted-foreground"
                                  title={`user: ${server.username}`}
                                >
                                  user: {server.username}
                                </span>
                              </>
                            )}
                            <span className="shrink-0 text-muted-foreground/50">·</span>
                            <span className="shrink-0 text-muted-foreground">
                              {testState?.status === 'testing'
                                ? 'Testing…'
                                : testState?.testedAt !== null && testState?.testedAt !== undefined
                                  ? `Last tested ${formatTestAge(testState.testedAt, now)}`
                                  : 'Not tested'}
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleTestOne(server)}
                            disabled={testingAll || testState?.status === 'testing'}
                            className="h-8"
                          >
                            {testState?.status === 'testing' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            Test
                          </Button>
                          {servers.length > 1 && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleMove(index, 'up')}
                                disabled={reordering || index === 0}
                                className="h-8 w-8"
                                aria-label="Move server up"
                              >
                                <ChevronUp />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleMove(index, 'down')}
                                disabled={reordering || index === servers.length - 1}
                                className="h-8 w-8"
                                aria-label="Move server down"
                              >
                                <ChevronDown />
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleCopy(server)}
                            className="h-8 w-8"
                            aria-label="Copy server URL"
                          >
                            {copiedId === server.id ? <Check className="text-success" /> : <Copy />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(server)}
                            className="h-8 w-8"
                            aria-label="Edit server"
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemove(server.id)}
                            className="h-8 w-8 hover:text-destructive"
                            aria-label="Remove server"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                      {showEntryWarning && (
                        <ServerEntryWarningRow
                          warning={entryWarning!}
                          onDismiss={() => dismissWarning(entryWarningKey!)}
                        />
                      )}
                    </div>
                  );
                })}

                {isFormOpen ? (
                  <div className="space-y-4 px-4 py-4">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-medium text-muted-foreground">Type</span>
                      <div className="inline-flex rounded-md border border-border p-0.5">
                        {TYPE_OPTIONS.map((type) => (
                          <button
                            key={type}
                            type="button"
                            onClick={() => handleTypeChange(type)}
                            className={`cursor-pointer rounded px-3 py-1 text-xs font-medium uppercase transition-colors ${draft.type === type
                              ? 'bg-primary/15 text-primary'
                              : 'text-muted-foreground hover:text-foreground'
                              }`}
                          >
                            {type}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Input
                      placeholder={URL_PLACEHOLDER[draft.type]}
                      value={draft.url}
                      onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                      parentClassName="w-full"
                    />
                    {(() => {
                      const trimmedUrl = draft.url.trim();
                      const draftWarning = trimmedUrl ? getServerEntryWarning(trimmedUrl, draft.type, {}) : null;
                      if (!draftWarning) return null;
                      const draftWarningKey = buildWarningDismissalKey(trimmedUrl, draftWarning.code);
                      if (dismissedWarnings.has(draftWarningKey)) return null;
                      return (
                        <ServerEntryWarningRow
                          warning={draftWarning}
                          onDismiss={() => dismissWarning(draftWarningKey)}
                        />
                      );
                    })()}

                    {!isStun && (
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <Input
                          placeholder="Username"
                          value={draft.username}
                          onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))}
                          parentClassName="min-w-0 flex-1"
                        />
                        <Input
                          type="password"
                          placeholder="Credential"
                          value={draft.credential}
                          onChange={(event) => setDraft((current) => ({ ...current, credential: event.target.value }))}
                          parentClassName="min-w-0 flex-1"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={handleCancelForm} disabled={saving}>
                        <X />
                        Cancel
                      </Button>
                      <Button variant="default" size="sm" onClick={handleSave} disabled={saveDisabled}>
                        {saving ? <Loader2 className="animate-spin" /> : <Plus />}
                        {draft.id ? 'Save changes' : 'Add server'}
                      </Button>
                    </div>
                  </div>
                ) : servers.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleOpenAdd}
                    className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground"
                  >
                    <Plus className="h-4 w-4" />
                    Add STUN/TURN server
                  </button>
                ) : null}
              </>
            )}
          </div>

          {!loading && servers.length > 0 && (
            <div className="mt-4 space-y-4 px-1">
              <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-success" aria-hidden />
                  Reachable
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-destructive" aria-hidden />
                  Unreachable
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-warning" aria-hidden />
                  Invalid credentials
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-muted-foreground" aria-hidden />
                  Inconclusive
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full border border-muted-foreground/50" aria-hidden />
                  Not tested
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs text-muted-foreground">
                  {reachableCount} reachable
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleTestAll}
                  disabled={testingAll || anyTesting}
                >
                  {testingAll ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  Test all
                </Button>
              </div>
            </div>
          )}

          {!loading && (
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={handleToggleAcknowledge}
                className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
              />
              <span>I don't plan to make audio or video calls — stop showing the setup reminder.</span>
            </label>
          )}
        </section>
      </div>
    </div>
  );
}
