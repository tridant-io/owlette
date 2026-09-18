/**
 * the viewer's half of `swoop-feedback` (PROTOCOL.md §5): the reports the
 * host's rate governor runs on, and the clock exchange that makes every
 * per-stage number in the stats overlay a real measurement.
 *
 * three things go out, on one 2 Hz timer:
 *
 * - **`fb`, every tick.** the frame stamps the host cannot see for itself —
 *   when the picture arrived, when the decoder finished with it, when the user
 *   agent presented it — plus the measured offset between the two clocks.
 * - **`stats`, every second** (§5's cadence): frame gaps, the delay rise this
 *   module measures, and a **measured** app-level round trip. parsec's web
 *   client hardcodes `networkLatency = 0`; every latency number downstream of
 *   that is fiction, so `rttMs` here is never sent before a `pong` has actually
 *   come back.
 * - **`ping`, every second.** the ntp-style exchange: `t1` out, the host's
 *   `hostUs` and our `t3` back, `rtt = t3 - t1` and
 *   `offset = hostUs - (t1 + rtt/2)`. the best (lowest-rtt) sample of the last
 *   few wins, because a sample that queued behind something is a sample whose
 *   two halves were not symmetric.
 *
 * **what this file does not do: it does not decide anything.** §5's `fb` is
 * `deny_unknown_fields` on the host and carries raw stamps, so there is no
 * field for a client-computed delay rise and none is invented here. the rise
 * this module tracks is for the overlay; the host recomputes its own from these
 * stamps and its own send times, because the number that moves the host's
 * encoder should be the host's own arithmetic rather than a scalar a browser
 * asserts. see `agent/swoop/src/transport/governor.rs`.
 *
 * the rise is measured against the best one-way delay of a 30 s rolling window,
 * and deliberately **without** applying the clock offset: the two clocks'
 * difference is a constant inside that subtraction and cancels, so an offset
 * that re-latches cannot disturb the reference. the host has the same property
 * and the same blind spot — a delay that stays raised for longer than the
 * window becomes the new baseline.
 */

import { decodeFeedbackMessage, encodeFeedbackMessage } from '@/lib/swoop/protocol';

import type { FrameObservation } from '@/lib/swoop/video/receiver';

/** §5 says `stats` once a second; `fb` is sampled, and this is the sample rate. */
export const REPORT_INTERVAL_MS = 500;

/** the rolling reference the delay rise is measured against. */
export const REFERENCE_WINDOW_MS = 30_000;

/**
 * a new offset estimate is only published when it moves this far. the host
 * resets its 30 s reference on a step in this value, so republishing sampling
 * noise would keep throwing that reference away.
 */
const OFFSET_LATCH_US = 2_000;

/** clock samples kept; the lowest-rtt one of these is the estimate. */
const CLOCK_SAMPLES = 8;

/** unanswered pings held before the oldest is abandoned and counted. */
const PENDING_PINGS = 4;

export interface FeedbackViewport {
  widthCss: number;
  heightCss: number;
}

export interface SwoopFeedbackOptions {
  /** writes one encoded message on `swoop-feedback`. this module owns no channel. */
  send: (payload: string) => void;
  /** the presentation surface's css size, read at report time. */
  viewport: () => FeedbackViewport;
  /** injectable clock, in `performance.now()` milliseconds. */
  now?: () => number;
  reportIntervalMs?: number;
  referenceWindowMs?: number;
}

export interface SwoopFeedbackDiagnostics {
  reports: number;
  fbSent: number;
  statsSent: number;
  pingsSent: number;
  pongsMatched: number;
  /** a `pong` for an id we never sent, or already answered. */
  pongsUnmatched: number;
  pingsAbandoned: number;
  framesObserved: number;
  /** cumulative frames the host sent that never reached presentation. */
  framesDropped: number;
  /** frames whose arrival time the ua did not report — see `arrivalUs`. */
  arrivalFallbacks: number;
  /** `stats` reports withheld because no round trip had been measured yet. */
  statsSuppressed: number;
  clockOffsetUs: number | null;
  rttUs: number | null;
  delayRiseUs: number | null;
  referenceMinUs: number | null;
  referenceSamples: number;
}

interface ClockSample {
  rttUs: number;
  offsetUs: number;
}

const usFromMs = (ms: number): number => Math.round(ms * 1000);

