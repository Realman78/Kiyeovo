import { useCallback, useEffect, useMemo, useState } from 'react';

export type CallCardAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const CALL_CARD_ANCHOR_STORAGE_KEY = 'kiyeovo.call.card.anchor';
const CALL_CARD_ANCHOR_CHANGED_EVENT = 'kiyeovo:call-card-anchor-changed';
const DEFAULT_CALL_CARD_ANCHOR: CallCardAnchor = 'bottom-right';

function isCallCardAnchor(value: unknown): value is CallCardAnchor {
  return value === 'top-left'
    || value === 'top-right'
    || value === 'bottom-left'
    || value === 'bottom-right';
}

function readStoredCallCardAnchor(): CallCardAnchor {
  if (typeof window === 'undefined') return DEFAULT_CALL_CARD_ANCHOR;
  const stored = window.localStorage.getItem(CALL_CARD_ANCHOR_STORAGE_KEY);
  return isCallCardAnchor(stored) ? stored : DEFAULT_CALL_CARD_ANCHOR;
}

function writeStoredCallCardAnchor(anchor: CallCardAnchor): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CALL_CARD_ANCHOR_STORAGE_KEY, anchor);
}

function resolveAnchorFromPoint(clientX: number, clientY: number): CallCardAnchor {
  const horizontal = clientX <= window.innerWidth / 2 ? 'left' : 'right';
  const vertical = clientY <= window.innerHeight / 2 ? 'top' : 'bottom';
  return `${vertical}-${horizontal}` as CallCardAnchor;
}

export function getCallCardAnchorPositionClass(anchor: CallCardAnchor): string {
  switch (anchor) {
    case 'top-left':
      return 'top-4 left-4';
    case 'top-right':
      return 'top-4 right-4';
    case 'bottom-left':
      return 'bottom-24 left-4';
    case 'bottom-right':
    default:
      return 'bottom-24 right-4';
  }
}

export function useCallCardAnchor() {
  const [anchor, setAnchorState] = useState<CallCardAnchor>(() => readStoredCallCardAnchor());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== CALL_CARD_ANCHOR_STORAGE_KEY) return;
      setAnchorState(readStoredCallCardAnchor());
    };

    const onAnchorChanged = (event: Event) => {
      const customEvent = event as CustomEvent<CallCardAnchor>;
      if (!isCallCardAnchor(customEvent.detail)) {
        setAnchorState(readStoredCallCardAnchor());
        return;
      }
      setAnchorState(customEvent.detail);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(CALL_CARD_ANCHOR_CHANGED_EVENT, onAnchorChanged as EventListener);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(CALL_CARD_ANCHOR_CHANGED_EVENT, onAnchorChanged as EventListener);
    };
  }, []);

  const setAnchor = useCallback((nextAnchor: CallCardAnchor) => {
    setAnchorState(nextAnchor);
    writeStoredCallCardAnchor(nextAnchor);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent<CallCardAnchor>(CALL_CARD_ANCHOR_CHANGED_EVENT, { detail: nextAnchor }));
    }
  }, []);

  const snapToClosestCorner = useCallback((clientX: number, clientY: number) => {
    setAnchor(resolveAnchorFromPoint(clientX, clientY));
  }, [setAnchor]);

  const positionClassName = useMemo(() => getCallCardAnchorPositionClass(anchor), [anchor]);

  return {
    anchor,
    positionClassName,
    setAnchor,
    snapToClosestCorner,
  };
}
