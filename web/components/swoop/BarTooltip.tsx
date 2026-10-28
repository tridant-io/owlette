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
 *
 * in the bar's menu (a narrow window's one button, `SwoopToolbar`) there is no
 * hover to ask with, so the label is printed under the button instead: `short`
 * when the tooltip is a sentence, the label itself otherwise.
 */

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';
import { cn } from '@/lib/utils';

/** true inside the bar's menu, where each button wears its label. */
export const SwoopBarInMenu = createContext(false);

export function BarTooltip({
  label,
  short,
  className,
  children,
}: {
  label: ReactNode;
  /** the label under the button in the bar's menu, where a sentence does not fit. */
  short?: string;
  /** on the wrapper, where a class that hides the whole control belongs. */
  className?: string;
  children: ReactElement;
}) {
  const placement = useBarMenuPlacement();
  const inMenu = useContext(SwoopBarInMenu);
  if (inMenu) {
    return (
      <span className={cn('inline-flex w-16 flex-col items-center gap-0.5', className)}>
        {children}
        {/* the button says it already, to a screen reader */}
        <span aria-hidden className="text-center text-[11px] leading-tight text-muted-foreground">
          {short ?? label}
        </span>
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent {...placement}>{label}</TooltipContent>
    </Tooltip>
  );
}
