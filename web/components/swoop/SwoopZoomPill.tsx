'use client';

/**
 * the way back from a pinch: while the picture is zoomed, a pill at the top of
 * the stage fits it to the screen again. a double tap is the machine's (it is
 * a double-click there), so the way out is a control of its own.
 */

import { useSyncExternalStore } from 'react';
import { Shrink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { SwoopSession } from '@/lib/swoop/features';
import { swoopTouch } from '@/lib/swoop/touch';
import { NO_ZOOM } from '@/lib/swoop/zoom';

const subscribeNever = (): (() => void) => () => {};
const noZoom = () => NO_ZOOM;

export function SwoopZoomPill({ session }: { session: SwoopSession | null }) {
  const touch = swoopTouch(session);
  const zoom = useSyncExternalStore(touch?.zoom.subscribe ?? subscribeNever, touch?.zoom.get ?? noZoom, noZoom);
  if (!touch || zoom.scale === 1) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => touch.zoom.reset()}
      className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full shadow-sm"
    >
      <Shrink aria-hidden />
      fit
    </Button>
  );
}
