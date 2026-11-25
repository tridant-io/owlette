'use client';

import { useCallback, useLayoutEffect, useRef, type RefCallback, type RefObject } from 'react';

/** quick, and decelerating so the box settles rather than stops */
export const HEIGHT_TRANSITION = 'height 200ms cubic-bezier(0.2, 0, 0, 1)';
/** settles the box if `transitionend` never arrives (a hidden tab, an interrupted run) */
const SAFETY_MS = 260;

/**
 * Ease an element between its natural heights whenever `key` changes, e.g. a
 * dialog moving between sections of different lengths. CSS can't transition
 * `auto` to `auto`, so on each change this pins the height last observed, measures
 * the new one, transitions between the two pixel values, and then hands the height
 * back to `auto` so later content changes reflow as usual.
 *
 * While it moves, the element carries `data-resizing`, so a scrolling body inside
 * can clip itself (`[[data-resizing]_&]:overflow-y-hidden`) rather than flash a
 * scrollbar for 200ms. Pass that body as `scroller` and the flag is left off when
 * the body will scroll once settled, so its scrollbar never pops in at the end.
 */
export function useHeightTransition<T extends HTMLElement>(
  key: unknown,
  scroller?: RefObject<HTMLElement | null>,
): RefCallback<T> {
  const node = useRef<T | null>(null);
  // the last height a ResizeObserver reported. a frame behind on purpose: when
  // `key` changes it still holds the old height, mid-transition the current one
  const height = useRef<number | null>(null);

  const ref = useCallback((element: T | null) => {
    if (!element || typeof ResizeObserver === 'undefined') return;
    node.current = element;
    const observer = new ResizeObserver(() => {
      height.current = element.getBoundingClientRect().height;
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      node.current = null;
      height.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const element = node.current;
    const from = height.current;
    // nothing painted yet (first open): there is no old height to come from
    if (!element || from === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    element.style.transition = 'none';
    element.style.height = '';
    const to = element.getBoundingClientRect().height;
    if (Math.abs(to - from) < 1) return;

    const pane = scroller?.current;
    if (!pane || pane.scrollHeight <= pane.clientHeight) element.dataset.resizing = '';

    element.style.height = `${from}px`;
    // commit the start height, or the browser coalesces both writes and jumps
    void element.offsetHeight;
    element.style.transition = HEIGHT_TRANSITION;
    element.style.height = `${to}px`;

    const settle = () => {
      element.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
      element.style.transition = '';
      element.style.height = '';
      delete element.dataset.resizing;
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === 'height') settle();
    };
    const timer = window.setTimeout(settle, SAFETY_MS);
    element.addEventListener('transitionend', onEnd);
    // a change mid-flight settles first; the next run starts from the observed height
    return settle;
  }, [key, scroller]);

  return ref;
}
