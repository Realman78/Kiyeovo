import { useState, type FC } from 'react';
import { useSelector } from 'react-redux';
import { AtSign, CheckCircle2, UserPlus } from 'lucide-react';
import type { RootState } from '../../../state/store';
import { Button } from '../../ui/Button';
import { RegisterIdentityDialog } from '../footer/RegisterIdentityDialog';

/**
 * Guided-setup step for registering a username. Optional and skippable — reuses the shared
 * `RegisterIdentityDialog` so registration logic stays in one place.
 */
export const WizardRegisterStep: FC = () => {
  const user = useSelector((state: RootState) => state.user);
  const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
  const [registerOpen, setRegisterOpen] = useState(false);

  return (
    <div className="h-full overflow-y-auto bg-sidebar-accent px-8 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-start flex-col gap-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <AtSign className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">Register a username</h1>
          </div>
          <p className="mt-0.5 text-md text-muted-foreground text-left">
            Registering publishes your username to the DHT so other people can discover you and start
            a chat. You can always register later from the Profile tab.
          </p>
        </header>

        <div className="mt-6 rounded-xl border border-border bg-card/55 p-6">
          {user.registered ? (
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-6 w-6 shrink-0 text-success" />
              <div className="min-w-0 text-left">
                <p className="truncate text-sm font-medium text-foreground" title={user.username}>
                  Registered as {user.username}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">{user.peerId}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">No username registered yet.</p>
              <Button
                className="shrink-0"
                onClick={() => setRegisterOpen(true)}
                disabled={registrationInProgress}
              >
                <UserPlus className="mr-1.5 h-4 w-4" />
                {registrationInProgress ? 'Registering…' : 'Register username'}
              </Button>
            </div>
          )}
        </div>
      </div>

      <RegisterIdentityDialog open={registerOpen} onOpenChange={setRegisterOpen} />
    </div>
  );
};

export default WizardRegisterStep;
