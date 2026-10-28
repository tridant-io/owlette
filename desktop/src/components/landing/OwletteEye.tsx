'use client';

import { useId } from 'react';

/**
 * light to warm to dark. all but the centre are theme tokens (globals.css --eye-*):
 * at night the falloff ends in near-black, a light in the dark; by day it stays
 * copper to the edge, a lit bead on the paper. mirrors
 * web/components/landing/OwletteEye.tsx.
 */
const EYE_STOPS = [
  ['0%', '#FFE8DC'],
  ['45%', 'var(--eye-glow)'],
  ['65%', 'var(--eye-iris)'],
  ['78%', 'var(--eye-band-1)'],
  ['83%', 'var(--eye-band-2)'],
  ['87%', 'var(--eye-band-3)'],
  ['100%', 'var(--eye-edge)'],
] as const;

/** the mark itself, shared by both components; `sheen` is the highlight's opacity */
function EyeArt({ uid, sheen }: { uid: string; sheen: string }) {
  return (
    <>
      <defs>
        <radialGradient id={`${uid}-eye`} cx="50%" cy="50%" r="50%">
          {EYE_STOPS.map(([offset, color]) => (
            <stop key={offset} offset={offset} style={{ stopColor: color }} />
          ))}
        </radialGradient>
        <radialGradient id={`${uid}-sheen`} cx="42%" cy="40%" r="25%">
          <stop offset="0%" style={{ stopColor: '#FFFFFF', stopOpacity: sheen }} />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-red-wash`} x1="0%" y1="50%" x2="100%" y2="50%">
          <stop offset="0%" stopColor="#C03020" stopOpacity="0.55" />
          <stop offset="35%" stopColor="#C03020" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* The eye — single gradient, light to warm to dark */}
      <circle cx="100" cy="100" r="88" fill={`url(#${uid}-eye)`} />

      {/* Red wash — left to right. at night only over the bright centre (the dark
          band hides its edge); by day over the whole disc, or the copper shows it */}
      <circle cx="100" cy="100" r="68" fill={`url(#${uid}-red-wash)`} style={{ opacity: 'var(--eye-wash-core)' }} />
      <circle cx="100" cy="100" r="88" fill={`url(#${uid}-red-wash)`} style={{ opacity: 'var(--eye-wash-disc)' }} />

      {/* Rim — dark at night, none by day */}
      <circle cx="100" cy="100" r="88" fill="none" style={{ stroke: 'var(--eye-rim)' }} strokeWidth="2" />

      {/* White sheen */}
      <circle cx="88" cy="86" r="18" fill={`url(#${uid}-sheen)`} />
    </>
  );
}

interface OwletteEyeProps {
  size?: number;
  className?: string;
  animated?: boolean;
}

export function OwletteEye({ size = 400, className = '', animated = false }: OwletteEyeProps) {
  const uid = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={`${className} ${animated ? 'animate-eye-ignite' : ''}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      <EyeArt uid={uid} sheen="var(--eye-sheen)" />

      {/* Animated breath */}
      {animated && (
        <circle cx="100" cy="100" r="88" fill={`url(#${uid}-eye)`} opacity="0.2">
          <animate attributeName="r" values="88;92;88" dur="5s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.2;0;0.2" dur="5s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}

export function OwletteEyeIcon({ size = 32, className = '' }: { size?: number; className?: string }) {
  const uid = useId();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <EyeArt uid={uid} sheen="var(--eye-icon-sheen)" />
    </svg>
  );
}
