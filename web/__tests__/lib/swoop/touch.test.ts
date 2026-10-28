/**
 * the gesture machine in `lib/swoop/touch.ts`, driven with a fake clock and a
 * capture that records what it is told: what each gesture sends the host, and
 * that a pinch sends nothing and zooms instead.
 */

import {
  DOUBLE_TAP_MS,
  HOLD_MS,
  SLOP_PX,
  TWO_FINGER_TAP_MS,
  createGestures,
  type AimState,
  type TouchCapture,
} from '@/lib/swoop/touch';
import { NO_ZOOM, type ZoomState } from '@/lib/swoop/zoom';

// a 400x200 stage at the client origin, wholly filled by a 2:1 picture
const STAGE = { width: 400, height: 200 };

function rig({ watcher = false, pictureScale = 0.5 } = {}) {
  const calls: string[] = [];
  let clock = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  let zoom: ZoomState = NO_ZOOM;
  const aims: AimState[] = [];
  let haptics = 0;

  const capture: TouchCapture = {
    pointAt: (x, y) => {
      // the picture is the whole stage
      const on = x >= 0 && x <= STAGE.width && y >= 0 && y <= STAGE.height;
      if (on) calls.push(`move ${x},${y}`);
      return on;
    },
    press: (button) => calls.push(`down ${button}`),
    release: (button) => calls.push(`up ${button}`),
    scroll: (dx, dy) => calls.push(`wheel ${dx},${dy}`),
  };

  const gestures = createGestures({
    capture: watcher ? null : capture,
    stageOrigin: () => ({ x: 0, y: 0 }),
    zoom: {
      get: () => zoom,
      set: (next) => {
        zoom = next;
      },
      picture: () => ({ left: 0, top: 0, ...STAGE }),
      stage: () => STAGE,
    },
    pictureScale: () => pictureScale,
    haptic: () => {
      haptics += 1;
    },
    now: () => clock,
    setTimer: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    onAim: (state) => aims.push(state),
  });

  const advance = (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > clock) continue;
      timers.delete(id);
      timer.run();
    }
  };

  return {
    gestures,
    calls,
    advance,
    aims,
    zoom: () => zoom,
    haptics: () => haptics,
  };
}

describe('one finger', () => {
  it('taps: a move to where it landed, then a click there', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.advance(80);
    r.gestures.up(1, 101, 51);
    expect(r.calls).toEqual(['move 100,50', 'down 0', 'up 0']);
  });

  it('keeps a wobble within the slop a tap, at the point it landed', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.move(1, 100 + SLOP_PX - 1, 50);
    r.gestures.up(1, 100 + SLOP_PX - 1, 50);
    expect(r.calls).toEqual(['move 100,50', 'down 0', 'up 0']);
  });

  it('clicks a quick second tap nearby where the first did, so the host counts a double-click', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.up(1, 100, 50);
    r.advance(DOUBLE_TAP_MS - 50);
    r.gestures.down(2, 112, 58);
    r.gestures.up(2, 112, 58);
    expect(r.calls).toEqual(['move 100,50', 'down 0', 'up 0', 'move 100,50', 'down 0', 'up 0']);
  });

  it('takes a late second tap at its own point', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.up(1, 100, 50);
    r.advance(DOUBLE_TAP_MS + 1);
    r.gestures.down(2, 112, 58);
    r.gestures.up(2, 112, 58);
    expect(r.calls.slice(3)).toEqual(['move 112,58', 'down 0', 'up 0']);
  });

  it('drags: down where it landed, the moves, up where it lifts', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.move(1, 130, 50);
    r.gestures.move(1, 160, 60);
    r.gestures.up(1, 160, 60);
    expect(r.calls).toEqual(['move 100,50', 'down 0', 'move 130,50', 'move 160,60', 'up 0']);
  });

  it('holds: the magnifier comes up with a tick, the pointer follows, and the lift clicks there', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.advance(HOLD_MS);
    expect(r.aims.at(-1)).toEqual({ active: true, x: 100, y: 50 });
    expect(r.haptics()).toBe(1);
    r.gestures.move(1, 140, 70);
    r.gestures.up(1, 141, 71);
    expect(r.aims.at(-1)?.active).toBe(false);
    expect(r.calls).toEqual(['move 100,50', 'move 100,50', 'move 140,70', 'move 141,71', 'down 0', 'up 0']);
  });

  it('clicks nothing for a hold lifted off the picture', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.advance(HOLD_MS);
    r.gestures.move(1, 100, 300);
    r.gestures.up(1, 100, 300);
    expect(r.calls).not.toContain('down 0');
    expect(r.aims.at(-1)?.active).toBe(false);
  });

  it('releases a drag the browser cancels', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.move(1, 140, 50);
    r.gestures.cancel(1);
    expect(r.calls.at(-1)).toBe('up 0');
  });

  it('releases a drag still held when it is disposed', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.move(1, 140, 50);
    r.gestures.dispose();
    expect(r.calls.at(-1)).toBe('up 0');
  });
});

