/**
 * browser half of the viewer roster.
 *
 * the host publishes who is connected, who holds control and where each other
 * controller's pointer is. **the roster is the host's, not ours**: `ctl` on a
 * line comes from that viewer's verified jwt and nothing any viewer sends can
 * change it, so this module only ever reads. there is no "request control"
 * message in the protocol and inventing one here would be a second gate.
 *
 * the two messages arrive on two channels, for the reason `PROTOCOL.md` §5
 * gives. `roster` rides `swoop-control`, which is ordered and reliable, so a
 * departure can never be the frame that goes missing and leave a ghost in the
 * list; it is sent whole on every change rather than as a delta, because a
 * viewer that joined late has no earlier state to apply a delta to. `vpos`
 * rides `swoop-cursor` unreliably beside the host's own `cpos` — a pointer that
 * missed a frame is corrected by the next one 16 ms later, and buffering to
 * redeliver a stale position is worse than dropping it.
 *
 * positions stay normalised 0..1 here, exactly as they arrived. turning one
 * into a pixel needs the PICTURE's box, which is a layout read and belongs
 * after a commit, not in a data-channel handler — `SwoopPresence.tsx` owns that
 * half.
 *
 * the decoders are total, like every other decoder on a receive path: a
 * malformed message is dropped, never thrown, and never partially applied.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';

/** one line of the host's roster. */
export interface SwoopPresenceViewer {
  id: string;
  /** the token's `uid` where it carries one, and the viewer id otherwise —
   *  §8's claim set has no name in it. */
  name: string;
  /** the host's own verdict from this viewer's jwt. never a request. */
  ctl: boolean;
}

/** where one other controller is pointing, normalised over the picture. */
export interface SwoopPeerCursor {
  viewer: string;
  x: number;
  y: number;
  tsUs: number;
}

export interface SwoopPresenceState {
  viewers: readonly SwoopPresenceViewer[];
  /** every controller but this one: the local pointer stays a css cursor. */
  cursors: readonly SwoopPeerCursor[];
}

/** the snapshot before the first roster lands, and the server's. */
export const NO_PRESENCE: SwoopPresenceState = { viewers: [], cursors: [] };

export interface SwoopPresenceStore {
  subscribe(listener: () => void): SwoopDetach;
  get(): SwoopPresenceState;
}

const stores = new WeakMap<SwoopSession, SwoopPresenceStore>();

/** the live presence store, or null before attach. */
export const swoopPresence = (session: SwoopSession | null): SwoopPresenceStore | null =>
  session ? (stores.get(session) ?? null) : null;

// ---------------------------------------------------------------------------
// decoding — total: a bad message is dropped, never thrown
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function asObject(raw: unknown): JsonObject | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : null;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function decodeRoster(message: JsonObject): SwoopPresenceViewer[] | null {
  if (message.t !== 'roster' || !Array.isArray(message.viewers)) return null;
  const viewers: SwoopPresenceViewer[] = [];
  for (const raw of message.viewers) {
    if (typeof raw !== 'object' || raw === null) return null;
    const { id, name, ctl } = raw as JsonObject;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof ctl !== 'boolean') return null;
    viewers.push({ id, name, ctl });
  }
  return viewers;
}

function decodeCursor(message: JsonObject): SwoopPeerCursor | null {
  if (message.t !== 'vpos') return null;
  const { viewer, x, y, tsUs } = message;
  if (typeof viewer !== 'string' || !finite(x) || !finite(y) || !finite(tsUs)) return null;
  return { viewer, x, y, tsUs };
}

// ---------------------------------------------------------------------------

export function attach(session: SwoopSession): SwoopDetach {
  const listeners = new Set<() => void>();
  let state: SwoopPresenceState = NO_PRESENCE;

  const set = (next: SwoopPresenceState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const onRoster = (viewers: SwoopPresenceViewer[]) => {
    // a viewer that left takes its cursor with it — the host stops publishing
    // one, and nothing else would ever clear it.
    const present = new Set(viewers.map((viewer) => viewer.id));
    set({ viewers, cursors: state.cursors.filter((cursor) => present.has(cursor.viewer)) });
  };

  const onCursor = (cursor: SwoopPeerCursor) => {
    // our own pointer is the real one this browser is moving, and it is already
    // on screen as a css cursor; drawing a second one at the same place is the
    // classic double-cursor bug.
    if (cursor.viewer === session.viewerId) return;
    // a position for somebody the roster has not named yet is dropped rather
    // than kept: the two channels are independent, so the next move — 16 ms
    // later — lands after the roster and shows the cursor then.
    if (!state.viewers.some((viewer) => viewer.id === cursor.viewer)) return;
    const cursors = state.cursors.filter((held) => held.viewer !== cursor.viewer);
    // id order, so a re-render never reshuffles the overlay elements.
    cursors.push(cursor);
    cursors.sort((a, b) => (a.viewer < b.viewer ? -1 : a.viewer > b.viewer ? 1 : 0));
    set({ viewers: state.viewers, cursors });
  };

  const offControl = session.onChannelMessage('swoop-control', (data) => {
    const message = asObject(data);
    if (!message) return;
    // the channel is shared with the clipboard, `hello-host` and every other
    // control message, so anything else is not ours and not an error.
    const viewers = decodeRoster(message);
    if (viewers) onRoster(viewers);
  });

  const offCursor = session.onChannelMessage('swoop-cursor', (data) => {
    const message = asObject(data);
    if (!message) return;
    // shared with `cpos` and `cshape`, which are the machine's own pointer.
    const cursor = decodeCursor(message);
    if (cursor) onCursor(cursor);
  });

  const store: SwoopPresenceStore = {
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
    offControl();
  };
}
