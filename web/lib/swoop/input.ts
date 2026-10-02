/**
 * swoop input capture — PROTOCOL.md §5, `swoop-input`, viewer → host.
 *
 * everything the stage element sees is turned into `k` / `m` / `mr` / `b` / `w`
 * messages by `encodeInputMessage` (protocol.ts owns the codec; there is not a
 * second one here) and handed to `send`, which wave 5 wires to the peer's
 * `swoop-input` channel.
 *
 * ## the two input modes
 *
 * **scancode** is the default and the only one implemented. keys go as a
 * `KeyboardEvent.code` — the physical key — which the host turns into a ps/2
 * set-1 scancode through `agent/swoop/testdata/keymap.json`. it is never `key`,
 * which depends on the layout and on whatever the IME is doing.
 *
 * **text** is the unicode path an IME composition needs, and it is a **wave 6
 * seam, deliberately unimplemented**. during a composition the physical key
 * bears no relation to the text being composed, so replaying scancodes types
 * garbage on the host; the protocol has no unicode input message to send
 * instead. so for the duration of a composition this module sends nothing at
 * all and reports `mode === 'text'`, which is a visible, explainable gap rather
 * than a half-built path. wave 6 adds the message, the host-side commit, and a
 * sender here.
 *
 * ## batching
 *
 * pointer moves and wheel deltas coalesce into one message per tick —
 * `getCoalescedEvents()` on a 1000 Hz mouse would otherwise put ~17 messages
 * per frame on the wire for no extra fidelity. discrete events (keys, buttons)
 * are never delayed: they flush the pending moves first, so ordering with the
 * moves is preserved, and then go immediately.
 *
 * ## stuck keys
 *
 * the top user-visible bug in this class of product. every key and button we
 * believe is held is released on blur, on `visibilitychange`, on pointer-lock
 * exit and on detach — exactly once each, because the held sets are cleared as
 * the releases are queued.
 */

import type { MachineOsFamily } from '@/lib/machineOs';
import {
  applyModifierMapping,
  isInjectable,
  isMacViewer,
  type ModifierMapping,
} from '@/lib/swoop/keymap';
import { encodeInputMessage, type InputMessage } from '@/lib/swoop/protocol';

export type InputMode = 'scancode' | 'text';

/** an input message before it takes its place in the channel's sequence. */
type Unsequenced<T> = T extends InputMessage ? Omit<T, 'seq'> : never;
type PendingInput = Unsequenced<InputMessage>;

/**
 * keys left to the browser: not prevented, and not sent to the host. f11 and
 * f12 are the user's way back out of a full-window stage and into devtools, and
 * no amount of `preventDefault` takes f12 from chrome anyway.
 *
 * escape is deliberately NOT in this list. it is forwarded to the host, but it
 * is also never `preventDefault`ed, because browsers ignore that for the
 * hold-to-exit gesture that leaves pointer lock and fullscreen.
 */
const BROWSER_RESERVED: ReadonlySet<string> = new Set(['F11', 'F12']);

/** an escape seen this recently was the one that dropped pointer lock. */
const ESCAPE_SYNTH_WINDOW_MS = 250;

/** a second escape tap this soon after the first is the keyboard leaving the stage. */
const ESCAPE_TWICE_WINDOW_MS = 500;

const TICK_FALLBACK_MS = 16;

export interface InputCaptureOptions {
  /** the stage element. it must be focusable for key events to arrive. */
  target: HTMLElement;
  /** one encoded message. wave 5 passes the `swoop-input` channel's `send`. */
  send: (payload: string) => void;
  /** the machine's system. defaults to windows, as a machine that reports none is. */
  hostOs?: MachineOsFamily;
  /** defaults to what the browser says about itself. */
  viewerIsMac?: boolean;
  /** defaults to `'swap'`. */
  modifierMapping?: ModifierMapping;
  /**
   * the box absolute moves normalise against, in client coordinates. defaults
   * to the target's rect; the stage passes the letterboxed video rect once it
   * knows it, so `0..1` means the selected display and not the black bars.
   */
  rect?: () => { left: number; top: number; width: number; height: number };
  /** tick source for the batched flush. defaults to rAF. */
  schedule?: (tick: () => void) => () => void;
  /** viewer clock in microseconds. defaults to the document timeline. */
  nowUs?: () => number;
}

