/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the machine's own pointer, drawn one way or the other and never both:
 * outside pointer lock it is the stage's css cursor, under pointer lock it is
 * an overlay at `cpos` over the picture, hotspot on the position.
 */

import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { SwoopCursor } from '@/components/swoop/SwoopCursor';
import { attach } from '@/lib/swoop/cursor';
import type { SwoopSession } from '@/lib/swoop/features';

const PNG = 'iVBORw0KGgo=';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

interface Harness {
  session: SwoopSession;
  stage: HTMLElement;
  cursor(data: string): void;
  lock(on: boolean): void;
  detach(): void;
}

/** a 16:9 picture letterboxed inside a taller stage. */
function harness(): Harness {
  const handlers = new Map<string, (data: unknown) => void>();
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => rect(0, 0, 1000, 800);

  const session = {
    viewerId: 'viewer-me',
    stage,
    video: document.createElement('video'),
    contentRect: () => rect(0, 81, 1000, 638),
    onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
      handlers.set(label, incoming);
      return () => {
        handlers.delete(label);
      };
    },
  } as unknown as SwoopSession;

  const detach = attach(session);
  return {
    session,
    stage,
    cursor: (data) => act(() => handlers.get('swoop-cursor')?.(data)),
    lock: (on) => {
      Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => (on ? stage : null) });
      act(() => {
        document.dispatchEvent(new Event('pointerlockchange'));
      });
    },
    detach,
  };
}

const cpos = (x: number, y: number, visible = true) => JSON.stringify({ t: 'cpos', x, y, visible, tsUs: 1 });
const shape = (w = 32, h = 32) => JSON.stringify({ t: 'cshape', id: 1, hotX: 4, hotY: 6, w, h, png: PNG });

afterEach(() => {
  cleanup();
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
});

describe('SwoopCursor', () => {
  it('renders nothing without a session', () => {
    const { container } = render(<SwoopCursor session={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('applies the machine shape to the stage css cursor outside pointer lock, and overlays nothing', () => {
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.5, 0.5));
    expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
    expect(screen.queryByTestId('machine-cursor')).toBeNull();
    h.detach();
  });

  it('overlays the shape at cpos over the picture under pointer lock, hotspot on the position', () => {
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.5, 0.5));
    h.lock(true);
    const drawn = screen.getByTestId('machine-cursor');
    // the css cursor is off while the overlay is on: one pointer, never two.
    expect(h.stage.style.cursor).toBe('');
    // the picture is inset 81px from the top of the stage, the `size - 1`
    // convention is the injection side's, and the hotspot (4, 6) sits on it.
    expect(drawn.style.left).toBe(`${0.5 * 999 - 4}px`);
    expect(drawn.style.top).toBe(`${81 + 0.5 * 637 - 6}px`);
    expect(drawn).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
    h.detach();
  });

  it('draws the shape at the picture scale, hotspot included', () => {
    const h = harness();
    // a 1000 px wide picture of a 500 px wide machine: everything is 2x.
    Object.defineProperty(h.session.video, 'videoWidth', { configurable: true, get: () => 500 });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.5, 0.5));
    h.lock(true);
    const drawn = screen.getByTestId('machine-cursor');
    expect(drawn.style.width).toBe('64px');
    expect(drawn.style.height).toBe('64px');
    expect(drawn.style.left).toBe(`${0.5 * 999 - 4 * 2}px`);
    expect(drawn.style.top).toBe(`${81 + 0.5 * 637 - 6 * 2}px`);
    h.detach();
  });

  it('draws a plain arrow under pointer lock before a shape has arrived', () => {
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    h.cursor(cpos(0.25, 0.25));
    h.lock(true);
    const drawn = screen.getByTestId('machine-cursor');
    expect(drawn.tagName.toLowerCase()).toBe('svg');
    expect(drawn.style.left).toBe(`${0.25 * 999}px`);
    h.detach();
  });

  it('hides the overlay when the machine hides its pointer', () => {
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    h.lock(true);
    h.cursor(cpos(0.5, 0.5, false));
    expect(screen.queryByTestId('machine-cursor')).toBeNull();
    h.cursor(cpos(0.5, 0.5, true));
    expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
    h.detach();
  });

  it('overlays a shape too large for a css cursor even outside pointer lock', () => {
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape(64, 64));
    h.cursor(cpos(0.5, 0.5));
    expect(h.stage.style.cursor).toBe('');
    expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
    h.detach();
  });

  it('clears the stage css cursor on unmount', () => {
    const h = harness();
    const { unmount } = render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    expect(h.stage.style.cursor).not.toBe('');
    unmount();
    expect(h.stage.style.cursor).toBe('');
    h.detach();
  });
});
