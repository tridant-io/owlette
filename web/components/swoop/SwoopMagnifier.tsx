'use client';

/**
 * the cursor preview. a finger covers the very point it aims at, so while one
 * holds the picture (`lib/swoop/touch.ts`) a loupe above it shows what is
 * under it at twice its size on screen, with the machine's pointer, its hot
 * spot where the lift will click.
 *
 * drawn from the `<video>` once a frame while it is up, and placed in the same
 * frame, so it never trails the finger; nothing runs while it is not. the
 * first frame is drawn before paint, or the loupe flashes in the corner.
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { MousePointer2 } from 'lucide-react';
import { NO_CURSOR, cursorPngUrl, swoopCursor } from '@/lib/swoop/cursor';
import type { SwoopSession } from '@/lib/swoop/features';
import { NO_AIM, swoopTouch } from '@/lib/swoop/touch';

/** the loupe's diameter, in css pixels. */
const SIZE = 112;
const MAGNIFY = 2;
/** from the finger to the loupe's centre: clear of a fingertip. */
const LIFT = 96;

/** 100%, as `SwoopCursor` reads a shape's `dpi`. */
const DEFAULT_DPI = 96;

const subscribeNever = (): (() => void) => () => {};
const noAim = () => NO_AIM;
const noCursor = () => NO_CURSOR;
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** a square of the frame, `span` frame pixels wide from (sx, sy), onto the whole canvas; what lies off the frame stays clear. */
function drawRegion(context: CanvasRenderingContext2D, video: HTMLVideoElement, sx: number, sy: number, span: number): void {
  const out = context.canvas.width;
  context.clearRect(0, 0, out, out);
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(video.videoWidth, sx + span);
  const y1 = Math.min(video.videoHeight, sy + span);
  if (x1 <= x0 || y1 <= y0) return;
  const k = out / span;
  context.drawImage(video, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
}

export function SwoopMagnifier({ session }: { session: SwoopSession | null }) {
  const touch = swoopTouch(session);
  const aim = useSyncExternalStore(touch?.aim.subscribe ?? subscribeNever, touch?.aim.get ?? noAim, noAim);
  const cursor = swoopCursor(session);
  const { shape } = useSyncExternalStore(cursor?.subscribe ?? subscribeNever, cursor?.get ?? noCursor, noCursor);
  const loupeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const loupe = loupeRef.current;
    const context = canvasRef.current?.getContext('2d');
    if (!session || !touch || !aim.active || !loupe || !context) return;
    const { video, stage } = session;
    const dpr = window.devicePixelRatio || 1;
    context.canvas.width = Math.round(SIZE * dpr);
    context.canvas.height = Math.round(SIZE * dpr);
    let frame = 0;
    const draw = (): void => {
      // the latest finger, read here so a move does not restart the loop
      const { x, y } = touch.aim.get();
      const box = stage.getBoundingClientRect();
      const left = clamp(x - box.left - SIZE / 2, 0, Math.max(0, box.width - SIZE));
      const above = y - box.top - LIFT - SIZE / 2;
      // below the finger when there is no room above it
      const top = above >= 0 ? above : y - box.top + LIFT - SIZE / 2;
      loupe.style.transform = `translate(${left}px, ${top}px)`;
      const picture = session.contentRect();
      if (video.videoWidth > 0 && picture.width > 0) {
        const span = (SIZE * video.videoWidth) / (picture.width * MAGNIFY);
        const cx = ((x - picture.left) / picture.width) * video.videoWidth;
        const cy = ((y - picture.top) / picture.height) * video.videoHeight;
        drawRegion(context, video, cx - span / 2, cy - span / 2, span);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [session, touch, aim.active]);

  if (!session || !aim.active) return null;
  // the machine's own pointer, at its size on the machine (`SwoopCursor`) and magnified with the rest
  const magnified = (px: number): number =>
    shape ? (px * shape.scale * DEFAULT_DPI * MAGNIFY) / (shape.dpi ?? DEFAULT_DPI) : px;
  return (
    <div
      ref={loupeRef}
      aria-hidden
      data-testid="swoop-magnifier"
      className="pointer-events-none absolute left-0 top-0 z-20 overflow-hidden rounded-full border-2 border-border bg-swoop-stage shadow-lg"
      style={{ width: SIZE, height: SIZE }}
    >
      <canvas ref={canvasRef} className="size-full" />
      {shape ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data url the host just sent, never optimised
        <img
          alt=""
          src={cursorPngUrl(shape)}
          className="absolute max-w-none select-none [filter:drop-shadow(0_0_1px_white)_drop-shadow(0_0_1px_black)]"
          style={{
            left: SIZE / 2 - magnified(shape.hotX),
            top: SIZE / 2 - magnified(shape.hotY),
            width: magnified(shape.w),
            height: magnified(shape.h),
          }}
        />
      ) : (
        // the arrow's tip, not its box, on the centre: lucide draws it from (3, 3) of 24
        <MousePointer2
          className="absolute size-6 fill-background text-foreground"
          style={{ left: SIZE / 2 - 3, top: SIZE / 2 - 3 }}
        />
      )}
    </div>
  );
}
