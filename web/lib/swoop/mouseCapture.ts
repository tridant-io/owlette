/**
 * whether fullscreen captures the mouse: off until this browser turns it on.
 *
 * captured (pointer lock), the browser hides the local pointer and the page
 * draws the machine's, which comes back a round trip late: on a slow link every
 * move lagged. free, the drawn pointer follows the mouse at once, as it does in
 * a window. a game or a 3D view that turns with the mouse needs the raw movement
 * only capture gives, and the session bar's toggle turns it on for those. the
 * choice is this browser's, kept in its storage; storage that is empty,
 * unreadable or refused means off.
 */

const KEY = 'owlette.swoop.mouseCapture';
const listeners = new Set<() => void>();

export function readMouseCapture(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setMouseCapture(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // unstorable: the read says off, so fullscreen leaves the mouse free
  }
  for (const listener of listeners) listener();
}

/** for `useSyncExternalStore`: this tab's own changes, and another swoop tab's through `storage`. */
export function subscribeMouseCapture(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}
