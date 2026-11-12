'use client';

/**
 * stands in for a feature the site's plan leaves out (adr 0018). `card`
 * replaces a whole surface; `inline` replaces one create control while the list
 * around it stays live, since list, revoke and delete are never gated.
 *
 * renders the children while the site's plan loads, after a failed lookup and
 * when plans are not enforced: a gate that flashes at a paying customer costs
 * more than ungated UI for a beat, and the server refuses every gated action
 * anyway.
 *
 * only the site's owner can change its billing, so the owner gets a link to the
 * site's billing section and anyone else is told to ask them.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSitePlan } from '@/hooks/useSitePlan';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';
import { siteSettingsPath } from '@/lib/siteSettingsPath';
import { cn } from '@/lib/utils';

export type UpgradeFlag = keyof SitePlanResponse['flags'];

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

/** no full stop: it is also a label and the start of a longer sentence. */
export const ASK_OWNER = 'ask the site owner to upgrade this site';

/** the billing section of a site's settings, where its owner changes its plan. */
export function siteBillingPath(siteId: string): string {
  return siteSettingsPath(siteId, 'billing');
}

function leftOut(plan: SitePlanResponse | undefined, flag: UpgradeFlag): plan is SitePlanResponse {
  return !!plan?.enforced && !plan.flags[flag];
}

/**
 * whether the site's plan leaves `flag` out, for a page that hides a second
 * create control rather than gating it twice.
 */
export function usePlanGated(flag: UpgradeFlag, siteId: string | null | undefined): boolean {
  return leftOut(useSitePlan(siteId).plan, flag);
}

interface UpgradeGateProps {
  flag: UpgradeFlag;
  /** the site the gated control acts on. */
  siteId: string | null | undefined;
  /** the gated feature's name, where the flag's own doesn't fit it. */
  feature?: string;
  variant?: 'card' | 'inline';
  className?: string;
  children?: ReactNode;
}

export function UpgradeGate({ flag, siteId, feature, variant = 'card', className, children }: UpgradeGateProps) {
  const { plan } = useSitePlan(siteId);
  if (!siteId || !leftOut(plan, flag)) return <>{children}</>;

  const { tier } = FEATURES[flag];
  const name = feature ?? FEATURES[flag].name;
  const upgrade = plan.isOwner && (
    <Button asChild size="sm">
      <Link href={siteBillingPath(siteId)}>upgrade</Link>
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
        <span className="text-sm text-muted-foreground">
          this site&apos;s plan doesn&apos;t include {name}.{!plan.isOwner && ` ${ASK_OWNER}.`}
        </span>
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
        <h2 className="text-lg font-semibold text-foreground">this site&apos;s plan doesn&apos;t include {name}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {plan.isOwner ? `upgrade to ${tier} to use it.` : `${ASK_OWNER}.`}
        </p>
        {upgrade && <div className="mt-6">{upgrade}</div>}
      </div>
    </div>
  );
}
