/**
 * where the session bar sits: on top, down the left or right edge, or `auto`,
 * which picks whichever leaves the picture bigger in this window.
 *
 * a 16:9 picture in a 16:9 window is letterboxed at its sides, so a bar on top
 * costs the picture height it could have had, while a bar down one side sits
 * in space the letterbox wastes anyway. the choice is this browser's, kept in
 * its storage, and auto until one is made: storage that is empty, unreadable or
 * refused means auto too, which needs nothing stored to work.
 *
 * the layout reads where the bar *is* from `data-swoop-bar` on <html> (the
 * `bar-side`, `bar-left` and `bar-right` variants in globals.css), not from
 * react state: the server cannot see this browser's storage or window, so a
 * layout that waited for hydration drew the bar on top for a frame first. the
 * root layout's boot script (`BAR_POSITION_BOOT_SCRIPT`) sets the attribute
 * before a hard load's first paint, `SwoopBarMark` before a client
 * navigation's, and every change here — a choice, a resize, the picture's real
 * shape — keeps it.
 */

export type SwoopBarPosition = 'top' | 'left' | 'right';
export type SwoopBarChoice = SwoopBarPosition | 'auto';

const KEY = 'owlette.swoop.barPosition';
const listeners = new Set<() => void>();

// the bar's own size, for the sum auto makes: a top bar is a 32 px button row
// with 8 px padding and a border; a side bar is `w-11`. below tailwind's md
// the bar is always on top.
const TOP_BAR_PX = 49;
const SIDE_BAR_PX = 44;
const MD_PX = 768;
// until a picture arrives, auto assumes the common shape
const DEFAULT_ASPECT = 16 / 9;

let aspect = DEFAULT_ASPECT;

/**
 * where `auto` puts the bar in a window this size: the side that leaves the
 * picture taller, top on a tie. the inline script below makes the same sum, and
 * a test holds the two to the same answers.
 */
export function autoPosition(width: number, height: number, pictureAspect = DEFAULT_ASPECT): 'top' | 'left' {
  if (width < MD_PX) return 'top';
  const onTop = Math.min(width / pictureAspect, height - TOP_BAR_PX);
  const beside = Math.min((width - SIDE_BAR_PX) / pictureAspect, height);
  return beside > onTop ? 'left' : 'top';
}

/** run inline, before the page paints. anything but a stored side or top is auto. */
export const BAR_POSITION_SCRIPT =
  `try{var p;try{p=localStorage.getItem('${KEY}')}catch(e){}` +
  `if(p!=='top'&&p!=='left'&&p!=='right'){var w=innerWidth,h=innerHeight,a=${DEFAULT_ASPECT};` +
  `p=w>=${MD_PX}&&Math.min((w-${SIDE_BAR_PX})/a,h)>Math.min(w/a,h-${TOP_BAR_PX})?'left':''}` +
  `if(p==='left'||p==='right')document.documentElement.dataset.swoopBar=p}catch(e){}`;

/**
 * the same, from the root layout on a hard load of a session page: the root
 * layout never re-renders on a client navigation, so react never has to
 * rebuild a <script> it cannot run. a client navigation into a session marks
 * through `SwoopBarMark` instead.
 */
export const BAR_POSITION_BOOT_SCRIPT =
  `if(/^\\/swoop\\/[^/]+\\/[^/]+(\\/|$)/.test(location.pathname)){${BAR_POSITION_SCRIPT}}`;

/** what this browser chose: auto until it chooses. */
export function readBarChoice(): SwoopBarChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'top' || stored === 'left' || stored === 'right' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

/** where the bar is now: the choice, with auto worked out for this window. */
export function currentBarPosition(): SwoopBarPosition {
  const marked = document.documentElement.dataset.swoopBar;
  return marked === 'left' || marked === 'right' ? marked : 'top';
}

/** mark <html> with where the bar is; true when that moved it. */
function mark(): boolean {
  const choice = readBarChoice();
  const position = choice === 'auto' ? autoPosition(innerWidth, innerHeight, aspect) : choice;
  if (position === currentBarPosition()) return false;
  if (position === 'top') delete document.documentElement.dataset.swoopBar;
  else document.documentElement.dataset.swoopBar = position;
  return true;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** follow the window, or anything else auto sums with. */
export function applyBarPosition(): void {
  if (mark()) notify();
}

export function setBarChoice(choice: SwoopBarChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // unstorable: the read says auto, so the bar goes where auto puts it
  }
  mark();
  // once, and even when the bar does not move: the radio follows the choice
  notify();
}

/** the picture's real shape, once the video knows it: auto sums with it from then on. */
export function setPictureAspect(width: number, height: number): void {
  if (width <= 0 || height <= 0) return;
  aspect = width / height;
  applyBarPosition();
}

/**
 * for `useSyncExternalStore`: this tab's own changes, and another swoop tab's
 * through the `storage` event.
 */
export function subscribeBarPosition(onChange: () => void): () => void {
  const onStorage = () => {
    mark();
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}
