/**
 * swoop on a touch screen: what a finger means, as the host takes it.
 *
 * `input.ts` leaves touch alone. a finger has no hover, and what a touch means
 * is the gesture's, not its pointer event's: a finger that lands may be a tap,
 * the start of a drag, a hold, or the first of two. so nothing is pressed
 * until the gesture says which, and this drives the capture's touch half.
 *
 * | gesture | sends |
 * |---|---|
 * | tap | a move there, a click |
 * | a second tap soon after and near the first | a click at the first's point, so the host counts a double-click |
 * | hold, slide, lift | the magnifier, with the pointer following the finger; lift clicks there, lift off the picture clicks nothing |
 * | drag | the left button, down where the finger landed, up where it lifts |
 * | two-finger tap | a right-click at the first finger |
 * | two-finger drag | the wheel; what is under the fingers follows them |
 * | pinch | nothing: the picture zooms on this screen, and the fingers' travel pans it |
 *
 * two fingers are a pinch when their spread changes more than their midpoint
 * travels by the time one is past the slop, a scroll otherwise, and stay that
 * until they lift. a finger beyond the ones a gesture uses is ignored. a
 * watcher's fingers send nothing; they still pinch. nor does a gesture that
 * starts on the bars around the picture, as nothing a mouse does there
 * reaches the machine; a pinch there still zooms.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import { watched, type InputCapture } from '@/lib/swoop/input';
import {
  NO_ZOOM,
  clampZoom,
  distance,
  fitBox,
  midpoint,
  pinchZoom,
  zoomTransform,
  type Box,
  type Point,
  type Size,
  type ZoomState,
} from '@/lib/swoop/zoom';

/** css pixels a finger can wander and still be a tap. */
export const SLOP_PX = 10;
export const HOLD_MS = 400;
export const TWO_FINGER_TAP_MS = 300;
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 24;
const HAPTIC_MS = 10;

export type TouchCapture = Pick<InputCapture, 'pointAt' | 'press' | 'release' | 'scroll'>;

/** the magnifier: whether it is up, and the finger under it in client coordinates. */
export interface AimState {
  active: boolean;
  x: number;
  y: number;
}

export const NO_AIM: AimState = { active: false, x: 0, y: 0 };

export interface GestureDeps {
  /** null for a watcher, whose touches send nothing. */
  capture: TouchCapture | null;
  /** where the picture is shown (the video's layout box) starts, in client coordinates: a pinch works in its own. */
  stageOrigin(): Point;
  zoom: {
    get(): ZoomState;
    set(next: ZoomState): void;
    /** the picture's box in the element, untransformed. */
    picture(): Box;
    /** the size of where the picture is shown, which a zoom keeps it covering. */
    stage(): Size;
  };
  /** css pixels on screen per machine pixel, the zoom included; 0 before a picture. */
  pictureScale(): number;
  haptic(): void;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onAim(state: AimState): void;
}

export interface Gestures {
  down(id: number, x: number, y: number): void;
  move(id: number, x: number, y: number): void;
  up(id: number, x: number, y: number): void;
  cancel(id: number): void;
  /** let go of anything held. */
  dispose(): void;
}

type Phase =
  | { kind: 'idle' }
  // `start` is where the pointer went, the first tap's point on a double-tap;
  // `landed` is the finger's own, which the slop is measured from; `onPicture`
  // is false for a finger that landed on the bars around the picture
  | { kind: 'pending'; id: number; start: Point; landed: Point; onPicture: boolean; timer: unknown }
  | { kind: 'aim'; id: number }
  | { kind: 'drag'; id: number }
  | { kind: 'pair'; a: number; b: number; a0: Point; b0: Point; at: number; first: Point }
  | { kind: 'scroll'; a: number; b: number; last: Point }
  | { kind: 'pinch'; a: number; b: number; start: { state: ZoomState; a: Point; b: Point } }
  // a gesture that is over, waiting on fingers it left down
  | { kind: 'spent' };

