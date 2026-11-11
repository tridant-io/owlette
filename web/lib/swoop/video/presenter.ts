/**
 * swoop presentation — plan D17 under the arm the bake-off actually chose, and
 * smooth scaling's canvas over it.
 *
 * gate G1 closed on 2026-09-18 on arm B: video arrives on an rtp media track
 * and the `<video>` element decodes, buffers and presents it itself. there is
 * no `VideoDecoder` and no `VideoFrame` in the shipping path, so the
 * `desynchronized` 2d canvas, the `ImageBitmapRenderingContext` fallback and
 * the `frame.close()` discipline D17 describes are arm-A-only and are not here.
 *
 * D17's arm-B reading also said no canvas in the shipping path. from 4.2.0 a
 * webgl2 canvas mirrors the video for minification
 * (dev/active/swoop-clarity/plan.md, C2): browsers draw a video with a
 * bilinear filter and no mipmaps, which is exact at 1:1 and at 1:2 on whole
 * device pixels and drops thin strokes at any other size below 1:1. so where
 * the picture is shown below 0.98 of its pixels and is not one of those two,
 * `present` draws each presented frame through `smooth.ts`'s area average,
 * from the one rvfc chain the receiver owns, and the canvas hides itself
 * everywhere else (C5).
 *
 * `receiver.ts` owns the element's lifecycle and the single
 * `requestVideoFrameCallback` chain, because its frame-stamp join needs that
 * metadata and the `swoop-meta` records together. this file owns what is left
 * and is genuinely presentation: the playout-delay `max` the session is
 * contracted to, the presented size, the drop/duplicate/phase counters the
 * stats overlay reads, and the canvas.
 *
 * what D17 still binds here:
 *  - no frame is presented from `requestAnimationFrame`. `invalidate` redraws
 *    the frame already shown, once, after a zoom, a layout or a toggle with no
 *    new frame, and the canvas's estimate reads the clock in a double rAF; a
 *    rAF `timestamp` is never read, because spike 2.12 measured it running
 *    16.1 ms *behind* a draw that preceded it.
 *  - `presentedFrames` and `expectedDisplayTime` are read to measure and never
 *    to pace. they arrive through `FrameObservation` and `present`; a second
 *    rVFC chain on the same element would double-count.
 *  - no dejitter buffer of ours. the receiver's own is the only one.
 *
 * the latency harness samples these counters rather than reading pixels back: a
 * per-frame readback from a hardware-decoded `<video>` costs 10–15 ms p50
 * (spike 2.12), against 0–2.3 ms for a canvas, so it can never sit in the hot
 * path. the canvas uploads the frame on the gpu and reads nothing back.
 */

import { PLAYOUT_DELAY_MAX_MS, PLAYOUT_DELAY_MIN_MS } from '@/lib/swoop/protocol';
import type { FrameObservation } from '@/lib/swoop/video/receiver';
import { createSmoothRenderer, type SmoothRect, type SmoothRenderer } from '@/lib/swoop/video/smooth';

/** protocol section 3 allows `max ∈ (0, 500]`; `max = 0` makes chrome fast-forward and spam PLI. */
const PLAYOUT_DELAY_CEILING_MS = 500;

/** below this share of its pixels a picture is the canvas's to draw (plan C5). */
const SMOOTH_BELOW = 0.98;

/** device-pixel slack: a css rect times a fractional dpr misses a whole number by float error. */
const SLACK = 0.01;

/** the draws smooth scaling's estimate is the median of. */
const ESTIMATE_DRAWS = 60;

/**
 * what draws the picture. exact: a whole fraction on whole device pixels,
 * drawn by the video at 1:1 and 1:2 and by the canvas at 1:3 and below.
 * smooth: the canvas's area average at any other size below 1:1. standard: the
 * browser's own filter, because smooth scaling is off, cannot draw or was
 * lost, or the picture is shown at or above full size.
 */
export type SwoopScaling = 'exact' | 'smooth' | 'standard';

export interface PresenterStats {
  /** host resolution as the element presents it; 0 before the first frame. */
  width: number;
  height: number;
  /** the renderer's own presented-frame counter. */
  presentedFrames: number;
  /** frames the compositor skipped (the counter advanced by more than one). */
  gaps: number;
  /** observations where it did not advance — the same picture shown twice. */
  duplicates: number;
  /** `expectedDisplayTime - presentationTime` of the last frame; null until one arrives. */
  displayPhaseMs: number | null;
  scaling: SwoopScaling;
  /**
   * how much later than the video the canvas shows a frame, an estimate: the
   * median over the last draws. null while the canvas does not draw.
   */
  smoothEstimateMs: number | null;
}

