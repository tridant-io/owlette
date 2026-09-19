/**
 * browser half of display selection.
 *
 * the host names outputs by a stable device path, never an index, because a
 * virtual display driver moves indices. that path does not reach the browser:
 * `hello-host`'s `displays[]` is `{index, width, height, primary}` and
 * `signal/messages.rs` is frozen, so the wire carries an index and the host
 * resolves it against the roster it holds. an index is therefore only good for
 * the roster it arrived with — which is why a switch is sent immediately and
 * nothing is cached across a reconnect.
 *
 * a rotated output is advertised transposed against its desktop rect (a 2160x3840
 * portrait panel arrives as 3840x2160) because the host encodes the un-rotated
 * texture and that is what this browser will draw. dpi is not on the wire at
 * all; a desktop rect is physical pixels whatever the monitor's scaling is.
 *
 * the roster is shared state across every viewer, and a switch is gated on
 * `ctl` by the host. there is no host→viewer message announcing a switch, so
 * the selection tracked here is THIS viewer's own last choice and can be stale
 * if another controller switches. `hello-host` arrives once per viewer, at
 * channel open, and resets it.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import { decodeControlMessage, encodeControlMessage } from '@/lib/swoop/protocol';

/** one output, exactly as `hello-host` advertises it. */
export interface SwoopDisplay {
  index: number;
  /** the encoded texture's size — transposed against the desktop if rotated. */
  width: number;
  height: number;
  primary: boolean;
}

export interface SwoopDisplayState {
  displays: SwoopDisplay[];
  /** this viewer's last choice, or null before it has made one. */
  selected: number | null;
}

/**
 * subscribable so the picker can `useSyncExternalStore` it: `hello-host` lands
 * on a data channel, outside react, and a component re-rendering is the only
 * thing that has to happen when it does.
 */
export interface SwoopDisplayStore {
  subscribe(listener: () => void): SwoopDetach;
  get(): SwoopDisplayState;
  /** send a `display` switch. false when the channel is not open. */
  select(index: number): boolean;
}

/** the snapshot before `hello-host` lands, and the server's. */
export const NO_DISPLAYS: SwoopDisplayState = { displays: [], selected: null };

const stores = new WeakMap<SwoopSession, SwoopDisplayStore>();

/** the live display store, or null before attach. */
export const swoopDisplays = (session: SwoopSession | null): SwoopDisplayStore | null =>
  session ? (stores.get(session) ?? null) : null;

export function attach(session: SwoopSession): SwoopDetach {
  const listeners = new Set<() => void>();
  let state = NO_DISPLAYS;

  const set = (next: SwoopDisplayState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const store: SwoopDisplayStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // the same object identity until something changes, which is what
    // `useSyncExternalStore` requires of a snapshot.
    get: () => state,
    select(index) {
      // the host is the enforcement point and refuses a gated control message
      // from a viewer without `ctl`; not sending one it will only deny keeps
      // the audit trail free of attempts the ui made on the user's behalf.
      if (!session.ctl) return false;
      if (!state.displays.some((display) => display.index === index)) return false;
      const sent = session.send('swoop-control', encodeControlMessage({ t: 'display', index }));
      if (sent) set({ ...state, selected: index });
      return sent;
    },
  };

  const off = session.onChannelMessage('swoop-control', (data) => {
    const decoded = decodeControlMessage(data);
    // the channel is shared with the clipboard and with every other control
    // message, so anything else is not ours and not an error.
    if (!decoded.ok || decoded.value.t !== 'hello-host') return;
    const displays = decoded.value.displays;
    // not a guess at what the host is capturing: the session opens the
    // PRIMARY output at startup (`session::primary`, the output whose rect
    // starts at the virtual desktop's origin) and the roster's `primary` flag
    // is that same rule, so this is what it is streaming until someone switches.
    set({
      displays,
      selected: displays.find((display) => display.primary)?.index ?? displays[0]?.index ?? null,
    });
  });

  stores.set(session, store);
  return () => {
    stores.delete(session);
    listeners.clear();
    off();
  };
}
