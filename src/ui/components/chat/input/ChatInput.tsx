import { useState, useEffect, useRef, type FC } from "react";
import { Button } from "../../ui/Button";
import { Paperclip, Send, Smile } from "lucide-react";
import { Input } from "../../ui/Input";
import { useToast } from "../../ui/use-toast";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { SendFileDialog } from "./SendFileDialog";
import { addMessage, addSendingMessage, finalizeSendingMessage, removeMessageById, updateChat, updateFileTransferStatus, updateLocalMessageSendState } from "../../../state/slices/chatSlice";
import { EMOJI_CATEGORIES, MAX_MESSAGE_CONTENT_LENGTH, UNEXPECTED_ERROR } from "../../../constants";
import { getGroupStatusMessage } from "../../../utils/groupStatusMessages";
import { errStr } from '../../../../core/utils/general-error';
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";

type PendingSendJob =
    | { type: 'direct'; chatId: number; peerId: string; content: string; localMessageId: string }
    | { type: 'group'; chatId: number; content: string; localMessageId: string };

type SendResult = {
    success: boolean;
    messageId?: string;
    timestamp?: number;
    messageSentStatus?: 'online' | 'offline' | null;
    error?: string;
    failedReason?: 'group_rekeying' | 'other';
};

export const ChatInput: FC = () => {
    const { toast } = useToast();
    const dispatch = useDispatch();
    const [draftByChatId, setDraftByChatId] = useState<Record<number, string>>({});
    const [fileDialogOpen, setFileDialogOpen] = useState(false);
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const activeChat = useSelector((state: RootState) => state.chat.activeChat);
    const myPeerId = useSelector((state: RootState) => state.user.peerId);
    const myUsername = useSelector((state: RootState) => state.user.username);
    const isTorActive = useSelector((state: RootState) => state.user.torEnabled);
    const messages = useSelector((state: RootState) => state.chat.messages);
    const isBlocked = activeChat?.blocked || false;
    const [groupHasOtherMembers, setGroupHasOtherMembers] = useState(true);

    useEffect(() => {
        let isMounted = true;
        let unsubscribe: (() => void) | undefined;

        const refreshGroupMemberState = async () => {
            if (!activeChat || activeChat.type !== 'group') {
                if (isMounted) setGroupHasOtherMembers(true);
                return;
            }
            try {
                const result = await window.kiyeovoAPI.getGroupMembers(activeChat.id);
                if (!isMounted || !result.success) return;
                const hasOtherMembers = result.members.some((member) => member.peerId !== myPeerId && member.status !== 'pending');
                setGroupHasOtherMembers(hasOtherMembers);
            } catch {
                // Keep previous value on transient errors.
            }
        };

        void refreshGroupMemberState();

        if (activeChat?.type === 'group') {
            unsubscribe = window.kiyeovoAPI.onGroupMembersUpdated((event) => {
                if (event.chatId === activeChat.id) {
                    void refreshGroupMemberState();
                }
            });
        }

        return () => {
            isMounted = false;
            unsubscribe?.();
        };
    }, [activeChat?.id, activeChat?.type, myPeerId]);

    const groupBlockedReason = activeChat?.type === 'group' && activeChat?.groupStatus !== 'active'
        ? (getGroupStatusMessage(activeChat?.groupStatus) ?? 'Group is not active yet')
        : activeChat?.type === 'group' && !groupHasOtherMembers
            ? 'Cannot send messages to an empty group'
            : null;
    const hasActiveFileTransfer = !!activeChat && activeChat.type === 'direct' && messages.some((m) =>
        m.chatId === activeChat.id &&
        m.messageType === 'file' &&
        (
            m.transferStatus === 'connecting' ||
            m.transferStatus === 'awaiting_acceptance' ||
            m.transferStatus === 'in_progress' ||
            (m.transferStatus === 'pending' && m.senderPeerId === myPeerId)
        )
    );
    const isDisabled = isBlocked || !!groupBlockedReason;
    const sendQueueRef = useRef<Record<number, PendingSendJob[]>>({});
    const processingQueueRef = useRef<Record<number, boolean>>({});
    const inputRef = useRef<HTMLInputElement>(null);
    const sendButtonRef = useRef<HTMLButtonElement>(null);
    const emojiPickerRef = useRef<HTMLDivElement>(null);
    const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
    const caretRestoreFrameRef = useRef<number | null>(null);
    const selectionSyncUnlockFrameRef = useRef<number | null>(null);
    const suppressSelectionSyncRef = useRef(false);

    // Auto-focus input when chat changes
    useEffect(() => {
        if (activeChat && !isDisabled) {
            inputRef.current?.focus();
        }
    }, [activeChat?.id, isDisabled]);

    useEffect(() => {
        return () => {
            if (caretRestoreFrameRef.current !== null) {
                cancelAnimationFrame(caretRestoreFrameRef.current);
            }
            if (selectionSyncUnlockFrameRef.current !== null) {
                cancelAnimationFrame(selectionSyncUnlockFrameRef.current);
            }
        };
    }, []);

    useEffect(() => {
        setEmojiPickerOpen(false);
    }, [activeChat?.id]);

    useEffect(() => {
        if (isDisabled) {
            setEmojiPickerOpen(false);
        }
    }, [isDisabled]);

    useEffect(() => {
        if (!emojiPickerOpen) return;

        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (emojiPickerRef.current?.contains(target)) return;
            setEmojiPickerOpen(false);
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            setEmojiPickerOpen(false);
            inputRef.current?.focus();
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [emojiPickerOpen]);

    const activeChatId = activeChat?.id;
    const inputQuery = activeChatId ? (draftByChatId[activeChatId] ?? "") : "";

    const setDraftForChat = (
        chatId: number,
        value: string | ((currentValue: string) => string)
    ) => {
        setDraftByChatId((prev) => {
            const currentValue = prev[chatId] ?? "";
            const nextValue = typeof value === 'function' ? value(currentValue) : value;
            return { ...prev, [chatId]: nextValue };
        });
    };

    const syncSelectionFromInput = (target?: HTMLInputElement | null) => {
        if (suppressSelectionSyncRef.current) return;
        const input = target ?? inputRef.current;
        const currentLength = input?.value.length ?? inputQuery.length;
        const fallbackPosition = currentLength;
        const start = Math.min(input?.selectionStart ?? fallbackPosition, currentLength);
        const end = Math.min(input?.selectionEnd ?? start, currentLength);
        selectionRef.current = { start, end };
    };

    const handleEmojiButtonMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        syncSelectionFromInput();
    };

    const handleEmojiButtonClick = () => {
        if (!activeChat || isDisabled) return;
        syncSelectionFromInput();
        setEmojiPickerOpen((prev) => !prev);
    };

    const handleEmojiClick = (emojiData: EmojiClickData) => {
        if (!activeChat) return;
        let nextCursor = selectionRef.current.end;

        setDraftForChat(activeChat.id, (currentDraft) => {
            const start = Math.min(selectionRef.current.start, currentDraft.length);
            const end = Math.min(selectionRef.current.end, currentDraft.length);
            nextCursor = start + emojiData.emoji.length;
            selectionRef.current = { start: nextCursor, end: nextCursor };
            return `${currentDraft.slice(0, start)}${emojiData.emoji}${currentDraft.slice(end)}`;
        });

        if (caretRestoreFrameRef.current !== null) {
            cancelAnimationFrame(caretRestoreFrameRef.current);
        }

        caretRestoreFrameRef.current = requestAnimationFrame(() => {
            caretRestoreFrameRef.current = null;
            suppressSelectionSyncRef.current = true;
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(nextCursor, nextCursor);
            selectionRef.current = { start: nextCursor, end: nextCursor };

            if (selectionSyncUnlockFrameRef.current !== null) {
                cancelAnimationFrame(selectionSyncUnlockFrameRef.current);
            }
            selectionSyncUnlockFrameRef.current = requestAnimationFrame(() => {
                selectionSyncUnlockFrameRef.current = null;
                suppressSelectionSyncRef.current = false;
            });
        });
    };

    const performSendMessage = async (peerIdOrUsername: string, messageContent: string): Promise<SendResult> => {
        try {
            const { success, error, message, messageSentStatus } = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, messageContent);

            if (!success) {
                toast.error(error || 'Failed to send message');
                return { success: false };
            }
            return {
                success: true,
                messageId: message?.messageId,
                timestamp: message?.timestamp,
                messageSentStatus: messageSentStatus ?? undefined,
            };
            // Note: Message will be added to Redux via onMessageReceived event in Main.tsx
            // This ensures single source of truth and correct sender information
        } catch (err) {
            console.error('Failed to send message:', err);
            toast.error(errStr(err, UNEXPECTED_ERROR));
            return { success: false };
        }
    };

    const performSendGroupMessage = async (
        chatId: number,
        messageContent: string,
        options?: { rekeyRetryHint?: boolean }
    ): Promise<SendResult> => {
        try {
            const { success, error, warning, offlineBackupRetry, message, messageSentStatus } = await window.kiyeovoAPI.sendGroupMessage(chatId, messageContent, options);
            if (!success) {
                const errorText = error || 'Failed to send group message';
                let failedReason: 'group_rekeying' | 'other' = 'other';
                if (errorText.includes('is not active')) {
                    const chatState = await window.kiyeovoAPI.getChatById(chatId);
                    if (chatState.success && chatState.chat?.group_status === 'rekeying') {
                        failedReason = 'group_rekeying';
                    }
                }
                toast.error(errorText);
                return { success: false, error: errorText, failedReason };
            } else if (warning && offlineBackupRetry) {
                toast.warningAction(
                    warning,
                    'Retry offline backup',
                    async () => {
                        const retry = await window.kiyeovoAPI.retryGroupOfflineBackup(
                            offlineBackupRetry.chatId,
                            offlineBackupRetry.messageId,
                        );
                        if (retry.success) {
                            toast.success('Group offline backup synced');
                        } else {
                            toast.error(retry.error || 'Failed to retry group offline backup');
                        }
                    },
                );
            }
            return {
                success: true,
                messageId: message?.messageId,
                timestamp: message?.timestamp,
                messageSentStatus: messageSentStatus ?? undefined,
            };
        } catch (err) {
            console.error('Failed to send group message:', err);
            toast.error(errStr(err, UNEXPECTED_ERROR));
            return { success: false, error: errStr(err, UNEXPECTED_ERROR), failedReason: 'other' };
        }
    };

    const processQueueForChat = async (chatId: number) => {
        if (processingQueueRef.current[chatId]) return;
        processingQueueRef.current[chatId] = true;

        try {
            while ((sendQueueRef.current[chatId]?.length ?? 0) > 0) {
                const next = sendQueueRef.current[chatId]!.shift()!;
                dispatch(updateLocalMessageSendState({ messageId: next.localMessageId, state: 'sending' }));

                let result: SendResult = { success: false };
                if (next.type === 'group') {
                    result = await performSendGroupMessage(next.chatId, next.content);
                } else {
                    result = await performSendMessage(next.peerId, next.content);
                }

                if (!result.success) {
                    const isRekeyFailure = next.type === 'group' && result.failedReason === 'group_rekeying';
                    dispatch(updateLocalMessageSendState({
                        messageId: next.localMessageId,
                        state: 'failed',
                        failedReason: isRekeyFailure ? 'group_rekeying' : 'other',
                        retryAfterTs: isRekeyFailure ? Date.now() + 30_000 : undefined,
                    }));
                } else if (result.messageId) {
                    // Finalize local sending row immediately using backend response.
                    dispatch(finalizeSendingMessage({
                        localMessageId: next.localMessageId,
                        finalMessage: {
                            id: result.messageId,
                            chatId: next.chatId,
                            senderPeerId: myPeerId || '',
                            senderUsername: myUsername || 'You',
                            content: next.content,
                            timestamp: result.timestamp ?? Date.now(),
                            messageType: 'text',
                            messageSentStatus: result.messageSentStatus ?? 'online',
                            currentUserPeerId: myPeerId ?? undefined,
                        },
                    }));
                } else {
                    dispatch(updateLocalMessageSendState({ messageId: next.localMessageId, state: 'failed' }));
                }
            }
        } finally {
            processingQueueRef.current[chatId] = false;
            setTimeout(() => {
                if (activeChat?.id === chatId) {
                    inputRef.current?.focus();
                }
            }, 200);
        }
    };

    const enqueueSendJob = (job: PendingSendJob) => {
        if (!sendQueueRef.current[job.chatId]) {
            sendQueueRef.current[job.chatId] = [];
        }
        sendQueueRef.current[job.chatId].push(job);
        void processQueueForChat(job.chatId);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        const activeElement = document.activeElement;
        if (
            activeElement &&
            activeElement !== inputRef.current &&
            activeElement !== sendButtonRef.current
        ) {
            return;
        }

        if (!activeChat) {
            toast.error('No active chat selected');
            return;
        }
        const messageContent = inputQuery.trim();
        if (!messageContent) {
            return;
        }
        if (messageContent.length > MAX_MESSAGE_CONTENT_LENGTH) {
            toast.error(`Message too long. Max ${MAX_MESSAGE_CONTENT_LENGTH} characters`);
            return;
        }
        const chatId = activeChat.id;
        const localMessageId = `local-send-${chatId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        dispatch(addSendingMessage({
            id: localMessageId,
            chatId,
            senderPeerId: myPeerId || '',
            senderUsername: myUsername || 'You',
            content: messageContent,
            timestamp: Date.now(),
            messageType: 'text',
            messageSentStatus: null,
            currentUserPeerId: myPeerId,
            localSendState: 'queued',
        }));

        if (activeChat.type === 'group') {
            enqueueSendJob({ type: 'group', chatId, content: messageContent, localMessageId });
        } else {
            if (!activeChat.peerId) {
                toast.error('No peer ID found for active chat');
                dispatch(updateLocalMessageSendState({ messageId: localMessageId, state: 'failed' }));
                return;
            }
            enqueueSendJob({ type: 'direct', chatId, peerId: activeChat.peerId, content: messageContent, localMessageId });
        }
        setDraftForChat(chatId, '');
        selectionRef.current = { start: 0, end: 0 };
        setEmojiPickerOpen(false);
    };

    const handleSendFile = async (filePath: string, fileName: string, fileSize: number) => {
        if (!activeChat?.peerId) {
            toast.error('No active chat selected');
            return;
        }

        const previousLastMessage = activeChat.lastMessage;
        const previousLastMessageTimestamp = activeChat.lastMessageTimestamp;
        const chatId = activeChat.id;
        const pendingMessageId =
            globalThis.crypto?.randomUUID?.() ??
            `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        try {
            dispatch(addMessage({
                id: pendingMessageId,
                chatId,
                senderPeerId: myPeerId || '',
                senderUsername: myUsername || 'You',
                content: `${fileName} (${fileSize} bytes)`,
                timestamp: Date.now(),
                messageType: 'file',
                messageSentStatus: 'online',
                currentUserPeerId: myPeerId,
                fileName: fileName,
                fileSize: fileSize,
                transferStatus: 'connecting',
                transferProgress: 0,
            }));

            const result = await window.kiyeovoAPI.sendFile(activeChat.peerId, filePath, pendingMessageId);
            if (!result.success) {
                const errorText = result.error?.toLowerCase() || '';
                console.error(result.error);
                const failedBeforePersist = errorText.includes('dial request has no valid addresses');
                const transferBusy = errorText.includes('already active with this peer');
                if (failedBeforePersist) {
                    toast.error('Cannot send file to offline user');
                } else if (transferBusy) {
                    toast.error('Another file transfer is already active with this peer');
                } else if (!errorText.includes('timeout waiting for file acceptance') && !errorText.includes('rejected')) {
                    toast.error(result.error || 'Failed to send file');
                }
                if (failedBeforePersist || transferBusy) {
                    dispatch(removeMessageById({ messageId: pendingMessageId, chatId }));
                    dispatch(updateChat({
                        id: chatId,
                        updates: {
                            lastMessage: previousLastMessage,
                            lastMessageTimestamp: previousLastMessageTimestamp
                        }
                    }));
                    return;
                }
                const status =
                    errorText.includes('timeout waiting for file acceptance') ? 'expired' :
                        errorText.includes('rejected') ? 'rejected' :
                            'failed';
                dispatch(updateFileTransferStatus({
                    messageId: pendingMessageId,
                    status,
                    transferError: result.error || (status === 'expired' ? 'Offer expired' : 'Offer rejected')
                }));
            }
        } catch (error) {
            console.error('Error sending file:', error);
            toast.error(errStr(error, 'Failed to send file'));
            const errorText = error instanceof Error ? error.message.toLowerCase() : '';
            const failedBeforePersist = errorText.includes('dial request has no valid addresses');
            const transferBusy = errorText.includes('already active with this peer');
            if (failedBeforePersist || transferBusy) {
                dispatch(removeMessageById({ messageId: pendingMessageId, chatId }));
                dispatch(updateChat({
                    id: chatId,
                    updates: {
                        lastMessage: previousLastMessage,
                        lastMessageTimestamp: previousLastMessageTimestamp
                    }
                }));
                return;
            }
            const status =
                errorText.includes('timeout waiting for file acceptance') ? 'expired' :
                    errorText.includes('rejected') ? 'rejected' :
                        'failed';
            dispatch(updateFileTransferStatus({
                messageId: pendingMessageId,
                status,
                transferError: errStr(
                    error,
                    status === 'expired' ? 'Offer expired' : 'Offer rejected',
                ),
            }));
        }
    }

    return <>
        <div className="relative">
            <form
                onSubmit={handleSubmit}
                className={`h-20 px-4 flex items-center justify-between border-t border-border gap-4`}
            >
                <div ref={emojiPickerRef} className="relative flex items-center gap-2">
                    {activeChat?.type !== 'group' && <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isDisabled || hasActiveFileTransfer}
                        onClick={() => setFileDialogOpen(true)}
                        className="text-sidebar-foreground hover:text-foreground"
                        aria-label="Open file picker"
                        title="Files"
                    >
                        <Paperclip className="w-4 h-4" />
                    </Button>}
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={!activeChat || isDisabled}
                        onMouseDown={handleEmojiButtonMouseDown}
                        onClick={handleEmojiButtonClick}
                        className={`text-sidebar-foreground hover:text-foreground ${emojiPickerOpen ? 'bg-secondary text-foreground' : ''}`}
                        aria-label="Open emoji picker"
                        title="Emoji"
                    >
                        <Smile className="w-4 h-4" />
                    </Button>
                    {emojiPickerOpen && (
                        <div className="chat-emoji-picker-panel absolute bottom-full left-0 mb-3 z-40">
                            <EmojiPicker
                                onEmojiClick={handleEmojiClick}
                                theme={Theme.DARK}
                                emojiStyle={EmojiStyle.NATIVE}
                                autoFocusSearch={false}
                                searchPlaceholder="Search emojis"
                                skinTonesDisabled={true}
                                previewConfig={{ showPreview: false }}
                                lazyLoadEmojis={true}
                                width={320}
                                height={380}
                                categories={EMOJI_CATEGORIES}
                                className="emoji-picker"
                            />
                        </div>
                    )}
                </div>
                <Input
                    ref={inputRef}
                    placeholder={isBlocked ? "Cannot send messages to blocked users" : groupBlockedReason ?? "Type a message..."}
                    parentClassName="flex flex-1 w-full"
                    value={inputQuery}
                    disabled={isDisabled}
                    onChange={(e) => {
                        if (!activeChat) return;
                        setDraftForChat(activeChat.id, e.target.value);
                        syncSelectionFromInput(e.target);
                    }}
                    onClick={(e) => syncSelectionFromInput(e.currentTarget)}
                    onFocus={(e) => syncSelectionFromInput(e.currentTarget)}
                    onKeyUp={(e) => syncSelectionFromInput(e.currentTarget)}
                    onSelect={(e) => syncSelectionFromInput(e.currentTarget)}
                />
                <Button
                    ref={sendButtonRef}
                    type="submit"
                    disabled={!inputQuery.trim() || isDisabled}
                    size="icon"
                    className={isTorActive ? 'bg-[#5a3184] hover:bg-[#4d2a72] text-white' : ''}
                    aria-label="Send message"
                >
                    <Send className="w-4 h-4" />
                </Button>
            </form>
        </div>

        <SendFileDialog
            open={fileDialogOpen}
            onOpenChange={setFileDialogOpen}
            onSend={handleSendFile}
            transferBlocked={hasActiveFileTransfer}
            transferBlockedReason="Wait for the current file transfer to finish before selecting another file."
        />
    </>
}