export interface InputCapture {
  readonly mode: InputMode;
  readonly pointerLocked: boolean;
  /**
   * the pointer is off the picture — over the letterbox bars or off the stage —
   * with no button held, so nothing reaches the host and the page shows the
   * local pointer instead of the machine's.
   */
  readonly pointerOutside: boolean;
  /** called whenever `pointerOutside` changes; returns the unsubscribe. */
  onPointerOutsideChange(listener: () => void): () => void;
  /**
   * the keyboard's way off the stage, which otherwise sends every key — tab
   * included — to the host. a second tap of escape within half a second, with
   * nothing fullscreen, is not sent: what is held is released and the listener
   * moves focus. the first tap still reaches the host, so escape there keeps
   * working. fullscreen keeps its own exit, the browser's escape hold. with no
   * listener, every escape goes to the host as before. returns the unsubscribe.
   */
  onEscapeTwice(listener: () => void): () => void;
  /**
   * the machine's system and the mapping, together: the capture is attached
   * before the page has read the system off the machine document, and the
   * keyboard menu owns the mapping from then on.
   */
  setModifierMapping(hostOs: MachineOsFamily, mapping: ModifierMapping): void;
  /**
   * relative mode. `unadjustedMovement` asks for raw deltas with no pointer
   * acceleration, which is the whole point for a remote desktop. whether the
   * browser prompts for this is **unmeasured** (spike 2.12 drove it through
   * automation, which sets the permission state and so hides the prompt), so a
   * refusal is a normal outcome here: it resolves false, absolute mode keeps
   * working, and the caller says so in the toolbar. call it from a user
   * gesture, together with fullscreen and keyboard lock.
   */
  requestPointerLock(): Promise<boolean>;
  exitPointerLock(): void;
  /** send the batched moves now. */
  flush(): void;
  /** release everything held. idempotent. */
  releaseAll(): void;
  /**
   * a combination the browser would keep for itself, pressed in order and
   * released in reverse, through the same queue as a typed key so it takes
   * its place in the channel's sequence. it is sent as written: the menu
   * already names the host's own keys, so the modifier mapping never applies.
   */
  pressChord(codes: readonly string[]): void;
  /**
   * a modifier held down until the next typed key's release, for the super
   * key outside keyboard lock, which the viewer's own system keeps for itself.
   * sent as written, never through the mapping; released with everything
   * else by `releaseAll`.
   */
  holdNextKey(code: string): void;
  detach(): void;
}

const nowMs = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

