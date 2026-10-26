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
 *   takes the lock on click when the session bar's mouse-capture toggle is
 *   on, `lib/swoop/mouseCapture.ts`), so the shape is overlaid at `cpos` over
 *   the picture, hotspot on the position, and hidden when the machine hides
 *   it.
 * - **off the picture** — over the letterbox bars, with no drag under way —
 *   input sends nothing, so the local pointer is shown as itself and the
 *   machine's is not drawn: pinned to the picture's edge it looked stuck
 *   there while the real pointer moved on unseen.
 *
 * **never no pointer.** the local one is hidden only for the machine's, so
 * only once there is a picture to draw it on and the host has said where it
 * is: over the connecting stage, and until the first `cpos`, the local pointer
 * stays up. when the host says its pointer is hidden, the local one is hidden
 * only while a press that went down over the machine's showing pointer is
 * held: a program that hides it for a drag, a 3d view's mouse look, means it.
 * (an older host also reported windows' title-bar drag that way, with the
 * pointer painted into the picture; a current one sends that pointer shown,
 * PROTOCOL.md §5.) any other time a program has hidden it, a kiosk or a
 * player, or it is on another of the machine's displays, and the operator
 * would be clicking blind. under pointer lock the browser hides
 * the local one whatever this says, and a game that hides the machine's means
 * it. the drawn pointer paints above the stage's panels, so none covers it.
 *
 * **a watcher's pointer is its own.** it moves nothing on the machine, so it
 * is never hidden or given the machine's shape, and the machine's pointer is
 * drawn where it is.
 *
 * **at the machine's own size.** a shape is drawn at its png pixels, times
 * what the host shrank for the wire, over the scale of the display the host
 * drew it at (`dpi`, 96 being 100%): the size of the pointer on the machine,
 * which is the size of the operator's own, whatever the picture is scaled to,
 * in a browser and in the app alike. a 2x mac's 56 px arrow is 28 css px. a
 * host older than `dpi` keeps the sizes it had: the picture's scale in a
 * browser, machine pixels in the app. the plain arrow that stands in before
 * a shape arrives is 16 css px for every host.
 *
 * in the owlette swoop desktop app the shape is overlaid in both cases: the
 * window's webview hands a css cursor to the native pointer at bitmap size,
 * so on a scaled display it came out small and soft. in a browser it is
 * overlaid whenever a css cursor, which draws a png pixel per css pixel, would
 * draw it at another size, or it is above 32 css px, which browsers silently
 * ignore (PROTOCOL.md §5).
 *
 * **an overlay moves with the local mouse.** outside pointer lock the
 * controller's overlay is drawn where its last move sent the machine's
 * pointer, the moment it is sent, as a css cursor would be: `cpos` is a round
 * trip behind, and over a slow link every move waited on it. until the first
 * move, under pointer lock and for a watcher, it is drawn at `cpos`.
 *
 * the overlay has a thin halo in both black and white: the host draws a
 * monochrome cursor's "invert the screen" pixels as black, which is the
 * i-beam, and over dark text that is nothing at all. the halo colours are the
 * remote image's, not the theme's.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { MousePointer2 } from 'lucide-react';
import { NO_CURSOR, swoopCursor, type SwoopCursorShape } from '@/lib/swoop/cursor';
import { toPixel, useSwoopPictureBox, type PictureBox } from '@/hooks/useSwoopPictureBox';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';

export interface SwoopCursorProps {
  session: SwoopSession | null;
}

const subscribeNever = (): (() => void) => () => {};
const noCursor = () => NO_CURSOR;
const onPicture = () => false;
const noButton = () => false;
const noPoint = () => null;

/** §5: the largest shape a css cursor can be trusted with. */
const MAX_CSS_CURSOR_PX = 32;

/** 100%, and what a host older than `dpi` is taken to have drawn at. */
const DEFAULT_DPI = 96;

// a css cursor is drawn png pixel for css pixel, so only a shape drawn one
// png pixel per css pixel can be one.
const fitsCssCursor = (shape: SwoopCursorShape): boolean =>
  shape.scale * DEFAULT_DPI === (shape.dpi ?? DEFAULT_DPI) &&
  shape.w <= MAX_CSS_CURSOR_PX &&
  shape.h <= MAX_CSS_CURSOR_PX;

