/**
 * the picture's box inside the stage, for the overlays that place a pointer on it.
 *
 * a pointer's position arrives normalised over the PICTURE — the letterboxed
 * content area, not the element — so the arithmetic here is the same one
 * `session.contentRect()` exists for on the input side, including its
 * `size - 1` convention. measuring is a layout read, so it happens in an
 * effect after a commit and not in render: a position changes 60 times a
 * second and the box changes when the window does.
 */

import { useEffect, useState } from 'react';
import type { SwoopSession } from '@/lib/swoop/features';

/** the picture's box, in the stage's own coordinates. */
export interface PictureBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function measure(session: SwoopSession): PictureBox {
  const picture = session.contentRect();
  const stage = session.stage.getBoundingClientRect();
  return {
    left: picture.left - stage.left,
    top: picture.top - stage.top,
    width: picture.width,
    height: picture.height,
  };
}

const sameBox = (a: PictureBox | null, b: PictureBox): boolean =>
  a !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/** a normalised coordinate to a pixel along one axis of the box. */
export const toPixel = (normalised: number, offset: number, size: number): number =>
  offset + normalised * Math.max(size - 1, 0);

/**
 * re-measured on a window resize, on entering or leaving fullscreen, and on the
 * `<video>` element's own `resize` — the last one is the display switch, which
 * changes the picture's aspect ratio inside an element whose box never moved
 * and so fires nothing else. re-measuring per cursor message instead would be a
 * layout read sixty times a second for a box that changes when the window does.
 */
export function useSwoopPictureBox(session: SwoopSession | null): PictureBox | null {
  const [box, setBox] = useState<PictureBox | null>(null);

  useEffect(() => {
    // no session means nothing is rendered at all, so the last box measured is
    // never read again — and the next session re-measures before it is.
    if (!session) return;
    const sync = () => {
      const next = measure(session);
      setBox((held) => (sameBox(held, next) ? held : next));
    };
    sync();
    window.addEventListener('resize', sync);
    document.addEventListener('fullscreenchange', sync);
    session.video.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('resize', sync);
      document.removeEventListener('fullscreenchange', sync);
      session.video.removeEventListener('resize', sync);
    };
  }, [session]);

  return box;
}
