import { useSelector } from 'react-redux';
import type { RootState } from '../state/store';
import { useToast } from '../components/ui/use-toast';

const OFFLINE_SEND_TOAST_DURATION_MS = 7000;

export function useOfflineSendWarning(): () => void {
  const { toast } = useToast();
  const networkOnline = useSelector((state: RootState) => state.user.networkOnline);

  return () => {
    if (!networkOnline) {
      toast.warning(
        'Message sent while offline — no one except clients on your machine will ever see it.',
        undefined,
        OFFLINE_SEND_TOAST_DURATION_MS,
      );
    }
  };
}