export interface PresenterOptions {
  /** smooth scaling's canvas, over the video in its area. */
  canvas: HTMLCanvasElement;
  /** whether smooth scaling may draw: this viewer has it on and this browser can (`smoothActive`). */
  smooth: () => boolean;
  playoutDelayMaxMs?: number;
}

export interface SwoopPresenter {
  /**
   * the `max` of the playout-delay header extension this session is contracted
   * to, validated on construction. it is signalled by the peer in the rtp
   * header extension — it is NOT written to `RTCRtpReceiver.jitterBufferTarget`
   * here or anywhere else in this file. despite the name, chrome maps that
   * attribute to `SetJitterBufferMinimumDelay` →
   * `VCMTiming::TargetDelay() = max(min_playout_delay, …)`, so it is a
   * *minimum* and can only raise the latency floor
   * (`research/06-chrome-h26x-receiver.md` §1.2). `receiver.ts` is its one
   * writer and sets it to 0.
   */
  readonly playoutDelayMaxMs: number;
  /** wire to `SwoopReceiver`'s `onFrame`. */
  observe(observation: FrameObservation): void;
  /** wire to `SwoopReceiver`'s `onPresent`: every presented frame, joined or not. */
  present(metadata: VideoFrameCallbackMetadata): void;
  /**
   * the picture's box moved, or smooth scaling changed: read the box again,
   * so `present` reads no layout, and redraw the frame already shown once in
   * the next animation frame.
   */
  invalidate(): void;
  /**
   * frames the canvas drew. the video sits at opacity 0 under the canvas,
   * where chromium counts its frames as dropped, so the freeze watchdog counts
   * these as shown.
   */
  readonly drawnFrames: number;
  stats(): PresenterStats;
  detach(): void;
}

/** the picture as the canvas draws it, read by `invalidate`. */
interface Placement {
  /** the picture's rect in the canvas's device pixels. */
  dest: SmoothRect;
  /** whether the picture starts on a whole device pixel of the screen. */
  onGrid: boolean;
  /** the canvas's size in device pixels. */
  size: { width: number; height: number };
  /** smooth scaling's setting, read here because every change of it invalidates. */
  smooth: boolean;
}

