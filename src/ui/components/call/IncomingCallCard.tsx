import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Phone, PhoneOff } from 'lucide-react';
import { Button } from '../ui/Button';
import { useToast } from '../ui/use-toast';
import { useAppDispatch, useAppSelector } from '../../state/hooks';
import { clearIncomingCall } from '../../state/slices/callSlice';
import { callService } from '../../lib/call/callService';
import { useCallCardAnchor } from './useCallCardAnchor';

export const IncomingCallCard = () => {
  const dispatch = useAppDispatch();
  const { toast } = useToast();
  const incomingCall = useAppSelector((state) => state.call.incomingCall);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDraggingAnchor, setIsDraggingAnchor] = useState(false);
  const { positionClassName, snapToClosestCorner } = useCallCardAnchor();

  if (!incomingCall) return null;

  const handleAccept = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await callService.acceptIncomingCall({
        callId: incomingCall.callId,
        peerId: incomingCall.peerId,
        offerSdp: incomingCall.offerSdp,
        mediaType: incomingCall.mediaType,
      });
      if (!result.success) {
        const currErr = result.error?.toLowerCase().includes("device not found")
          ? "Camera or Microphone not found" : result.error;
        toast.error(currErr|| 'Failed to accept call');
        return;
      }
      dispatch(clearIncomingCall());
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const result = await callService.rejectIncomingCall(
        incomingCall.peerId,
        incomingCall.callId,
        'rejected',
      );
      if (!result.success) {
        toast.error(result.error || 'Failed to reject call');
      }
      dispatch(clearIncomingCall());
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAnchorPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    setIsDraggingAnchor(true);

    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // no-op: pointer capture can fail on some environments, snap still works via window listener
    }

    const cleanup = () => {
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // no-op: if capture was never set, release can throw
      }
      setIsDraggingAnchor(false);
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      cleanup();
      snapToClosestCorner(upEvent.clientX, upEvent.clientY);
    };

    const onPointerCancel = () => {
      cleanup();
    };

    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  };

  return (
    <div className={`fixed ${positionClassName} z-110 w-[320px] rounded-lg border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-xl`}>
      <button
        type="button"
        className={`absolute top-1 left-1 z-10 h-5 w-5 rounded text-muted-foreground transition hover:bg-accent/70 hover:text-foreground cursor-move ${isDraggingAnchor ? 'bg-accent/80 text-foreground' : ''}`}
        title="Drag to snap card position"
        aria-label="Drag to snap card position"
        onPointerDown={handleAnchorPointerDown}
      >
        <GripVertical className="mx-auto h-3.5 w-3.5" />
      </button>
      <div className="flex items-center justify-center gap-2">
        <div className="text-sm font-semibold text-foreground">
          Incoming {incomingCall.mediaType} call from {incomingCall.peerName}...
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={handleReject}
          disabled={isSubmitting}
        >
          <PhoneOff className="w-4 h-4" />
          Reject
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={handleAccept}
          disabled={isSubmitting}
        >
          <Phone className="w-4 h-4" />
          Accept
        </Button>
      </div>
    </div>
  );
};
