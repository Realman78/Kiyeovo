import { useEffect, useState, type FC, type ReactNode } from 'react';
import { Bell, BellOff, Info, Settings } from 'lucide-react';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/use-toast';
import { KiyeovoDialog } from '../header/KiyeovoDialog';

type SettingsActionRowProps = {
  icon: ReactNode;
  title: string;
  description: string;
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

  useEffect(() => {
    let disposed = false;

    const unsubscribe = window.kiyeovoAPI.onNotificationsEnabledChanged((enabled) => {
      if (!disposed) {
        setNotificationsEnabled(enabled);
      }
    });

    const loadNotificationsSetting = async () => {
      try {
        const result = await window.kiyeovoAPI.getNotificationsEnabled();
        if (disposed) return;

        if (result.success) {
          setNotificationsEnabled(result.enabled);
        } else {
          toast.error(result.error || 'Failed to load notification settings');
        }
      } catch (error) {
        if (!disposed) {
          console.error('Failed to load notification settings:', error);
          toast.error('Failed to load notification settings');
        }
      }
    };

    void loadNotificationsSetting();

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
          </div>
        </div>
      </div>

      <KiyeovoDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  );
};
