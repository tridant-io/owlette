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
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

interface UpgradeGateProps {
  flag: UpgradeFlag;
  variant?: 'card' | 'inline';
  className?: string;
  children?: ReactNode;
}

export function UpgradeGate({ flag, variant = 'card', className, children }: UpgradeGateProps) {
  const { plan } = usePlan();
  if (!plan || !plan.enforced || plan.flags[flag]) return <>{children}</>;

  const { name, tier } = FEATURES[flag];
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
        <Sparkles className="h-4 w-4 shrink-0 text-accent-cyan" aria-hidden />
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
