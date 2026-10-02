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
}

/** jsdom has no PointerEvent constructor, so build the surface we read. */
function pointerEvent(type: string, props: PointerProps = {}, coalesced?: PointerProps[]): Event {
  const base = { clientX: 0, clientY: 0, movementX: 0, movementY: 0, button: 0, pointerId: 1 };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, base, props);
  if (coalesced) {
    Object.assign(event, {
      getCoalescedEvents: () => coalesced.map((sample) => ({ ...base, ...props, ...sample })),
    });
  }
  return event;
}

const keyEvent = (type: string, code: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });

function setPointerLock(element: Element | null): void {
  Object.defineProperty(document, 'pointerLockElement', { value: element, configurable: true });
  document.dispatchEvent(new Event('pointerlockchange'));
}

afterEach(() => {
  // document- and window-level listeners outlive the element, so every capture
  // is detached or the next test inherits it.
  for (const capture of attached.splice(0, attached.length)) capture.detach();
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
      { t: 'b', button: 0, down: true, seq: 1, tsUs: TS_US },
      { t: 'm', x: 0, y: 1, seq: 2, tsUs: TS_US },
    ]);
    expect(h.capture.pointerOutside).toBe(false);
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
    expect(h.sent()).toEqual([{ t: 'b', button: 0, down: false, seq: 2, tsUs: TS_US }]);
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
      { t: 'k', code: 'KeyA', down: false, seq: 4, tsUs: TS_US },
      { t: 'k', code: 'ShiftLeft', down: false, seq: 5, tsUs: TS_US },
      { t: 'b', button: 2, down: false, seq: 6, tsUs: TS_US },
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
