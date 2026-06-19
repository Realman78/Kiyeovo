import { useEffect, useState, useRef, type FC } from "react";
import { Plus, MessageSquarePlus, UserPlus, Users } from "lucide-react";
import { Button } from "../../ui/Button";
import { useDispatch, useSelector } from "react-redux";
import { setConnected, setRegistered, setRegistrationInProgress, setUsername } from "../../../state/slices/userSlice";
import NewConversationDialog from "./NewConversationDialog";
import ImportTrustedUserDialog from "./ImportTrustedUserDialog";
import NewGroupDialog, { type GroupInviteDeliveryView } from "./NewGroupDialog";
import { addPendingKeyExchange, removeContactAttempt, removePendingKeyExchange, setActivePendingKeyExchange, setActiveChat, addChat, type Chat } from "../../../state/slices/chatSlice";
import type { RootState } from "../../../state/store";
import { DropdownMenu, DropdownMenuItem } from "../../ui/DropdownMenu";
import { useToast } from "../../ui/use-toast";
import { useOfflineSendWarning } from "../../../hooks/useOfflineSendWarning";
import { errStr } from '../../../../core/utils/general-error';
import { UNEXPECTED_ERROR } from "../../../constants";

type SidebarHeaderProps = {
    statusSuffix: string;
    collapsed?: boolean;
    onOpenBootstrapSetup: () => void;
};

