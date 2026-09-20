/**
 * swoop presentation — plan D17 under the arm the bake-off actually chose.
 *
 * gate G1 closed on 2026-09-18 on arm B: video arrives on an rtp media track
 * and the `<video>` element decodes, buffers and presents it itself. there is
 * no `VideoDecoder`, no canvas and no `VideoFrame` in the shipping path, so the
 * `desynchronized` 2d canvas, the `ImageBitmapRenderingContext` fallback and
 * the `frame.close()` discipline D17 describes are arm-A-only and are not here.
 *
 * `receiver.ts` owns the element's lifecycle and the single
 * `requestVideoFrameCallback` chain, because its frame-stamp join needs that
 * metadata and the `swoop-meta` records together. this file owns what is left
 * and is genuinely presentation: the playout-delay `max` the session is
 * contracted to, the presented size, and the drop/duplicate/phase counters the
 * stats overlay reads.
 *
 * what D17 still binds here:
 *  - nothing is scheduled from `requestAnimationFrame`. spike 2.12 measured a
 *    rAF `timestamp` running 16.1 ms *behind* a draw that preceded it, so it is
 *    not even a usable clock.
 *  - `presentedFrames` and `expectedDisplayTime` are read to measure and never
 *    to pace. they arrive through `FrameObservation`; a second rVFC chain on
 *    the same element would double-count.
 *  - no dejitter buffer of ours. the receiver's own is the only one.
 *
 * the latency harness samples these counters rather than reading pixels back: a
 * per-frame readback from a hardware-decoded `<video>` costs 10–15 ms p50
 * (spike 2.12), against 0–2.3 ms for a canvas, so it can never sit in the hot
 * path.
 */

import { PLAYOUT_DELAY_MAX_MS, PLAYOUT_DELAY_MIN_MS } from '@/lib/swoop/protocol';
import type { FrameObservation } from '@/lib/swoop/video/receiver';

/** protocol section 3 allows `max ∈ (0, 500]`; `max = 0` makes chrome fast-forward and spam PLI. */
const PLAYOUT_DELAY_CEILING_MS = 500;

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
  stats(): PresenterStats;
  detach(): void;
}

export function createPresenter(
  video: HTMLVideoElement,
  playoutDelayMaxMs: number = PLAYOUT_DELAY_MAX_MS,
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

  const readSize = () => {
    width = video.videoWidth;
    height = video.videoHeight;
  };

  // the host changes resolution when an operator changes the desktop or we
  // switch display; the element reports it and the stage lays out from here.
  const onResize = () => readSize();

  video.addEventListener('resize', onResize);
  readSize();

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

    stats() {
      return { width, height, presentedFrames, gaps, duplicates, displayPhaseMs };
    },

    detach() {
      video.removeEventListener('resize', onResize);
      lastPresented = null;
    },
  };
}
