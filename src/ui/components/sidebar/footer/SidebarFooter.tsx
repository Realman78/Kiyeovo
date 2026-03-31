import { useEffect, useState, type FC } from "react";
import { RegisterButton } from "./RegisterButton";
import type { RootState } from "../../../state/store";
import { useDispatch, useSelector } from "react-redux";
import { Check, Copy, Settings, User } from "lucide-react";
import { Button } from "../../ui/Button";
import UserDialog from "./UserDialog";
import { setRegistered, setRegistrationInProgress, setUsername } from "../../../state/slices/userSlice";
import { SettingsDialog } from "./SettingsDialog";
import RegisterDialog from "./RegisterDialog";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";

type SidebarFooterProps = {
  collapsed?: boolean;
};

export const SidebarFooter: FC<SidebarFooterProps> = ({ collapsed = false }) => {
  const user = useSelector((state: RootState) => state.user);
  const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
  const pendingRegistrationUsername = useSelector((state: RootState) => state.user.pendingRegisterUsername || "");
  const [isCopied, setIsCopied] = useState(false);
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false);
  const [isUpdatingUsername, setIsUpdatingUsername] = useState(false);
  const [updateUsernameError, setUpdateUsernameError] = useState<string | undefined>(undefined);
  const [isRegisteringIdentity, setIsRegisteringIdentity] = useState(false);
  const [registerIdentityError, setRegisterIdentityError] = useState<string | undefined>(undefined);
  const [pendingRegisterUsername, setPendingRegisterUsername] = useState("");
  const dispatch = useDispatch();
  const effectiveIsRegistering = isRegisteringIdentity || registrationInProgress;
  const effectivePendingUsername = pendingRegisterUsername || pendingRegistrationUsername;

  useEffect(() => {
    if (!registerDialogOpen || !user.registered) {
      return;
    }
    setRegisterDialogOpen(false);
    setRegisterIdentityError(undefined);
  }, [registerDialogOpen, user.registered]);

  const handleSettings = () => {
    setSettingsDialogOpen(true);
  }

  const handleCopyPeerId = () => {
    setIsCopied(true);
    navigator.clipboard.writeText(user.peerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  }

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
            setUpdateUsernameError(result.error || 'Failed to register username');
        }
    } catch (err) {
        console.error('Registration error:', err);
        setUpdateUsernameError(errStr(err, UNEXPECTED_ERROR));
    } finally {
        setIsUpdatingUsername(false);
        dispatch(setRegistrationInProgress({ inProgress: false, pendingUsername: '' }));
    }
  };

  const handleRegisterIdentity = async (username: string, rememberMe: boolean) => {
    setIsRegisteringIdentity(true);
    setRegisterIdentityError(undefined);
    setPendingRegisterUsername(username);
    dispatch(setRegistrationInProgress({ inProgress: true, pendingUsername: username }));

    try {
      const result = await window.kiyeovoAPI.register(username, rememberMe);
      if (result.success) {
        dispatch(setUsername(username));
        dispatch(setRegistered(true));
        setRegisterIdentityError(undefined);
        setRegisterDialogOpen(false);
      } else {
        setRegisterIdentityError(result.error || 'Failed to register username');
      }
    } catch (err) {
      console.error('Registration error:', err);
      setRegisterIdentityError(errStr(err, UNEXPECTED_ERROR));
    } finally {
        setIsRegisteringIdentity(false);
        dispatch(setRegistrationInProgress({ inProgress: false, pendingUsername: '' }));
    }
  };

  return <div className={`flex border-t border-sidebar-border bg-sidebar-accent/50 ${collapsed ? "h-24 p-2" : "h-20 p-3"}`}>
    <div className={`flex w-full ${collapsed ? "flex-col items-center justify-between" : "items-center gap-3"}`}>
      {collapsed ? (
        <>
          {user.registered ? (
            <div className="relative">
              <div className="w-9 h-9 cursor-pointer rounded-full bg-secondary flex items-center justify-center" onClick={() => setUserDialogOpen(true)}>
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
            </div>
          ) : (
            <RegisterButton
              onClick={() => setRegisterDialogOpen(true)}
              isRegistering={effectiveIsRegistering}
              pendingUsername={effectivePendingUsername}
              collapsed
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSettings}
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </>
      ) : (
        <>
          {user.registered ? (
            <>
              <div className="relative">
                <div className="w-9 h-9 cursor-pointer rounded-full bg-secondary flex items-center justify-center" onClick={() => setUserDialogOpen(true)}>
                  <User className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono font-medium text-sidebar-foreground truncate text-left">
                  {user.username}
                </p>
                <div className="flex items-center gap-1">
                  <p title={user.peerId} className="text-xs text-success font-mono text-left truncate cursor-pointer" onClick={handleCopyPeerId}>{user.peerId}</p>
                  <button
                    type="button"
                    className="text-xs cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={handleCopyPeerId}
                  >
                    {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <RegisterButton
              onClick={() => setRegisterDialogOpen(true)}
              isRegistering={effectiveIsRegistering}
              pendingUsername={effectivePendingUsername}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleSettings}
            className="text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
    <UserDialog
      open={userDialogOpen}
      onOpenChange={setUserDialogOpen}
      onRegister={handleUsernameChange}
      isRegistering={isUpdatingUsername}
      backendError={updateUsernameError}
    />
    <RegisterDialog
      open={registerDialogOpen}
      onOpenChange={setRegisterDialogOpen}
      onRegister={handleRegisterIdentity}
      backendError={registerIdentityError}
      isRegistering={effectiveIsRegistering}
      initialUsername={effectivePendingUsername}
    />
    <SettingsDialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} />
  </div>
};
