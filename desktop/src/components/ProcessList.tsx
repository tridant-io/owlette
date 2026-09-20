import {
  Copy,
  FilePlus2,
  GripVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ProcessIcon } from '@/components/ProcessIcon'
import { ProcessListEmpty } from '@/components/ProcessListEmpty'
import { useScrollFade } from '@/hooks/useScrollFade'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { ProcessEntry } from '@/lib/owletteConfig'
import { STATUS_DOT, isLive, statusForProcess, statusLabel, type AppStates } from '@/lib/processStatus'
import { setRowDragging } from '@/lib/rowDrag'
import { MENU_SURFACE } from '@/lib/surfaces'
import { cn } from '@/lib/utils'

/** Everything the context menu can ask for. Order lives on the list itself. */
export type ProcessAction = 'restart' | 'kill' | 'duplicate' | 'delete'

/** How far the pointer travels before a click becomes a drag. */
const DRAG_THRESHOLD_PX = 4

/**
 * Minimum room the rows must leave before the drop hint is drawn at all: the
 * sentence + glyph stack ~70px, the rest is breathing space. Below this it
 * reads as a line squeezed above the toggle, so nothing is drawn.
 */
const HINT_MIN_ROOM_PX = 160

interface ProcessListProps {
  processes: ProcessEntry[]
  states: AppStates
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onAction: (action: ProcessAction, id: string) => void
  /** Commit a new position. Called once, on drop. */
  onReorder: (id: string, toIndex: number) => void
  /** True while an OS file drag is over the window; lights up the empty state. */
  dragOver?: boolean
  /** Collapsed to the icon rail. The divider drives this; so does the toggle. */
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}

interface MenuAnchor {
  id: string
  x: number
  y: number
}

/** The row geometry captured when a drag starts, and where it has got to. */
interface DragState {
  id: string
  from: number
  pointerId: number
  startY: number
  midpoints: number[]
  active: boolean
  gap: number
}

/**
 * The process list: what this machine should be running, whether it is, and in
 * what order it starts. Each row is a config entry joined to the service's live
 * table, so the dot is the service's opinion, not one inferred here.
 *
 * Reordering is a drag because `processes[]` order IS the launch sequence.
 * Hand-rolled on pointer events: html5 DnD is unreliable in a webview with
 * `dragDropEnabled` claiming OS drops, and a flat list needs no library.
 *
 * Collapsed, the same markup and handlers become an icon rail — a rail that
 * dropped a gesture would be a second list to keep in step with this one.
 */
