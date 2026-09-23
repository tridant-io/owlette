/**
 * @jest-environment jsdom
 */

// three of the done-when cases in task 3.12 are arm-A-only and have no honest
// test here: "the ImageBitmap fallback is used when `desynchronized` is
// unsupported" and "every frame is closed exactly once" describe a canvas and a
// `VideoFrame` that arm B has neither of, and "presentation happens on the
// decoder callback" describes a `VideoDecoder` that no longer exists in the
// shipping path. what survives of that first case — no rAF, and no canvas
// pipeline at all — is asserted below.

import { createPresenter } from '@/lib/swoop/video/presenter';
import type { FrameObservation } from '@/lib/swoop/video/receiver';

interface FakeVideo {
  element: HTMLVideoElement;
  /** every property this module wrote to the element. must stay empty. */
  writes: string[];
  resize(width: number, height: number): void;
}

function makeVideo(): FakeVideo {
  const listeners = new Map<string, EventListener[]>();
  const writes: string[] = [];
  const target = {
    videoWidth: 0,
    videoHeight: 0,
    srcObject: null,
    muted: false,
    playsInline: false,
    autoplay: false,
    play: jest.fn(async () => undefined),
    pause: jest.fn(),
    requestVideoFrameCallback: jest.fn(() => 1),
    cancelVideoFrameCallback: jest.fn(),
    addEventListener: (type: string, fn: EventListener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn));
    },
  };

  const element = new Proxy(target, {
    set(object, property, value) {
      writes.push(String(property));
      return Reflect.set(object, property, value);
    },
  });

  return {
    element: element as unknown as HTMLVideoElement,
    writes,
    resize(width, height) {
      // set behind the proxy: this is the browser reporting, not us writing.
      target.videoWidth = width;
      target.videoHeight = height;
      for (const listener of listeners.get('resize') ?? []) listener(new Event('resize'));
    },
  };
}

function observation(overrides: Partial<FrameObservation> = {}): FrameObservation {
  return {
    frameId: 1,
    rtpTimestamp90k: 90_000,
    irap: true,
    codec: 'h264',
    width: 1920,
    height: 1080,
    tCaptureUs: 0,
    tEncodeUs: 0,
    tSendUs: 0,
    arrivalMs: 1,
    decodeMs: 2,
    presentedMs: 100,
    expectedDisplayMs: 108,
    presentedFrames: 1,
    ...overrides,
  };
}

describe('createPresenter', () => {
  it('never attaches the element or writes jitterBufferTarget — receiver.ts owns both', () => {
    const video = makeVideo();
    const presenter = createPresenter(video.element);

    presenter.observe(observation());
    video.resize(1920, 1080);
    presenter.detach();

    // in chrome `jitterBufferTarget` is a *minimum*, so a second writer here
    // could only raise the floor arm B measured at 31 ms p50. there is no
    // surface left to write it from.
    expect(Object.keys(presenter).sort()).toEqual(['detach', 'observe', 'playoutDelayMaxMs', 'stats']);
    expect(video.writes).toEqual([]);
  });

  it('consumes frame observations without scheduling rAF or arming a second rVFC chain', () => {
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
    const createElement = jest.spyOn(document, 'createElement');
    const video = makeVideo();

    const presenter = createPresenter(video.element);
    presenter.observe(observation({ presentedFrames: 7 }));

    expect(presenter.stats().presentedFrames).toBe(7);
    expect(raf).not.toHaveBeenCalled();
    expect(video.element.requestVideoFrameCallback).not.toHaveBeenCalled();
    // no canvas pipeline: arm B never uploads a frame anywhere.
    expect(createElement.mock.calls.map(([tag]) => tag)).not.toContain('canvas');
  });

  it('counts gaps and duplicates from the renderer presentedFrames counter', () => {
    const presenter = createPresenter(makeVideo().element);

    presenter.observe(observation({ presentedFrames: 10 }));
    presenter.observe(observation({ presentedFrames: 11 }));
    presenter.observe(observation({ presentedFrames: 14 }));
    presenter.observe(observation({ presentedFrames: 14 }));

    expect(presenter.stats().gaps).toBe(2);
    expect(presenter.stats().duplicates).toBe(1);
  });

  it('reports display phase from the frame own stamps', () => {
    const presenter = createPresenter(makeVideo().element);

    expect(presenter.stats().displayPhaseMs).toBeNull();
    presenter.observe(observation({ presentedMs: 100, expectedDisplayMs: 108.5 }));

    expect(presenter.stats().displayPhaseMs).toBeCloseTo(8.5);
  });

  it('tracks the host resolution across a resize', () => {
    const video = makeVideo();
    const presenter = createPresenter(video.element);
    expect(presenter.stats()).toMatchObject({ width: 0, height: 0 });

    video.resize(2560, 1440);

    expect(presenter.stats()).toMatchObject({ width: 2560, height: 1440 });
  });

  it('carries the playout-delay max and refuses one outside (0, 500]', () => {
    const video = makeVideo().element;

    expect(createPresenter(video).playoutDelayMaxMs).toBeGreaterThan(0);
    expect(createPresenter(video, 500).playoutDelayMaxMs).toBe(500);
    expect(() => createPresenter(video, 0)).toThrow(RangeError);
    expect(() => createPresenter(video, 501)).toThrow(RangeError);
  });

  it('detach stops tracking resolution and resets the frame counter join', () => {
    const video = makeVideo();
    const presenter = createPresenter(video.element);
    presenter.observe(observation({ presentedFrames: 3 }));

    presenter.detach();
    video.resize(1280, 720);
    expect(presenter.stats().width).toBe(0);

    // no phantom gap from the counter jumping across the detach.
    presenter.observe(observation({ presentedFrames: 9 }));
    expect(presenter.stats().gaps).toBe(0);
    expect(presenter.stats().presentedFrames).toBe(9);
  });
});
