import { useState, useEffect, useLayoutEffect, useRef, type FC } from "react";
import { Button } from "../../ui/Button";
import { Check, Mic, Paperclip, Reply, Send, Smile, X } from "lucide-react";
import { useToast } from "../../ui/use-toast";
import { useOfflineSendWarning } from "../../../hooks/useOfflineSendWarning";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../../state/store";
import { SendFileDialog, type PastedImageFile } from "./SendFileDialog";
import { SendLongMessageDialog, type PendingLongMessage } from "./SendLongMessageDialog";
import { UploadsQuotaDialog } from "./UploadsQuotaDialog";
import { addMessage, addSendingMessage, clearReplyTarget, finalizeSendingMessage, updateFileTransferStatus, updateLocalMessageSendState, type ReplyTarget } from "../../../state/slices/chatSlice";
import { EMOJI_CATEGORIES, MAX_MESSAGE_CONTENT_LENGTH, UNEXPECTED_ERROR } from "../../../constants";
import { getGroupStatusMessage } from "../../../utils/groupStatusMessages";
import { errStr } from '../../../../core/utils/general-error';
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";
import { useConnectivityGuidance } from "../../../hooks/useConnectivityGuidance";
import { ACCEPTED_IMAGE_MIME } from "../../../../shared/file-types";
import { UPLOADS_QUOTA_WARN_BYTES } from "../../../../core/constants";
import { useVoiceRecorder, type VoiceRecorderResult } from "../../../hooks/useVoiceRecorder";

type PendingSendJob =
    | { type: 'direct'; chatId: number; peerId: string; content: string; localMessageId: string; replyToCid?: string }
    | { type: 'group'; chatId: number; content: string; localMessageId: string; replyToCid?: string };

type SendResult = {
    success: boolean;
    messageId?: string;
    timestamp?: number;
    messageSentStatus?: 'online' | 'offline' | null;
    error?: string;
    failedReason?: 'group_rekeying' | 'other';
    // Accepted but still in flight (non-blocking offline send): keep the spinner
    // until a MESSAGE_SEND_STATE_CHANGED event settles the row.
    localSendState?: 'sending';
    // Group message delivered online but the DHT backup failed → show the
    // "Retry offline backup" affordance (re-store only, not re-send).
    backupFailed?: boolean;
    clientMsgId?: string;
};

type FileSendOutcome =
    | { completed: true }
    | {
        completed: false;
        reason: 'invalid_target' | 'failed';
    };

type FileSendTarget = {
    chatId: number;
    peerId?: string;
};

type FileSendOptions = {
    target?: FileSendTarget;
    replyTarget?: ReplyTarget;
    voiceNote?: { durationMs: number };
};

type FileDialogSource = FileSendTarget & {
    replyTarget?: ReplyTarget;
};

const MAX_COMPOSER_LINES = 5;
let uploadsQuotaWarnedThisSession = false;

const createPastedImageName = (date: Date, extension: string): string => {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `pasted-image-${year}${month}${day}-${hours}${minutes}${seconds}.${extension}`;
};

const createVoiceNoteName = (date: Date): string => {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `voice-note-${year}${month}${day}-${hours}${minutes}${seconds}.webm`;
};

const formatRecordingTime = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const createLongMessageName = (date: Date): string => {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `long-message-${year}${month}${day}-${hours}${minutes}${seconds}.txt`;
};

type ChatInputProps = {
    onOfflineInboxRelevant?: () => void;
    selectionMode?: boolean;
    searchMode?: boolean;
};

