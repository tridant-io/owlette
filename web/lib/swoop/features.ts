/**
 * the seam between `useSwoopSession` and everything later waves bolt onto a
 * live session.
 *
 * the hook builds exactly one `SwoopSession` and calls `attach` on every entry
 * in `SWOOP_FEATURES`; each returns its own detach, which the hook runs in
 * reverse on teardown. that is the whole contract, and it exists so clipboard,
 * audio, displays, presence, the lease renewer and the input capture can each
 * land in their own task without any of them editing the page or the hook.
 *
 * two shapes here are deliberate:
 *
 * 1. **`SwoopSession` lives in this file, not a module of its own.** every
 *    feature needs the type and this file needs every feature's `attach`, so
 *    the import graph is a cycle — but the features' half is `import type`,
 *    which erases, so nothing circular survives to runtime.
 * 2. **the session hands out the `<video>` element but owns none of its
 *    behaviour.** `video/receiver.ts` owns the element's lifecycle, the single
 *    `requestVideoFrameCallback` chain and `jitterBufferTarget` (which it sets
 *    to 0, because in chrome it is a *minimum* and can only raise the playout
 *    floor the host asked for). a feature that arms a second rVFC chain
 *    double-counts every frame; a feature that writes `jitterBufferTarget`
 *    undoes the measured 31 ms lan latency. neither belongs here.
 */

import type { SwoopPeer } from '@/lib/swoop/peer';
import type { SwoopChannel } from '@/lib/swoop/protocol';
import type { SwoopPresenter } from '@/lib/swoop/video/presenter';
import type { FrameObservation } from '@/lib/swoop/video/receiver';

import { attach as attachLease } from '@/lib/swoop/lease';
import { attach as attachClipboard } from '@/lib/swoop/clipboard';
import { attach as attachAudio } from '@/lib/swoop/audio';
import { attach as attachDisplays } from '@/lib/swoop/displays';
import { attach as attachPresence } from '@/lib/swoop/presence';

/** what `attach` hands back: undo everything it did, idempotently. */
export type SwoopDetach = () => void;

/** a renewed lease, exactly as the lease route reports it. */
export interface SwoopLease {
  viewerJwt: string;
  /** when the LEASE lapses — not the 60 s life of the jwt beside it. */
  expiresAt: number;
}

/**
 * one live session, as a feature sees it. the hook is its only builder.
 */
export interface SwoopSession {
  readonly siteId: string;
  readonly machineId: string;
  readonly sid: string;
  readonly viewerId: string;
  /**
   * whether the api granted control. the host re-derives this from the viewer
   * jwt and is the enforcement point — this field is for the ui, never a gate.
   */
  readonly ctl: boolean;
  /** this browser's dtls fingerprint; every lease renewal re-presents it. */
  readonly fingerprint: string;
  /** the element `video/receiver.ts` owns. read it; do not re-wire it. */
  readonly video: HTMLVideoElement;
  /** the focusable surface input capture binds to. */
  readonly stage: HTMLElement;
  /**
   * the PICTURE's box in client coordinates — the letterboxed content area
   * inside the element, not the element's own rect.
   *
   * this exists because arm B presents into a `<video>`, and a `<video>` whose
   * aspect ratio does not match its box contains black bars. normalising a
   * pointer position against the element rect makes `0..1` span the bars too,
   * so every click lands offset and the offset grows with the mismatch — right
   * on a 16:9 host in a 16:9 window, wrong by a different amount at each edge
   * on an ultrawide, a rotated panel or a resized window.
   *
   * hand this to `attachInputCapture`'s `rect()` and let `input.ts` own the
   * normalisation itself, including its `size - 1` convention, which the rust
   * injection side matches. do not redo either here.
   */
  contentRect(): DOMRect;
  readonly peer: SwoopPeer;
  readonly presenter: SwoopPresenter;
  /**
   * send on one of the five channels; false when that channel is not open.
   * every viewer→host payload in the protocol is json text — `swoop-meta` is
   * the only binary one, and it only ever flows host→viewer.
   */
  send(label: SwoopChannel, data: string): boolean;
  /** subscribe to one channel's inbound frames. returns an unsubscribe. */
  onChannelMessage(label: SwoopChannel, handler: (data: unknown) => void): SwoopDetach;
  /** every presented frame joined to its host stamps. returns an unsubscribe. */
  onFrame(handler: (observation: FrameObservation) => void): SwoopDetach;
  /** renew the 5-minute lease and mint a fresh viewer jwt (PROTOCOL.md §10). */
  renewLease(): Promise<SwoopLease>;
  /** when the lease currently held lapses. */
  leaseExpiresAt(): number;
  /** end the session: tears down the peer and the page's state. */
  end(reason: string): void;
}

export interface SwoopFeature {
  readonly name: string;
  readonly attach: (session: SwoopSession) => SwoopDetach;
}

/**
 * attached in this order, detached in reverse. the lease renewer leads because
 * everything after it depends on the session still being authorised.
 *
 * `input` (task 4.6/5.2) and `feedback` (task 4.7) join this list when they
 * land; neither exists yet and neither needs anything added to the seam.
 */
export const SWOOP_FEATURES: readonly SwoopFeature[] = [
  { name: 'lease', attach: attachLease },
  { name: 'clipboard', attach: attachClipboard },
  { name: 'audio', attach: attachAudio },
  { name: 'displays', attach: attachDisplays },
  { name: 'presence', attach: attachPresence },
];
