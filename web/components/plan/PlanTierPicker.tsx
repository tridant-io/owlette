'use client';

/**
 * core and pro side by side, with each one's price and what it adds: how an
 * owner picks a site's plan, in the upgrade dialog and when a new site is
 * created on a plan. prices are PRICING_FACTS; a plan shows its founders price
 * while `foundersRate` says the owner gets it.
 */

import { Check } from 'lucide-react';
import type { BillingTier } from '@/hooks/useSiteBilling';
import type { AccountPlanOn } from '@/lib/planResponse';
import { PRICING_FACTS, usd } from '@/lib/product-facts';
import { cn } from '@/lib/utils';

const TIERS: readonly BillingTier[] = ['core', 'pro'];

/**
 * whether the account plan says the owner gets the founders rate on `tier`: a
 * place is left, or a site they own is billed at it, or was, which tridant id
 * honours past the cap.
 */
export function foundersRate(account: AccountPlanOn | null, tier: BillingTier): boolean {
  return (account?.foundersRemaining?.[tier] ?? 0) > 0 || account?.foundersHeld?.[tier] === true;
}

const FEATURES: Record<BillingTier, readonly string[]> = {
  core: [
    'everything in owlette free',
    'remote control: commands, process restart and kill, display restore, screenshots',
    'alert rules and alert emails',
    'unlimited machines on this site',
  ],
  pro: ['everything in core', 'deployments and roost', 'swoop, hoot and talons', 'webhooks and API keys'],
};

interface PlanTierPickerProps {
  selected: BillingTier;
  onSelect: (tier: BillingTier) => void;
  foundersRate: (tier: BillingTier) => boolean;
  /** the plan the site is billed at: shown, and not picked again. */
  current?: BillingTier;
}

export function PlanTierPicker({ selected, onSelect, foundersRate, current }: PlanTierPickerProps) {
  return (
    <div role="radiogroup" aria-label="plan" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {TIERS.map((tier) => {
        const facts = PRICING_FACTS[tier];
        const founders = foundersRate(tier);
        const isCurrent = tier === current;
        const isSelected = tier === selected;
        return (
          <button
            key={tier}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={isCurrent}
            onClick={() => onSelect(tier)}
            // the focus ring is the inputs' (components/ui/input.tsx): the selected card is told by its fill
            className={cn(
              'flex cursor-pointer flex-col rounded-lg border p-3 text-left outline-none transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60 sm:p-4',
              isSelected ? 'border-accent-cyan/50 bg-accent-cyan/10' : 'border-border bg-background',
            )}
          >
            {/* below sm the price shares the plan's line, so both cards and the dialog's actions fit a phone,
                and "current plan" takes the line under it instead of pushing the price apart */}
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="flex items-baseline justify-between gap-x-2 sm:basis-full">
                <span className="text-base font-semibold text-foreground">{tier}</span>
                {isCurrent && <span className="hidden text-xs text-muted-foreground sm:inline">current plan</span>}
              </span>
              <span className="text-xl font-bold tabular-nums text-foreground sm:mt-1 sm:text-2xl">
                {usd(founders ? facts.founders : facts.list)}
              </span>
              <span className="text-sm text-muted-foreground">{PRICING_FACTS.billingUnit}</span>
            </span>
            {isCurrent && <span className="mt-0.5 text-xs text-muted-foreground sm:hidden">current plan</span>}
            {founders && (
              <span className="mt-0.5 text-xs text-muted-foreground">
                founders rate. the list price is {usd(facts.list)}.
              </span>
            )}
            {'minMachines' in facts && (
              <span className="mt-0.5 text-xs text-muted-foreground">
                bills at least {facts.minMachines} machines.
              </span>
            )}
            <ul className="mt-2 flex flex-col gap-1 sm:mt-3 sm:gap-1.5">
              {FEATURES[tier].map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <Check className="mt-0.5 size-3 shrink-0 text-accent-cyan" aria-hidden="true" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
