import { useEffect, useState, type FC, type ReactNode } from 'react';
import { useSelector } from 'react-redux';
import {
  Bell,
  BellOff,
  Clock,
  Database,
  FolderOpen,
  Info,
  LogIn,
  Minimize2,
  Power,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { RootState } from '../../../state/store';
import { TimeFormatDialog } from './TimeFormatDialog';
import { NETWORK_MODES } from '../../../../core/constants';
import type { NetworkMode } from '../../../../core/types';
import { errStr } from '../../../../core/utils/general-error';
import { NetworkModeSwitchDialog } from '../../NetworkModeSwitchDialog';
import { TOR_CONFIG } from '../../../constants';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/use-toast';
import { BackupPasswordDialog } from '../../backup/BackupPasswordDialog';
import { ConfigurationDialog } from '../footer/ConfigurationDialog';
import { DeleteAccountDialog } from '../footer/DeleteAccountDialog';
import { KiyeovoDialog } from '../header/KiyeovoDialog';
import { QuitAppDialog } from './QuitAppDialog';
import { TorRestartDialog } from './TorRestartDialog';
import { TorSettingsSection, type TorSettings } from './TorSettingsSection';

type SettingsActionRowProps = {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action: ReactNode;
};

const SettingsActionRow: FC<SettingsActionRowProps> = ({
  icon,
  title,
  description,
  action,
}) => (
  <div className="flex items-center justify-between gap-6 rounded-lg border border-border bg-background/60 p-4">
    <div className="flex min-w-0 items-center gap-3">
      {icon}
      <div className="min-w-0 text-left">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
    <div className="shrink-0">{action}</div>
  </div>
);

const DEFAULT_TOR_SETTINGS: TorSettings = {
  socksHost: TOR_CONFIG.DEFAULT_SOCKS_HOST,
  socksPort: TOR_CONFIG.DEFAULT_SOCKS_PORT,
  connectionTimeout: TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
  circuitTimeout: TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT,
  maxRetries: TOR_CONFIG.DEFAULT_MAX_RETRIES,
  healthCheckInterval: TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL,
  dnsResolution: TOR_CONFIG.DNS_RESOLUTION_TOR as TorSettings['dnsResolution'],
};

export const SettingsPage: FC = () => {
  const { toast } = useToast();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null);
  const [updatingNotifications, setUpdatingNotifications] = useState(false);
  const [downloadsDir, setDownloadsDir] = useState<string | null>(null);
  const [changingDownloadsDir, setChangingDownloadsDir] = useState(false);
  const [networkMode, setNetworkMode] = useState<NetworkMode | null>(null);
  const [modeSwitchOpen, setModeSwitchOpen] = useState(false);
  const [isSwitchingNetworkMode, setIsSwitchingNetworkMode] = useState(false);
  const [pendingRestartMode, setPendingRestartMode] = useState<NetworkMode | null>(null);
  const [torSettings, setTorSettings] = useState<TorSettings>(DEFAULT_TOR_SETTINGS);
  const [originalTorSettings, setOriginalTorSettings] = useState<TorSettings>(DEFAULT_TOR_SETTINGS);
  const [pendingTorSettings, setPendingTorSettings] = useState<TorSettings>(DEFAULT_TOR_SETTINGS);
  const [torConfirmOpen, setTorConfirmOpen] = useState(false);
  const [applyingTorSettings, setApplyingTorSettings] = useState(false);
  const [torRestartRequired, setTorRestartRequired] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [backingUpDatabase, setBackingUpDatabase] = useState(false);
  const [backupPasswordDialogOpen, setBackupPasswordDialogOpen] = useState(false);
  const [pendingBackupPath, setPendingBackupPath] = useState<string | null>(null);
  const [backupPasswordError, setBackupPasswordError] = useState<string | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [quitAppOpen, setQuitAppOpen] = useState(false);
  const [quittingApp, setQuittingApp] = useState(false);
  const [timeFormatOpen, setTimeFormatOpen] = useState(false);
  const timeFormat = useSelector((state: RootState) => state.uiPrefs.timeFormat);
  const [closeToTrayEnabled, setCloseToTrayEnabledState] = useState<boolean | null>(null);
  const [updatingCloseToTray, setUpdatingCloseToTray] = useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabledState] = useState<boolean | null>(null);
  const [updatingMinimizeToTray, setUpdatingMinimizeToTray] = useState(false);
  const [launchOnLoginEnabled, setLaunchOnLoginEnabledState] = useState<boolean | null>(null);
  const [updatingLaunchOnLogin, setUpdatingLaunchOnLogin] = useState(false);

  useEffect(() => {
    let disposed = false;

    const unsubscribe = window.kiyeovoAPI.onNotificationsEnabledChanged((enabled) => {
      if (!disposed) {
        setNotificationsEnabled(enabled);
      }
    });

    const loadSettings = async () => {
      const [
        notificationsResult,
        downloadsResult,
        modeResult,
        torResult,
        closeToTrayResult,
        minimizeToTrayResult,
        launchOnLoginResult,
      ] = await Promise.allSettled([
        window.kiyeovoAPI.getNotificationsEnabled(),
        window.kiyeovoAPI.getDownloadsDir(),
        window.kiyeovoAPI.getNetworkMode(),
        window.kiyeovoAPI.getTorSettings(),
        window.kiyeovoAPI.getCloseToTrayEnabled(),
        window.kiyeovoAPI.getMinimizeToTrayEnabled(),
        window.kiyeovoAPI.getLaunchOnLoginEnabled(),
      ]);
      if (disposed) return;

      if (notificationsResult.status === 'fulfilled' && notificationsResult.value.success) {
        setNotificationsEnabled(notificationsResult.value.enabled);
      } else {
        const message = notificationsResult.status === 'fulfilled'
          ? notificationsResult.value.error
          : errStr(notificationsResult.reason);
        toast.error(message || 'Failed to load notification settings');
      }

      if (closeToTrayResult.status === 'fulfilled' && closeToTrayResult.value.success) {
        setCloseToTrayEnabledState(closeToTrayResult.value.enabled);
      } else {
        const message = closeToTrayResult.status === 'fulfilled'
          ? closeToTrayResult.value.error
          : errStr(closeToTrayResult.reason);
        toast.error(message || 'Failed to load close-to-tray setting');
      }

      if (minimizeToTrayResult.status === 'fulfilled' && minimizeToTrayResult.value.success) {
        setMinimizeToTrayEnabledState(minimizeToTrayResult.value.enabled);
      } else {
        const message = minimizeToTrayResult.status === 'fulfilled'
          ? minimizeToTrayResult.value.error
          : errStr(minimizeToTrayResult.reason);
        toast.error(message || 'Failed to load minimize-to-tray setting');
      }

      if (launchOnLoginResult.status === 'fulfilled' && launchOnLoginResult.value.success) {
        setLaunchOnLoginEnabledState(launchOnLoginResult.value.enabled);
      } else {
        const message = launchOnLoginResult.status === 'fulfilled'
          ? launchOnLoginResult.value.error
          : errStr(launchOnLoginResult.reason);
        toast.error(message || 'Failed to load launch-on-login setting');
      }

      if (downloadsResult.status === 'fulfilled' && downloadsResult.value.success) {
        setDownloadsDir(downloadsResult.value.path);
      } else {
        const message = downloadsResult.status === 'fulfilled'
          ? downloadsResult.value.error
          : errStr(downloadsResult.reason);
        toast.error(message || 'Failed to load downloads directory');
      }

      if (modeResult.status === 'fulfilled' && modeResult.value.success) {
        setNetworkMode(modeResult.value.mode);
      } else {
        const message = modeResult.status === 'fulfilled'
          ? modeResult.value.error
          : errStr(modeResult.reason);
        toast.error(message || 'Failed to load network mode');
      }

      if (
        torResult.status === 'fulfilled'
        && torResult.value.success
        && torResult.value.settings
      ) {
        const settings = torResult.value.settings;
        const loadedSettings: TorSettings = {
          socksHost: settings.socksHost || TOR_CONFIG.DEFAULT_SOCKS_HOST,
          socksPort: settings.socksPort
            ? Number.parseInt(settings.socksPort, 10)
            : TOR_CONFIG.DEFAULT_SOCKS_PORT,
          connectionTimeout: settings.connectionTimeout
            ? Number.parseInt(settings.connectionTimeout, 10)
            : TOR_CONFIG.DEFAULT_CONNECTION_TIMEOUT,
          circuitTimeout: settings.circuitTimeout
            ? Number.parseInt(settings.circuitTimeout, 10)
            : TOR_CONFIG.DEFAULT_CIRCUIT_TIMEOUT,
          maxRetries: settings.maxRetries
            ? Number.parseInt(settings.maxRetries, 10)
            : TOR_CONFIG.DEFAULT_MAX_RETRIES,
          healthCheckInterval: settings.healthCheckInterval
            ? Number.parseInt(settings.healthCheckInterval, 10)
            : TOR_CONFIG.DEFAULT_HEALTH_CHECK_INTERVAL,
          dnsResolution: settings.dnsResolution === TOR_CONFIG.DNS_RESOLUTION_SYSTEM
            ? 'system'
            : 'tor',
        };
        setTorSettings(loadedSettings);
        setOriginalTorSettings(loadedSettings);
        setPendingTorSettings(loadedSettings);
      } else {
        const message = torResult.status === 'fulfilled'
          ? torResult.value.error
          : errStr(torResult.reason);
        toast.error(message || 'Failed to load Tor settings');
      }
    };

    const load = async () => {
      try {
        await loadSettings();
      } catch (error) {
        if (!disposed) {
          console.error('Failed to load settings:', error);
          toast.error('Failed to load settings');
        }
      }
    };

    void load();

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [toast]);

  const handleToggleNotifications = async () => {
    if (notificationsEnabled === null || updatingNotifications) return;

    const previousValue = notificationsEnabled;
    const nextValue = !previousValue;
    setNotificationsEnabled(nextValue);
    setUpdatingNotifications(true);

    try {
      const result = await window.kiyeovoAPI.setNotificationsEnabled(nextValue);
      if (!result.success) {
        setNotificationsEnabled(previousValue);
        toast.error(result.error || 'Failed to update notification settings');
      }
    } catch (error) {
      console.error('Failed to update notification settings:', error);
      setNotificationsEnabled(previousValue);
      toast.error('Failed to update notification settings');
    } finally {
      setUpdatingNotifications(false);
    }
  };

  const handleToggleCloseToTray = async () => {
    if (closeToTrayEnabled === null || updatingCloseToTray) return;

    const previousValue = closeToTrayEnabled;
    const nextValue = !previousValue;
    setCloseToTrayEnabledState(nextValue);
    setUpdatingCloseToTray(true);

    try {
      const result = await window.kiyeovoAPI.setCloseToTrayEnabled(nextValue);
      if (!result.success) {
        setCloseToTrayEnabledState(previousValue);
        toast.error(result.error || 'Failed to update close-to-tray setting');
      }
    } catch (error) {
      console.error('Failed to update close-to-tray setting:', error);
      setCloseToTrayEnabledState(previousValue);
      toast.error('Failed to update close-to-tray setting');
    } finally {
      setUpdatingCloseToTray(false);
    }
  };

  const handleToggleMinimizeToTray = async () => {
    if (minimizeToTrayEnabled === null || updatingMinimizeToTray) return;

    const previousValue = minimizeToTrayEnabled;
    const nextValue = !previousValue;
    setMinimizeToTrayEnabledState(nextValue);
    setUpdatingMinimizeToTray(true);

    try {
      const result = await window.kiyeovoAPI.setMinimizeToTrayEnabled(nextValue);
      if (!result.success) {
        setMinimizeToTrayEnabledState(previousValue);
        toast.error(result.error || 'Failed to update minimize-to-tray setting');
      }
    } catch (error) {
      console.error('Failed to update minimize-to-tray setting:', error);
      setMinimizeToTrayEnabledState(previousValue);
      toast.error('Failed to update minimize-to-tray setting');
    } finally {
      setUpdatingMinimizeToTray(false);
    }
  };

  const handleToggleLaunchOnLogin = async () => {
    if (launchOnLoginEnabled === null || updatingLaunchOnLogin) return;

    const previousValue = launchOnLoginEnabled;
    const nextValue = !previousValue;
    setLaunchOnLoginEnabledState(nextValue);
    setUpdatingLaunchOnLogin(true);

    try {
      const result = await window.kiyeovoAPI.setLaunchOnLoginEnabled(nextValue);
      if (!result.success) {
        setLaunchOnLoginEnabledState(previousValue);
        toast.error(result.error || 'Failed to update launch-on-login setting');
      }
    } catch (error) {
      console.error('Failed to update launch-on-login setting:', error);
      setLaunchOnLoginEnabledState(previousValue);
      toast.error('Failed to update launch-on-login setting');
    } finally {
      setUpdatingLaunchOnLogin(false);
    }
  };

  const notificationsLoading = notificationsEnabled === null;
  const targetMode = networkMode === NETWORK_MODES.ANONYMOUS
    ? NETWORK_MODES.FAST
    : NETWORK_MODES.ANONYMOUS;
  const currentModeLabel = networkMode === NETWORK_MODES.ANONYMOUS ? 'Anonymous' : 'Fast';
  const targetModeLabel = targetMode === NETWORK_MODES.ANONYMOUS ? 'Anonymous' : 'Fast';

  const handleChangeDownloadsDir = async () => {
    if (changingDownloadsDir) return;

    setChangingDownloadsDir(true);
    try {
      const result = await window.kiyeovoAPI.showOpenDialog({
        title: 'Select Downloads Directory',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePath) return;

      const setResult = await window.kiyeovoAPI.setDownloadsDir(result.filePath);
      if (!setResult.success) {
        toast.error(setResult.error || 'Failed to update downloads directory');
        return;
      }
      setDownloadsDir(result.filePath);
    } catch (error) {
      console.error('Failed to change downloads directory:', error);
      toast.error(errStr(error, 'Failed to change downloads directory'));
    } finally {
      setChangingDownloadsDir(false);
    }
  };

  const restartForSavedMode = async (savedMode: NetworkMode) => {
    const restartResult = await window.kiyeovoAPI.restartApp();
    if (!restartResult.success) {
      setPendingRestartMode(savedMode);
      setModeSwitchOpen(false);
      toast.error(
        `${restartResult.error || 'Failed to restart the app'}. ${
          savedMode === NETWORK_MODES.ANONYMOUS ? 'Anonymous' : 'Fast'
        } mode was saved; restart Kiyeovo manually to apply it.`,
      );
    }
  };

  const handleSwitchNetworkMode = async (nextMode: NetworkMode) => {
    if (isSwitchingNetworkMode || networkMode === null) return;

    setIsSwitchingNetworkMode(true);
    let modeSaved = false;
    try {
      const setResult = await window.kiyeovoAPI.setNetworkMode(nextMode);
      if (!setResult.success) {
        toast.error(setResult.error || 'Failed to switch network mode');
        return;
      }

      modeSaved = true;
      await restartForSavedMode(nextMode);
    } catch (error) {
      const message = errStr(error, 'Failed to switch network mode');
      if (modeSaved) {
        setPendingRestartMode(nextMode);
        setModeSwitchOpen(false);
        toast.error(`${message}. The new mode was saved; restart Kiyeovo manually to apply it.`);
      } else {
        toast.error(message);
      }
    } finally {
      setIsSwitchingNetworkMode(false);
    }
  };

  const handleRestartForPendingMode = async () => {
    if (!pendingRestartMode || isSwitchingNetworkMode) return;

    setIsSwitchingNetworkMode(true);
    try {
      await restartForSavedMode(pendingRestartMode);
    } catch (error) {
      toast.error(errStr(error, 'Failed to restart the app'));
    } finally {
      setIsSwitchingNetworkMode(false);
    }
  };

  const handleConfirmTorRestart = (updatedSettings: TorSettings) => {
    setPendingTorSettings(updatedSettings);
    setTorConfirmOpen(true);
  };

  const handleApplyTorSettings = async () => {
    if (applyingTorSettings) return;

    setApplyingTorSettings(true);
    let settingsSaved = false;
    try {
      const result = await window.kiyeovoAPI.setTorSettings(pendingTorSettings);
      if (!result.success) {
        toast.error(result.error || 'Failed to update Tor settings');
        return;
      }

      settingsSaved = true;
      setTorSettings(pendingTorSettings);
      setOriginalTorSettings(pendingTorSettings);
      setTorConfirmOpen(false);

      const restartResult = await window.kiyeovoAPI.restartApp();
      if (!restartResult.success) {
        setTorRestartRequired(true);
        toast.error(
          `${restartResult.error || 'Failed to restart the app'}. Tor settings were saved; restart Kiyeovo manually to apply them.`,
        );
      }
    } catch (error) {
      const message = errStr(error, 'Failed to apply Tor settings');
      if (settingsSaved) {
        setTorRestartRequired(true);
        setTorConfirmOpen(false);
        toast.error(`${message}. Tor settings were saved; restart Kiyeovo manually to apply them.`);
      } else {
        toast.error(message);
      }
    } finally {
      setApplyingTorSettings(false);
    }
  };

  const handleRestartForTorSettings = async () => {
    if (applyingTorSettings) return;

    setApplyingTorSettings(true);
    try {
      const result = await window.kiyeovoAPI.restartApp();
      if (!result.success) {
        toast.error(result.error || 'Failed to restart the app');
      }
    } catch (error) {
      toast.error(errStr(error, 'Failed to restart the app'));
    } finally {
      setApplyingTorSettings(false);
    }
  };

  const handleCancelTorRestart = () => {
    if (applyingTorSettings) return;
    setTorSettings(originalTorSettings);
    setPendingTorSettings(originalTorSettings);
    setTorConfirmOpen(false);
  };

  const handleBackupDatabase = async () => {
    if (backingUpDatabase || backupPasswordDialogOpen) return;

    setBackingUpDatabase(true);
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const result = await window.kiyeovoAPI.showSaveDialog({
        title: 'Save Database Backup',
        defaultPath: `kiyeovo-backup-${timestamp}.kiyeovo-db-backup`,
        filters: [
          { name: 'Database Backup', extensions: ['kiyeovo-db-backup'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return;

      setPendingBackupPath(result.filePath);
      setBackupPasswordError(null);
      setBackupPasswordDialogOpen(true);
    } catch (error) {
      console.error('Failed to choose database backup path:', error);
      toast.error(errStr(error, 'Failed to choose database backup path'));
    } finally {
      setBackingUpDatabase(false);
    }
  };

  const handleBackupPasswordOpenChange = (open: boolean) => {
    if (open) {
      setBackupPasswordDialogOpen(true);
      return;
    }
    if (backingUpDatabase) return;

    setBackupPasswordDialogOpen(false);
    setPendingBackupPath(null);
    setBackupPasswordError(null);
  };

  const handleConfirmBackupPassword = async (backupPassword: string) => {
    if (!pendingBackupPath || backingUpDatabase) return;

    setBackingUpDatabase(true);
    setBackupPasswordError(null);
    try {
      const backupResult = await window.kiyeovoAPI.backupDatabase(pendingBackupPath, backupPassword);
      if (!backupResult.success) {
        const message = backupResult.error || 'Failed to back up database';
        setBackupPasswordError(message);
        toast.error(message);
        return;
      }

      toast.success('Database backup saved');
      setBackupPasswordDialogOpen(false);
      setPendingBackupPath(null);
    } catch (error) {
      console.error('Failed to back up database:', error);
      const message = errStr(error, 'Failed to back up database');
      setBackupPasswordError(message);
      toast.error(message);
    } finally {
      setBackingUpDatabase(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deletingAccount) return;

    setDeletingAccount(true);
    try {
      const result = await window.kiyeovoAPI.deleteAccountAndData();
      if (!result.success) {
        toast.error(result.error || 'Failed to delete account');
        setDeletingAccount(false);
      }
    } catch (error) {
      console.error('Failed to delete account:', error);
      toast.error(errStr(error, 'Failed to delete account'));
      setDeletingAccount(false);
    }
  };

  const handleQuitApp = async () => {
    if (quittingApp) return;

    setQuittingApp(true);
    try {
      const result = await window.kiyeovoAPI.quitApp();
      if (!result.success) {
        toast.error(result.error || 'Failed to quit app');
        setQuittingApp(false);
        setQuitAppOpen(false);
      }
    } catch (error) {
      console.error('Failed to quit app:', error);
      toast.error(errStr(error, 'Failed to quit app'));
      setQuittingApp(false);
      setQuitAppOpen(false);
    }
  };

  return (
    <>
      <div className="h-full overflow-y-auto bg-background py-8">
        <div className="mx-auto w-full max-w-4xl px-8 py-10">
        <header className="flex flex-col items-start gap-3.5">
          <div className="flex items-center gap-2 mb-8">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Settings className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
          </div>
        </header>

          <div className="space-y-3">
            <SettingsActionRow
              icon={<Info className="h-5 w-5 shrink-0 text-primary" />}
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
              icon={notificationsEnabled === false ? (
                <BellOff className="h-5 w-5 shrink-0 text-muted-foreground" />
              ) : (
                <Bell className="h-5 w-5 shrink-0 text-primary" />
              )}
              title="Notifications & Sounds"
              description={notificationsLoading
                ? 'Loading current preference...'
                : notificationsEnabled
                  ? 'Enabled for all chats'
                  : 'Disabled for all chats'}
              action={(
                <Button
                  variant={notificationsEnabled === false ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { void handleToggleNotifications(); }}
                  disabled={notificationsLoading || updatingNotifications}
                >
                  {updatingNotifications
                    ? 'Saving...'
                    : notificationsEnabled === false
                      ? 'Enable'
                      : 'Disable'}
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<Clock className="h-5 w-5 shrink-0 text-primary" />}
              title="Time format"
              description={timeFormat === '12h' ? '12-hour (AM/PM)' : '24-hour'}
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTimeFormatOpen(true)}
                >
                  Change
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<FolderOpen className="h-5 w-5 shrink-0 text-primary" />}
              title="Downloads Directory"
              description={(
                <span className="block truncate" title={downloadsDir ?? undefined}>
                  {downloadsDir ?? 'Loading current directory...'}
                </span>
              )}
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { void handleChangeDownloadsDir(); }}
                  disabled={downloadsDir === null || changingDownloadsDir}
                >
                  {changingDownloadsDir ? 'Changing...' : 'Change'}
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<RefreshCw className="h-5 w-5 shrink-0 text-primary" />}
              title="Switch Mode"
              description={networkMode === null
                ? 'Loading current mode...'
                : pendingRestartMode
                  ? `${pendingRestartMode === NETWORK_MODES.ANONYMOUS ? 'Anonymous' : 'Fast'} mode saved; restart required`
                  : `Current: ${currentModeLabel} (restarts app)`}
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (pendingRestartMode) {
                      void handleRestartForPendingMode();
                    } else {
                      setModeSwitchOpen(true);
                    }
                  }}
                  disabled={networkMode === null || isSwitchingNetworkMode}
                >
                  {isSwitchingNetworkMode
                    ? 'Restarting...'
                    : pendingRestartMode
                      ? 'Restart app'
                      : `Switch to ${targetModeLabel}`}
                </Button>
              )}
            />

            {networkMode === NETWORK_MODES.ANONYMOUS && (
              <TorSettingsSection
                torSettings={torSettings}
                setTorSettings={setTorSettings}
                originalTorSettings={originalTorSettings}
                onConfirmRestart={handleConfirmTorRestart}
                restartRequired={torRestartRequired}
                restarting={applyingTorSettings}
                onRestart={() => { void handleRestartForTorSettings(); }}
              />
            )}

            <SettingsActionRow
              icon={<SlidersHorizontal className="h-5 w-5 shrink-0 text-primary" />}
              title="Configuration"
              description="Performance and behavior settings"
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfigurationOpen(true)}
                >
                  Open
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<Database className="h-5 w-5 shrink-0 text-primary" />}
              title="Backup Database"
              description="Save a copy of all your data"
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { void handleBackupDatabase(); }}
                  disabled={backingUpDatabase || backupPasswordDialogOpen}
                >
                  {backingUpDatabase ? 'Backing up...' : 'Backup'}
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<Trash2 className="h-5 w-5 shrink-0 text-destructive" />}
              title="Delete Account"
              description={deletingAccount
                ? 'Deleting all account data and restarting...'
                : 'Permanently delete all data'}
              action={(
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteAccountOpen(true)}
                  disabled={deletingAccount}
                >
                  {deletingAccount ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            />

            <h2 className="pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              System
            </h2>

            <SettingsActionRow
              icon={<X className="h-5 w-5 shrink-0 text-primary" />}
              title="Close to Tray"
              description={closeToTrayEnabled === null
                ? 'Loading current preference...'
                : `${closeToTrayEnabled ? 'Closing the window hides it to the tray' : 'Closing the window quits Kiyeovo'} (Windows/Linux only)`}
              action={(
                <Button
                  variant={closeToTrayEnabled === false ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { void handleToggleCloseToTray(); }}
                  disabled={closeToTrayEnabled === null || updatingCloseToTray}
                >
                  {updatingCloseToTray
                    ? 'Saving...'
                    : closeToTrayEnabled === false
                      ? 'Enable'
                      : 'Disable'}
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<Minimize2 className="h-5 w-5 shrink-0 text-primary" />}
              title="Minimize to Tray"
              description={minimizeToTrayEnabled === null
                ? 'Loading current preference...'
                : `${minimizeToTrayEnabled ? 'Minimizing the window hides it to the tray' : 'Minimizing uses the normal taskbar behavior'} (Windows/Linux only)`}
              action={(
                <Button
                  variant={minimizeToTrayEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { void handleToggleMinimizeToTray(); }}
                  disabled={minimizeToTrayEnabled === null || updatingMinimizeToTray}
                >
                  {updatingMinimizeToTray
                    ? 'Saving...'
                    : minimizeToTrayEnabled
                      ? 'Disable'
                      : 'Enable'}
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<LogIn className="h-5 w-5 shrink-0 text-primary" />}
              title="Launch on Login"
              description={launchOnLoginEnabled === null
                ? 'Loading current preference...'
                : launchOnLoginEnabled
                  ? 'Kiyeovo starts automatically (hidden in the tray) when you log in'
                  : 'Kiyeovo does not start automatically at login'}
              action={(
                <Button
                  variant={launchOnLoginEnabled ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => { void handleToggleLaunchOnLogin(); }}
                  disabled={launchOnLoginEnabled === null || updatingLaunchOnLogin}
                >
                  {updatingLaunchOnLogin
                    ? 'Saving...'
                    : launchOnLoginEnabled
                      ? 'Disable'
                      : 'Enable'}
                </Button>
              )}
            />

            <SettingsActionRow
              icon={<Power className="h-5 w-5 shrink-0 text-primary" />}
              title="Quit App"
              description="Close Kiyeovo completely"
              action={(
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setQuitAppOpen(true)}
                  disabled={quittingApp}
                >
                  {quittingApp ? 'Quitting...' : 'Quit'}
                </Button>
              )}
            />
          </div>
        </div>
      </div>

      <KiyeovoDialog open={aboutOpen} onOpenChange={setAboutOpen} />
      <BackupPasswordDialog
        open={backupPasswordDialogOpen}
        onOpenChange={handleBackupPasswordOpenChange}
        title="Encrypt Database Backup"
        description="Use a backup password separate from your login password."
        confirmLabel="Save Backup"
        submittingLabel="Saving..."
        requireConfirmation
        submitting={backingUpDatabase}
        error={backupPasswordError}
        onSubmit={handleConfirmBackupPassword}
      />
      <TimeFormatDialog open={timeFormatOpen} onOpenChange={setTimeFormatOpen} />
      <ConfigurationDialog
        open={configurationOpen}
        onOpenChange={setConfigurationOpen}
      />
      <DeleteAccountDialog
        open={deleteAccountOpen}
        onOpenChange={(open) => {
          if (!deletingAccount) {
            setDeleteAccountOpen(open);
          }
        }}
        onConfirm={() => { void handleDeleteAccount(); }}
      />
      <QuitAppDialog
        open={quitAppOpen}
        onOpenChange={setQuitAppOpen}
        onConfirm={() => { void handleQuitApp(); }}
        quitting={quittingApp}
      />
      <NetworkModeSwitchDialog
        open={modeSwitchOpen}
        onOpenChange={(open) => {
          if (!isSwitchingNetworkMode) {
            setModeSwitchOpen(open);
          }
        }}
        targetMode={targetMode}
        targetModeLabel={targetModeLabel}
        onConfirm={handleSwitchNetworkMode}
        isSwitchingNetworkMode={isSwitchingNetworkMode}
      />
      <TorRestartDialog
        open={torConfirmOpen}
        onOpenChange={(open) => {
          if (!applyingTorSettings) {
            setTorConfirmOpen(open);
          }
        }}
        onCancel={handleCancelTorRestart}
        onConfirm={() => { void handleApplyTorSettings(); }}
        applying={applyingTorSettings}
      />
    </>
  );
};
