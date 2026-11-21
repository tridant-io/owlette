/**
 * the slide every expandable panel shares: collapsible-down and collapsible-up
 * in globals.css, on a radix CollapsibleContent. a test reads the slides off
 * their animationstart events, which bubble, so it never races a 200ms
 * animation. only these two count: a spinner inside a panel is an animation too,
 * and one that never ends.
 */

import type { Locator } from '@playwright/test';

/**
 * start recording the slides that play inside `scope`. the returned read gives
 * their names in order, space-separated: "collapsible-down collapsible-up".
 */
export async function recordSlides(scope: Locator): Promise<() => Promise<string>> {
  await scope.evaluate((el: HTMLElement) => {
    el.dataset.slides = '';
    el.addEventListener('animationstart', (e) => {
      if (e.animationName.startsWith('collapsible-')) el.dataset.slides += `${e.animationName} `;
    });
  });
  return () => scope.evaluate((el: HTMLElement) => (el.dataset.slides ?? '').trim());
}

/** wait out a slide in `scope`: a click inside a panel still sliding open can miss its target */
export async function slideSettled(scope: Locator): Promise<void> {
  await scope.evaluate((el) =>
    Promise.allSettled(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a instanceof CSSAnimation && a.animationName.startsWith('collapsible-'))
        .map((a) => a.finished),
    ),
  );
}
