/**
 * the viewer's `swoop-feedback` reports. what is under test is the cadence §5
 * fixes, the ntp-style clock exchange, and the one rule the parsec web client
 * breaks — never report a latency that was not measured.
 */

import { SwoopFeedback } from '@/lib/swoop/feedback';

import type { FeedbackMessage } from '@/lib/swoop/protocol';
import type { FrameObservation } from '@/lib/swoop/video/receiver';

/** one-way delay of the synthetic path, and the host clock's head start. */
const ONE_WAY_MS = 8;
const SKEW_US = 7_000_000;
const TICK_MS = 500;

interface Harness {
  feedback: SwoopFeedback;
  sent: FeedbackMessage[];
  /** advance the injected clock and the timers together. */
  advance: (ms: number) => void;
  /**
   * answer the newest outstanding ping as a host `ONE_WAY_MS` away would, with
   * the return leg optionally queued so the two halves are not symmetric.
   */
  answerPings: (returnMs?: number) => void;
  frame: (overrides?: Partial<FrameObservation>) => FrameObservation;
}

function harness(): Harness {
  let clock = 1_000;
  const sent: FeedbackMessage[] = [];
  const feedback = new SwoopFeedback({
    send: (payload) => sent.push(JSON.parse(payload) as FeedbackMessage),
    viewport: () => ({ widthCss: 1920, heightCss: 1080 }),
    now: () => clock,
    reportIntervalMs: TICK_MS,
  });

  let answered = 0;
  let nextFrameId = 1;
  return {
    feedback,
    sent,
    advance: (ms) => {
      // in whole ticks, so the injected clock reads the tick's own time.
      for (let left = ms; left > 0; left -= TICK_MS) {
        const step = Math.min(TICK_MS, left);
        clock += step;
        jest.advanceTimersByTime(step);
      }
    },
    answerPings: (returnMs = ONE_WAY_MS) => {
      const pings = sent.filter((m): m is Extract<FeedbackMessage, { t: 'ping' }> => m.t === 'ping');
      const outstanding = pings.slice(answered);
      answered = pings.length;
      const ping = outstanding[outstanding.length - 1];
      if (ping === undefined) return;
      clock += ONE_WAY_MS + returnMs;
      feedback.handleMessage(
        JSON.stringify({
          t: 'pong',
          id: ping.id,
          tUs: ping.tUs,
          // the host stamps it when the ping actually reached it: the outbound
          // leg is always `ONE_WAY_MS`, whatever the return leg does.
          hostUs: ping.tUs + ONE_WAY_MS * 1000 + SKEW_US,
        }),
      );
    },
    frame: (overrides = {}) => {
      const frameId = overrides.frameId ?? nextFrameId++;
      const tSendUs = 500_000 + frameId * 16_667;
      return {
        frameId,
        rtpTimestamp90k: frameId * 1500,
        irap: frameId === 1,
        codec: 'h264',
        width: 1920,
        height: 1080,
        tCaptureUs: tSendUs - 9_000,
        tEncodeUs: tSendUs - 1_000,
        tSendUs,
        arrivalMs: (tSendUs + 20_000 - SKEW_US) / 1000,
        decodeMs: 3,
        presentedMs: (tSendUs + 26_000 - SKEW_US) / 1000,
        expectedDisplayMs: (tSendUs + 32_000 - SKEW_US) / 1000,
        presentedFrames: frameId,
        ...overrides,
      };
    },
  };
}

