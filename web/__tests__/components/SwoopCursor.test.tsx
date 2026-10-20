/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the machine's own pointer, drawn one way or the other and never both: the
 * stage's css cursor where its size allows, otherwise an overlay at `cpos`
 * over the picture, hotspot on the position, at the machine's own size. over
 * the letterbox bars it is neither, and the local pointer shows as itself.
 */

import React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';
import { SwoopCursor } from '@/components/swoop/SwoopCursor';
import { attach } from '@/lib/swoop/cursor';
import { SWOOP_FEATURES, type SwoopSession } from '@/lib/swoop/features';

// flipped per test: the desktop app is told apart by its user-agent token.
let inApp = false;
jest.mock('@/lib/swoop/viewerApp', () => ({
  ...jest.requireActual('@/lib/swoop/viewerApp'),
  viewerAppPlatform: () => (inApp ? 'windows' : null),
}));

const PNG = 'iVBORw0KGgo=';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect;

interface Harness {
  session: SwoopSession;
  stage: HTMLElement;
  cursor(data: string): void;
  lock(on: boolean): void;
  /** a frame `width` machine pixels wide lands, as the element's `resize` says. */
  frame(width: number): void;
  detach(): void;
}

/**
 * a 16:9 picture letterboxed inside a taller stage. `input` attaches the real
 * input capture too, which is what says whether the pointer is on the picture.
 * the picture is a frame 1000 px wide unless `picture` is false, a session
 * still connecting: jsdom's own video has no frame at all.
 */
function harness(options: { input?: boolean; picture?: boolean; ctl?: boolean } = {}): Harness {
  const handlers = new Map<string, (data: unknown) => void>();
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => rect(0, 0, 1000, 800);
  const video = document.createElement('video');
  const frameWidth = (width: number) =>
    Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => width });
  if (options.picture !== false) frameWidth(1000);

  const session = {
    viewerId: 'viewer-me',
    ctl: options.ctl ?? true,
    stage,
    video,
    contentRect: () => rect(0, 81, 1000, 638),
    send: () => true,
    onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
      handlers.set(label, incoming);
      return () => {
        handlers.delete(label);
      };
    },
  } as unknown as SwoopSession;

  const detachCursor = attach(session);
  const detachInput = options.input
    ? SWOOP_FEATURES.find((feature) => feature.name === 'input')!.attach(session)
    : () => {};
  const detach = () => {
    detachInput();
    detachCursor();
  };
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
    frame: (width) => {
      frameWidth(width);
      act(() => {
        video.dispatchEvent(new Event('resize'));
      });
    },
    detach,
  };
}

const cpos = (x: number, y: number, visible = true) => JSON.stringify({ t: 'cpos', x, y, visible, tsUs: 1 });

/** jsdom has no PointerEvent constructor, so build the surface input.ts reads. */
const pointerAt = (type: string, clientX: number, clientY: number): Event =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    clientX,
    clientY,
    movementX: 0,
    movementY: 0,
    button: 0,
    pointerId: 1,
  });
/** an upload as a host that names no dpi sends it: one older than the field. */
const shape = (w = 32, h = 32, scale?: number) =>
  JSON.stringify({ t: 'cshape', id: 1, hotX: 4, hotY: 6, w, h, ...(scale === undefined ? {} : { scale }), png: PNG });
/** an upload from a host that names the dpi it drew the shape at. */
const shapeAt = (dpi: number, w: number, h: number, hotX = 4, hotY = 6, scale?: number) =>
  JSON.stringify({ t: 'cshape', id: 1, hotX, hotY, w, h, ...(scale === undefined ? {} : { scale }), dpi, png: PNG });
/**
 * a 2x mac's arrow as its host sends it: 28x40 points with its hot spot 5
 * points in, drawn at 56x80 pixels and halved for the wire's 64 px cap.
 */
