import { useEffect, useState, type FC, type ReactNode } from 'react';
import { Bell, BellOff, FolderOpen, Info, RefreshCw, Settings } from 'lucide-react';
import { NETWORK_MODES } from '../../../../core/constants';
import type { NetworkMode } from '../../../../core/types';
import { errStr } from '../../../../core/utils/general-error';
import { NetworkModeSwitchDialog } from '../../NetworkModeSwitchDialog';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/use-toast';
import { KiyeovoDialog } from '../header/KiyeovoDialog';

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

  useEffect(() => {
    let disposed = false;

    const unsubscribe = window.kiyeovoAPI.onNotificationsEnabledChanged((enabled) => {
      if (!disposed) {
        setNotificationsEnabled(enabled);
      }
    });

    const loadSettings = async () => {
      const [notificationsResult, downloadsResult, modeResult] = await Promise.allSettled([
        window.kiyeovoAPI.getNotificationsEnabled(),
        window.kiyeovoAPI.getDownloadsDir(),
        window.kiyeovoAPI.getNetworkMode(),
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
          </div>
        </div>
      </div>

      <KiyeovoDialog open={aboutOpen} onOpenChange={setAboutOpen} />
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
    </>
  );
};
