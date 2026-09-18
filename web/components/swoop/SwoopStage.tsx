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
 * the wrapper is what input capture binds to (task 4.6/5.2), which is why it is
 * focusable and why the fullscreen/keyboard-lock gesture will target it.
 *
 * **`object-contain` on the video is load-bearing.** a `<video>` whose aspect
 * ratio does not match its box letterboxes, and `session.contentRect()` derives
 * the picture's box from exactly this fit and this (default, centred) position.
 * input capture normalises against that rect, not the element's — normalising
 * against the element makes `0..1` span the black bars and every pointer
 * position lands offset. changing the fit or the object-position here without
 * changing `contentRect` breaks clicks on every non-matching aspect ratio.
 */

import type { RefObject } from 'react';
import type { SwoopSession } from '@/lib/swoop/features';
import type { SwoopSessionState } from '@/hooks/useSwoopSession';

export interface SwoopStageProps {
  session: SwoopSession | null;
  state: SwoopSessionState;
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  children?: React.ReactNode;
}

export function SwoopStage({ state, stageRef, videoRef, children }: SwoopStageProps) {
  return (
    <div
      ref={stageRef}
      tabIndex={-1}
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
      {children}
    </div>
  );
}
