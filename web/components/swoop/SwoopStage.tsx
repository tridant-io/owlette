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

import { useCallback, useEffect, useId, useState, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { hasKeyboardLock } from '@/lib/swoop/keyboardLock';
import type { SwoopSessionState } from '@/hooks/useSwoopSession';
import type { SwoopNoPath } from '@/lib/swoop/peer';

export interface SwoopStageProps {
  session: SwoopSession | null;
  state: SwoopSessionState;
  /** connecting found no media path; the stage says so instead of a bare "connecting". */
  noPath?: SwoopNoPath | null;
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * where keyboard focus goes when it leaves the stage — escape twice, see
   * `InputCapture.onEscapeTwice`. without it the stage only lets focus go.
   */
  onLeave?: () => void;
  children?: React.ReactNode;
}

/** four seconds, once per entry, then gone. */
function Hint({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4000);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

export function SwoopStage({ session, state, noPath, stageRef, videoRef, onLeave, children }: SwoopStageProps) {
  const [locked, setLocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // the way out, said once fullscreen holds and only where it is not obvious:
  // with the keyboard captured a tap of esc goes to the machine, and the hold
  // is the exit the browser reserves. without the lock a tap leaves as usual.
  const [escHint, setEscHint] = useState(false);
  // windowed, every key — tab too — goes to the machine, so the way out is
  // said each time the stage takes the keyboard.
  const [leaveHint, setLeaveHint] = useState(false);
  // stable, or every stats tick re-renders the stage and restarts the timers.
  const hideEscHint = useCallback(() => setEscHint(false), []);
  const hideLeaveHint = useCallback(() => setLeaveHint(false), []);
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
    const sync = () => {
      setLocked(document.pointerLockElement === stageRef.current);
      const on = document.fullscreenElement === stageRef.current;
      setFullscreen(on);
      setEscHint(on && hasKeyboardLock());
    };
    document.addEventListener('pointerlockchange', sync);
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('pointerlockchange', sync);
      document.removeEventListener('fullscreenchange', sync);
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

  return (
    // touch-none: a drag is the machine's, never a page pan, and android's
    // pull-to-refresh must not reload the page mid-session. `dark` scopes the
    // night palette to the stage in both themes: it is a video surface, not
    // chrome, so the letterbox, hints and overlays read the same over any
    // picture and on the black of fullscreen.
    <div
      ref={stageRef}
      tabIndex={-1}
      role={capture ? 'application' : undefined}
      aria-label={capture ? 'remote screen' : undefined}
      aria-describedby={windowedCapture ? leaveHintId : undefined}
      onPointerDown={onPointerDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget && windowedCapture) setLeaveHint(true);
      }}
      onBlur={(e) => {
        if (e.target === e.currentTarget) setLeaveHint(false);
      }}
      className="dark relative h-full w-full overflow-hidden bg-background outline-none touch-none overscroll-none [&:fullscreen]:bg-black"
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className="h-full w-full object-contain"
        aria-label="remote screen"
      />
      {state !== 'connected' && (
        <p className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          {state !== 'ended' && <Loader2 className="size-6 animate-spin" aria-hidden />}
          {state === 'ended' ? 'session ended' : noPath ? "can't reach this machine from your network" : 'connecting'}
          {state !== 'ended' && noPath && (
            <span className="max-w-sm text-center text-xs">
              {noPath.relayConfigured
                ? 'even the relay could not get through. check that this network allows udp, or try another network.'
                : 'no relay is set up for this site, so swoop only connects when both ends can reach each other directly.'}
            </span>
          )}
        </p>
      )}
      {state === 'connected' && fullscreen && !locked && (
        <p className="pointer-events-none absolute inset-x-0 top-4 text-center text-xs text-muted-foreground">
          click to capture the mouse
        </p>
      )}
      {state === 'connected' && escHint && (
        <Hint onDone={hideEscHint}>hold esc for two seconds to leave fullscreen</Hint>
      )}
      {state === 'connected' && leaveHint && windowedCapture && (
        <Hint onDone={hideLeaveHint}>press esc twice to leave the remote screen</Hint>
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
