/**
 * `tmp/app_states.json` — the service's live process table — and the join that
 * turns it into a dot next to a name. Keyed by OS pid:
 *
 * ```json
 * { "18244": { "id": "e38d36a5-…", "status": "RUNNING", "timestamp": 1786562574 } }
 * ```
 *
 * A config entry can own several pids at once (crashed generations are left
 * behind, and Windows recycles pids), so every lookup must pick one deliberately.
 */

export const PROCESS_STATUSES = [
  'RUNNING',
  'LAUNCHING',
  'RESTARTING',
  'STALLED',
  'QUEUED',
  'LAUNCH_FAILED',
  'KILLED',
  'STOPPED',
  'INACTIVE',
] as const

export type ProcessStatus = (typeof PROCESS_STATUSES)[number]

/**
 * The two statuses this app writes itself, both telling the service an exit it
 * is about to see was intended. `KILLED` = leave it alone; `RESTARTING` = same
 * crash-alert suppression plus a `process_restarted` audit event. Everything
 * else in {@link PROCESS_STATUSES} is the service's to write.
 */
export type ProcessMarker = Extract<ProcessStatus, 'KILLED' | 'RESTARTING'>

export interface AppState {
  id?: string
  status?: string
  timestamp?: number
  [key: string]: unknown
}

export type AppStates = Record<string, AppState>

/**
 * Keep only usable entries. The service has written malformed ones before (a
 * `None` pid key), and this is read on every watcher event, so a non-numeric
 * pid or non-object value is dropped rather than crashing the list. Unknown
 * keys inside an entry are preserved — a status write must not lose them.
 */
