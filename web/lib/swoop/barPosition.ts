/**
 * where the session bar sits: on top, or down the left or right edge.
 *
 * a 16:9 picture in a 16:9 window is letterboxed at its sides, so a bar on top
 * costs the picture height it could have had, while a bar down one side sits
 * in space the letterbox wastes anyway. the choice is this browser's, kept in
 * its storage; storage that is missing or refused means the bar stays on top.
 *
 * the layout reads it from `data-swoop-bar` on <html> (the `bar-side`,
 * `bar-left` and `bar-right` variants in globals.css), not from react state:
 * the server cannot see this browser's storage, so a layout that waited for
 * hydration drew the bar on top for a frame first. the swoop layout's inline
 * script sets the attribute before first paint, and every change here keeps it.
 */

export type SwoopBarPosition = 'top' | 'left' | 'right';

const KEY = 'owlette.swoop.barPosition';
const listeners = new Set<() => void>();

/** run inline, before the page paints. */
export const BAR_POSITION_SCRIPT = `try{var p=localStorage.getItem('${KEY}');if(p==='left'||p==='right')document.documentElement.dataset.swoopBar=p}catch(e){}`;

export function readBarPosition(): SwoopBarPosition {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'left' || stored === 'right' ? stored : 'top';
  } catch {
    return 'top';
  }
}

/** the attribute the layout's css reads, from what is stored. */
function applyBarPosition(): void {
  const position = readBarPosition();
  if (position === 'top') delete document.documentElement.dataset.swoopBar;
  else document.documentElement.dataset.swoopBar = position;
}

export function setBarPosition(position: SwoopBarPosition): void {
  try {
    if (position === 'top') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, position);
  } catch {
    // unstorable: the read says top, so the bar stays where it was
  }
  applyBarPosition();
  for (const listener of listeners) listener();
}

/**
 * for `useSyncExternalStore`: this tab's own changes, and another swoop tab's
 * through the `storage` event.
 */
export function subscribeBarPosition(onChange: () => void): () => void {
  const onStorage = () => {
    applyBarPosition();
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}
