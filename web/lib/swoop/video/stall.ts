/**
 * a picture that froze while everything under it kept working.
 *
 * b4a, 2026-10-07: chrome's hevc hardware decoder took one decode error and,
 * with no software fallback for h.265, went quiet for good — behind a decoder
 * that answers ok, so chrome stopped asking the host for keyframes. the
 * transport stayed healthy (sctp acks, lease renewals, the host sending), so
 * nothing that watches the transport noticed, and the picture sat on one frame
 * for three minutes until a reload.
 *
 * this file notices. it is a pure state machine, fed once a second by the
 * hook's stats timer with counters it gets for free: the host's frame records
 * on `swoop-meta` (what was sent), the element's `getVideoPlaybackQuality()`
 * totals (what was shown) and the raw rvfc callback count. the host sends at
 * least two frames a second even on a still desktop (`FLOOR_INTERVAL` in
 * `agent/swoop/src/session/mod.rs`), so frames sent and none shown is a dead
 * picture, never a still one.
 *
 * deliberately not inputs: the presenter's and feedback's counters (both hang
 * off the meta join, which a stall starves too), `freezeCount`,
 * `video.currentTime` and transport bytes.
 *
 * time is real elapsed time from `now`, never a count of ticks: a timer that
 * fired late must not make a short window look long.
 */

/** where a frozen picture died: before the decoder, in it, or after it. */
export type StallKind = 'decode' | 'render' | 'nothing';
export const STALL_KINDS: readonly StallKind[] = ['decode', 'render', 'nothing'];

/** what the page did about a stall: reattach the element, start a new session, or nothing more (the cap). */
export type StallAction = 'reattach' | 'reconnect' | 'none';
export const STALL_ACTIONS: readonly StallAction[] = ['reattach', 'reconnect', 'none'];

export type StallPhase = 'ok' | 'suspect' | 'stalled';

/** a fresh baseline only settles for this long before it is judged. */
export const STALL_SETTLE_MS = 2000;
/** how long the host must be heard sending into a dead picture before it is declared. */
export const STALL_DECLARE_MS = 3000;
/** and how many frames it must have sent in that time. */
export const STALL_DECLARE_HOST_FRAMES = 4;
/** consecutive good ticks that end a declared stall. */
export const STALL_CLEAR_TICKS = 2;
/**
 * a gap longer than this between two ticks is a discontinuity, not evidence:
 * a machine that slept or a tab the browser froze.
 */
const MAX_TICK_GAP_MS = 5000;

export interface StallSample {
  /** `receiver.diagnostics().metaRecords`: frame records the host sent. */
  hostFrames: number;
  /** `getVideoPlaybackQuality()`: frames that reached the element, and the ones it dropped. */
  totalFrames: number;
  droppedFrames: number;
  /** raw rvfc callbacks; null where the browser has none. */
  rvfcCallbacks: number | null;
  /** connected, link up, tab visible, playing, data in hand and a box on screen. */
  gated: boolean;
}

export interface StallTick {
  phase: StallPhase;
  /** set on the tick the phase changed. */
  change: 'suspect' | 'stalled' | 'cleared' | null;
  /** frames were shown but rvfc never fired: the callback chain died, not the picture. */
  rvfcSilent: boolean;
  /** on `stalled` only: how long the picture was dead, and what the host sent meanwhile. */
  evidence: { windowMs: number; hostFrames: number } | null;
}

export interface StallDetector {
  tick(sample: StallSample): StallTick;
  /** forget the baseline: the next `STALL_SETTLE_MS` of gated ticks only settle. */
  reset(): void;
}

interface Point {
  at: number;
  hostFrames: number;
  total: number;
  dropped: number;
  rvfc: number | null;
}

const shownBetween = (from: Point, to: Point): number => to.total - from.total - (to.dropped - from.dropped);

