import { ChevronDown, ChevronUp, Clock, Minus, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { DayPillSelector } from '@/components/DayPillSelector'
import { WeekSummaryBar } from '@/components/WeekSummaryBar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ScheduleBlock } from '@/lib/owletteConfig'
import { scheduleClockDescription } from '@/lib/scheduleClockCopy'
import { BLOCK_COLORS, DEFAULT_SCHEDULE } from '@/lib/scheduleDefaults'

/**
 * Ported from `web/components/ScheduleEditor.tsx`. Keep the blocks editor and
 * time picker identical: both apps write the same `schedules` array into the
 * same `config.json`, and a second dialect is how they drift.
 *
 * The surround follows the web's process dialog (ProcessDialog.tsx:223-248):
 * week bar over the block list, no preset bar — presets live in Firestore,
 * which this app never reads.
 */

/**
 * The web's `userPreferences.timeFormat` can't be inherited — a machine is
 * paired, not signed in — so read the operator's Windows regional preference via
 * Intl hourCycle (h11/h12 = AM/PM, h23/h24 = 24h). Evaluated once per launch.
 */
const USE_24H = (() => {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions()
      .hourCycle
    return cycle === 'h23' || cycle === 'h24'
  } catch {
    return false
  }
})()

interface TimePickerProps {
  value: string // "HH:MM" 24-hour format
  onChange: (value: string) => void
  compact?: boolean
}

function formatTimeDisplay(value: string, use24h: boolean): string {
  const [h, m] = value.split(':').map(Number)
  if (use24h) {
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

/** Parse typed time input into "HH:MM" 24h format. Returns null if unrecognizable.
 *
 * In 12h mode, a bare "H:MM" (no am/pm) inherits the am/pm of `currentHour24`
 * so editing "2:25 pm" to "3:25" stays in the afternoon instead of silently
 * jumping back to 3:25 AM.
 */
function parseTimeInput(input: string, use24h: boolean, currentHour24?: number): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ')

  // "9:30", "17:00", "5:00 pm"
  const colonMatch = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/)
  if (colonMatch) {
    let h = parseInt(colonMatch[1])
    const m = parseInt(colonMatch[2])
    const ampm = colonMatch[3]
    if (m > 59) return null
    if (ampm === 'pm' && h !== 12) h = Math.min(h + 12, 23)
    else if (ampm === 'am' && h === 12) h = 0
    else if (!ampm && !use24h && h >= 1 && h <= 12 && typeof currentHour24 === 'number') {
      const wasPM = currentHour24 >= 12
      if (wasPM && h !== 12) h += 12
      else if (!wasPM && h === 12) h = 0
    }
    if (h > 23) return null
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  // "5pm", "9 am"
  const shortMatch = s.match(/^(\d{1,2})\s*(am|pm)$/)
  if (shortMatch) {
    let h = parseInt(shortMatch[1])
    const ampm = shortMatch[2]
    if (h > 12 || h < 1) return null
    if (ampm === 'pm' && h !== 12) h += 12
    else if (ampm === 'am' && h === 12) h = 0
    return `${h.toString().padStart(2, '0')}:00`
  }

  // compact "1700", "900"
  const compactMatch = s.match(/^(\d{3,4})$/)
  if (compactMatch) {
    const n = parseInt(compactMatch[1])
    const h = Math.floor(n / 100)
    const m = n % 100
    if (h > 23 || m > 59) return null
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
  }

  return null
}

/** Not exported (unlike the web's): the dashboard schedule popover has no counterpart here. */
function TimePicker({ value, onChange, compact }: TimePickerProps) {
  const use24h = USE_24H
  const [draft, setDraft] = useState<string | null>(null)

  const [h, m] = value.split(':').map(Number)

  const adjust = (deltaMinutes: number): string => {
    const total = (((h * 60 + m + deltaMinutes) % (24 * 60)) + 24 * 60) % (24 * 60)
    const newH = Math.floor(total / 60)
    const newM = total % 60
    const newValue = `${newH.toString().padStart(2, '0')}:${newM.toString().padStart(2, '0')}`
    onChange(newValue)
    return newValue
  }

  const commit = (text: string) => {
    const parsed = parseTimeInput(text, use24h, h)
    if (parsed) onChange(parsed)
    setDraft(null)
  }

  const displayed = formatTimeDisplay(value, use24h)
  const inputWidth = use24h ? 'w-14' : 'w-[4.5rem]'
  const inputPy = compact ? 'py-0.5 text-[11px]' : 'py-1 text-sm'

  return (
    <div className="flex items-center gap-0.5">
      <input
        type="text"
        value={draft ?? displayed}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setDraft(displayed)
          requestAnimationFrame(() => e.target.select())
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value)
            e.currentTarget.blur()
          }
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(60), use24h))
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(-60), use24h))
          }
        }}
        className={`${inputPy} ${inputWidth} rounded-md border border-border bg-background text-foreground font-medium text-center cursor-text outline-none focus:border-muted-foreground transition-colors`}
        title="type a time (e.g. 9:00, 5pm, 17:00) or use ↑↓ arrows"
      />
      <div className="flex flex-col">
        <button
          type="button"
          aria-label="+15 min"
          onMouseDown={(e) => {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(15), use24h))
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer leading-none py-px"
        >
          <ChevronUp className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          aria-label="-15 min"
          onMouseDown={(e) => {
            e.preventDefault()
            setDraft(formatTimeDisplay(adjust(-15), use24h))
          }}
          className="text-muted-foreground hover:text-foreground cursor-pointer leading-none py-px"
        >
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  )
}

