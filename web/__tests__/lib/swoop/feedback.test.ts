/**
 * the viewer's `swoop-feedback` reports. what is under test is the cadence §5
 * fixes, the ntp-style clock exchange, and the one rule the parsec web client
 * breaks — never report a latency that was not measured.
 */

import { PONG_SILENCE_MS, SwoopFeedback } from '@/lib/swoop/feedback';

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

function harness(
  onSilence?: () => void,
  linkUp?: () => boolean,
  framesDecoded?: () => Promise<number | null>,
): Harness {
  let clock = 1_000;
  const sent: FeedbackMessage[] = [];
  const feedback = new SwoopFeedback({
    send: (payload) => sent.push(JSON.parse(payload) as FeedbackMessage),
    viewport: () => ({ widthCss: 1920, heightCss: 1080 }),
    now: () => clock,
    reportIntervalMs: TICK_MS,
    onSilence,
    linkUp,
    framesDecoded,
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

/** let the stats reads the timers started settle. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

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

  it('reports a host that answered pings and then went silent, once per silence', () => {
    const silences = jest.fn();
    const h = harness(silences);
    h.feedback.start();
    h.answerPings();
    h.advance(PONG_SILENCE_MS - TICK_MS);
    expect(silences).not.toHaveBeenCalled();
    h.advance(TICK_MS);
    expect(silences).toHaveBeenCalledTimes(1);
    expect(h.feedback.diagnostics().silences).toBe(1);
    // re-armed: the next report is a full window later, not every tick.
    h.advance(TICK_MS);
    expect(silences).toHaveBeenCalledTimes(1);
    h.advance(PONG_SILENCE_MS);
    expect(silences).toHaveBeenCalledTimes(2);
  });

  it('never calls a host silent before it has answered at all', () => {
    const silences = jest.fn();
    const h = harness(silences);
    h.feedback.start();
    // a channel that has not opened yet answers nothing; that is the peer's
    // connect path to judge, not this loop's.
    h.advance(PONG_SILENCE_MS * 3);
    expect(silences).not.toHaveBeenCalled();
    expect(h.feedback.diagnostics().silences).toBe(0);
  });

  it('is not silence while pongs keep coming, however lossy the path', () => {
    const silences = jest.fn();
    const h = harness(silences);
    h.feedback.start();
    h.answerPings();
    // one answer per window is enough to be alive.
    for (let i = 0; i < 4; i += 1) {
      h.advance(PONG_SILENCE_MS - TICK_MS);
      h.answerPings();
    }
    expect(silences).not.toHaveBeenCalled();
  });

  it('does not call a host silent while the link under the channel is down', () => {
    const silences = jest.fn();
    let up = true;
    const h = harness(silences, () => up);
    h.feedback.start();
    h.answerPings();

    // the path dropped: the peer's restart ladder owns that, however long.
    up = false;
    h.advance(PONG_SILENCE_MS * 3);
    expect(silences).not.toHaveBeenCalled();
  });

  it('counts the silence from the moment the link comes back', () => {
    const silences = jest.fn();
    let up = true;
    const h = harness(silences, () => up);
    h.feedback.start();
    h.answerPings();
    up = false;
    h.advance(PONG_SILENCE_MS * 3);

    // the first tick that sees the link up starts the clock again.
    up = true;
    h.advance(TICK_MS);
    h.advance(PONG_SILENCE_MS - TICK_MS);
    expect(silences).not.toHaveBeenCalled();
    h.advance(TICK_MS);
    expect(silences).toHaveBeenCalledTimes(1);
  });

  it('still calls a dead channel on a live link silent at the same mark', () => {
    const silences = jest.fn();
    const h = harness(silences, () => true);
    h.feedback.start();
    h.answerPings();
    h.advance(PONG_SILENCE_MS - TICK_MS);
    expect(silences).not.toHaveBeenCalled();
    h.advance(TICK_MS);
    expect(silences).toHaveBeenCalledTimes(1);
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

  // TEC-B4A, 2026-10-13: a 60 fps picture on a 60 hz screen leaves frames
  // decoded and never painted, the viewer reported each one dropped, and the
  // host cut 20% every two seconds on a wired lan with nothing lost.
  describe('with the decoder count', () => {
    /** paint `ids` in order, then let one stats read land. */
    async function paint(h: Harness, ids: number[]): Promise<void> {
      for (const frameId of ids) h.feedback.observeFrame(h.frame({ frameId }));
      h.advance(TICK_MS * 2);
      await flush();
    }

    it('does not count a frame decoded and never painted as dropped', async () => {
      let decoded = 100;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [10]);
      // 11 to 13 decoded and skipped by the compositor, 14 painted
      decoded += 4;
      await paint(h, [14]);
      expect(h.feedback.diagnostics().framesDropped).toBe(0);
    });

    it('counts frames never decoded beyond the decoder lead', async () => {
      let decoded = 100;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [10]);
      // 11 to 18 lost, 19 and 20 decoded
      decoded += 2;
      await paint(h, [20]);
      expect(h.feedback.diagnostics().framesDropped).toBe(8 - 3);
      h.advance(TICK_MS * 2);
      expect(of(h.sent, 'stats').at(-1)?.framesDropped).toBe(5);
    });

    it('does not latch frames decoded ahead of the paint at the base as dropped', async () => {
      let decoded = 103;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      // painted 10 while 11 to 13 are already decoded
      await paint(h, [10]);
      decoded += 57;
      await paint(h, [70]);
      expect(h.feedback.diagnostics().framesDropped).toBe(0);
    });

    // a frame-rate or resolution move opens a new encoder, whose ids start at
    // zero; the decoder's count runs straight through it.
    it('keeps counting losses after a new encoder starts its ids again', async () => {
      let decoded = 30;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [30]);
      decoded += 1770;
      await paint(h, [1800]);
      // the new encoder's 0 to 45, all decoded
      decoded += 46;
      await paint(h, [45]);
      // then 20 lost and one decoded
      decoded += 1;
      await paint(h, [66]);
      expect(h.feedback.diagnostics().framesDropped).toBe(20 - 3);
    });

    it('does not count a small step back in the ids as loss', async () => {
      let decoded = 100;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [500]);
      await paint(h, [499]);
      decoded += 10;
      await paint(h, [509]);
      expect(h.feedback.diagnostics().framesDropped).toBe(0);
    });

    // a hidden tab or a minimised window stops the paint, not the decoder: the
    // old encoder ran on to 1000 and a new one to 300 before a frame was painted
    it('keeps counting after a new encoder it never saw start, behind a stalled paint', async () => {
      let decoded = 100;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [100]);
      decoded += 900 + 301;
      await paint(h, [300]);
      // then 30 lost and one decoded
      decoded += 1;
      await paint(h, [331]);
      expect(h.feedback.diagnostics().framesDropped).toBe(30 - 3);
    });

    it('does not let rebuilds with skipped tails hide later losses', async () => {
      let decoded = 100;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [10]);
      for (let rebuild = 0; rebuild < 5; rebuild++) {
        // the old run's last two decoded and never painted, then the new run
        decoded += 2 + 11;
        await paint(h, [5, 10]);
      }
      // then 6 lost and one decoded
      decoded += 1;
      await paint(h, [17]);
      expect(h.feedback.diagnostics().framesDropped).toBe(6 - 3);
    });

    it('keeps what it counted when the decoder count starts over', async () => {
      let decoded = 100;
      const h = harness(undefined, undefined, async () => decoded);
      h.feedback.start();
      h.answerPings();
      await paint(h, [10]);
      decoded += 2;
      await paint(h, [20]);
      expect(h.feedback.diagnostics().framesDropped).toBe(5);

      // a new receiver: its count starts over, and that read is its base
      decoded = 1;
      await paint(h, [21]);
      decoded += 1;
      await paint(h, [30]);
      expect(h.feedback.diagnostics().framesDropped).toBe(5 + 8 - 3);
    });
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
