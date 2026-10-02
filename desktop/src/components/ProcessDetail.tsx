import { format, formatDistanceToNowStrict } from 'date-fns'
import { ChevronRight, FileSearch, FolderOpen, Pencil, RotateCcw, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PathInput } from '@/components/PathInput'
import { ScheduleEditor } from '@/components/ScheduleEditor'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useScrollFade } from '@/hooks/useScrollFade'
import { launchCopy } from '@/lib/launchCopy'
import { pickDirectory, pickExecutable, pickFile } from '@/lib/pickers'
import {
  coerceForm,
  formFromProcess,
  formsEqual,
  launchModeOf,
  priorityOf,
  PRIORITIES,
  scheduleSummary,
  VISIBILITIES,
  visibilityOf,
  type LaunchMode,
  type Priority,
  type ProcessEntry,
  type ProcessForm,
  type ScheduleBlock,
  type TextField,
  type Visibility,
} from '@/lib/owletteConfig'
import { DETAIL_SECTION_DEFAULTS } from '@/hooks/useDetailSections'
import type { DetailSectionKey, DetailSections } from '@/lib/ipc'
import { isLive, STATUS_TEXT, statusLabel, type ProcessStatus } from '@/lib/processStatus'
import { cn } from '@/lib/utils'

/**
 * Enter and blur both fire for one "done typing"; drop the second within 100ms
 * rather than writing the file twice (`owlette_gui.py:867-871`).
 */
const SAVE_DEBOUNCE_MS = 100

const LAUNCH_MODES: { value: LaunchMode; label: string }[] = [
  { value: 'off', label: 'off' },
  { value: 'always', label: 'always on' },
  { value: 'scheduled', label: 'scheduled' },
]

/**
 * The dashboard's launch-mode colours (`web/.../ProcessDialog.tsx:85-105`), split
 * in two because the fill slides and the text does not. Keep in sync with web.
 */
const LAUNCH_MODE_FILL: Record<LaunchMode, string> = {
  off: 'bg-muted',
  always: 'bg-emerald-600',
  scheduled: 'bg-blue-600',
}

const LAUNCH_MODE_TEXT: Record<LaunchMode, string> = {
  off: 'text-foreground',
  always: 'text-white',
  scheduled: 'text-white',
}

/**
 * Group heading and disclosure in one: the chevron trigger for a section's
 * Collapsible. Spans both columns of the form grid so the rows underneath keep
 * their shared label gutter.
 */
function SectionToggle({
  children,
  testId,
  first = false,
  dimmed = false,
  note,
}: {
  children: ReactNode
  testId: string
  /** No top margin on the first one; it already has the header above it. */
  first?: boolean
  dimmed?: boolean
  note?: ReactNode
}) {
  return (
    <CollapsibleTrigger
      data-testid={testId}
      className={cn(
        'group col-span-2 flex min-w-0 cursor-pointer items-baseline gap-1 text-xs font-medium text-muted-foreground/80 transition-all hover:text-foreground',
        first ? 'mt-0' : 'mt-3',
        dimmed && 'opacity-60',
      )}
    >
      <ChevronRight
        aria-hidden
        className="size-3.5 self-center transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
      />
      <span>{children}</span>
      {note && <span className="min-w-0 truncate font-normal text-muted-foreground/70">{note}</span>}
    </CollapsibleTrigger>
  )
}

interface ProcessDetailProps {
  process: ProcessEntry
  status: ProcessStatus
  /** Launch time of the live generation, unix ms; null if never launched. Only
   *  meaningful (and only shown) while the status is live. */
  startedAt?: number | null
  /** Persist the seven text fields. Already coerced; the caller only writes. */
  onSave: (form: ProcessForm) => void
  onLaunchMode: (mode: LaunchMode) => void
  /** Persist the schedule windows authored in the editor. */
  onSchedules: (schedules: ScheduleBlock[]) => void
  /**
   * The site's clock for launch windows, or `''` for this machine's own —
   * passed straight to the schedule editor, which is the only surface that
   * names a clock. Nothing here evaluates a window; the service does that.
   */
  scheduleTimezone?: string
  onPriority: (priority: Priority) => void
  onVisibility: (visibility: Visibility) => void
  onRestart: () => void
  onKill: () => void
  /** Open state of the three section disclosures. Owned above so it survives
   *  a process change, and persisted as a per-user layout preference. */
  sections?: DetailSections
  onSectionToggle?: (section: DetailSectionKey, open: boolean) => void
}

