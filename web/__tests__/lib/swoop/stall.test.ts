/**
 * the frozen-picture watchdog, tick by tick. the clock is the test's, so every
 * window below is real elapsed time and never a count of ticks.
 */

import {
  classifyStall,
  createStallDetector,
  pickInboundVideoStats,
  type StallSample,
  type StallTick,
} from '@/lib/swoop/video/stall';

/** one detector on a hand-driven clock, fed a picture tick by tick. */
function harness() {
  let at = 0;
  const detector = createStallDetector(() => at);
  const counters = { hostFrames: 0, totalFrames: 0, droppedFrames: 0, rvfcCallbacks: 0 as number | null };
  return {
    detector,
    /** one second later: the host sent `sent`, the element showed `shown`. */
    tick(
      sent: number,
      shown: number,
      options: { gated?: boolean; rvfc?: boolean; ms?: number; dropped?: number } = {},
    ): StallTick {
      at += options.ms ?? 1000;
      counters.hostFrames += sent;
      counters.totalFrames += shown + (options.dropped ?? 0);
      counters.droppedFrames += options.dropped ?? 0;
      if (options.rvfc !== false && counters.rvfcCallbacks !== null) counters.rvfcCallbacks += shown;
      const sample: StallSample = { ...counters, gated: options.gated ?? true };
      return detector.tick(sample);
    },
    noRvfc() {
      counters.rvfcCallbacks = null;
    },
  };
}

/** the first gated tick and the two seconds after it only settle. */
function settled() {
  const h = harness();
  h.tick(60, 60);
  h.tick(60, 60);
  h.tick(60, 60);
  return h;
}

describe('swoop stall watchdog', () => {
  it('never fires on a still desktop: the host floor is two frames a second and each is shown', () => {
    const h = settled();
    for (let i = 0; i < 120; i += 1) {
      expect(h.tick(2, 2).change).toBeNull();
    }
  });

  it('declares a picture that shows nothing while the host sends, three seconds in', () => {
    const h = settled();
    expect(h.tick(60, 0).change).toBe('suspect');
    expect(h.tick(60, 0).change).toBeNull();
    const declared = h.tick(60, 0);
    expect(declared.change).toBe('stalled');
    expect(declared.phase).toBe('stalled');
    expect(declared.evidence).toEqual({ windowMs: 3000, hostFrames: 180 });
  });

  it('judges by elapsed time, not ticks: one late tick does not stretch a window', () => {
    const h = settled();
    expect(h.tick(10, 0, { ms: 400 }).change).toBe('suspect');
    expect(h.tick(10, 0, { ms: 400 }).change).toBeNull();
    // three ticks in, but only 1.2 s of window: not yet.
    expect(h.tick(10, 0, { ms: 400 }).change).toBeNull();
    expect(h.tick(10, 0, { ms: 1900 }).change).toBe('stalled');
  });

  it('needs the host to have sent at least four frames in the window', () => {
    const h = settled();
    expect(h.tick(1, 0).change).toBe('suspect');
    expect(h.tick(1, 0).change).toBeNull();
    // three seconds, but only three frames.
    expect(h.tick(1, 0).change).toBeNull();
    expect(h.tick(1, 0).change).toBe('stalled');
  });

  it('drops a suspicion on a second the host sent nothing: capture paused, the picture did not die', () => {
    const h = settled();
    expect(h.tick(60, 0).change).toBe('suspect');
    expect(h.tick(60, 0).change).toBeNull();
    // a uac prompt or a display switch re-duplicating the desktop.
    expect(h.tick(0, 0)).toMatchObject({ phase: 'ok', change: 'cleared' });
    // a new window opens where the pause ended, and runs its full three seconds.
    expect(h.tick(60, 0).change).toBe('suspect');
    expect(h.tick(60, 0).change).toBeNull();
    expect(h.tick(60, 0)).toMatchObject({ change: 'stalled', evidence: { windowMs: 3000, hostFrames: 180 } });
  });

  it('drops a suspicion the moment the window shows a frame', () => {
    const h = settled();
    expect(h.tick(60, 0).change).toBe('suspect');
    expect(h.tick(60, 1).change).toBe('cleared');
    expect(h.tick(60, 0).change).toBe('suspect');
  });

  it('never fires in a hidden tab, and starts over with a settle when it is back', () => {
    const h = settled();
    expect(h.tick(60, 0).change).toBe('suspect');
    for (let i = 0; i < 10; i += 1) {
      expect(h.tick(60, 0, { gated: false })).toMatchObject({ phase: 'ok', change: null });
    }
    // visible again: a fresh baseline and two seconds of settle before anything is judged.
    expect(h.tick(60, 0).change).toBeNull();
    expect(h.tick(60, 0).change).toBeNull();
    expect(h.tick(60, 0).change).toBe('suspect');
  });

  it('starts over after a reset, as on a resize or a reattached track', () => {
    const h = settled();
    h.tick(60, 0);
    h.tick(60, 0);
    h.detector.reset();
    expect(h.tick(60, 0).change).toBeNull();
    expect(h.tick(60, 0).change).toBeNull();
    expect(h.tick(60, 0).change).toBe('suspect');
  });

  it('treats element counters that went backwards as a reload, not as evidence', () => {
    const h = settled();
    h.tick(60, 0);
    // a reattached element counts from zero again.
    const reloaded = h.detector.tick({ hostFrames: 1000, totalFrames: 0, droppedFrames: 0, rvfcCallbacks: 0, gated: true });
    expect(reloaded).toMatchObject({ phase: 'ok', change: null });
  });

  it('treats a long gap between ticks as a discontinuity', () => {
    const h = settled();
    expect(h.tick(60, 0).change).toBe('suspect');
    expect(h.tick(600, 0, { ms: 10_000 })).toMatchObject({ phase: 'ok', change: null });
  });

  it('clears a declared stall after two good ticks, and not after one', () => {
    const h = settled();
    h.tick(60, 0);
    h.tick(60, 0);
    expect(h.tick(60, 0).change).toBe('stalled');
    expect(h.tick(60, 30).change).toBeNull();
    expect(h.tick(60, 0).change).toBeNull();
    expect(h.tick(60, 30).change).toBeNull();
    const cleared = h.tick(60, 30);
    expect(cleared).toMatchObject({ phase: 'ok', change: 'cleared' });
  });

  it('a picture that is shown while rvfc stays silent is not a stall, only a chain to re-arm', () => {
    const h = settled();
    for (let i = 0; i < 6; i += 1) {
      expect(h.tick(60, 60, { rvfc: false })).toMatchObject({ phase: 'ok', change: null, rvfcSilent: true });
    }
  });

  it('says nothing about rvfc on a browser that has none', () => {
    const h = harness();
    h.noRvfc();
    h.tick(60, 60);
    h.tick(60, 60);
    h.tick(60, 60);
    expect(h.tick(60, 60).rvfcSilent).toBe(false);
  });

  it('counts frames the element dropped as not shown', () => {
    const h = settled();
    expect(h.tick(60, 0, { dropped: 60 }).change).toBe('suspect');
  });
});

