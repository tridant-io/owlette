/**
 * `config/config.json` as this app touches it, plus the pure transforms behind
 * every write. Two inherited rules:
 *
 * 1. Never rebuild the document — every transform spreads the parsed one, so
 *    unknown keys (`firebase`, `displays`, `sentry`, `rebootSchedule`, the web's
 *    `processId` / `schedulePresetId`) survive. With serde_json `preserve_order`
 *    on the Rust side a desktop write leaves `firebase` byte-identical.
 * 2. Spreading preserves key order; only genuinely new keys get appended.
 *
 * Field names are the python service's snake_case — this is a view over its
 * file format, not a place to invent a nicer one.
 */

import { launchCopy } from '@/lib/launchCopy'

/** `off` is unmanaged, `always` is 24/7 with crash recovery, `scheduled` runs windows. */
export type LaunchMode = 'off' | 'always' | 'scheduled'

/** CPU priority classes the service knows how to apply. */
export const PRIORITIES = ['Low', 'Normal', 'High', 'Realtime'] as const
export type Priority = (typeof PRIORITIES)[number]

/** Window visibility on launch. Legacy configs say `Show` / `Hide`. */
export const VISIBILITIES = ['Normal', 'Hidden'] as const
export type Visibility = (typeof VISIBILITIES)[number]

/**
 * One schedule window, `HH:MM` 24-hour. `stop` < `start` means overnight: opens
 * on each scheduled day, closes next morning (`shared_utils.is_within_schedule`).
 */
export interface ScheduleRange {
  start: string
  stop: string
}

/**
 * Days + the windows that apply to them. Field-for-field the web's
 * `ScheduleBlock` (`web/hooks/useFirestore.ts:150-160`) — both apps write the
 * same array. `name`/`colorIndex` are editor bookkeeping the service ignores;
 * neither app may drop one it did not add. Readers still guard `days`/`ranges`
 * because the file can be hand-edited.
 */
export interface ScheduleBlock {
  /** The operator's label for the block, e.g. `morning shift`. */
  name?: string
  /** Stable colour slot, so deleting a block does not recolour its neighbours. */
  colorIndex?: number
  days: string[]
  ranges: ScheduleRange[]
}

/**
 * One entry of `processes[]`. Everything but `id` is optional: field entries
 * predate several fields, and numeric ones become strings as soon as a human
 * types them. The service reads both, so never coerce a value we did not touch.
 */
export interface ProcessEntry {
  id: string
  name?: string
  exe_path?: string
  file_path?: string
  cwd?: string
  priority?: string
  visibility?: string
  time_delay?: string | number
  time_to_init?: string | number
  relaunch_attempts?: string | number
  launch_mode?: string
  autolaunch?: boolean
  schedules?: ScheduleBlock[] | null
  [key: string]: unknown
}

export interface OwletteConfig {
  processes?: ProcessEntry[]
  [key: string]: unknown
}

/** The fields the detail form edits as free text (everything else is a select). */
export const TEXT_FIELDS = [
  'name',
  'exe_path',
  'file_path',
  'cwd',
  'time_delay',
  'time_to_init',
  'relaunch_attempts',
] as const

export type TextField = (typeof TEXT_FIELDS)[number]
export type ProcessForm = Record<TextField, string>

/** Defaults the legacy GUI writes for a brand new entry (`owlette_gui.new_process`). */
export const NEW_PROCESS_DEFAULTS = {
  name: 'untitled process',
  time_delay: '0',
  time_to_init: '10',
  relaunch_attempts: '5',
} as const

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** `processes[]`, or an empty list when the document has never held one. */
export function processesOf(config: OwletteConfig): ProcessEntry[] {
  return Array.isArray(config.processes) ? config.processes : []
}

export function findProcess(config: OwletteConfig, id: string): ProcessEntry | undefined {
  return processesOf(config).find((process) => process.id === id)
}

export function indexOfProcess(config: OwletteConfig, id: string): number {
  return processesOf(config).findIndex((process) => process.id === id)
}

/** Launch mode, falling back to the pre-`launch_mode` `autolaunch` boolean. */
export function launchModeOf(process: ProcessEntry): LaunchMode {
  const mode = process.launch_mode
  if (mode === 'off' || mode === 'always' || mode === 'scheduled') return mode
  return process.autolaunch ? 'always' : 'off'
}

/** Visibility, mapping the legacy `Show` / `Hide` spellings onto today's. */
export function visibilityOf(process: ProcessEntry): Visibility {
  const value = text(process.visibility)
  if (value === 'Hidden' || value === 'Hide') return 'Hidden'
  return 'Normal'
}

export function priorityOf(process: ProcessEntry): Priority {
  const value = text(process.priority)
  return (PRIORITIES as readonly string[]).includes(value) ? (value as Priority) : 'Normal'
}

