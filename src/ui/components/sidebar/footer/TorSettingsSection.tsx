import { type FC, useState } from "react";
import { Button } from "../../ui/Button";
import { HatGlasses } from "lucide-react";

type TorSettings = {
  socksHost: string;
  socksPort: number;
  connectionTimeout: number;
  circuitTimeout: number;
  maxRetries: number;
  healthCheckInterval: number;
  dnsResolution: 'tor' | 'system';
};

type TorSettingsSectionProps = {
  torSettings: TorSettings;
  setTorSettings: (next: TorSettings | ((prev: TorSettings) => TorSettings)) => void;
  originalTorSettings: TorSettings;
  onConfirmRestart: (updatedSettings: TorSettings) => void;
  isAnonymousMode: boolean;
};

export const TorSettingsSection: FC<TorSettingsSectionProps> = ({
  torSettings,
  setTorSettings,
  originalTorSettings,
  onConfirmRestart,
  isAnonymousMode,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const updateTorField = (updates: Partial<TorSettings>) => {
    const newSettings = { ...torSettings, ...updates };
    setTorSettings(newSettings);
  };

  const handleCancel = () => {
    setTorSettings(originalTorSettings);
  };

  const hasChanges = JSON.stringify(torSettings) !== JSON.stringify(originalTorSettings);

  return (
    <div className="border border-border rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <HatGlasses className="w-5 h-5 text-primary" />
          <div>
            <p className="text-sm font-medium text-foreground">Tor Network</p>
            <p className="text-xs text-muted-foreground">
              Mode-controlled (Anonymous mode). Settings require restart.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasChanges ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancel}
            >
              Cancel
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsExpanded((prev) => !prev)}
          >
            {isExpanded ? "Collapse" : "Expand"}
          </Button>
        </div>
      </div>

      {isExpanded ? (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">SOCKS Host</span>
              <input
                className="border border-border rounded px-2 py-1 bg-background"
                value={torSettings.socksHost}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ socksHost: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">SOCKS Port</span>
              <input
                className="border border-border rounded px-2 py-1 bg-background"
                type="number"
                value={torSettings.socksPort}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ socksPort: parseInt(e.target.value || '0', 10) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Connection Timeout (ms)</span>
              <input
                className="border border-border rounded px-2 py-1 bg-background"
                type="number"
                value={torSettings.connectionTimeout}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ connectionTimeout: parseInt(e.target.value || '0', 10) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Circuit Timeout (ms)</span>
              <input
                className="border border-border rounded px-2 py-1 bg-background"
                type="number"
                value={torSettings.circuitTimeout}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ circuitTimeout: parseInt(e.target.value || '0', 10) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Max Retries</span>
              <input
                className="border border-border rounded px-2 py-1 bg-background"
                type="number"
                value={torSettings.maxRetries}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ maxRetries: parseInt(e.target.value || '0', 10) })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Health Check Interval (ms)</span>
              <input
                className="border border-border rounded px-2 py-1 bg-background"
                type="number"
                value={torSettings.healthCheckInterval}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ healthCheckInterval: parseInt(e.target.value || '0', 10) })}
              />
            </label>
            <label className="flex flex-col gap-1 col-span-2">
              <span className="text-xs text-muted-foreground">DNS Resolution</span>
              <select
                className="border border-border rounded px-2 py-1 bg-background"
                value={torSettings.dnsResolution}
                disabled={!isAnonymousMode}
                onChange={(e) => updateTorField({ dnsResolution: e.target.value as 'tor' | 'system' })}
              >
                <option value="tor">tor</option>
                <option value="system">system</option>
              </select>
            </label>
          </div>
          {!isAnonymousMode ? (
            <p className="text-xs text-muted-foreground">Switch to Anonymous mode to edit Tor settings.</p>
          ) : null}
          {hasChanges ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!isAnonymousMode}
                onClick={() => onConfirmRestart(torSettings)}
              >
                Apply & Restart
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
