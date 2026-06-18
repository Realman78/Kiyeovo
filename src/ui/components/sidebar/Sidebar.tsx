import { type FC, useState, useEffect } from 'react'
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
import { SidebarRail } from './SidebarRail'
import type { NetworkMode } from '../../../core/types'
import type { SetupSection, SidebarSection } from './navigation'
import { SetupSidebar } from './setup/SetupSidebar'

type SidebarProps = {
  activeSection: SidebarSection;
  activeSetupSection: SetupSection;
  onSelectSection: (section: SidebarSection) => void;
  onSelectSetupSection: (section: SetupSection) => void;
};

export const Sidebar: FC<SidebarProps> = ({
  activeSection,
  activeSetupSection,
  onSelectSection,
  onSelectSetupSection,
}) => {
  const [isLoadingContactAttempts, setIsLoadingContactAttempts] = useState(true);
  const [contactAttemptsError, setContactAttemptsError] = useState<string | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isTorEnabled, setIsTorEnabled] = useState<boolean>(false);
  const [networkMode, setNetworkMode] = useState<NetworkMode>('fast');
  const networkOnline = useSelector((state: RootState) => state.user.networkOnline);
  const statusSuffix = networkOnline === false ? ' (local)' : isTorEnabled ? ' (tor)' : '';

  const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts)
  const { toast } = useToast();
  const dispatch = useDispatch();

  const handleContactAttemptExpired = (peerId: string) => {
    dispatch(removeContactAttempt(peerId))
  };

  useEffect(() => {
    const loadNetworkSettings = async () => {
      try {
        const [torResult, modeResult] = await Promise.all([
          window.kiyeovoAPI.getTorSettings(),
          window.kiyeovoAPI.getNetworkMode(),
        ]);
        if (torResult.success && torResult.settings) {
          setIsTorEnabled(torResult.settings.enabled === 'true');
        }
        if (modeResult.success) {
          setNetworkMode(modeResult.mode);
        }
      } catch (error) {
        console.error('Failed to load network settings:', error);
      }
    };
    void loadNetworkSettings();
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
    void fetchContactAttempts();
  }, [dispatch]);

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
    void checkUserState();

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
  }, [dispatch, toast]);

  const renderCollapsedPane = () => (
    <>
      <SidebarHeader statusSuffix={statusSuffix} collapsed />
      <div className="flex-1" />
      <SidebarFooter collapsed />
    </>
  );

  const renderSectionPane = () => {
    if (isCollapsed) {
      return renderCollapsedPane();
    }

    if (activeSection === 'setup') {
      return (
        <SetupSidebar
          activeSection={activeSetupSection}
          networkMode={networkMode}
          onSelectSection={onSelectSetupSection}
        />
      );
    }

    if (activeSection === 'help' || activeSection === 'settings') {
      return <div className="flex-1 bg-sidebar-background" />;
    }

    if (activeSection === 'groups') {
      return (
        <>
          <SidebarHeader statusSuffix={statusSuffix} />
          <GroupInviteList />
          <ChatList scope="groups" />
          <SidebarFooter />
        </>
      );
    }

    return (
      <>
        <SidebarHeader statusSuffix={statusSuffix} />
        {contactAttempts.length > 0 && (
          <ContactAttemptList
            isLoadingContactAttempts={isLoadingContactAttempts}
            contactAttemptsError={contactAttemptsError}
            handleContactAttemptExpired={handleContactAttemptExpired}
          />
        )}
        <GroupInviteList />
        <PendingKeyExchangeList />
        <ChatList scope="all" />
        <SidebarFooter />
      </>
    );
  };

  return (
    <div className={`relative z-10 h-full overflow-visible border-r border-sidebar-border bg-sidebar-background transition-[width] duration-300 ease-in-out ${isCollapsed ? 'w-30' : 'w-110'}`}>
      <div className="flex h-full">
        <SidebarRail
          activeSection={activeSection}
          onSelectSection={onSelectSection}
          isTorEnabled={isTorEnabled}
        />
        <div
          className={`relative z-0 flex min-w-0 flex-col overflow-hidden border-l border-sidebar-border transition-[width] duration-300 ease-in-out ${isCollapsed ? 'w-16' : 'flex-1'
            }`}
        >
          {renderSectionPane()}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setIsCollapsed((prev) => !prev)}
        className="absolute right-0 top-1/2 z-40 flex h-6 w-6 translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent/70 text-primary/80 transition-colors duration-200 hover:bg-sidebar-accent hover:text-primary"
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>
    </div>
  )
}

export default Sidebar