export function formFromProcess(process: ProcessEntry): ProcessForm {
  return {
    name: text(process.name),
    exe_path: text(process.exe_path),
    file_path: text(process.file_path),
    cwd: text(process.cwd),
    time_delay: text(process.time_delay),
    time_to_init: text(process.time_to_init),
    relaunch_attempts: text(process.relaunch_attempts),
  }
}

export function formsEqual(a: ProcessForm, b: ProcessForm): boolean {
  return TEXT_FIELDS.every((field) => a[field] === b[field])
}

/**
 * "Soft save" (`owlette_gui.py:886-945`): blur fires on every focus change, so a
 * nonsense number is replaced by the default rather than thrown back mid-edit.
 * delay >= 0, time-to-init >= 10, relaunch attempts an integer >= 0 (0 =
 * unlimited). Trimming is ours — a trailing space in an exe path is an
 * invisible launch failure.
 */
export function coerceForm(form: ProcessForm): ProcessForm {
  const delay = Number(form.time_delay.trim())
  const init = Number(form.time_to_init.trim())
  const attempts = Number(form.relaunch_attempts.trim())

  return {
    name: form.name.trim(),
    exe_path: form.exe_path.trim(),
    file_path: form.file_path.trim(),
    cwd: form.cwd.trim(),
    time_delay:
      form.time_delay.trim() === '' || !Number.isFinite(delay) || delay < 0
        ? NEW_PROCESS_DEFAULTS.time_delay
        : form.time_delay.trim(),
    time_to_init:
      form.time_to_init.trim() === '' || !Number.isFinite(init) || init < 10
        ? NEW_PROCESS_DEFAULTS.time_to_init
        : form.time_to_init.trim(),
    relaunch_attempts:
      form.relaunch_attempts.trim() === '' ||
      !Number.isInteger(attempts) ||
      attempts < 0
        ? NEW_PROCESS_DEFAULTS.relaunch_attempts
        : form.relaunch_attempts.trim(),
  }
}

/** Replace `processes[]`, leaving every other top-level key exactly where it was. */
function withProcesses(config: OwletteConfig, processes: ProcessEntry[]): OwletteConfig {
  return { ...config, processes }
}

/** Throws when the id is gone — it was deleted since the read; writing would resurrect it. */
export function updateProcess(
  config: OwletteConfig,
  id: string,
  update: (process: ProcessEntry) => ProcessEntry,
): OwletteConfig {
  const processes = processesOf(config)
  const index = processes.findIndex((process) => process.id === id)
  if (index < 0) throw new Error(`process ${id} is no longer in config.json`)

  const next = processes.slice()
  next[index] = update({ ...processes[index] })
  return withProcesses(config, next)
}

/** Write the seven text fields onto an entry, keeping every other key. */
export function applyForm(process: ProcessEntry, form: ProcessForm): ProcessEntry {
  return {
    ...process,
    name: form.name,
    exe_path: form.exe_path,
    file_path: form.file_path,
    cwd: form.cwd,
    time_delay: form.time_delay,
    time_to_init: form.time_to_init,
    relaunch_attempts: form.relaunch_attempts,
  }
}

/**
 * Keeps the legacy `autolaunch` mirror in step — the service still reads it on
 * pre-launch_mode entries, so a disagreement launches a process the UI calls off.
 */
export function setLaunchMode(process: ProcessEntry, mode: LaunchMode): ProcessEntry {
  return { ...process, launch_mode: mode, autolaunch: mode !== 'off' }
}

export function setPriority(process: ProcessEntry, priority: Priority): ProcessEntry {
  return { ...process, priority }
}

export function setVisibility(process: ProcessEntry, visibility: Visibility): ProcessEntry {
  return { ...process, visibility }
}

/**
 * `schedulePresetId` is deliberately left alone: presets live in Firestore, so
 * this app cannot tell whether the edits still match the named preset. The web's
 * own dialog leaves it too (`ProcessDialog.tsx:241-245`).
 */
export function setSchedules(process: ProcessEntry, schedules: ScheduleBlock[]): ProcessEntry {
  return { ...process, schedules }
}

/**
 * Can this entry leave `off`? Presence only — unlike the legacy GUI we cannot
 * stat the exe (no filesystem command). A blank exe path never leaves `off`
 * (this guard blocks it before the service is ever involved); a path that is
 * present but unresolvable passes here, fails at launch, and the service
 * writes LAUNCH_FAILED onto the entry's newest row — visible for any entry
 * that has ever launched. An entry that never produced a row (broken path
 * from creation) has no row to reuse and stays INACTIVE.
 */
export function launchModeBlockedReason(process: ProcessEntry): string | null {
  if (!text(process.name).trim()) return 'name is required before a launch mode can be set'
  if (!text(process.exe_path).trim()) return launchCopy().pathRequired
  return null
}

