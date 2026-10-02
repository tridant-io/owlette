import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const getSnapshot = () => window.matchMedia(REDUCED_MOTION_QUERY).matches;

/**
 * whether the visitor asked for less motion, kept live. `serverValue` stands in
 * during SSR *and* the hydration render, so the first client pass matches the
 * server HTML; the real value arrives on the post-hydration re-render.
 *
 * do not read matchMedia in a lazy `useState` initializer instead: it runs
 * during the hydration render and disagrees with the server (React error #418).
 */
export function usePrefersReducedMotion(serverValue: boolean): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverValue);
}
