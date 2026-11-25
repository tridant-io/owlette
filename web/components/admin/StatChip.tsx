import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A tally chip for an admin header: beside the title, not a card row, so the table
 * keeps the height. Below sm it drops the icon and tightens, so a row of them
 * fits a phone.
 */
export function StatChip({
  icon: Icon,
  iconTone,
  count,
  label,
  className,
}: {
  icon: LucideIcon;
  /** the tile's fill and the ink that sits on it */
  iconTone: string;
  count: number;
  label: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-1.5 py-1.5 sm:justify-start sm:px-3 sm:py-2',
        className,
      )}
    >
      <div className={cn('hidden rounded-md p-1.5 sm:block', iconTone)}>
        <Icon className="h-4 w-4" />
      </div>
      {/* text-lg and text-xs stay plain classes: the user-mgmt e2e spec selects on them */}
      <div className="leading-tight max-sm:text-center">
        <p className="text-lg font-bold text-foreground max-sm:text-base">{count}</p>
        <p className="text-xs text-muted-foreground whitespace-nowrap max-sm:text-[11px]">{label}</p>
      </div>
    </div>
  );
}
