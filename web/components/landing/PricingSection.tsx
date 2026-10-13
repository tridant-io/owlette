import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';
import {
  AFTER_BETA,
  FREE_SCOPE,
  INCLUDED_STORAGE,
  PRICING_FACTS,
  STORAGE_OVERAGE,
  usd,
} from '@/lib/product-facts';

interface TierFeature {
  label: string;
  asterisk?: boolean;
}

const freeFeatures: TierFeature[] = [
  { label: FREE_SCOPE },
  { label: 'live status & metrics' },
  { label: 'crash detection & auto-restart' },
  { label: 'owlette updates' },
];

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
  { label: 'swoop — live remote desktop in the browser' },
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
  unit?: string;
  /** a list price is struck while beta makes it free; owlette free has none to strike. */
  struck?: boolean;
  note?: string;
  features: TierFeature[];
  highlighted?: boolean;
  preludeNote?: string;
  priceFootnote?: string;
}

function TierCard({
  name,
  price,
  unit,
  struck = true,
  note = 'free during beta',
  features,
  highlighted = false,
  preludeNote,
  priceFootnote,
}: TierCardProps) {
  // on wide screens each card's five blocks sit on rows shared across the
  // cards (subgrid), so the dividers line up however the price wraps
  return (
    <div
      className={`relative rounded-2xl border bg-card/60 px-6 sm:px-10 lg:px-8 text-center flex flex-col lg:grid lg:grid-rows-subgrid lg:row-span-5 ${
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
        {/* translucent ink loses more contrast on paper than on navy, so the
            struck price takes more of it by day to fade by the same amount */}
        <div
          className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 mb-1 ${
            struck ? 'opacity-50 dark:opacity-35' : ''
          }`}
        >
          <span
            className={`text-5xl sm:text-6xl font-heading font-bold text-foreground ${
              struck ? 'line-through decoration-2' : ''
            }`}
          >
            {price}
          </span>
          {unit && (
            <span className="text-lg sm:text-xl">
              {unit}
            </span>
          )}
        </div>
        <p className="text-accent-warm font-semibold text-xl">
          {note}
        </p>
        {priceFootnote && (
          <p className="text-sm text-muted-foreground mt-2">
            {priceFootnote}
          </p>
        )}
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
      <div className="max-w-6xl mx-auto">
        <div className="text-center max-w-3xl mx-auto">
          <h2 className="section-headline text-foreground mb-4">
            simple, transparent pricing.
          </h2>
          <p className="section-subheadline mb-12">
            three tiers. no hidden fees. pay only for what you run.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-x-6 lg:gap-y-0">
          <TierCard
            name="owlette free"
            price="free"
            struck={false}
            note="after beta, too"
            features={freeFeatures}
          />
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
            {AFTER_BETA}
          </p>
          <p className="mt-2 text-sm text-muted-foreground/80">
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
