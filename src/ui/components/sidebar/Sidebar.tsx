import { type FC, useState, useEffect, useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { SidebarHeader } from './header/SidebarHeader'
import { ChatList } from './chats/ChatList'
import { SidebarFooter } from './footer/SidebarFooter'
import { type ContactAttempt } from './contact-attempts/ContactAttemptItem'
import { useDispatch, useSelector } from 'react-redux';
import { errStr } from '../../../core/utils/general-error';
import { addContactAttempt, removeContactAttempt, removePendingKeyExchange, setContactAttempts } from '../../state/slices/chatSlice'
import { store, type RootState } from '../../state/store'
import { ContactAttemptList } from './contact-attempts/ContactAttemptList'
import { PendingKeyExchangeList } from './pending-key-exchange/PendingKeyExchangeList'
import { GroupInviteList } from './group-invites/GroupInviteList'
import { setConnected, setPeerId, setRegistered, setUsername } from '../../state/slices/userSlice'
import { useToast } from '../ui/use-toast'

export const Sidebar: FC = () => {
  const [isLoadingContactAttempts, setIsLoadingContactAttempts] = useState(true);
  const [contactAttemptsError, setContactAttemptsError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts)
  const { toast } = useToast();
  const dispatch = useDispatch();

  const handleContactAttemptExpired = useCallback((peerId: string) => {
    dispatch(removeContactAttempt(peerId))
  }, []);

  useEffect(() => {
    const fetchContactAttempts = async () => {
      setIsLoadingContactAttempts(true);
      setContactAttemptsError(null);

      try {
        const result = await window.kiyeovoAPI.getContactAttempts();
        if (result.success) {
          dispatch(setContactAttempts(result.contactAttempts as ContactAttempt[]));
        } else {
          setContactAttemptsError(result.error || 'Failed to fetch contact attempts');
        }
      } catch (error) {
        setContactAttemptsError(errStr(error, 'Failed to fetch contact attempts'));
      } finally {
        setIsLoadingContactAttempts(false);
      }
    };
    fetchContactAttempts();
  }, []);

  useEffect(() => {
    // Pull current user state on mount (solves race condition)
    const checkUserState = async () => {
      const userState = await window.kiyeovoAPI.getUserState();
      if (userState.peerId) {
        dispatch(setPeerId(userState.peerId));
      }
      if (userState.username && userState.isRegistered) {
        dispatch(setUsername(userState.username));
        dispatch(setRegistered(true));
        dispatch(setConnected(true));
      }
    };
    checkUserState();

    // Also listen for future username restoration events
    const unsubscribe = window.kiyeovoAPI.onContactRequestReceived((data) => {
      const state = store.getState();
      const myPeerId = state.user.peerId;
      const hasPendingForPeer = state.chat.pendingKeyExchanges.some((pending) => pending.peerId === data.peerId);

      if (hasPendingForPeer && myPeerId) {
        const outgoingWins = myPeerId < data.peerId;
        if (outgoingWins) return;

        dispatch(removePendingKeyExchange(data.peerId));
      }

      dispatch(addContactAttempt(data));
    });

    const unsubscribeCancelled = window.kiyeovoAPI.onContactRequestCancelled((data) => {
      dispatch(removeContactAttempt(data.peerId));
      toast.info(`${data.username || data.peerId} cancelled the contact request`)
    });

    const restoreUnsubscribe = window.kiyeovoAPI.onRestoreUsername((username) => {
      dispatch(setUsername(username));
      dispatch(setRegistered(true));
      dispatch(setConnected(true));
    });

    return () => {
      unsubscribe();
      unsubscribeCancelled();
      restoreUnsubscribe();
    };
  }, []);

  return (
    <div className={`relative h-full bg-sidebar border-r border-sidebar-border flex flex-col transition-[width] duration-300 ease-in-out ${isCollapsed ? 'w-16' : 'w-96'}`}>
      <SidebarHeader collapsed={isCollapsed} />

      {!isCollapsed && contactAttempts.length > 0 && (
        <ContactAttemptList
          isLoadingContactAttempts={isLoadingContactAttempts}
          contactAttemptsError={contactAttemptsError}
          handleContactAttemptExpired={handleContactAttemptExpired}
        />
      )}
      {!isCollapsed && <GroupInviteList />}
      {!isCollapsed && <PendingKeyExchangeList />}
      {!isCollapsed && <ChatList />}
      {isCollapsed && <div className="flex-1" />}
      <SidebarFooter collapsed={isCollapsed} />
      <button
        type="button"
        onClick={() => setIsCollapsed((prev) => !prev)}
        className="absolute cursor-pointer top-1/2 right-0 -translate-y-1/2 translate-x-1/2 w-6 h-6 rounded-full border border-sidebar-border bg-sidebar-accent/70 hover:bg-sidebar-accent text-primary/80 hover:text-primary flex items-center justify-center transition-colors duration-200"
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </div>
  )
}

export default Sidebar
