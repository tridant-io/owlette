/**
 * browser half of host audio.
 *
 * audio arrives on its own `MediaStream`, never the video one, so the browser
 * cannot a/v-sync and hold the picture back. it starts muted and unmutes on a
 * user gesture of its own; `video/receiver.ts` mutes the video element so it
 * can autoplay, and that is not this feature's to undo.
 *
 * three things here are deliberate:
 *
 * 1. **its own `<audio>` element, and it is never in the dom.** the picture is
 *    a `<video>` that `video/receiver.ts` owns end to end; hanging a second
 *    `srcObject` on it is how audio ends up sharing the video clock. a
 *    detached element plays fine and has no layout, no styling and nothing for
 *    a later task to trip over.
 * 2. **it listens with `addEventListener('track')`, not `pc.ontrack`.** that
 *    property slot belongs to `peer.ts`, which routes the video track to the
 *    receiver; both fire, so taking the slot would silently kill the picture.
 * 3. **the element plays from the moment the track arrives, muted.** keeping
 *    the decoder warm is what makes the first click instant — starting
 *    playback inside the gesture would add a decoder start to it — and a muted
 *    element is what autoplay policy actually allows.
 *
 * the disabled "no audio endpoint" state is derived from the peer, not pushed
 * by the host: `signal/messages.rs` is frozen, so there is no host→viewer
 * message that carries it (the host reports it to the *service*, on §6's
 * `status`). what the browser can see is whether an audio track ever arrived,
 * and a host with no render endpoint — or one built without the `audio-opus`
 * feature — produces none. there is no timeout on that: a track that turns up
 * late still enables the toggle, where a timer would have disabled it for the
 * rest of the session.
 */

import type { SwoopDetach, SwoopSession } from '@/lib/swoop/features';
import { encodeControlMessage } from '@/lib/swoop/protocol';

/**
 * `unavailable` — no audio track; the toggle is disabled.
 * `muted` — a track is playing into a muted element, waiting for a gesture.
 * `playing` — audible.
 */
export type SwoopAudioState = 'unavailable' | 'muted' | 'playing';

export interface SwoopAudio {
  state(): SwoopAudioState;
  /** notified whenever `state()` would return something new. */
  subscribe(listener: () => void): SwoopDetach;
  /**
   * flip between muted and playing. **must be called from a user gesture** —
   * un-muting without one is what browsers refuse.
   */
  toggle(): void;
}

/** the live audio handle, or null before attach and after teardown. */
const handles = new WeakMap<SwoopSession, SwoopAudio>();

export const swoopAudio = (session: SwoopSession | null): SwoopAudio | null =>
  session ? (handles.get(session) ?? null) : null;

export function attach(session: SwoopSession): SwoopDetach {
  const element = new Audio();
  element.autoplay = true;
  // autoplay policy: a muted element may start on its own, an audible one may
  // not. the gesture in `toggle` is what un-mutes it.
  element.muted = true;

  let state: SwoopAudioState = 'unavailable';
  let detached = false;
  const listeners = new Set<() => void>();

  const set = (next: SwoopAudioState) => {
    if (state === next) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const onTrack = (event: RTCTrackEvent) => {
    if (detached || event.track.kind !== 'audio') return;
    // its own stream, whatever the host sent: two tracks in one `MediaStream`
    // is the a/v-sync case this feature exists to avoid.
    element.srcObject = new MediaStream([event.track]);
    void element.play().catch(() => {
      // a muted element is allowed to play, so a refusal here is the element
      // being torn down mid-call rather than policy. the state is still
      // `muted`, and the gesture in `toggle` retries.
    });
    set('muted');
  };

  const connection = session.peer.connection;
  connection.addEventListener('track', onTrack);

  const handle: SwoopAudio = {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toggle: () => {
      if (detached || state === 'unavailable') return;
      const wantAudible = state === 'muted';
      element.muted = !wantAudible;
      if (wantAudible) {
        // inside the gesture, so the promise is allowed to resolve.
        void element.play().catch(() => {
          element.muted = true;
          set('muted');
        });
      }
      // tell the host as well: a muted viewer that keeps receiving opus is
      // bandwidth nobody hears. §5 allows this from a watcher, so it is never
      // gated on `ctl` here or on the host.
      session.send('swoop-control', encodeControlMessage({ t: 'mute', on: !wantAudible }));
      set(wantAudible ? 'playing' : 'muted');
    },
  };
  handles.set(session, handle);

  return () => {
    if (detached) return;
    detached = true;
    handles.delete(session);
    connection.removeEventListener('track', onTrack);
    listeners.clear();
    element.pause();
    element.srcObject = null;
  };
}
