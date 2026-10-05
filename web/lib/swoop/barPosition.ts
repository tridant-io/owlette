/**
 * where the session bar sits: on top, or down the left or right edge.
 *
 * a 16:9 picture in a 16:9 window is letterboxed at its sides, so a bar on top
 * costs the picture height it could have had, while a bar down one side sits
 * in space the letterbox wastes anyway. the choice is this browser's, kept in
 * its storage; storage that is missing or refused means the bar stays on top.
 */

export type SwoopBarPosition = 'top' | 'left' | 'right';

const KEY = 'owlette.swoop.barPosition';
const listeners = new Set<() => void>();

export function readBarPosition(): SwoopBarPosition {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'left' || stored === 'right' ? stored : 'top';
  } catch {
    return 'top';
  }
}

export function setBarPosition(position: SwoopBarPosition): void {
  try {
    if (position === 'top') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, position);
  } catch {
    // unstorable: the read says top, so the bar stays where it was
  }
  for (const listener of listeners) listener();
}

/**
 * for `useSyncExternalStore`: this tab's own changes, and another swoop tab's
 * through the `storage` event.
 */
export function subscribeBarPosition(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}
