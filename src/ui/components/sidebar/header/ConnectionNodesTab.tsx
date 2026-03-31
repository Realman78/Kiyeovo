import { Check, ChevronDown, ChevronUp, Copy, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";

export interface ConnectionNodeEntry {
  key: string;
  address: string;
  connected: boolean;
}

interface ConnectionNodesTabProps {
  sectionLabel: string;
  addLabel: string;
  addPlaceholder: string;
  retryLabel: string;
  loadingLabel: string;
  emptyLabel: string;
  nodes: ConnectionNodeEntry[];
  loading: boolean;
  error: string | null;
  copiedAddress: string | null;
  newAddress: string;
  retrying: boolean;
  addDisabled?: boolean;
  retryDisabled?: boolean;
  onNewAddressChange: (value: string) => void;
  onAdd: () => void;
  onRetry: () => void;
  onCopy: (address: string) => void;
  onRemove: (address: string) => void;
  onMoveUp?: (index: number) => void;
  onMoveDown?: (index: number) => void;
  moveDisabled?: boolean;
}

export function ConnectionNodesTab({
  sectionLabel,
  addLabel,
  addPlaceholder,
  retryLabel,
  loadingLabel,
  emptyLabel,
  nodes,
  loading,
  error,
  copiedAddress,
  newAddress,
  retrying,
  addDisabled = false,
  retryDisabled = false,
  onNewAddressChange,
  onAdd,
  onRetry,
  onCopy,
  onRemove,
  onMoveUp,
  onMoveDown,
  moveDisabled = false,
}: ConnectionNodesTabProps) {
  return (
    <>
      <div className="space-y-2">
        {!!error && (
          <div className="p-4 rounded-md bg-destructive/10 border border-destructive/20">
            <span className="text-sm text-destructive">{error}</span>
          </div>
        )}
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          {sectionLabel}
        </label>

        {loading ? (
          <div className="flex items-center justify-center p-4">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">{loadingLabel}</span>
          </div>
        ) : nodes.length === 0 ? (
          <div className="p-4 rounded-md bg-secondary/50 border border-border">
            <span className="text-sm text-muted-foreground">{emptyLabel}</span>
          </div>
        ) : (
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {nodes.map((node, index) => (
              <div key={node.key} className="flex items-center gap-4 p-2 rounded-md bg-secondary/50 border border-border">
                <div className={`w-2 h-2 rounded-full ${node.connected ? 'bg-success' : 'bg-muted-foreground'}`} />
                <span className="flex-1 text-sm font-mono text-foreground break-all" title={node.address}>
                  {node.address}
                </span>
                <div className="flex items-center">
                  {onMoveUp && onMoveDown && nodes.length > 1 && (
                    <div className="flex flex-col">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onMoveUp(index)}
                        disabled={moveDisabled || index === 0}
                        className="w-4! h-4! text-muted-foreground"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onMoveDown(index)}
                        disabled={moveDisabled || index === nodes.length - 1}
                        className="w-4! h-4! text-muted-foreground"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </Button>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onCopy(node.address)}
                    className="h-7 w-7 text-muted-foreground"
                  >
                    {copiedAddress === node.address ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onRemove(node.address)}
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3 hover:text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">
          {addLabel}
        </label>
        <div className="flex gap-2">
          <Input
            placeholder={addPlaceholder}
            value={newAddress}
            onChange={(e) => onNewAddressChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAdd()}
            className="flex-1"
            parentClassName="flex-1"
          />
          <Button
            variant="outline"
            size="icon"
            onClick={onAdd}
            disabled={addDisabled || !newAddress.trim()}
          >
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="pt-2 border-t border-border">
        <Button
          variant="outline"
          className="w-full"
          onClick={onRetry}
          disabled={retryDisabled}
        >
          {retrying ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Retrying...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              {retryLabel}
            </>
          )}
        </Button>
      </div>
    </>
  );
}
