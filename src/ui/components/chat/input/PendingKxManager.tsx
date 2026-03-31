import { useState } from "react";
import { useDispatch } from "react-redux";
import { Button } from "../../ui/Button";
import { removePendingKeyExchange, setActivePendingKeyExchange } from "../../../state/slices/chatSlice";
import { useToast } from "../../ui/use-toast";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";

type PendingKxManagerProps = {
    peerId: string;
}

export const PendingKxManager = ({ peerId }: PendingKxManagerProps) => {
    const dispatch = useDispatch();
    const [error, setError] = useState<string | undefined>(undefined);
    const [isCancelling, setIsCancelling] = useState(false);
    const { toast } = useToast();

    const handleCancel = async () => {
        setError(undefined);
        setIsCancelling(true);

        try {
            const result = await window.kiyeovoAPI.cancelPendingKeyExchange(peerId);

            if (!result.success) {
                toast.error(result.error || 'Failed to cancel key exchange');
                setIsCancelling(false);
            }
            dispatch(removePendingKeyExchange(peerId))
            dispatch(setActivePendingKeyExchange(null))
            toast.info("Successfully cancelled message request.")
        } catch (err) {
            console.error('Failed to cancel key exchange:', err);
            setError(errStr(err, UNEXPECTED_ERROR));
            setIsCancelling(false);
        }
    }
    return <div className={`h-20 px-4 flex flex-col justify-center border-t border-border`}>
        <div className="flex items-center justify-evenly">
            <Button onClick={handleCancel} variant="destructive" className="bg-transparent border border-destructive/50 text-destructive hover:bg-destructive/50!" disabled={isCancelling}>
                Cancel Key Exchange
            </Button>
        </div>
        {error && <div className="text-destructive text-sm text-center mt-2">{error}</div>}
    </div>
}