export const SidebarHeader: FC<SidebarHeaderProps> = ({
    collapsed = false,
    statusSuffix,
    onOpenBootstrapSetup,
}) => {
    const [isDHTConnected, setIsDHTConnected] = useState<boolean | null>(null);
    const [newConversationDialogOpen, setNewConversationDialogOpen] = useState(false);
    const [importTrustedUserDialogOpen, setImportTrustedUserDialogOpen] = useState(false);
    const [newGroupDialogOpen, setNewGroupDialogOpen] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const isConnected = useSelector((state: RootState) => state.user.connected);
    // Status reflects real DHT-peer reachability (liveness)
    const statusText = isDHTConnected === null ? 'Connecting...' : isDHTConnected ? `Connected${statusSuffix}` : 'Offline';
    const isRegistered = useSelector((state: RootState) => state.user.registered);
    const registrationInProgress = useSelector((state: RootState) => state.user.registrationInProgress);
    const chats = useSelector((state: RootState) => state.chat.chats);
    const contactAttempts = useSelector((state: RootState) => state.chat.contactAttempts);
    const pendingKeyExchanges = useSelector((state: RootState) => state.chat.pendingKeyExchanges);
    const myPeerId = useSelector((state: RootState) => state.user.peerId);

    const dispatch = useDispatch();
    const { toast } = useToast();
    const warnOfflineSend = useOfflineSendWarning();

    // Ref to track latest newConversationDialogOpen value without recreating listeners
    const newConversationDialogOpenRef = useRef(newConversationDialogOpen);
    const attemptedAutoRegisterRef = useRef(false);
    const isRegisteredRef = useRef(isRegistered);
    const registrationInProgressRef = useRef(registrationInProgress);
    const autoRegisterEnabledRef = useRef<boolean | null>(null);
    const chatsRef = useRef(chats);
    const contactAttemptsRef = useRef(contactAttempts);
    const pendingKeyExchangesRef = useRef(pendingKeyExchanges);
    const myPeerIdRef = useRef(myPeerId);

    // Keep ref in sync with state
    useEffect(() => {
        newConversationDialogOpenRef.current = newConversationDialogOpen;
    }, [newConversationDialogOpen]);

    useEffect(() => {
        chatsRef.current = chats;
    }, [chats]);

    useEffect(() => {
        contactAttemptsRef.current = contactAttempts;
    }, [contactAttempts]);

    useEffect(() => {
        isRegisteredRef.current = isRegistered;
    }, [isRegistered]);

    useEffect(() => {
        registrationInProgressRef.current = registrationInProgress;
    }, [registrationInProgress]);

    useEffect(() => {
        pendingKeyExchangesRef.current = pendingKeyExchanges;
    }, [pendingKeyExchanges]);

    useEffect(() => {
        myPeerIdRef.current = myPeerId;
    }, [myPeerId]);

    const handleNewConversation = async (peerIdOrUsername: string, message: string) => {
        setError(undefined);

        try {
            const result = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, message);

            if (result.success) {
                warnOfflineSend();
                setNewConversationDialogOpen(false);
                dispatch(setActivePendingKeyExchange(null));
            } else {
                setError(result.error || 'Failed to send message');
            }
        } catch (err) {
            console.error('Failed to send message:', err);
            setError(errStr(err, UNEXPECTED_ERROR));
        }
    }


    useEffect(() => {
        let isDisposed = false;
        const ensureAutoRegisterEnabled = async (): Promise<boolean> => {
            if (autoRegisterEnabledRef.current !== null) {
                return autoRegisterEnabledRef.current;
            }

            try {
                const result = await window.kiyeovoAPI.getAutoRegister();
                autoRegisterEnabledRef.current = !!result.autoRegister;
            } catch (error) {
                console.error('[UI] Failed to read auto-register setting:', error);
                autoRegisterEnabledRef.current = false;
            }

            return autoRegisterEnabledRef.current;
        };

        const triggerAutoRegisterIfNeeded = () => {
            if (
                attemptedAutoRegisterRef.current
                || isRegisteredRef.current
                || registrationInProgressRef.current
            ) {
                return;
            }

            attemptedAutoRegisterRef.current = true;

            void (async () => {
                const autoRegisterEnabled = await ensureAutoRegisterEnabled();
                if (!autoRegisterEnabled) {
                    return;
                }

                dispatch(setRegistrationInProgress({ inProgress: true, pendingUsername: '' }));

                const lastUsernamePromise = window.kiyeovoAPI.getLastUsername()
                    .then((last) => {
                        if (!isDisposed && last.username) {
                            dispatch(setRegistrationInProgress({ inProgress: true, pendingUsername: last.username }));
                        }
                    })
                    .catch(() => {
                        // Best effort; pending username can remain empty.
                    });

                try {
                    await lastUsernamePromise;
                    const result = await window.kiyeovoAPI.attemptAutoRegister();
                    if (result.success && result.username) {
                        dispatch(setUsername(result.username));
                        dispatch(setRegistered(true));
                    } else if (!isDisposed && result.error) {
                        toast.error(result.error, 'Username registration failed');
                    }
                } finally {
                    dispatch(setRegistrationInProgress({ inProgress: false, pendingUsername: '' }));
                }
            })();
        };

        void window.kiyeovoAPI.getDHTConnectionStatus().then((result) => {
            if (isDisposed || !result.success) return;
            setIsDHTConnected(result.connected);
            dispatch(setConnected(result.connected));
            if (result.connected) {
                triggerAutoRegisterIfNeeded();
            }
        }).catch((error) => {
            console.error('[DHT-STATUS][UI][SNAPSHOT] failed:', error);
        });

        const unsubStatus = window.kiyeovoAPI.onDHTConnectionStatus((status: { connected: boolean | null }) => {
            setIsDHTConnected(status.connected);
            dispatch(setConnected(status.connected));
            if (status.connected === null) {
                return;
            }
            if (!status.connected) {
                attemptedAutoRegisterRef.current = false;
                autoRegisterEnabledRef.current = null;
                dispatch(setRegistrationInProgress({ inProgress: false, pendingUsername: '' }));
                return;
            }
            triggerAutoRegisterIfNeeded();
        });

        // Listen for key exchange sent event (to close dialog immediately)
        const unsubSent = window.kiyeovoAPI.onKeyExchangeSent((data) => {
            // this needs to be called only for new conversations, not for existing chats
            if (!newConversationDialogOpenRef.current) return;
            const existingDirectChat = chatsRef.current.find((chat) => chat.type === 'direct' && chat.peerId === data.peerId);
            if (!existingDirectChat) {
                const existingContactAttempt = contactAttemptsRef.current.some((attempt) => attempt.peerId === data.peerId);
                const localPeerId = myPeerIdRef.current;

                if (existingContactAttempt && localPeerId) {
                    const outgoingWins = localPeerId < data.peerId;
                    if (outgoingWins) {
                        dispatch(removeContactAttempt(data.peerId));
                        dispatch(addPendingKeyExchange(data));
                        dispatch(setActivePendingKeyExchange(data.peerId));
                    } else {
                        dispatch(removePendingKeyExchange(data.peerId));
                        dispatch(setActivePendingKeyExchange(null));
                    }
                } else {
                    dispatch(addPendingKeyExchange(data));
                    dispatch(setActivePendingKeyExchange(data.peerId));
                }
            } else {
                const alreadyPending = pendingKeyExchangesRef.current.some((pending) => pending.peerId === data.peerId);
                if (alreadyPending) {
                    dispatch(setActivePendingKeyExchange(data.peerId));
                } else {
                    dispatch(setActivePendingKeyExchange(null));
                }
            }
            setNewConversationDialogOpen(false);
        });

        return () => {
            isDisposed = true;
            unsubStatus();
            unsubSent();
        };
    }, [dispatch]);

    useEffect(() => {
        if (isConnected) {
            setIsDHTConnected(true);
        }
    }, [isConnected]);

    const handleShowNewConversationDialog = () => {
        if (!isRegistered || registrationInProgress) {
            toast.error('Register before starting a new conversation.');
            setDropdownOpen(false);
            return;
        }

        setError(undefined);
        setNewConversationDialogOpen(true);
        setDropdownOpen(false);
    }

    const handleShowImportTrustedUserDialog = () => {
        setImportTrustedUserDialogOpen(true);
        setDropdownOpen(false);
    }

    const handleShowNewGroupDialog = () => {
        setNewGroupDialogOpen(true);
        setDropdownOpen(false);
    }

    const handleGroupCreated = async (groupId: string, chatId: number, inviteDeliveries: GroupInviteDeliveryView[]) => {
        try {
            const result = await window.kiyeovoAPI.getChatById(chatId);
            if (result.success && result.chat) {
                const chat: Chat = {
                    id: result.chat.id,
                    type: result.chat.type as 'direct' | 'group',
                    name: result.chat.name,
                    groupId: result.chat.group_id,
                    lastMessage: '',
                    lastMessageTimestamp: new Date(result.chat.updated_at || result.chat.created_at).getTime(),
                    unreadCount: 0,
                    status: result.chat.status as 'active' | 'pending' | 'awaiting_acceptance',
                    justCreated: true,
                    fetchedOffline: true,
                    isFetchingOffline: false,
                };
                dispatch(addChat(chat));
            }
        } catch (error) {
            console.error('Failed to fetch group chat:', groupId, error);
        }

        dispatch(setActiveChat(chatId));

        const sent = inviteDeliveries.filter((d) => d.status === 'sent');
        const queued = inviteDeliveries.filter((d) => d.status === 'queued_for_retry');
        if (queued.length === 0) {
            toast.success(`Invites sent: ${sent.length}/${inviteDeliveries.length}.`, "Group created");
            return;
        }

        const queuedNames = queued.map((d) => d.username);
        const preview = queuedNames.slice(0, 3).join(', ');
        const suffix = queuedNames.length > 3 ? ` +${queuedNames.length - 3} more` : '';
        const details = preview ? ` (${preview}${suffix})` : '';
        toast.warning(
            `Invites sent: ${sent.length}/${inviteDeliveries.length}. ${queued.length} queued for retry${details}.`,
            "Group created (partial delivery)"
        );
    }

    const handleImportSuccess = async (chatId: number) => {
        // Fetch the new chat and add it to the state
        try {
            const result = await window.kiyeovoAPI.getChatById(chatId);
            if (result.success && result.chat) {
                const chat: Chat = {
                    id: result.chat.id,
                    type: result.chat.type as 'direct' | 'group',
                    name: result.chat.username || result.chat.name,
                    peerId: result.chat.other_peer_id,
                    lastMessage: result.chat.last_message_content || '',
                    lastMessageTimestamp: result.chat.last_message_timestamp
                        ? new Date(result.chat.last_message_timestamp).getTime()
                        : new Date(result.chat.updated_at || result.chat.created_at).getTime(),
                    lastInboundActivityTimestamp: result.chat.last_inbound_activity_timestamp
                        ? new Date(result.chat.last_inbound_activity_timestamp).getTime()
                        : undefined,
                    unreadCount: 0,
                    status: result.chat.status as 'active' | 'pending' | 'awaiting_acceptance',
                    username: result.chat.username,
                    trusted_out_of_band: result.chat.trusted_out_of_band,
                    justCreated: true,
                    fetchedOffline: true,
                    isFetchingOffline: false,
                };
                dispatch(addChat(chat));
            }
        } catch (error) {
            console.error('Failed to fetch chat:', error);
        }

        dispatch(setActiveChat(chatId));
        toast.success("You can now send encrypted messages to this user.", "User imported successfully");
    }

    return <>
        <div className={collapsed ? "w-full p-3 flex flex-col items-center gap-3" : "w-full p-4 flex"}>
            <div className={collapsed ? "flex flex-col items-center gap-3" : "w-full flex items-center justify-between"}>
                {collapsed ? (
                    <button
                        onClick={onOpenBootstrapSetup}
                        className="flex cursor-pointer items-center justify-center w-8 h-8 rounded-md transition-colors hover:bg-sidebar-accent"
                        title={statusText}
                        aria-label={`${statusText}. Open Bootstrap setup`}
                    >
                        <span className={`w-2.5 h-2.5 rounded-full ${isDHTConnected === null ? "bg-muted-foreground" : isDHTConnected ? "bg-success pulse-online" : "bg-destructive"}`} />
                    </button>
                ) : (
                    <button
                        onClick={onOpenBootstrapSetup}
                        className={`flex cursor-pointer items-center gap-2 px-2 py-1 rounded-md transition-colors hover:bg-sidebar-accent group ${isDHTConnected === null ? "text-muted-foreground" : isDHTConnected ? "text-success" : "text-destructive"}`}
                        aria-label={`${statusText}. Open Bootstrap setup`}
                        title="Open setup"
                    >
                        <span className="font-mono text-xs uppercase tracking-wider">
                            {statusText}
                        </span>
                        <span className={`w-2 h-2 rounded-full mb-0.5 ${isDHTConnected === null ? "bg-muted-foreground" : isDHTConnected ? "bg-success pulse-online" : "bg-destructive"}`} />
                    </button>
                )}
                <DropdownMenu
                    open={dropdownOpen}
                    onOpenChange={setDropdownOpen}
                    align={collapsed ? "start" : "end"}
                    trigger={
                        <Button
                            variant="ghost"
                            size="icon"
                            className="text-sidebar-foreground hover:text-primary bg-secondary/50 border"
                        >
                            <Plus className="w-5 h-5" />
                        </Button>
                    }
                >
                    <DropdownMenuItem
                        icon={<MessageSquarePlus className="w-4 h-4" />}
                        onClick={handleShowNewConversationDialog}
                    >
                        New Conversation
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        icon={<UserPlus className="w-4 h-4" />}
                        onClick={handleShowImportTrustedUserDialog}
                    >
                        Import Trusted User
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        icon={<Users className="w-4 h-4" />}
                        onClick={handleShowNewGroupDialog}
                    >
                        New Group
                    </DropdownMenuItem>
                </DropdownMenu>
            </div>
        </div>
        <NewConversationDialog
            open={newConversationDialogOpen}
            onOpenChange={(open) => {
                setNewConversationDialogOpen(open);
                if (!open) {
                    setError(undefined);
                }
            }}
            onNewConversation={handleNewConversation}
            backendError={error}
            setError={setError}
        />
        <ImportTrustedUserDialog
            open={importTrustedUserDialogOpen}
            onOpenChange={setImportTrustedUserDialogOpen}
            onSuccess={handleImportSuccess}
        />
        <NewGroupDialog
            open={newGroupDialogOpen}
            onOpenChange={setNewGroupDialogOpen}
            onSuccess={handleGroupCreated}
        />
    </>
};
