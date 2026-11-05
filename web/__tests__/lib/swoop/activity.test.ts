/**
 * @jest-environment jsdom
 */

/**
 * what lights a viewer's pill: another controller's moves, from the host's
 * `vpos` through presence, and this tab's own moves and presses, from its input
 * capture. the lights run on this browser's clock, faked here.
 */

import { ACTIVITY_CLICK_MS, ACTIVITY_MOVE_MS, NO_ACTIVITY, attach, swoopActivity } from '@/lib/swoop/activity';
import type { SwoopSession } from '@/lib/swoop/features';
import { attachInputCapture } from '@/lib/swoop/input';
import { attach as attachPresence } from '@/lib/swoop/presence';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const ROSTER = JSON.stringify({
  t: 'roster',
  viewers: [
    { id: 'viewer-a', name: 'uid_a', ctl: true },
    { id: 'viewer-b', name: 'uid_b', ctl: true },
    { id: 'viewer-me', name: 'uid_me', ctl: true },
  ],
  tsUs: 1,
});

// the host's clock, which is nowhere near this browser's: a light never reads it
const vpos = (viewer: string) => JSON.stringify({ t: 'vpos', viewer, x: 0.5, y: 0.5, tsUs: 1 });

/** jsdom has no PointerEvent constructor, so build the surface the capture reads. */
function pointerEvent(type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 100, clientY: 50, button: 0, pointerId: 1, getModifierState: () => false });
  return event;
}

let detachAll: (() => void) | null = null;

/** a session as it attaches: this tab's input capture, then activity, then presence, with a roster in. */
function harness() {
  const handlers = new Map<string, (data: unknown) => void>();
  const session = {
    viewerId: 'viewer-me',
    onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
      handlers.set(label, incoming);
      return () => {
        handlers.delete(label);
      };
    },
  } as unknown as SwoopSession;
  const stage = document.createElement('div');
  document.body.appendChild(stage);
  const capture = attachInputCapture({
    target: stage,
    send: () => {},
    hostOs: 'windows',
    viewerIsMac: false,
    rect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    schedule: () => () => {},
  });
  const detachActivity = attach(session, capture);
  const detachPresence = attachPresence(session);
  detachAll = () => {
    detachPresence();
    detachActivity();
    capture.detach();
    stage.remove();
  };
  handlers.get('swoop-control')?.(ROSTER);
  const store = swoopActivity(session)!;
  return {
    session,
    store,
    detachActivity,
    of: (viewer: string) => store.get().get(viewer) ?? 'idle',
    moves: (viewer: string) => handlers.get('swoop-cursor')?.(vpos(viewer)),
    pointer: (type: string) => stage.dispatchEvent(pointerEvent(type)),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  detachAll?.();
  detachAll = null;
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('swoop viewer activity', () => {
  it('has nobody lit and no timer before anyone moves, and a viewer never seen is idle', () => {
    const h = harness();
    expect(h.store.get()).toBe(NO_ACTIVITY);
    // a position for somebody the roster has not named lights nobody
    h.moves('viewer-x');
    expect(h.of('viewer-x')).toBe('idle');
    expect(h.of('viewer-a')).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it("lights another controller as moving for 400 ms after their vpos, on this browser's clock", () => {
    const h = harness();
    h.moves('viewer-a');
    expect(h.of('viewer-a')).toBe('moving');
    expect(h.of('viewer-b')).toBe('idle');
    jest.advanceTimersByTime(ACTIVITY_MOVE_MS - 1);
    expect(h.of('viewer-a')).toBe('moving');
    jest.advanceTimersByTime(1);
    expect(h.of('viewer-a')).toBe('idle');
    expect(h.store.get()).toBe(NO_ACTIVITY);
  });

  it('stays lit 400 ms past the last move, on one timer and two changes however fast the moves come', () => {
    const h = harness();
    let changes = 0;
    h.store.subscribe(() => {
      changes += 1;
    });
    // 30 moves a frame apart; the last lands at 464 ms and the loop ends at 480
    for (let i = 0; i < 30; i += 1) {
      h.moves('viewer-a');
      jest.advanceTimersByTime(16);
      expect(jest.getTimerCount()).toBe(1);
    }
    expect(changes).toBe(1);
    jest.advanceTimersByTime(ACTIVITY_MOVE_MS - 16 - 1);
    expect(h.of('viewer-a')).toBe('moving');
    jest.advanceTimersByTime(1);
    expect(h.of('viewer-a')).toBe('idle');
    expect(changes).toBe(2);
    // and nothing left running while nobody is lit
    expect(jest.getTimerCount()).toBe(0);
  });

  it('lights this tab as moving when its capture sends a move', () => {
    const h = harness();
    h.pointer('pointermove');
    expect(h.of('viewer-me')).toBe('moving');
    jest.advanceTimersByTime(ACTIVITY_MOVE_MS);
    expect(h.of('viewer-me')).toBe('idle');
  });

  it('lights this tab as clicking for 250 ms on a button down, over the move that came with it', () => {
    const h = harness();
    h.pointer('pointerdown');
    h.pointer('pointerup');
    expect(h.of('viewer-me')).toBe('clicking');
    jest.advanceTimersByTime(ACTIVITY_CLICK_MS - 1);
    expect(h.of('viewer-me')).toBe('clicking');
    jest.advanceTimersByTime(1);
    // the press moved the machine's pointer to where it landed, and that move is still lit
    expect(h.of('viewer-me')).toBe('moving');
    jest.advanceTimersByTime(ACTIVITY_MOVE_MS - ACTIVITY_CLICK_MS);
    expect(h.of('viewer-me')).toBe('idle');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps each viewer to their own light', () => {
    const h = harness();
    h.moves('viewer-a');
    h.pointer('pointerdown');
    h.pointer('pointerup');
    expect(h.store.get()).toEqual(
      new Map([
        ['viewer-a', 'moving'],
        ['viewer-me', 'clicking'],
      ]),
    );
  });

  it('puts every light out on detach, its timer with it', () => {
    const h = harness();
    h.moves('viewer-a');
    expect(jest.getTimerCount()).toBe(1);
    h.detachActivity();
    expect(jest.getTimerCount()).toBe(0);
    expect(swoopActivity(h.session)).toBeNull();
    // presence finds no store to light, and says nothing about it
    expect(() => h.moves('viewer-a')).not.toThrow();
  });
});
