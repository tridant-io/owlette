'use client';

/**
 * the picture, and the surface everything else overlays.
 *
 * gate g1 chose the rtp media track, so the stage is a `<video>` element rather
 * than the canvas the plan's arm A would have drawn into. `video/receiver.ts`
 * owns that element — it attaches the track, sets `srcObject`, mutes it for
 * autoplay and runs the single `requestVideoFrameCallback` chain. this
 * component only places it and hands the hook the ref.
 *
 * the wrapper is what input capture binds to, which is why it is focusable and
 * why the fullscreen/keyboard-lock gesture in the toolbar targets it. input
 * capture itself is attached by the `input` feature in `lib/swoop/features.ts`
 * — this component must not attach a second one.
 *
 * **`object-contain` on the video is load-bearing.** a `<video>` whose aspect
 * ratio does not match its box letterboxes, and `session.contentRect()` derives
 * the picture's box from exactly this fit and this (default, centred) position.
 * input capture normalises against that rect, not the element's — normalising
 * against the element makes `0..1` span the black bars and every pointer
 * position lands offset. changing the fit or the object-position here without
 * changing `contentRect` breaks clicks on every non-matching aspect ratio.
 */

import { useCallback, useEffect, useId, useState, useSyncExternalStore, type RefObject } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { hasKeyboardLock } from '@/lib/swoop/keyboardLock';
import { isViewerApp } from '@/lib/swoop/viewerApp';
import type { SwoopSessionState, SwoopStallRecovery } from '@/hooks/useSwoopSession';
import type { SwoopNoPath } from '@/lib/swoop/peer';

const subscribeNever = (): (() => void) => () => {};
const notInApp = () => false;

export interface SwoopStageProps {
  session: SwoopSession | null;
  state: SwoopSessionState;
  /** why the session ended or failed; said in the middle of the stage, where it is seen. */
  error?: string | null;
  /** seconds until the next automatic reconnect, while one is scheduled. */
  retryIn?: number | null;
  /** the api's code for a refusal that is final; `swoop_disabled` says where to turn swoop on. */
  refusal?: string | null;
  /** where this user turns swoop on for the site; null for one who cannot. */
  settingsHref?: string | null;
  /** connecting found no media path; the stage says so instead of a bare "connecting". */
  noPath?: SwoopNoPath | null;
  /** what the page is doing about a frozen picture; the stage says it over the picture. */
  stall?: SwoopStallRecovery;
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * where keyboard focus goes when it leaves the stage — escape twice, see
   * `InputCapture.onEscapeTwice`. without it the stage only lets focus go.
   */
  onLeave?: () => void;
  children?: React.ReactNode;
}

const HINT_MS = 4000;
/** the fullscreen hint's fade; matches its `motion-safe:duration-300`. */
const HINT_FADE_MS = 300;

/** four seconds, once per entry, then gone. */
function Hint({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, HINT_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-xs text-swoop-stage-ink">
      {children}
    </p>
  );
}

/**
 * owlette swoop's way out of fullscreen, said on every entry: the app has no
 * browser overlay that says it, and a toast would sit outside the fullscreen
 * element, unseen. four seconds, then a fade; with reduced motion it just goes.
 */
