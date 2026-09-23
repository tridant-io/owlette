import { AppWindow } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ProcessIconProps {
  /** Sizing lives here; the box is the same in every row. */
  className?: string
}

/**
 * The glyph a process row carries beside its name — one fixed box per row, so
 * every name starts at the same offset.
 *
 * Decorative — the process name is always beside it or in the tooltip, so an
 * icon that read itself out would be noise.
 */
export function ProcessIcon({ className }: ProcessIconProps) {
  return (
    <AppWindow aria-hidden data-testid="process-icon" className={cn('size-4 shrink-0', className)} />
  )
}
