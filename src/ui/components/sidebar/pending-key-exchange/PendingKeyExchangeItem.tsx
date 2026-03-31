import { Handshake } from "lucide-react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { useExpirationTimer } from "../../../hooks/useExpirationTimer";
import { setActivePendingKeyExchange, type PendingKeyExchange } from "../../../state/slices/chatSlice";
import { useEffect } from "react";

interface PendingKeyExchangeItemProps {
  pendingKeyExchange: PendingKeyExchange;
  onExpired: (peerId: string) => void;
}

export const PendingKeyExchangeItem = ({ pendingKeyExchange, onExpired }: PendingKeyExchangeItemProps) => {
  const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
  const dispatch = useDispatch();
  const { minutes, seconds, timeLeft } = useExpirationTimer(pendingKeyExchange.expiresAt);

  const handleSelectPendingKeyExchange = () => {
    dispatch(setActivePendingKeyExchange(pendingKeyExchange.peerId));
  };

  useEffect(() => {
    if (timeLeft === 0 && pendingKeyExchange.expiresAt && pendingKeyExchange.expiresAt < Date.now()) {
      onExpired(pendingKeyExchange.peerId);
    }
  }, [timeLeft, pendingKeyExchange.peerId, pendingKeyExchange.expiresAt, onExpired]);

  const isSelected = activePendingKeyExchange?.peerId === pendingKeyExchange.peerId;

  return (
    <div
      onClick={handleSelectPendingKeyExchange}
      className={`flex items-center gap-3 p-3
        cursor-pointer bg-primary/5 hover:bg-primary/10 transition-colors
        ${isSelected ? 'border-l-2 border-primary bg-primary/10' : ''}
        `}
    >
      <div className="shrink-0">
        <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
          <Handshake className="w-5 h-5 text-primary" />
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-foreground truncate text-left">{pendingKeyExchange.username}</div>
        <div className="text-xs text-muted-foreground truncate text-left">
          Awaiting invitation acceptance
        </div>
      </div>
      <div className="shrink-0">
        <div className="text-xs text-primary font-mono tabular-nums">
          {minutes}:{seconds.toString().padStart(2, '0')}
        </div>
      </div>
    </div>
  );
};
