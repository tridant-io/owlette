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

import { attachInputCapture, type InputCapture } from '@/lib/swoop/input';
import { createSwoopFeedback, type SwoopFeedback } from '@/lib/swoop/feedback';
import { attach as attachLease } from '@/lib/swoop/lease';
import { attach as attachClipboard } from '@/lib/swoop/clipboard';
import { attach as attachAudio } from '@/lib/swoop/audio';
import { attach as attachDisplays } from '@/lib/swoop/displays';
import { attach as attachPresence } from '@/lib/swoop/presence';
import { attach as attachCursor } from '@/lib/swoop/cursor';
import { attach as attachWakeLock } from '@/lib/swoop/wakeLock';

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
 * two features are adapted rather than imported as an `attach`.
 *
 * `input.ts` and `feedback.ts` predate this seam and export their own
 * constructors — `attachInputCapture(options)` and `createSwoopFeedback(options)`
 * — because both are used directly by their own tests and neither should know
 * what a `SwoopSession` is. the adapters below are the whole of the coupling.
 *
 * the handles they produce are kept here, keyed weakly by session, because the
 * toolbar and the overlay need them and the `attach` contract only hands back a
 * detach. each entry is deleted before its handle is torn down, so a session
 * being unwound can never hand anyone a dead capture.
 */
const inputCaptures = new WeakMap<SwoopSession, InputCapture>();
const feedbacks = new WeakMap<SwoopSession, SwoopFeedback>();

/** the live input capture, or null for a view-only session or before attach. */
export const swoopInputCapture = (session: SwoopSession | null): InputCapture | null =>
  session ? (inputCaptures.get(session) ?? null) : null;

/** the live feedback reporter, whose diagnostics carry the measured rtt. */
export const swoopFeedback = (session: SwoopSession | null): SwoopFeedback | null =>
  session ? (feedbacks.get(session) ?? null) : null;

const inputFeature: SwoopFeature = {
  name: 'input',
  attach(session) {
    // the host re-derives `ctl` from the verified jwt and refuses input from a
    // viewer without it, reporting the attempt. so a view-only viewer captures
    // nothing at all rather than generating denials the operator cannot act on.
    if (!session.ctl) return () => {};
    const capture = attachInputCapture({
      target: session.stage,
      send: (payload) => {
        session.send('swoop-input', payload);
      },
      // the PICTURE's box, never the element's — see `contentRect` above. the
      // normalisation, including its `size - 1` convention, stays in input.ts.
      rect: () => session.contentRect(),
    });
    inputCaptures.set(session, capture);
    return () => {
      inputCaptures.delete(session);
      capture.detach();
    };
  },
};

const feedbackFeature: SwoopFeature = {
  name: 'feedback',
  attach(session) {
    const feedback = createSwoopFeedback({
      send: (payload) => {
        session.send('swoop-feedback', payload);
      },
      viewport: () => {
        const box = session.contentRect();
        return { widthCss: box.width, heightCss: box.height };
      },
      // the host stopped answering on a channel that had been working. an
      // ice restart would not help — the channels are what died, and only a
      // new peer gets new ones — so this is the transient end the hook
      // reconnects from, with the retry ladder it already has.
      onSilence: () => session.end('peer_failed'),
    });
    const offFrame = session.onFrame((observation) => feedback.observeFrame(observation));
    const offMessage = session.onChannelMessage('swoop-feedback', (data) =>
      feedback.handleMessage(data),
    );
    feedback.start();
    feedbacks.set(session, feedback);
    return () => {
      feedbacks.delete(session);
      feedback.stop();
      offMessage();
      offFrame();
    };
  },
};

/**
 * attached in this order, detached in reverse. the lease renewer leads because
 * everything after it depends on the session still being authorised, and
 * feedback follows it because the host's rate governor should start adapting
 * before any of the optional features add traffic of their own.
 */
export const SWOOP_FEATURES: readonly SwoopFeature[] = [
  { name: 'lease', attach: attachLease },
  feedbackFeature,
  inputFeature,
  { name: 'clipboard', attach: attachClipboard },
  { name: 'audio', attach: attachAudio },
  { name: 'displays', attach: attachDisplays },
  { name: 'presence', attach: attachPresence },
  { name: 'cursor', attach: attachCursor },
  { name: 'wake-lock', attach: attachWakeLock },
];
