'use client';

/**
 * the tooltip every session-bar button carries: what it does, on hover and
 * focus, shown away from the bar — below a top bar, toward the picture from a
 * side one.
 *
 * the trigger is a wrapper, not the button: a disabled button fires no pointer
 * events (shadcn's buttons pass them through), and a control that is disabled
 * — quality before the session connects, keys for a watcher — is exactly the
 * one whose purpose someone hovers to find out.
 */

import type { ReactElement, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';
import { cn } from '@/lib/utils';

export function BarTooltip({
  label,
  className,
  children,
}: {
  label: ReactNode;
  /** on the wrapper, where a class that hides the whole control belongs. */
  className?: string;
  children: ReactElement;
}) {
  const placement = useBarMenuPlacement();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent {...placement}>{label}</TooltipContent>
    </Tooltip>
  );
}
