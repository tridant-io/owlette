/**
 * focus-ring clipping checks. a focus ring is painted outside its control's box
 * (tailwind's ring-* is an unblurred box-shadow spread, the global
 * `*:focus-visible` outline sits at an offset), so an overflow ancestor flush
 * with the control on that side cuts the ring off. `overflow-y-auto` clips the
 * x axis too: a scroll body with no inline gutter eats the left edge of every
 * full-width field in it.
 */

import type { Locator, Page } from '@playwright/test';
import { stabilize } from './mobile';

export interface ClippedRing {
  /** the focused control: its id, label or text */
  control: string;
  edge: 'left' | 'right' | 'top' | 'bottom' | 'no focus-visible';
  /** px of ring hidden on that edge */
  px: number;
}

/**
 * focus every tab stop inside `scope` in document order, as tabbing would, and
 * return each ring edge an overflow ancestor hides. focus() scrolls a stop in
 * the way a tab does, flush with the scroller's edge when it was out of view.
 * transitions go first, or a ring still growing in reads as no ring. one key
 * press then: without a keyboard event, focus() does not match
 * `:focus-visible` on a button, and a stop that never shows a ring is
 * reported rather than passed.
 */
export async function clippedFocusRings(page: Page, scope: Locator): Promise<ClippedRing[]> {
  await stabilize(page);
  await page.keyboard.press('Shift');
  return scope.evaluate((root) => {
    const stops = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]',
      ),
    ).filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.checkVisibility());

    const found: ClippedRing[] = [];
    for (const el of stops) {
      el.focus();
      const control =
        (el.id && `#${el.id}`) ||
        el.getAttribute('aria-label') ||
        el.textContent?.trim().slice(0, 40) ||
        el.tagName.toLowerCase();
      if (!el.matches(':focus-visible')) {
        found.push({ control, edge: 'no focus-visible', px: 0 });
        continue;
      }

      // the ring is the widest outset, unblurred, unshifted shadow, or the
      // outline plus its offset. computed colours carry commas of their own,
      // so strip every function call before splitting the shadow list.
      const cs = getComputedStyle(el);
      let shadows = cs.boxShadow;
      while (/\([^()]*\)/.test(shadows)) shadows = shadows.replace(/[a-z-]*\([^()]*\)/gi, '');
      let extent = 0;
      for (const shadow of shadows.split(',')) {
        if (shadow.trim() === 'none' || shadow.includes('inset')) continue;
        const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        if (x === 0 && y === 0 && blur === 0) extent = Math.max(extent, spread);
      }
      if (cs.outlineStyle !== 'none') {
        extent = Math.max(extent, parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset));
      }
      if (extent <= 0) continue;

      const box = el.getBoundingClientRect();
      const worst = { left: 0, right: 0, top: 0, bottom: 0 };
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        const clipX = s.overflowX !== 'visible';
        const clipY = s.overflowY !== 'visible';
        if (!clipX && !clipY) continue;
        // the clip box is the padding box less any scrollbar
        const r = a.getBoundingClientRect();
        const left = r.left + a.clientLeft;
        const top = r.top + a.clientTop;
        const right = left + a.clientWidth;
        const bottom = top + a.clientHeight;
        // a control still partly out of view is scrolling, not clipping (1px
        // of slack: one scrolled in flush can sit a fraction past the edge)
        if (box.left < left - 1 || box.right > right + 1 || box.top < top - 1 || box.bottom > bottom + 1) {
          continue;
        }
        if (clipX) {
          worst.left = Math.max(worst.left, left - (box.left - extent));
          worst.right = Math.max(worst.right, box.right + extent - right);
        }
        if (clipY) {
          worst.top = Math.max(worst.top, top - (box.top - extent));
          worst.bottom = Math.max(worst.bottom, box.bottom + extent - bottom);
        }
      }

      // half a pixel of slack for fractional layout
      for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
        if (worst[edge] > 0.5) found.push({ control, edge, px: Math.round(worst[edge] * 10) / 10 });
      }
    }
    return found;
  });
}
