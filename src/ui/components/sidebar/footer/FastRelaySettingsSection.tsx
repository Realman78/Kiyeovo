import { type FC } from "react";
import { Network } from "lucide-react";
import { Button } from "../../ui/Button";

type FastRelaySettingsSectionProps = {
  relayMultiaddrsText: string;
  setRelayMultiaddrsText: (next: string) => void;
  originalRelayMultiaddrsText: string;
  onConfirmRestart: (updatedText: string) => void;
  onTestRelays: () => Promise<void>;
  isTestingRelays: boolean;
  testSummary?: string | null;
  backendError?: string | null;
  isFastMode: boolean;
};

function normalizeRelayText(value: string): string {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");
}

function stripP2pSuffix(value: string): string {
  return value.replace(/\/p2p\/[^/]+$/, "");
}

export const FastRelaySettingsSection: FC<FastRelaySettingsSectionProps> = ({
  relayMultiaddrsText,
  setRelayMultiaddrsText,
  originalRelayMultiaddrsText,
  onConfirmRestart,
  onTestRelays,
  isTestingRelays,
  testSummary,
  backendError,
  isFastMode,
}) => {
  const normalizedCurrent = normalizeRelayText(relayMultiaddrsText);
  const normalizedOriginal = normalizeRelayText(originalRelayMultiaddrsText);
  const hasChanges = normalizedCurrent !== normalizedOriginal;

  const handleCancel = () => {
    setRelayMultiaddrsText(originalRelayMultiaddrsText);
  };

  return (
    <div className="border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Network className="w-5 h-5 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">Fast Relay Nodes</p>
            <p className="text-xs text-muted-foreground">
              Relay multiaddrs used in Fast mode (one per line or comma-separated).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { void onTestRelays(); }} disabled={isTestingRelays}>
            {isTestingRelays ? 'Testing...' : 'Test Relays'}
          </Button>
          {hasChanges ? (
            <Button variant="outline" size="sm" onClick={handleCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      <textarea
        className="w-full min-h-24 border border-border rounded px-2 py-2 bg-background text-sm"
        value={relayMultiaddrsText}
        onChange={(e) => setRelayMultiaddrsText(e.target.value)}
        placeholder="/ip4/1.2.3.4/tcp/9001/p2p/12D3Koo..."
      />

      {normalizeRelayText(relayMultiaddrsText)
        .split("\n")
        .filter(Boolean)
        .some((line) => stripP2pSuffix(line) === "") ? (
        <p className="text-xs text-destructive">Invalid relay multiaddr format.</p>
      ) : null}

      {backendError ? (
        <p className="text-xs text-destructive">{backendError}</p>
      ) : null}
      {testSummary ? (
        <p className="text-xs text-muted-foreground">{testSummary}</p>
      ) : null}

      {!isFastMode ? (
        <p className="text-xs text-muted-foreground">
          Fast relays are inactive in Anonymous mode. They will be used when you switch to Fast mode.
        </p>
      ) : null}

      {hasChanges ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => onConfirmRestart(normalizedCurrent)}>
            Apply & Restart
          </Button>
        </div>
      ) : null}
    </div>
  );
};