export function ProcessList({
  processes,
  states,
  selectedId,
  onSelect,
  onAdd,
  onAction,
  onReorder,
  dragOver = false,
  collapsed = false,
  onCollapsedChange,
}: ProcessListProps) {
  // Radix positions against a trigger, so the trigger is a zero-size element
  // parked at the click — native context-menu behaviour, no extra primitive.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)

  const isEmpty = processes.length === 0

  const listRef = useRef<HTMLUListElement>(null)
  // Rows disappear under the header rather than being guillotined by it.
  const scrollerRef = useScrollFade<HTMLDivElement>()
  // The box the drop hint would sit in, and how tall it turned out to be.
  const hintRoomRef = useRef<HTMLDivElement>(null)
  const [hintRoom, setHintRoom] = useState<number | null>(null)
  const dragRef = useRef<DragState | null>(null)
  // Mirrors the ref so the indicator re-renders; the pointer handlers read the
  // ref, since they run between renders.
  const [dropGap, setDropGap] = useState<number | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const index = anchor ? processes.findIndex((process) => process.id === anchor.id) : -1
  const anchorLive = anchor ? isLive(statusForProcess(states, anchor.id)) : false

  function act(action: ProcessAction) {
    if (!anchor) return
    const { id } = anchor
    setAnchor(null)
    onAction(action, id)
  }

  const endDrag = useCallback(() => {
    dragRef.current = null
    setRowDragging(false)
    setDraggingId(null)
    setDropGap(null)
  }, [])

  /** Where the row would land: the number of row midpoints above the pointer. */
  function gapFor(midpoints: number[], y: number): number {
    let gap = 0
    while (gap < midpoints.length && y > midpoints[gap]) gap += 1
    return gap
  }

  function handlePointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    id: string,
    from: number,
  ) {
    if (event.button !== 0 || processes.length < 2) return

    const rows = listRef.current?.querySelectorAll('[data-testid="process-row"]') ?? []
    const midpoints = [...rows].map((row) => {
      const rect = row.getBoundingClientRect()
      return rect.top + rect.height / 2
    })

    dragRef.current = {
      id,
      from,
      pointerId: event.pointerId,
      startY: event.clientY,
      midpoints,
      active: false,
      gap: from,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    if (!state.active) {
      if (Math.abs(event.clientY - state.startY) < DRAG_THRESHOLD_PX) return
      state.active = true
      setRowDragging(true)
      setDraggingId(state.id)
    }

    state.gap = gapFor(state.midpoints, event.clientY)
    setDropGap(state.gap)
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    const state = dragRef.current
    if (!state || state.pointerId !== event.pointerId) return

    const { active, from, gap, id } = state
    endDrag()
    if (!active) return

    // The gap counts positions including the dragged row, so dropping below its
    // own position closes that hole by one.
    const target = from < gap ? gap - 1 : gap
    if (target !== from) onReorder(id, target)
  }

  // Escape abandons a drag.
  useEffect(() => {
    if (!draggingId) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') endDrag()
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [draggingId, endDrag])

  // A drag outliving its component leaves the file-drop overlay's flag set, and
  // it would then ignore real drops.
  useEffect(() => endDrag, [endDrag])

  // The box is `flex-1 min-h-0`, so its height is the leftover and does not
  // change when the sentence moves in or out — that is what stops the rule
  // oscillating. Layout effect so the hint never flashes in and back out.
  useLayoutEffect(() => {
    const room = hintRoomRef.current
    // jsdom has no layout to observe.
    if (!room || typeof ResizeObserver === 'undefined') return
    const measure = () => setHintRoom(room.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(room)
    return () => observer.disconnect()
  }, [collapsed, isEmpty])

  // `null` until measured — with no layout to read, show the sentence.
  const showHint = hintRoom === null || hintRoom >= HINT_MIN_ROOM_PX

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="process-list"
      data-collapsed={collapsed || undefined}
    >
      {/* The rail keeps only the add button: at 48px the heading has nowhere to go. */}
      <header
        className={cn(
          'flex items-center pt-4 pb-3',
          collapsed ? 'justify-center px-2' : 'justify-between px-4',
        )}
      >
        {!collapsed && <h2 className="text-sm font-medium text-muted-foreground">processes</h2>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-sm" variant="secondary" onClick={onAdd} aria-label="add process">
              <Plus />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? 'right' : 'top'}>add process</TooltipContent>
        </Tooltip>
      </header>

      {/* pt-1: the focus ring sits 3px outside a row (1px outline + 2px
          offset); without top padding the first row's ring clips against the
          scroll boundary on keyboard selection.

          Nothing beneath it and no padding under it: the scroller reaches the
          floor of the sidebar, so its track does too. A track that stopped 56px
          short — the height of the toggle row that used to sit below it —
          read as a rendering fault. */}
      <div
        ref={scrollerRef}
        className={cn('min-h-0 flex-1 overflow-y-auto pt-1', collapsed ? 'px-1.5' : 'px-2')}
      >
        {/* At least the height of the scroller, so the toggle rests on the floor
            when the rows fall short of it and the hint can take the room they
            leave; past that the column grows with the list. */}
        <div className="flex min-h-full flex-col">
          {isEmpty ? (
            // Nothing fits in 48px that the expanded list doesn't say better.
            collapsed ? null : (
              <ProcessListEmpty dragOver={dragOver} />
            )
          ) : (
            <ul ref={listRef} className="flex flex-col gap-0.5">
              {processes.map((process, position) => {
                const status = statusForProcess(states, process.id)
                const selected = process.id === selectedId
                const dragged = draggingId === process.id
                const name = process.name || 'untitled process'
                // No indicator for a no-op drop.
                const showGap =
                  dropGap !== null && dragRef.current !== null
                    ? dropGap !== dragRef.current.from && dropGap !== dragRef.current.from + 1
                    : false

                return (
                  <li key={process.id} className="relative">
                    {showGap && dropGap === position && (
                      <span
                        aria-hidden
                        data-testid="drop-indicator"
                        className={cn(
                          'absolute -top-px z-10 h-0.5 rounded-full bg-primary',
                          collapsed ? 'left-1 right-1' : 'left-2 right-2',
                        )}
                      />
                    )}
                    {showGap &&
                      dropGap === processes.length &&
                      position === processes.length - 1 && (
                        <span
                          aria-hidden
                          data-testid="drop-indicator"
                          className={cn(
                            'absolute -bottom-px z-10 h-0.5 rounded-full bg-primary',
                            collapsed ? 'left-1 right-1' : 'left-2 right-2',
                          )}
                        />
                      )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          data-testid="process-row"
                          data-process-id={process.id}
                          data-status={status}
                          data-dragging={dragged || undefined}
                          aria-current={selected}
                          // A tooltip is not an accessible name, and the rail
                          // shows no text.
                          aria-label={collapsed ? name : undefined}
                          className={cn(
                            // btn-sweep is the hover feedback — the same
                            // animated scrim every button carries; a hover:bg
                            // would cross-fade underneath it and muddy the sweep.
                            'btn-sweep group flex w-full touch-none items-center rounded-md text-left text-sm transition-colors select-none',
                            collapsed ? 'justify-center px-0 py-1' : 'gap-2 px-1.5 py-2',
                            // Grab cursor on the grip only — the row is a
                            // click-to-select surface, though a drag may start
                            // anywhere on it.
                            draggingId ? 'cursor-grabbing' : 'cursor-pointer',
                            selected ? 'bg-accent text-accent-foreground' : 'text-foreground/90',
                            dragged && 'opacity-90 shadow-lg ring-1 ring-border',
                          )}
                          onClick={() => onSelect(process.id)}
                          onPointerDown={(event) => handlePointerDown(event, process.id, position)}
                          onPointerMove={handlePointerMove}
                          onPointerUp={handlePointerUp}
                          onPointerCancel={endDrag}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            onSelect(process.id)
                            setAnchor({ id: process.id, x: event.clientX, y: event.clientY })
                          }}
                        >
                          {collapsed ? (
                            // Dot badged onto the icon's corner: a separate dot
                            // would cost a third of the icon's width here.
                            <span className="relative flex size-8 shrink-0 items-center justify-center">
                              <ProcessIcon className="size-5" />
                              <span
                                aria-hidden
                                data-testid="rail-status-dot"
                                className={cn(
                                  'absolute right-0.5 bottom-0.5 size-2 rounded-full ring-2 ring-background',
                                  STATUS_DOT[status],
                                )}
                              />
                            </span>
                          ) : (
                            <>
                              <GripVertical
                                aria-hidden
                                className={cn(
                                  'size-3.5 shrink-0 text-muted-foreground transition-opacity',
                                  dragged ? 'opacity-70' : 'opacity-0 group-hover:opacity-60',
                                  !draggingId && 'cursor-grab',
                                )}
                              />
                              <span
                                aria-hidden
                                className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])}
                              />
                              <ProcessIcon />
                              <span className="truncate">{name}</span>
                            </>
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {collapsed ? `${name} — ${statusLabel(status)}` : statusLabel(status)}
                      </TooltipContent>
                    </Tooltip>
                  </li>
                )
              })}
            </ul>
          )}

          {/*
            Carries the empty state's lesson (a dropped file becomes a process)
            once rows exist. Withheld when the rows leave too little room, and in
            the rail, where it reads as a stray line rather than an invitation.

            The box is `flex-1 min-h-0` and measured whether or not the sentence
            is in it, so its height is the room the rows leave — that also keeps
            the hint out of the scrollable extent once rows overflow.

            `pointer-events-none` and outside the `ul`, so it cannot steal a
            drag, an OS drop, or a right-click.
          */}
          {!collapsed && !isEmpty && (
            <div
              ref={hintRoomRef}
              data-testid="process-list-drop-room"
              className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3"
            >
              {showHint && (
                // mt-14 = the toggle strip's height; on a centred flex item a
                // top margin shifts the box by half of it, centring the sentence
                // against the sidebar floor rather than the toggle. Margin, not
                // padding, so the box above still measures room and nothing else.
                <p
                  data-testid="process-list-drop-hint"
                  className="pointer-events-none mt-14 flex flex-col items-center gap-2 text-center text-sm leading-relaxed text-muted-foreground"
                >
                  <FilePlus2 aria-hidden className="size-4 shrink-0" />
                  {/* max-w forces the copy onto two lines so the hint reads as a
                      compact stack instead of one wide strip. */}
                  <span className="min-w-0 max-w-36">drop an app or script here to add it</span>
                </p>
              )}
            </div>
          )}

          {/*
            Collapse toggle, at the bottom of the column. The draggable divider
            does the same thing; this is the affordance for operators who never
            discover that.

            Inside the scroller stuck to its floor, not in a row beneath it: a
            row cut the scrollbar's track short of the sidebar's bottom edge, and
            an overlay painted over the track. `mt-auto` floors it in the two
            layouts with no hint box to push it there (rail, empty state).

            The gradient veils rather than cuts — a flat band chopped rows clean
            in half 56px clear of the floor, which read as a clipping fault. It
            is solid from the button down, so at 48px the toggle can't be
            mistaken for one more list item.
          */}
          {onCollapsedChange && (
            <div
              className={cn(
                'sticky bottom-0 mt-auto flex shrink-0 bg-[linear-gradient(to_bottom,transparent,var(--background)_60%)] py-2',
                collapsed ? 'justify-center' : 'justify-end',
              )}
            >
              {/* p-1: the ground reaches a little past the glyph on every side,
                  so a row behind it never touches the icon. With the row's own
                  py-2 that is the same 12px the button has always stood off the
                  floor and the edge by. */}
              <div className="rounded-lg bg-background p-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      // Chrome, not content: same muted foreground as the other
                      // passive icons.
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => onCollapsedChange(!collapsed)}
                      aria-label={collapsed ? 'expand the process list' : 'collapse the process list'}
                      data-testid={collapsed ? 'expand-sidebar' : 'collapse-sidebar'}
                    >
                      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side={collapsed ? 'right' : 'top'}>
                    {collapsed ? 'expand sidebar' : 'collapse sidebar'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          )}
        </div>
      </div>

      {anchor && index >= 0 && (
        <DropdownMenu open onOpenChange={(open) => !open && setAnchor(null)}>
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              className="pointer-events-none fixed size-0"
              style={{ left: anchor.x, top: anchor.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" sideOffset={2} className={MENU_SURFACE}>
            {/* Same rule as the detail pane: run controls follow liveness, not
                the launch mode. */}
            <DropdownMenuItem disabled={!anchorLive} onSelect={() => act('restart')}>
              <RotateCcw />
              restart process
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!anchorLive}
              onSelect={() => act('kill')}
            >
              <Square />
              kill process
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => act('duplicate')}>
              <Copy />
              duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => act('delete')}>
              <Trash2 />
              delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