describe('swoop stall classification', () => {
  it('reads nothing arriving, arriving undecoded, and decoded but unseen', () => {
    const before = { framesReceived: 100, framesDecoded: 100, packetsReceived: 1000 };
    expect(classifyStall(before, { ...before })).toBe('nothing');
    expect(classifyStall(before, { ...before, framesReceived: 280 })).toBe('decode');
    expect(classifyStall(before, { ...before, framesReceived: 280, framesDecoded: 280 })).toBe('render');
  });

  it('falls back to packets when the browser has no frame count, and reads no stats as nothing', () => {
    expect(classifyStall({ packetsReceived: 10 }, { packetsReceived: 90 })).toBe('decode');
    expect(classifyStall(null, { framesReceived: 9 })).toBe('nothing');
    expect(classifyStall(null, null)).toBe('nothing');
  });
});

describe('swoop stall stats snapshot', () => {
  const report = (entries: Record<string, unknown>) =>
    new Map(Object.entries(entries)) as unknown as RTCStatsReport;

  it('keeps the allow-listed inbound video counters and the codec, and nothing else', () => {
    const picked = pickInboundVideoStats(
      report({
        IT01V: {
          type: 'inbound-rtp',
          kind: 'video',
          id: 'IT01V',
          ssrc: 1234,
          transportId: 'T01',
          codecId: 'CIT01_104',
          packetsReceived: 5000,
          framesReceived: 900,
          framesDecoded: 880,
          pliCount: 2,
          framesPerSecond: 59.9,
          decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)',
          trackIdentifier: 'track-1',
          remoteId: 'ROA1',
        },
        IT01A: { type: 'inbound-rtp', kind: 'audio', packetsReceived: 77 },
        CIT01_104: { type: 'codec', mimeType: 'video/H265', payloadType: 104 },
        CPa: { type: 'candidate-pair', localCandidateId: 'L1' },
        L1: { type: 'local-candidate', address: '192.168.1.20', candidateType: 'host' },
      }),
    );
    expect(picked).toEqual({
      packetsReceived: 5000,
      framesReceived: 900,
      framesDecoded: 880,
      pliCount: 2,
      framesPerSecond: 59.9,
      decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)',
      codecMimeType: 'video/H265',
    });
  });

  it('is null for a report with no inbound video', () => {
    expect(pickInboundVideoStats(report({ IT01A: { type: 'inbound-rtp', kind: 'audio' } }))).toBeNull();
  });
});
