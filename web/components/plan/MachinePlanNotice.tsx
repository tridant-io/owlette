'use client';

/**
 * what the machine views show where the viewer's plan leaves something out.
 * a machine outside the machine limit (plan.md decision 9) gets a notice with a
 * way to upgrade instead of its metrics, and a lock where its display button
 * was, which still reads where the notice has no room. without control, the
 * controls that send a command (process restart and kill, display restore)
 * give way to a link saying they're part of core.
 */

import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';

export function MachinePlanNotice({ limit, className }: { limit: number; className?: string }) {
  return (
    <div
      data-testid="machine-plan-notice"
      className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)}
    >
      <p className="text-sm text-muted-foreground">
        your plan covers {limit} machine{limit === 1 ? '' : 's'}. upgrade to see this one.
      </p>
      <Button asChild size="sm">
        <Link href="/settings/plan">upgrade</Link>
      </Button>
    </div>
  );
}

export function MachinePlanLock() {
  return (
    <IconButton
      label="upgrade to see this machine"
      asChild
      variant="outline"
      size="icon-sm"
      className="flex-shrink-0 text-muted-foreground"
    >
      <Link href="/settings/plan" data-testid="machine-plan-lock" onClick={(e) => e.stopPropagation()}>
        <Lock />
      </Link>
    </IconButton>
  );
}

/**
 * `label` names what it stands in for, for screen readers: "restore is part of
 * core". `className` sizes it to the controls it sits among.
 */
export function ControlUpgradeLink({ label, className }: { label: string; className?: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className={cn('text-muted-foreground', className)}>
      <Link href="/settings/plan" aria-label={label} data-testid="control-upgrade">
        <Lock />
        part of core
      </Link>
    </Button>
  );
}
