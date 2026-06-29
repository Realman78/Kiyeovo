import { useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../state/store';
import type { MessageReceivedEvent, ContactRequestEvent, CallIncomingEvent } from '../../core/types';
import { setActiveChat } from '../state/slices/chatSlice';
import { store } from '../state/store';

const MESSAGE_NOTIFICATION_BATCH_WINDOW_MS = 1000;
const MAX_NOTIFICATION_PREVIEW_LENGTH = 120;

const normalizeNotificationText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const truncateNotificationText = (value: string): string => (
  value.length > MAX_NOTIFICATION_PREVIEW_LENGTH
    ? `${value.slice(0, MAX_NOTIFICATION_PREVIEW_LENGTH - 1)}…`
    : value
);

const getMessageNotificationPreview = (message: MessageReceivedEvent): string => {
  if (message.messageType === 'file') {
    return message.fileName ? `File: ${message.fileName}` : 'File received';
  }

  const normalized = normalizeNotificationText(message.content);
  return normalized || 'New message';
};

export const useNotifications = () => {
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const dispatch = useDispatch();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const notificationsEnabledRef = useRef(true);
  const pendingMessageNotificationsRef = useRef<MessageReceivedEvent[]>([]);
  const messageNotificationTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const loadNotificationsSetting = async () => {
      try {
        const result = await window.kiyeovoAPI.getNotificationsEnabled();
        if (result.success) {
          notificationsEnabledRef.current = result.enabled;
        }
      } catch (error) {
        console.error('Failed to load notifications setting:', error);
      }
    };
    loadNotificationsSetting();

    // Initialize audio
    audioRef.current = new Audio('/sounds/notification2.mp3');

    // Listen for notifications setting changes
    const unsubscribeNotificationsSetting = window.kiyeovoAPI.onNotificationsEnabledChanged((enabled: boolean) => {
      notificationsEnabledRef.current = enabled;
    });

    const flushMessageNotificationBatch = async () => {
      if (messageNotificationTimerRef.current !== null) {
        clearTimeout(messageNotificationTimerRef.current);
        messageNotificationTimerRef.current = null;
      }

      const queuedMessages = pendingMessageNotificationsRef.current;
      pendingMessageNotificationsRef.current = [];

      if (queuedMessages.length === 0 || !notificationsEnabledRef.current) {
        return;
      }

      const currentState = store.getState();
      const eligibleMessages = queuedMessages.filter((message) => {
        if (message.senderPeerId === currentState.user.peerId) {
          return false;
        }

        const chat = currentState.chat.chats.find((candidate) => candidate.id === message.chatId);
        if (chat?.justCreated || chat?.muted) {
          return false;
        }

        return true;
      });

      if (eligibleMessages.length === 0) {
        return;
      }

      try {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          await audioRef.current.play();
        }
      } catch (error) {
        console.error('Failed to play notification sound:', error);
      }

      try {
        const { focused } = await window.kiyeovoAPI.isWindowFocused();
        if (focused) {
          return;
        }

        const latestMessage = eligibleMessages[eligibleMessages.length - 1];
        const latestPreview = truncateNotificationText(getMessageNotificationPreview(latestMessage));
        const uniqueChatIds = new Set(eligibleMessages.map((message) => message.chatId));
        const summary = (() => {
          if (eligibleMessages.length === 1) {
            return {
              title: `New message from ${latestMessage.senderUsername}`,
              body: latestMessage.content,
              chatId: latestMessage.chatId,
            };
          }

          if (uniqueChatIds.size === 1) {
            const onlyChatId = latestMessage.chatId;
            const chat = currentState.chat.chats.find((candidate) => candidate.id === onlyChatId);
            if (chat?.type === 'group') {
              const uniqueSenders = new Set(eligibleMessages.map((message) => message.senderUsername));
              return {
                title: `New messages in ${chat.name}`,
                body: `${eligibleMessages.length} new messages from ${uniqueSenders.size} ${uniqueSenders.size === 1 ? 'person' : 'people'} • Latest: ${latestPreview}`,
                chatId: onlyChatId,
              };
            }

            const directChatName = chat?.name || latestMessage.senderUsername;
            return {
              title: `New messages from ${directChatName}`,
              body: `${eligibleMessages.length} new messages • Latest: ${latestPreview}`,
              chatId: onlyChatId,
            };
          }

          return {
            title: `${eligibleMessages.length} new messages`,
            body: `From ${uniqueChatIds.size} chats • Latest: ${latestPreview}`,
          };
        })();

        await window.kiyeovoAPI.showNotification(summary);
      } catch (error) {
        console.error('Failed to show notification:', error);
      }
    };

    const scheduleMessageNotification = (message: MessageReceivedEvent) => {
      pendingMessageNotificationsRef.current.push(message);
      if (messageNotificationTimerRef.current !== null) {
        return;
      }

      messageNotificationTimerRef.current = window.setTimeout(() => {
        void flushMessageNotificationBatch();
      }, MESSAGE_NOTIFICATION_BATCH_WINDOW_MS);
    };

    // Listen for message received events
    const unsubscribeMessages = window.kiyeovoAPI.onMessageReceived((data: MessageReceivedEvent) => {
      if (data.senderPeerId === myPeerId) {
        return;
      }

      // Don't notify for messages in just-created chats (from accepted contact requests/key exchanges)
      const currentState = store.getState();
      const chat = currentState.chat.chats.find(c => c.id === data.chatId);
      if (chat?.justCreated) {
        return;
      }

      if (chat?.muted || !notificationsEnabledRef.current) {
        return;
      }

      scheduleMessageNotification(data);
    });

    // Listen for pending file offers
    const unsubscribePendingFiles = window.kiyeovoAPI.onPendingFileReceived(async (data: any) => {
      if (!notificationsEnabledRef.current) {
        return;
      }

      const currentState = store.getState();
      const chat = currentState.chat.chats.find(c => c.id === data.chatId);
      if (chat?.muted) {
        return;
      }

      try {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          await audioRef.current.play();
        }
      } catch (error) {
        console.error('Failed to play notification sound:', error);
      }

      try {
        const { focused } = await window.kiyeovoAPI.isWindowFocused();
        if (!focused) {
          await window.kiyeovoAPI.showNotification({
            title: `File offer from ${data.senderUsername}`,
            body: data.filename,
            chatId: data.chatId,
          });
        }
      } catch (error) {
        console.error('Failed to show notification:', error);
      }
    });

    // Listen for contact request events
    const unsubscribeContactRequests = window.kiyeovoAPI.onContactRequestReceived(async (data: ContactRequestEvent) => {
      // Don't notify if global notifications are disabled
      if (!notificationsEnabledRef.current) {
        return;
      }

      // Play sound
      try {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
          await audioRef.current.play();
        }
      } catch (error) {
        console.error('Failed to play notification sound:', error);
      }

      // Show notification if window not focused
      try {
        const { focused } = await window.kiyeovoAPI.isWindowFocused();
        if (!focused) {
          await window.kiyeovoAPI.showNotification({
            title: 'New Contact Request',
            body: `${data.username} wants to connect`,
          });
        }
      } catch (error) {
        console.error('Failed to show notification:', error);
      }
    });

    // Listen for incoming call events
    const unsubscribeIncomingCalls = window.kiyeovoAPI.onCallIncoming(async (data: CallIncomingEvent) => {
      if (!notificationsEnabledRef.current) {
        return;
      }

      try {
        const { focused } = await window.kiyeovoAPI.isWindowFocused();
        if (focused) {
          return;
        }

        const currentState = store.getState();
        const directChat = currentState.chat.chats.find(
          (chat) => chat.type === 'direct' && chat.peerId === data.signal.fromPeerId,
        );
        const callerName = directChat?.name || `user_${data.signal.fromPeerId.slice(-8)}`;

        await window.kiyeovoAPI.showNotification({
          title: 'Incoming call',
          body: `${callerName} is calling you`,
          chatId: directChat?.id,
        });
      } catch (error) {
        console.error('Failed to show incoming call notification:', error);
      }
    });

    // Listen for notification clicks
    const unsubscribeNotificationClick = window.kiyeovoAPI.onNotificationClicked((chatId: number) => {
      dispatch(setActiveChat(chatId));
    });

    return () => {
      unsubscribeMessages();
      unsubscribePendingFiles();
      unsubscribeContactRequests();
      unsubscribeIncomingCalls();
      unsubscribeNotificationClick();
      unsubscribeNotificationsSetting();
      if (messageNotificationTimerRef.current !== null) {
        clearTimeout(messageNotificationTimerRef.current);
        messageNotificationTimerRef.current = null;
      }
      pendingMessageNotificationsRef.current = [];
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [myPeerId, dispatch]);
};
