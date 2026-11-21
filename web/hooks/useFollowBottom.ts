'use client';

import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** one glide to the bottom: quick, but long enough to read as motion, not a cut */
export const FOLLOW_MS = 200;
/** a reader scrolling back down to within this of the bottom is following again */
const PINNED_PX = 100;
/** one 60Hz frame: a glide is timed from a frame back, so its first frame already moves */
const FRAME_MS = 1000 / 60;
/** keys that scroll from wherever focus is, and those of them that go up */
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);
const UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp']);

/** fast off the mark, then settles into place */
export function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

interface FollowState {
  /** the reader is at the bottom, following the reply down */
  pinned: boolean;
  /** scrollTop as last seen, so a scroll can tell up from down */
  lastTop: number;
  /** the scrollTop a glide last wrote: its own scroll events are not the reader's */
  wrote: number | null;
  /** ends the running glide; null when none runs */
  cancel: (() => void) | null;
}

/** glide `el` to its bottom on one frame loop, for as long as the reader stays pinned */
function glideToBottom(el: HTMLElement, state: FollowState): void {
  const bottom = () => el.scrollHeight - el.clientHeight;
  const write = (top: number) => {
    state.wrote = Math.round(top);
    el.scrollTop = state.wrote;
  };
  if (bottom() - el.scrollTop < 1) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    write(bottom());
    return;
  }

  let frame = 0;
  let from = 0;
  let to = 0;
  let start: number | null = null;
  let last: number | null = null;

  function end() {
    cancelAnimationFrame(frame);
    window.removeEventListener('keydown', onKey);
    state.cancel = null;
  }
  // the scroller is not focusable, so its own keydown never sees these
  function onKey(event: KeyboardEvent) {
    if (!SCROLL_KEYS.has(event.key)) return;
    if (UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)) state.pinned = false;
    end();
  }
  function step(now: number) {
    // every frame: a reader who scrolled up since the last one is let go
    if (!state.pinned) {
      end();
      return;
    }
    const target = bottom();
    if (start === null || target !== to) {
      // eased from where the view is and timed from the frame before, so this
      // frame already moves rather than holding each time the reply grows
      from = el.scrollTop;
      to = target;
      start = last ?? now - FRAME_MS;
    }
    last = now;
    const t = Math.min(1, (now - start) / FOLLOW_MS);
    write(from + (to - from) * easeOutCubic(t));
    if (t < 1) frame = requestAnimationFrame(step);
    else end();
  }

  state.cancel = end;
  window.addEventListener('keydown', onKey);
  frame = requestAnimationFrame(step);
}

/**
 * keeps a growing transcript's newest line in view for a reader at the bottom,
 * gliding down instead of jump-cutting there, and lets go the moment they
 * scroll up. one rAF loop at a time: content that grows mid-glide restarts the
 * ease from where the view is, toward the new bottom, so a streaming reply is
 * followed rather than queued up behind — native smooth scrolling restarts
 * itself on every token and judders. under reduced motion it jumps.
 *
 * wire `noteScroll` to the scroller's scroll events, `noteWheel` to its wheel,
 * and `stop` to anything else that takes the scroll (touch, a press on the
 * scrollbar); scroll keys are heard on window while a glide runs. `release`
 * lets go until the reader scrolls back down, as "back to top" needs.
 */
export function useFollowBottom(scroller: RefObject<HTMLElement | null>) {
  const state = useRef<FollowState>({ pinned: true, lastTop: 0, wrote: null, cancel: null });

  const stop = useCallback(() => {
    state.current.cancel?.();
  }, []);

  const follow = useCallback(() => {
    const el = scroller.current;
    // a glide under way already retargets on its own
    if (el && state.current.pinned && !state.current.cancel) glideToBottom(el, state.current);
  }, [scroller]);

  const noteScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const s = state.current;
    const top = el.scrollTop;
    if (s.wrote === null || Math.abs(top - s.wrote) >= 1) {
      const fromBottom = el.scrollHeight - top - el.clientHeight;
      // at the bottom it follows, whatever put it there (a shorter chat clamps
      // it); off it, up lets go and back down to near it takes hold again
      if (fromBottom < 1) s.pinned = true;
      else if (top < s.lastTop) s.pinned = false;
      else if (fromBottom < PINNED_PX) s.pinned = true;
    }
    s.lastTop = top;
  }, [scroller]);

  const noteWheel = useCallback(
    (event: { deltaY: number }) => {
      // up lets go before the scroll it causes has landed, so a token arriving
      // in between cannot start a glide that undoes it
      if (event.deltaY < 0 && (scroller.current?.scrollTop ?? 0) > 0) state.current.pinned = false;
      stop();
    },
    [scroller, stop],
  );

  const release = useCallback(() => {
    state.current.pinned = false;
    stop();
  }, [stop]);

  useEffect(() => stop, [stop]);

  return { follow, stop, noteScroll, noteWheel, release };
}
