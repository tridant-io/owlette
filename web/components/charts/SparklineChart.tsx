'use client';

/**
 * Compact inline area chart for metric trends (CPU/memory/disk/GPU history) in
 * machine cards and table rows.
 */

import { memo } from 'react';
import { AreaChart, Area, ResponsiveContainer, YAxis } from 'recharts';
import { cn } from '@/lib/utils';

export interface SparklineDataPoint {
  t: number;  // timestamp
  v: number;  // value (0-100 for percentages)
}

export type MetricColor = 'cpu' | 'memory' | 'disk' | 'gpu' | 'temp';

interface SparklineChartProps {
  data: SparklineDataPoint[];
  color?: MetricColor;
  height?: number;
  className?: string;
  onClick?: () => void;
  loading?: boolean;
}

// Distinct ids so co-rendered sparklines don't share a <linearGradient>.
const gradientIds: Record<MetricColor, string> = {
  cpu: 'sparkline-gradient-cpu',
  memory: 'sparkline-gradient-memory',
  disk: 'sparkline-gradient-disk',
  gpu: 'sparkline-gradient-gpu',
  temp: 'sparkline-gradient-temp',
};

// memo: every card and row renders four of these, and a parent re-render would
// otherwise rebuild each recharts tree even when its data is unchanged
export const SparklineChart = memo(function SparklineChart({
  data,
  color = 'cpu',
  height = 48,
  className,
  onClick,
  loading = false,
}: SparklineChartProps) {
  if (loading) {
    return (
      <div
        className={cn(
          'bg-muted/30 rounded animate-pulse',
          className
        )}
        style={{ height }}
      />
    );
  }

  // Empty placeholder: no text, no background.
  if (!data || data.length === 0) {
    return (
      <div
        className={cn('rounded', className)}
        style={{ height }}
      />
    );
  }

  const gradientId = gradientIds[color];

  return (
    <div
      className={cn(
        'cursor-pointer hover:opacity-90 transition-opacity rounded',
        onClick && 'hover:bg-muted/30',
        className
      )}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
    >
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(148, 163, 184)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="rgb(71, 85, 105)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <YAxis domain={[0, 100]} hide />
          <Area
            type="monotone"
            dataKey="v"
            stroke="transparent"
            strokeWidth={0}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});
