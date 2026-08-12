import { useSyncExternalStore } from 'react';

/**
 * Width below which the shell cannot show its sidebar and content panes side by
 * side and switches to one pane at a time.
 *
 * A phone-class Linux device (PinePhone and friends) is 720x1440 at scale 2,
 * i.e. 360x720 CSS px, while the expanded sidebar alone is w-110 (440px) on top
 * of a 56px rail. Matches Tailwind's `sm` breakpoint so utility classes and this
 * hook agree on where "narrow" starts.
 */
export const NARROW_VIEWPORT_QUERY = '(max-width: 639px)';

function subscribe(onStoreChange: () => void): () => void {
  const mediaQuery = window.matchMedia(NARROW_VIEWPORT_QUERY);
  mediaQuery.addEventListener('change', onStoreChange);
  return () => mediaQuery.removeEventListener('change', onStoreChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
}

/**
 * True while the viewport is too narrow for the two-pane layout. Read through
 * useSyncExternalStore rather than an effect so the first render already has the
 * real width — an effect-based read would paint the desktop layout for a frame.
 */
export function useIsNarrowViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