const whole = (value: number): boolean => Math.abs(value - Math.round(value)) < SLACK;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createPresenter(
  video: HTMLVideoElement,
  { canvas, smooth, playoutDelayMaxMs = PLAYOUT_DELAY_MAX_MS }: PresenterOptions,
): SwoopPresenter {
  if (playoutDelayMaxMs <= PLAYOUT_DELAY_MIN_MS || playoutDelayMaxMs > PLAYOUT_DELAY_CEILING_MS) {
    throw new RangeError(`swoop presenter: playout delay ${playoutDelayMaxMs} outside (0, ${PLAYOUT_DELAY_CEILING_MS}]`);
  }

  let width = 0;
  let height = 0;
  let presentedFrames = 0;
  let gaps = 0;
  let duplicates = 0;
  let displayPhaseMs: number | null = null;
  let lastPresented: number | null = null;

  // made at its first draw, so a browser that never draws never opens a context; null once refused or detached
  let renderer: SmoothRenderer | null | undefined;
  let place: Placement | null = null;
  // the canvas's exact device size, from the last observation that gave one
  let canvasPixels: { width: number; height: number } | null = null;
  let scaling: SwoopScaling = 'standard';
  let drawing = false;
  let drawnFrames = 0;
  let estimates: number[] = [];
  // bumped when drawing stops, so an estimate measured across the stop is dropped
  let epoch = 0;
  let redraw = 0;

  const readSize = () => {
    width = video.videoWidth;
    height = video.videoHeight;
  };

  // the host changes resolution when an operator changes the desktop or we
  // switch display; the element reports it and the stage lays out from here.
  const onResize = () => readSize();

  video.addEventListener('resize', onResize);
  readSize();

  // plan C5: the video draws 1:1 and 1:2 on whole device pixels exactly, and the canvas the rest below SMOOTH_BELOW.
  const judge = (): { scaling: SwoopScaling; draws: boolean } => {
    const { videoWidth: w, videoHeight: h } = video;
    if (!place || !w || !h || place.dest.width <= 0 || place.dest.height <= 0) return { scaling: 'standard', draws: false };
    const { dest } = place;
    const n = Math.round(w / dest.width);
    const fraction = place.onGrid && n >= 1 && Math.abs(dest.width * n - w) < SLACK && Math.abs(dest.height * n - h) < SLACK;
    if (fraction && n <= 2) return { scaling: 'exact', draws: false };
    if (dest.width / w >= SMOOTH_BELOW || !place.smooth) return { scaling: 'standard', draws: false };
    if (renderer === undefined) renderer = createSmoothRenderer(canvas);
    if (!renderer || renderer.lost) return { scaling: 'standard', draws: false };
    return { scaling: fraction ? 'exact' : 'smooth', draws: true };
  };

  const stop = () => {
    renderer?.hide();
    if (!drawing) return;
    drawing = false;
    estimates = [];
    epoch += 1;
  };

  /** draws the video's current frame, or hides the canvas; whether it drew. */
  const paint = (): boolean => {
    const judged = judge();
    scaling = judged.scaling;
    if (!judged.draws || !renderer || !place) {
      stop();
      return false;
    }
    renderer.resize(place.size.width, place.size.height);
    renderer.draw(video, place.dest);
    drawing = true;
    return true;
  };

  const invalidate = () => {
    const dpr = window.devicePixelRatio || 1;
    const picture = video.getBoundingClientRect();
    const area = canvas.getBoundingClientRect();
    place = {
      dest: {
        x: (picture.left - area.left) * dpr,
        y: (picture.top - area.top) * dpr,
        width: picture.width * dpr,
        height: picture.height * dpr,
      },
      onGrid: whole(picture.left * dpr) && whole(picture.top * dpr),
      size: canvasPixels ?? { width: Math.round(area.width * dpr), height: Math.round(area.height * dpr) },
      smooth: smooth(),
    };
    if (redraw === 0) {
      redraw = requestAnimationFrame(() => {
        redraw = 0;
        paint();
      });
    }
  };

  const resizes =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          const exact = entries.at(-1)?.devicePixelContentBoxSize?.[0];
          canvasPixels = exact ? { width: exact.inlineSize, height: exact.blockSize } : null;
          invalidate();
        })
      : null;
  try {
    resizes?.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    // safari has no device-pixel-content-box: the canvas's size times dpr
    resizes?.observe(canvas);
  }

  return {
    playoutDelayMaxMs,

    observe(observation) {
      if (lastPresented !== null) {
        const advance = observation.presentedFrames - lastPresented;
        if (advance > 1) gaps += advance - 1;
        else if (advance <= 0) duplicates += 1;
      }
      lastPresented = observation.presentedFrames;
      presentedFrames = observation.presentedFrames;
      // both stamps come from one frame's metadata, so the phase does not
      // depend on when the observation reached us.
      displayPhaseMs = observation.expectedDisplayMs - observation.presentedMs;
      readSize();
    },

    present(metadata) {
      if (!paint()) return;
      drawnFrames += 1;
      // no browser reports when a canvas reaches the screen. two animation
      // frames after the draw it has been composited, so the clock there, less
      // when the video's frame was due on screen, is an estimate with about a
      // refresh of error; the probe (task 4.1) and the owner's photos (8.1)
      // measure it (plan C15).
      const at = epoch;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (at !== epoch) return;
          estimates.push(performance.now() - metadata.expectedDisplayTime);
          if (estimates.length > ESTIMATE_DRAWS) estimates.shift();
        }),
      );
    },

    invalidate,

    get drawnFrames() {
      return drawnFrames;
    },

    stats() {
      return {
        width,
        height,
        presentedFrames,
        gaps,
        duplicates,
        displayPhaseMs,
        scaling,
        smoothEstimateMs: drawing && estimates.length > 0 ? median(estimates) : null,
      };
    },

    detach() {
      video.removeEventListener('resize', onResize);
      lastPresented = null;
      resizes?.disconnect();
      cancelAnimationFrame(redraw);
      redraw = 0;
      place = null;
      stop();
      renderer?.dispose();
      renderer = null;
    },
  };
}