/** whether a finger lifting or cancelling is one the gesture is made of. */
const owns = (phase: Phase, id: number): boolean => {
  switch (phase.kind) {
    case 'pending':
    case 'aim':
    case 'drag':
      return phase.id === id;
    case 'pair':
    case 'scroll':
    case 'pinch':
      return phase.a === id || phase.b === id;
    default:
      return false;
  }
};

export function createGestures(deps: GestureDeps): Gestures {
  const { capture } = deps;
  /** every finger down, in client coordinates. */
  const fingers = new Map<number, Point>();
  let phase: Phase = { kind: 'idle' };
  let lastTap: { at: number; point: Point } | null = null;

  const local = (point: Point): Point => {
    const origin = deps.stageOrigin();
    return { x: point.x - origin.x, y: point.y - origin.y };
  };
  const finger = (id: number): Point => fingers.get(id) ?? { x: 0, y: 0 };
  const click = (button: number): void => {
    capture?.press(button);
    capture?.release(button);
  };
  const settle = (): void => {
    phase = fingers.size === 0 ? { kind: 'idle' } : { kind: 'spent' };
  };
  /** what a gesture holds, let go when it ends without a lift: its timer, the magnifier, the button. */
  const letGo = (): void => {
    if (phase.kind === 'pending') deps.clearTimer(phase.timer);
    if (phase.kind === 'aim') deps.onAim(NO_AIM);
    if (phase.kind === 'drag') capture?.release(0);
  };

  const onHold = (): void => {
    if (phase.kind !== 'pending') return;
    // a watcher has nothing to aim
    if (!capture) {
      phase = { kind: 'spent' };
      return;
    }
    const at = finger(phase.id);
    phase = { kind: 'aim', id: phase.id };
    capture.pointAt(at.x, at.y);
    deps.onAim({ active: true, x: at.x, y: at.y });
    deps.haptic();
  };

  const scrollBy = (current: { a: number; b: number; last: Point }): void => {
    const now = midpoint(finger(current.a), finger(current.b));
    const scale = deps.pictureScale();
    // in machine pixels, the way a trackpad's wheel is: the host turns 100 into a notch
    if (scale > 0) capture?.scroll(-(now.x - current.last.x) / scale, -(now.y - current.last.y) / scale);
    current.last = now;
  };

  const pinchBy = (current: { a: number; b: number; start: { state: ZoomState; a: Point; b: Point } }): void => {
    const now = { a: local(finger(current.a)), b: local(finger(current.b)) };
    deps.zoom.set(pinchZoom(current.start, now, deps.zoom.picture(), deps.zoom.stage()));
  };

  return {
    down(id, x, y) {
      const point = { x, y };
      fingers.set(id, point);
      if (phase.kind === 'idle') {
        const again =
          lastTap !== null &&
          deps.now() - lastTap.at <= DOUBLE_TAP_MS &&
          distance(lastTap.point, point) <= DOUBLE_TAP_PX;
        const start = again && lastTap ? lastTap.point : point;
        const onPicture = capture?.pointAt(start.x, start.y) ?? false;
        phase = { kind: 'pending', id, start, landed: point, onPicture, timer: deps.setTimer(onHold, HOLD_MS) };
        return;
      }
      if (phase.kind === 'pending') {
        deps.clearTimer(phase.timer);
        phase = {
          kind: 'pair',
          a: phase.id,
          b: id,
          a0: finger(phase.id),
          b0: point,
          at: deps.now(),
          first: phase.start,
        };
      }
    },

    move(id, x, y) {
      if (!fingers.has(id)) return;
      fingers.set(id, { x, y });
      switch (phase.kind) {
        case 'pending': {
          if (id !== phase.id || distance({ x, y }, phase.landed) <= SLOP_PX) return;
          deps.clearTimer(phase.timer);
          // a watcher's drag sends nothing, and nor does one from the bars, as a mouse's would not
          if (!capture || !phase.onPicture) {
            phase = { kind: 'spent' };
            return;
          }
          // down where the finger landed, where the pointer already is
          capture.press(0);
          capture.pointAt(x, y);
          phase = { kind: 'drag', id };
          return;
        }
        case 'aim':
          if (id !== phase.id) return;
          capture?.pointAt(x, y);
          deps.onAim({ active: true, x, y });
          return;
        case 'drag':
          if (id === phase.id) capture?.pointAt(x, y);
          return;
        case 'pair': {
          const a = finger(phase.a);
          const b = finger(phase.b);
          if (distance(a, phase.a0) <= SLOP_PX && distance(b, phase.b0) <= SLOP_PX) return;
          const spreadChange = Math.abs(distance(a, b) - distance(phase.a0, phase.b0));
          const travel = distance(midpoint(a, b), midpoint(phase.a0, phase.b0));
          if (spreadChange > travel) {
            const pinch = {
              kind: 'pinch' as const,
              a: phase.a,
              b: phase.b,
              start: { state: deps.zoom.get(), a: local(phase.a0), b: local(phase.b0) },
            };
            phase = pinch;
            pinchBy(pinch);
          } else {
            // the wheel turns what is under the pointer, so the pointer goes under the fingers;
            // fingers on the bars scroll nothing
            const last = midpoint(phase.a0, phase.b0);
            if (!capture?.pointAt(last.x, last.y)) {
              phase = { kind: 'spent' };
              return;
            }
            const scroll = { kind: 'scroll' as const, a: phase.a, b: phase.b, last };
            phase = scroll;
            scrollBy(scroll);
          }
          return;
        }
        case 'scroll':
          if (owns(phase, id)) scrollBy(phase);
          return;
        case 'pinch':
          if (owns(phase, id)) pinchBy(phase);
          return;
        default:
          return;
      }
    },

    up(id, x, y) {
      if (!fingers.has(id)) return;
      switch (phase.kind) {
        case 'pending':
          deps.clearTimer(phase.timer);
          if (!phase.onPicture) break;
          click(0);
          lastTap = { at: deps.now(), point: phase.start };
          break;
        case 'aim':
          if (id !== phase.id) break;
          deps.onAim(NO_AIM);
          // lifted off the picture is a change of mind
          if (capture?.pointAt(x, y)) click(0);
          break;
        case 'drag':
          if (id === phase.id) capture?.release(0);
          break;
        case 'pair':
          if (capture && deps.now() - phase.at <= TWO_FINGER_TAP_MS && capture.pointAt(phase.first.x, phase.first.y)) {
            click(2);
            deps.haptic();
          }
          break;
        default:
          break;
      }
      const ended = owns(phase, id) || phase.kind === 'spent';
      fingers.delete(id);
      if (ended) settle();
    },

    cancel(id) {
      if (!fingers.has(id)) return;
      const ended = owns(phase, id) || phase.kind === 'spent';
      if (ended) letGo();
      fingers.delete(id);
      if (ended) settle();
    },

    dispose() {
      letGo();
      fingers.clear();
      phase = { kind: 'idle' };
    },
  };
}