function FullscreenHint({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const fade = setTimeout(() => setFading(true), HINT_MS);
    const done = setTimeout(onDone, HINT_MS + HINT_FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [onDone]);
  return (
    <p
      role="status"
      data-testid="fullscreen-hint"
      className={`rounded-full border border-border bg-card/90 px-3 py-1.5 text-xs text-foreground shadow-sm motion-safe:transition-opacity motion-safe:duration-300 ${fading ? 'opacity-0' : ''}`}
    >
      press and hold esc to exit fullscreen
    </p>
  );
}

/** the stage's centred notice, over the picture or in place of it. */
const NOTICE = 'pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-base text-swoop-stage-ink';
/** a notice's second line, one size down from its first; every notice uses it. */
const NOTICE_DETAIL = 'max-w-sm text-center text-sm';

/**
 * why there is no path, as far as this end can tell: whether a relay was
 * there, and which ends reached it. each sentence names the network to look
 * at, because "check your network" sent people the wrong way (#328: the
 * viewer's network was fine and the machine held no relay).
 */
function noPathDetail(noPath: SwoopNoPath): string {
  if (!noPath.relayConfigured) {
    return 'no relay is set up for this site, so swoop only connects when both ends can reach each other directly.';
  }
  if (!noPath.hostRelay) {
    return "the machine's side never reached the relay. its network has to allow udp out to the relay, and its agent has to be up to date.";
  }
  if (noPath.browserRelay === false) {
    return 'the machine reached the relay but this browser did not. check that this network allows udp or tcp out, or try another network.';
  }
  return 'the relay was reached and still no path came up. reconnect to try again, or try another network.';
}

export function SwoopStage({
  session,
  state,
  error = null,
  retryIn = null,
  refusal = null,
  settingsHref = null,
  noPath,
  stall = 'none',
  stageRef,
  videoRef,
  onLeave,
  children,
}: SwoopStageProps) {
  const [locked, setLocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // the server renders no app; the way back from a settled notice is the picker there
  const inApp = useSyncExternalStore(subscribeNever, isViewerApp, notInApp);
  // the way out, said on each entry into fullscreen and only where it is not
  // obvious: owlette swoop always says it (its hold is its own, and nothing
  // else tells it), a browser only with the keyboard captured, where a tap of
  // esc goes to the machine and the hold is the exit the browser reserves.
  // without the lock a tap leaves as usual.
  const [escHint, setEscHint] = useState<'app' | 'browser' | null>(null);
  // stable, or every stats tick re-renders the stage and restarts the timer.
  const hideEscHint = useCallback(() => setEscHint(null), []);
  // windowed, every key — tab too — goes to the machine. the way out is told
  // to a screen reader only: on screen it was noise.
  const leaveHintId = useId();
  // a view-only session captures nothing, so its keys never leave the page.
  const capture = swoopInputCapture(session);

  useEffect(() => {
    if (!capture) return;
    return capture.onEscapeTwice(() => {
      if (onLeave) onLeave();
      else stageRef.current?.blur();
    });
  }, [capture, onLeave, stageRef]);

  useEffect(() => {
    const syncLock = () => setLocked(document.pointerLockElement === stageRef.current);
    // the hint comes with an entry into fullscreen, not with a pointer lock change inside one
    const syncFullscreen = () => {
      syncLock();
      const on = document.fullscreenElement === stageRef.current;
      setFullscreen(on);
      if (!on) setEscHint(null);
      else if (isViewerApp()) setEscHint('app');
      else setEscHint(hasKeyboardLock() ? 'browser' : null);
    };
    document.addEventListener('pointerlockchange', syncLock);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => {
      document.removeEventListener('pointerlockchange', syncLock);
      document.removeEventListener('fullscreenchange', syncFullscreen);
    };
  }, [stageRef]);

  // keys only reach input capture while the stage holds focus, and it cannot
  // take focus on a click: input capture calls `preventDefault` on pointerdown
  // to keep the browser from starting a selection, which also suppresses the
  // default focus. so focus is taken explicitly, here and on first picture.
  useEffect(() => {
    if (state === 'connected') stageRef.current?.focus();
  }, [state, stageRef]);

  const onPointerDown = useCallback(() => {
    stageRef.current?.focus();
    // escape drops pointer lock but leaves fullscreen, and the toolbar is off
    // screen at that point — a click is the way back in.
    if (fullscreen && !locked) void swoopInputCapture(session)?.requestPointerLock();
  }, [fullscreen, locked, session, stageRef]);

  const windowedCapture = capture !== null && !fullscreen;
  const captureHint = state === 'connected' && fullscreen && !locked;
  // a stall recovery speaks for the stage until the page is connecting again.
  const recovering = stall === 'reattaching' || stall === 'reconnecting';
  // an ended or failed session is not connecting: it says why, and the way on.
  const settled = state === 'ended' || state === 'error';
  const swoopOff = refusal === 'swoop_disabled';
  // the picture behind a stall notice is the frozen frame, so it sits on a wash of the stage.
  const washed = `${NOTICE} bg-swoop-stage/80`;

  return (
    // touch-none: a drag is the machine's, never a page pan, and android's
    // pull-to-refresh must not reload the page mid-session. `dark` scopes the
    // night palette to the stage in both themes: it is a video surface, not
    // chrome, so its overlays read the same over any picture and on the black
    // of fullscreen. the letterbox and hints follow the page instead: mid grey
    // by day, the night page at night.
    <div
      ref={stageRef}
      tabIndex={-1}
      role={capture ? 'application' : undefined}
      aria-label={capture ? 'remote screen' : undefined}
      aria-describedby={windowedCapture ? leaveHintId : undefined}
      onPointerDown={onPointerDown}
      className="dark relative h-full w-full overflow-hidden bg-swoop-stage outline-none touch-none overscroll-none [&:fullscreen]:bg-black"
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className="h-full w-full object-contain"
        aria-label="remote screen"
      />
      {recovering && (
        <p role="status" className={washed}>
          <Loader2 className="size-6 animate-spin" aria-hidden />
          {stall === 'reattaching' ? 'picture stalled — restarting the picture' : 'picture stalled — reconnecting'}
        </p>
      )}
      {stall === 'frozen' && (
        // the session is still up; only the automatic recovery has stopped.
        <p role="alert" className={washed}>
          the picture froze
          <span className={NOTICE_DETAIL}>
            it kept freezing, so swoop stopped fixing it on its own. reconnect from the bar to try again.
          </span>
        </p>
      )}
      {state !== 'connected' && !settled && stall === 'none' && (
        <p className={NOTICE}>
          <Loader2 className="size-6 animate-spin" aria-hidden />
          {noPath ? "can't reach this machine from your network" : 'connecting'}
          {noPath && (
            <span className={NOTICE_DETAIL}>{noPathDetail(noPath)}</span>
          )}
        </p>
      )}
      {settled && stall === 'none' && (
        <p role="alert" className={`${NOTICE} px-4 text-center`}>
          {state === 'ended' ? 'session ended' : error}
          {state === 'ended' && error && <span className={NOTICE_DETAIL}>{error}</span>}
          {/* a session that failed after finding no path keeps saying which network to look at */}
          {noPath && <span className={NOTICE_DETAIL}>{noPathDetail(noPath)}</span>}
          {retryIn !== null && <span className={NOTICE_DETAIL}>reconnecting in {retryIn} s…</span>}
          {swoopOff && (
            <span className={NOTICE_DETAIL}>
              {settingsHref ? 'turn it on in site settings.' : 'ask a site owner or admin to turn it on.'}
            </span>
          )}
          {/* text lines carry leading above and below their ink and the buttons' edge does not,
              so the same gap reads 7px tighter there; measured at these sizes */}
          <span className="pointer-events-auto mt-[7px] flex gap-2">
            {swoopOff && settingsHref && (
              <Button asChild size="sm">
                <Link href={settingsHref}>open site settings</Link>
              </Button>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href={inApp ? '/swoop' : '/dashboard'}>{inApp ? 'back to machines' : 'back to dashboard'}</Link>
            </Button>
          </span>
        </p>
      )}
      {(escHint === 'app' || captureHint) && (
        // one column, so the two never overlap while the pointer lock is on its way
        <div className="pointer-events-none absolute inset-x-0 top-4 flex flex-col items-center gap-2">
          {escHint === 'app' && <FullscreenHint onDone={hideEscHint} />}
          {captureHint && <p className="text-center text-xs text-swoop-stage-ink">click to capture the mouse</p>}
        </div>
      )}
      {state === 'connected' && escHint === 'browser' && (
        <Hint onDone={hideEscHint}>hold esc for two seconds to leave fullscreen</Hint>
      )}
      {windowedCapture && (
        <span id={leaveHintId} className="sr-only">
          press escape twice to leave the remote screen
        </span>
      )}
      {children}
    </div>
  );
}
