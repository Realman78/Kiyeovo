import { useState, type Dispatch, type FC, type SetStateAction } from 'react';
import { HatGlasses } from 'lucide-react';
import { Button } from '../../ui/Button';

export type TorSettings = {
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
  setTorSettings: Dispatch<SetStateAction<TorSettings>>;
  originalTorSettings: TorSettings;
  onConfirmRestart: (updatedSettings: TorSettings) => void;
  restartRequired: boolean;
  restarting: boolean;
  onRestart: () => void;
};

export const TorSettingsSection: FC<TorSettingsSectionProps> = ({
  torSettings,
  setTorSettings,
  originalTorSettings,
  onConfirmRestart,
  restartRequired,
  restarting,
  onRestart,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasChanges = JSON.stringify(torSettings) !== JSON.stringify(originalTorSettings);

  const updateTorField = (updates: Partial<TorSettings>) => {
    setTorSettings((current) => ({ ...current, ...updates }));
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background/60 p-4">
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3">
          <HatGlasses className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 text-left">
            <p className="text-sm font-medium text-foreground">Tor Network</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Anonymous-mode transport settings. Changes require an app restart.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {restartRequired && !hasChanges && (
            <Button
              size="sm"
              onClick={onRestart}
              disabled={restarting}
            >
              {restarting ? 'Restarting...' : 'Restart app'}
            </Button>
          )}
          {hasChanges && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTorSettings(originalTorSettings)}
              disabled={restarting}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsExpanded((current) => !current)}
            disabled={restarting}
          >
            {isExpanded ? 'Collapse' : 'Expand'}
          </Button>
        </div>
      </div>

      {isExpanded && (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">SOCKS Host</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                value={torSettings.socksHost}
                onChange={(event) => updateTorField({ socksHost: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">SOCKS Port</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                value={torSettings.socksPort}
                onChange={(event) => updateTorField({
                  socksPort: Number.parseInt(event.target.value || '0', 10),
                })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Connection Timeout (ms)</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                value={torSettings.connectionTimeout}
                onChange={(event) => updateTorField({
                  connectionTimeout: Number.parseInt(event.target.value || '0', 10),
                })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Circuit Timeout (ms)</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                value={torSettings.circuitTimeout}
                onChange={(event) => updateTorField({
                  circuitTimeout: Number.parseInt(event.target.value || '0', 10),
                })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Max Retries</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                value={torSettings.maxRetries}
                onChange={(event) => updateTorField({
                  maxRetries: Number.parseInt(event.target.value || '0', 10),
                })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Health Check Interval (ms)</span>
              <input
                className="rounded border border-border bg-background px-2 py-1"
                type="number"
                value={torSettings.healthCheckInterval}
                onChange={(event) => updateTorField({
                  healthCheckInterval: Number.parseInt(event.target.value || '0', 10),
                })}
              />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">DNS Resolution</span>
              <select
                className="rounded border border-border bg-background px-2 py-1"
                value={torSettings.dnsResolution}
                onChange={(event) => updateTorField({
                  dnsResolution: event.target.value as TorSettings['dnsResolution'],
                })}
              >
                <option value="tor">Tor</option>
                <option value="system">System</option>
              </select>
            </label>
          </div>
          {hasChanges && (
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={() => onConfirmRestart(torSettings)}
                disabled={restarting}
              >
                Apply & Restart
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