/**
 * the arrival stamp. `receiveTime` is optional in `requestVideoFrameCallback`,
 * so when the ua withholds it the presentation time stands in: that adds the
 * decode-and-present interval to every sample, which is a constant and cancels
 * against the rolling minimum — and a rise in it is real degradation anyway.
 * the substitution is counted rather than hidden.
 */
const arrivalUs = (frame: FrameObservation): { us: number; fallback: boolean } =>
  frame.arrivalMs === null
    ? { us: usFromMs(frame.presentedMs), fallback: true }
    : { us: usFromMs(frame.arrivalMs), fallback: false };

/** the rolling minimum, as a monotonic deque: the head is the window's best. */
class MinWindow {
  private readonly samples: { atMs: number; value: number }[] = [];

  constructor(private readonly windowMs: number) {}

  push(atMs: number, value: number): void {
    while (this.samples.length > 0 && this.samples[this.samples.length - 1].value >= value) {
      this.samples.pop();
    }
    this.samples.push({ atMs, value });
    while (this.samples.length > 0 && atMs - this.samples[0].atMs > this.windowMs) {
      this.samples.shift();
    }
  }

  min(): number | null {
    return this.samples.length > 0 ? this.samples[0].value : null;
  }

  get size(): number {
    return this.samples.length;
  }
}

export class SwoopFeedback {
  private readonly options: SwoopFeedbackOptions;
  private readonly now: () => number;
  private readonly reportIntervalMs: number;
  private readonly reference: MinWindow;

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private nextPingId = 1;
  private readonly pending = new Map<number, number>();
  private readonly clock: ClockSample[] = [];
  private offsetUs: number | null = null;
  private rttUs: number | null = null;

  private latest: FrameObservation | null = null;
  private lastFrameId: number | null = null;
  private lastSentFrameId: number | null = null;
  private windowRiseUs: number | null = null;
  private delayRiseUs: number | null = null;

  private readonly stats = {
    reports: 0,
    fbSent: 0,
    statsSent: 0,
    pingsSent: 0,
    pongsMatched: 0,
    pongsUnmatched: 0,
    pingsAbandoned: 0,
    framesObserved: 0,
    framesDropped: 0,
    arrivalFallbacks: 0,
    statsSuppressed: 0,
  };

  constructor(options: SwoopFeedbackOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.reportIntervalMs = options.reportIntervalMs ?? REPORT_INTERVAL_MS;
    this.reference = new MinWindow(options.referenceWindowMs ?? REFERENCE_WINDOW_MS);
  }

