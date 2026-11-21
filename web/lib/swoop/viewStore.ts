/**
 * how this browser shows a swoop picture: its size, and whether smooth scaling
 * draws it. both describe this screen, not the machine or the session
 * (dev/active/swoop-clarity/plan.md, C13), so they are this browser's, kept in
 * its storage across sessions and never sent. storage that is empty,
 * unreadable or refused means the defaults, which need nothing stored to work.
 *
 * size is `fit`, the largest picture the window holds, or `sharp`, the largest
 * whole fraction of the machine's pixels that fits; only sharp is stored.
 *
 * smooth scaling is the off switch for the canvas path (task 3.1, plan C6),
 * which averages the picture down where the browser's bilinear filter drops
 * thin strokes. its default follows the engine because the canvas's cost is
 * measured in one only: on in a chromium desktop engine (chrome, edge, and
 * owlette swoop on windows, whose webview2 is edge), which tasks 2.5 and 4.1
 * measure; off in webkit (safari, owlette swoop on macos and linux, every
 * iphone browser), firefox and phones until task 8.1 measures them, because a
 * retina or phone viewer sits below 1:1 most of the time and would upload a
 * full frame on every presented frame and every pinch. a viewer's own choice
 * beats the default either way, and is stored as `on` or `off` once made.
 */

import type { SwoopSize } from '@/lib/swoop/view';

const SIZE_KEY = 'owlette.swoop.size';
const SMOOTH_KEY = 'owlette.swoop.smooth';
const listeners = new Set<() => void>();

// chromium's client hints; the dom lib does not type them
interface NavigatorUAData {
  brands: { brand: string }[];
  mobile: boolean;
}

interface BrowserNavigator {
  userAgentData?: NavigatorUAData;
}

/** whether smooth scaling starts on in this engine: a chromium desktop one only. */
export function smoothByDefault(
  nav: BrowserNavigator | undefined = typeof navigator === 'undefined' ? undefined : (navigator as BrowserNavigator),
): boolean {
  const hints = nav?.userAgentData;
  return !!hints && !hints.mobile && hints.brands.some(({ brand }) => brand === 'Chromium');
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function readSize(): SwoopSize {
  try {
    return localStorage.getItem(SIZE_KEY) === 'sharp' ? 'sharp' : 'fit';
  } catch {
    return 'fit';
  }
}

export function setSize(size: SwoopSize): void {
  try {
    if (size === 'sharp') localStorage.setItem(SIZE_KEY, size);
    else localStorage.removeItem(SIZE_KEY);
  } catch {
    // unstorable: the read says fit
  }
  notify();
}

/** whether smooth scaling is on here: this viewer's choice, else the engine's default. */
export function readSmooth(): boolean {
  try {
    const stored = localStorage.getItem(SMOOTH_KEY);
    if (stored === 'on' || stored === 'off') return stored === 'on';
  } catch {
    // unreadable: the engine's default
  }
  return smoothByDefault();
}

export function setSmooth(on: boolean): void {
  try {
    localStorage.setItem(SMOOTH_KEY, on ? 'on' : 'off');
  } catch {
    // unstorable: the read says the engine's default
  }
  notify();
}

/**
 * for `useSyncExternalStore`: this tab's own changes, and another swoop tab's
 * through the `storage` event.
 */
export function subscribeView(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}
