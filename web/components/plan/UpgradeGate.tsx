'use client';

/**
 * Stands in for a feature the signed-in user's plan leaves out, with a way to
 * upgrade. `card` replaces a whole surface; `inline` replaces one create
 * control while the list around it stays live, since list, revoke and delete
 * are never gated (plan.md decision 8).
 *
 * Renders the children while the plan loads, after a failed lookup and when
 * plans are not enforced: a gate that flashes at a paying customer costs more
 * than ungated UI for a beat, and the server refuses every gated action anyway.
 *
 * The plan is the viewer's own, and a site runs on its owner's plan (plan.md
 * decision 1), so a site feature passes `siteOwner`: on someone else's site, or
 * while the owner is unknown (`null`), nothing is gated here and the server
 * decides. Account features (API keys) leave it out.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import type { PlanResponse } from '@/lib/plan.server';
import { cn } from '@/lib/utils';

export type UpgradeFlag = keyof PlanResponse['flags'];

const FEATURES: Record<UpgradeFlag, { name: string; tier: 'core' | 'pro' }> = {
  control: { name: 'remote control', tier: 'core' },
  deployments: { name: 'deployments', tier: 'pro' },
  swoop: { name: 'swoop', tier: 'pro' },
  hoot: { name: 'hoot', tier: 'pro' },
  roost: { name: 'roost', tier: 'pro' },
  talons: { name: 'talons', tier: 'pro' },
  webhooks: { name: 'webhooks', tier: 'pro' },
  api_keys: { name: 'API keys', tier: 'pro' },
};

/**
 * The viewer's plan when it governs what the viewer is looking at, else null:
 * plans are enforced, and it is an account feature (`siteOwner` left out) or a
 * site the viewer owns. The one place that owner rule lives; `useSitePlan`
 * builds on it too.
 */
export function governingPlan(
  plan: PlanResponse | undefined,
  viewerUid: string | null | undefined,
  siteOwner?: string | null,
): PlanResponse | null {
  if (!plan?.enforced) return null;
  return siteOwner === undefined || (siteOwner !== null && siteOwner === viewerUid) ? plan : null;
}

/**
 * Whether the viewer's plan leaves `flag` out, for a page that hides a second
 * create control rather than gating it twice. `siteOwner` as on UpgradeGate:
 * pass `site?.owner ?? null`, since leaving it out means an account feature.
 */
export function usePlanGated(flag: UpgradeFlag, siteOwner?: string | null): boolean {
  const { plan } = usePlan();
  const { user } = useAuth();
  const governing = governingPlan(plan, user?.uid, siteOwner);
  return !!governing && !governing.flags[flag];
}

interface UpgradeGateProps {
  flag: UpgradeFlag;
  /** the owner of the site the gated control acts on; omit for an account feature. */
  siteOwner?: string | null;
  /** the gated feature's name, where the flag's own doesn't fit it. */
  feature?: string;
  variant?: 'card' | 'inline';
  className?: string;
  children?: ReactNode;
}

export function UpgradeGate({ flag, siteOwner, feature, variant = 'card', className, children }: UpgradeGateProps) {
  const gated = usePlanGated(flag, siteOwner);
  if (!gated) return <>{children}</>;

  const { tier } = FEATURES[flag];
  const name = feature ?? FEATURES[flag].name;
  const upgrade = (
    <Button asChild size="sm">
      <Link href="/settings/plan">upgrade</Link>
    </Button>
  );

  if (variant === 'inline') {
    return (
      <div
        data-testid="upgrade-gate-inline"
        className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-card px-3 py-2', className)}
      >
        {/* dropped on a phone, where the note then fits on one row */}
        <Sparkles className="hidden h-4 w-4 shrink-0 text-accent-cyan sm:block" aria-hidden />
        <span className="text-sm text-muted-foreground">your plan doesn&apos;t include {name}.</span>
        {upgrade}
      </div>
    );
  }

  return (
    <div className={cn('mt-8 flex justify-center md:mt-16', className)}>
      <div
        data-testid="upgrade-gate"
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center sm:p-8"
      >
        <div className="mx-auto mb-4 inline-flex rounded-md bg-accent-cyan/10 p-2.5 text-accent-cyan">
          <Sparkles className="h-5 w-5" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold text-foreground">your plan doesn&apos;t include {name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">upgrade to {tier} to use it.</p>
        <div className="mt-6">{upgrade}</div>
      </div>
    </div>
  );
}
