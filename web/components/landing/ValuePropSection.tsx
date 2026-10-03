'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ThemedImage } from '@/components/ThemedImage';

// the deepest layer was black at 0.6 and elevation-shadow stops at 0.5: a fifth of
// the page tone lifts the alpha to 0.6 and still reads black. by day it is the
// token's soft navy
const FRAME_SHADOW =
  '0 80px 160px -30px color-mix(in oklab, var(--elevation-shadow) 80%, var(--background)), ' +
  '0 40px 80px -20px color-mix(in oklab, var(--elevation-shadow) 80%, transparent), ' +
  '0 0 0 1px color-mix(in oklab, var(--elevation-ring) 50%, transparent)';

// the glint that follows the pointer: white light on the glass at night, a soft
// daylight glare by day, where a white wash at night's strength would vanish
const SHEEN =
  '[--sheen:color-mix(in_oklab,var(--card)_40%,transparent)] dark:[--sheen:color-mix(in_oklab,var(--elevation-ring)_60%,transparent)]';

const sheenAt = (x: number, y: number) =>
  `radial-gradient(ellipse 600px 400px at ${x}% ${y}%, var(--sheen) 0%, transparent 70%)`;

export function ValuePropSection() {
  const containerRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLAnchorElement>(null);
  const sheenRef = useRef<HTMLDivElement>(null);
  const target = useRef({ x: 8, y: 0 });
  const current = useRef({ x: 8, y: 0 });
  const sheenTarget = useRef({ x: 50, y: 50 });
  const sheenCurrent = useRef({ x: 50, y: 50 });
  const raf = useRef<number | null>(null);
  const isVisible = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Only animate when the section is in the viewport
    const handleMouseMove = (e: MouseEvent) => {
      if (!isVisible.current) return;
      const rect = container.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width * 2 - 1;
      const ny = (e.clientY - rect.top) / rect.height * 2 - 1;
      target.current = {
        x: 8 - ny * 6,
        y: nx * 5,
      };
      sheenTarget.current = {
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100,
      };
      start();
    };

    // the loop parks once it settles; a move or a return to view restarts it.
    const start = () => {
      if (isVisible.current && !raf.current) raf.current = requestAnimationFrame(animate);
    };

    const animate = () => {
      if (!isVisible.current) {
        raf.current = null;
        return; // Stop RAF when not visible — restarted by IntersectionObserver
      }

      const factor = 0.06;
      const cur = current.current;
      const tgt = target.current;
      const sc = sheenCurrent.current;
      const st = sheenTarget.current;
      // close enough to the pointer to stop: the sheen is a full-size gradient
      // and every write repaints it, so it must not run on with nothing moving.
      const settled = [tgt.x - cur.x, tgt.y - cur.y, st.x - sc.x, st.y - sc.y].every((d) => Math.abs(d) < 0.01);

      if (settled) {
        Object.assign(cur, tgt);
        Object.assign(sc, st);
      } else {
        cur.x += (tgt.x - cur.x) * factor;
        cur.y += (tgt.y - cur.y) * factor;
        sc.x += (st.x - sc.x) * factor;
        sc.y += (st.y - sc.y) * factor;
      }

      // Write directly to DOM — no React re-render
      if (tiltRef.current) {
        tiltRef.current.style.transform = `rotateX(${cur.x}deg) rotateY(${cur.y}deg)`;
      }
      if (sheenRef.current) {
        sheenRef.current.style.background = sheenAt(sc.x, sc.y);
      }

      raf.current = settled ? null : requestAnimationFrame(animate);
    };

    // Only run RAF when section is in viewport
    const observer = new IntersectionObserver(
      ([entry]) => {
        isVisible.current = entry.isIntersecting;
        start();
      },
      { threshold: 0 }
    );
    observer.observe(container);

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (raf.current) cancelAnimationFrame(raf.current);
      observer.disconnect();
    };
  }, []);

  return (
    <section className="pt-0 sm:pt-0 pb-0 px-4 sm:px-6 mt-8 sm:-mt-24">
      {/* Product screenshot with mouse-reactive 3D tilt */}
      {/* the lcp image: it rises in but is never held transparent, which
          would hold back largest contentful paint until the fade began. */}
      <div
        ref={containerRef}
        className="max-w-6xl mx-auto mb-6 sm:mb-8 motion-safe:animate-in slide-in-from-bottom-4 duration-800 ease-out"
        style={{ perspective: '1800px' }}
      >
        <Link
          ref={tiltRef}
          href="/demo"
          target="_blank"
          className="block relative rounded-xl overflow-hidden cursor-pointer"
          style={{
            transform: `rotateX(8deg) rotateY(0deg)`,
            transformOrigin: 'center center',
            boxShadow: FRAME_SHADOW,
            willChange: 'transform',
          }}
        >
          <ThemedImage
            dark="/landing-screens/dashboard.png"
            light="/landing-screens/dashboard.png"
            alt="owlette dashboard showing 10 machines with real-time metrics"
            width={1920}
            height={1080}
            // max-w-6xl inside px-6 (px-4 below sm) caps it at 1152px from a 1200px viewport.
            sizes="(max-width: 1200px) 100vw, 1152px"
            quality={90}
            className="w-full h-auto"
            preload
            fetchPriority="high"
          />
          {/* Sheen overlay */}
          <div
            ref={sheenRef}
            className={`absolute inset-0 pointer-events-none ${SHEEN}`}
            style={{ background: sheenAt(50, 50) }}
          />
        </Link>
      </div>
      <div className="text-center mt-12 mb-16 sm:mb-20">
        <Link
          href="/demo"
          target="_blank"
          className="inline-flex items-center gap-1.5 text-base text-accent-cyan hover:text-accent-cyan-hover transition-colors group"
        >
          explore the live demo
          <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      {/* Text below */}
      <div className="max-w-2xl mx-auto text-center">
        <h2 className="section-headline text-foreground mb-4 leading-tight">
          one dashboard for every screen, every machine, everywhere.
        </h2>
        <p className="section-subheadline text-balance">
          owlette lets you monitor, control, and update all of your computers
          remotely &mdash; so you always know they&apos;re running, even when
          you&apos;re not there.
        </p>
      </div>
    </section>
  );
}
