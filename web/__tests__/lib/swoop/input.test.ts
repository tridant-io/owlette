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
    cmdMapping: 'win',
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

  it('clamps an absolute move that leaves the video box', () => {
    const h = harness();
    h.target.dispatchEvent(pointerEvent('pointermove', { clientX: -40, clientY: 400 }));
    h.tick();
    expect(h.sent()).toEqual([{ t: 'm', x: 0, y: 1, seq: 1, tsUs: TS_US }]);
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

describe('cmd mapping', () => {
  it('sends ctrl for cmd when configured that way', () => {
    const h = harness({ cmdMapping: 'ctrl' });
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    h.target.dispatchEvent(keyEvent('keyup', 'MetaLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'MetaRight'));

    expect(h.sent().map((m) => (m.t === 'k' ? m.code : m.t))).toEqual([
      'ControlLeft',
      'ControlLeft',
      'ControlRight',
    ]);
  });

  it('sends the windows key for cmd when configured that way', () => {
    const h = harness({ cmdMapping: 'win' });
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    h.target.dispatchEvent(keyEvent('keydown', 'MetaRight'));

    expect(h.sent().map((m) => (m.t === 'k' ? m.code : m.t))).toEqual(['MetaLeft', 'MetaRight']);
  });

  it('releases what is held before the mapping changes under it', () => {
    const h = harness({ cmdMapping: 'win' });
    h.target.dispatchEvent(keyEvent('keydown', 'MetaLeft'));
    h.clear();

    h.capture.setCmdMapping('ctrl');
    expect(h.sent()).toEqual([{ t: 'k', code: 'MetaLeft', down: false, seq: 2, tsUs: TS_US }]);
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
