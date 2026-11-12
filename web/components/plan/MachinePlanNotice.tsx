'use client';

/**
 * what the machine views show where the site's plan leaves something out.
 * a machine outside owlette free's machine limit, counted per account, gets a
 * notice with a way to upgrade instead of its metrics, and a lock where its
 * display button was, which still reads where the notice has no room. without
 * control, the controls that send a command (process restart and kill, display
 * restore) give way to a "part of core" row. the site's owner gets a link to
 * its billing section; anyone else is told to ask the owner.
 */

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ASK_OWNER, siteBillingPath } from '@/components/plan/UpgradeGate';
import { cn } from '@/lib/utils';

/** the site a lock belongs to and whether the viewer owns it: only the owner can upgrade it. */
export interface PlanSite {
  siteId: string;
  isOwner: boolean;
}

export function MachinePlanNotice({
  limit,
  planSite,
  className,
}: {
  limit: number;
  planSite?: PlanSite;
  className?: string;
}) {
  return (
    <div
      data-testid="machine-plan-notice"
      className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)}
    >
      <p className="text-sm text-muted-foreground">
        owlette free covers {limit} machine{limit === 1 ? '' : 's'}.{' '}
        {planSite?.isOwner ? 'upgrade to see this one.' : `${ASK_OWNER} to see this one.`}
      </p>
      {planSite?.isOwner && (
        <Button asChild size="sm">
          <Link href={siteBillingPath(planSite.siteId)}>upgrade</Link>
        </Button>
      )}
    </div>
  );
}

export function MachinePlanLock({ planSite }: { planSite?: PlanSite }) {
  const lock = planSite?.isOwner ? (
    <Link href={siteBillingPath(planSite.siteId)} data-testid="machine-plan-lock" onClick={(e) => e.stopPropagation()}>
      <Lock />
    </Link>
  ) : (
    <span data-testid="machine-plan-lock" title={ASK_OWNER}>
      <Lock />
    </span>
  );
  return (
    <IconButton
      label={planSite?.isOwner ? 'upgrade to see this machine' : ASK_OWNER}
      asChild
      variant="outline"
      size="icon-sm"
      className="flex-shrink-0 text-muted-foreground"
    >
      {lock}
    </IconButton>
  );
}

/**
 * `label` names what it stands in for, for screen readers: "restore is part of
 * core". `className` sizes it to the controls it sits among. anyone but the
 * owner reads the same short label, with whom to ask on hover and to a screen
 * reader, so it never crowds the controls beside it.
 */
export function ControlUpgradeLink({
  label,
  planSite,
  className,
}: {
  label: string;
  planSite?: PlanSite;
  className?: string;
}) {
  if (!planSite?.isOwner) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="control-upgrade"
            className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground', className)}
          >
            <Lock className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <span aria-hidden="true">part of core</span>
            <span className="sr-only">
              {label}. {ASK_OWNER}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{ASK_OWNER}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button asChild variant="ghost" size="sm" className={cn('text-muted-foreground', className)}>
      <Link href={siteBillingPath(planSite.siteId)} aria-label={label} data-testid="control-upgrade">
        <Lock />
        part of core
      </Link>
    </Button>
  );
}
