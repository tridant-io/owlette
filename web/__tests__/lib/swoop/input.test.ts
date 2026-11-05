/**
 * @jest-environment jsdom
 */

import { attachInputCapture, type InputCapture } from '@/lib/swoop/input';
import { decodeInputMessage, type InputMessage } from '@/lib/swoop/protocol';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const TS_US = 1_700_000_000_000_000;

interface Harness {
  capture: InputCapture;
  target: HTMLElement;
  /** one flush tick of the scheduler the capture was built with. */
  tick(): void;
  sent(): InputMessage[];
  clear(): void;
}

const attached: InputCapture[] = [];

function harness(options: Partial<Parameters<typeof attachInputCapture>[0]> = {}): Harness {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const payloads: string[] = [];
  let scheduled: (() => void) | null = null;

  const capture = attachInputCapture({
    target,
    send: (payload) => payloads.push(payload),
    // a pc viewing a windows machine: nothing to map, whatever jsdom's agent says.
    hostOs: 'windows',
    viewerIsMac: false,
    nowUs: () => TS_US,
    rect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    schedule: (flush) => {
      scheduled = flush;
      return () => {
        scheduled = null;
      };
    },
    ...options,
  });
  attached.push(capture);

  return {
    capture,
    target,
    tick: () => scheduled?.(),
    sent: () =>
      payloads.map((payload) => {
        const decoded = decodeInputMessage(payload, { ctl: true });
        if (!decoded.ok) throw new Error(`undecodable input message: ${payload}`);
        return decoded.value;
      }),
    clear: () => {
      payloads.length = 0;
    },
  };
}

interface PointerProps {
  clientX?: number;
  clientY?: number;
  movementX?: number;
  movementY?: number;
  button?: number;
  pointerId?: number;
  pointerType?: string;
}

/** jsdom has no PointerEvent constructor, so build the surface we read. */
function pointerEvent(type: string, props: PointerProps = {}, coalesced?: PointerProps[]): Event {
  const base = { clientX: 0, clientY: 0, movementX: 0, movementY: 0, button: 0, pointerId: 1, ...modifierFlags() };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, base, props, { getModifierState: () => false });
  if (coalesced) {
    Object.assign(event, {
      getCoalescedEvents: () => coalesced.map((sample) => ({ ...base, ...props, ...sample })),
    });
  }
  return event;
}

const MODIFIER_FLAGS: Readonly<Record<string, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {
  ControlLeft: 'ctrlKey',
  ControlRight: 'ctrlKey',
  MetaLeft: 'metaKey',
  MetaRight: 'metaKey',
  AltLeft: 'altKey',
  AltRight: 'altKey',
  ShiftLeft: 'shiftKey',
  ShiftRight: 'shiftKey',
};
/** the modifiers down on the test's keyboard, whose flags every event carries, as a real one's do. */
const modifiersDown = new Set<string>();
const modifierFlags = (): Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> =>
  Object.fromEntries([...modifiersDown].map((code) => [MODIFIER_FLAGS[code], true]));

const keyEvent = (type: string, code: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  if (code in MODIFIER_FLAGS) {
    if (type === 'keydown') modifiersDown.add(code);
    else modifiersDown.delete(code);
  }
  return new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...modifierFlags(), ...init });
};

/** each sent message as one string: a key or button edge, or the message's kind. */
const edges = (h: Harness) =>
  h.sent().map((m) =>
    m.t === 'k' ? `${m.code}:${m.down ? 'down' : 'up'}` : m.t === 'b' ? `b${m.button}:${m.down ? 'down' : 'up'}` : m.t,
  );

function setPointerLock(element: Element | null): void {
  Object.defineProperty(document, 'pointerLockElement', { value: element, configurable: true });
  document.dispatchEvent(new Event('pointerlockchange'));
}

afterEach(() => {
  // document- and window-level listeners outlive the element, so every capture
  // is detached or the next test inherits it.
  for (const capture of attached.splice(0, attached.length)) capture.detach();
  modifiersDown.clear();
  document.body.innerHTML = '';
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
});

// ---------------------------------------------------------------------------
// batching
// ---------------------------------------------------------------------------

