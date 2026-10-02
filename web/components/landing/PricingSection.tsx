import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';
import {
  INCLUDED_STORAGE,
  PRICING_FACTS,
  STORAGE_OVERAGE,
  usd,
} from '@/lib/product-facts';

interface TierFeature {
  label: string;
  asterisk?: boolean;
}

const coreFeatures: TierFeature[] = [
  { label: 'process monitoring & auto-recovery' },
  { label: 'process control — start, stop, restart, kill' },
  { label: 'display layouts' },
  { label: '1 site with role-based access' },
  { label: 'unlimited machines & members' },
  { label: 'email alerts' },
  { label: 'email support' },
];

const proFeatures: TierFeature[] = [
  { label: 'software & file deployment' },
  { label: 'hoot — AI fleet assistant', asterisk: true },
  { label: 'talons — automations with AI visual checks' },
  { label: 'roost — incremental project sync with atomic deploy and rollback' },
  { label: `${INCLUDED_STORAGE} included project storage per site` },
  { label: `${STORAGE_OVERAGE} overage` },
  { label: '50-version retention with 30-day rollback' },
  { label: 'REST API' },
  { label: 'webhooks' },
  { label: 'CLI + TypeScript SDK' },
  { label: 'unlimited sites' },
  { label: 'priority support' },
];

interface TierCardProps {
  name: string;
  price: string;
  unit: string;
  features: TierFeature[];
  highlighted?: boolean;
  preludeNote?: string;
  priceFootnote?: string;
}

function TierCard({ name, price, unit, features, highlighted = false, preludeNote, priceFootnote }: TierCardProps) {
  return (
    <div
      className={`relative rounded-2xl border bg-card/60 px-6 sm:px-10 text-center flex flex-col ${
        highlighted ? 'border-accent-cyan/40' : 'border-border'
      }`}
    >
      {highlighted && (
        <span className="absolute top-3 right-4 text-xs font-semibold uppercase tracking-wider text-accent-cyan">
          new
        </span>
      )}

      {/* Tier name + price */}
      <div className="py-8">
        <h3 className="text-2xl font-heading font-bold text-foreground mb-4">
          {name}
        </h3>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-1 opacity-35">
          <span className="text-5xl sm:text-6xl font-heading font-bold text-foreground line-through decoration-2">
            {price}
          </span>
          <span className="text-lg sm:text-xl">
            {unit}
          </span>
        </div>
        <p className="text-accent-warm font-semibold text-xl">
          free during beta
        </p>
        {/* Always rendered (with a non-breaking-space fallback) so the
            horizontal divider lines up across both cards regardless of
            whether the tier has a price footnote. */}
        <p
          className={`text-sm text-muted-foreground mt-2 ${priceFootnote ? '' : 'opacity-0 select-none'}`}
          aria-hidden={priceFootnote ? undefined : true}
        >
          {priceFootnote ?? ' '}
        </p>
      </div>

      <hr className="border-border/50" />

      {/* Features */}
      <div className="py-8 flex-1">
        {preludeNote && (
          <p className="text-sm text-muted-foreground mb-5 text-left">
            {preludeNote}
          </p>
        )}
        <ul className="flex flex-col gap-y-4 text-left">
          {features.map(({ label, asterisk }) => (
            <li
              key={label}
              className="flex items-start gap-2.5 text-base sm:text-lg text-foreground/80 text-pretty"
            >
              <Check className="w-4 h-4 mt-1.5 text-accent-cyan shrink-0" />
              <span>
                {label}
                {asterisk && (
                  <span className="text-muted-foreground text-xs align-super -ml-0.5">*</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <hr className="border-border/50" />

      {/* CTA */}
      <div className="py-8">
        <Button
          asChild
          size="lg"
          className="w-full sm:w-auto mx-auto text-background font-semibold px-10 h-12 text-base"
        >
          <Link href="/register">get started</Link>
        </Button>
      </div>
    </div>
  );
}

export function PricingSection() {
  return (
    <section id="pricing" className="pt-16 sm:pt-24 pb-32 sm:pb-48 px-4 sm:px-6 -scroll-mt-8 sm:-scroll-mt-16">
      <div className="max-w-5xl mx-auto">
        <div className="text-center max-w-3xl mx-auto">
          <h2 className="section-headline text-foreground mb-4">
            simple, transparent pricing.
          </h2>
          <p className="section-subheadline mb-12">
            two tiers. no hidden fees. pay only for what you run.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
          <TierCard
            name="core"
            price={usd(PRICING_FACTS.core.list)}
            unit="/machine/month"
            features={coreFeatures}
            priceFootnote={`${usd(PRICING_FACTS.core.founders)} founders rate — first ${PRICING_FACTS.foundersCohort}`}
          />
          <TierCard
            name="pro"
            price={usd(PRICING_FACTS.pro.list)}
            unit="/machine/month"
            features={proFeatures}
            highlighted
            preludeNote="everything in core, plus:"
            priceFootnote={`${PRICING_FACTS.pro.minMachines}-machine minimum · ${usd(PRICING_FACTS.pro.founders)} founders rate — first ${PRICING_FACTS.foundersCohort}`}
          />
        </div>

        <div className="text-center max-w-3xl mx-auto">
          <p className="mt-10 section-subheadline">
            need volume pricing or an enterprise agreement?{' '}
            <a href="mailto:hey@tridant.io" className="hl-link hl-link-plain text-foreground">
              get in touch
            </a>
          </p>
          <p className="mt-10 text-sm text-muted-foreground/80">
            founders pricing is the rate you keep, not an introductory period.
          </p>
          <p className="mt-2 text-sm text-muted-foreground/80">
            * hoot requires your own API key (OpenAI, Anthropic, or compatible)
          </p>
        </div>
      </div>
    </section>
  );
}
