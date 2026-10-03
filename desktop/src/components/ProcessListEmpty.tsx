import { FilePlus2 } from 'lucide-react'
import { launchCopy } from '@/lib/launchCopy'
import { cn } from '@/lib/utils'

interface ProcessListEmptyProps {
  /**
   * True while a file is dragged over the WINDOW — the window is the drop
   * target, not this box, so `useFileDrop` owns the state and passes it down.
   */
  dragOver?: boolean
  className?: string
}

/**
 * The fresh-install empty state. Dropping a file is the primary route on
 * purpose — one gesture versus a nine-field form — so it gets the drop-zone
 * framing and the header button is named as the alternative, not repeated.
 */
export function ProcessListEmpty({ dragOver = false, className }: ProcessListEmptyProps) {
  return (
    <div
      data-testid="process-list-empty"
      data-drag-over={dragOver || undefined}
      className={cn(
        'm-2 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center transition-colors',
        dragOver && 'border-primary bg-primary/5',
        className,
      )}
    >
      <FilePlus2
        aria-hidden
        className={cn('size-6 text-muted-foreground', dragOver && 'text-primary')}
      />
      <p className="text-sm font-medium">no processes yet</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{launchCopy().dropHint}</p>
      <p className="text-xs text-muted-foreground/80">or use add process, above</p>
    </div>
  )
}
