/**
 * @jest-environment jsdom
 */

// three of the done-when cases in task 3.12 are arm-A-only and have no honest
// test here: "the ImageBitmap fallback is used when `desynchronized` is
// unsupported" and "every frame is closed exactly once" describe a canvas and a
// `VideoFrame` that arm B has neither of, and "presentation happens on the
// decoder callback" describes a `VideoDecoder` that no longer exists in the
// shipping path. what survives of that first case — no rAF for a frame, and no
// upload from the frame join — is asserted below. smooth scaling's canvas
// (4.2.0) draws from `present`, against a fake renderer.

import { createPresenter } from '@/lib/swoop/video/presenter';
import type { FrameObservation } from '@/lib/swoop/video/receiver';
import { createSmoothRenderer } from '@/lib/swoop/video/smooth';

const mockRenderer = {
  resize: jest.fn(),
  draw: jest.fn(),
  hide: jest.fn(),
  dispose: jest.fn(),
  lost: false,
};
jest.mock('@/lib/swoop/video/smooth', () => ({ createSmoothRenderer: jest.fn(() => mockRenderer) }));
const createRenderer = createSmoothRenderer as jest.Mock;

interface FakeVideo {
  element: HTMLVideoElement;
  /** every property this module wrote to the element. must stay empty. */
  writes: string[];
  resize(width: number, height: number): void;
  /** where the picture's box is on screen, css px. */
  place(left: number, top: number, width: number, height: number): void;
}

function makeVideo(): FakeVideo {
  const listeners = new Map<string, EventListener[]>();
  const writes: string[] = [];
  let rect = { left: 0, top: 0, width: 0, height: 0 };
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
    getBoundingClientRect: () => rect,
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
    place(left, top, width, height) {
      rect = { left, top, width, height };
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

/** the area's canvas, 1300x800 css at the page's origin. */
function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1300, height: 800 }) as DOMRect;
  return canvas;
}

const presenterOn = (video: FakeVideo, smooth = () => true) =>
  createPresenter(video.element, { canvas: makeCanvas(), smooth });

/** animation frames, run by hand. */
let frames: FrameRequestCallback[] = [];
function nextFrame(): void {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
}

const metadata = (expectedDisplayTime = 0) =>
  ({ presentationTime: 0, expectedDisplayTime, presentedFrames: 1, width: 0, height: 0, mediaTime: 0 }) as VideoFrameCallbackMetadata;

