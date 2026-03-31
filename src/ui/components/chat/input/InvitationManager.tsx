import { useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { Button } from "../../ui/Button";
import { removeContactAttempt } from "../../../state/slices/chatSlice";
import { useToast } from "../../ui/use-toast";
import type { RootState } from "../../../state/store";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";

type InvitationManagerProps = {
    peerId: string;
}

export const InvitationManager = ({peerId}: InvitationManagerProps) => {
    const dispatch = useDispatch();
    const isRegistered = useSelector((state: RootState) => state.user.registered);
    const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
    const [error, setError] = useState<string | undefined>(undefined);
    const [isAccepting, setIsAccepting] = useState(false);
    const [isRejecting, setIsRejecting] = useState(false);
    const { toast } = useToast();

    const handleAccept = async () => {
        if (!isRegistered || registrationInProgress) {
            toast.warning('Finish registration first, then accept this contact request.');
            return;
        }

        setError(undefined);
        setIsAccepting(true);

        try {
            const result = await window.kiyeovoAPI.acceptContactRequest(peerId);

            if (!result.success) {
                setError(result.error || 'Failed to accept contact request');
                setIsAccepting(false);
            }
            // If successful, we wait for the chat-created event
        } catch (err) {
            toast.error(errStr(err, UNEXPECTED_ERROR));
            setError(errStr(err, UNEXPECTED_ERROR));
            setIsAccepting(false);
        }
    }

    const handleReject = async (block: boolean) => {
        setError(undefined);
        setIsRejecting(true);

        try {
            const result = await window.kiyeovoAPI.rejectContactRequest(peerId, block);

            if (result.success) {
                dispatch(removeContactAttempt(peerId));
                toast.info(`Contact request rejected${block ? ' and blocked' : ''}`);
            } else {
                toast.error(result.error || 'Failed to reject contact request');
            }
            setIsRejecting(false);
        }
        catch (err) {
            console.error('Failed to reject contact request:', err);
            setError(errStr(err, UNEXPECTED_ERROR));
            setIsRejecting(false);
        }
    }
    return <div className={`h-20 px-4 flex flex-col justify-center border-t border-border`}>
        <div className="flex items-center justify-evenly">
            <Button variant="outline" onClick={handleAccept} disabled={isAccepting || isRejecting}>
                {isAccepting ? 'Accepting...' : 'Accept'}
            </Button>

            <div className="flex items-center gap-4">
                <Button onClick={async () => await handleReject(false)} variant="destructive" className="bg-transparent border border-destructive/50 text-destructive hover:bg-destructive/50!" disabled={isAccepting || isRejecting}>
                    {isRejecting ? 'Rejecting...' : 'Reject'}
                </Button>
                <Button onClick={async () => await handleReject(true)} variant="destructive" className="bg-transparent border border-destructive/50 text-destructive" disabled={isAccepting || isRejecting}>
                    {isRejecting ? 'Rejecting & Blocking...' : 'Reject & Block'}
                </Button>
            </div>
        </div>
        {error && <div className="text-destructive text-sm text-center mt-2">{error}</div>}
    </div>
}