function defaultNowUs(): number {
  if (typeof performance === 'undefined' || typeof performance.timeOrigin !== 'number') {
    return Date.now() * 1000;
  }
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function defaultSchedule(tick: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setInterval(tick, TICK_FALLBACK_MS);
    return () => clearInterval(timer);
  }
  let handle = requestAnimationFrame(function loop() {
    tick();
    handle = requestAnimationFrame(loop);
  });
  return () => cancelAnimationFrame(handle);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const wheelMode = (deltaMode: number): 'pixel' | 'line' | 'page' =>
  deltaMode === 1 ? 'line' : deltaMode === 2 ? 'page' : 'pixel';

export function attachInputCapture(options: InputCaptureOptions): InputCapture {
  const { target, send } = options;
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  const nowUs = options.nowUs ?? defaultNowUs;
  const rect = options.rect ?? (() => target.getBoundingClientRect());

  let hostOs = options.hostOs ?? 'windows';
  const viewerIsMac = options.viewerIsMac ?? isMacViewer();
  let modifierMapping = options.modifierMapping ?? 'swap';
  let seq = 1;
  let composing = false;
  let locked = false;
  let exitRequested = false;
  let lastEscapeMs = -Infinity;
  let lastEscapeTapMs = -Infinity;
  let detached = false;
  const escapeTwiceListeners = new Set<() => void>();

  const queue: InputMessage[] = [];
  const heldKeys = new Set<string>();
  const heldButtons = new Set<number>();
  /** the modifier `holdNextKey` has down, until the next key's release. */
  let armed: string | null = null;
  /** whether that next key has gone down: the release of an earlier key is not its release. */
  let armedKeyDown = false;

  // off the picture — over its letterbox bars or off the stage — with nothing
  // held. nothing reaches the host from there: a move pinned to the edge drags
  // the machine's pointer along it, and a click in the bars lands on whatever
  // sits at the screen's edge.
  let outside = false;
  const outsideListeners = new Set<() => void>();
  const setOutside = (value: boolean): void => {
    if (value === outside) return;
    outside = value;
    for (const listener of outsideListeners) listener();
  };

  /** a client point in the picture's `0..1`, or null while there is no picture box. */
  const onPicture = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const box = rect();
    if (box.width <= 0 || box.height <= 0) return null;
    return { x: (clientX - box.left) / box.width, y: (clientY - box.top) / box.height };
  };
  const inPicture = (point: { x: number; y: number } | null): point is { x: number; y: number } =>
    point !== null && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;

  /**
   * one message in, coalescing with the tail when both describe motion of the
   * same kind. the sequence number is taken at push time, so a coalesced move
   * never burns one and the wire stays gap-free.
   */
  const enqueue = (message: PendingInput): void => {
    const last = queue[queue.length - 1];
    if (last) {
      if (last.t === 'm' && message.t === 'm') {
        last.x = message.x;
        last.y = message.y;
        last.tsUs = message.tsUs;
        return;
      }
      if (last.t === 'mr' && message.t === 'mr') {
        last.dx += message.dx;
        last.dy += message.dy;
        last.tsUs = message.tsUs;
        return;
      }
      if (last.t === 'w' && message.t === 'w' && last.mode === message.mode) {
        last.dx += message.dx;
        last.dy += message.dy;
        last.tsUs = message.tsUs;
        return;
      }
    }
    // `PendingInput & { seq }` is exactly `InputMessage`; the compiler cannot
    // see that through a spread of a union.
    queue.push({ ...message, seq: seq++ } as InputMessage);
  };

  const flush = (): void => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    for (const message of batch) send(encodeInputMessage(message));
  };

  /** discrete events do not wait for the tick, but must not overtake a move. */
  const enqueueNow = (message: PendingInput): void => {
    enqueue(message);
    flush();
  };

  const key = (code: string, down: boolean, tsUs: number): void =>
    enqueueNow({ t: 'k', code, down, tsUs });

  const releaseButtons = (): void => {
    const tsUs = nowUs();
    for (const button of heldButtons) enqueue({ t: 'b', button, down: false, tsUs });
    heldButtons.clear();
  };

  const releaseAll = (): void => {
    const tsUs = nowUs();
    for (const code of heldKeys) enqueue({ t: 'k', code, down: false, tsUs });
    heldKeys.clear();
    armed = null;
    releaseButtons();
    flush();
  };

  const holdNextKey = (code: string): void => {
    if (armed === code) return;
    armed = code;
    armedKeyDown = false;
    heldKeys.add(code);
    key(code, true, nowUs());
  };

  const releaseArmed = (): void => {
    if (armed === null) return;
    const code = armed;
    armed = null;
    if (heldKeys.delete(code)) key(code, false, nowUs());
  };

  const pressChord = (codes: readonly string[]): void => {
    const tsUs = nowUs();
    for (const code of codes) enqueue({ t: 'k', code, down: true, tsUs });
    for (let i = codes.length - 1; i >= 0; i -= 1) enqueue({ t: 'k', code: codes[i], down: false, tsUs });
    flush();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (composing || event.isComposing) return;
    if (BROWSER_RESERVED.has(event.code)) return;
    if (event.code === 'Escape') {
      lastEscapeMs = nowMs();
      // a held escape repeats; only separate taps count towards leaving.
      if (!event.repeat) {
        const leaving =
          escapeTwiceListeners.size > 0 &&
          !doc.fullscreenElement &&
          lastEscapeMs - lastEscapeTapMs <= ESCAPE_TWICE_WINDOW_MS;
        lastEscapeTapMs = leaving ? -Infinity : lastEscapeMs;
        if (leaving) {
          // focus is about to go, and the keyups with it.
          releaseAll();
          for (const listener of escapeTwiceListeners) listener();
          return;
        }
      }
    } else {
      event.preventDefault();
    }

    const code = applyModifierMapping(event.code, hostOs, viewerIsMac, modifierMapping);
    if (!isInjectable(code)) return;
    // auto-repeat is forwarded: SendInput injects discrete events, so nothing
    // on the host side repeats a held key for us.
    heldKeys.add(code);
    key(code, true, nowUs());
    if (armed !== null && code !== armed) armedKeyDown = true;
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (BROWSER_RESERVED.has(event.code)) return;
    if (event.code !== 'Escape') event.preventDefault();

    const code = applyModifierMapping(event.code, hostOs, viewerIsMac, modifierMapping);
    if (!isInjectable(code)) return;
    // a key we never saw go down still gets its release: the host tracks state,
    // and a spurious release is cheaper than a stuck key.
    heldKeys.delete(code);
    key(code, false, nowUs());
    if (armedKeyDown && code !== armed) releaseArmed();
  };

  const onPointerMove = (event: PointerEvent): void => {
    const events =
      typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    const samples = events.length > 0 ? events : [event];
    const tsUs = nowUs();

    if (locked) {
      let dx = 0;
      let dy = 0;
      for (const sample of samples) {
        dx += sample.movementX;
        dy += sample.movementY;
      }
      if (dx === 0 && dy === 0) return;
      enqueue({ t: 'mr', dx, dy, tsUs });
      return;
    }

    const latest = samples[samples.length - 1];
    const point = onPicture(latest.clientX, latest.clientY);
    if (point === null) return;
    // a drag keeps going past the picture, pinned to its edge; a pointer that
    // only wanders over the bars moves nothing on the host.
    if (heldButtons.size === 0 && !inPicture(point)) {
      setOutside(true);
      return;
    }
    setOutside(false);
    enqueue({ t: 'm', x: clamp01(point.x), y: clamp01(point.y), tsUs });
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button < 0 || event.button > 4) return;
    // under pointer lock the pointer has no position, only the machine's.
    if (!locked && !inPicture(onPicture(event.clientX, event.clientY))) return;
    event.preventDefault();
    // keep the release even if the drag leaves the element, or the button is
    // held on the host forever.
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // a pointer that has already been released; nothing to capture.
      }
    }
    heldButtons.add(event.button);
    enqueueNow({ t: 'b', button: event.button, down: true, tsUs: nowUs() });
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (event.button < 0 || event.button > 4) return;
    // only a press the host was sent: one in the bars never was, and one
    // already released on blur or cancel was released there.
    if (!heldButtons.delete(event.button)) return;
    event.preventDefault();
    enqueueNow({ t: 'b', button: event.button, down: false, tsUs: nowUs() });
  };

  // off the stage is off the picture, unless a drag carries the pointer there.
  const onPointerLeave = (): void => {
    if (heldButtons.size === 0) setOutside(true);
  };

  // a cancelled pointer never sends its up, and the button would stay down on
  // the host. its `button` is -1, so it cannot go through the pointerup path.
  const onPointerCancel = (): void => {
    releaseButtons();
    flush();
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (!locked && !inPicture(onPicture(event.clientX, event.clientY))) return;
    enqueue({
      t: 'w',
      dx: event.deltaX,
      dy: event.deltaY,
      mode: wheelMode(event.deltaMode),
      tsUs: nowUs(),
    });
  };

  const onContextMenu = (event: MouseEvent): void => event.preventDefault();
  const onCompositionStart = (): void => {
    composing = true;
    // the composition owns the keyboard from here; release what we were holding
    // so no modifier is left down on the host for its duration.
    releaseAll();
  };
  const onCompositionEnd = (): void => {
    composing = false;
  };

  const onBlur = (): void => releaseAll();
  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'hidden') releaseAll();
  };

  const onPointerLockChange = (): void => {
    const nowLocked = doc.pointerLockElement === target;
    if (nowLocked === locked) return;
    locked = nowLocked;
    if (locked) {
      setOutside(false);
      return;
    }

    flush();
    // chrome swallows the escape keydown that drops pointer lock, so the host
    // would never see it. forward a synthetic one — unless we asked for the
    // exit ourselves, or the browser did dispatch the key (firefox does).
    if (!exitRequested && nowMs() - lastEscapeMs > ESCAPE_SYNTH_WINDOW_MS) {
      const tsUs = nowUs();
      enqueue({ t: 'k', code: 'Escape', down: true, tsUs });
      enqueue({ t: 'k', code: 'Escape', down: false, tsUs });
      flush();
    }
    exitRequested = false;
    releaseAll();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointerleave', onPointerLeave);
  target.addEventListener('pointercancel', onPointerCancel);
  target.addEventListener('wheel', onWheel, { passive: false });
  target.addEventListener('contextmenu', onContextMenu);
  target.addEventListener('compositionstart', onCompositionStart);
  target.addEventListener('compositionend', onCompositionEnd);
  doc.addEventListener('visibilitychange', onVisibilityChange);
  doc.addEventListener('pointerlockchange', onPointerLockChange);
  view?.addEventListener('blur', onBlur);

  const cancelSchedule = (options.schedule ?? defaultSchedule)(flush);

  return {
    get mode(): InputMode {
      return composing ? 'text' : 'scancode';
    },
    get pointerLocked(): boolean {
      return locked;
    },
    get pointerOutside(): boolean {
      return outside;
    },

    onPointerOutsideChange(listener: () => void): () => void {
      outsideListeners.add(listener);
      return () => {
        outsideListeners.delete(listener);
      };
    },

    onEscapeTwice(listener: () => void): () => void {
      escapeTwiceListeners.add(listener);
      return () => {
        escapeTwiceListeners.delete(listener);
      };
    },

    setModifierMapping(nextHostOs: MachineOsFamily, mapping: ModifierMapping): void {
      if (nextHostOs === hostOs && mapping === modifierMapping) return;
      // the emitted code changes under us, so anything held would never be
      // released under the code the host has down.
      releaseAll();
      hostOs = nextHostOs;
      modifierMapping = mapping;
    },

    async requestPointerLock(): Promise<boolean> {
      const element = target as HTMLElement & {
        requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
      };
      try {
        await element.requestPointerLock({ unadjustedMovement: true });
        return true;
      } catch {
        // firefox and safari reject the options object rather than ignoring the
        // member; a locked pointer with acceleration beats no lock at all.
        try {
          await element.requestPointerLock();
          return true;
        } catch {
          return false;
        }
      }
    },

    exitPointerLock(): void {
      exitRequested = true;
      doc.exitPointerLock?.();
    },

    flush,
    releaseAll,
    pressChord,
    holdNextKey,

    detach(): void {
      if (detached) return;
      detached = true;
      releaseAll();
      cancelSchedule();
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerdown', onPointerDown);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointerleave', onPointerLeave);
      target.removeEventListener('pointercancel', onPointerCancel);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', onContextMenu);
      target.removeEventListener('compositionstart', onCompositionStart);
      target.removeEventListener('compositionend', onCompositionEnd);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      doc.removeEventListener('pointerlockchange', onPointerLockChange);
      view?.removeEventListener('blur', onBlur);
    },
  };
}