/**
 * Detail form for one process. Two non-obvious behaviours:
 *
 * Auto-save: no save button. A field writes `config.json` on blur/enter, but only
 * when it differs from disk — otherwise tabbing through rewrites the file, and
 * every rewrite makes the service re-read and re-upload the config.
 *
 * Deferred external refresh: the web app and the service write the same file.
 * External changes apply immediately except to the field under the cursor, which
 * keeps its text until focus leaves (`owlette_gui.py:1434-1448`).
 */
export function ProcessDetail({
  process,
  status,
  startedAt = null,
  onSave,
  onLaunchMode,
  onSchedules,
  scheduleTimezone = '',
  onPriority,
  onVisibility,
  onRestart,
  onKill,
  sections = DETAIL_SECTION_DEFAULTS,
  onSectionToggle,
}: ProcessDetailProps) {
  const [draft, setDraft] = useState<ProcessForm>(() => formFromProcess(process))
  const [pendingRefresh, setPendingRefresh] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState(false)

  const scroller = useScrollFade<HTMLDivElement>()

  // Last known on-disk values — distinguishes an incoming change from our echo.
  const synced = useRef<ProcessForm>(formFromProcess(process))
  // Seed of the draft: differing from THIS is the only proof the operator typed
  // (the draft also differs from disk whenever an external change is held back).
  const seeded = useRef<ProcessForm>(formFromProcess(process))
  const shownId = useRef(process.id)
  const focused = useRef<TextField | null>(null)
  const lastSaveAt = useRef(0)
  const lastSaved = useRef<ProcessForm | null>(null)
  const latest = useRef(process)

  const mode = launchModeOf(process)
  // Which third of the segmented control the fill sits over.
  const modeIndex = LAUNCH_MODES.findIndex((option) => option.value === mode)

  // Recovery fields are dimmed while the entry is off (nothing applies), but stay
  // editable — configuring them before switching the mode on is the normal flow.
  const unmanaged = mode === 'off'
  const live = isLive(status)
  const copy = launchCopy()

  useEffect(() => {
    latest.current = process
    const next = formFromProcess(process)

    // Different process: adopt wholesale, cursor or not.
    if (shownId.current !== process.id) {
      shownId.current = process.id
      synced.current = next
      seeded.current = next
      lastSaved.current = null
      focused.current = null
      setPendingRefresh(false)
      setDraft(next)
      return
    }

    if (formsEqual(next, synced.current)) return

    synced.current = next
    if (focused.current) {
      setPendingRefresh(true)
    } else {
      seeded.current = next
      setDraft(next)
    }
  }, [process])

  /** Write `form` if it says something new. Returns whether it wrote. */
  const save = useCallback(
    (form: ProcessForm): boolean => {
      const coerced = coerceForm(form)

      // Never soft-save a blank name: the entry becomes unfindable in the list.
      if (!coerced.name) return false

      const onDisk = formFromProcess(latest.current)
      if (formsEqual(coerced, onDisk)) {
        // Nothing to write, but the typed value may not be the stored one (a 2s
        // initialise time floors to 10), so stop showing a value disk lacks.
        seeded.current = onDisk
        setDraft(onDisk)
        return false
      }

      const now = Date.now()
      if (
        lastSaved.current &&
        formsEqual(coerced, lastSaved.current) &&
        now - lastSaveAt.current < SAVE_DEBOUNCE_MS
      ) {
        return false
      }

      lastSaveAt.current = now
      lastSaved.current = coerced
      synced.current = coerced
      seeded.current = coerced
      setDraft(coerced)
      onSave(coerced)
      return true
    },
    [onSave],
  )

  const handleBlur = useCallback(() => {
    focused.current = null

    // The operator's edit outranks a change that arrived mid-typing.
    if (!formsEqual(draft, seeded.current)) {
      save(draft)
      setPendingRefresh(false)
      return
    }

    if (pendingRefresh) {
      const onDisk = formFromProcess(latest.current)
      synced.current = onDisk
      seeded.current = onDisk
      setDraft(onDisk)
      setPendingRefresh(false)
    }
  }, [draft, pendingRefresh, save])

  const browse = useCallback(
    async (field: 'exe_path' | 'file_path' | 'cwd') => {
      try {
        const picked =
          field === 'exe_path'
            ? await pickExecutable(draft.exe_path)
            : field === 'file_path'
              ? await pickFile(draft.file_path)
              : await pickDirectory(draft.cwd)

        if (picked === null) return
        const next = { ...draft, [field]: picked }
        setDraft(next)
        save(next)
      } catch (cause) {
        toast.error('could not open the file picker', {
          description: cause instanceof Error ? cause.message : String(cause),
        })
      }
    },
    [draft, save],
  )

  function field(name: TextField) {
    return {
      value: draft[name],
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setDraft((current) => ({ ...current, [name]: event.target.value })),
      onFocus: () => {
        focused.current = name
      },
      onBlur: handleBlur,
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') return
        save(draft)
        event.currentTarget.blur()
      },
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        Same grid template as the form below, so the header is that layout's first
        row: `name` right-aligns with `launch mode` and `exe`, and the field starts
        where every input does.
      */}
      <header
        data-testid="detail-header"
        className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 px-6 pt-4 pb-3"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Label htmlFor="name" className="justify-end text-muted-foreground">
              name
            </Label>
          </TooltipTrigger>
          <TooltipContent>
            the display name for this process — how it appears here and on the dashboard
          </TooltipContent>
        </Tooltip>

        {/* Controls sit with the status word, not across the pane from it. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Input
            id="name"
            placeholder="name of your process"
            // Wide enough for the names entries actually carry, and no wider:
            // the room it gives up is what puts the status on the same line.
            className="h-8 w-full max-w-64 min-w-0 flex-1"
            {...field('name')}
          />

          {/* Status + its two controls float right; the name holds the left. */}
          <span aria-hidden className="grow" />

          <Tooltip>
            <TooltipTrigger asChild>
              <span className={cn('text-sm', STATUS_TEXT[status])} data-testid="detail-status">
                {statusLabel(status)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              what the service reports for this process right now
            </TooltipContent>
          </Tooltip>

          {/*
            `app_states.json` only records the launch of this generation, so this is
            a launch time — shown only while that generation is still up.
          */}
          {live && startedAt !== null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="text-xs text-muted-foreground"
                  data-testid="detail-started"
                  data-started-at={startedAt}
                >
                  started {formatDistanceToNowStrict(startedAt, { addSuffix: true })}
                </span>
              </TooltipTrigger>
              <TooltipContent>launched {format(startedAt, 'eee d MMM, HH:mm:ss')}</TooltipContent>
            </Tooltip>
          )}

          {/*
            Both actions follow liveness alone, never the launch mode: a running
            process can be restarted or killed whatever its mode, and a dead one
            can be neither — the launch mode is what brings it back. Disabled
            buttons get no pointer events, so each tooltip hangs off a wrapper.
          */}
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={onRestart}
                    disabled={!live}
                    aria-label="restart process"
                  >
                    <RotateCcw />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {live
                  ? 'restart — stop it and let the service start it again'
                  : `restart — nothing to restart while this process is ${statusLabel(status)}`}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    size="icon-sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    onClick={onKill}
                    disabled={!live}
                    aria-label="kill process"
                  >
                    <Square />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {live
                  ? 'kill — terminate it now, without a crash alert'
                  : `kill — nothing to terminate while this process is ${statusLabel(status)}`}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      {/* Scrolls under the header rather than being clipped by it. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 @container">
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
          {/* The name lives in the header row above; this is the rest of it. */}
          <Collapsible
            open={sections.whatToRun}
            onOpenChange={(open) => onSectionToggle?.('whatToRun', open)}
            className="contents"
          >
            <SectionToggle first testId="what-to-run-toggle">
              what to run
            </SectionToggle>
            <CollapsibleContent className="col-span-2">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 pt-3">

          <Tooltip>
            <TooltipTrigger asChild>
              <Label htmlFor="exe_path" className="justify-end text-muted-foreground">
                {copy.label}
              </Label>
            </TooltipTrigger>
            <TooltipContent>{copy.tooltip}</TooltipContent>
          </Tooltip>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              className="size-8"
              variant="outline"
              onClick={() => void browse('exe_path')}
              aria-label={copy.browseAria}
            >
              <FileSearch />
            </Button>
            <PathInput
              id="exe_path"
              placeholder={copy.placeholder}
              className="h-8 font-mono text-xs"
              {...field('exe_path')}
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Label htmlFor="file_path" className="justify-end text-muted-foreground">
                path / args
              </Label>
            </TooltipTrigger>
            <TooltipContent>{copy.fileTooltip}</TooltipContent>
          </Tooltip>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              className="size-8"
              variant="outline"
              onClick={() => void browse('file_path')}
              aria-label="browse for a file"
            >
              <FileSearch />
            </Button>
            <PathInput
              id="file_path"
              placeholder="a file to open, or command line arguments"
              className="h-8 font-mono text-xs"
              {...field('file_path')}
            />
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Label htmlFor="cwd" className="justify-end text-muted-foreground">
                cwd
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              the folder the process starts in — set it when your app loads files by relative paths
            </TooltipContent>
          </Tooltip>
          <div className="flex min-w-0 items-center gap-2">
            <Button
              size="icon"
              className="size-8"
              variant="outline"
              onClick={() => void browse('cwd')}
              aria-label="browse for a working directory"
            >
              <FolderOpen />
            </Button>
            <PathInput
              id="cwd"
              placeholder="the working directory for your process"
              className="h-8 font-mono text-xs"
              {...field('cwd')}
            />
          </div>

              </div>
            </CollapsibleContent>
          </Collapsible>

          <Collapsible
            open={sections.whenToRun}
            onOpenChange={(open) => onSectionToggle?.('whenToRun', open)}
            className="contents"
          >
            <SectionToggle testId="when-to-run-toggle">when to run</SectionToggle>
            <CollapsibleContent className="col-span-2">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 pt-3">

          <Tooltip>
            <TooltipTrigger asChild>
              <Label id="launch-mode-label" className="justify-end text-muted-foreground">
                launch mode
              </Label>
            </TooltipTrigger>
            <TooltipContent>
              off: owlette leaves it alone · always on: kept running 24/7 and relaunched if it
              crashes · scheduled: runs during the time windows you set
            </TooltipContent>
          </Tooltip>
          <div className="flex min-w-0 items-center gap-3">
            {/*
              One bordered shell around the three-mode group and the schedule
              pencil. Border/rounding/clipping live here, not on the group, so the
              pencil sits inside them.
            */}
            <div className="flex w-fit overflow-hidden rounded-lg border border-border bg-card">
              {/*
                All three states visible, one click apart, with a sliding fill.

                EQUAL COLUMNS ARE LOAD-BEARING: the indicator is a third of the
                group wide and moves in whole multiples of itself, so label-sized
                segments would leave it landing short. `grid-cols-3` under `w-fit`
                gives every column the widest label's width — and is why the pencil
                is a SIBLING of this grid, not a fourth cell (a fourth column would
                make the indicator a quarter wide).
              */}
              <div
                role="radiogroup"
                aria-labelledby="launch-mode-label"
                data-testid="launch-mode"
                className="relative grid h-8 w-fit grid-cols-3"
              >
                <span
                  aria-hidden
                  data-testid="launch-mode-indicator"
                  className={cn(
                    'pointer-events-none absolute inset-y-0 left-0 w-1/3 transition-[transform,background-color] duration-200 motion-reduce:transition-none',
                    LAUNCH_MODE_FILL[mode],
                  )}
                  style={{ transform: `translateX(${modeIndex * 100}%)` }}
                />
                {LAUNCH_MODES.map((option) => {
                  const active = option.value === mode
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-testid={`launch-mode-${option.value}`}
                      // Re-clicking the current mode is not a change; the caller
                      // writes config.json for every one it is told about.
                      onClick={() => !active && onLaunchMode(option.value)}
                      className={cn(
                        'relative z-10 flex cursor-pointer items-center px-3 text-xs font-medium transition-colors',
                        active
                          ? LAUNCH_MODE_TEXT[option.value]
                          : 'text-muted-foreground hover:bg-muted/50',
                      )}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
              {/*
                Offered in EVERY launch mode. Gating it on `scheduled` put the
                windows behind the mode that needs them, and a scheduled entry with
                no windows runs always — two walkthroughs hit that. Editing from
                `off`/`always on` just stores windows; only the segmented control
                changes a mode, which is why the pencil never takes a fill.
              */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setEditingSchedule(true)}
                    aria-label="edit schedule"
                    data-testid="edit-schedule"
                    className="flex cursor-pointer items-center border-l border-border px-2.5 text-muted-foreground transition-colors hover:bg-muted/50"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>edit schedule</TooltipContent>
              </Tooltip>
            </div>
            {mode === 'scheduled' && (
              <span className="truncate text-xs text-muted-foreground" data-testid="schedule-note">
                {scheduleSummary(process)}
              </span>
            )}
          </div>

                {/* Launch timing is a "when": dimmed while the mode is off,
                    because nothing launches until one is set. */}
                <div
                  className={cn(
                    'col-span-2 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 @2xl:grid-cols-[7rem_minmax(0,1fr)_7rem_minmax(0,1fr)] [&>*]:transition-opacity',
                    unmanaged && '[&>*]:opacity-70 [&>*]:focus-within:opacity-100',
                  )}
                  data-testid="when-to-run-timing"
                  data-dimmed={unmanaged || undefined}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label htmlFor="time_delay" className="justify-end text-muted-foreground">
                        delay (sec)
                      </Label>
                    </TooltipTrigger>
                    <TooltipContent>
                      seconds to wait before launching this process on startup — stagger heavy apps
                      so they don&apos;t fight over the gpu
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    id="time_delay"
                    className="h-8 w-20"
                    inputMode="numeric"
                    {...field('time_delay')}
                  />

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Label htmlFor="time_to_init" className="justify-end text-muted-foreground">
                        wait (sec)
                      </Label>
                    </TooltipTrigger>
                    <TooltipContent>
                      seconds to wait after launch before monitoring starts — give slow apps time
                      to boot before crash checks apply
                    </TooltipContent>
                  </Tooltip>
                  <Input
                    id="time_to_init"
                    className="h-8 w-20"
                    inputMode="numeric"
                    {...field('time_to_init')}
                  />
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/*
            Tune-once fields — recovery attempts, priority, visibility — behind
            their own disclosure so the everyday view stays name / what / when.
            Priority and visibility exist on windows only: the service applies
            neither on macos or linux, so they are not offered there.
            Two or three columns when the pane is wide enough; the label gutter
            repeats per column.
          */}
          <Collapsible
            open={sections.howToRun}
            onOpenChange={(open) => onSectionToggle?.('howToRun', open)}
            className="contents"
          >
            <SectionToggle
              testId="how-to-run-toggle"
              dimmed={unmanaged}
              note={unmanaged ? '· applies once a launch mode is set' : undefined}
            >
              how to run
            </SectionToggle>
            <CollapsibleContent className="col-span-2">
              {/* Dimmed, not disabled — see the isOff note above. */}
              <div
                className={cn(
                  'grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 pt-3 @2xl:grid-cols-[7rem_minmax(0,1fr)_7rem_minmax(0,1fr)] @4xl:grid-cols-[7rem_minmax(0,1fr)_7rem_minmax(0,1fr)_7rem_minmax(0,1fr)] [&>*]:transition-opacity',
                  // Full strength for the focused field: the dimming is about when
                  // these apply, not about what is under the cursor.
                  unmanaged && '[&>*]:opacity-70 [&>*]:focus-within:opacity-100',
                )}
                data-testid="how-to-run-fields"
                data-dimmed={unmanaged || undefined}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Label htmlFor="relaunch_attempts" className="justify-end text-muted-foreground">
                      attempts
                    </Label>
                  </TooltipTrigger>
                  <TooltipContent>
                    max relaunch attempts before an automatic machine restart is initiated — 0 is
                    unlimited
                  </TooltipContent>
                </Tooltip>
                <Input
                  id="relaunch_attempts"
                  className="h-8 w-20"
                  inputMode="numeric"
                  {...field('relaunch_attempts')}
                />

                {copy.launchOptions && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="priority" className="justify-end text-muted-foreground">
                          priority
                        </Label>
                      </TooltipTrigger>
                      <TooltipContent>
                        windows cpu priority for this process — leave normal unless it must outrank
                        everything else
                      </TooltipContent>
                    </Tooltip>
                    <Select
                      value={priorityOf(process)}
                      onValueChange={(value) => onPriority(value as Priority)}
                    >
                      <SelectTrigger id="priority" className="h-8 w-32" data-testid="priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option.toLowerCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="visibility" className="justify-end text-muted-foreground">
                          visibility
                        </Label>
                      </TooltipTrigger>
                      <TooltipContent>
                        window visibility on launch — hidden suppresses the console window (ideal for
                        background scripts); apps that create their own windows stay visible
                      </TooltipContent>
                    </Tooltip>
                    <Select
                      value={visibilityOf(process)}
                      onValueChange={(value) => onVisibility(value as Visibility)}
                    >
                      <SelectTrigger id="visibility" className="h-8 w-32" data-testid="visibility">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VISIBILITIES.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option.toLowerCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      {/*
        Mounted only while open: the editor seeds its draft in a state initializer,
        so the remount is what makes a second visit show disk instead of the last
        draft. Outside the mode-conditional markup so a launch-mode change from the
        web app mid-edit can't yank the dialog away.
      */}
      {editingSchedule && (
        <ScheduleEditor
          open
          schedules={process.schedules}
          scheduleTimezone={scheduleTimezone}
          onClose={() => setEditingSchedule(false)}
          onSave={onSchedules}
        />
      )}
    </div>
  )
}
