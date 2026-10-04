'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { InteractiveBackground } from './InteractiveBackground';
import { EYE_HALO_DAY, EYE_HALO_GRADIENT, OwletteEye } from './OwletteEye';
import type { HeroHeadline } from '@/lib/heroHeadlines';
import { LICENSE_URL } from '@/lib/repoLinks';

interface HeroSectionProps {
  /** Chosen per request by the server component — see app/page.tsx. */
  headline: HeroHeadline;
}

export function HeroSection({ headline }: HeroSectionProps) {
  return (
    <section className="relative sm:min-h-[100dvh] flex flex-col pt-16 overflow-hidden">
      {/* Interactive mouse-reactive background */}
      <InteractiveBackground />

      {/* Content wrapper — the block sits 18vh above centre, so the headline lands
          near the middle with the eye above it. two spacers share the free space
          (the lower one starts 36vh ahead), and the upper one never shrinks past a
          gap under the header, so a short window can't push the eye beneath it. */}
      <div className="relative z-10 w-full max-w-5xl mx-auto px-4 sm:px-6 text-center flex flex-col items-center flex-1 justify-center py-12 sm:py-0">
        <div aria-hidden className="hidden sm:block flex-[1_1_0%] min-h-8" />
        {/* The Eye */}
        <div className="relative flex items-center justify-center mb-6 sm:mb-8">
          <div
            className={`absolute w-[300px] h-[300px] sm:w-[500px] sm:h-[500px] rounded-full blur-3xl ${EYE_HALO_DAY} dark:[--halo-core:color-mix(in_oklch,var(--accent-coral)_15%,transparent)] dark:[--halo-edge:color-mix(in_oklch,var(--accent-warm)_8%,transparent)]`}
            style={{ background: EYE_HALO_GRADIENT }}
          />
          <OwletteEye
            size={220}
            className="sm:w-[320px] sm:h-[320px] drop-shadow-2xl relative z-10"
            animated
          />
        </div>

        {/* Headline — text-balance rather than a hardcoded <br>, since the
            phrase varies per load and a fixed break point would split most of
            them in the wrong place. Every phrase fits one line at the 72px
            desktop ceiling; balancing is what keeps the longer ones from
            leaving an orphan word on phones. */}
        <h1 className="hero-headline text-foreground mb-4 sm:mb-6 hero-enter text-balance">
          {headline}
        </h1>

        {/* Subheadline */}
        <p className="hero-subheadline max-w-5xl mx-auto mb-8 sm:mb-10 hero-enter-delay-1">
          {/* Non-breaking space: "24/7" must never wrap onto its own line. */}
          owlette keeps your installations running&nbsp;24/7
        </p>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center hero-enter-delay-2">
          <Button asChild size="lg" className="text-background font-semibold px-8 h-12 text-base">
            <Link href="/register">get started</Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="border-border/50 hover:bg-accent-warm/10 hover:border-accent-warm/30 h-12 text-base text-muted-foreground">
            <Link href="/demo" target="_blank">see the live demo</Link>
          </Button>
        </div>

        {/* Platform pill row */}
        <p className="mt-6 sm:mt-8 text-xs sm:text-sm text-muted-foreground text-center hero-enter-delay-3">
          windows, macos and linux <span className="mx-1 sm:mx-2">&middot;</span> free during beta <span className="mx-1 sm:mx-2">&middot;</span>
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            FSL-1.1 source on github
          </a>
        </p>
        <div aria-hidden className="hidden sm:block flex-[1_1_36vh]" />
      </div>

    </section>
  );
}