export function parseAppStates(raw: unknown): AppStates {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const states: AppStates = {}
  for (const [pid, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(pid)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    states[pid] = value as AppState
  }
  return states
}

function entriesFor(states: AppStates, processId: string): [number, AppState][] {
  return Object.entries(states)
    .filter(([, state]) => state.id === processId)
    .map(([pid, state]) => [Number(pid), state] as [number, AppState])
}

/** Newest first, by the service's timestamp, with the higher pid breaking ties. */
function byRecency(a: [number, AppState], b: [number, AppState]): number {
  return recencyOf(b[1]) - recencyOf(a[1]) || b[0] - a[0]
}

/**
 * What "recent" means for a row with no timestamp. The service stamps
 * `timestamp` at launch only, so an adopted row never has one. Reading missing
 * as 0 let a stale KILLED generation outrank a live adopted one (2026-09-04:
 * pane said "killed", run controls keyed off the displayed status went dead
 * while the process ran). A live-status row with no timestamp now reads as
 * "now" - the process observably exists, which is at least as recent as any
 * recorded launch. A dead row with no timestamp still reads as oldest: it
 * carries no evidence of recency, and ranking it high would mirror the bug
 * (a dead adopted row shadowing a live launched one). Among timestamped rows
 * nothing changes, so an operator's kill still wins on recency.
 * MAX_SAFE_INTEGER rather than Infinity: Infinity - Infinity is NaN, which
 * would poison the sort when two adopted live rows meet.
 */
function recencyOf(state: AppState): number {
  if (typeof state.timestamp === 'number') return state.timestamp
  return isLive(asStatus(state.status) ?? 'INACTIVE') ? Number.MAX_SAFE_INTEGER : 0
}

function asStatus(value: unknown): ProcessStatus | null {
  return typeof value === 'string' && (PROCESS_STATUSES as readonly string[]).includes(value)
    ? (value as ProcessStatus)
    : null
}

/**
 * Status for a config entry: the most recent generation's. Deliberately NOT
 * "prefer RUNNING" — a killed process keeps its timestamp, so that would leave
 * a stale green dot on a process the operator just stopped. Never-launched or
 * all-unrecognised reads INACTIVE.
 */
export function statusForProcess(states: AppStates, processId: string): ProcessStatus {
  const [newest] = entriesFor(states, processId).sort(byRecency)
  return (newest && asStatus(newest[1].status)) ?? 'INACTIVE'
}

/**
 * Statuses whose pid generation is running right now.
 *
 * `STALLED` belongs here: the service writes it when a process stops answering
 * but before killing anything, so it is alive and exactly what an operator
 * wants to restart. Omitting it made a hung process read `INACTIVE` and greyed
 * out the restart control. The dashboard treats it as actionable too.
 */
const LIVE_STATUSES: readonly ProcessStatus[] = ['RUNNING', 'LAUNCHING', 'RESTARTING', 'STALLED']

/** Whether there is a process behind this status to stop. */
export function isLive(status: ProcessStatus): boolean {
  return LIVE_STATUSES.includes(status)
}

/**
 * When the newest generation was *launched*, in unix ms, or null.
 *
 * The service stamps `timestamp` once at launch and never again — status
 * changes are written without it. So this is a launch time, not the start of
 * the current status, and it is only honest beside a status {@link isLive}
 * accepts; showing it next to `killed`/`stopped` claims more than the file says.
 */
export function launchedAtForProcess(states: AppStates, processId: string): number | null {
  const [newest] = entriesFor(states, processId).sort(byRecency)
  const timestamp = newest?.[1].timestamp
  return typeof timestamp === 'number' && timestamp > 0 ? timestamp * 1000 : null
}

/**
 * Every pid a kill or restart should try, most likely first: live-status
 * generations by recency, then the rest by recency. Several candidates are the
 * norm, not an edge case — adopted rows carry no timestamp, and a dead
 * generation can sit at `RUNNING` until the service's next stale-pid sweep,
 * so the caller's identity check in `terminate_pid` decides which one is real
 * and walks on past the ones that are not.
 */
export function candidatePidsForProcess(states: AppStates, processId: string): number[] {
  const entries = entriesFor(states, processId)
  const live = entries
    .filter(([, state]) => isLive(asStatus(state.status) ?? 'INACTIVE'))
    .sort(byRecency)
  const rest = entries
    .filter(([, state]) => !isLive(asStatus(state.status) ?? 'INACTIVE'))
    .sort(byRecency)
  return [...live, ...rest].map(([pid]) => pid)
}

/** The single most likely pid, or null — see {@link candidatePidsForProcess}. */
export function livePidForProcess(states: AppStates, processId: string): number | null {
  return candidatePidsForProcess(states, processId)[0] ?? null
}

/**
 * Stamp a marker on one pid, leaving the rest of the document alone: status
 * replaced, config id re-asserted, timestamp and unknown keys preserved.
 */
export function markProcess(
  states: AppStates,
  pid: number,
  processId: string,
  marker: ProcessMarker,
): AppStates {
  const key = String(pid)
  return { ...states, [key]: { ...states[key], status: marker, id: processId } }
}

/** "The operator killed it" — no crash alert, no audit event, no relaunch of ours. */
export function markKilled(states: AppStates, pid: number, processId: string): AppStates {
  return markProcess(states, pid, processId, 'KILLED')
}

/** "The operator restarted it" — no crash alert, but a `process_restarted` event. */
export function markRestarting(states: AppStates, pid: number, processId: string): AppStates {
  return markProcess(states, pid, processId, 'RESTARTING')
}

/**
 * Put a pid's row back the way it was. `RESTARTING` must be written BEFORE
 * termination, so it is sometimes written for one that never happens. Nothing
 * corrects it — the service only rewrites rows it monitors — so an unmanaged
 * entry would sit at "restarting" until reboot and suppress a real crash alert.
 */
export function restoreState(states: AppStates, pid: number, previous: AppState): AppStates {
  return { ...states, [String(pid)]: previous }
}

/**
 * dot colours, on the dashboard's status tokens. stalled and queued keep a
 * warmer step of their own, where the dashboard draws them as launching.
 * INACTIVE is a hollow ring, as in the legacy GUI.
 */
export const STATUS_DOT: Record<ProcessStatus, string> = {
  RUNNING: 'bg-success',
  LAUNCHING: 'bg-warning',
  RESTARTING: 'bg-warning',
  STALLED: 'bg-accent-warm',
  QUEUED: 'bg-accent-warm',
  LAUNCH_FAILED: 'bg-danger',
  KILLED: 'bg-danger',
  STOPPED: 'bg-danger',
  INACTIVE: 'bg-transparent border border-muted-foreground/80',
}

/** Text colour for the status word in the detail panel. */
export const STATUS_TEXT: Record<ProcessStatus, string> = {
  RUNNING: 'text-success',
  LAUNCHING: 'text-warning',
  RESTARTING: 'text-warning',
  STALLED: 'text-accent-warm',
  QUEUED: 'text-accent-warm',
  LAUNCH_FAILED: 'text-danger',
  KILLED: 'text-danger',
  STOPPED: 'text-danger',
  INACTIVE: 'text-muted-foreground',
}

/** Lowercase copy for a status, matching the dashboard's badge wording. */
export function statusLabel(status: ProcessStatus): string {
  return status === 'LAUNCH_FAILED' ? 'failed' : status.toLowerCase()
}