/**
 * png pixels to css pixels as the overlay draws them: the machine's own size,
 * or for a host older than `dpi` the size it had. multiplied before it
 * divides, so a whole size in css pixels comes out whole.
 */
const toCss =
  (shape: SwoopCursorShape, box: PictureBox, inApp: boolean) =>
  (px: number): number =>
    shape.dpi === undefined && !inApp
      ? px * box.scale * shape.scale
      : (px * shape.scale * DEFAULT_DPI) / (shape.dpi ?? DEFAULT_DPI);

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
  const capture = swoopInputCapture(session);
  const outside = useSyncExternalStore(
    capture ? capture.onPointerOutsideChange : subscribeNever,
    capture ? () => capture.pointerOutside : onPicture,
    onPicture,
  );
  const held = useSyncExternalStore(
    capture ? capture.onButtonHeldChange : subscribeNever,
    capture ? () => capture.buttonHeld : noButton,
    noButton,
  );
  const sent = useSyncExternalStore(
    capture ? capture.onPointerSentChange : subscribeNever,
    capture ? () => capture.pointerSent : noPoint,
    noPoint,
  );
  // whether the machine's pointer was showing when the press now held went
  // down: a program that hides it for a drag hid a showing one, while a
  // kiosk's or a player's was hidden all along.
  const [press, setPress] = useState({ held: false, overShown: false });
  if (press.held !== held) setPress({ held, overShown: held && state.visible });
  const box = useSwoopPictureBox(session);
  const picture = box !== null;
  const inApp = useViewerAppPlatform() !== null;
  const watching = session !== null && !session.ctl;
  const overlay = watching || locked || inApp || (state.shape !== null && !fitsCssCursor(state.shape));
  // the machine's pointer is in the local one's place: drawn over the picture,
  // or, hidden by a program for a drag, not drawn at all.
  const standIn = picture && state.positioned && (state.visible ? overlay : press.held && press.overShown);

  // the css half: one pointer, never two and never none. outside pointer lock
  // the local cursor is the machine's shape, or nothing at all while the
  // machine's stands in for it. cleared on the way out so the stage never
  // keeps a shape from a session that has ended.
  useEffect(() => {
    if (!session) return;
    const style = session.stage.style;
    if (watching || locked || outside || !picture) {
      style.removeProperty('cursor');
    } else if (standIn) {
      style.setProperty('cursor', 'none');
    } else if (state.shape && !overlay) {
      style.setProperty('cursor', `url(${pngUrl(state.shape)}) ${state.shape.hotX} ${state.shape.hotY}, auto`);
    } else {
      style.removeProperty('cursor');
    }
    return () => {
      style.removeProperty('cursor');
    };
  }, [session, watching, locked, outside, picture, standIn, overlay, state.shape]);

  if (!session || !box || !overlay || !state.visible || outside) return null;

  const at = sent ?? state;
  const left = toPixel(at.x, box.left, box.width);
  const top = toPixel(at.y, box.top, box.height);
  if (!state.shape) {
    // no shape yet, or its upload was lost: a plain arrow, hotspot at its tip.
    return (
      <MousePointer2
        aria-hidden
        data-testid="machine-cursor"
        className="pointer-events-none absolute z-10 fill-background text-foreground"
        style={{ left, top, width: 16, height: 16 }}
      />
    );
  }
  const css = toCss(state.shape, box, inApp);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a data url the host just sent, never optimised
    <img
      alt=""
      aria-hidden
      data-testid="machine-cursor"
      src={pngUrl(state.shape)}
      className="pointer-events-none absolute z-10 max-w-none select-none [filter:drop-shadow(0_0_1px_white)_drop-shadow(0_0_1px_black)]"
      style={{
        left: left - css(state.shape.hotX),
        top: top - css(state.shape.hotY),
        width: css(state.shape.w),
        height: css(state.shape.h),
      }}
    />
  );
}
