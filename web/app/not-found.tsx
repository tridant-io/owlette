'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { OwletteEye } from '@/components/landing/OwletteEye';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/** `still` paints one frame of the rain and stops there. */
function RainCanvas({ still }: { still: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const initDrops = useCallback((width: number, height: number) => {
    const spacing = 24;
    const cols = Math.floor(width / spacing);
    const drops: { x: number; y: number; speed: number; opacity: number }[] = [];
    for (let i = 0; i < cols; i++) {
      drops.push({
        x: i * spacing + spacing / 2,
        y: Math.random() * height,
        speed: 0.5 + Math.random() * 1.0,
        opacity: 0.1 + Math.random() * 0.2,
      });
    }
    return drops;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let drops: ReturnType<typeof initDrops>;

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
      drops = initDrops(canvas!.width, canvas!.height);
      // resizing clears the canvas, so a still frame is painted again.
      if (still) draw();
    }

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      for (const drop of drops) {
        ctx!.beginPath();
        ctx!.arc(drop.x, drop.y, 1.35, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(97, 112, 155, ${drop.opacity + 0.05})`;
        ctx!.fill();

        drop.y += drop.speed;
        if (drop.y > canvas!.height + 10) {
          drop.y = -10;
          drop.opacity = 0.05 + Math.random() * 0.15;
        }
      }
      if (!still) animId = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    if (!still) draw();
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, [initDrops, still]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 1 }}
    />
  );
}

export default function NotFound() {
  const [glitch, setGlitch] = useState(false);
  // no rain and no glitch until hydration says motion is welcome.
  const reducedMotion = usePrefersReducedMotion(true);

  useEffect(() => {
    if (reducedMotion) return;
    const interval = setInterval(() => {
      setGlitch(true);
      setTimeout(() => setGlitch(false), 200);
    }, 4000);
    return () => clearInterval(interval);
  }, [reducedMotion]);

  return (
    <div className="relative min-h-[100dvh] flex flex-col items-center justify-center overflow-hidden pb-24">
      {/* Dot grid background */}
      <div className="absolute inset-0 dot-grid opacity-40" />

      {/* Raining dots */}
      <RainCanvas still={reducedMotion} />

      {/* Radial glow behind the eye */}
      <div
        className="absolute w-[500px] h-[500px] rounded-full blur-3xl opacity-30"
        style={{
          background: 'radial-gradient(circle, oklch(0.70 0.14 30 / 0.4) 0%, oklch(0.72 0.16 55 / 0.15) 40%, transparent 70%)',
        }}
      />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center text-center px-6">
        {/* The Eye */}
        <div className="relative mb-5 animate-in fade-in zoom-in-50 duration-1000">
          <OwletteEye size={110} className="drop-shadow-2xl" animated />
        </div>

        <h1 className="sr-only">404: page not found</h1>
        {/* the ghost numeral is decoration (wcag 1.4.3 exempts it); the sr-only h1
            carries the meaning */}
        <div
          aria-hidden="true"
          className={`font-mono text-[5.5rem] sm:text-[8.5rem] font-bold leading-none tracking-tighter mb-6 transition-all duration-100 ${
            glitch
              ? 'text-accent-coral skew-x-2 scale-x-[1.02]'
              : 'text-foreground/10'
          }`}
          style={{
            textShadow: glitch
              ? '3px 0 oklch(0.75 0.18 195), -3px 0 oklch(0.70 0.14 30)'
              : 'none',
          }}
        >
          404
        </div>

        {/* One-liner */}
        <p className="text-lg sm:text-xl text-muted-foreground font-light tracking-wide mb-8 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
          all these pages will be lost in time...
          <br className="mb-0" />
          <span className="inline-block mt-1.5">like tears in rain.</span>
        </p>

        {/* Single CTA */}
        <Button
          asChild
          className="text-background font-semibold px-7 h-11 text-sm animate-in fade-in slide-in-from-bottom-6 duration-700 delay-500"
        >
          <Link href="/">go home</Link>
        </Button>
      </div>
    </div>
  );
}
