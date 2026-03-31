import { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../state/store';

const INCOMING_RING_SRC = '/sounds/call-incoming-placeholder.wav';
const OUTGOING_RING_SRC = '/sounds/call-outgoing-placeholder.wav';
const END_CALL_SOUND_SRC = '/sounds/hangup.mp3';
const END_CALL_FALLBACK_SRC = '/sounds/call-ended-placeholder.mp3';

function stopAudio(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

async function playLoop(audio: HTMLAudioElement | null): Promise<void> {
  if (!audio) return;
  if (!audio.paused) return;
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch (error) {
    console.warn('[CALL] Failed to play ringtone:', error);
  }
}

async function playOnce(audio: HTMLAudioElement | null): Promise<void> {
  if (!audio) return;
  audio.currentTime = 0;
  try {
    await audio.play();
    return;
  } catch (error) {
    if (audio.src.includes(END_CALL_FALLBACK_SRC)) {
      console.warn('[CALL] Failed to play end-call sound:', error);
      return;
    }
  }

  audio.src = END_CALL_FALLBACK_SRC;
  audio.load();
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch (error) {
    console.warn('[CALL] Failed to play end-call fallback sound:', error);
  }
}

export const useCallRingtone = () => {
  const incomingCall = useSelector((state: RootState) => state.call.incomingCall);
  const activeCall = useSelector((state: RootState) => state.call.activeCall);

  const incomingAudioRef = useRef<HTMLAudioElement | null>(null);
  const outgoingAudioRef = useRef<HTMLAudioElement | null>(null);
  const endAudioRef = useRef<HTMLAudioElement | null>(null);
  const previousActiveCallRef = useRef<RootState['call']['activeCall'] | null>(null);

  useEffect(() => {
    const incoming = new Audio(INCOMING_RING_SRC);
    incoming.loop = true;
    incoming.preload = 'auto';
    incomingAudioRef.current = incoming;

    const outgoing = new Audio(OUTGOING_RING_SRC);
    outgoing.loop = true;
    outgoing.preload = 'auto';
    outgoingAudioRef.current = outgoing;

    const ended = new Audio(END_CALL_SOUND_SRC);
    ended.loop = false;
    ended.preload = 'auto';
    endAudioRef.current = ended;

    return () => {
      stopAudio(incomingAudioRef.current);
      stopAudio(outgoingAudioRef.current);
      stopAudio(endAudioRef.current);
      incomingAudioRef.current = null;
      outgoingAudioRef.current = null;
      endAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const shouldPlayIncoming = Boolean(incomingCall);
    const shouldPlayOutgoing = activeCall?.state === 'ringing_out';

    if (shouldPlayIncoming) {
      void playLoop(incomingAudioRef.current);
    } else {
      stopAudio(incomingAudioRef.current);
    }

    if (shouldPlayOutgoing) {
      void playLoop(outgoingAudioRef.current);
    } else {
      stopAudio(outgoingAudioRef.current);
    }
  }, [incomingCall?.callId, activeCall?.callId, activeCall?.state]);

  useEffect(() => {
    const previous = previousActiveCallRef.current;
    if (previous && !activeCall) {
      void playOnce(endAudioRef.current);
    }
    previousActiveCallRef.current = activeCall;
  }, [activeCall?.callId, activeCall?.peerId, activeCall?.state]);
};