interface ScheduleBlocksEditorProps {
  blocks: ScheduleBlock[]
  onChange: (blocks: ScheduleBlock[]) => void
  compact?: boolean
}

/** colorIndex if set, else position. */
function getBlockColorIndex(block: ScheduleBlock, position: number): number {
  return block.colorIndex ?? position
}

export function ScheduleBlocksEditor({ blocks, onChange, compact }: ScheduleBlocksEditorProps) {
  const updateBlock = (index: number, updated: ScheduleBlock) => {
    const next = [...blocks]
    next[index] = updated
    onChange(next)
  }

  const addBlock = () => {
    // Must count colors the way blocks RENDER (colorIndex ?? position): counting
    // only explicit colorIndex hands the new block a duplicate color.
    const usedColors = new Set(
      blocks.map((b, i) => getBlockColorIndex(b, i) % BLOCK_COLORS.length),
    )
    let nextColor = 0
    while (usedColors.has(nextColor % BLOCK_COLORS.length) && nextColor < BLOCK_COLORS.length)
      nextColor++
    nextColor %= BLOCK_COLORS.length
    onChange([
      ...blocks,
      {
        colorIndex: nextColor,
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        ranges: [{ start: '09:00', stop: '17:00' }],
      },
    ])
  }

  const removeBlock = (index: number) => {
    onChange(blocks.filter((_, i) => i !== index))
  }

  const updateRange = (
    blockIndex: number,
    rangeIndex: number,
    field: 'start' | 'stop',
    value: string,
  ) => {
    const block = blocks[blockIndex]
    const ranges = [...block.ranges]
    ranges[rangeIndex] = { ...ranges[rangeIndex], [field]: value }
    updateBlock(blockIndex, { ...block, ranges })
  }

  const addRange = (blockIndex: number) => {
    const block = blocks[blockIndex]
    updateBlock(blockIndex, {
      ...block,
      ranges: [...block.ranges, { start: '09:00', stop: '17:00' }],
    })
  }

  const removeRange = (blockIndex: number, rangeIndex: number) => {
    const block = blocks[blockIndex]
    updateBlock(blockIndex, {
      ...block,
      ranges: block.ranges.filter((_, i) => i !== rangeIndex),
    })
  }

  const updateBlockName = (blockIndex: number, name: string) => {
    const block = blocks[blockIndex]
    updateBlock(blockIndex, { ...block, name: name || undefined })
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        const color = BLOCK_COLORS[getBlockColorIndex(block, blockIndex) % BLOCK_COLORS.length]
        return (
          <div key={blockIndex} className="border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color.pill}`} />
                <input
                  type="text"
                  value={block.name || ''}
                  onChange={(e) => updateBlockName(blockIndex, e.target.value)}
                  placeholder={`block ${blockIndex + 1}`}
                  className="text-sm font-medium bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground dark:placeholder:text-muted-foreground/50 w-full min-w-0 outline-none focus:border-muted-foreground transition-colors"
                />
              </div>
              {blocks.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeBlock(blockIndex)}
                  aria-label={`remove block ${blockIndex + 1}`}
                  className="h-6 w-6 p-0 text-danger hover:text-danger hover:bg-danger-surface cursor-pointer flex-shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>

            {/* Day pills */}
            <DayPillSelector
              value={block.days}
              onChange={(days) => updateBlock(blockIndex, { ...block, days })}
              variant="pill"
              compact={compact}
              activeClassName={`${color.pill} ${color.pillText}`}
            />

            {/* Time ranges */}
            <div className="space-y-2">
              {block.ranges.map((range, rangeIndex) => {
                const isOvernight = range.start > range.stop
                return (
                  <div key={rangeIndex} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <TimePicker
                        value={range.start}
                        onChange={(v) => updateRange(blockIndex, rangeIndex, 'start', v)}
                        compact={compact}
                      />
                      <span className="text-muted-foreground text-xs">to</span>
                      <TimePicker
                        value={range.stop}
                        onChange={(v) => updateRange(blockIndex, rangeIndex, 'stop', v)}
                        compact={compact}
                      />
                      {isOvernight && (
                        <span className="text-[10px] font-medium text-warning bg-warning-surface border border-warning-border/75 rounded px-1.5 py-0.5 whitespace-nowrap">
                          +1 day
                        </span>
                      )}
                      {block.ranges.length > 1 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => removeRange(blockIndex, rangeIndex)}
                              aria-label="remove time range"
                              className="h-6 w-6 rounded-md text-muted-foreground hover:text-danger hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                            >
                              <Minus className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>remove time range</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {/* Add time range button on the last row */}
                      {rangeIndex === block.ranges.length - 1 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => addRange(blockIndex)}
                              aria-label="add time range"
                              className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                            >
                              <Plus className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>add time range</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    {isOvernight && (
                      <p className="text-[11px] text-warning dark:text-warning/80 pl-0.5">
                        ends the following day — schedule days control when it <em>starts</em>
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      <Button
        variant="outline"
        size="sm"
        onClick={addBlock}
        className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <Plus className="h-3 w-3 mr-1" />
        add schedule block
      </Button>
    </div>
  )
}

/**
 * Blocks the editor opens with. A block missing `days` or `ranges` is unusable
 * and the save filter drops it anyway, so a hand-mangled config falls back to
 * the same default the web uses for no schedules at all.
 */
function seedBlocks(schedules: ScheduleBlock[] | null | undefined): ScheduleBlock[] {
  const usable = (schedules ?? []).filter(
    (block) => Array.isArray(block?.days) && Array.isArray(block?.ranges),
  )
  return usable.length > 0 ? usable : DEFAULT_SCHEDULE
}

interface ScheduleEditorProps {
  open: boolean
  /** Null, absent, or empty seeds the web's default. */
  schedules: ScheduleBlock[] | null | undefined
  /**
   * The site's clock, from `scheduleTimezoneOf` — `''` (the default) whenever
   * these windows are evaluated on this machine's own clock, which is every
   * site that has not opted into site time. Copy only; nothing here evaluates.
   */
  scheduleTimezone?: string
  onClose: () => void
  /** Only fires on `save schedule`. */
  onSave: (blocks: ScheduleBlock[]) => void
}

/**
 * Author one process's schedule windows. Mounted only while open (as in the web's
 * dialog) so the draft reseeds every time and any dismissal discards it, leaving
 * `config.json` untouched.
 */
export function ScheduleEditor({
  open,
  schedules,
  scheduleTimezone = '',
  onClose,
  onSave,
}: ScheduleEditorProps) {
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(() => seedBlocks(schedules))

  const handleSave = () => {
    // no days or no ranges can never match; the web drops these on save too
    onSave(blocks.filter((block) => block.days.length > 0 && block.ranges.length > 0))
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        // Two panes under one height cap: rules left, the scrolling block list
        // right with actions pinned beneath. The split gives the blocks a
        // full-height column. Title owns row 1 so the block pane can't crowd the
        // close button.
        className="h-[min(34rem,calc(100vh-5.5rem))] grid-cols-[minmax(0,5fr)_minmax(0,6fr)] grid-rows-[auto_minmax(0,1fr)] gap-x-6 gap-y-4 sm:max-w-3xl"
        data-testid="schedule-editor"
      >
        <DialogHeader className="col-span-2">
          <DialogTitle>configure schedule</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4">
          {/* Which clock times these windows is the site's call, resolved by the
              service and published as `firebase.schedule_timezone` — a zone name
              only when the site opted in (`sites/{siteId}.schedulesFollowSiteTime`,
              agent support since 3.2.3), `''` otherwise. Empty keeps the
              machine-clock sentence BYTE FOR BYTE: that is the state every
              recorded tutorial frame was shot in, and the state of every site
              that has not answered the dashboard's banner. */}
          <DialogDescription>{scheduleClockDescription(scheduleTimezone)}</DialogDescription>

          <div className="space-y-3 rounded-lg border border-info-border bg-info-surface p-3">
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-info" />
              <span className="text-xs font-medium text-info">week at a glance</span>
            </div>
            <div className="flex justify-center">
              <WeekSummaryBar schedules={blocks} tall />
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-info-border bg-info-surface p-3">
            <ScheduleBlocksEditor blocks={blocks} onChange={setBlocks} compact />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              cancel
            </Button>
            <Button onClick={handleSave}>save schedule</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
