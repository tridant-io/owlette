import Link from 'next/link';
import { ArrowRight, Check, Eye, Layers, RotateCcw, AlertTriangle } from 'lucide-react';

export function DisplaySection() {
  return (
    <section className="py-16 sm:py-24 px-4 sm:px-6 relative">
      <div className="max-w-5xl mx-auto">

        {/* Headline */}
        <div className="max-w-2xl mx-auto text-center mb-12 sm:mb-16">
          <h2 className="section-headline text-foreground mb-4 leading-tight text-balance">
            displays that stay put.
          </h2>
          <p className="section-subheadline text-balance max-w-xl mx-auto">
            windows can lose your display layout after a driver update, a
            restart, or an accidental change. owlette captures the layout you
            want, watches for drift, and restores it automatically.
          </p>
        </div>

        {/* Storyboard — three frames cycling baseline → drift → restored. by day
            the translucent mono captions print at full strength, and amber on its
            own tint a step deeper: on paper the night's inks fall under 4.5:1 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6 mb-8">

          {/* Frame 1 — baseline captured */}
          <figure className="flex flex-col">
            <div className="flex-1 rounded-xl border border-accent-cyan/30 bg-card/60 p-5 shadow-2xl shadow-elevation-shadow/60 ring-1 ring-elevation-ring/50 display-section-frame display-section-frame-baseline">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] uppercase tracking-wider text-accent-cyan dark:text-accent-cyan/80 font-mono">
                  baseline
                </span>
                <span className="flex items-center gap-1 text-[10px] text-accent-cyan dark:text-accent-cyan/70 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan" />
                  captured
                </span>
              </div>

              {/* Mosaic 2x2 monitor topology — all aligned */}
              <div className="grid grid-cols-2 gap-1.5 mb-4 aspect-[16/9]">
                {[1, 2, 3, 4].map((n) => (
                  <div
                    key={n}
                    className="rounded-md border border-accent-cyan/30 bg-accent-cyan/5 flex items-center justify-center"
                  >
                    <span className="text-[10px] text-accent-cyan dark:text-accent-cyan/70 font-mono">{n}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-md bg-accent-cyan/10 border border-accent-cyan/30 px-3 py-2 text-center">
                <span className="text-xs font-medium text-accent-cyan">
                  layout saved
                </span>
              </div>
            </div>
            <figcaption className="text-center text-xs text-muted-foreground mt-3 font-mono">
              known-good layout
            </figcaption>
          </figure>

          {/* Frame 2 — drift detected: monitors 2 and 3 off-baseline */}
          <figure className="flex flex-col">
            <div className="flex-1 rounded-xl border border-accent-warm/40 bg-card/60 p-5 shadow-2xl shadow-elevation-shadow/60 ring-1 ring-elevation-ring/50 display-section-frame display-section-frame-drift">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] uppercase tracking-wider text-accent-warm dark:text-accent-warm/80 font-mono">
                  drift
                </span>
                <span className="flex items-center gap-1 text-[10px] text-accent-warm dark:text-accent-warm/80 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-warm display-section-pulse" />
                  detected
                </span>
              </div>

              {/* Same 2x2 mosaic, but monitors 2 and 3 visibly displaced */}
              <div className="grid grid-cols-2 gap-1.5 mb-4 aspect-[16/9]">
                <div className="rounded-md border border-accent-cyan/30 bg-accent-cyan/5 flex items-center justify-center">
                  <span className="text-[10px] text-accent-cyan dark:text-accent-cyan/70 font-mono">1</span>
                </div>
                <div className="relative rounded-md border border-accent-warm/60 bg-accent-warm/10 flex items-center justify-center display-section-drift-2">
                  <span className="text-[10px] text-accent-warm-hover dark:text-accent-warm font-mono">2</span>
                  <AlertTriangle
                    className="absolute -top-1.5 -right-1.5 w-3 h-3 text-accent-warm"
                    strokeWidth={2.5}
                    aria-hidden="true"
                  />
                </div>
                <div className="relative rounded-md border border-accent-warm/60 bg-accent-warm/10 flex items-center justify-center display-section-drift-3">
                  <span className="text-[10px] text-accent-warm-hover dark:text-accent-warm font-mono">3</span>
                </div>
                <div className="rounded-md border border-accent-cyan/30 bg-accent-cyan/5 flex items-center justify-center">
                  <span className="text-[10px] text-accent-cyan dark:text-accent-cyan/70 font-mono">4</span>
                </div>
              </div>

              <div className="rounded-md bg-accent-warm/10 border border-accent-warm/30 px-3 py-2 text-center">
                <span className="text-xs font-medium text-accent-warm-hover dark:text-accent-warm">
                  layout changed
                </span>
              </div>
            </div>
            <figcaption className="text-center text-xs text-muted-foreground mt-3 font-mono">
              drift detected
            </figcaption>
          </figure>

          {/* Frame 3 — restored to baseline */}
          <figure className="flex flex-col">
            <div className="flex-1 rounded-xl border border-accent-cyan/30 bg-card/60 p-5 shadow-2xl shadow-elevation-shadow/60 ring-1 ring-elevation-ring/50 display-section-frame display-section-frame-restored">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] uppercase tracking-wider text-accent-cyan dark:text-accent-cyan/80 font-mono">
                  restored
                </span>
                <span className="flex items-center gap-1 text-[10px] text-accent-cyan dark:text-accent-cyan/70 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent-cyan" />
                  ack
                </span>
              </div>

              {/* Restored 2x2 mosaic with a centered check */}
              <div className="relative grid grid-cols-2 gap-1.5 mb-4 aspect-[16/9]">
                {[1, 2, 3, 4].map((n) => (
                  <div
                    key={n}
                    className="rounded-md border border-accent-cyan/30 bg-accent-cyan/5 flex items-center justify-center"
                  >
                    <span className="text-[10px] text-accent-cyan dark:text-accent-cyan/70 font-mono">{n}</span>
                  </div>
                ))}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="w-12 h-12 rounded-full bg-accent-cyan/20 border border-accent-cyan/50 flex items-center justify-center backdrop-blur-sm">
                    <Check className="w-7 h-7 text-accent-cyan" strokeWidth={2.5} />
                  </div>
                </div>
              </div>

              <div className="rounded-md bg-accent-cyan/10 border border-accent-cyan/30 px-3 py-2 text-center">
                <span className="text-xs font-medium text-accent-cyan">
                  baseline restored
                </span>
              </div>
            </div>
            <figcaption className="text-center text-xs text-muted-foreground mt-3 font-mono">
              auto-restored
            </figcaption>
          </figure>
        </div>

        {/* Lifecycle arrows — linear: captured → drift detected → auto-restored */}
        <div className="flex items-center justify-center gap-2 flex-wrap mb-14 sm:mb-16 text-[11px] sm:text-xs font-mono text-muted-foreground/80">
          <span className="text-accent-cyan dark:text-accent-cyan/80">captured</span>
          <ArrowRight className="w-3 h-3" aria-hidden="true" />
          <span className="text-accent-warm dark:text-accent-warm/80">drift detected</span>
          <ArrowRight className="w-3 h-3" aria-hidden="true" />
          <span className="text-accent-cyan dark:text-accent-cyan/80">auto-restored</span>
        </div>

        {/* Three proof bullets */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 sm:gap-10 mb-12">
          <div className="text-center">
            <Eye className="w-7 h-7 mx-auto mb-3 text-accent-cyan" />
            <h3 className="text-lg font-bold font-heading text-foreground mb-2">
              drift detection
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              owlette watches for changes after restarts, driver updates, and
              accidental config edits. when something drifts, you&apos;ll know.
            </p>
          </div>

          <div className="text-center">
            <RotateCcw className="w-7 h-7 mx-auto mb-3 text-accent-cyan" />
            <h3 className="text-lg font-bold font-heading text-foreground mb-2">
              auto-restore
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              your known-good layout is restored automatically &mdash; no manual
              intervention, no kiosk that needs a keyboard found in the ceiling.
            </p>
          </div>

          <div className="text-center">
            <Layers className="w-7 h-7 mx-auto mb-3 text-accent-cyan" />
            <h3 className="text-lg font-bold font-heading text-foreground mb-2">
              mosaic-aware
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              detects and protects active nvidia mosaic configurations. owlette
              won&apos;t blindly rewrite a wall it shouldn&apos;t touch.
            </p>
          </div>
        </div>

        {/* Footer link */}
        <div className="text-center">
          <Link
            href="/docs/api"
            className="inline-flex items-center gap-1.5 text-base text-accent-cyan hover:text-accent-cyan-hover transition-colors group"
          >
            read the display api reference
            <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
          </Link>
        </div>

      </div>

      {/* CSS-only animations: linear baseline → drift → restored cycle on a 9s
          loop. Each frame highlights for ~3s of the cycle by lifting and
          glowing slightly; otherwise it sits at rest. The drift frame's
          displaced monitors (2, 3) animate into their off-baseline position
          during the drift phase only. */}
      {/* No nonce: the CSP grants styles via `style-src 'self' 'unsafe-inline'`
          with no style nonce at all (see proxy.ts), so a nonce here would be
          inert — and browsers blank the `nonce` content attribute on insert,
          which made React's hydration diff report a false mismatch. */}
      <style>{`
        @keyframes display-section-pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.35; }
        }
        .display-section-pulse {
          animation: display-section-pulse 1.4s ease-in-out infinite;
        }

        /* Each frame is highlighted (subtle lift) for one third of a 9s cycle,
           then dims back to rest. Phase offsets: baseline 0/9, drift 3/9,
           restored 6/9. Highlight = full opacity + small translateY lift.
           Rest = 65% opacity, no lift. */
        @keyframes display-section-cycle-baseline {
          0%, 28%   { opacity: 1; transform: translateY(-2px); }
          33%, 95%  { opacity: 0.65; transform: translateY(0); }
          100%      { opacity: 1; transform: translateY(-2px); }
        }
        @keyframes display-section-cycle-drift {
          0%, 28%   { opacity: 0.65; transform: translateY(0); }
          33%, 61%  { opacity: 1; transform: translateY(-2px); }
          66%, 100% { opacity: 0.65; transform: translateY(0); }
        }
        @keyframes display-section-cycle-restored {
          0%, 61%   { opacity: 0.65; transform: translateY(0); }
          66%, 95%  { opacity: 1; transform: translateY(-2px); }
          100%      { opacity: 0.65; transform: translateY(0); }
        }
        .display-section-frame {
          will-change: transform, opacity;
        }
        .display-section-frame-baseline {
          animation: display-section-cycle-baseline 9s ease-in-out infinite;
        }
        .display-section-frame-drift {
          animation: display-section-cycle-drift 9s ease-in-out infinite;
        }
        .display-section-frame-restored {
          animation: display-section-cycle-restored 9s ease-in-out infinite;
        }

        /* Drift monitors slide off-baseline during the drift phase, then
           snap back to rest as the cycle moves on. Monitor 2 nudges right,
           monitor 3 nudges left + down — visibly displaced but still legible. */
        @keyframes display-section-drift-2 {
          0%, 28%    { transform: translate(0, 0); }
          33%, 61%   { transform: translate(4px, -2px); }
          66%, 100%  { transform: translate(0, 0); }
        }
        @keyframes display-section-drift-3 {
          0%, 28%    { transform: translate(0, 0); }
          33%, 61%   { transform: translate(-3px, 3px); }
          66%, 100%  { transform: translate(0, 0); }
        }
        .display-section-drift-2 {
          animation: display-section-drift-2 9s ease-in-out infinite;
        }
        .display-section-drift-3 {
          animation: display-section-drift-3 9s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .display-section-pulse,
          .display-section-frame-baseline,
          .display-section-frame-drift,
          .display-section-frame-restored,
          .display-section-drift-2,
          .display-section-drift-3 {
            animation: none;
          }
          .display-section-frame-baseline,
          .display-section-frame-drift,
          .display-section-frame-restored {
            opacity: 1;
            transform: none;
          }
        }
      `}</style>
    </section>
  );
}
