'use client';

import { OwletteFeather } from '@/components/icons/OwletteFeather';

// the brand's warm glow. on light paper the peach sits darker than the ground
// and reads as a smudge, so it is fainter there
const GLOW = 'drop-shadow-[0_0_6px_rgba(240,184,154,0.2)] dark:drop-shadow-[0_0_6px_rgba(240,184,154,0.35)]';

/**
 * Two golden feathers drifting down in mirrored pendulum arcs — the boot-splash
 * idle animation. Pure CSS (keyframes in globals.css). Each nested layer
 * animates one axis (descent / sway / arc-bob / tilt) so each gets its own
 * easing; composed they trace the falling-leaf path. The second feather is
 * mirrored and phase-shifted half a descent.
 *
 * No overflow clipping — the fall keyframes fade each feather in and out.
 * Hidden under prefers-reduced-motion: the global motion clamp freezes keyframes
 * at their end state, which would leave feathers hanging mid-air.
 */
export function FallingFeather() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative h-44 w-40 motion-reduce:hidden"
    >
      <div className="absolute left-[30%] top-4 -ml-3.5">
        <div className="feather-fall">
          <div className="feather-sway">
            <div className="feather-arc">
              <div className="feather-tilt">
                <OwletteFeather className={GLOW} />
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Mirrored sibling: scaleX(-1) on the WRAPPER, because the fall animation
          owns `transform` on the element below it. */}
      <div className="absolute left-[70%] top-4 -ml-3.5 -scale-x-100">
        <div className="feather-delayed feather-fall">
          <div className="feather-sway">
            <div className="feather-arc">
              <div className="feather-tilt">
                <OwletteFeather className={GLOW} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
