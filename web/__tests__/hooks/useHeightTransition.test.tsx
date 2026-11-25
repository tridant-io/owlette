import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { HEIGHT_TRANSITION, useHeightTransition } from '@/hooks/useHeightTransition';

/** natural heights per section, and whether the pane scrolls once settled */
const NATURAL: Record<string, number> = { short: 300, tall: 500 };
let paneScrolls = false;
let reducedMotion = false;
let observers: Array<() => void> = [];

class FakeResizeObserver {
  constructor(private callback: () => void) {}
  observe() {
    observers.push(this.callback);
  }
  disconnect() {
    observers = observers.filter((callback) => callback !== this.callback);
  }
}

/** what a browser reports: a pinned pixel height wins, otherwise the content's */
function measure(this: HTMLElement) {
  const pinned = parseFloat(this.style.height);
  const height = Number.isNaN(pinned) ? NATURAL[this.dataset.section ?? ''] ?? 0 : pinned;
  return { height } as DOMRect;
}

function Box({ section }: { section: string }) {
  const pane = useRef<HTMLDivElement>(null);
  const ref = useHeightTransition<HTMLDivElement>(section, pane);
  return (
    <div ref={ref} data-testid="box" data-section={section}>
      <div ref={pane} />
    </div>
  );
}

/** the observer's first report, which a real browser delivers after the first paint */
const paint = () => act(() => observers.forEach((callback) => callback()));

/** jsdom has no TransitionEvent, and a plain Event drops `propertyName` */
const transitionEnd = (element: HTMLElement, propertyName: string) =>
  act(() => {
    element.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName }));
  });

beforeEach(() => {
  jest.useFakeTimers();
  observers = [];
  paneScrolls = false;
  reducedMotion = false;
  global.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes('reduce') })) as typeof window.matchMedia;
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(measure);
  jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => (paneScrolls ? 900 : 100));
  jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 400);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('useHeightTransition', () => {
  it('leaves the first open alone: there is no old height to come from', () => {
    const { rerender } = render(<Box section="short" />);
    rerender(<Box section="tall" />);
    expect(screen.getByTestId('box').style.height).toBe('');
  });

  it('eases from the old height to the new one, then hands back to auto', () => {
    const { rerender } = render(<Box section="short" />);
    paint();
    rerender(<Box section="tall" />);

    const box = screen.getByTestId('box');
    expect(box.style.height).toBe('500px');
    expect(box.style.transition).toBe(HEIGHT_TRANSITION);
    expect(box.dataset.resizing).toBe('');

    transitionEnd(box, 'height');
    expect(box.style.height).toBe('');
    expect(box.style.transition).toBe('');
    expect(box.dataset.resizing).toBeUndefined();
  });

  it('ignores a child transition and settles on the safety timer if none arrives', () => {
    const { rerender } = render(<Box section="short" />);
    paint();
    rerender(<Box section="tall" />);
    const box = screen.getByTestId('box');

    transitionEnd(box, 'opacity');
    expect(box.style.height).toBe('500px');

    act(() => jest.advanceTimersByTime(300));
    expect(box.style.height).toBe('');
  });

  it('keeps a body that will scroll unclipped, so its scrollbar never pops in at the end', () => {
    paneScrolls = true;
    const { rerender } = render(<Box section="short" />);
    paint();
    rerender(<Box section="tall" />);
    const box = screen.getByTestId('box');
    expect(box.style.height).toBe('500px');
    expect(box.dataset.resizing).toBeUndefined();
  });

  it('cuts straight to the new height under reduced motion', () => {
    reducedMotion = true;
    const { rerender } = render(<Box section="short" />);
    paint();
    rerender(<Box section="tall" />);
    expect(screen.getByTestId('box').style.height).toBe('');
  });
});
