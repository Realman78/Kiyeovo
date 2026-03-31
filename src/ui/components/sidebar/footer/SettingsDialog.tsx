import { type FC, type ReactNode, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from "../../ui/Dialog";
import { Button } from "../../ui/Button";
import { Bell, BellOff, FolderOpen, Info, Trash2, Database, Settings, RefreshCw, Power } from "lucide-react";
import { KiyeovoDialog } from "../header/KiyeovoDialog";
import { TorSettingsSection } from "./TorSettingsSection";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { TorRestartDialog } from "./TorRestartDialog";
import { ConfigurationDialog } from "./ConfigurationDialog";
import { TOR_CONFIG } from "../../../constants";
import { handleDeleteAccount } from "../../../utils/handlers";
import { useToast } from "../../ui/use-toast";
import type { NetworkMode } from "../../../../core/types";
import { errStr } from '../../../../core/utils/general-error';


type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type SettingsActionRowProps = {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action: ReactNode;
  destructive?: boolean;
  contentClassName?: string;
  bodyClassName?: string;
};

const SettingsActionRow: FC<SettingsActionRowProps> = ({
  icon,
  title,
  description,
  action,
  destructive = false,
  contentClassName = '',
  bodyClassName = '',
}) => (
  <div
    className={`flex items-center justify-between p-3 rounded-lg transition-colors ${
      destructive
        ? 'border border-destructive/50 bg-destructive/5'
        : 'border border-border'
    }`}
  >
    <div className={`flex items-center gap-3 ${contentClassName}`.trim()}>
      {icon}
      <div className={bodyClassName}>
        <p className="text-sm font-medium text-foreground">
          {title}
        </p>
        <p className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
    {action}
  </div>
);

export const SettingsDialog: FC<SettingsDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { toast } = useToast();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [downloadsDir, setDownloadsDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [torSettings, setTorSettings] = useState({
    socksHost: TOR_CONFIG.DEFAULT_SOCKS_HOST,
    socksPort: TOR_CONFIG.DEFAULT_SOCKS_PORT,
    connectionTimeout: TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
    circuitTimeout: TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT,
    maxRetries: TOR_CONFIG.DEFAULT_MAX_RETRIES,
    healthCheckInterval: TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL,
    dnsResolution: TOR_CONFIG.DNS_RESOLUTION_TOR as 'tor' | 'system'
  });
  const [originalTorSettings, setOriginalTorSettings] = useState(torSettings);
  const [torConfirmOpen, setTorConfirmOpen] = useState(false);
  const [pendingTorSettings, setPendingTorSettings] = useState(torSettings);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [networkMode, setNetworkMode] = useState<NetworkMode>('fast');
  const [isSwitchingMode, setIsSwitchingMode] = useState(false);
  const [isQuittingApp, setIsQuittingApp] = useState(false);

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open]);

  useEffect(() => {
    // Listen for notifications setting changes
    const unsubscribe = window.kiyeovoAPI.onNotificationsEnabledChanged((enabled: boolean) => {
      setNotificationsEnabled(enabled);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const loadSettings = async () => {
    setLoading(true);
    try {
      const [notifResult, downloadsDirResult, torResult, networkModeResult] = await Promise.all([
        window.kiyeovoAPI.getNotificationsEnabled(),
        window.kiyeovoAPI.getDownloadsDir(),
        window.kiyeovoAPI.getTorSettings(),
        window.kiyeovoAPI.getNetworkMode(),
      ]);

      if (notifResult.success) {
        setNotificationsEnabled(notifResult.enabled);
      }

      if (downloadsDirResult.success && downloadsDirResult.path) {
        setDownloadsDir(downloadsDirResult.path);
      }
      if (torResult.success && torResult.settings) {
        const s = torResult.settings;
        const loadedSettings = {
          socksHost: s.socksHost || TOR_CONFIG.DEFAULT_SOCKS_HOST,
          socksPort: s.socksPort ? parseInt(s.socksPort, 10) : TOR_CONFIG.DEFAULT_SOCKS_PORT,
          connectionTimeout: s.connectionTimeout ? parseInt(s.connectionTimeout, 10) : TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
          circuitTimeout: s.circuitTimeout ? parseInt(s.circuitTimeout, 10) : TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT,
          maxRetries: s.maxRetries ? parseInt(s.maxRetries, 10) : TOR_CONFIG.DEFAULT_MAX_RETRIES,
          healthCheckInterval: s.healthCheckInterval ? parseInt(s.healthCheckInterval, 10) : TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL,
          dnsResolution: (s.dnsResolution === TOR_CONFIG.DNS_RESOLUTION_SYSTEM ? 'system' : 'tor') as 'tor' | 'system'
        };
        setTorSettings(loadedSettings);
        setOriginalTorSettings(loadedSettings);
      }

      if (networkModeResult.success) {
        setNetworkMode(networkModeResult.mode);
      }
    } catch (error) {
      console.error("Failed to load settings:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleNotifications = async () => {
    const newValue = !notificationsEnabled;
    setNotificationsEnabled(newValue);

    try {
      const result = await window.kiyeovoAPI.setNotificationsEnabled(newValue);
      if (!result.success) {
        // Revert on failure
        setNotificationsEnabled(!newValue);
        console.error("Failed to update notifications setting:", result.error);
      }
    } catch (error) {
      // Revert on failure
      setNotificationsEnabled(!newValue);
      console.error("Failed to update notifications setting:", error);
    }
  };

  const handleChangeDownloadsDir = async () => {
    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select Downloads Directory',
        properties: ['openDirectory']
      });

      if (!result.canceled && result.filePath) {
        const setResult = await window.kiyeovoAPI.setDownloadsDir(result.filePath);
        if (setResult.success) {
          setDownloadsDir(result.filePath);
        } else {
          console.error("Failed to update downloads directory:", setResult.error);
        }
      }
    } catch (error) {
      console.error("Failed to change downloads directory:", error);
    }
  };

  const handleConfirmTorRestart = (updatedSettings: typeof torSettings) => {
    setPendingTorSettings(updatedSettings);
    setTorConfirmOpen(true);
  };

  const handleApplyTorSettings = async () => {
    try {
      const result = await window.kiyeovoAPI.setTorSettings(pendingTorSettings);
      if (!result.success) {
        console.error('Failed to update Tor settings:', result.error);
        return;
      }
      await window.kiyeovoAPI.restartApp();
    } catch (error) {
      console.error('Failed to apply Tor settings:', error);
    }
  };

  const handleBackupDatabase = async () => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const defaultFileName = `kiyeovo-backup-${timestamp}.db`;

      const result = await window.kiyeovoAPI.showSaveDialog({
        title: 'Save Database Backup',
        defaultPath: defaultFileName,
        filters: [
          { name: 'Database Files', extensions: ['db'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (!result.canceled && result.filePath) {
        const backupResult = await window.kiyeovoAPI.backupDatabase(result.filePath);
        if (backupResult.success) {
          toast.info('Database backup successful');
          onOpenChange(false);
        } else {
          console.error('Failed to backup database:', backupResult.error);
        }
      }
    } catch (error) {
      console.error('Failed to backup database:', error);
    }
  }

  const handleCancelTorRestart = () => {
    setTorSettings(originalTorSettings);
    setTorConfirmOpen(false);
  };

  const handleSwitchNetworkMode = async () => {
    if (isSwitchingMode || isQuittingApp) return;

    const targetMode: NetworkMode = networkMode === 'anonymous' ? 'fast' : 'anonymous';
    setIsSwitchingMode(true);
    try {
      const setResult = await window.kiyeovoAPI.setNetworkMode(targetMode);
      if (!setResult.success) {
        toast.error(setResult.error || 'Failed to switch network mode');
        return;
      }
      setNetworkMode(targetMode);
      await window.kiyeovoAPI.restartApp();
    } catch (error) {
      toast.error(errStr(error, 'Failed to switch network mode'));
    } finally {
      setIsSwitchingMode(false);
    }
  };

  const handleQuitApp = async () => {
    if (isQuittingApp || isSwitchingMode) return;
    setIsQuittingApp(true);
    try {
      const result = await window.kiyeovoAPI.quitApp();
      if (!result.success) {
        toast.error(result.error || 'Failed to quit app');
        setIsQuittingApp(false);
      }
    } catch (error) {
      toast.error(errStr(error, 'Failed to quit app'));
      setIsQuittingApp(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <DialogBody className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading settings...</div>
            ) : (
              <div className="space-y-4">
                <SettingsActionRow
                  icon={<Info className="w-5 h-5 text-primary" />}
                  title="About Kiyeovo"
                  description="App info and resources"
                  action={(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAboutOpen(true)}
                    >
                      Open
                    </Button>
                  )}
                />
                <SettingsActionRow
                  icon={notificationsEnabled ? (
                    <Bell className="w-5 h-5 text-primary" />
                  ) : (
                    <BellOff className="w-5 h-5 text-muted-foreground" />
                  )}
                  title="Notifications & Sounds"
                  description={notificationsEnabled
                    ? "Enabled for all chats"
                    : "Disabled for all chats"}
                  action={(
                    <Button
                      variant={!notificationsEnabled ? "default" : "outline"}
                      size="sm"
                      onClick={handleToggleNotifications}
                    >
                      {notificationsEnabled ? "Disable" : "Enable"}
                    </Button>
                  )}
                />
                <SettingsActionRow
                  icon={<FolderOpen className="w-5 h-5 text-primary shrink-0" />}
                  title="Downloads Directory"
                  description={<span className="block truncate" title={downloadsDir}>{downloadsDir || 'Not set'}</span>}
                  contentClassName="flex-1 min-w-0"
                  bodyClassName="flex-1 min-w-0"
                  action={(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleChangeDownloadsDir}
                      className="shrink-0"
                    >
                      Change
                    </Button>
                  )}
                />
                {networkMode === 'anonymous' && <TorSettingsSection
                  torSettings={torSettings}
                  setTorSettings={setTorSettings}
                  originalTorSettings={originalTorSettings}
                  onConfirmRestart={handleConfirmTorRestart}
                  isAnonymousMode={networkMode === 'anonymous'}
                />}

                <SettingsActionRow
                  icon={<RefreshCw className="w-5 h-5 text-primary" />}
                  title="Switch Mode"
                  description={`Current: ${networkMode === 'anonymous' ? 'Anonymous' : 'Fast'} (restarts app)`}
                  action={(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { void handleSwitchNetworkMode(); }}
                      disabled={isSwitchingMode || isQuittingApp}
                    >
                      {isSwitchingMode
                        ? 'Switching...'
                        : `Switch to ${networkMode === 'anonymous' ? 'Fast' : 'Anonymous'}`}
                    </Button>
                  )}
                />

                <SettingsActionRow
                  icon={<Settings className="w-5 h-5 text-primary" />}
                  title="Configuration"
                  description="Performance and behavior settings"
                  action={(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfigDialogOpen(true)}
                    >
                      Open
                    </Button>
                  )}
                />

                <SettingsActionRow
                  icon={<Database className="w-5 h-5 text-primary shrink-0" />}
                  title="Backup Database"
                  description="Save a copy of all your data"
                  contentClassName="flex-1"
                  bodyClassName="flex-1"
                  action={(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleBackupDatabase}
                      className="shrink-0"
                    >
                      Backup
                    </Button>
                  )}
                />

                <SettingsActionRow
                  icon={<Trash2 className="w-5 h-5 text-destructive shrink-0" />}
                  title="Delete Account"
                  description="Permanently delete all data"
                  destructive
                  contentClassName="flex-1"
                  bodyClassName="flex-1"
                  action={(
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteAccountOpen(true)}
                      className="shrink-0"
                    >
                      Delete
                    </Button>
                  )}
                />

                <SettingsActionRow
                  icon={<Power className="w-5 h-5 text-primary shrink-0" />}
                  title="Quit App"
                  description="Close Kiyeovo completely"
                  contentClassName="flex-1"
                  bodyClassName="flex-1"
                  action={(
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { void handleQuitApp(); }}
                      disabled={isQuittingApp || isSwitchingMode}
                      className="shrink-0"
                    >
                      {isQuittingApp ? 'Quitting...' : 'Quit'}
                    </Button>
                  )}
                />
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
      <KiyeovoDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <TorRestartDialog
        open={torConfirmOpen}
        onOpenChange={setTorConfirmOpen}
        onCancel={handleCancelTorRestart}
        onConfirm={handleApplyTorSettings}
      />
      <DeleteAccountDialog
        open={deleteAccountOpen}
        onOpenChange={setDeleteAccountOpen}
        onConfirm={handleDeleteAccount}
      />
      <ConfigurationDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
      />
    </>
  );
};