describe('pointer batching', () => {
  it('collapses coalesced absolute moves into one message per tick', () => {
    const h = harness();

    h.target.dispatchEvent(
      pointerEvent('pointermove', { clientX: 10, clientY: 10 }, [
        { clientX: 10, clientY: 10 },
        { clientX: 20, clientY: 20 },
      ]),
    );
    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: 50 }));

    expect(h.sent()).toHaveLength(0);
    h.tick();

    expect(h.sent()).toEqual([{ t: 'm', x: 0.5, y: 0.5, seq: 1, tsUs: TS_US }]);
  });

  it('sums coalesced relative deltas while pointer-locked', () => {
    const h = harness();
    setPointerLock(h.target);
    expect(h.capture.pointerLocked).toBe(true);

    h.target.dispatchEvent(
      pointerEvent('pointermove', {}, [
        { movementX: 2, movementY: 1 },
        { movementX: 3, movementY: 1 },
        { movementX: 4, movementY: 2 },
      ]),
    );
    h.target.dispatchEvent(pointerEvent('pointermove', { movementX: 1, movementY: -4 }));
    h.tick();

    expect(h.sent()).toEqual([{ t: 'mr', dx: 10, dy: 0, seq: 1, tsUs: TS_US }]);
  });

  it('keeps a drag going past the video box, pinned to its edge', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: -40, clientY: 400 }));
    h.tick();
    expect(h.sent()).toEqual([
      { t: 'm', x: 0.5, y: 0.5, seq: 1, tsUs: TS_US },
      { t: 'b', button: 0, down: true, seq: 2, tsUs: TS_US },
      { t: 'm', x: 0, y: 1, seq: 3, tsUs: TS_US },
    ]);
    expect(h.capture.pointerOutside).toBe(false);
  });

  it('moves to where a press lands before pressing, for a pointer that never hovered there', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 150, clientY: 25, button: 0 }));
    expect(h.sent()).toEqual([
      { t: 'm', x: 0.75, y: 0.25, seq: 1, tsUs: TS_US },
      { t: 'b', button: 0, down: true, seq: 2, tsUs: TS_US },
    ]);
  });

  it('leaves touch to the touch layer: a finger sends nothing of its own', () => {
    const h = harness();
    const touch = { clientX: 100, clientY: 50, pointerType: 'touch' };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave']) {
      h.target.dispatchEvent(pointerEvent(type, touch));
    }
    h.tick();
    expect(h.sent()).toEqual([]);
    expect(h.capture.pointerSent).toBeNull();
  });

  it('flushes the pending move ahead of a key, without waiting for a tick', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));

    expect(h.sent()).toEqual([
      { t: 'm', x: 0.5, y: 0.5, seq: 1, tsUs: TS_US },
      { t: 'k', code: 'KeyA', down: true, seq: 2, tsUs: TS_US },
    ]);
  });

  it('merges wheel deltas of one mode and keeps the modes apart', () => {
    const h = harness();
    h.target.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, deltaMode: 0, cancelable: true }));
    h.target.dispatchEvent(new WheelEvent('wheel', { deltaY: 12, deltaMode: 0, cancelable: true }));
    h.target.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, deltaMode: 1, cancelable: true }));
    h.tick();

    expect(h.sent()).toEqual([
      { t: 'w', dx: 0, dy: 42, mode: 'pixel', seq: 1, tsUs: TS_US },
      { t: 'w', dx: 0, dy: 1, mode: 'line', seq: 2, tsUs: TS_US },
    ]);
  });
});

// ---------------------------------------------------------------------------
// off the picture
// ---------------------------------------------------------------------------

describe('off the picture', () => {
  it('moves nothing on the host over the letterbox bars, and says the pointer is off the picture', () => {
    const h = harness();
    const changes = jest.fn();
    h.capture.onPointerOutsideChange(changes);

    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: -20 }));
    h.tick();
    expect(h.sent()).toEqual([]);
    expect(h.capture.pointerOutside).toBe(true);

    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: 50 }));
    h.tick();
    expect(h.sent()).toEqual([{ t: 'm', x: 0.5, y: 0.5, seq: 1, tsUs: TS_US }]);
    expect(h.capture.pointerOutside).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('clicks nothing on the host for a press in the bars, and sends no release for it', () => {
    const h = harness();
    const down = pointerEvent('pointerdown', { clientX: 250, clientY: 50, button: 0 });
    h.target.dispatchEvent(down);
    h.target.dispatchEvent(pointerEvent('pointerup', { clientX: 250, clientY: 50, button: 0 }));
    expect(h.sent()).toEqual([]);
    expect(down.defaultPrevented).toBe(false);
  });

  it('scrolls nothing on the host for a wheel over the bars', () => {
    const h = harness();
    h.target.dispatchEvent(new WheelEvent('wheel', { deltaY: 30, clientX: 100, clientY: 150, cancelable: true }));
    h.tick();
    expect(h.sent()).toEqual([]);
  });

  it('counts leaving the stage as off the picture, unless a drag carries the pointer out', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    h.target.dispatchEvent(pointerEvent('pointerleave'));
    expect(h.capture.pointerOutside).toBe(false);

    h.target.dispatchEvent(pointerEvent('pointerup', { button: 0 }));
    h.target.dispatchEvent(pointerEvent('pointerleave'));
    expect(h.capture.pointerOutside).toBe(true);
  });

  it('clicks under pointer lock wherever the local pointer sits: it has no position there', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: 100, clientY: -20 }));
    setPointerLock(h.target);
    expect(h.capture.pointerOutside).toBe(false);

    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 250, clientY: -20, button: 0 }));
    expect(h.sent()).toEqual([{ t: 'b', button: 0, down: true, seq: 1, tsUs: TS_US }]);
  });
});

