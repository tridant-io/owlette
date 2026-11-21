/**
 * @jest-environment jsdom
 *
 * `useSwoopView` writes `layoutPicture`'s box straight onto the `<video>`, and
 * writes it again on everything that can move it: the area's size, the
 * screen's dpr, and this browser's size setting. jsdom lays nothing out, so
 * the area's rect and the frame's size are set here, and ResizeObserver and
 * matchMedia, which jsdom lacks, are faked when a test needs them.
 */

import { useRef } from 'react';
import { act, render } from '@testing-library/react';
import { useSwoopView } from '@/hooks/useSwoopView';
import { setSize } from '@/lib/swoop/viewStore';

let area = { left: 0, top: 0, width: 1300, height: 760 };
let frame = { width: 1280, height: 720 };

function Stage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  useSwoopView({ videoRef, areaRef });
  return (
    <div ref={areaRef} data-testid="swoop-area">
      <video ref={videoRef} />
    </div>
  );
}

const box = (video: HTMLVideoElement) => {
  const { left, top, width, height } = video.style;
  return { left, top, width, height };
};

/** the last ResizeObserver made, with how it was asked to observe. */
let observer: { fire: (entries: unknown[]) => void; options: unknown } | null = null;
/** each `matchMedia` query asked, and the change listeners on it. */
let queries: { query: string; listeners: Set<() => void> }[] = [];

const setDpr = (value: number) => Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });

beforeEach(() => {
  area = { left: 0, top: 0, width: 1300, height: 760 };
  frame = { width: 1280, height: 720 };
  jest
    .spyOn(HTMLDivElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => ({ ...area, x: area.left, y: area.top, right: area.left + area.width, bottom: area.top + area.height }) as DOMRect);
  jest.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockImplementation(() => frame.width);
  jest.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockImplementation(() => frame.height);
});

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
  setDpr(1);
  observer = null;
  queries = [];
  delete (window as unknown as Record<string, unknown>).ResizeObserver;
  delete (window as unknown as Record<string, unknown>).matchMedia;
});

function fakeObservers() {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    private readonly callback: (entries: unknown[]) => void;
    constructor(callback: (entries: unknown[]) => void) {
      this.callback = callback;
      observer = { fire: (entries) => this.callback(entries), options: undefined };
    }
    observe(_target: Element, options?: unknown) {
      observer!.options = options;
    }
    disconnect() {}
  };
  (window as unknown as Record<string, unknown>).matchMedia = (query: string) => {
    const listeners = new Set<() => void>();
    queries.push({ query, listeners });
    return {
      matches: true,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
  };
}

describe('useSwoopView', () => {
  it('writes the picture box onto the video on mount', () => {
    const { container } = render(<Stage />);
    // a 1280x720 frame a little under a 1300x760 area snaps to 1:1, centred
    expect(box(container.querySelector('video')!)).toEqual({ left: '10px', top: '20px', width: '1280px', height: '720px' });
  });

  it('lays the picture out again when the area resizes, from its exact device size', () => {
    fakeObservers();
    const { container } = render(<Stage />);
    expect(observer?.options).toEqual({ box: 'device-pixel-content-box' });

    area = { left: 0, top: 0, width: 660.4, height: 380 };
    act(() => observer!.fire([{ devicePixelContentBoxSize: [{ inlineSize: 661, blockSize: 380 }] }]));
    // now a little over 1:2, centred in the 661 device pixels the browser reports, not round(660.4)
    expect(box(container.querySelector('video')!)).toEqual({ left: '11px', top: '10px', width: '640px', height: '360px' });
  });

  it('lays the picture out again when the dpr changes, and watches for the next change', () => {
    fakeObservers();
    const { container } = render(<Stage />);
    const video = container.querySelector('video')!;
    expect(box(video)).toEqual({ left: '10px', top: '20px', width: '1280px', height: '720px' });
    expect(queries.map(({ query }) => query)).toEqual(['(resolution: 1dppx)']);

    setDpr(2);
    act(() => [...queries[0].listeners].forEach((listener) => listener()));
    // at dpr 2 the area is 2600x1520 device pixels, past the snap band: fit, on a whole device origin
    expect(box(video)).toEqual({ left: '0px', top: '14.5px', width: '1300px', height: '731.5px' });
    expect(queries.map(({ query }) => query)).toEqual(['(resolution: 1dppx)', '(resolution: 2dppx)']);
    expect(queries[0].listeners.size).toBe(0);
    expect(queries[1].listeners.size).toBe(1);
  });

  it('lays the picture out again when the frame changes size', () => {
    const { container } = render(<Stage />);
    const video = container.querySelector('video')!;
    frame = { width: 640, height: 360 };
    act(() => {
      video.dispatchEvent(new Event('resize'));
    });
    // 640x360 in 1300x760 is past the snap band: fit fills the area's width
    expect(box(video)).toEqual({ left: '0px', top: '15px', width: '1300px', height: '731px' });
  });

  it('lays the picture out again when this browser picks a size', () => {
    frame = { width: 1920, height: 1080 };
    const { container } = render(<Stage />);
    const video = container.querySelector('video')!;
    expect(box(video).width).toBe('1300px');

    act(() => setSize('sharp'));
    // the largest whole fraction that fits: 1:2
    expect(box(video)).toEqual({ left: '170px', top: '110px', width: '960px', height: '540px' });
  });

  it('throws nothing without ResizeObserver or matchMedia, and still lays the picture out', () => {
    expect(typeof window.ResizeObserver).toBe('undefined');
    expect(typeof window.matchMedia).toBe('undefined');
    const { container, unmount } = render(<Stage />);
    expect(box(container.querySelector('video')!).width).toBe('1280px');
    unmount();
  });
});
