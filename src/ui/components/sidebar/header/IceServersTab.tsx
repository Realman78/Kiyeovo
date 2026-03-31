import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import type { IceServerConfig, IceServerType } from "../../../../core/types";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";

interface IceServersTabProps {
  servers: IceServerConfig[];
  loading: boolean;
  error: string | null;
  saving: boolean;
  copiedAddress: string | null;
  draftMode: 'add' | 'edit';
  draftType: IceServerType;
  draftUrl: string;
  draftUsername: string;
  draftCredential: string;
  onDraftTypeChange: (value: IceServerType) => void;
  onDraftUrlChange: (value: string) => void;
  onDraftUsernameChange: (value: string) => void;
  onDraftCredentialChange: (value: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onCopy: (address: string) => void;
  onEdit: (server: IceServerConfig) => void;
  onRemove: (id: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}

function getPlaceholder(type: IceServerType): string {
  switch (type) {
    case 'stun':
      return 'stun:stun.example.com:3478';
    case 'turn':
      return 'turn:turn.example.com:3478?transport=udp';
    case 'turns':
      return 'turns:turn.example.com:5349';
  }
}

export function IceServersTab({
  servers,
  loading,
  error,
  saving,
  copiedAddress,
  draftMode,
  draftType,
  draftUrl,
  draftUsername,
  draftCredential,
  onDraftTypeChange,
  onDraftUrlChange,
  onDraftUsernameChange,
  onDraftCredentialChange,
  onSave,
  onCancelEdit,
  onCopy,
  onEdit,
  onRemove,
  onMoveUp,
  onMoveDown,
}: IceServersTabProps) {
  const isTurn = draftType !== 'stun';
  const hasDraftUrl = draftUrl.trim().length > 0;
  const canSave = hasDraftUrl && (!isTurn || (draftUsername.trim() && draftCredential.trim()));

  return (
    <>
      <div className="space-y-2">
        {!!error && (
          <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20">
            <span className="text-sm text-destructive">{error}</span>
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
              ICE Servers For Calls
            </label>
            <p className="text-xs text-muted-foreground">
              Add multiple STUN or TURN servers for fast-mode calls. This dialog validates format only, so test reachability with a real call.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
          <span>{servers.length} server{servers.length === 1 ? '' : 's'}</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Loading ICE servers...</span>
          </div>
        ) : servers.length === 0 ? (
          <div className="p-4 rounded-md bg-secondary/50 border border-border">
            <span className="text-sm text-muted-foreground">
              No ICE servers configured. Calls will rely on direct host candidates only.
            </span>
          </div>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {servers.map((server, index) => (
              <div key={server.id} className="rounded-md bg-secondary/50 border border-border p-3 space-y-2">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-mono uppercase text-primary">
                        {server.type}
                      </span>
                      {server.username ? (
                        <span className="text-xs text-muted-foreground font-mono">
                          {server.username} / credential set
                        </span>
                      ) : null}
                    </div>
                    <div className="text-sm font-mono break-all text-foreground" title={server.url}>
                      {server.url}
                    </div>
                  </div>
                  <div className="flex items-center">
                    {servers.length > 1 ? (
                      <div className="flex flex-col">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onMoveUp(index)}
                          disabled={saving || index === 0}
                          className="w-4! h-4! text-muted-foreground"
                        >
                          <ChevronUp className="w-3 h-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onMoveDown(index)}
                          disabled={saving || index === servers.length - 1}
                          className="w-4! h-4! text-muted-foreground"
                        >
                          <ChevronDown className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onCopy(server.url)}
                      className="h-7 w-7 text-muted-foreground"
                    >
                      {copiedAddress === server.url ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onEdit(server)}
                      disabled={saving}
                      className="h-7 w-7 text-muted-foreground"
                    >
                      <Pencil className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onRemove(server.id)}
                      disabled={saving}
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3 h-3 hover:text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
            {draftMode === 'edit' ? 'Edit ICE Server' : 'Add ICE Server'}
          </label>
          {draftMode === 'edit' ? (
            <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={saving}>
              Cancel
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Type</span>
            <select
              className="border border-border rounded px-3 py-2.5 bg-background font-mono text-sm h-11"
              value={draftType}
              disabled={saving}
              onChange={(event) => onDraftTypeChange(event.target.value as IceServerType)}
            >
              <option value="stun">stun</option>
              <option value="turn">turn</option>
              <option value="turns">turns</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">URL</span>
            <Input
              placeholder={getPlaceholder(draftType)}
              value={draftUrl}
              disabled={saving}
              onChange={(event) => onDraftUrlChange(event.target.value)}
            />
          </label>
        </div>

        {isTurn ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              placeholder="TURN username"
              value={draftUsername}
              disabled={saving}
              onChange={(event) => onDraftUsernameChange(event.target.value)}
            />
            <Input
              type="password"
              placeholder="TURN credential"
              value={draftCredential}
              disabled={saving}
              onChange={(event) => onDraftCredentialChange(event.target.value)}
            />
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onSave} disabled={saving || !canSave}>
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                {draftMode === 'edit' ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                {draftMode === 'edit' ? 'Save' : 'Add'}
              </>
            )}
          </Button>
        </div>
      </div>
    </>
  );
}