describe('a held button', () => {
  it('says while a press the host was sent is down, and never for one in the bars', () => {
    const h = harness();
    const changes = jest.fn();
    h.capture.onButtonHeldChange(changes);

    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 250, clientY: 50, button: 0 }));
    expect(h.capture.buttonHeld).toBe(false);
    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 2 }));
    expect(h.capture.buttonHeld).toBe(true);
    h.target.dispatchEvent(pointerEvent('pointerup', { button: 0 }));
    expect(h.capture.buttonHeld).toBe(true);
    h.target.dispatchEvent(pointerEvent('pointerup', { button: 2 }));
    expect(h.capture.buttonHeld).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);

    // a press the window loses on its way out is released on the host, and here.
    h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 100, clientY: 50, button: 0 }));
    window.dispatchEvent(new Event('blur'));
    expect(h.capture.buttonHeld).toBe(false);
  });
});

describe('detach', () => {
  const exitPointerLock = jest.fn(() => setPointerLock(null));
  beforeEach(() => {
    exitPointerLock.mockClear();
    Object.defineProperty(document, 'exitPointerLock', { value: exitPointerLock, configurable: true });
  });
  afterEach(() => {
    delete (document as { exitPointerLock?: unknown }).exitPointerLock;
  });

  it('gives a locked pointer back, sending the host no escape for it', () => {
    const h = harness();
    setPointerLock(h.target);
    h.capture.detach();
    // a session that is gone draws no pointer, so a lock it kept left none at all.
    expect(exitPointerLock).toHaveBeenCalledTimes(1);
    expect(h.sent()).toEqual([]);
  });

  it('leaves a lock it does not hold alone', () => {
    const h = harness();
    setPointerLock(document.createElement('div'));
    h.capture.detach();
    expect(exitPointerLock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

describe('keyboard', () => {
  it('sends physical codes and prevents the browser acting on them', () => {
    const h = harness();
    const down = keyEvent('keydown', 'KeyA');
    h.target.dispatchEvent(down);
    h.target.dispatchEvent(keyEvent('keyup', 'KeyA'));

    expect(down.defaultPrevented).toBe(true);
    expect(h.sent()).toEqual([
      { t: 'k', code: 'KeyA', down: true, seq: 1, tsUs: TS_US },
      { t: 'k', code: 'KeyA', down: false, seq: 2, tsUs: TS_US },
    ]);
  });

  it('forwards escape without preventing the browser gesture', () => {
    const h = harness();
    const down = keyEvent('keydown', 'Escape');
    h.target.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(false);
    expect(h.sent()).toEqual([{ t: 'k', code: 'Escape', down: true, seq: 1, tsUs: TS_US }]);
  });

  it('leaves the reserved keys to the browser entirely', () => {
    const h = harness();
    for (const code of ['F11', 'F12']) {
      const down = keyEvent('keydown', code);
      h.target.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(false);
    }
    expect(h.sent()).toHaveLength(0);
  });

  it('drops codes the host cannot inject but still swallows them', () => {
    const h = harness();
    const fn = keyEvent('keydown', 'Fn');
    h.target.dispatchEvent(fn);
    h.target.dispatchEvent(keyEvent('keydown', 'NoSuchKey'));

    expect(fn.defaultPrevented).toBe(true);
    expect(h.sent()).toHaveLength(0);
  });

  it('forwards auto-repeat, because SendInput does not repeat for us', () => {
    const h = harness();
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA', { repeat: true }));
    expect(h.sent()).toHaveLength(2);
  });

  it('sends nothing while an IME composition owns the keyboard', () => {
    const h = harness();
    h.target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(h.capture.mode).toBe('text');

    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    expect(h.sent()).toHaveLength(0);

    h.target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(h.capture.mode).toBe('scancode');
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    expect(h.sent()).toHaveLength(1);
  });
});

describe('escape twice, the keyboard way off the stage', () => {
  const tapEscape = (h: Harness, init: KeyboardEventInit = {}): KeyboardEvent => {
    const down = keyEvent('keydown', 'Escape', init);
    h.target.dispatchEvent(down);
    h.target.dispatchEvent(keyEvent('keyup', 'Escape'));
    return down;
  };

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
  });

  it('sends the first tap to the host and keeps the second, telling the listener', () => {
    const h = harness();
    const leave = jest.fn();
    h.capture.onEscapeTwice(leave);

    tapEscape(h);
    expect(leave).not.toHaveBeenCalled();
    const second = keyEvent('keydown', 'Escape');
    h.target.dispatchEvent(second);

    expect(leave).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
    expect(h.sent()).toEqual([
      { t: 'k', code: 'Escape', down: true, seq: 1, tsUs: TS_US },
      { t: 'k', code: 'Escape', down: false, seq: 2, tsUs: TS_US },
    ]);
  });

  it('releases what is held before focus goes, so nothing sticks down on the host', () => {
    const h = harness();
    h.capture.onEscapeTwice(jest.fn());
    h.target.dispatchEvent(keyEvent('keydown', 'ShiftLeft'));

    tapEscape(h);
    h.clear();
    h.target.dispatchEvent(keyEvent('keydown', 'Escape'));

    expect(h.sent()).toEqual([{ t: 'k', code: 'ShiftLeft', down: false, seq: 4, tsUs: TS_US }]);
  });

  it('sends both taps when they are further apart than half a second', () => {
    const h = harness();
    const leave = jest.fn();
    h.capture.onEscapeTwice(leave);
    const now = jest.spyOn(performance, 'now').mockReturnValue(1_000);

    tapEscape(h);
    now.mockReturnValue(1_501);
    tapEscape(h);

    expect(leave).not.toHaveBeenCalled();
    expect(h.sent().filter((m) => m.t === 'k' && m.down)).toHaveLength(2);
  });

  it('does not count a held escape repeating', () => {
    const h = harness();
    const leave = jest.fn();
    h.capture.onEscapeTwice(leave);

    h.target.dispatchEvent(keyEvent('keydown', 'Escape'));
    h.target.dispatchEvent(keyEvent('keydown', 'Escape', { repeat: true }));

    expect(leave).not.toHaveBeenCalled();
  });

  it('leaves fullscreen to the browser escape hold', () => {
    const h = harness();
    const leave = jest.fn();
    h.capture.onEscapeTwice(leave);
    Object.defineProperty(document, 'fullscreenElement', { value: h.target, configurable: true });

    tapEscape(h);
    tapEscape(h);

    expect(leave).not.toHaveBeenCalled();
    expect(h.sent().filter((m) => m.t === 'k' && m.down)).toHaveLength(2);
  });

  it('sends every escape to the host while nothing listens', () => {
    const h = harness();
    const off = h.capture.onEscapeTwice(jest.fn());
    off();

    tapEscape(h);
    tapEscape(h);

    expect(h.sent().filter((m) => m.t === 'k' && m.down)).toHaveLength(2);
  });
});

describe('escape held for two seconds, the way out of fullscreen in owlette swoop', () => {
  const APP_UA = 'Mozilla/5.0 owlette-swoop-viewer/0.0.0';
  const BROWSER_UA = 'Mozilla/5.0 Chrome/140.0';
  let exitFullscreen: jest.Mock;
  let exitPointerLock: jest.Mock;

  /** a capture on a fullscreen stage, under the given user agent. */
  const fullscreenHarness = (ua: string): Harness => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
    const h = harness();
    Object.defineProperty(document, 'fullscreenElement', { value: h.target, configurable: true });
    return h;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    exitFullscreen = jest.fn(() => Promise.resolve());
    exitPointerLock = jest.fn();
    Object.defineProperty(document, 'exitFullscreen', { value: exitFullscreen, configurable: true });
    Object.defineProperty(document, 'exitPointerLock', { value: exitPointerLock, configurable: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    Reflect.deleteProperty(document, 'exitFullscreen');
    Reflect.deleteProperty(document, 'exitPointerLock');
  });

  it('leaves fullscreen and lets go of the pointer two seconds into the hold, however it repeats', () => {
    const h = fullscreenHarness(APP_UA);
    setPointerLock(h.target);

    h.target.dispatchEvent(keyEvent('keydown', 'Escape'));
    jest.advanceTimersByTime(1000);
    h.target.dispatchEvent(keyEvent('keydown', 'Escape', { repeat: true }));
    jest.advanceTimersByTime(999);
    expect(exitFullscreen).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(exitPointerLock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when escape is let go at 1.9 s', () => {
    const h = fullscreenHarness(APP_UA);

    h.target.dispatchEvent(keyEvent('keydown', 'Escape'));
    jest.advanceTimersByTime(1900);
    h.target.dispatchEvent(keyEvent('keyup', 'Escape'));
    jest.advanceTimersByTime(10_000);

    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it('never arms in a browser, which owns its own escape hold', () => {
    const h = fullscreenHarness(BROWSER_UA);

    h.target.dispatchEvent(keyEvent('keydown', 'Escape'));
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(10_000);

    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(h.sent()).toEqual([{ t: 'k', code: 'Escape', down: true, seq: 1, tsUs: TS_US }]);
  });
});

describe('keys owlette swoop captures itself', () => {
  // desktop/viewer/src/windows.rs: the macos build ends its ua with ` (keys)`
  const MAC_APP =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) owlette-swoop-viewer/4.1.8 (keys)';
  type NativeKeyHost = { __owletteNativeKey?: (code: string, down: boolean) => void };
  const nativeKeyHost = (): NativeKeyHost => window as unknown as NativeKeyHost;

  /** a mac viewing a mac in the app, the stage focused as fullscreen leaves it. */
  const appHarness = (options: Partial<Parameters<typeof attachInputCapture>[0]> = {}): Harness => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_APP);
    const h = harness({ hostOs: 'macos', viewerIsMac: true, ...options });
    h.target.tabIndex = -1;
    h.target.focus();
    return h;
  };

  afterEach(() => jest.restoreAllMocks());

  it("sends the app's down, and the page's own keyup releases it", () => {
    const h = appHarness();
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    // macos hands over only the down; webkit gives the page the up
    nativeKeyHost().__owletteNativeKey?.('KeyQ', true);
    h.target.dispatchEvent(keyEvent('keyup', 'KeyQ'));
    h.target.dispatchEvent(keyEvent('keyup', 'MetaLeft'));
    expect(edges(h)).toEqual(['MetaLeft:down', 'KeyQ:down', 'KeyQ:up', 'MetaLeft:up']);

    // nothing is left held for a blur to release
    h.clear();
    window.dispatchEvent(new Event('blur'));
    expect(h.sent()).toHaveLength(0);
  });

  it('sends a second down of a held key once: a shortcut fires once on the host', () => {
    const h = appHarness();
    h.capture.nativeKey('KeyW', true);
    h.capture.nativeKey('KeyW', true);
    h.capture.nativeKey('KeyW', false);
    expect(edges(h)).toEqual(['KeyW:down', 'KeyW:up']);
  });

  it('releases what it pressed on blur, with everything else', () => {
    const h = appHarness();
    h.capture.nativeKey('KeyQ', true);
    h.clear();
    window.dispatchEvent(new Event('blur'));
    expect(edges(h)).toEqual(['KeyQ:up']);
  });

  it('goes through the modifier mapping, as a typed key does', () => {
    const h = appHarness({ hostOs: 'windows' });
    h.capture.nativeKey('MetaLeft', true);
    h.target.dispatchEvent(keyEvent('keyup', 'MetaLeft'));
    expect(edges(h)).toEqual(['ControlLeft:down', 'ControlLeft:up']);
  });

  it('takes no down while the stage lacks focus, since its keyup would never reach the stage', () => {
    const h = appHarness();
    h.target.blur();
    h.capture.nativeKey('KeyQ', true);
    expect(h.sent()).toHaveLength(0);
  });

  it('exists only in the app that says it captures keys, and goes on detach', () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/141.0');
    const browser = harness();
    expect(nativeKeyHost().__owletteNativeKey).toBeUndefined();
    browser.capture.detach();
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0) owlette-swoop-viewer/4.1.8');
    const windowsApp = harness();
    expect(nativeKeyHost().__owletteNativeKey).toBeUndefined();
    windowsApp.capture.detach();

    const h = appHarness();
    expect(nativeKeyHost().__owletteNativeKey).toBeDefined();
    h.capture.detach();
    expect(nativeKeyHost().__owletteNativeKey).toBeUndefined();
    h.capture.nativeKey('KeyQ', true);
    expect(edges(h)).toEqual([]);
  });

  it("leaves a newer capture's in place when an older one detaches", () => {
    const older = appHarness();
    const newer = appHarness();
    older.capture.detach();
    nativeKeyHost().__owletteNativeKey?.('KeyQ', true);
    expect(edges(newer)).toEqual(['KeyQ:down']);
  });
});

describe('a held modifier', () => {
  it('holds an armed modifier through the next key and releases it after', () => {
    const h = harness({ hostOs: 'macos' });
    h.capture.holdNextKey('MetaLeft');
    h.target.dispatchEvent(keyEvent('keydown', 'KeyC'));
    h.target.dispatchEvent(keyEvent('keyup', 'KeyC'));

    const keys = h.sent().filter((m) => m.t === 'k');
    expect(keys.map((m) => `${m.code}:${m.down ? 'down' : 'up'}`)).toEqual([
      'MetaLeft:down',
      'KeyC:down',
      'KeyC:up',
      'MetaLeft:up',
    ]);
  });

  it('does not take the release of a key pressed before the hold as the next key', () => {
    const h = harness({ hostOs: 'macos' });
    h.capture.holdNextKey('MetaLeft');
    // the enter that chose the menu item, released once focus is back on the stage.
    h.target.dispatchEvent(keyEvent('keyup', 'Enter'));
    h.target.dispatchEvent(keyEvent('keydown', 'KeyC'));
    h.target.dispatchEvent(keyEvent('keyup', 'KeyC'));

    const keys = h.sent().filter((m) => m.t === 'k');
    expect(keys.map((m) => `${m.code}:${m.down ? 'down' : 'up'}`)).toEqual([
      'MetaLeft:down',
      'Enter:up',
      'KeyC:down',
      'KeyC:up',
      'MetaLeft:up',
    ]);
  });

  it('releases an armed modifier with everything else, and never arms it twice', () => {
    const h = harness();
    h.capture.holdNextKey('MetaLeft');
    h.capture.holdNextKey('MetaLeft');
    h.capture.releaseAll();

    const keys = h.sent().filter((m) => m.t === 'k');
    expect(keys.map((m) => `${m.code}:${m.down ? 'down' : 'up'}`)).toEqual(['MetaLeft:down', 'MetaLeft:up']);
  });

  it('holds two armed modifiers together through the next key, so ctrl+alt can be typed', () => {
    const h = harness();
    h.capture.holdNextKey('ControlLeft');
    h.capture.holdNextKey('AltLeft');
    h.capture.typeKey('Tab', false);
    expect(edges(h)).toEqual(['ControlLeft:down', 'AltLeft:down', 'Tab:down', 'Tab:up', 'ControlLeft:up', 'AltLeft:up']);
    expect(h.capture.armedKeys).toEqual([]);
  });

  it('lets one armed modifier go before the next key, the others staying down', () => {
    const h = harness();
    h.capture.holdNextKey('ControlLeft');
    h.capture.holdNextKey('AltLeft');
    h.capture.releaseArmedKey('ControlLeft');
    h.capture.releaseArmedKey('ControlLeft');
    expect(h.capture.armedKeys).toEqual(['AltLeft']);
    h.capture.typeKey('Tab', false);
    expect(edges(h)).toEqual(['ControlLeft:down', 'AltLeft:down', 'ControlLeft:up', 'Tab:down', 'Tab:up', 'AltLeft:up']);
  });

  it('says which modifiers are armed, and when they let go', () => {
    const h = harness();
    const seen: (readonly string[])[] = [];
    h.capture.onArmedKeysChange(() => seen.push(h.capture.armedKeys));
    h.capture.holdNextKey('ControlLeft');
    h.capture.holdNextKey('ShiftLeft');
    h.capture.typeKey('KeyC', false);
    expect(seen).toEqual([['ControlLeft'], ['ControlLeft', 'ShiftLeft'], []]);
  });
});

describe('the touch layer', () => {
  it('points at a client point on the picture, and refuses one off it', () => {
    const h = harness();
    expect(h.capture.pointAt(50, 75)).toBe(true);
    expect(h.capture.pointAt(250, 50)).toBe(false);
    h.tick();
    expect(h.sent()).toEqual([{ t: 'm', x: 0.25, y: 0.75, seq: 1, tsUs: TS_US }]);
    expect(h.capture.pointerSent).toEqual({ x: 0.25, y: 0.75 });
  });

  it('pins a held press to the edge, as a mouse drag is', () => {
    const h = harness();
    h.capture.pointAt(100, 50);
    h.capture.press(0);
    expect(h.capture.pointAt(260, -20)).toBe(true);
    h.tick();
    expect(h.sent().slice(-1)).toEqual([{ t: 'm', x: 1, y: 0, seq: 3, tsUs: TS_US }]);
  });

  it('presses and releases once each, and lets releaseAll take a press it holds', () => {
    const h = harness();
    h.capture.press(2);
    h.capture.release(2);
    h.capture.release(2);
    h.capture.press(0);
    h.capture.releaseAll();
    expect(edges(h)).toEqual(['b2:down', 'b2:up', 'b0:down', 'b0:up']);
  });

  it('scrolls in pixels, coalesced within a tick', () => {
    const h = harness();
    h.capture.scroll(0, 12);
    h.capture.scroll(3, 8);
    h.capture.scroll(0, 0);
    h.tick();
    expect(h.sent()).toEqual([{ t: 'w', dx: 3, dy: 20, mode: 'pixel', seq: 1, tsUs: TS_US }]);
  });

  it('types a key, shift around it when asked, and drops a code the host cannot inject', () => {
    const h = harness();
    h.capture.typeKey('KeyH', true);
    h.capture.typeKey('KeyI', false);
    h.capture.typeKey('NotAKey', false);
    expect(edges(h)).toEqual(['ShiftLeft:down', 'KeyH:down', 'KeyH:up', 'ShiftLeft:up', 'KeyI:down', 'KeyI:up']);
  });

  it('leaves the keys of a text field inside the stage to it', () => {
    const h = harness();
    const field = document.createElement('textarea');
    h.target.appendChild(field);
    const down = keyEvent('keydown', 'KeyA');
    field.dispatchEvent(down);
    field.dispatchEvent(keyEvent('keyup', 'KeyA'));
    expect(h.sent()).toEqual([]);
    expect(down.defaultPrevented).toBe(false);
  });
});

describe('modifier mapping', () => {
  const codes = (h: Harness) => h.sent().map((m) => (m.t === 'k' ? m.code : m.t));

  it("sends a mac viewer's cmd to a windows host as ctrl by default", () => {
    const h = harness({ hostOs: 'windows', viewerIsMac: true });
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    h.target.dispatchEvent(keyEvent('keyup', 'MetaLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'MetaRight'));

    expect(codes(h)).toEqual(['ControlLeft', 'ControlLeft', 'ControlRight']);
  });

  it("sends a mac viewer's control to a windows host as the windows key, which cmd no longer is", () => {
    const h = harness({ hostOs: 'windows', viewerIsMac: true });
    h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
    h.target.dispatchEvent(keyEvent('keyup', 'ControlLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'ControlRight'));

    expect(codes(h)).toEqual(['MetaLeft', 'MetaLeft', 'MetaRight']);
  });

  it("sends a pc viewer's ctrl to a mac host as cmd by default, so ctrl+c copies there", () => {
    const h = harness({ hostOs: 'macos', viewerIsMac: false });
    h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'KeyC'));
    h.target.dispatchEvent(keyEvent('keyup', 'KeyC'));
    h.target.dispatchEvent(keyEvent('keyup', 'ControlLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'ControlRight'));

    expect(codes(h)).toEqual(['MetaLeft', 'KeyC', 'KeyC', 'MetaLeft', 'MetaRight']);
  });

  it('sends every key as pressed under passthrough', () => {
    const h = harness({ hostOs: 'macos', viewerIsMac: false, modifierMapping: 'passthrough' });
    h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));

    expect(codes(h)).toEqual(['ControlLeft', 'MetaLeft']);
  });

  it('sends every key as pressed where the viewer and the host agree', () => {
    const mac = harness({ hostOs: 'macos', viewerIsMac: true });
    const pc = harness({ hostOs: 'windows', viewerIsMac: false });
    for (const h of [mac, pc]) {
      h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      expect(codes(h)).toEqual(['MetaLeft', 'ControlLeft']);
    }
  });

  it('sends a chord from the menu as written, never through the mapping', () => {
    const h = harness({ hostOs: 'macos', viewerIsMac: false });
    h.capture.pressChord(['MetaLeft', 'ControlLeft', 'KeyQ']);

    expect(codes(h)).toEqual(['MetaLeft', 'ControlLeft', 'KeyQ', 'KeyQ', 'ControlLeft', 'MetaLeft']);
  });

  it('presses a chord in order and releases it in reverse, inside the one sequence', () => {
    const h = harness();
    h.capture.pressChord(['AltLeft', 'Tab']);

    const keys = h.sent().filter((m) => m.t === 'k');
    expect(keys.map((m) => `${m.code}:${m.down ? 'down' : 'up'}`)).toEqual([
      'AltLeft:down',
      'Tab:down',
      'Tab:up',
      'AltLeft:up',
    ]);
    const seqs = keys.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('releases what is held before the mapping changes under it', () => {
    const h = harness({ hostOs: 'windows', viewerIsMac: true, modifierMapping: 'passthrough' });
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    h.clear();

    h.capture.setModifierMapping('windows', 'swap');
    expect(h.sent()).toEqual([{ t: 'k', code: 'MetaLeft', down: false, seq: 2, tsUs: TS_US }]);
    h.clear();

    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    expect(codes(h)).toEqual(['ControlLeft']);
  });

  it('takes the machine it learns after attach, releasing what is held first', () => {
    const h = harness({ viewerIsMac: false });
    h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
    h.clear();

    h.capture.setModifierMapping('macos', 'swap');
    expect(h.sent()).toEqual([{ t: 'k', code: 'ControlLeft', down: false, seq: 2, tsUs: TS_US }]);
    h.clear();

    h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
    expect(codes(h)).toEqual(['MetaLeft']);
  });

  it('releases nothing when neither the machine nor the mapping changes', () => {
    const h = harness({ hostOs: 'macos', viewerIsMac: false });
    h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
    h.clear();

    h.capture.setModifierMapping('macos', 'swap');
    expect(h.sent()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buttons and releases
// ---------------------------------------------------------------------------

describe('buttons', () => {
  it('maps the five buttons straight through', () => {
    const h = harness();
    for (const button of [0, 1, 2, 3, 4]) {
      h.target.dispatchEvent(pointerEvent('pointerdown', { button }));
      h.target.dispatchEvent(pointerEvent('pointerup', { button }));
    }
    expect(h.sent().filter((m) => m.t === 'b')).toHaveLength(10);
  });

  it('releases a held button when the pointer is cancelled', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointerdown', { button: 0 }));
    h.clear();

    // a cancelled pointer reports button -1, so it cannot go through pointerup.
    h.target.dispatchEvent(pointerEvent('pointercancel', { button: -1 }));
    expect(h.sent()).toEqual([{ t: 'b', button: 0, down: false, seq: 3, tsUs: TS_US }]);
  });

  it('prevents the context menu so right-click reaches the host', () => {
    const h = harness();
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    h.target.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });
});

describe('releases', () => {
  it('releases every held key and button exactly once on blur', () => {
    const h = harness();
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    h.target.dispatchEvent(keyEvent('keydown', 'ShiftLeft'));
    h.target.dispatchEvent(pointerEvent('pointerdown', { button: 2 }));
    h.clear();

    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('blur'));

    expect(h.sent()).toEqual([
      { t: 'k', code: 'KeyA', down: false, seq: 5, tsUs: TS_US },
      { t: 'k', code: 'ShiftLeft', down: false, seq: 6, tsUs: TS_US },
      { t: 'b', button: 2, down: false, seq: 7, tsUs: TS_US },
    ]);
  });

  it('releases on visibilitychange to hidden, and not on the way back', () => {
    const h = harness();
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    h.clear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sent()).toHaveLength(1);

    h.clear();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.sent()).toHaveLength(0);
  });

  it('releases and stops listening on detach', () => {
    const h = harness();
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    h.clear();

    h.capture.detach();
    expect(h.sent()).toEqual([{ t: 'k', code: 'KeyA', down: false, seq: 2, tsUs: TS_US }]);

    h.clear();
    h.target.dispatchEvent(keyEvent('keydown', 'KeyB'));
    h.capture.detach();
    expect(h.sent()).toHaveLength(0);
  });

  describe('a modifier whose keyup the os kept, with the window still focused', () => {
    // a mac's ctrl+up opens mission control, which takes the keyup and never blurs the window.
    const keptKeyup = (code: string) => modifiersDown.delete(code);

    it('is released before the next key goes, so typing is not a string of shortcuts', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      keptKeyup('ControlLeft');
      h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
      expect(edges(h)).toEqual(['ControlLeft:down', 'ControlLeft:up', 'KeyA:down']);
    });

    it('is released as the host has it down, through the mapping', () => {
      const h = harness({ viewerIsMac: true });
      h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
      keptKeyup('MetaLeft');
      h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
      expect(edges(h)).toEqual(['ControlLeft:down', 'ControlLeft:up', 'KeyA:down']);
    });

    it('is released before a click, which would otherwise go as ctrl+click', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      keptKeyup('ControlLeft');
      h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 50 }));
      expect(edges(h)).toEqual(['ControlLeft:down', 'ControlLeft:up', 'm', 'b0:down']);
    });

    it('is released when the mouse next moves', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      keptKeyup('ControlLeft');
      h.target.dispatchEvent(pointerEvent('pointermove', { clientX: 50, clientY: 50 }));
      expect(edges(h)).toEqual(['ControlLeft:down', 'ControlLeft:up']);
    });

    it('keeps ctrl and alt down under altgr, which some browsers report as neither', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      h.target.dispatchEvent(keyEvent('keydown', 'AltRight'));
      // firefox on windows: the character altgr types carries no ctrl and no alt, only AltGraph.
      h.target.dispatchEvent(keyEvent('keydown', 'KeyQ', { ctrlKey: false, altKey: false, modifierAltGraph: true }));
      expect(edges(h)).toEqual(['ControlLeft:down', 'AltRight:down', 'KeyQ:down']);
    });
  });

  describe("a modifier's release sent again, since swoop-input never retransmits", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('goes again at 100 ms and 500 ms, so one lost on the way, or overtaking its press, still lands', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      h.target.dispatchEvent(keyEvent('keyup', 'ControlLeft'));
      h.clear();
      jest.advanceTimersByTime(99);
      expect(h.sent()).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(edges(h)).toEqual(['ControlLeft:up']);
      jest.advanceTimersByTime(400);
      expect(edges(h)).toEqual(['ControlLeft:up', 'ControlLeft:up']);
    });

    it('stays quiet once the modifier is down again', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      h.target.dispatchEvent(keyEvent('keyup', 'ControlLeft'));
      jest.advanceTimersByTime(100);
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      h.clear();
      jest.advanceTimersByTime(1_000);
      expect(h.sent()).toHaveLength(0);
    });

    it('never goes again for a letter or a mouse button: the host injects every up it gets, held or not', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
      h.target.dispatchEvent(keyEvent('keyup', 'KeyA'));
      h.target.dispatchEvent(pointerEvent('pointerdown', { clientX: 50, clientY: 50 }));
      h.target.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 50 }));
      h.clear();
      jest.advanceTimersByTime(1_000);
      expect(h.sent()).toHaveLength(0);
    });

    it('is dropped on detach', () => {
      const h = harness();
      h.target.dispatchEvent(keyEvent('keydown', 'ControlLeft'));
      h.target.dispatchEvent(keyEvent('keyup', 'ControlLeft'));
      h.capture.detach();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// pointer lock
// ---------------------------------------------------------------------------

describe('pointer lock exit', () => {
  it('forwards the escape the browser swallowed, then releases what was held', () => {
    const h = harness();
    setPointerLock(h.target);
    h.target.dispatchEvent(keyEvent('keydown', 'KeyA'));
    h.clear();

    setPointerLock(null);

    expect(h.capture.pointerLocked).toBe(false);
    expect(h.sent()).toEqual([
      { t: 'k', code: 'Escape', down: true, seq: 2, tsUs: TS_US },
      { t: 'k', code: 'Escape', down: false, seq: 3, tsUs: TS_US },
      { t: 'k', code: 'KeyA', down: false, seq: 4, tsUs: TS_US },
    ]);
  });

  it('does not invent an escape when the browser dispatched the real one', () => {
    const h = harness();
    setPointerLock(h.target);
    h.target.dispatchEvent(keyEvent('keydown', 'Escape'));
    h.clear();

    setPointerLock(null);
    expect(h.sent()).toEqual([{ t: 'k', code: 'Escape', down: false, seq: 2, tsUs: TS_US }]);
  });

  it('does not invent an escape when we asked for the exit ourselves', () => {
    const h = harness();
    setPointerLock(h.target);
    h.clear();

    h.capture.exitPointerLock();
    setPointerLock(null);
    expect(h.sent()).toHaveLength(0);
  });
});