export function createStallDetector(now: () => number = () => performance.now()): StallDetector {
  let last: Point | null = null;
  let settleUntil = 0;
  let phase: StallPhase = 'ok';
  // the sample the suspicion window opened on.
  let origin: Point | null = null;
  let goodTicks = 0;

  const reset = () => {
    last = null;
    origin = null;
    goodTicks = 0;
    phase = 'ok';
  };

  const result = (change: StallTick['change'], rvfcSilent = false, evidence: StallTick['evidence'] = null): StallTick => ({
    phase,
    change,
    rvfcSilent,
    evidence,
  });

  const tick = (sample: StallSample): StallTick => {
    if (!sample.gated) {
      reset();
      return result(null);
    }
    const point: Point = {
      at: now(),
      hostFrames: sample.hostFrames,
      total: sample.totalFrames,
      dropped: sample.droppedFrames,
      rvfc: sample.rvfcCallbacks,
    };
    const previous = last;
    // a fresh baseline: the first gated tick, or a discontinuity. a counter
    // that went backwards is an element that reloaded (a reattach), so its
    // numbers start again and so does the judgement.
    if (
      previous === null ||
      point.at - previous.at > MAX_TICK_GAP_MS ||
      point.total < previous.total ||
      point.hostFrames < previous.hostFrames
    ) {
      reset();
      last = point;
      settleUntil = point.at + STALL_SETTLE_MS;
      return result(null);
    }
    last = point;
    if (point.at < settleUntil) return result(null);

    const hostDelta = point.hostFrames - previous.hostFrames;
    const shown = shownBetween(previous, point);
    const rvfcSilent = shown > 0 && point.rvfc !== null && previous.rvfc !== null && point.rvfc === previous.rvfc;

    if (phase === 'ok') {
      if (hostDelta >= 1 && shown <= 0) {
        phase = 'suspect';
        origin = previous;
        return result('suspect', rvfcSilent);
      }
      return result(null, rvfcSilent);
    }

    if (phase === 'suspect' && origin) {
      // a second with no host frame at all, under a two-a-second floor, is
      // capture paused (a uac prompt, a display switch), not a dead picture.
      if (hostDelta === 0 || shownBetween(origin, point) > 0) {
        phase = 'ok';
        origin = null;
        return result('cleared', rvfcSilent);
      }
      const windowMs = point.at - origin.at;
      const hostFrames = point.hostFrames - origin.hostFrames;
      if (windowMs >= STALL_DECLARE_MS && hostFrames >= STALL_DECLARE_HOST_FRAMES) {
        phase = 'stalled';
        goodTicks = 0;
        return result('stalled', rvfcSilent, { windowMs, hostFrames });
      }
      return result(null, rvfcSilent);
    }

    goodTicks = shown >= 1 ? goodTicks + 1 : 0;
    if (goodTicks >= STALL_CLEAR_TICKS) {
      phase = 'ok';
      origin = null;
      goodTicks = 0;
      return result('cleared', rvfcSilent);
    }
    return result(null, rvfcSilent);
  };

  return { tick, reset };
}

/**
 * the inbound-rtp video counters a stall report may carry. nothing else leaves
 * the browser: no candidate, no address, no id.
 */
export const INBOUND_VIDEO_COUNTERS = [
  'packetsReceived',
  'packetsLost',
  'nackCount',
  'pliCount',
  'firCount',
  'framesReceived',
  'jitterBufferEmittedCount',
  'framesDecoded',
  'keyFramesDecoded',
  'framesDropped',
  'framesPerSecond',
  'frameWidth',
  'frameHeight',
  'freezeCount',
  'pauseCount',
  'totalFreezesDuration',
  'totalPausesDuration',
] as const;

export type InboundVideoCounter = (typeof INBOUND_VIDEO_COUNTERS)[number];

export type InboundVideoStats = Partial<Record<InboundVideoCounter, number>> & {
  /** often withheld by the browser. */
  decoderImplementation?: string;
  /** the negotiated codec, through `codecId`: `video/H265`, `video/H264`. */
  codecMimeType?: string;
};

/** the two strings, bounded: they go into a log line. */
export const INBOUND_VIDEO_STRING_MAX = 64;

/** the video receiver's inbound-rtp entry, reduced to the allow-list; null when it has none. */
export function pickInboundVideoStats(report: RTCStatsReport): InboundVideoStats | null {
  let source: Record<string, unknown> | undefined;
  report.forEach((entry) => {
    const stat = entry as { type?: string; kind?: string };
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') source = entry as Record<string, unknown>;
  });
  if (!source) return null;
  const picked: InboundVideoStats = {};
  for (const counter of INBOUND_VIDEO_COUNTERS) {
    const value = source[counter];
    if (typeof value === 'number' && Number.isFinite(value)) picked[counter] = value;
  }
  const decoder = source.decoderImplementation;
  if (typeof decoder === 'string' && decoder) picked.decoderImplementation = decoder.slice(0, INBOUND_VIDEO_STRING_MAX);
  const codecId = source.codecId;
  const codec = typeof codecId === 'string' ? (report.get(codecId) as { mimeType?: unknown } | undefined) : undefined;
  if (typeof codec?.mimeType === 'string') picked.codecMimeType = codec.mimeType.slice(0, INBOUND_VIDEO_STRING_MAX);
  return picked;
}

const delta = (before: InboundVideoStats | null, after: InboundVideoStats | null, counter: InboundVideoCounter) => {
  const from = before?.[counter];
  const to = after?.[counter];
  return typeof from === 'number' && typeof to === 'number' ? to - from : null;
};

/**
 * where the picture died, from the receiver's own counters between suspicion
 * and declaration: nothing arrived, it arrived and was not decoded, or it was
 * decoded and never shown. no stats at all read as nothing arriving, the
 * case that recovers the same way.
 */
export function classifyStall(before: InboundVideoStats | null, after: InboundVideoStats | null): StallKind {
  const received = delta(before, after, 'framesReceived') ?? delta(before, after, 'packetsReceived');
  if (received === null || received <= 0) return 'nothing';
  const decoded = delta(before, after, 'framesDecoded');
  if (decoded === null || decoded <= 0) return 'decode';
  return 'render';
}

/** what the page posts to `…/swoop/sessions/{sid}/stall`, once per declared stall. */
export interface SwoopStallReport {
  viewerId: string;
  kind: StallKind;
  action: StallAction;
  /** the codec the host stamped on its frame records; null before the first one. */
  codec: 'h264' | 'hevc' | 'av1' | null;
  /** how long the picture was dead when it was declared. */
  stalledMs: number;
  /** frames the host sent into it meanwhile. */
  hostFrames: number;
  /** the receiver's counters where suspicion began, and at the declaration. */
  before: InboundVideoStats | null;
  after: InboundVideoStats | null;
}
