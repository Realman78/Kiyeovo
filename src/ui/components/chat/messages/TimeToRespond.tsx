import { useEffect } from "react";
import { useDispatch } from "react-redux";
import { setActiveChat } from "../../../state/slices/chatSlice";
import { useExpirationTimer } from "../../../hooks/useExpirationTimer";

type TimeToRespondProps = {
    expiresAt: number;
    type: 'contactAttempt' | 'pendingKeyExchange';
}
export const TimeToRespond = ({ expiresAt, type }: TimeToRespondProps) => {
    const dispatch = useDispatch();
    const { minutes, seconds, timeLeft } = useExpirationTimer(expiresAt);

    useEffect(() => {
        if (timeLeft === 0 && expiresAt < Date.now()) {
            dispatch(setActiveChat(null));
        }
    }, [timeLeft, expiresAt, dispatch]);
    return <div className="w-full flex justify-center">
        <div className={`text-foreground relative text-center w-1/2 border p-4 rounded-lg ${type === 'contactAttempt' ? 'border-warning/50 bg-warning/20' : 'border-primary/50 bg-primary/20'}`} style={{ wordBreak: "break-word" }}>
            Time left to respond: {minutes}:{seconds.toString().padStart(2, '0')}
        </div>
    </div>
}