export interface SwoopTouch {
  zoom: { get(): ZoomState; subscribe(listener: () => void): () => void; reset(): void };
  aim: { get(): AimState; subscribe(listener: () => void): () => void };
}

const touches = new WeakMap<SwoopSession, SwoopTouch>();

/** the live touch layer, or null before attach. */
export const swoopTouch = (session: SwoopSession | null): SwoopTouch | null =>
  session ? (touches.get(session) ?? null) : null;

/**
 * the touch layer on a session's stage. `features.ts` hands it the input
 * capture, which is null for a watcher.
 */
export function attach(session: SwoopSession, capture: InputCapture | null): SwoopDetach {
  const { stage, video } = session;
  const zoom = watched<ZoomState>(NO_ZOOM);
  const aim = watched<AimState>(NO_AIM);

  // the layout box, which the transform does not change
  const picture = (): Box =>
    fitBox(
      { width: video.offsetWidth, height: video.offsetHeight },
      { width: video.videoWidth, height: video.videoHeight },
    );
  // what the picture is shown in: the video's layout box, which is the stage's
  // but for what the stage pads out from under the phone keyboard
  const area = (): Size => ({ width: video.offsetWidth, height: video.offsetHeight });
  // the transform before the word: a listener measures the picture's box as it is told
  const setZoom = (next: ZoomState): void => {
    video.style.transformOrigin = '0 0';
    video.style.transform = zoomTransform(next);
    zoom.set(next);
  };

  const gestures = createGestures({
    capture,
    // the video's layout origin, which its transform is about: the stage is its offset parent
    stageOrigin: () => {
      const box = stage.getBoundingClientRect();
      return { x: box.left + video.offsetLeft, y: box.top + video.offsetTop };
    },
    zoom: { get: zoom.get, set: setZoom, picture, stage: area },
    pictureScale: () => (video.videoWidth > 0 ? session.contentRect().width / video.videoWidth : 0),
    haptic: () => {
      // android only: an iphone has no vibration a page may use
      if (typeof navigator.vibrate === 'function') navigator.vibrate(HAPTIC_MS);
    },
    now: () => performance.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onAim: aim.set,
  });

  // the picture's own touches: the stage's controls (the fit pill, the key
  // row) keep theirs as plain taps
  const onPicture = (event: Event): boolean => event.target === video || event.target === stage;

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch' || !onPicture(event)) return;
    // a finger that slides off the stage still lifts here
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // a pointer already gone; nothing to capture
    }
    gestures.down(event.pointerId, event.clientX, event.clientY);
  };
  const onMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') gestures.move(event.pointerId, event.clientX, event.clientY);
  };
  const onUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') gestures.up(event.pointerId, event.clientX, event.clientY);
  };
  const onCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') gestures.cancel(event.pointerId);
  };
  // the browser's own reading of a touch on the picture: the mouse events and
  // the click after it, which would move focus off the phone keyboard
  const onTouch = (event: TouchEvent): void => {
    if (onPicture(event)) event.preventDefault();
  };
  // safari's pinch, which would zoom the page instead of the picture
  const onGesture = (event: Event): void => event.preventDefault();
  // the picture's box moves with the video's size, and the zoom with it
  const reclamp = (): void => setZoom(clampZoom(zoom.get(), picture(), area()));
  // the keyboard's padding resizes the video with no window resize to say so
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(reclamp) : null;

  stage.addEventListener('pointerdown', onDown);
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onCancel);
  stage.addEventListener('touchstart', onTouch, { passive: false });
  stage.addEventListener('touchend', onTouch, { passive: false });
  stage.addEventListener('gesturestart', onGesture);
  window.addEventListener('resize', reclamp);
  document.addEventListener('fullscreenchange', reclamp);
  video.addEventListener('resize', reclamp);
  resizes?.observe(video);

  touches.set(session, {
    zoom: { get: zoom.get, subscribe: zoom.subscribe, reset: () => setZoom(NO_ZOOM) },
    aim: { get: aim.get, subscribe: aim.subscribe },
  });

  return () => {
    touches.delete(session);
    gestures.dispose();
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onCancel);
    stage.removeEventListener('touchstart', onTouch);
    stage.removeEventListener('touchend', onTouch);
    stage.removeEventListener('gesturestart', onGesture);
    window.removeEventListener('resize', reclamp);
    document.removeEventListener('fullscreenchange', reclamp);
    video.removeEventListener('resize', reclamp);
    resizes?.disconnect();
    video.style.removeProperty('transform');
    video.style.removeProperty('transform-origin');
  };
}
