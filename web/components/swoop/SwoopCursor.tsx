'use client';

/**
 * the machine's own pointer.
 *
 * the frames carry no cursor — desktop duplication never blends it in — so it
 * is drawn here from the host's `cpos`/`cshape` feed, in one of two ways and
 * never both:
 *
 * - **outside pointer lock** the local css cursor is on screen where the
 *   machine's pointer went, so the machine's shape is applied to the stage as
 *   a css cursor and nothing is overlaid. overlaying too puts a second arrow a
 *   few pixels from the real one on every move, which reads as lag that is
 *   not there.
 * - **under pointer lock** the browser hides the local cursor (fullscreen
 *   takes the lock on click), so the shape is overlaid at `cpos` over the
 *   picture, hotspot on the position, and hidden when the machine hides it.
 *
 * a shape above 32 css px is overlaid in both cases: browsers silently ignore
 * large css cursors (PROTOCOL.md §5). the host downscales to 32, so that is
 * the guard, not the path.
 *
 * the overlay is drawn at the picture's scale, so a cursor on a 1080p machine
 * shown on a 4k display is as big as everything else on it, and with a thin
 * halo in both black and white: the host draws a monochrome cursor's "invert
 * the screen" pixels as black, which is the i-beam, and over dark text that
 * is nothing at all. the halo colours are the remote image's, not the theme's.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { MousePointer2 } from 'lucide-react';
import { NO_CURSOR, swoopCursor, type SwoopCursorShape } from '@/lib/swoop/cursor';
import { toPixel, useSwoopPictureBox } from '@/hooks/useSwoopPictureBox';
import type { SwoopSession } from '@/lib/swoop/features';

export interface SwoopCursorProps {
  session: SwoopSession | null;
}

const subscribeNever = (): (() => void) => () => {};
const noCursor = () => NO_CURSOR;

/** §5: the largest shape a css cursor can be trusted with. */
const MAX_CSS_CURSOR_PX = 32;

const fitsCssCursor = (shape: SwoopCursorShape): boolean =>
  shape.w <= MAX_CSS_CURSOR_PX && shape.h <= MAX_CSS_CURSOR_PX;

const pngUrl = (shape: SwoopCursorShape): string => `data:image/png;base64,${shape.png}`;

function usePointerLocked(session: SwoopSession | null): boolean {
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    if (!session) return;
    const sync = () => setLocked(document.pointerLockElement === session.stage);
    sync();
    document.addEventListener('pointerlockchange', sync);
    return () => document.removeEventListener('pointerlockchange', sync);
  }, [session]);
  return locked;
}

export function SwoopCursor({ session }: SwoopCursorProps) {
  const store = swoopCursor(session);
  const state = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.get ?? noCursor,
    // the server has no session and no channel; hydration fills it in.
    noCursor,
  );
  const locked = usePointerLocked(session);
  const box = useSwoopPictureBox(session);
  const overlay = locked || (state.shape !== null && !fitsCssCursor(state.shape));

  // the css half: the machine's shape on the local cursor, and only there.
  // cleared on the way out so the stage never keeps a shape from a session
  // that has ended.
  useEffect(() => {
    if (!session) return;
    const style = session.stage.style;
    if (!overlay && state.shape) {
      style.setProperty('cursor', `url(${pngUrl(state.shape)}) ${state.shape.hotX} ${state.shape.hotY}, auto`);
    } else {
      style.removeProperty('cursor');
    }
    return () => {
      style.removeProperty('cursor');
    };
  }, [session, overlay, state.shape]);

  if (!session || !box || !overlay || !state.visible) return null;

  const left = toPixel(state.x, box.left, box.width);
  const top = toPixel(state.y, box.top, box.height);
  const scale = box.scale;
  if (state.shape) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a data url the host just sent, never optimised
      <img
        alt=""
        aria-hidden
        data-testid="machine-cursor"
        src={pngUrl(state.shape)}
        className="pointer-events-none absolute max-w-none select-none [image-rendering:pixelated] [filter:drop-shadow(0_0_1px_white)_drop-shadow(0_0_1px_black)]"
        style={{
          left: left - state.shape.hotX * scale,
          top: top - state.shape.hotY * scale,
          width: state.shape.w * scale,
          height: state.shape.h * scale,
        }}
      />
    );
  }
  // no shape yet, or its upload was lost: a plain arrow, hotspot at its tip.
  return (
    <MousePointer2
      aria-hidden
      data-testid="machine-cursor"
      className="pointer-events-none absolute fill-background text-foreground"
      style={{ left, top, width: 16 * scale, height: 16 * scale }}
    />
  );
}
