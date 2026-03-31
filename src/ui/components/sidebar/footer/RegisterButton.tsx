import { UserPlus } from "lucide-react";
import type { FC } from "react";

interface RegisterButtonProps {
    onClick: () => void;
    isRegistering?: boolean;
    pendingUsername?: string;
    collapsed?: boolean;
}

export const RegisterButton: FC<RegisterButtonProps> = ({
    onClick,
    isRegistering = false,
    pendingUsername = "",
    collapsed = false
}) => {
    if (collapsed) {
        return (
            <button
                onClick={onClick}
                className="w-9 h-9 cursor-pointer rounded-full border border-primary/50 flex items-center justify-center hover:border-primary/80 hover:bg-primary/10 transition-colors"
                title={isRegistering ? `Reserving ${pendingUsername || "username"}` : "Register Identity"}
                aria-label="Register Identity"
            >
                <UserPlus className="w-4 h-4 text-primary" />
            </button>
        );
    }

    return (
            <button
                onClick={onClick}
                className="w-full cursor-pointer flex items-center gap-3 p-2 rounded-md bg-primary/10 border border-primary/30 hover:bg-primary/20 transition-colors group"
            >
                <div className="w-9 h-9 rounded-full border border-primary/50 flex items-center justify-center group-hover:border-primary transition-colors">
                    <UserPlus className="w-4 h-4 text-primary" />
                </div>
                <div className="text-left">
                    <p className="text-sm font-mono font-medium text-primary">
                        {isRegistering ? 'Registering...' : 'Register Identity'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                        {isRegistering ? `Reserving ${pendingUsername || 'username'}` : 'Register with a unique username'}
                    </p>
                </div>
            </button>
    )
}
