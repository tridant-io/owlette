import { BLOCK_COLORS } from '@/lib/scheduleDefaults'
import type { ScheduleBlock } from '@/lib/owletteConfig'

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Convert "HH:MM" to minutes since midnight */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

interface WeekSummaryBarProps {
  schedules: ScheduleBlock[] | null | undefined
  className?: string
  /** Taller bars for standalone display (default: false) */
  tall?: boolean
}

/**
 * Visual 7-day summary bar showing active schedule ranges, ported verbatim from
 * `web/components/WeekSummaryBar.tsx`.
 *
 * Each day is a vertical bar with color-coded segments per block.
 */
export function WeekSummaryBar({ schedules, className, tall }: WeekSummaryBarProps) {
  const barHeight = tall ? 'h-16' : 'h-10'
  const barWidth = tall ? 'w-5' : 'w-4'
  const labelSize = tall ? 'text-[10px]' : 'text-[9px]'

  // Build a map of day -> list of active ranges with block color index
  const dayRanges: Record<string, { top: number; height: number; colorIndex: number }[]> = {}
  for (const key of DAY_KEYS) {
    dayRanges[key] = []
  }

  if (schedules) {
    schedules.forEach((block, blockIndex) => {
      const stableColorIndex = block.colorIndex ?? blockIndex
      for (const day of block.days) {
        if (!dayRanges[day]) continue
        for (const range of block.ranges) {
          const startMin = timeToMinutes(range.start)
          const stopMin = timeToMinutes(range.stop)
          const totalMin = 24 * 60

          if (stopMin > startMin) {
            dayRanges[day].push({
              top: (startMin / totalMin) * 100,
              height: ((stopMin - startMin) / totalMin) * 100,
              colorIndex: stableColorIndex,
            })
          } else if (stopMin < startMin) {
            dayRanges[day].push({
              top: (startMin / totalMin) * 100,
              height: ((totalMin - startMin) / totalMin) * 100,
              colorIndex: stableColorIndex,
            })
            dayRanges[day].push({
              top: 0,
              height: (stopMin / totalMin) * 100,
              colorIndex: stableColorIndex,
            })
          }
        }
      }
    })
  }

  return (
    <div className={`flex items-end gap-1.5 ${className ?? ''}`} data-testid="week-summary">
      {DAY_KEYS.map((day, i) => {
        const ranges = dayRanges[day]
        const isActive = ranges.length > 0
        // Use the first block's color for the label, or default
        const labelColor = isActive
          ? BLOCK_COLORS[ranges[0].colorIndex % BLOCK_COLORS.length].label
          : 'text-muted-foreground/80 dark:text-muted-foreground/50'
        return (
          <div key={day} className="flex flex-col items-center gap-0.5">
            <div
              className={`relative ${barWidth} ${barHeight} rounded-sm overflow-hidden ${
                isActive ? 'bg-muted/40' : 'bg-muted/20'
              }`}
              data-testid={`week-summary-${day}`}
              data-active={isActive}
            >
              {ranges.map((r, ri) => (
                <div
                  key={ri}
                  className={`absolute w-full ${BLOCK_COLORS[r.colorIndex % BLOCK_COLORS.length].bar} rounded-[1px]`}
                  style={{ top: `${r.top}%`, height: `${Math.max(r.height, 2)}%` }}
                />
              ))}
            </div>
            <span className={`${labelSize} font-medium leading-none ${labelColor}`}>
              {DAY_LABELS[i]}
            </span>
          </div>
        )
      })}
    </div>
  )
}
