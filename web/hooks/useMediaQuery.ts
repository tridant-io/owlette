import { useCallback, useSyncExternalStore } from 'react';

const hasMatchMedia = (): boolean => typeof window.matchMedia === 'function';

/**
 * whether a media query matches, kept live. `serverValue` stands in during SSR
 * *and* the hydration render, so the first client pass matches the server
 * HTML; the real value arrives on the post-hydration re-render. a browser
 * without `matchMedia` (jsdom) keeps `serverValue`.
 *
 * do not read matchMedia in a lazy `useState` initializer instead: it runs
 * during the hydration render and disagrees with the server (React error #418).
 */
export function useMediaQuery(query: string, serverValue: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => (hasMatchMedia() ? window.matchMedia(query).matches : serverValue),
    [query, serverValue],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => serverValue);
}
