/**
 * @jest-environment jsdom
 *
 * the machine's pointer feed: a shape is cached by id and repeated by id
 * alone, and an id whose upload was lost falls back to no shape rather than
 * the previous one.
 */

import { attach, NO_CURSOR, swoopCursor } from '@/lib/swoop/cursor';
import type { SwoopSession } from '@/lib/swoop/features';

const PNG = 'iVBORw0KGgo=';

const cpos = (x: number, y: number, visible = true) => JSON.stringify({ t: 'cpos', x, y, visible, tsUs: 1 });
const upload = (id: number) => JSON.stringify({ t: 'cshape', id, hotX: 2, hotY: 3, w: 32, h: 32, png: PNG });
const repeat = (id: number) => JSON.stringify({ t: 'cshape', id });

function harness() {
  const handlers = new Map<string, (data: unknown) => void>();
  const session = {
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
    cursor: (data: unknown) => handlers.get('swoop-cursor')?.(data),
    handlers,
    detach,
  };
}

describe('swoop cursor', () => {
  it('is empty before the first message and gone after detach', () => {
    const h = harness();
    expect(swoopCursor(h.session)?.get()).toBe(NO_CURSOR);
    h.detach();
    expect(swoopCursor(h.session)).toBeNull();
    expect(h.handlers.size).toBe(0);
  });

  it('keeps the latest position and the machine own visibility', () => {
    const h = harness();
    const store = swoopCursor(h.session)!;
    const seen = jest.fn();
    store.subscribe(seen);
    h.cursor(cpos(0.25, 0.75));
    expect(store.get()).toMatchObject({ x: 0.25, y: 0.75, visible: true, shape: null });
    h.cursor(cpos(0.5, 0.5, false));
    expect(store.get()).toMatchObject({ x: 0.5, y: 0.5, visible: false });
    expect(seen).toHaveBeenCalledTimes(2);
    h.detach();
  });

  it('caches a shape by id and answers a repeat from the cache', () => {
    const h = harness();
    const store = swoopCursor(h.session)!;
    h.cursor(upload(1));
    expect(store.get().shape).toEqual({ id: 1, hotX: 2, hotY: 3, w: 32, h: 32, scale: 1, png: PNG });
    h.cursor(upload(2));
    expect(store.get().shape?.id).toBe(2);
    h.cursor(repeat(1));
    expect(store.get().shape?.id).toBe(1);
    // a position does not disturb the shape, and a shape does not move the pointer.
    h.cursor(cpos(0.1, 0.2));
    expect(store.get()).toMatchObject({ x: 0.1, y: 0.2, shape: { id: 1 } });
    h.detach();
  });

  it('falls back to no shape when a repeat names an upload that never arrived', () => {
    const h = harness();
    const store = swoopCursor(h.session)!;
    h.cursor(upload(1));
    h.cursor(repeat(7));
    expect(store.get().shape).toBeNull();
    h.detach();
  });

  it('drops what it cannot decode without touching the state', () => {
    const h = harness();
    const store = swoopCursor(h.session)!;
    h.cursor(cpos(0.3, 0.3));
    const before = store.get();
    h.cursor('not json');
    h.cursor(JSON.stringify({ t: 'cshape', id: 1, png: PNG }));
    h.cursor(JSON.stringify({ t: 'vpos', viewer: 'a', x: 0, y: 0, tsUs: 1 }));
    expect(store.get()).toBe(before);
    h.detach();
  });
});
