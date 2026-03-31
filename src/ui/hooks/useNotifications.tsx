import { useEffect, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import type { RootState } from '../state/store';
import type { MessageReceivedEvent, ContactRequestEvent, CallIncomingEvent } from '../../core/types';
import { setActiveChat } from '../state/slices/chatSlice';
import { store } from '../state/store';

export const useNotifications = () => {
  const myPeerId = useSelector((state: RootState) => state.user.peerId);
  const dispatch = useDispatch();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const notificationsEnabledRef = useRef(true);

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

    // Listen for message received events
    const unsubscribeMessages = window.kiyeovoAPI.onMessageReceived(async (data: MessageReceivedEvent) => {
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
            title: `New message from ${data.senderUsername}`,
            body: data.content,
            chatId: data.chatId,
          });
        }
      } catch (error) {
        console.error('Failed to show notification:', error);
      }
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
          title: `Incoming ${data.signal.mediaType} call`,
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
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [myPeerId, dispatch]);
};
