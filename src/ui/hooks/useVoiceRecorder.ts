import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_NOTE_MAX_DURATION_MS } from '../../core/constants';

export type VoiceRecorderState = 'idle' | 'recording' | 'finalizing';

export interface VoiceRecorderResult {
  bytes: Uint8Array;
  durationMs: number;
}

export interface UseVoiceRecorderResult {
  state: VoiceRecorderState;
  elapsedMs: number;
  maxDurationMs: number;
  error: string | null;
  start: () => Promise<void>;
  cancel: () => void;
  stopAndFinish: () => Promise<VoiceRecorderResult | null>;
}

// Opus in a WebM container, no new native/audio dependency — MediaRecorder is a browser (and
// therefore Chromium/Electron renderer) built-in. Preference order matters: explicit Opus codec
// first, falling back only if the exact codec string isn't recognized on this build.
const CANDIDATE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm'];

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  return CANDIDATE_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null;
}

/**
 * Encapsulates MediaRecorder lifecycle for voice notes: mic permission request, Opus/WebM
 * capture, a live elapsed timer, and a hard auto-stop at maxDurationMs. Callers get back raw
 * bytes + a measured duration; everything about uploading/sending those bytes lives outside
 * this hook (see ChatInput's onRecorded handling), keeping the recorder itself transport-agnostic.
 */
export function useVoiceRecorder(maxDurationMs: number = VOICE_NOTE_MAX_DURATION_MS): UseVoiceRecorderResult {
  const [state, setState] = useState<VoiceRecorderState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStopResolveRef = useRef<((result: VoiceRecorderResult | null) => void) | null>(null);
  const discardRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (timerIntervalRef.current !== null) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (autoStopTimeoutRef.current !== null) {
      clearTimeout(autoStopTimeoutRef.current);
      autoStopTimeoutRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const resetToIdle = useCallback(() => {
    clearTimers();
    releaseStream();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    pendingStopResolveRef.current = null;
    discardRef.current = false;
    setElapsedMs(0);
    setState('idle');
  }, [clearTimers, releaseStream]);

  // Release the mic the moment the component unmounts mid-recording — never leave the OS mic
  // indicator active or a stream dangling because the composer/chat was closed.
  useEffect(() => () => {
    clearTimers();
    releaseStream();
  }, [clearTimers, releaseStream]);

  const start = useCallback(async (): Promise<void> => {
    if (mediaRecorderRef.current) {
      return;
    }
    setError(null);

    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      setError('Voice messages are not supported on this device');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Covers permission denial, no device present, and device-in-use — MediaDevices doesn't
      // distinguish these in a renderer-safe way, so give one clear, actionable message.
      setError('Microphone access was denied or unavailable');
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setError('Voice messages are not supported on this device');
      return;
    }

    chunksRef.current = [];
    discardRef.current = false;
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const resolve = pendingStopResolveRef.current;
      pendingStopResolveRef.current = null;
      const wasDiscarded = discardRef.current;
      const durationMs = Math.min(maxDurationMs, Date.now() - startTimeRef.current);
      const blob = new Blob(chunksRef.current, { type: mimeType });
      resetToIdle();
      if (resolve) {
        if (wasDiscarded || blob.size === 0) {
          resolve(null);
          return;
        }
        void blob.arrayBuffer().then((buffer) => {
          resolve({ bytes: new Uint8Array(buffer), durationMs });
        }).catch(() => resolve(null));
      }
    };
    recorder.onerror = () => {
      setError('Recording failed');
      discardRef.current = true;
      try { recorder.stop(); } catch { /* already stopped/inactive */ }
    };

    mediaRecorderRef.current = recorder;
    streamRef.current = stream;
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    setState('recording');
    recorder.start();

    timerIntervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 200);
    autoStopTimeoutRef.current = setTimeout(() => {
      // Hard cap: auto-finalize and send exactly like a manual stop, not a cancel.
      const activeRecorder = mediaRecorderRef.current;
      if (activeRecorder && activeRecorder.state === 'recording') {
        setState('finalizing');
        activeRecorder.stop();
      }
    }, maxDurationMs);
  }, [maxDurationMs, resetToIdle]);

  const cancel = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      resetToIdle();
      return;
    }
    discardRef.current = true;
    pendingStopResolveRef.current = null;
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* already stopped */ }
    } else {
      resetToIdle();
    }
  }, [resetToIdle]);

  const stopAndFinish = useCallback((): Promise<VoiceRecorderResult | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      return Promise.resolve(null);
    }
    setState('finalizing');
    return new Promise((resolve) => {
      pendingStopResolveRef.current = resolve;
      try {
        recorder.stop();
      } catch {
        pendingStopResolveRef.current = null;
        resetToIdle();
        resolve(null);
      }
    });
  }, [resetToIdle]);

  return { state, elapsedMs, maxDurationMs, error, start, cancel, stopAndFinish };
}
