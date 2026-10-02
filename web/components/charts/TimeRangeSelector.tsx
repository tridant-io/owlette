'use client';

/**
 * TimeRangeSelector Component
 *
 * A button group for selecting time ranges for metric charts.
 * Options: Day, Week, Month, Year, All
 *
 * Used by MetricsDetailPanel to control the chart's time window.
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type TimeRange = '1h' | '1d' | '1w' | '1m' | '1y' | 'all';

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}

const ranges: { value: TimeRange; label: string }[] = [
  { value: '1h', label: 'hour' },
  { value: '1d', label: 'day' },
  { value: '1w', label: 'week' },
  { value: '1m', label: 'month' },
  { value: '1y', label: 'year' },
  { value: 'all', label: 'all' },
];

export function TimeRangeSelector({ value, onChange, className }: TimeRangeSelectorProps) {
  return (
    // tighter below sm so all six fit one row at 390px; wraps rather than clips if not
    <div role="group" aria-label="time range" className={cn('flex flex-wrap gap-1 sm:gap-1.5', className)}>
      {ranges.map((range) => {
        const isSelected = value === range.value;
        return (
          <Button
            key={range.value}
            variant="ghost"
            size="sm"
            aria-pressed={isSelected}
            className={cn(
              'h-8 px-2.5 sm:px-3 text-xs transition-colors',
              isSelected
                ? 'bg-accent text-foreground border-transparent ring-1 ring-primary/40 hover:bg-accent'
                : 'bg-card text-muted-foreground border border-border hover:bg-accent/40 hover:text-foreground'
            )}
            onClick={() => onChange(range.value)}
          >
            {range.label}
          </Button>
        );
      })}
    </div>
  );
}
