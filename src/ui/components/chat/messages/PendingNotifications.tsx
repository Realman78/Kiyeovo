import { useState, type FC } from "react";
import { Check, Copy } from "lucide-react";
import { TimeToRespond } from "./TimeToRespond";
import type { RootState } from "../../../state/store";
import { useSelector } from "react-redux";

type PendingNotificationsProps = {
    senderUsername: string;
    senderPeerId: string;
}
export const PendingNotifications: FC<PendingNotificationsProps> = ({ senderUsername, senderPeerId }) => {
    const activePendingKeyExchange = useSelector((state: RootState) => state.chat.activePendingKeyExchange);
    const activeContactAttempt = useSelector((state: RootState) => state.chat.activeContactAttempt);
    const [isCopied, setIsCopied] = useState(false);

    const handleCopyPeerId = () => {
        setIsCopied(true);
        navigator.clipboard.writeText(senderPeerId);
        setTimeout(() => {
            setIsCopied(false);
        }, 2000);
    }
    return <>
        {!!activePendingKeyExchange && <div className="w-full flex justify-center">
            <div className="text-foreground relative text-center w-1/2 border p-6 rounded-lg border-primary/50 bg-primary/20" style={{ wordBreak: "break-word" }}>
                <div onClick={handleCopyPeerId} className="absolute right-2 top-2 cursor-pointer hover:text-foreground/80">
                    {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </div>
                You have requested to contact <b>{senderUsername}</b> with Peer ID <b onClick={handleCopyPeerId} className="cursor-pointer hover:text-foreground/80">{senderPeerId}</b>.
            </div>
        </div>}
        {!!activeContactAttempt && <div className="w-full flex justify-center">
            <div className="text-foreground relative text-center w-1/2 border p-6 rounded-lg border-warning/50 bg-warning/20" style={{ wordBreak: "break-word" }}>
                <div onClick={handleCopyPeerId} className="absolute right-2 top-2 cursor-pointer hover:text-foreground/80">
                    {isCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </div>
                User <b>{senderUsername}</b> with Peer ID <b onClick={handleCopyPeerId} className="cursor-pointer hover:text-foreground/80">{senderPeerId}</b> has requested to contact you.
            </div>
        </div>}
        {!!activeContactAttempt && activeContactAttempt?.expiresAt && <TimeToRespond type="contactAttempt" expiresAt={activeContactAttempt.expiresAt} />}
        {!!activePendingKeyExchange && activePendingKeyExchange?.expiresAt && <TimeToRespond type="pendingKeyExchange" expiresAt={activePendingKeyExchange.expiresAt} />}
    </>
}