export const ChatInput: FC<ChatInputProps> = ({
    onOfflineInboxRelevant,
    selectionMode = false,
    searchMode = false,
}) => {
    const { toast } = useToast();
    const { showMessageFailureGuidance } = useConnectivityGuidance();
    const warnOfflineSend = useOfflineSendWarning();
    const dispatch = useDispatch();
    const [draftByChatId, setDraftByChatId] = useState<Record<number, string>>({});
    const [fileDialogOpen, setFileDialogOpen] = useState(false);
    const [pastedFile, setPastedFile] = useState<PastedImageFile | null>(null);
    const [fileDialogSource, setFileDialogSource] = useState<FileDialogSource | null>(null);
    const [longMessageDialogOpen, setLongMessageDialogOpen] = useState(false);
    const [pendingLongMessage, setPendingLongMessage] = useState<PendingLongMessage | null>(null);
    const [pendingQuotaFilePath, setPendingQuotaFilePath] = useState<string | null>(null);
    const [quotaFilePath, setQuotaFilePath] = useState<string | null>(null);
    const [quotaDialogOpen, setQuotaDialogOpen] = useState(false);
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const activeChat = useSelector((state: RootState) => state.chat.activeChat);
    const chats = useSelector((state: RootState) => state.chat.chats);
    const myPeerId = useSelector((state: RootState) => state.user.peerId);
    const myUsername = useSelector((state: RootState) => state.user.username);
    const isTorActive = useSelector((state: RootState) => state.user.torEnabled);
    const messages = useSelector((state: RootState) => state.chat.messages);
    const replyTargetByChatId = useSelector((state: RootState) => state.chat.replyTargetByChatId);
    const replyTarget = activeChat ? replyTargetByChatId[activeChat.id] : undefined;
    const activeChatId = activeChat?.id;
    const activeChatType = activeChat?.type;
    const isBlocked = activeChat?.blocked || false;
    const [groupHasOtherMembers, setGroupHasOtherMembers] = useState(true);

    useEffect(() => {
        if (!pastedFile?.previewUrl) return;
        const previewUrl = pastedFile.previewUrl;
        return () => {
            URL.revokeObjectURL(previewUrl);
        };
    }, [pastedFile?.previewUrl]);

    useEffect(() => {
        let isMounted = true;
        let unsubscribe: (() => void) | undefined;

        const refreshGroupMemberState = async () => {
            if (!activeChatId || activeChatType !== 'group') {
                if (isMounted) setGroupHasOtherMembers(true);
                return;
            }
            try {
                const result = await window.kiyeovoAPI.getGroupMembers(activeChatId);
                if (!isMounted || !result.success) return;
                const hasOtherMembers = result.members.some((member) => member.peerId !== myPeerId && member.status !== 'pending');
                setGroupHasOtherMembers(hasOtherMembers);
            } catch {
                // Keep previous value on transient errors.
            }
        };

        void refreshGroupMemberState();

        if (activeChatType === 'group') {
            unsubscribe = window.kiyeovoAPI.onGroupMembersUpdated((event) => {
                if (event.chatId === activeChatId) {
                    void refreshGroupMemberState();
                }
            });
        }

        return () => {
            isMounted = false;
            unsubscribe?.();
        };
    }, [activeChatId, activeChatType, myPeerId]);

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
            m.transferStatus === 'in_progress'
        )
    );
    const interactionBlocked = selectionMode || searchMode;
    const isDisabled = interactionBlocked || isBlocked || !!groupBlockedReason;
    const sendQueueRef = useRef<Record<number, PendingSendJob[]>>({});
    const processingQueueRef = useRef<Record<number, boolean>>({});
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const sendButtonRef = useRef<HTMLButtonElement>(null);
    const emojiPickerRef = useRef<HTMLDivElement>(null);
    const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
    const caretRestoreFrameRef = useRef<number | null>(null);
    const selectionSyncUnlockFrameRef = useRef<number | null>(null);
    const resizeAnimationFrameRef = useRef<number | null>(null);
    const suppressSelectionSyncRef = useRef(false);
    const draftRevisionByChatIdRef = useRef<Record<number, number>>({});
    const replyTargetByChatIdRef = useRef(replyTargetByChatId);
    const activeChatIdRef = useRef(activeChatId);
    const hasActiveFileTransferRef = useRef(hasActiveFileTransfer);
    replyTargetByChatIdRef.current = replyTargetByChatId;
    activeChatIdRef.current = activeChatId;
    hasActiveFileTransferRef.current = hasActiveFileTransfer;

    const createCurrentFileDialogSource = (): FileDialogSource | null => {
        if (!activeChat) {
            return null;
        }
        if (activeChat.type === 'direct' && !activeChat.peerId) {
            return null;
        }
        return {
            chatId: activeChat.id,
            ...(activeChat.peerId ? { peerId: activeChat.peerId } : {}),
            ...(replyTarget ? { replyTarget } : {}),
        };
    };

    const voiceRecordTargetRef = useRef<FileDialogSource | null>(null);

    // Shared completion path for a finished recording, used both by the manual stop-and-send
    // button and by the recorder hook's 60s hard-cap auto-stop (see the onAutoStop argument
    // below) — hitting the cap must send exactly like a manual stop, not silently drop the note.
    const finishRecordingAndSend = async (result: VoiceRecorderResult | null) => {
        const recordedTarget = voiceRecordTargetRef.current;
        voiceRecordTargetRef.current = null;
        if (!result) return;

        const { bytes, durationMs } = result;
        const fileName = createVoiceNoteName(new Date());
        try {
            const saveResult = await window.kiyeovoAPI.saveVoiceNoteUpload(bytes, fileName, durationMs);
            if (!saveResult.success || !saveResult.filePath) {
                toast.error(saveResult.error || 'Failed to save voice message');
                return;
            }
            if (!uploadsQuotaWarnedThisSession && saveResult.uploadsDirSizeBytes > UPLOADS_QUOTA_WARN_BYTES) {
                uploadsQuotaWarnedThisSession = true;
                setQuotaFilePath(saveResult.filePath);
                setQuotaDialogOpen(true);
            }

            await handleSendFile(
                saveResult.filePath,
                saveResult.fileName || fileName,
                saveResult.fileSize,
                saveResult.mediaToken,
                {
                    ...(recordedTarget ? {
                        target: {
                            chatId: recordedTarget.chatId,
                            ...(recordedTarget.peerId ? { peerId: recordedTarget.peerId } : {}),
                        },
                        ...(recordedTarget.replyTarget ? { replyTarget: recordedTarget.replyTarget } : {}),
                    } : {}),
                    voiceNote: { durationMs },
                },
            );
        } catch (error) {
            console.error('Error sending voice message:', error);
            toast.error(errStr(error, 'Failed to send voice message'));
        }
    };

    const voiceRecorder = useVoiceRecorder(undefined, finishRecordingAndSend);

    useEffect(() => {
        if (voiceRecorder.error) {
            toast.error(voiceRecorder.error);
        }
    }, [voiceRecorder.error, toast]);

    const handleMicClick = async () => {
        if (isDisabled || hasActiveFileTransfer || voiceRecorder.state !== 'idle') return;
        voiceRecordTargetRef.current = createCurrentFileDialogSource();
        await voiceRecorder.start();
    };

    const handleCancelRecording = () => {
        voiceRecordTargetRef.current = null;
        voiceRecorder.cancel();
    };

    const handleStopAndSendRecording = async () => {
        const result = await voiceRecorder.stopAndFinish();
        await finishRecordingAndSend(result);
    };

    const clearReplyTargetIfUnchanged = (chatId: number, target?: ReplyTarget): boolean => {
        if (!target) return false;
        const current = replyTargetByChatIdRef.current[chatId];
        if (current?.cid !== target.cid) return false;

        dispatch(clearReplyTarget(chatId));
        const nextTargets = { ...replyTargetByChatIdRef.current };
        delete nextTargets[chatId];
        replyTargetByChatIdRef.current = nextTargets;
        return true;
    };

    // Auto-focus input when chat changes
    useEffect(() => {
        if (activeChatId && !isDisabled) {
            inputRef.current?.focus();
        }
    }, [activeChatId, isDisabled]);

    // Selecting Reply happens in the message list, but the composer owns focus.
    useEffect(() => {
        if (!replyTarget || isDisabled) return;

        const frameId = requestAnimationFrame(() => {
            const input = inputRef.current;
            if (!input) return;
            const cursorPosition = input.value.length;
            input.focus();
            input.setSelectionRange(cursorPosition, cursorPosition);
            selectionRef.current = { start: cursorPosition, end: cursorPosition };
        });

        return () => cancelAnimationFrame(frameId);
    }, [replyTarget, isDisabled]);

    useEffect(() => {
        return () => {
            if (caretRestoreFrameRef.current !== null) {
                cancelAnimationFrame(caretRestoreFrameRef.current);
            }
            if (selectionSyncUnlockFrameRef.current !== null) {
                cancelAnimationFrame(selectionSyncUnlockFrameRef.current);
            }
            if (resizeAnimationFrameRef.current !== null) {
                cancelAnimationFrame(resizeAnimationFrameRef.current);
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
        if (!interactionBlocked) return;
        setEmojiPickerOpen(false);
        setFileDialogOpen(false);
        setFileDialogSource(null);
        setLongMessageDialogOpen(false);
        inputRef.current?.blur();
    }, [interactionBlocked]);

    useEffect(() => {
        if (!pendingLongMessage || activeChatId === pendingLongMessage.chatId) return;
        setLongMessageDialogOpen(false);
    }, [activeChatId, pendingLongMessage]);

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

    const inputQuery = activeChatId ? (draftByChatId[activeChatId] ?? "") : "";

    const resizeComposer = (target?: HTMLTextAreaElement | null) => {
        const textarea = target ?? inputRef.current;
        if (!textarea) {
            return;
        }

        if (resizeAnimationFrameRef.current !== null) {
            cancelAnimationFrame(resizeAnimationFrameRef.current);
            resizeAnimationFrameRef.current = null;
        }

        const currentHeight = textarea.getBoundingClientRect().height;

        textarea.style.height = 'auto';

        const computedStyle = window.getComputedStyle(textarea);
        const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 24;
        const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
        const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
        const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
        const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;
        const singleLineHeight = Math.ceil(lineHeight + paddingTop + paddingBottom + borderTop + borderBottom);
        const maxHeight = Math.ceil((lineHeight * MAX_COMPOSER_LINES) + paddingTop + paddingBottom + borderTop + borderBottom);
        const contentHeight = textarea.scrollHeight;
        const targetHeight = Math.max(singleLineHeight, Math.min(contentHeight, maxHeight));
        const shouldScroll = contentHeight > maxHeight;

        textarea.style.overflowY = shouldScroll ? 'auto' : 'hidden';

        if (!Number.isFinite(currentHeight) || currentHeight <= 0) {
            textarea.style.height = `${targetHeight}px`;
            return;
        }

        if (Math.abs(currentHeight - targetHeight) < 0.5) {
            textarea.style.height = `${targetHeight}px`;
            return;
        }

        textarea.style.height = `${currentHeight}px`;
        void textarea.offsetHeight;

        resizeAnimationFrameRef.current = requestAnimationFrame(() => {
            resizeAnimationFrameRef.current = null;
            textarea.style.height = `${targetHeight}px`;
        });
    };

    useLayoutEffect(() => {
        resizeComposer();
    }, [activeChatId, inputQuery]);

    const setDraftForChat = (
        chatId: number,
        value: string | ((currentValue: string) => string)
    ) => {
        draftRevisionByChatIdRef.current[chatId] =
            (draftRevisionByChatIdRef.current[chatId] ?? 0) + 1;
        setDraftByChatId((prev) => {
            const currentValue = prev[chatId] ?? "";
            const nextValue = typeof value === 'function' ? value(currentValue) : value;
            return { ...prev, [chatId]: nextValue };
        });
    };

    const queueUploadsQuotaWarning = (
        savedFilePath: string,
        uploadsDirSizeBytes: number,
    ) => {
        if (
            uploadsQuotaWarnedThisSession
            || uploadsDirSizeBytes <= UPLOADS_QUOTA_WARN_BYTES
        ) {
            return;
        }
        setPendingQuotaFilePath(savedFilePath);
    };

    const showQueuedUploadsQuotaWarning = () => {
        if (!pendingQuotaFilePath) return;

        const savedFilePath = pendingQuotaFilePath;
        setPendingQuotaFilePath(null);
        if (uploadsQuotaWarnedThisSession) return;

        uploadsQuotaWarnedThisSession = true;
        setQuotaFilePath(savedFilePath);
        setQuotaDialogOpen(true);
    };

    const syncSelectionFromInput = (target?: HTMLTextAreaElement | null) => {
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

    const performSendMessage = async (peerIdOrUsername: string, messageContent: string, replyToCid?: string): Promise<SendResult> => {
        try {
            const {
                success,
                error,
                message,
                messageSentStatus,
                localSendState,
                connectivityFailure,
            } = await window.kiyeovoAPI.sendMessage(peerIdOrUsername, messageContent, replyToCid);

            if (!success) {
                if (error === 'OFFLINE_BUCKET_FULL') {
                    onOfflineInboxRelevant?.();
                    if (activeChat?.type === 'direct' && activeChat.peerId) {
                        void window.kiyeovoAPI.requestOfflineInboxRecovery(activeChat.peerId).catch(() => undefined);
                    }
                }
                const guidanceShown = connectivityFailure
                    ? showMessageFailureGuidance(connectivityFailure)
                    : false;
                if (!guidanceShown) {
                    toast.error(
                        error === 'OFFLINE_BUCKET_FULL'
                            ? `${activeChat?.name || 'This contact'}'s offline inbox is full — wait until they come online.`
                            : (error || 'Failed to send message'),
                    );
                }
                return { success: false, error: error ?? undefined };
            }
            // Don't warn yet for a still-in-flight offline send — we don't know the outcome.
            if (localSendState !== 'sending') {
                warnOfflineSend();
            }
            if (messageSentStatus === 'offline') {
                onOfflineInboxRelevant?.();
            }
            return {
                success: true,
                messageId: message?.messageId,
                timestamp: message?.timestamp,
                messageSentStatus: messageSentStatus ?? undefined,
                localSendState,
                clientMsgId: message?.clientMsgId,
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
        options?: { rekeyRetryHint?: boolean; replyToCid?: string }
    ): Promise<SendResult> => {
        try {
            const {
                success,
                error,
                warning,
                offlineBackupRetry,
                message,
                messageSentStatus,
                connectivityFailure,
            } = await window.kiyeovoAPI.sendGroupMessage(chatId, messageContent, options);
            if (!success) {
                const errorText = error || 'Failed to send group message';
                let failedReason: 'group_rekeying' | 'other' = 'other';
                if (errorText.includes('is not active')) {
                    const chatState = await window.kiyeovoAPI.getChatById(chatId);
                    if (chatState.success && chatState.chat?.group_status === 'rekeying') {
                        failedReason = 'group_rekeying';
                    }
                }
                if (!connectivityFailure || !showMessageFailureGuidance(connectivityFailure)) {
                    toast.error(errorText);
                }
                return { success: false, error: errorText, failedReason };
            } else if (warning && offlineBackupRetry) {
                toast.warning(warning);
            }
            warnOfflineSend();
            onOfflineInboxRelevant?.();
            return {
                success: true,
                messageId: message?.messageId,
                timestamp: message?.timestamp,
                messageSentStatus: messageSentStatus ?? undefined,
                backupFailed: !!(warning && offlineBackupRetry),
                clientMsgId: message?.clientMsgId,
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
                    result = await performSendGroupMessage(next.chatId, next.content, { replyToCid: next.replyToCid });
                } else {
                    result = await performSendMessage(next.peerId, next.content, next.replyToCid);
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
                    // Finalize local sending row using the backend response. For a
                    // non-blocking offline send (localSendState 'sending') keep the
                    // spinner — the MESSAGE_SEND_STATE_CHANGED event settles it later.
                    const stillSending = result.localSendState === 'sending';
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
                            messageSentStatus: stillSending ? null : (result.messageSentStatus ?? 'online'),
                            localSendState: stillSending ? 'sending' : undefined,
                            currentUserPeerId: myPeerId ?? undefined,
                            clientMsgId: result.clientMsgId,
                            replyToClientId: next.replyToCid,
                        },
                    }));
                    // Delivered online but DHT backup failed
                    if (result.backupFailed) {
                        dispatch(updateLocalMessageSendState({
                            messageId: result.messageId,
                            state: 'failed',
                            failedReason: 'offline_backup',
                        }));
                    }
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

    const sendCurrentDraft = async () => {
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
            if (activeChat.type === 'direct') {
                if (!activeChat.peerId) {
                    toast.error('No peer ID found for active chat');
                    return;
                }

                setPendingLongMessage({
                    chatId: activeChat.id,
                    peerId: activeChat.peerId,
                    recipientName: activeChat.username || activeChat.name || 'the recipient',
                    rawDraft: inputQuery,
                    trimmedText: messageContent,
                    draftRevision: draftRevisionByChatIdRef.current[activeChat.id] ?? 0,
                    defaultFileName: createLongMessageName(new Date()),
                    ...(replyTarget ? { replyTarget } : {}),
                });
                setLongMessageDialogOpen(true);
                return;
            }
            toast.error(`Message too long. Max ${MAX_MESSAGE_CONTENT_LENGTH} characters`);
            return;
        }
        const chatId = activeChat.id;

        // Capacity pre-check (direct chats): a full offline mailbox must not even
        // create an optimistic row — keep the draft, toast, and stop
        if (activeChat.type === 'direct' && activeChat.peerId) {
            const inFlight = (sendQueueRef.current[chatId]?.length ?? 0)
                + (processingQueueRef.current[chatId] ? 1 : 0);
            const { hasRoom } = await window.kiyeovoAPI.checkOfflineCapacity(activeChat.peerId, inFlight);
            if (!hasRoom) {
                onOfflineInboxRelevant?.();
                if (activeChat.type === 'direct' && activeChat.peerId) {
                    void window.kiyeovoAPI.requestOfflineInboxRecovery(activeChat.peerId).catch(() => undefined);
                }
                toast.error(`${activeChat.name || 'This contact'}'s offline inbox is full — wait until they come online.`);
                return;
            }
        }

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
            // Keep the reply ref on the optimistic row so a retry before backend
            // finalization still sends it as a reply (see retry path).
            replyToClientId: replyTarget?.cid,
        }));

        if (activeChat.type === 'group') {
            enqueueSendJob({ type: 'group', chatId, content: messageContent, localMessageId, replyToCid: replyTarget?.cid });
        } else {
            if (!activeChat.peerId) {
                toast.error('No peer ID found for active chat');
                dispatch(updateLocalMessageSendState({ messageId: localMessageId, state: 'failed' }));
                return;
            }
            enqueueSendJob({ type: 'direct', chatId, peerId: activeChat.peerId, content: messageContent, localMessageId, replyToCid: replyTarget?.cid });
        }
        setDraftForChat(chatId, '');
        selectionRef.current = { start: 0, end: 0 };
        setEmojiPickerOpen(false);
        if (replyTarget) dispatch(clearReplyTarget(chatId));
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        await sendCurrentDraft();
    };

    const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void sendCurrentDraft();
            return;
        }
        if (event.key === 'Escape' && replyTarget && activeChat) {
            event.preventDefault();
            dispatch(clearReplyTarget(activeChat.id));
        }
    };

    const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (
            !activeChat ||
            isDisabled
        ) {
            return;
        }
        if (activeChat.type === 'direct' && !activeChat.peerId) {
            return;
        }

        const imageItem = Array.from(event.clipboardData.items).find((item) =>
            item.kind === 'file' && !!ACCEPTED_IMAGE_MIME[item.type]
        );
        if (!imageItem) return;

        const pastedBlob = imageItem.getAsFile();
        const extension = ACCEPTED_IMAGE_MIME[imageItem.type];
        if (!pastedBlob || !extension) return;

        event.preventDefault();

        if (hasActiveFileTransfer) {
            toast.error('Wait for the current file transfer to finish before sending another file');
            return;
        }

        const chatIdAtPaste = activeChat.id;
        const fileSourceAtPaste = createCurrentFileDialogSource();
        const mime = imageItem.type;
        const name = createPastedImageName(new Date(), extension);
        const previewUrl = URL.createObjectURL(pastedBlob);

        void pastedBlob.arrayBuffer()
            .then((arrayBuffer) => {
                if (activeChatIdRef.current !== chatIdAtPaste) {
                    URL.revokeObjectURL(previewUrl);
                    return;
                }
                if (hasActiveFileTransferRef.current) {
                    URL.revokeObjectURL(previewUrl);
                    toast.error('Wait for the current file transfer to finish before sending another file');
                    return;
                }

                setFileDialogSource(fileSourceAtPaste);
                setPastedFile({
                    bytes: new Uint8Array(arrayBuffer),
                    mime,
                    name,
                    previewUrl,
                    size: pastedBlob.size,
                });
                setFileDialogOpen(true);
            })
            .catch((error) => {
                URL.revokeObjectURL(previewUrl);
                console.error('Failed to read pasted image:', error);
                toast.error('Failed to read pasted image');
            });
    };

    const handleSendFile = async (
        filePath: string,
        fileName: string,
        fileSize: number,
        mediaToken?: string | null,
        options?: FileSendOptions,
    ): Promise<FileSendOutcome> => {
        const target = options?.target;
        const replyTargetForSend = options?.replyTarget;
        const replyToCid = replyTargetForSend?.cid;
        const voiceNote = options?.voiceNote;
        const targetChat = target
            ? chats.find((chat) => chat.id === target.chatId)
            : activeChat;

        if (!targetChat) {
            toast.error('No active chat selected');
            return { completed: false, reason: 'invalid_target' };
        }
        if (targetChat.type === 'direct') {
            const targetPeerId = target?.peerId ?? targetChat.peerId;
            if (!targetPeerId || targetChat.peerId !== targetPeerId) {
                toast.error('No active chat selected');
                return { completed: false, reason: 'invalid_target' };
            }
        }

        const chatId = targetChat.id;
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
                clientMsgId: pendingMessageId,
                fileName: fileName,
                fileSize: fileSize,
                filePreviewToken: mediaToken || undefined,
                transferStatus: 'connecting',
                transferProgress: 0,
                ...(replyToCid ? { replyToClientId: replyToCid } : {}),
                ...(voiceNote ? { isVoiceNote: true, voiceDurationMs: voiceNote.durationMs } : {}),
            }));
            clearReplyTargetIfUnchanged(chatId, replyTargetForSend);

            const result = targetChat.type === 'group'
                ? await window.kiyeovoAPI.sendGroupFile(targetChat.id, filePath, pendingMessageId, replyToCid, voiceNote?.durationMs)
                : await window.kiyeovoAPI.sendFile(targetChat.peerId!, filePath, pendingMessageId, replyToCid, voiceNote?.durationMs);
            if (!result.success) {
                console.error(result.error);
                toast.error(result.error || 'Failed to send file');
                dispatch(updateFileTransferStatus({
                    messageId: pendingMessageId,
                    status: 'failed',
                    transferError: result.error || 'Failed to send file'
                }));
                return {
                    completed: false,
                    reason: 'failed',
                };
            }
            return { completed: true };
        } catch (error) {
            console.error('Error sending file:', error);
            toast.error(errStr(error, 'Failed to send file'));
            dispatch(updateFileTransferStatus({
                messageId: pendingMessageId,
                status: 'failed',
                transferError: errStr(error, 'Failed to send file'),
            }));
            return {
                completed: false,
                reason: 'failed',
            };
        }
    }

    const handlePreparedLongMessage = async (
        file: {
            filePath: string;
            fileName: string;
            fileSize: number;
        },
        source: PendingLongMessage,
    ) => {
        const outcome = await handleSendFile(
            file.filePath,
            file.fileName,
            file.fileSize,
            null,
            {
                target: {
                    chatId: source.chatId,
                    peerId: source.peerId,
                },
                ...(source.replyTarget ? { replyTarget: source.replyTarget } : {}),
            },
        );
        if (!outcome.completed) return;
        if (
            (draftRevisionByChatIdRef.current[source.chatId] ?? 0)
            !== source.draftRevision
        ) {
            return;
        }

        setDraftForChat(source.chatId, '');
        if (activeChatIdRef.current === source.chatId) {
            selectionRef.current = { start: 0, end: 0 };
            setEmojiPickerOpen(false);
        }
    };

    return <>
        <div
            className={interactionBlocked ? "hidden" : "relative"}
            aria-hidden={interactionBlocked}
        >
            {replyTarget && (
                <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-4 py-2">
                    <Reply className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 pl-2 flex flex-col justify-center items-start">
                        <p className="text-xs font-medium text-foreground/80">Replying to {replyTarget.sender}</p>
                        <p className="truncate w-full text-xs text-left text-muted-foreground">{replyTarget.excerpt}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => { if (activeChat) dispatch(clearReplyTarget(activeChat.id)); }}
                        className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-background/40 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label="Cancel reply"
                        title="Cancel reply"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
            <form
                onSubmit={handleSubmit}
                className={`flex min-h-20 items-end justify-between gap-4 px-4 py-3 ${replyTarget ? '' : 'border-t border-border'}`}
            >
                <div ref={emojiPickerRef} className="relative flex shrink-0 items-center gap-2 self-end">
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isDisabled || hasActiveFileTransfer}
                        onClick={() => {
                            setFileDialogSource(createCurrentFileDialogSource());
                            setPastedFile(null);
                            setFileDialogOpen(true);
                        }}
                        className="text-sidebar-foreground hover:text-foreground"
                        aria-label="Open file picker"
                        title="Files"
                    >
                        <Paperclip className="w-4 h-4" />
                    </Button>
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
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={isDisabled || hasActiveFileTransfer || voiceRecorder.state !== 'idle'}
                        onClick={() => void handleMicClick()}
                        className="text-sidebar-foreground hover:text-foreground"
                        aria-label="Record voice message"
                        title="Record voice message"
                    >
                        <Mic className="w-4 h-4" />
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
                {voiceRecorder.state === 'idle' ? (
                    <div className="flex flex-1 items-end gap-4">
                        <textarea
                            ref={inputRef}
                            rows={1}
                            placeholder={isBlocked ? "Cannot send messages to blocked users" : groupBlockedReason ?? "Type a message..."}
                            value={inputQuery}
                            disabled={isDisabled}
                            className="flex w-full resize-none overflow-hidden rounded-md border border-border bg-input px-4 py-2 text-sm font-mono leading-6 placeholder:text-muted-foreground/60 transition-[height,border-color,box-shadow] duration-150 ease-out focus:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                            onChange={(e) => {
                                if (!activeChat) return;
                                setDraftForChat(activeChat.id, e.target.value);
                                syncSelectionFromInput(e.target);
                            }}
                            onClick={(e) => syncSelectionFromInput(e.currentTarget)}
                            onFocus={(e) => syncSelectionFromInput(e.currentTarget)}
                            onKeyDown={handleComposerKeyDown}
                            onKeyUp={(e) => syncSelectionFromInput(e.currentTarget)}
                            onPaste={handleComposerPaste}
                            onSelect={(e) => syncSelectionFromInput(e.currentTarget)}
                        />
                        <Button
                            ref={sendButtonRef}
                            type="submit"
                            disabled={!inputQuery.trim() || isDisabled}
                            size="icon"
                            className={`shrink-0 self-end ${isTorActive ? 'bg-[#5a3184] hover:bg-[#4d2a72] text-white' : ''}`}
                            aria-label="Send message"
                        >
                            <Send className="w-4 h-4" />
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-1 items-center gap-3 self-end rounded-md border border-border bg-input px-4 py-2">
                        <span className="flex h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
                        <span className="flex-1 text-sm font-mono text-muted-foreground">
                            {voiceRecorder.state === 'finalizing'
                                ? 'Sending voice message…'
                                : `Recording… ${formatRecordingTime(voiceRecorder.elapsedMs)} / ${formatRecordingTime(voiceRecorder.maxDurationMs)}`}
                        </span>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={handleCancelRecording}
                            disabled={voiceRecorder.state === 'finalizing'}
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label="Cancel recording"
                            title="Cancel"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                        <Button
                            type="button"
                            size="icon"
                            onClick={() => void handleStopAndSendRecording()}
                            disabled={voiceRecorder.state === 'finalizing'}
                            className="shrink-0"
                            aria-label="Stop and send voice message"
                            title="Send"
                        >
                            <Check className="w-4 h-4" />
                        </Button>
                    </div>
                )}
            </form>
        </div>

        <SendFileDialog
            open={!interactionBlocked && fileDialogOpen}
            onOpenChange={(open) => setFileDialogOpen(interactionBlocked ? false : open)}
            onClosed={() => {
                setPastedFile(null);
                setFileDialogSource(null);
                showQueuedUploadsQuotaWarning();
            }}
            onSend={async (filePath, fileName, fileSize, mediaToken) => {
                await handleSendFile(
                    filePath,
                    fileName,
                    fileSize,
                    mediaToken,
                    fileDialogSource
                        ? {
                            target: {
                                chatId: fileDialogSource.chatId,
                                ...(fileDialogSource.peerId ? { peerId: fileDialogSource.peerId } : {}),
                            },
                            ...(fileDialogSource.replyTarget ? { replyTarget: fileDialogSource.replyTarget } : {}),
                        }
                        : undefined,
                );
            }}
            onUploadSaved={queueUploadsQuotaWarning}
            pastedFile={pastedFile}
            replyTarget={fileDialogSource?.replyTarget ?? null}
            transferBlocked={hasActiveFileTransfer}
            transferBlockedReason="Wait for the current file transfer to finish before selecting another file."
        />

        <SendLongMessageDialog
            open={!interactionBlocked && longMessageDialogOpen}
            onOpenChange={(open) => setLongMessageDialogOpen(interactionBlocked ? false : open)}
            onClosed={() => {
                setPendingLongMessage(null);
                showQueuedUploadsQuotaWarning();
            }}
            onPrepared={handlePreparedLongMessage}
            onUploadSaved={queueUploadsQuotaWarning}
            pendingMessage={pendingLongMessage}
            transferBlocked={hasActiveFileTransfer}
            transferBlockedReason="Wait for the current file transfer to finish before sending this message as a file."
        />

        <UploadsQuotaDialog
            open={quotaDialogOpen}
            onOpenChange={setQuotaDialogOpen}
            savedFilePath={quotaFilePath}
        />
    </>
}
