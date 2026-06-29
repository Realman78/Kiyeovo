import { useEffect, useState, type FC } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { setRegistered, setRegistrationInProgress, setUsername } from "../../../state/slices/userSlice";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";
import { useToast } from "../../ui/use-toast";
import RegisterDialog from "./RegisterDialog";

type RegisterIdentityDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const RegisterIdentityDialog: FC<RegisterIdentityDialogProps> = ({ open, onOpenChange }) => {
  const registered = useSelector((state: RootState) => state.user.registered);
  const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
  const pendingRegistrationUsername = useSelector((state: RootState) => state.user.pendingRegisterUsername || "");
  const [isRegisteringIdentity, setIsRegisteringIdentity] = useState(false);
  const [registerIdentityError, setRegisterIdentityError] = useState<string | undefined>(undefined);
  const [pendingRegisterUsername, setPendingRegisterUsername] = useState("");
  const dispatch = useDispatch();
  const { toast } = useToast();
  const effectiveIsRegistering = isRegisteringIdentity || registrationInProgress;
  const effectivePendingUsername = pendingRegisterUsername || pendingRegistrationUsername;

  useEffect(() => {
    if (!open || !registered) {
      return;
    }
    onOpenChange(false);
    setRegisterIdentityError(undefined);
  }, [open, registered, onOpenChange]);

  const handleRegisterIdentity = async (username: string, rememberMe: boolean) => {
    setIsRegisteringIdentity(true);
    setRegisterIdentityError(undefined);
    setPendingRegisterUsername(username);
    dispatch(setRegistrationInProgress({ inProgress: true, pendingUsername: username }));

    try {
      const result = await window.kiyeovoAPI.register(username, rememberMe);
      if (result.success) {
        // Registration is the source of truth — commit it before any secondary work.
        dispatch(setUsername(username));
        dispatch(setRegistered(true));
        setRegisterIdentityError(undefined);
        onOpenChange(false);

        // Persist the explicit choice so an opt-out is recorded durably as 'never' rather than left unset
        try {
          const prefResult = await window.kiyeovoAPI.setAutoRegister(rememberMe);
          if (!prefResult.success) {
            console.error('Failed to persist auto-register preference:', prefResult.error);
            toast.warning('Registered, but the auto-register preference could not be saved.', 'Preference not saved');
          }
        } catch (prefErr) {
          console.error('Failed to persist auto-register preference:', prefErr);
          toast.warning('Registered, but the auto-register preference could not be saved.', 'Preference not saved');
        }
      } else {
        const message = result.error || 'Failed to register username';
        setRegisterIdentityError(message);
        toast.error(message, 'Username registration failed');
      }
    } catch (err) {
      console.error('Registration error:', err);
      const message = errStr(err, UNEXPECTED_ERROR);
      setRegisterIdentityError(message);
      toast.error(message, 'Username registration failed');
    } finally {
      setIsRegisteringIdentity(false);
      dispatch(setRegistrationInProgress({ inProgress: false, pendingUsername: '' }));
    }
  };

  return (
    <RegisterDialog
      open={open}
      onOpenChange={onOpenChange}
      onRegister={handleRegisterIdentity}
      backendError={registerIdentityError}
      isRegistering={effectiveIsRegistering}
      initialUsername={effectivePendingUsername}
    />
  );
};

export default RegisterIdentityDialog;
