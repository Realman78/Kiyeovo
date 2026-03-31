import { useEffect } from "react";
import { UserPlus } from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import { setActiveContactAttempt } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { useExpirationTimer } from "../../../hooks/useExpirationTimer";

export interface ContactAttempt {
  peerId: string;
  username: string;
  message: string;
  messageBody?: string;
  receivedAt: number;
  expiresAt: number;
}

interface ContactAttemptItemProps {
  attempt: ContactAttempt;
  onExpired: (peerId: string) => void;
}

export const ContactAttemptItem = ({ attempt, onExpired }: ContactAttemptItemProps) => {
  const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);
  const dispatch = useDispatch();
  const { minutes, seconds, timeLeft } = useExpirationTimer(attempt.expiresAt);

  const handleSelectContactAttempt = () => {
    dispatch(setActiveContactAttempt(attempt.peerId));
  };

  useEffect(() => {
    if (timeLeft === 0 && attempt.expiresAt && attempt.expiresAt < Date.now()) {
      onExpired(attempt.peerId);
    }
  }, [timeLeft, attempt.peerId, attempt.expiresAt, onExpired]);

  const isSelected = activeContactAttempt?.peerId === attempt.peerId;

  return (
    <div
      onClick={handleSelectContactAttempt}
      className={`flex items-center gap-3 p-3
        cursor-pointer bg-warning/5 hover:bg-warning/10 transition-colors
        ${isSelected ? 'border-l-2 border-warning bg-warning/10' : ''}
        `}
    >
      <div className="shrink-0">
        <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
          <UserPlus className="w-5 h-5 text-warning" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-foreground truncate text-left">{attempt.username}</div>
        <div className="text-xs text-muted-foreground truncate text-left">
          {attempt.messageBody ?? attempt.message}
        </div>
      </div>
      <div className="shrink-0">
        <div className="text-xs text-warning font-mono tabular-nums">
          {minutes}:{seconds.toString().padStart(2, '0')}
        </div>
      </div>
    </div>
  );
};
