import { useEffect, useState, type FC } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AlertCircle, Check, Copy, Download, Settings2, ShieldCheck, User, UserPlus } from 'lucide-react';
import type { RootState } from '../../../state/store';
import { setRegistered, setRegistrationInProgress, setUsername } from '../../../state/slices/userSlice';
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from '../../../constants';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/use-toast';
import { RegisterIdentityDialog } from '../footer/RegisterIdentityDialog';
import UserDialog from '../footer/UserDialog';
import ExportDialog from './ExportDialog';

export const ProfilePage: FC = () => {
  const user = useSelector((state: RootState) => state.user);
  const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
  const pendingRegistrationUsername = useSelector((state: RootState) => state.user.pendingRegisterUsername || '');
  const [isCopied, setIsCopied] = useState(false);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [isUpdatingUsername, setIsUpdatingUsername] = useState(false);
  const [updateUsernameError, setUpdateUsernameError] = useState<string | undefined>(undefined);
  const [autoRegister, setAutoRegister] = useState(false);
  const [isSavingAutoRegister, setIsSavingAutoRegister] = useState(false);
  const dispatch = useDispatch();
  const { toast } = useToast();

  useEffect(() => {
    if (!user.registered) {
      setAutoRegister(false);
      return;
    }
    let disposed = false;
    void window.kiyeovoAPI.getAutoRegister().then((result) => {
      if (!disposed) {
        setAutoRegister(result.autoRegister);
      }
    });
    return () => {
      disposed = true;
    };
  }, [user.registered]);

  const handleCopyPeerId = () => {
    setIsCopied(true);
    navigator.clipboard.writeText(user.peerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  };

  const handleAutoRegisterToggle = async (enabled: boolean) => {
    const previousValue = autoRegister;
    setAutoRegister(enabled);
    setIsSavingAutoRegister(true);
    try {
      const result = await window.kiyeovoAPI.setAutoRegister(enabled);
      if (!result.success) {
        setAutoRegister(previousValue);
        toast.error(result.error || 'Failed to save auto-register preference', 'Preference not saved');
      }
    } catch (err) {
      console.error('Failed to save auto-register preference:', err);
      setAutoRegister(previousValue);
      toast.error(errStr(err, 'Failed to save auto-register preference'), 'Preference not saved');
    } finally {
      setIsSavingAutoRegister(false);
    }
  };

  const handleUsernameChange = async (username: string) => {
    setIsUpdatingUsername(true);
    setUpdateUsernameError(undefined);
    dispatch(setRegistrationInProgress({ inProgress: true, pendingUsername: username }));

    try {
      const result = await window.kiyeovoAPI.register(username, false);
      if (result.success) {
        setUserDialogOpen(false);
        setUpdateUsernameError(undefined);
        dispatch(setUsername(username));
        dispatch(setRegistered(true));
      } else {
        const message = result.error || 'Failed to register username';
        setUpdateUsernameError(message);
        toast.error(message, 'Username registration failed');
      }
    } catch (err) {
      console.error('Registration error:', err);
      const message = errStr(err, UNEXPECTED_ERROR);
      setUpdateUsernameError(message);
      toast.error(message, 'Username registration failed');
    } finally {
      setIsUpdatingUsername(false);
      dispatch(setRegistrationInProgress({ inProgress: false, pendingUsername: '' }));
    }
  };

  return (
    <>
      <div className="h-full overflow-y-auto bg-background py-8">
        <div className="mx-auto w-full max-w-4xl px-8 py-10">
          <header className="flex flex-col items-start gap-3.5">
            <div className="mb-8 flex items-center gap-2">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                <User className="h-5 w-5" />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Profile</h1>
            </div>
          </header>

          {user.registered ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-6 rounded-lg border border-border bg-background/60 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="relative">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary">
                      <User className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background bg-success" />
                  </div>
                  <div className="min-w-0 text-left">
                    <p className="truncate font-mono text-sm font-medium text-foreground">{user.username}</p>
                    <div className="flex items-center gap-1">
                      <p className='font-mono text-xs text-foreground'>
                        Peer ID: <span title={user.peerId}
                          className="cursor-pointer truncate font-mono text-xs text-success"
                          onClick={handleCopyPeerId}>
                          {user.peerId}
                        </span>
                      </p>
                      <button
                        type="button"
                        className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
                        onClick={handleCopyPeerId}
                      >
                        {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setUserDialogOpen(true)}
                >
                  <Settings2 className="mr-1.5 h-4 w-4" />
                  Manage identity
                </Button>
              </div>

              <div className="flex items-center justify-between gap-6 rounded-lg border border-border bg-background/60 p-4">
                <div className="min-w-0 text-left">
                  <p className="text-sm font-medium text-foreground">Auto-register username</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Automatically restore your username when the app starts (if username not taken)
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoRegister}
                  aria-label="Auto-register username"
                  onClick={() => handleAutoRegisterToggle(!autoRegister)}
                  disabled={isSavingAutoRegister}
                  className={`relative shrink-0 cursor-pointer inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoRegister ? 'bg-primary hover:bg-primary/80' : 'bg-input hover:bg-input/80'
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${autoRegister ? 'translate-x-6' : 'translate-x-1'
                      }`}
                  />
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-lg border border-border bg-background/60 p-4">
                <User className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">Peer ID: {user.peerId || 'Connecting...'}</p>
                    {user.peerId && (
                      <button
                        type="button"
                        className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
                        onClick={handleCopyPeerId}
                      >
                        {isCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-5">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                  <div className="min-w-0 text-left">
                    <p className="text-sm font-medium text-foreground">You haven&apos;t registered a username</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Registering publishes your username through the DHT so other users can discover
                      you and start a chat. It&apos;s optional &mdash; if you only talk to existing
                      contacts you don&apos;t have to register &mdash; but it&apos;s recommended when
                      you first set up the app.
                    </p>
                    <Button
                      className="mt-4"
                      size="sm"
                      onClick={() => setRegisterDialogOpen(true)}
                      disabled={registrationInProgress}
                    >
                      <UserPlus className="mr-1.5 h-4 w-4" />
                      {registrationInProgress
                        ? `Registering as${pendingRegistrationUsername ? ` ${pendingRegistrationUsername}` : ''}...`
                        : 'Register username'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 rounded-lg border border-border bg-background/60 p-5">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0 text-left">
                <p className="text-sm font-medium text-foreground">Trusted profile</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Export an encrypted profile file and hand it to someone you trust out-of-band (a
                  call, in person). They import it to message you directly &mdash; no username lookup
                  needed, and it works even if you never register a public username. The password
                  encrypts the file; the separate shared secret defines your offline mailbox. Verify
                  the fingerprint with them and use a unique shared secret per contact.
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  onClick={() => setExportDialogOpen(true)}
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  Export trusted profile
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <UserDialog
        open={userDialogOpen}
        onOpenChange={setUserDialogOpen}
        onRegister={handleUsernameChange}
        isRegistering={isUpdatingUsername}
        backendError={updateUsernameError}
      />
      <RegisterIdentityDialog
        open={registerDialogOpen}
        onOpenChange={setRegisterDialogOpen}
      />
      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
      />
    </>
  );
};

export default ProfilePage;
