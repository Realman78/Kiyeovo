import { useState, type FC } from "react";
import { RegisterButton } from "./RegisterButton";
import type { RootState } from "../../../state/store";
import { useSelector } from "react-redux";
import { Check, Copy, User } from "lucide-react";
import { RegisterIdentityDialog } from "./RegisterIdentityDialog";

type SidebarFooterProps = {
  collapsed?: boolean;
  onOpenProfile: () => void;
};

export const SidebarFooter: FC<SidebarFooterProps> = ({ collapsed = false, onOpenProfile }) => {
  const user = useSelector((state: RootState) => state.user);
  const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
  const pendingRegistrationUsername = useSelector((state: RootState) => state.user.pendingRegisterUsername || "");
  const [isCopied, setIsCopied] = useState(false);
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false);

  const handleCopyPeerId = (event: React.MouseEvent) => {
    event.stopPropagation();
    setIsCopied(true);
    navigator.clipboard.writeText(user.peerId);
    setTimeout(() => {
      setIsCopied(false);
    }, 2000);
  };

  return <div className={`flex border-t border-sidebar-border bg-sidebar-accent/50 ${collapsed ? "h-14 p-2" : "h-20 p-3"}`}>
    <div className={`flex w-full ${collapsed ? "items-center justify-center" : "items-center gap-3"}`}>
      {collapsed ? (
        <>
          {user.registered ? (
            <button
              type="button"
              onClick={onOpenProfile}
              aria-label="Open profile"
              className="relative cursor-pointer"
            >
              <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
            </button>
          ) : (
            <RegisterButton
              onClick={() => setRegisterDialogOpen(true)}
              isRegistering={registrationInProgress}
              pendingUsername={pendingRegistrationUsername}
              collapsed
            />
          )}
        </>
      ) : (
        <>
          {user.registered ? (
            <div className="flex w-full items-center gap-3">
              <button
                type="button"
                onClick={onOpenProfile}
                aria-label="Open profile"
                className="relative shrink-0 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center">
                  <User className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-success border-2 border-sidebar-accent/50" />
              </button>
              <div className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={onOpenProfile}
                  className="block max-w-full text-sm font-mono font-medium text-sidebar-foreground truncate text-left cursor-pointer"
                >
                  {user.username}
                </button>
                <div className="flex items-center gap-1">
                  <p title={user.peerId} className="text-xs text-success font-mono text-left truncate cursor-pointer" onClick={handleCopyPeerId}>{user.peerId}</p>
                  <button
                    type="button"
                    aria-label="Copy peer ID"
                    className="text-xs cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={handleCopyPeerId}
                  >
                    {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <RegisterButton
              onClick={() => setRegisterDialogOpen(true)}
              isRegistering={registrationInProgress}
              pendingUsername={pendingRegistrationUsername}
            />
          )}
        </>
      )}
    </div>
    <RegisterIdentityDialog open={registerDialogOpen} onOpenChange={setRegisterDialogOpen} />
  </div>
};
