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
 *
 * `onAutoStop`, if provided, is invoked with the finished recording (or null if it came back
 * empty) when the hard 60s cap fires — mirroring what a caller gets back from `stopAndFinish()`
 * on a manual stop. Hitting the cap must still hand the caller a sendable recording, not silently
 * discard it. The callback is read from a ref on every fire, so callers can pass a fresh closure
 * on every render without needing to memoize it.
 */
export function useVoiceRecorder(
  maxDurationMs: number = VOICE_NOTE_MAX_DURATION_MS,
  onAutoStop?: (result: VoiceRecorderResult | null) => void,
): UseVoiceRecorderResult {
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
  const onAutoStopRef = useRef(onAutoStop);
  // Refs must not be written during render (React flags this) — keep the ref in sync via an
  // effect that runs after every render instead, well before any 60s auto-stop timer could fire.
  useEffect(() => {
    onAutoStopRef.current = onAutoStop;
  });

  // `isRequestingRef` blocks a second concurrent getUserMedia call (e.g. a double-clicked mic
  // button) while the first permission prompt is still open — at that point mediaRecorderRef is
  // still null, so a guard on it alone wouldn't catch the double-start. `generationRef` is bumped
  // by cancel() and on unmount so an in-flight request can tell, once its await resolves, that it
  // was superseded and must release the mic instead of becoming the active recorder.
  const isRequestingRef = useRef(false);
  const generationRef = useRef(0);

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
    isRequestingRef.current = false;
    setElapsedMs(0);
    setState('idle');
  }, [clearTimers, releaseStream]);

  // Release the mic the moment the component unmounts mid-recording — never leave the OS mic
  // indicator active or a stream dangling because the composer/chat was closed. Also supersede
  // any in-flight getUserMedia request: if permission is granted after unmount, start() must
  // notice and stop the returned stream's tracks instead of adopting it.
  useEffect(() => () => {
    generationRef.current += 1;
    clearTimers();
    releaseStream();
  }, [clearTimers, releaseStream]);

  const finishRecording = useCallback((): Promise<VoiceRecorderResult | null> => {
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

  const start = useCallback(async (): Promise<void> => {
    if (mediaRecorderRef.current || isRequestingRef.current) {
      return;
    }
    isRequestingRef.current = true;
    const requestGeneration = ++generationRef.current;
    setError(null);

    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      setError('Voice messages are not supported on this device');
      isRequestingRef.current = false;
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Covers permission denial, no device present, and device-in-use — MediaDevices doesn't
      // distinguish these in a renderer-safe way, so give one clear, actionable message.
      isRequestingRef.current = false;
      if (requestGeneration === generationRef.current) {
        setError('Microphone access was denied or unavailable');
      }
      return;
    }

    // The permission prompt can outlive interest in its result — the recording may have been
    // cancelled, or the component unmounted, while it was open. Don't adopt the stream in that
    // case; stop it immediately so the OS mic indicator doesn't stay lit for nothing.
    if (requestGeneration !== generationRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      isRequestingRef.current = false;
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setError('Voice messages are not supported on this device');
      isRequestingRef.current = false;
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
    isRequestingRef.current = false;
    recorder.start();

    timerIntervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startTimeRef.current);
    }, 200);
    autoStopTimeoutRef.current = setTimeout(() => {
      // Hard cap: auto-finalize through the exact same completion path as a manual stop (not a
      // cancel/discard), and hand the result to the caller via onAutoStop — hitting the cap must
      // still produce a sendable recording, not silently drop it.
      const activeRecorder = mediaRecorderRef.current;
      if (activeRecorder && activeRecorder.state === 'recording') {
        void finishRecording().then((result) => {
          onAutoStopRef.current?.(result);
        });
      }
    }, maxDurationMs);
  }, [maxDurationMs, resetToIdle, finishRecording]);

  const cancel = useCallback(() => {
    // Supersede any in-flight getUserMedia request so a permission grant that lands after the
    // user cancelled doesn't quietly turn into a live, unreleased mic stream.
    generationRef.current += 1;
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

  const stopAndFinish = useCallback((): Promise<VoiceRecorderResult | null> => finishRecording(), [finishRecording]);

  return { state, elapsedMs, maxDurationMs, error, start, cancel, stopAndFinish };
}