const retinaArrow = () => shapeAt(192, 28, 40, 5, 5, 2);

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
    h.frame(500);
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

  it('hides the css cursor while the machine paints its own pointer into the picture during a drag', () => {
    const h = harness({ input: true });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.5, 0.5));
    act(() => {
      h.stage.dispatchEvent(pointerAt('pointerdown', 500, 400));
    });
    h.cursor(cpos(0.5, 0.5, false));
    // a title-bar drag: windows draws the pointer into the frame, so the
    // local arrow on top of it would be a second cursor.
    expect(h.stage.style.cursor).toBe('none');
    act(() => {
      h.stage.dispatchEvent(pointerAt('pointerup', 500, 400));
    });
    h.cursor(cpos(0.5, 0.5, true));
    expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
    h.detach();
  });

  it('keeps the local pointer through a press when the machine had hidden its own before it', () => {
    const h = harness({ input: true });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    // a kiosk or a player: hidden all along, so a click is not windows taking it over.
    h.cursor(cpos(0.5, 0.5, false));
    act(() => {
      h.stage.dispatchEvent(pointerAt('pointerdown', 500, 400));
    });
    expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
    h.cursor(cpos(0.6, 0.5, false));
    expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
    h.detach();
  });

  it('keeps the local pointer when the machine hides its own with no button down', () => {
    const h = harness({ input: true });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.5, 0.5));
    // a kiosk hiding its cursor, or the pointer on another of the
    // machine's displays: the operator would be clicking blind.
    h.cursor(cpos(0.5, 0.5, false));
    expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
    h.detach();
  });

  it('in the app, gives the local pointer back while the machine hides its own with no button down', () => {
    inApp = true;
    try {
      const h = harness({ input: true });
      render(<SwoopCursor session={h.session} />);
      h.cursor(retinaArrow());
      h.cursor(cpos(0.5, 0.5));
      expect(h.stage.style.cursor).toBe('none');
      h.cursor(cpos(0.5, 0.5, false));
      expect(screen.queryByTestId('machine-cursor')).toBeNull();
      expect(h.stage.style.cursor).toBe('');
      h.detach();
    } finally {
      inApp = false;
    }
  });

  it('leaves a watcher its own pointer and draws the machine one where it is', () => {
    const h = harness({ ctl: false });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.25, 0.5));
    // a css cursor would put the machine's shape on the watcher's own
    // pointer, which is not where the machine's is.
    expect(h.stage.style.cursor).toBe('');
    const drawn = screen.getByTestId('machine-cursor');
    expect(drawn.style.left).toBe(`${0.25 * 999 - 4}px`);
    h.detach();
  });

  it('hides the local pointer under a windowed overlay', () => {
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape(64, 64));
    h.cursor(cpos(0.5, 0.5));
    expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
    expect(h.stage.style.cursor).toBe('none');
    h.detach();
  });

  it('shows the local pointer and draws no machine cursor while the pointer is over the letterbox', () => {
    const h = harness({ input: true });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape(64, 64));
    h.cursor(cpos(0.5, 0.5));
    expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();

    // the picture spans y 81..719 of this stage, so y 40 is the top bar.
    act(() => {
      h.stage.dispatchEvent(pointerAt('pointermove', 500, 40));
    });
    expect(screen.queryByTestId('machine-cursor')).toBeNull();
    expect(h.stage.style.cursor).toBe('');

    act(() => {
      h.stage.dispatchEvent(pointerAt('pointermove', 500, 400));
    });
    expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
    expect(h.stage.style.cursor).toBe('none');
    h.detach();
  });

  it('gives the bars the local pointer when the machine shape is a css cursor too', () => {
    const h = harness({ input: true });
    render(<SwoopCursor session={h.session} />);
    h.cursor(shape());
    h.cursor(cpos(0.5, 0.5));
    expect(h.stage.style.cursor).toContain('url(data:image/png;base64,');

    act(() => {
      h.stage.dispatchEvent(pointerAt('pointermove', 500, 760));
    });
    expect(h.stage.style.cursor).toBe('');

    act(() => {
      h.stage.dispatchEvent(pointerAt('pointermove', 500, 400));
    });
    expect(h.stage.style.cursor).toContain('url(data:image/png;base64,');
    h.detach();
  });

  it('draws a shape the host shrank for the wire at its true size, as an overlay', () => {
    // the harness's 1000 px wide picture of a 1000 px wide machine: the picture is 1x.
    const h = harness();
    render(<SwoopCursor session={h.session} />);
    // a 64 px pointer sent as 32 png pixels at scale 2.
    h.cursor(shape(32, 32, 2));
    h.cursor(cpos(0.5, 0.5));
    const drawn = screen.getByTestId('machine-cursor');
    expect(drawn.style.width).toBe('64px');
    expect(drawn.style.height).toBe('64px');
    expect(drawn.style.left).toBe(`${0.5 * 999 - 4 * 2}px`);
    expect(drawn.style.top).toBe(`${81 + 0.5 * 637 - 6 * 2}px`);
    expect(h.stage.style.cursor).toBe('none');
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
    // the overlay is the pointer, so the local one goes.
    expect(h.stage.style.cursor).toBe('none');
    expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
    h.detach();
  });

  it('in the owlette swoop desktop app, draws the pointer at its own size whatever the picture scale', () => {
    inApp = true;
    try {
      const h = harness();
      // a 1000 px wide picture of a 500 px wide machine: the picture is 2x, the pointer is not.
      h.frame(500);
      render(<SwoopCursor session={h.session} />);
      h.cursor(shape());
      h.cursor(cpos(0.5, 0.5));
      const drawn = screen.getByTestId('machine-cursor');
      expect(drawn.style.width).toBe('32px');
      expect(drawn.style.left).toBe(`${0.5 * 999 - 4}px`);
      h.detach();
    } finally {
      inApp = false;
    }
  });

  it('in the owlette swoop desktop app, overlays the shape outside pointer lock and hides the local pointer', () => {
    inApp = true;
    try {
      const h = harness();
      render(<SwoopCursor session={h.session} />);
      h.cursor(shape());
      h.cursor(cpos(0.5, 0.5));
      // never a css cursor there: the webview paints it at bitmap size, small and soft on a scaled display.
      expect(h.stage.style.cursor).toBe('none');
      const drawn = screen.getByTestId('machine-cursor');
      expect(drawn.style.left).toBe(`${0.5 * 999 - 4}px`);
      expect(drawn).toHaveAttribute('src', `data:image/png;base64,${PNG}`);
      h.detach();
    } finally {
      inApp = false;
    }
  });

  describe('at the machine own pointer size, from the dpi the host drew it at', () => {
    it('in the owlette swoop desktop app, draws a retina mac pointer at its size in points, not in pixels', () => {
      inApp = true;
      try {
        const h = harness();
        // the mac's 2880 px wide picture, shown 1000 css px wide.
        h.frame(2880);
        render(<SwoopCursor session={h.session} />);
        h.cursor(retinaArrow());
        h.cursor(cpos(0.5, 0.5));
        const drawn = screen.getByTestId('machine-cursor');
        expect(drawn.style.width).toBe('28px');
        expect(drawn.style.height).toBe('40px');
        // the hot spot is 5 png pixels in at scale 2 and 192 dpi: 5 css pixels.
        expect(drawn.style.left).toBe(`${0.5 * 999 - 5}px`);
        expect(drawn.style.top).toBe(`${81 + 0.5 * 637 - 5}px`);
        h.detach();
      } finally {
        inApp = false;
      }
    });

    it('in the app, draws a 2x shape the host sent whole at half its png pixels', () => {
      inApp = true;
      try {
        const h = harness();
        render(<SwoopCursor session={h.session} />);
        // a 2x mac's i-beam, small enough to go whole: 18x36 pixels, 9x18 points.
        h.cursor(shapeAt(192, 18, 36, 8, 16));
        h.cursor(cpos(0.5, 0.5));
        const drawn = screen.getByTestId('machine-cursor');
        expect(drawn.style.width).toBe('9px');
        expect(drawn.style.height).toBe('18px');
        expect(drawn.style.left).toBe(`${0.5 * 999 - 4}px`);
        h.detach();
      } finally {
        inApp = false;
      }
    });

    it('in a browser, draws it at the machine own size whatever the picture scale', () => {
      const h = harness();
      // a 1000 px wide picture of a 500 px wide machine: the picture is 2x, the pointer is not.
      h.frame(500);
      render(<SwoopCursor session={h.session} />);
      h.cursor(shapeAt(96, 32, 32));
      h.cursor(cpos(0.5, 0.5));
      h.lock(true);
      const drawn = screen.getByTestId('machine-cursor');
      expect(drawn.style.width).toBe('32px');
      expect(drawn.style.left).toBe(`${0.5 * 999 - 4}px`);
      h.detach();
    });

    it('in a browser, overlays a pointer at 150% at its 32 css px', () => {
      const h = harness();
      render(<SwoopCursor session={h.session} />);
      h.cursor(shapeAt(144, 48, 48, 6, 9));
      h.cursor(cpos(0.5, 0.5));
      // 48 png pixels are too many for a css cursor, which would draw each one a css pixel.
      expect(h.stage.style.cursor).toBe('none');
      const drawn = screen.getByTestId('machine-cursor');
      expect(drawn.style.width).toBe('32px');
      expect(drawn.style.left).toBe(`${0.5 * 999 - 4}px`);
      expect(drawn.style.top).toBe(`${81 + 0.5 * 637 - 6}px`);
      h.detach();
    });

    it('in a browser, overlays a 2x shape that would fit a css cursor by its png, at half its png', () => {
      const h = harness();
      render(<SwoopCursor session={h.session} />);
      h.cursor(shapeAt(192, 32, 32));
      h.cursor(cpos(0.5, 0.5));
      expect(h.stage.style.cursor).toBe('none');
      expect(screen.getByTestId('machine-cursor').style.width).toBe('16px');
      h.detach();
    });

    it('in a browser, keeps a pointer at 100% the stage css cursor', () => {
      const h = harness();
      render(<SwoopCursor session={h.session} />);
      h.cursor(shapeAt(96, 32, 32));
      h.cursor(cpos(0.5, 0.5));
      expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
      expect(screen.queryByTestId('machine-cursor')).toBeNull();
      h.detach();
    });
  });

  describe('one pointer, never none', () => {
    it('in the app, leaves the local pointer up until the host has said where its own is', () => {
      inApp = true;
      try {
        const h = harness();
        render(<SwoopCursor session={h.session} />);
        // a live session the host has said nothing on yet: the local pointer is the only one.
        expect(h.stage.style.cursor).toBe('');
        h.cursor(retinaArrow());
        expect(h.stage.style.cursor).toBe('');
        expect(screen.queryByTestId('machine-cursor')).toBeNull();
        h.cursor(cpos(0.5, 0.5));
        expect(h.stage.style.cursor).toBe('none');
        expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
        h.detach();
      } finally {
        inApp = false;
      }
    });

    it('in the app, leaves the local pointer up over the connecting stage until the first frame lands', () => {
      inApp = true;
      try {
        const h = harness({ picture: false });
        render(<SwoopCursor session={h.session} />);
        // the host's pointer arrives before its picture does.
        h.cursor(retinaArrow());
        h.cursor(cpos(0.5, 0.5));
        expect(h.stage.style.cursor).toBe('');
        expect(screen.queryByTestId('machine-cursor')).toBeNull();
        h.frame(2880);
        expect(h.stage.style.cursor).toBe('none');
        expect(screen.getByTestId('machine-cursor')).toBeInTheDocument();
        h.detach();
      } finally {
        inApp = false;
      }
    });

    it('in a browser, gives the local pointer the machine shape before any position, rather than hiding it', () => {
      const h = harness();
      render(<SwoopCursor session={h.session} />);
      h.cursor(shape());
      expect(h.stage.style.cursor).toBe(`url(data:image/png;base64,${PNG}) 4 6, auto`);
      h.detach();
    });
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