  /** start reporting. the first ping goes immediately, so the first `stats` a
   * second later already has a measured round trip to carry. */
  start(): void {
    if (this.timer !== null) return;
    this.sendPing();
    this.timer = setInterval(() => this.tick(), this.reportIntervalMs);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** one presented frame, straight from `SwoopReceiver`'s `onFrame`. */
  observeFrame(frame: FrameObservation): void {
    this.stats.framesObserved += 1;
    if (this.lastFrameId !== null && frame.frameId > this.lastFrameId) {
      this.stats.framesDropped += frame.frameId - this.lastFrameId - 1;
    }
    // a frame id that went backwards is the counter wrapping at 2³² or a new
    // track; neither is a drop, so the sequence just restarts here.
    this.lastFrameId = frame.frameId;
    this.latest = frame;

    const arrival = arrivalUs(frame);
    if (arrival.fallback) this.stats.arrivalFallbacks += 1;
    // no clock offset on purpose: it is a constant in this subtraction and
    // cancels, so a re-latched offset cannot move the reference.
    const owdUs = arrival.us - frame.tSendUs;
    const atMs = arrival.us / 1000;
    this.reference.push(atMs, owdUs);
    const best = this.reference.min();
    const rise = best === null ? 0 : owdUs - best;
    this.delayRiseUs = rise;
    this.windowRiseUs = this.windowRiseUs === null ? rise : Math.max(this.windowRiseUs, rise);
  }

  /** one message off `swoop-feedback`. only `pong` is ours to act on. */
  handleMessage(raw: unknown): void {
    const decoded = decodeFeedbackMessage(raw);
    if (!decoded.ok || decoded.value.t !== 'pong') return;
    const { id, hostUs } = decoded.value;
    const sentMs = this.pending.get(id);
    if (sentMs === undefined) {
      this.stats.pongsUnmatched += 1;
      return;
    }
    // the echoed `tUs` is never trusted for the arithmetic — a host that
    // shaded it would shade every latency number the overlay shows. the
    // locally recorded send time is the one that counts.
    this.pending.delete(id);
    const rttUs = Math.max(0, usFromMs(this.now() - sentMs));
    this.stats.pongsMatched += 1;
    this.record({ rttUs, offsetUs: hostUs - (usFromMs(sentMs) + Math.round(rttUs / 2)) });
  }

  diagnostics(): SwoopFeedbackDiagnostics {
    return {
      ...this.stats,
      clockOffsetUs: this.offsetUs,
      rttUs: this.rttUs,
      delayRiseUs: this.delayRiseUs,
      referenceMinUs: this.reference.min(),
      referenceSamples: this.reference.size,
    };
  }

  private record(sample: ClockSample): void {
    this.clock.push(sample);
    if (this.clock.length > CLOCK_SAMPLES) this.clock.shift();
    const best = this.clock.reduce((a, b) => (b.rttUs < a.rttUs ? b : a));
    this.rttUs = best.rttUs;
    if (this.offsetUs === null || Math.abs(best.offsetUs - this.offsetUs) >= OFFSET_LATCH_US) {
      this.offsetUs = best.offsetUs;
    }
  }

  private tick(): void {
    this.ticks += 1;
    this.stats.reports += 1;
    this.sendFb();
    // §5 puts `stats` on a one-second cadence, so it rides every other tick.
    if (this.ticks % 2 === 0) {
      this.sendPing();
      this.sendStats();
    }
  }

  private sendFb(): void {
    const frame = this.latest;
    // nothing new presented since the last report: re-sending the same frame's
    // stamps would give the host a second delay sample it did not measure.
    if (frame === null || frame.frameId === this.lastSentFrameId) return;
    this.lastSentFrameId = frame.frameId;
    const arrival = arrivalUs(frame);
    // `decodeMs` is the decoder's processing duration, so the instant it
    // finished is arrival plus that; with no duration reported the two stamps
    // collapse rather than inventing one.
    const decodeUs = frame.decodeMs === null ? arrival.us : arrival.us + usFromMs(frame.decodeMs);
    this.stats.fbSent += 1;
    this.options.send(
      encodeFeedbackMessage({
        t: 'fb',
        frameId: frame.frameId,
        tArrivalUs: arrival.us,
        tDecodeUs: decodeUs,
        tPresentUs: usFromMs(frame.presentedMs),
        clockOffsetUs: this.offsetUs ?? 0,
      }),
    );
  }

  private sendStats(): void {
    if (this.rttUs === null) {
      this.stats.statsSuppressed += 1;
      return;
    }
    const viewport = this.options.viewport();
    const rise = this.windowRiseUs ?? 0;
    this.windowRiseUs = null;
    this.stats.statsSent += 1;
    this.options.send(
      encodeFeedbackMessage({
        t: 'stats',
        // arm B renders on a media track: the `<video>` element owns the
        // decode queue and there is no app-level one to report.
        decodeQueue: 0,
        framesDropped: this.stats.framesDropped,
        // variation in one-way delay, which is what jitter is — not
        // `RTCInboundRtpStreamStats.jitter`, which needs a `getStats` handle
        // this module does not have. the field is integer milliseconds, so a
        // sub-millisecond lan figure rounds to zero here and survives in full
        // in `diagnostics()`.
        jitterMs: Math.round(rise / 1000),
        rttMs: Math.round(this.rttUs / 1000),
        widthCss: Math.round(viewport.widthCss),
        heightCss: Math.round(viewport.heightCss),
      }),
    );
  }

  private sendPing(): void {
    while (this.pending.size >= PENDING_PINGS) {
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      this.pending.delete(oldest.value);
      this.stats.pingsAbandoned += 1;
    }
    const id = this.nextPingId++;
    const sentMs = this.now();
    this.pending.set(id, sentMs);
    this.stats.pingsSent += 1;
    this.options.send(encodeFeedbackMessage({ t: 'ping', id, tUs: usFromMs(sentMs) }));
  }
}

export const createSwoopFeedback = (options: SwoopFeedbackOptions): SwoopFeedback =>
  new SwoopFeedback(options);
