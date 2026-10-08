'use client';

/**
 * /settings/plan — the signed-in user's plan as the payer for the sites they
 * own: tier, standing, limits, this month's active machines and what the plan
 * includes. Every 402 `plan_required` points here (`upgradeUrl`).
 *
 * Checkout is not built yet (plan.md wave 6), so the upgrade buttons are
 * disabled. While plans are not enforced the page says so and nothing else.
 */

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Check, CreditCard, Loader2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import { PageCascade } from '@/components/PageCascade';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { PlanResponse, PlanTier } from '@/lib/plan.server';
import { PRICING_FACTS, perMachineMonth } from '@/lib/product-facts';

const PLAN_NAMES: Record<PlanTier, string> = {
  free: 'owlette free',
  trial: 'pro trial',
  core: 'core',
  pro: 'pro',
};

const FLAG_LABELS: Record<keyof PlanResponse['flags'], string> = {
  control: 'remote control, deploy, swoop, hoot and alerts',
  roost: 'roost',
  talons: 'talons',
  webhooks: 'webhooks',
  api_keys: 'API keys',
};

const UPGRADES = [
  {
    tier: 'core',
    price: perMachineMonth(PRICING_FACTS.core.list),
    detail: 'remote control, deploy, swoop, hoot and alerts.',
  },
  {
    tier: 'pro',
    price: perMachineMonth(PRICING_FACTS.pro.list),
    detail: `everything in core, plus roost, talons, webhooks and API keys. ${PRICING_FACTS.pro.minMachines}-machine minimum.`,
  },
] as const;

/** the tiers above the current one; a trial picks either to keep going. */
function upgradesFor(plan: PlanTier | null) {
  if (plan === 'pro') return [];
  if (plan === 'core') return UPGRADES.filter((u) => u.tier === 'pro');
  return UPGRADES;
}

function limitLabel(limit: number | null): string {
  return limit === null ? 'unlimited' : String(limit);
}

function PlanDetails({ plan }: { plan: PlanResponse }) {
  const upgrades = upgradesFor(plan.plan);
  const usage = [
    { label: 'machine limit', value: limitLabel(plan.limits.machines) },
    { label: 'active this month', value: String(plan.activeMachinesThisMonth ?? '—') },
    { label: 'site limit', value: limitLabel(plan.limits.sites) },
  ];

  return (
    <div className="space-y-6">
      <Card data-testid="current-plan" className="gap-0 py-0">
        <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">current plan</p>
            <p className="mt-1 text-xl font-semibold text-foreground">
              {plan.plan ? PLAN_NAMES[plan.plan] : 'unknown'}
            </p>
            {plan.plan === 'trial' && (
              <p className="mt-1 text-sm text-muted-foreground">
                when the trial ends, your account falls back to owlette free unless you pick core or pro.
              </p>
            )}
          </div>
          {plan.standing && (
            <Badge variant="outline" className="mt-0.5">
              {plan.standing.replace(/_/g, ' ')}
            </Badge>
          )}
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-4 sm:grid-cols-3 sm:px-6">
          {usage.map(({ label, value }) => (
            <div key={label} className="flex items-baseline justify-between gap-3 sm:block">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-sm font-medium text-foreground sm:mt-1 sm:text-lg">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="px-4 pb-4 text-xs text-muted-foreground sm:px-6">
          a machine is active if it was online at any point since the 1st of the month (UTC).
        </p>

        <div className="border-t border-border px-4 py-4 sm:px-6">
          <p className="mb-2 text-xs text-muted-foreground">included</p>
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {(Object.keys(FLAG_LABELS) as (keyof PlanResponse['flags'])[]).map((flag) => {
              const on = plan.flags[flag];
              return (
                <li
                  key={flag}
                  className={`flex items-start gap-2 text-sm ${on ? 'text-foreground' : 'text-muted-foreground'}`}
                >
                  {on ? (
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
                  ) : (
                    <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  )}
                  <span>
                    {FLAG_LABELS[flag]}
                    <span className="sr-only">{on ? ' (included)' : ' (not included)'}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </Card>

      {upgrades.length > 0 && (
        <section aria-labelledby="upgrade-heading">
          <h2 id="upgrade-heading" className="mb-3 text-sm font-medium text-foreground">
            upgrade
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {upgrades.map(({ tier, price, detail }) => (
              <Card key={tier} className="gap-3 px-4 py-4 sm:px-6">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-lg font-semibold text-foreground">{tier}</p>
                  <p className="text-sm text-muted-foreground">{price}</p>
                </div>
                <p className="flex-1 text-sm text-muted-foreground">{detail}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Button type="button" size="sm" disabled aria-describedby={`upgrade-${tier}-hint`}>
                    upgrade to {tier}
                  </Button>
                  <span id={`upgrade-${tier}-hint`} className="text-xs text-muted-foreground">
                    upgrade opens soon
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export default function PlanSettingsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { plan, loading, error, refresh } = usePlan();

  useEffect(() => {
    if (authLoading) return;
    if (!user) router.push('/login');
  }, [user, authLoading, router]);

  if (authLoading || !user) return null;

  let body: ReactNode = null;
  if (plan) {
    if (plan.enforced) body = <PlanDetails plan={plan} />;
  } else if (loading) {
    body = (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="loading" />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{error ?? 'failed to load plan'}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          try again
        </Button>
      </div>
    );
  }

  return (
    <PageCascade className="min-h-screen bg-background">
      <PageHeader currentPage="plan" />
      <main className="relative z-10 mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <CreditCard className="h-5 w-5" aria-hidden />
            plan
          </h1>
          {plan &&
            (plan.enforced ? (
              <p className="mt-1 text-sm text-muted-foreground">
                your plan covers the sites you own and their machines.
              </p>
            ) : (
              <p data-testid="plans-not-active" className="mt-1 text-sm text-muted-foreground">
                plans aren&apos;t active during beta, so every feature is included.
              </p>
            ))}
        </div>
        {body}
      </main>
    </PageCascade>
  );
}