const of = <T extends FeedbackMessage['t']>(
  sent: FeedbackMessage[],
  t: T,
): Extract<FeedbackMessage, { t: T }>[] =>
  sent.filter((m): m is Extract<FeedbackMessage, { t: T }> => m.t === t);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('swoop feedback reports', () => {
  it('reports at 2 hz and puts stats and ping on the one-second cadence', () => {
    const h = harness();
    h.feedback.start();
    h.answerPings();

    for (let i = 0; i < 4; i += 1) {
      h.feedback.observeFrame(h.frame());
      h.advance(TICK_MS);
      h.answerPings();
    }

    expect(of(h.sent, 'fb')).toHaveLength(4);
    expect(of(h.sent, 'stats')).toHaveLength(2);
    // one at start(), then one per second.
    expect(of(h.sent, 'ping')).toHaveLength(3);
    h.feedback.stop();
    h.advance(2_000);
    expect(of(h.sent, 'fb')).toHaveLength(4);
  });

  it('does not re-send a frame whose stamps the host already has', () => {
    const h = harness();
    h.feedback.start();
    h.feedback.observeFrame(h.frame());
    h.advance(TICK_MS * 3);
    expect(of(h.sent, 'fb')).toHaveLength(1);
  });

  it('converges on a synthetic clock skew and is not moved by a queued sample', () => {
    const h = harness();
    h.feedback.start();
    h.answerPings();
    expect(h.feedback.diagnostics().clockOffsetUs).toBe(SKEW_US);

    // a pong that queued 192 ms on the way back: half of that asymmetry lands
    // straight in its offset, and the lowest-rtt sample has to win anyway.
    h.advance(TICK_MS * 2);
    h.answerPings(192);
    h.advance(TICK_MS * 2);
    h.answerPings();
    expect(h.feedback.diagnostics().clockOffsetUs).toBe(SKEW_US);
  });

  it('measures the round trip and never reports one it has not measured', () => {
    const h = harness();
    h.feedback.start();
    h.advance(TICK_MS * 2);
    expect(of(h.sent, 'stats')).toHaveLength(0);
    expect(h.feedback.diagnostics().statsSuppressed).toBe(1);
    expect(h.feedback.diagnostics().rttUs).toBeNull();

    h.answerPings();
    h.advance(TICK_MS * 2);
    const stats = of(h.sent, 'stats');
    expect(stats).toHaveLength(1);
    expect(stats[0].rttMs).toBe(ONE_WAY_MS * 2);
    expect(h.feedback.diagnostics().rttUs).toBe(ONE_WAY_MS * 2_000);
  });

  it('takes the round trip from its own send time, not the host’s echo', () => {
    const h = harness();
    h.feedback.start();
    const ping = of(h.sent, 'ping')[0];
    h.advance(TICK_MS);
    // the host echoes a `tUs` 5 seconds in the past to inflate the round trip.
    h.feedback.handleMessage(
      JSON.stringify({
        t: 'pong',
        id: ping.id,
        tUs: ping.tUs - 5_000_000,
        hostUs: ping.tUs + TICK_MS * 500 + SKEW_US,
      }),
    );
    expect(h.feedback.diagnostics().rttUs).toBe(TICK_MS * 1000);
    expect(h.feedback.diagnostics().clockOffsetUs).toBe(SKEW_US);
  });

  it('counts a pong it never asked for instead of applying it', () => {
    const h = harness();
    h.feedback.start();
    h.feedback.handleMessage(JSON.stringify({ t: 'pong', id: 999, tUs: 1, hostUs: 2 }));
    h.feedback.handleMessage('not json at all');
    expect(h.feedback.diagnostics().pongsUnmatched).toBe(1);
    expect(h.feedback.diagnostics().clockOffsetUs).toBeNull();
  });

  it('carries the frame stamps and the latched offset in fb', () => {
    const h = harness();
    h.feedback.start();
    h.answerPings();
    const frame = h.frame();
    h.feedback.observeFrame(frame);
    h.advance(TICK_MS);

    const [fb] = of(h.sent, 'fb');
    expect(fb.frameId).toBe(frame.frameId);
    expect(fb.tArrivalUs).toBe(Math.round(frame.arrivalMs! * 1000));
    expect(fb.tDecodeUs).toBe(fb.tArrivalUs + 3_000);
    expect(fb.tPresentUs).toBe(Math.round(frame.presentedMs * 1000));
    expect(fb.clockOffsetUs).toBe(SKEW_US);
    // the host adds the offset back to reach its own epoch, and lands on the
    // 20 ms of one-way delay the fixture built in.
    expect(fb.tArrivalUs + fb.clockOffsetUs - frame.tSendUs).toBe(20_000);
  });

  it('counts frame ids the host sent and the viewer never presented', () => {
    const h = harness();
    h.feedback.start();
    h.answerPings();
    h.feedback.observeFrame(h.frame({ frameId: 10 }));
    h.feedback.observeFrame(h.frame({ frameId: 14 }));
    h.advance(TICK_MS * 2);
    expect(h.feedback.diagnostics().framesDropped).toBe(3);
    expect(of(h.sent, 'stats')[0].framesDropped).toBe(3);
  });

  it('measures the delay rise against the best of the window, offset and all', () => {
    const h = harness();
    h.feedback.start();
    h.answerPings();
    const base = h.frame({ frameId: 1 });
    h.feedback.observeFrame(base);
    expect(h.feedback.diagnostics().delayRiseUs).toBe(0);

    const late = h.frame({ frameId: 2 });
    h.feedback.observeFrame({ ...late, arrivalMs: late.arrivalMs! + 40 });
    expect(h.feedback.diagnostics().delayRiseUs).toBe(40_000);
    h.advance(TICK_MS * 2);
    expect(of(h.sent, 'stats')[0].jitterMs).toBe(40);

    // back to the reference: the rise goes away, the reference does not move.
    h.feedback.observeFrame(h.frame({ frameId: 3 }));
    expect(h.feedback.diagnostics().delayRiseUs).toBe(0);
    // the reference itself is the 20 ms of path delay plus the whole clock
    // skew, because no offset is applied to it — which is the point: only
    // differences against it mean anything.
    expect(h.feedback.diagnostics().referenceMinUs).toBe(20_000 - SKEW_US);
  });

  it('falls back to the presentation time when the ua reports no arrival', () => {
    const h = harness();
    h.feedback.start();
    h.answerPings();
    const frame = h.frame({ arrivalMs: null, decodeMs: null });
    h.feedback.observeFrame(frame);
    h.advance(TICK_MS);

    const [fb] = of(h.sent, 'fb');
    expect(fb.tArrivalUs).toBe(Math.round(frame.presentedMs * 1000));
    expect(fb.tDecodeUs).toBe(fb.tArrivalUs);
    expect(h.feedback.diagnostics().arrivalFallbacks).toBe(1);
  });
});
