/**
 * who in a swoop session is moving the pointer, and who just clicked: what
 * lights each viewer's pill in the bar.
 *
 * the others' moves are their `vpos`, which `presence.ts` hands over: the host
 * publishes one for each absolute move it takes from another controller
 * (PROTOCOL.md §5). a `vpos` carries no buttons, so somebody else's click can't
 * be seen here. this tab's own moves and presses come from its input capture,
 * which sent them.
 *
 * the clock is this browser's. a `vpos`'s `tsUs` is the host's, on a clock this
 * one is not synchronised to.
 *
 * a light goes out on one timer, set for the next one due, never a frame loop;
 * with nobody lit there is no timer at all.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import type { InputCapture } from '@/lib/swoop/input';

export type SwoopViewerActivity = 'idle' | 'moving' | 'clicking';

/** a viewer's pill stays lit this long after their last move. */
export const ACTIVITY_MOVE_MS = 400;

/** and shows a click this long after a button went down, over a move. */
export const ACTIVITY_CLICK_MS = 250;

/** every viewer moving or clicking now. anyone missing is idle. */
export type SwoopActivityState = ReadonlyMap<string, SwoopViewerActivity>;

/** nobody lit: before attach, on the server, and once every light is out. */
export const NO_ACTIVITY: SwoopActivityState = new Map();

export interface SwoopActivityStore {
  subscribe(listener: () => void): SwoopDetach;
  get(): SwoopActivityState;
  /** a move from this viewer. */
  moved(viewerId: string): void;
}

const stores = new WeakMap<SwoopSession, SwoopActivityStore>();

/** the live activity store, or null before attach. */
export const swoopActivity = (session: SwoopSession | null): SwoopActivityStore | null =>
  session ? (stores.get(session) ?? null) : null;

interface Lit {
  movingUntil: number;
  clickedUntil: number;
}

/** a click wins over a move while both are lit. */
const activityAt = (lit: Lit, now: number): SwoopViewerActivity =>
  now < lit.clickedUntil ? 'clicking' : now < lit.movingUntil ? 'moving' : 'idle';

const same = (a: SwoopActivityState, b: SwoopActivityState): boolean =>
  a.size === b.size && [...a].every(([viewer, activity]) => b.get(viewer) === activity);

export function attach(session: SwoopSession, capture: Pick<InputCapture, 'onPointerInput'> | null): SwoopDetach {
  const listeners = new Set<() => void>();
  const lit = new Map<string, Lit>();
  let state: SwoopActivityState = NO_ACTIVITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;

  /** the state as of now, told only when it changed, and the timer set for the next light due out. */
  const refresh = (): void => {
    const now = performance.now();
    const next = new Map<string, SwoopViewerActivity>();
    let due = Infinity;
    for (const [viewer, times] of lit) {
      const activity = activityAt(times, now);
      if (activity === 'idle') {
        lit.delete(viewer);
        continue;
      }
      next.set(viewer, activity);
      due = Math.min(due, activity === 'clicking' ? times.clickedUntil : times.movingUntil);
    }
    if (!same(next, state)) {
      state = next.size === 0 ? NO_ACTIVITY : next;
      for (const listener of listeners) listener();
    }
    // a timer already due sooner stays: it finds this one still lit and sets the next
    if (due >= timerAt) return;
    if (timer !== null) clearTimeout(timer);
    timerAt = due;
    // rounded up, so it never fires a fraction early and has to be set again
    timer = setTimeout(() => {
      timer = null;
      timerAt = Infinity;
      refresh();
    }, Math.ceil(due - now));
  };

  const mark = (viewer: string, activity: 'moving' | 'clicking'): void => {
    const now = performance.now();
    const times = lit.get(viewer) ?? { movingUntil: -Infinity, clickedUntil: -Infinity };
    if (activity === 'clicking') times.clickedUntil = now + ACTIVITY_CLICK_MS;
    else times.movingUntil = now + ACTIVITY_MOVE_MS;
    lit.set(viewer, times);
    // moves come at the pointer's rate, and one more from a viewer already lit
    // changes nothing on screen: the timer set for them finds the later time
    if (state.get(viewer) !== activityAt(times, now)) refresh();
  };

  const offInput = capture?.onPointerInput((kind) =>
    mark(session.viewerId, kind === 'press' ? 'clicking' : 'moving'),
  );

  stores.set(session, {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // the same object identity until something changes, which is what
    // `useSyncExternalStore` requires of a snapshot.
    get: () => state,
    moved: (viewerId) => mark(viewerId, 'moving'),
  });

  return () => {
    stores.delete(session);
    offInput?.();
    if (timer !== null) clearTimeout(timer);
    listeners.clear();
  };
}
