import { act, renderHook } from '@testing-library/react';
import { FOLLOW_MS, easeOutCubic, useFollowBottom } from '@/hooks/useFollowBottom';

let reducedMotion = false;
let contentPx = 1000;
const VIEW_PX = 400;
/** one fake-timer animation frame */
const FRAME = 16;

/** a scroller showing 400px of `contentPx`, starting at the top */
function scroller(): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { get: () => contentPx });
  Object.defineProperty(el, 'clientHeight', { get: () => VIEW_PX });
  return el;
}

function follower(el: HTMLElement) {
  const ref = { current: el };
  return renderHook(() => useFollowBottom(ref));
}

const frames = (ms: number) => act(() => jest.advanceTimersByTime(ms));

/** frames as a browser runs them: every write lands as a scroll event before the next frame */
function framesWithScrollEvents(ms: number, noteScroll: () => void) {
  for (let t = 0; t < ms; t += FRAME) {
    frames(FRAME);
    noteScroll();
  }
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }));
  });

beforeEach(() => {
  jest.useFakeTimers();
  reducedMotion = false;
  contentPx = 1000;
  window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes('reduce') })) as typeof window.matchMedia;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('easeOutCubic', () => {
  it('runs from 0 to 1, front-loaded so the glide settles rather than stops', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBe(0.875);
    for (let t = 0; t < 1; t += 0.1) expect(easeOutCubic(t + 0.1)).toBeGreaterThan(easeOutCubic(t));
  });
});

describe('useFollowBottom', () => {
  it('glides to the bottom over FOLLOW_MS, moving from its very first frame', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    expect(el.scrollTop).toBe(0);

    frames(FRAME);
    expect(el.scrollTop).toBeGreaterThan(0);

    frames(FOLLOW_MS / 2);
    expect(el.scrollTop).toBeGreaterThan(300);
    expect(el.scrollTop).toBeLessThan(600);

    frames(FOLLOW_MS);
    expect(el.scrollTop).toBe(600);
  });

  it('keeps moving on the frame the content grows, toward the new bottom', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(FOLLOW_MS / 2);
    const before = el.scrollTop;

    contentPx = 1400;
    // a second call joins the running loop rather than queueing another
    act(() => result.current.follow());
    frames(FRAME);
    expect(el.scrollTop).toBeGreaterThan(before);
    expect(el.scrollTop).toBeLessThan(1000);

    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(1000);
  });

  it('starts a glide moving on its first frame after the content grows at rest', () => {
    const el = scroller();
    const { result } = follower(el);
    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(600);

    contentPx = 1100;
    act(() => result.current.follow());
    frames(FRAME);

    expect(el.scrollTop).toBeGreaterThan(600);
  });

  it('is not cut off by its own scroll events on a long way down', () => {
    contentPx = 2000;
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    framesWithScrollEvents(FOLLOW_MS * 2, result.current.noteScroll);

    expect(el.scrollTop).toBe(1600);
  });

  it('never pulls back a reader who scrolled up mid-glide, even when the reply grows before their scroll lands', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    framesWithScrollEvents(3 * FRAME, result.current.noteScroll);
    const readerAt = el.scrollTop - 150;
    el.scrollTop = readerAt;
    // a token lands between the reader's move and its scroll event
    contentPx = 1300;
    act(() => result.current.follow());
    act(() => result.current.noteScroll());
    frames(FOLLOW_MS * 2);

    expect(el.scrollTop).toBe(readerAt);
  });

  it('lets go on an upward wheel before any scroll event, and stays let go as the reply grows', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(3 * FRAME);
    act(() => result.current.noteWheel({ deltaY: -100 }));
    const heldAt = el.scrollTop;
    contentPx = 1300;
    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);

    expect(el.scrollTop).toBe(heldAt);
  });

  it('follows again once the reader scrolls back down near the bottom', () => {
    const el = scroller();
    const { result } = follower(el);
    act(() => result.current.follow());
    framesWithScrollEvents(FOLLOW_MS * 2, result.current.noteScroll);

    el.scrollTop = 200;
    act(() => result.current.noteScroll());
    contentPx = 1200;
    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(200);

    el.scrollTop = 750;
    act(() => result.current.noteScroll());
    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(800);
  });

  it('stops for scroll keys pressed anywhere, and an up key lets go', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(3 * FRAME);
    press('PageUp');
    const heldAt = el.scrollTop;
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(heldAt);

    contentPx = 1300;
    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(heldAt);
  });

  it('only stops for a down key: the reader is still following', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(3 * FRAME);
    press('End');
    const heldAt = el.scrollTop;
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(heldAt);

    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);
    expect(el.scrollTop).toBe(600);
  });

  it('listens for keys only while a glide runs', () => {
    const add = jest.spyOn(window, 'addEventListener');
    const remove = jest.spyOn(window, 'removeEventListener');
    const el = scroller();
    const { result, unmount } = follower(el);

    act(() => result.current.follow());
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function));
    const listener = add.mock.calls.find(([type]) => type === 'keydown')?.[1];
    frames(FOLLOW_MS * 2);
    expect(remove).toHaveBeenCalledWith('keydown', listener);

    remove.mockClear();
    contentPx = 1300;
    act(() => result.current.follow());
    frames(3 * FRAME);
    unmount();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('jumps straight to the bottom under reduced motion', () => {
    reducedMotion = true;
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());

    expect(el.scrollTop).toBe(600);
  });

  it('leaves the view where stop caught it', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(3 * FRAME);
    act(() => result.current.stop());
    const heldAt = el.scrollTop;
    frames(FOLLOW_MS * 2);

    expect(heldAt).toBeGreaterThan(0);
    expect(el.scrollTop).toBe(heldAt);
  });

  it('lets go on release, as "back to top" needs', () => {
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(3 * FRAME);
    act(() => result.current.release());
    const heldAt = el.scrollTop;
    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);

    expect(el.scrollTop).toBe(heldAt);
  });

  it('stops on unmount', () => {
    const el = scroller();
    const { result, unmount } = follower(el);

    act(() => result.current.follow());
    frames(3 * FRAME);
    const heldAt = el.scrollTop;
    unmount();
    frames(FOLLOW_MS * 2);

    expect(el.scrollTop).toBe(heldAt);
  });

  it('does nothing at the bottom already', () => {
    contentPx = VIEW_PX;
    const el = scroller();
    const { result } = follower(el);

    act(() => result.current.follow());
    frames(FOLLOW_MS * 2);

    expect(el.scrollTop).toBe(0);
  });
});
