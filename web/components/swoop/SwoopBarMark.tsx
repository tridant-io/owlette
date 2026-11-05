'use client';

import { useLayoutEffect } from 'react';
import { applyBarPosition } from '@/lib/swoop/barPosition';

/**
 * marks <html> with the bar's side when a session page is reached by a client
 * navigation (the picker in the owlette swoop desktop app, a dashboard link).
 * a layout effect, so the mark lands before the commit paints and the bar never
 * draws on top for a frame first. a hard load is marked earlier still, by the
 * root layout's boot script.
 */
export function SwoopBarMark() {
  useLayoutEffect(() => {
    applyBarPosition();
  }, []);
  return null;
}
