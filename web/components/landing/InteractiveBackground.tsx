'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface MousePosition {
  x: number;
  y: number;
}

/** Touch support can't change mid-session — nothing to subscribe to. */
const subscribeNever = () => () => undefined;

const getTouchSnapshot = () =>
  'ontouchstart' in window || navigator.maxTouchPoints > 0;

/**
 * Reports false during SSR *and* the hydration render, so the client's first
 * pass matches the server HTML; the real values arrive on the post-hydration
 * re-render.
 *
 * Do NOT switch to a lazy `useState` initializer: it runs during the hydration
 * render itself and returns the real value where the server returned false,
 * which swapped the animated branch for the static one mid-hydration on every
 * touch device (React error #418).
 */
const getServerSnapshot = () => false;

// the signal's pool of light. paper can't be lit, so by day it is the signal hue
// raised to a pastel tint; translucent cyan at night's strength reads as a grey smudge
const DAY_SIGNAL = '[--glow:oklch(from_var(--accent-cyan)_0.93_0.06_h_/_0.55)]';
const SIGNAL_GRADIENT = 'radial-gradient(circle, var(--glow) 0%, transparent 60%)';

export function InteractiveBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const isTouchDevice = useSyncExternalStore(
    subscribeNever,
    getTouchSnapshot,
    getServerSnapshot,
  );
  const prefersReducedMotion = usePrefersReducedMotion(false);
  const animationRef = useRef<number | null>(null);
  const targetPos = useRef<MousePosition>({ x: 0.5, y: 0.5 });
  const currentPos = useRef<MousePosition>({ x: 0.5, y: 0.5 });

  useEffect(() => {
    if (isTouchDevice || prefersReducedMotion) return;
    const container = containerRef.current;
    if (!container) return;

    // the glows sit centred and move by transform alone: animating left/top
    // relaid and repainted both blur-3xl layers on every frame.
    let width = container.clientWidth;
    let height = container.clientHeight;
    let visible = false;

    // Exponential decay; writes the DOM directly to avoid React re-renders.
    const animate = () => {
      const dx = targetPos.current.x - currentPos.current.x;
      const dy = targetPos.current.y - currentPos.current.y;
      const factor = 0.025;
      // under a tenth of a pixel from the pointer: park until it moves again.
      const settled = Math.abs(dx * width) < 0.1 && Math.abs(dy * height) < 0.1;

      currentPos.current = settled
        ? { ...targetPos.current }
        : { x: currentPos.current.x + dx * factor, y: currentPos.current.y + dy * factor };

      const ox = (currentPos.current.x - 0.5) * width;
      const oy = (currentPos.current.y - 0.5) * height;
      if (primaryRef.current) primaryRef.current.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
      if (secondaryRef.current) secondaryRef.current.style.transform = `translate3d(${-ox}px, ${-oy}px, 0)`;

      animationRef.current = settled ? null : requestAnimationFrame(animate);
    };

    const start = () => {
      if (visible && animationRef.current === null) animationRef.current = requestAnimationFrame(animate);
    };

    const handleMouseMove = (e: MouseEvent) => {
      targetPos.current = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
      start();
    };

    const handleResize = () => {
      width = container.clientWidth;
      height = container.clientHeight;
      start();
    };

    // off screen, nothing is seen to move: stop, and pick up from there on return.
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) {
        start();
      } else if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    });
    observer.observe(container);

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isTouchDevice, prefersReducedMotion]);

  if (isTouchDevice || prefersReducedMotion) {
    return (
      <div className="absolute inset-0 overflow-hidden">
        <div
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(600px,90vw)] h-[min(600px,90vw)] rounded-full blur-3xl ${DAY_SIGNAL} dark:[--glow:color-mix(in_oklch,var(--accent-cyan)_15%,transparent)]`}
          style={{ background: SIGNAL_GRADIENT }}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
    >
      {/* Primary glow - follows mouse, responsive size */}
      <div
        ref={primaryRef}
        className={`absolute w-[min(900px,150vw)] h-[min(900px,150vw)] rounded-full blur-3xl will-change-transform ${DAY_SIGNAL} dark:[--glow:color-mix(in_oklch,var(--accent-cyan)_10%,transparent)]`}
        style={{
          background: SIGNAL_GRADIENT,
          left: 'calc(50% - min(450px, 75vw))',
          top: 'calc(50% - min(450px, 75vw))',
        }}
      />

      {/* Secondary warm glow - offset from mouse for depth. night only: on paper
          its amber crosses the cyan pool and the eye's halo, and complementary
          tints laid over each other cancel to grey */}
      <div
        ref={secondaryRef}
        className="absolute w-[min(600px,100vw)] h-[min(600px,100vw)] rounded-full blur-3xl will-change-transform hidden dark:block"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--accent-warm) 6%, transparent) 0%, color-mix(in oklab, var(--accent-coral) 3%, transparent) 40%, transparent 70%)',
          left: 'calc(50% - min(300px, 50vw))',
          top: 'calc(50% - min(300px, 50vw))',
        }}
      />
    </div>
  );
}
