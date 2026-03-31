import { useCallback, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { ChevronDown } from "lucide-react";
import { PendingKeyExchangeItem } from "./PendingKeyExchangeItem";
import { removePendingKeyExchange } from "../../../state/slices/chatSlice";

export const PendingKeyExchangeList = () => {
    const pendingKeyExchanges = useSelector((state: RootState) => state.chat.pendingKeyExchanges);
    const dispatch = useDispatch();
    const [isExpanded, setIsExpanded] = useState(true);

    const handlePendingKeyExchangeExpired = useCallback((peerId: string) => {
        dispatch(removePendingKeyExchange(peerId));
    }, []);

    return pendingKeyExchanges.length > 0 ? (
        <div className="border-b border-sidebar-border mb-4">
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full cursor-pointer flex items-center justify-between px-4 py-2 hover:bg-sidebar-accent transition-colors"
            >
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                    Pending Key Exchanges
                </div>
                <div className="flex items-center gap-2">
                    <div className="shrink-0 w-5 h-5 rounded-full bg-primary/20 text-primary text-xs font-bold font-mono flex items-center justify-center">
                        {pendingKeyExchanges.length}
                    </div>
                    <ChevronDown
                        className={`w-4 h-4 text-muted-foreground transition-transform duration-300 ${isExpanded ? '' : '-rotate-90'}`}
                    />
                </div>
            </button>

            <div
                className={`transition-all duration-300 ease-in-out overflow-hidden ${isExpanded ? 'max-h-96' : 'max-h-0'}`}
            >
                {pendingKeyExchanges.map((pendingKeyExchange) => (
                    <PendingKeyExchangeItem
                        key={pendingKeyExchange.peerId}
                        pendingKeyExchange={pendingKeyExchange}
                        onExpired={handlePendingKeyExchangeExpired}
                    />
                ))}
            </div>
        </div>
    ) : null;
}