beforeEach(() => {
  frames = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
  jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  mockRenderer.lost = false;
  createRenderer.mockImplementation(() => mockRenderer);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('createPresenter', () => {
  it('never attaches the element or writes jitterBufferTarget — receiver.ts owns both', () => {
    const video = makeVideo();
    const presenter = presenterOn(video);

    presenter.observe(observation());
    video.resize(1920, 1080);
    presenter.detach();

    // in chrome `jitterBufferTarget` is a *minimum*, so a second writer here
    // could only raise the floor arm B measured at 31 ms p50. there is no
    // surface left to write it from.
    expect(Object.keys(presenter).sort()).toEqual([
      'detach',
      'drawnFrames',
      'invalidate',
      'observe',
      'playoutDelayMaxMs',
      'present',
      'stats',
    ]);
    expect(video.writes).toEqual([]);
  });

  it('consumes frame observations without scheduling rAF, arming a second rVFC chain or uploading', () => {
    const video = makeVideo();

    const presenter = presenterOn(video);
    presenter.observe(observation({ presentedFrames: 7 }));

    expect(presenter.stats().presentedFrames).toBe(7);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(video.element.requestVideoFrameCallback).not.toHaveBeenCalled();
    expect(createRenderer).not.toHaveBeenCalled();
  });

  it('counts gaps and duplicates from the renderer presentedFrames counter', () => {
    const presenter = presenterOn(makeVideo());

    presenter.observe(observation({ presentedFrames: 10 }));
    presenter.observe(observation({ presentedFrames: 11 }));
    presenter.observe(observation({ presentedFrames: 14 }));
    presenter.observe(observation({ presentedFrames: 14 }));

    expect(presenter.stats().gaps).toBe(2);
    expect(presenter.stats().duplicates).toBe(1);
  });

  it('reports display phase from the frame own stamps', () => {
    const presenter = presenterOn(makeVideo());

    expect(presenter.stats().displayPhaseMs).toBeNull();
    presenter.observe(observation({ presentedMs: 100, expectedDisplayMs: 108.5 }));

    expect(presenter.stats().displayPhaseMs).toBeCloseTo(8.5);
  });

  it('tracks the host resolution across a resize', () => {
    const video = makeVideo();
    const presenter = presenterOn(video);
    expect(presenter.stats()).toMatchObject({ width: 0, height: 0 });

    video.resize(2560, 1440);

    expect(presenter.stats()).toMatchObject({ width: 2560, height: 1440 });
  });

  it('carries the playout-delay max and refuses one outside (0, 500]', () => {
    const video = makeVideo().element;
    const options = { canvas: makeCanvas(), smooth: () => false };

    expect(createPresenter(video, options).playoutDelayMaxMs).toBeGreaterThan(0);
    expect(createPresenter(video, { ...options, playoutDelayMaxMs: 500 }).playoutDelayMaxMs).toBe(500);
    expect(() => createPresenter(video, { ...options, playoutDelayMaxMs: 0 })).toThrow(RangeError);
    expect(() => createPresenter(video, { ...options, playoutDelayMaxMs: 501 })).toThrow(RangeError);
  });

  it('detach stops tracking resolution and resets the frame counter join', () => {
    const video = makeVideo();
    const presenter = presenterOn(video);
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

describe('createPresenter — smooth scaling', () => {
  /** a presenter with a frame of `width`x`height` laid out at the given css box, dpr 1. */
  function shown(frame: [number, number], box: [number, number, number, number], smooth = () => true) {
    const video = makeVideo();
    video.resize(...frame);
    video.place(...box);
    const presenter = presenterOn(video, smooth);
    presenter.invalidate();
    nextFrame();
    jest.clearAllMocks();
    return { video, presenter };
  }

  it('draws a picture shown at 0.73 through the canvas, and calls it smooth', () => {
    const { video, presenter } = shown([1000, 500], [10, 20, 730, 365]);
    presenter.present(metadata());

    expect(mockRenderer.resize).toHaveBeenCalledWith(1300, 800);
    expect(mockRenderer.draw).toHaveBeenCalledWith(video.element, { x: 10, y: 20, width: 730, height: 365 });
    expect(presenter.stats().scaling).toBe('smooth');
    expect(presenter.drawnFrames).toBe(1);
  });

  it.each([
    ['1:1', [1000, 500, 1000, 500]],
    ['1:2', [10, 20, 500, 250]],
  ] as const)('leaves %s on whole pixels to the video, and calls it exact', (_ratio, box) => {
    const { presenter } = shown([1000, 500], [...box]);
    presenter.present(metadata());

    expect(mockRenderer.draw).not.toHaveBeenCalled();
    expect(presenter.stats().scaling).toBe('exact');
    expect(presenter.drawnFrames).toBe(0);
  });

  it('draws 1:2 off the pixel grid, where the video would blend it', () => {
    const { presenter } = shown([1000, 500], [10.5, 20, 500, 250]);
    presenter.present(metadata());

    expect(mockRenderer.draw).toHaveBeenCalledTimes(1);
    expect(presenter.stats().scaling).toBe('smooth');
  });

  it('draws 1:3 on whole pixels through the canvas, and calls it exact', () => {
    const { video, presenter } = shown([3840, 2160], [10, 20, 1280, 720]);
    presenter.present(metadata());

    expect(mockRenderer.draw).toHaveBeenCalledWith(video.element, { x: 10, y: 20, width: 1280, height: 720 });
    expect(presenter.stats().scaling).toBe('exact');
    expect(presenter.drawnFrames).toBe(1);
  });

  it('is standard with smooth scaling off, and opens no context for it', () => {
    const { presenter } = shown([1000, 500], [10, 20, 730, 365], () => false);
    presenter.present(metadata());

    expect(createRenderer).not.toHaveBeenCalled();
    expect(presenter.stats().scaling).toBe('standard');
    expect(presenter.drawnFrames).toBe(0);
  });

  it('is standard where the renderer cannot be made, and asks only once', () => {
    createRenderer.mockImplementation(() => null);
    const video = makeVideo();
    video.resize(1000, 500);
    video.place(10, 20, 730, 365);
    const presenter = presenterOn(video);
    presenter.invalidate();
    presenter.present(metadata());
    presenter.present(metadata());

    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(presenter.stats().scaling).toBe('standard');
    expect(presenter.drawnFrames).toBe(0);
  });

  it('is standard while the context is lost, and draws again once it is back', () => {
    const { presenter } = shown([1000, 500], [10, 20, 730, 365]);
    presenter.present(metadata());
    mockRenderer.lost = true;
    presenter.present(metadata());

    expect(presenter.stats().scaling).toBe('standard');
    expect(mockRenderer.hide).toHaveBeenCalled();
    expect(presenter.drawnFrames).toBe(1);

    mockRenderer.lost = false;
    presenter.present(metadata());
    expect(presenter.stats().scaling).toBe('smooth');
    expect(presenter.drawnFrames).toBe(2);
  });

  it.each([
    ['at full size off the grid', [10.5, 20, 1000, 500]],
    ['just under full size', [10, 20, 990, 495]],
    ['zoomed above it', [10, 20, 1500, 750]],
  ] as const)('is standard %s, and leaves it to the video', (_where, box) => {
    const { presenter } = shown([1000, 500], [...box]);
    presenter.present(metadata());

    expect(mockRenderer.draw).not.toHaveBeenCalled();
    expect(presenter.stats().scaling).toBe('standard');
  });

  it('redraws the frame shown once in the next animation frame, however often it is invalidated, and counts no new frame', () => {
    const { video, presenter } = shown([1000, 500], [10, 20, 730, 365]);
    video.place(0, 0, 700, 350);
    presenter.invalidate();
    presenter.invalidate();
    presenter.invalidate();
    expect(mockRenderer.draw).not.toHaveBeenCalled();

    nextFrame();
    expect(mockRenderer.draw).toHaveBeenCalledTimes(1);
    expect(mockRenderer.draw).toHaveBeenCalledWith(video.element, { x: 0, y: 0, width: 700, height: 350 });
    expect(presenter.drawnFrames).toBe(0);
  });

  it('hides the canvas at once when smooth scaling goes off, with no frame needed', () => {
    let on = true;
    const { presenter } = shown([1000, 500], [10, 20, 730, 365], () => on);
    presenter.present(metadata());
    on = false;
    presenter.invalidate();
    nextFrame();

    expect(mockRenderer.hide).toHaveBeenCalled();
    expect(presenter.stats().scaling).toBe('standard');
  });

  it('estimates the canvas from the clock in the second animation frame after a draw, and is null while not drawing', () => {
    const now = jest.spyOn(performance, 'now');
    const { presenter } = shown([1000, 500], [10, 20, 730, 365]);
    expect(presenter.stats().smoothEstimateMs).toBeNull();

    presenter.present(metadata(100));
    now.mockReturnValue(110);
    nextFrame();
    expect(presenter.stats().smoothEstimateMs).toBeNull();
    now.mockReturnValue(125);
    nextFrame();
    expect(presenter.stats().smoothEstimateMs).toBe(25);

    presenter.present(metadata(200));
    nextFrame();
    now.mockReturnValue(235);
    nextFrame();
    // the median of 25 and 35
    expect(presenter.stats().smoothEstimateMs).toBe(30);
  });

  it('drops the estimate when the canvas stops drawing, including one still in flight', () => {
    const now = jest.spyOn(performance, 'now').mockReturnValue(150);
    const { video, presenter } = shown([1000, 500], [10, 20, 730, 365]);
    presenter.present(metadata(100));
    nextFrame();
    nextFrame();
    expect(presenter.stats().smoothEstimateMs).toBe(50);

    presenter.present(metadata(200));
    video.place(0, 0, 1000, 500);
    presenter.invalidate();
    nextFrame();
    now.mockReturnValue(260);
    nextFrame();
    expect(presenter.stats().scaling).toBe('exact');
    expect(presenter.stats().smoothEstimateMs).toBeNull();
  });

  it('hides the canvas and lets its context go on detach', () => {
    const { presenter } = shown([1000, 500], [10, 20, 730, 365]);
    presenter.present(metadata());
    presenter.detach();

    expect(mockRenderer.hide).toHaveBeenCalled();
    expect(mockRenderer.dispose).toHaveBeenCalledTimes(1);
    presenter.present(metadata());
    expect(presenter.drawnFrames).toBe(1);
  });
});
