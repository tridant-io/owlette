/**
 * browser half of the machine's own pointer.
 *
 * desktop duplication never blends the pointer into the desktop image, so the
 * encoded frames carry no cursor at all: the host sends where it is (`cpos`)
 * and what it looks like (`cshape`) on `swoop-cursor`, and this module keeps
 * the latest of each. **the pointer is drawn in one of two ways, never both**:
 * as the local css cursor, which is already on screen where the machine's
 * pointer went, where its size allows; otherwise as an overlay at `cpos`.
 * `SwoopCursor.tsx` owns the rules and both halves — turning a position into
 * a pixel is a layout read and belongs after a commit, not here.
 *
 * until the first `cpos` the host has not said where its pointer is, and
 * `positioned` says so: nothing can stand in for the local pointer yet.
 *
 * shapes are cached by id: the host uploads each distinct bitmap once per
 * viewer and repeats `{"t":"cshape","id":n}` alone after that. the channel is
 * unreliable, so an id this cache has never seen means the upload was lost —
 * there is no message to ask for it again, so the shape falls back to a plain
 * arrow until the pointer next changes to a shape that arrives whole.
 *
 * the decoder is total, like every other decoder on a receive path: a
 * malformed message is dropped, never thrown, and never partially applied.
 */
import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import { decodeCursorMessage } from '@/lib/swoop/protocol';

/** one of the host's bitmaps: png pixels, hotspot in the png's own pixels. */
export interface SwoopCursorShape {
  id: number;
  hotX: number;
  hotY: number;
  w: number;
  h: number;
  /**
   * machine pixels per png pixel. 1 for a shape as captured; the host shrinks
   * a big pointer for the wire and this is what draws it back at full size.
   */
  scale: number;
  /**
   * the dpi the host drew the shape at, 96 being 100%: a 2x mac's is 192.
   * absent from a host older than the field.
   */
  dpi?: number;
  /** base64 png, as it arrived. */
  png: string;
}

export interface SwoopCursorState {
  /** the current shape, or null before the first upload or after a lost one. */
  shape: SwoopCursorShape | null;
  /** whether a `cpos` has arrived, so `x`, `y` and `visible` are the host's word. */
  positioned: boolean;
  /** normalised over the picture, exactly as it arrived. */
  x: number;
  y: number;
  visible: boolean;
}

/** the snapshot before the first message lands, and the server's. */
export const NO_CURSOR: SwoopCursorState = { shape: null, positioned: false, x: 0, y: 0, visible: false };

/** a shape's png as an image source. */
export const cursorPngUrl = (shape: SwoopCursorShape): string => `data:image/png;base64,${shape.png}`;

export interface SwoopCursorStore {
  subscribe(listener: () => void): SwoopDetach;
  get(): SwoopCursorState;
}

const stores = new WeakMap<SwoopSession, SwoopCursorStore>();

/** the live cursor store, or null before attach. */
export const swoopCursor = (session: SwoopSession | null): SwoopCursorStore | null =>
  session ? (stores.get(session) ?? null) : null;

export function attach(session: SwoopSession): SwoopDetach {
  const listeners = new Set<() => void>();
  const shapes = new Map<number, SwoopCursorShape>();
  let state: SwoopCursorState = NO_CURSOR;

  const set = (next: SwoopCursorState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const offCursor = session.onChannelMessage('swoop-cursor', (data) => {
    // shared with `vpos`, which is another viewer's pointer and presence's.
    const decoded = decodeCursorMessage(data);
    if (!decoded.ok) return;
    const message = decoded.value;
    if (message.t === 'cpos') {
      set({ shape: state.shape, positioned: true, x: message.x, y: message.y, visible: message.visible });
      return;
    }
    if (message.png !== undefined) {
      const { id, hotX, hotY, w, h, scale, dpi, png } = message;
      shapes.set(id, { id, hotX: hotX ?? 0, hotY: hotY ?? 0, w: w ?? 0, h: h ?? 0, scale: scale ?? 1, dpi, png });
    }
    set({ ...state, shape: shapes.get(message.id) ?? null });
  });

  const store: SwoopCursorStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // the same object identity until something changes, which is what
    // `useSyncExternalStore` requires of a snapshot.
    get: () => state,
  };

  stores.set(session, store);
  return () => {
    stores.delete(session);
    listeners.clear();
    offCursor();
  };
}