describe('two fingers', () => {
  it('right-clicks at the first finger for a quick two-finger tap, with a tick', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.down(2, 200, 50);
    r.advance(TWO_FINGER_TAP_MS - 100);
    r.gestures.up(2, 200, 50);
    r.gestures.up(1, 100, 50);
    expect(r.calls).toEqual(['move 100,50', 'move 100,50', 'down 2', 'up 2']);
    expect(r.haptics()).toBe(1);
  });

  it('sends nothing for two fingers held past the tap and lifted', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.down(2, 200, 50);
    r.advance(TWO_FINGER_TAP_MS + 1);
    r.gestures.up(2, 200, 50);
    r.gestures.up(1, 100, 50);
    expect(r.calls).toEqual(['move 100,50']);
  });

  it('scrolls for fingers moving together, the content following them, in machine pixels', () => {
    const r = rig({ pictureScale: 0.5 });
    r.gestures.down(1, 100, 100);
    r.gestures.down(2, 200, 100);
    r.gestures.move(1, 100, 80);
    r.gestures.move(2, 200, 80);
    r.gestures.up(1, 100, 80);
    r.gestures.up(2, 200, 80);
    // the pointer goes under the fingers, then up 20 css px each at half scale:
    // 40 machine px of wheel, in two halves
    expect(r.calls).toEqual(['move 100,100', 'move 150,100', 'wheel 0,20', 'wheel 0,20']);
    expect(r.zoom()).toEqual(NO_ZOOM);
  });

  it('pinches: the picture zooms under the fingers and the host is sent nothing', () => {
    const r = rig();
    r.gestures.down(1, 150, 100);
    r.gestures.down(2, 250, 100);
    r.gestures.move(1, 100, 100);
    r.gestures.move(2, 300, 100);
    expect(r.zoom().scale).toBeCloseTo(2);
    // the point under the midpoint (200, 100) stays there
    expect(r.zoom().x).toBeCloseTo(-200);
    expect(r.zoom().y).toBeCloseTo(-100);
    r.gestures.up(1, 100, 100);
    r.gestures.up(2, 300, 100);
    expect(r.calls).toEqual(['move 150,100']);
  });

  it('ignores a finger that lands on a drag under way', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.move(1, 140, 50);
    r.gestures.down(2, 300, 150);
    r.gestures.move(2, 320, 150);
    r.gestures.up(2, 320, 150);
    r.gestures.up(1, 150, 50);
    expect(r.calls).toEqual(['move 100,50', 'down 0', 'move 140,50', 'up 0']);
  });

  it('waits for every finger to lift before a new gesture starts', () => {
    const r = rig();
    r.gestures.down(1, 100, 50);
    r.gestures.down(2, 200, 50);
    r.gestures.up(1, 100, 50);
    // the second finger, still down, does not tap when it lifts
    r.gestures.up(2, 200, 50);
    r.gestures.down(3, 50, 50);
    r.gestures.up(3, 50, 50);
    expect(r.calls.slice(-3)).toEqual(['move 50,50', 'down 0', 'up 0']);
  });
});

describe('the bars around the picture', () => {
  // the rig's picture is the stage's top 200 px; below it is bar
  it('send nothing for a tap, a drag or a two-finger tap that starts on them', () => {
    const r = rig();
    r.gestures.down(1, 100, 250);
    r.gestures.up(1, 100, 250);
    r.gestures.down(2, 100, 250);
    r.gestures.move(2, 100, 150);
    r.gestures.up(2, 100, 150);
    r.gestures.down(3, 100, 260);
    r.gestures.down(4, 200, 260);
    r.gestures.up(3, 100, 260);
    r.gestures.up(4, 200, 260);
    expect(r.calls).toEqual([]);
  });

  it('scroll nothing for two fingers moving on them', () => {
    const r = rig();
    r.gestures.down(1, 100, 260);
    r.gestures.down(2, 200, 260);
    r.gestures.move(1, 100, 230);
    r.gestures.move(2, 200, 230);
    r.gestures.up(1, 100, 230);
    r.gestures.up(2, 200, 230);
    expect(r.calls).toEqual([]);
  });

  it('do not count a tap on them as the first of a double-click', () => {
    const r = rig();
    r.gestures.down(1, 100, 205);
    r.gestures.up(1, 100, 205);
    r.gestures.down(2, 100, 195);
    r.gestures.up(2, 100, 195);
    expect(r.calls).toEqual(['move 100,195', 'down 0', 'up 0']);
  });
});

describe('a watcher', () => {
  it('sends nothing for a tap, a drag or a hold, and still pinches', () => {
    const r = rig({ watcher: true });
    r.gestures.down(1, 100, 50);
    r.gestures.up(1, 100, 50);
    r.gestures.down(2, 100, 50);
    r.gestures.move(2, 150, 50);
    r.gestures.up(2, 150, 50);
    r.gestures.down(3, 100, 50);
    r.advance(HOLD_MS);
    r.gestures.up(3, 100, 50);
    expect(r.calls).toEqual([]);
    expect(r.aims).toEqual([]);

    r.gestures.down(4, 150, 100);
    r.gestures.down(5, 250, 100);
    r.gestures.move(4, 100, 100);
    r.gestures.move(5, 300, 100);
    expect(r.zoom().scale).toBeCloseTo(2);
  });
});