/** A fresh entry with the legacy GUI's defaults. `id` comes from `crypto.randomUUID()`. */
export function createProcessEntry(id: string, name: string = NEW_PROCESS_DEFAULTS.name): ProcessEntry {
  return {
    id,
    name,
    exe_path: '',
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: NEW_PROCESS_DEFAULTS.time_delay,
    time_to_init: NEW_PROCESS_DEFAULTS.time_to_init,
    relaunch_attempts: NEW_PROCESS_DEFAULTS.relaunch_attempts,
    launch_mode: 'off',
    autolaunch: false,
    schedules: null,
  }
}

export function addProcess(config: OwletteConfig, entry: ProcessEntry): OwletteConfig {
  return withProcesses(config, [...processesOf(config), entry])
}

export function removeProcess(config: OwletteConfig, id: string): OwletteConfig {
  return withProcesses(
    config,
    processesOf(config).filter((process) => process.id !== id),
  )
}

/**
 * `untitled process`, `untitled process 2`, … — same 409 rationale as
 * {@link uniqueCopyName}: repeated `+` clicks must not mint colliding names.
 */
export function uniqueDefaultName(
  processes: readonly ProcessEntry[],
  baseName: string = NEW_PROCESS_DEFAULTS.name,
): string {
  const taken = new Set(processes.map((process) => text(process.name).trim()))
  if (!taken.has(baseName)) return baseName
  let n = 2
  while (taken.has(`${baseName} ${n}`)) n += 1
  return `${baseName} ${n}`
}

/**
 * `name (copy)`, `name (copy 2)`, … — the web API 409s on duplicate process
 * names, so a name-reusing clone would fail to sync on the next config upload.
 */
export function uniqueCopyName(existing: readonly string[], baseName: string): string {
  const taken = new Set(existing)
  let candidate = `${baseName} (copy)`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${baseName} (copy ${n})`
    n += 1
  }
  return candidate
}

/**
 * Deep clone, launch mode forced off — nobody duplicates an always-on entry
 * meaning to start a second copy immediately. `processId` (the web's mirror of
 * `id`) is re-pointed too, else the clone syncs as an edit of its original.
 */
export function duplicateProcess(config: OwletteConfig, id: string, newId: string): OwletteConfig {
  const original = findProcess(config, id)
  if (!original) throw new Error(`process ${id} is no longer in config.json`)

  const clone = structuredClone(original) as ProcessEntry
  clone.id = newId
  if ('processId' in clone) clone.processId = newId
  clone.name = uniqueCopyName(
    processesOf(config).map((process) => text(process.name)),
    text(original.name),
  )
  clone.launch_mode = 'off'
  if ('autolaunch' in clone) clone.autolaunch = false

  return addProcess(config, clone)
}

/**
 * `processes[]` order is the startup launch sequence, not cosmetic — hence
 * drag-ordering rather than sorting. A no-op or out-of-range move returns the
 * document untouched so it never triggers a write.
 */
export function reorderProcess(config: OwletteConfig, id: string, toIndex: number): OwletteConfig {
  const processes = processesOf(config)
  const from = processes.findIndex((process) => process.id === id)
  if (from < 0 || toIndex < 0 || toIndex >= processes.length || toIndex === from) return config

  const next = processes.slice()
  const [moved] = next.splice(from, 1)
  next.splice(toIndex, 0, moved)
  return withProcesses(config, next)
}

/**
 * One-line window summary, wording from `owlette_gui.py:784-800`. Empty is not
 * "nothing runs" — `shared_utils.is_within_schedule` returns True for an empty
 * schedule, so the copy says so.
 */
export function scheduleSummary(process: ProcessEntry): string {
  const blocks = Array.isArray(process.schedules) ? process.schedules : []
  const parts = blocks
    .map((block) => {
      const days = Array.isArray(block.days) && block.days.length ? block.days.join(', ') : 'all days'
      const ranges = Array.isArray(block.ranges)
        ? block.ranges
            .filter((range) => range?.start && range?.stop)
            .map((range) => `${range.start}-${range.stop}`)
            .join(', ')
        : ''
      return ranges ? `${days}: ${ranges}` : null
    })
    .filter((part): part is string => part !== null)

  return parts.length ? parts.join(' | ') : '(no schedule set — runs at all times)'
}

/**
 * Image names for `terminate_pid`'s identity check, most specific first.
 * `.bat`/`.cmd` run as `cmd.exe` so the configured path can never match.
 * Otherwise full path then bare file name — configured vs actually-running
 * paths legitimately differ for adopted processes. This name-based check is
 * the desktop's own; the service's destructive ops instead prove identity
 * against a recorded pid/create_time/exe snapshot
 * (`shared_utils.identity_matches`).
 */
export function expectedImagesFor(process: ProcessEntry): string[] {
  const exe = text(process.exe_path).trim()
  if (!exe) return []
  if (/\.(bat|cmd)$/i.test(exe)) return ['cmd.exe']

  const fileName = exe.replace(/\//g, '\\').split('\\').pop() ?? exe
  return fileName && fileName !== exe ? [exe, fileName] : [exe]
}
