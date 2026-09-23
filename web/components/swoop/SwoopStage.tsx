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

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import type { SwoopSessionState } from '@/hooks/useSwoopSession';

export interface SwoopStageProps {
  session: SwoopSession | null;
  state: SwoopSessionState;
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  children?: React.ReactNode;
}

export function SwoopStage({ session, state, stageRef, videoRef, children }: SwoopStageProps) {
  const [locked, setLocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const sync = () => {
      setLocked(document.pointerLockElement === stageRef.current);
      setFullscreen(document.fullscreenElement === stageRef.current);
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

  return (
    <div
      ref={stageRef}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      className="relative h-full w-full overflow-hidden bg-background outline-none"
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className="h-full w-full object-contain"
        aria-label="remote screen"
      />
      {state !== 'connected' && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {state === 'ended' ? 'session ended' : 'connecting…'}
        </p>
      )}
      {state === 'connected' && fullscreen && !locked && (
        <p className="pointer-events-none absolute inset-x-0 top-4 text-center text-xs text-muted-foreground">
          click to capture the mouse · hold esc for two seconds to leave fullscreen
        </p>
      )}
      {children}
    </div>
  );
}
