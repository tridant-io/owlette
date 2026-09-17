/**
 * Typed access to the Rust host. Every Tauri command has exactly one wrapper
 * here and nothing else calls `invoke` directly, so a rename in
 * `src-tauri/src/commands.rs` breaks the build instead of failing at runtime.
 *
 * Mirrors the python service's file seam: JSON reads/writes go through the
 * `Global\OwletteJsonFileMutex` named mutex and land atomically; the three
 * files the service publishes are watched, not polled.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Seam files, addressed relative to the owlette data root. */
export const OWLETTE_FILES = {
  config: 'config/config.json',
  appStates: 'tmp/app_states.json',
  serviceStatus: 'tmp/service_status.json',
} as const

/** Discriminant carried by a file-changed event. */
export type OwletteFile = 'config' | 'app_states' | 'service_status'

/**
 * The service rewrites `service_status.json` on a 30 s throttle, so older than
 * this means nothing is writing it, not that it is slow.
 */
export const SERVICE_STATUS_STALE_SECONDS = 120

/** Event names emitted by the host (see `src-tauri/src/lib.rs`). */
const EVENT_FILE_CHANGED = 'owlette://file-changed'
const EVENT_SECOND_INSTANCE = 'owlette://second-instance'

/**
 * `acquired` is normal. `unavailable` means the agent on this machine predates
 * the fix that gave the mutex an explicit descriptor, so LocalSystem's default
 * DACL shuts out non-elevated processes. Writes stay atomic either way — worst
 * case a lost update, never a torn file.
 */
export type LockOutcome = 'acquired' | 'abandoned' | 'timeout' | 'unavailable'

export interface WriteOutcome {
  lock: LockOutcome
  /** Time spent waiting on the mutex. */
  waitedMs: number
  /** Attempts used; more than one means the file was locked or being replaced. */
  attempts: number
  bytes: number
}

export interface FileChange {
  file: OwletteFile
  /** Absolute path of the file that changed. */
  path: string
  /** Unix milliseconds. */
  at: number
}

export interface SecondInstancePayload {
  argv: string[]
  cwd: string
}

export interface StatusFileInfo {
  exists: boolean
  /** Seconds since the last write, when the file exists. */
  ageSecs: number | null
  /** True when missing or older than {@link SERVICE_STATUS_STALE_SECONDS}. */
  stale: boolean
}

export type ServiceState =
  | 'running'
  | 'stopped'
  | 'start_pending'
  | 'stop_pending'
  | 'continue_pending'
  | 'pause_pending'
  | 'paused'
  | 'unknown'

export type ServiceStartType =
  | 'auto_start'
  | 'on_demand'
  | 'disabled'
  | 'system_start'
  | 'boot_start'
  | 'unknown'

export interface ServiceStatus {
  /** False when OwletteService is not registered on this machine. */
  installed: boolean
  running: boolean
  state: ServiceState
  startType: ServiceStartType
  /**
   * For a stopped service, whether it exited cleanly; null when it is not
   * stopped. A quit and a crash both leave the SCM saying STOPPED, and this is
   * the only thing that tells them apart.
   */
  stoppedCleanly: boolean | null
  statusFile: StatusFileInfo
}

/**
 * How a start/stop was answered.
 *
 * Only `scm` and `elevated` did anything. The other three are successful calls
 * that deliberately changed nothing: `noop` (already there, or already heading
 * there), `quitting` (a start refused because the app is on its way out) and
 * `needs_elevation` (the SCM said no and the caller did not want a UAC prompt
 * raised on its behalf).
 */
export type ServiceCommandMethod = 'scm' | 'elevated' | 'noop' | 'quitting' | 'needs_elevation'

export interface ServiceCommandOutcome {
  method: ServiceCommandMethod
  /**
   * State before the request. An elevated start only confirms the shell
   * accepted it, so callers poll {@link serviceStatus} for the result.
   */
  stateBefore: ServiceState
}

export type TerminateMethod = 'not_found' | 'wm_close' | 'terminated'

export interface TerminateOutcome {
  method: TerminateMethod
  waitedMs: number
  /** Top-level windows that were sent WM_CLOSE. */
  windowsClosed: number
  imagePath: string | null
}

/** Absolute path of the owlette data root (`%PROGRAMDATA%\Owlette`). */
export function owletteDataRoot(): Promise<string> {
  return invoke<string>('owlette_data_root')
}

/** Argument the service passes to ask for a tray icon with no window. */
export const ARG_TRAY = '--tray'

/** Argument the service passes when a process has exhausted its relaunch budget. */
export const ARG_RESTART_PROMPT = '--restart-prompt'

/** Argument the installer passes to open this window straight on the pairing dialog. */
export const ARG_PAIR = '--pair'

/**
 * Argument that names which owlette server to pair against; only meaningful
 * alongside {@link ARG_PAIR}.
 */
export const ARG_SERVER = '--server'

/** 'dev' | 'prod' from `--server dev` or `--server=dev`; null when absent or unrecognised. */
export function serverFromArgs(argv: readonly string[]): 'dev' | 'prod' | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    let value: string | undefined
    if (arg === ARG_SERVER) {
      value = argv[i + 1]
    } else if (arg.startsWith(`${ARG_SERVER}=`)) {
      value = arg.slice(ARG_SERVER.length + 1)
    } else {
      continue
    }
    // The first occurrence decides, even when its value is junk — a later
    // well-formed flag must not override what the installer put first.
    return value === 'dev' || value === 'prod' ? value : null
  }
  return null
}

/**
 * argv of the FIRST launch only. A second launch is folded into this instance
 * by the single-instance plugin, which forwards its argv through
 * {@link onSecondInstance} — anything reacting to {@link ARG_RESTART_PROMPT}
 * must read both.
 */
export function launchArgs(): Promise<string[]> {
  return invoke<string[]>('launch_args')
}

/** This machine's name, as the fleet knows it (`COMPUTERNAME`). */
export function hostname(): Promise<string> {
  return invoke<string>('hostname')
}

/** Whether the run-on-login startup shortcut exists. */
export function startupLinkEnabled(): Promise<boolean> {
  return invoke<boolean>('startup_link_enabled')
}

/** Create or remove the run-on-login shortcut; resolves to the resulting state. */
export function setStartupLink(enabled: boolean): Promise<boolean> {
  return invoke<boolean>('set_startup_link', { enabled })
}

/**
 * Read a JSON file from the owlette tree under the cross-process mutex.
 * Missing file → `{}` (`app_states.json` doesn't exist until the service has
 * launched something). Unparseable content REJECTS, so a torn read can never
 * be mistaken for an empty config and written back over the real one.
 */
export function readOwletteJson<T = Record<string, unknown>>(path: string): Promise<T> {
  return invoke<T>('read_owlette_json', { path })
}

/**
 * Write JSON into the owlette tree: service-matching 4-space indent, scratch
 * file renamed over the target. No read-modify-write — callers must read,
 * merge, and write the whole document back, preserving keys they don't
 * understand (the `firebase` block above all).
 */
export function writeOwletteJson(path: string, json: unknown): Promise<WriteOutcome> {
  return invoke<WriteOutcome>('write_owlette_json', { path, json })
}

/** SCM state of OwletteService plus the freshness of `service_status.json`. */
export function serviceStatus(): Promise<ServiceStatus> {
  return invoke<ServiceStatus>('service_status')
}

/**
 * Start OwletteService, then poll {@link serviceStatus} — neither an elevated
 * launch nor an SCM start means the service is up yet.
 *
 * `allowElevation` is the operator's intent, not a capability check: pass `true`
 * only when they asked for this by hand. On a machine without the interactive
 * service grant, `false` comes back as `needs_elevation` rather than putting a
 * UAC prompt in front of someone who clicked nothing.
 */
export function serviceStart(allowElevation: boolean): Promise<ServiceCommandOutcome> {
  return invoke<ServiceCommandOutcome>('service_start', { allowElevation })
}

/**
 * Whether a start/stop actually reached the SCM. Mirrors `service_ctl::was_issued`
 * — the other three methods are successful calls that deliberately did nothing,
 * and a caller that treats them as work done will report progress that is not
 * happening.
 */
export function commandWasIssued(outcome: ServiceCommandOutcome): boolean {
  return outcome.method === 'scm' || outcome.method === 'elevated'
}

/** Stop OwletteService, on the same terms as {@link serviceStart}. */
export function serviceStop(allowElevation: boolean): Promise<ServiceCommandOutcome> {
  return invoke<ServiceCommandOutcome>('service_stop', { allowElevation })
}

/**
 * Close a process gracefully (WM_CLOSE, then terminate), but only if the pid is
 * still running `expectedExe` — a recycled pid rejects rather than killing an
 * unrelated process.
 */
export function terminatePid(
  pid: number,
  expectedExe: string,
  gracefulTimeoutMs?: number,
): Promise<TerminateOutcome> {
  return invoke<TerminateOutcome>('terminate_pid', {
    pid,
    expectedExe,
    gracefulTimeoutMs: gracefulTimeoutMs ?? null,
  })
}

/**
 * Sidebar width in logical pixels. Device-local shell geometry, so it lives in
 * a per-user JSON beside the remembered window size
 * (`%APPDATA%\app.owlette.desktop\layout.json`), not in fleet `config.json`.
 */
export function sidebarWidth(): Promise<number> {
  return invoke<number>('sidebar_width')
}

/**
 * Store the sidebar width; resolves to the value actually kept (the host
 * clamps). Debounce — this writes a file and a drag fires per frame.
 */
export function setSidebarWidth(width: number): Promise<number> {
  return invoke<number>('set_sidebar_width', { width })
}

/** Whether the process list should open collapsed to its icon rail. */
export function sidebarCollapsed(): Promise<boolean> {
  return invoke<boolean>('sidebar_collapsed')
}

/**
 * Remember whether the process list is collapsed. Stored beside the width, not
 * instead of it, so expanding lands on the last dragged width.
 */
export function setSidebarCollapsed(collapsed: boolean): Promise<boolean> {
  return invoke<boolean>('set_sidebar_collapsed', { collapsed })
}

/**
 * The executable's Windows icon as a `data:` URL, or null.
 *
 * Resolves (not rejects) for every ordinary miss — blank path, missing file, no
 * icon — because the list draws the same fallback glyph for all of them. Host
 * failures reject; callers treat those as a miss too. The host caches by path +
 * mtime, so per-row calls cost a hash lookup after the first extraction.
 */
export async function exeIcon(path: string): Promise<string | null> {
  const encoded = await invoke<string | null>('exe_icon', { path })
  return encoded ? `data:image/png;base64,${encoded}` : null
}

/** Severity accepted by {@link logEvent}; anything else is recorded as info. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Append to the app's log file
 * (`%LOCALAPPDATA%\app.owlette.desktop\logs\owlette-desktop.log`). Release
 * builds have no console and no devtools, so unlogged steps are unrecoverable
 * after the fact — and the flows worth logging are the ones that can take the
 * app down mid-sequence (e.g. a teardown stopping the owlette service).
 *
 * Never rejects: a step that failed to be logged must not become a failed step.
 */
export function logEvent(level: LogLevel, message: string): Promise<void> {
  return invoke<void>('log_event', { level, message }).catch(() => undefined)
}

/**
 * Both halves matter: a service that is running but hasn't refreshed
 * `service_status.json` for two minutes is wedged, and the footer must not show
 * a green light.
 */
export function isServiceDown(status: ServiceStatus): boolean {
  return !status.installed || !status.running || status.statusFile.stale
}

/** Subscribe to every seam-file change. */
export function onOwletteFileChanged(handler: (change: FileChange) => void): Promise<UnlistenFn> {
  return listen<FileChange>(EVENT_FILE_CHANGED, (event) => handler(event.payload))
}

/** Subscribe to changes of one seam file. */
export function onOwletteFileChangedFor(
  file: OwletteFile,
  handler: (change: FileChange) => void,
): Promise<UnlistenFn> {
  return onOwletteFileChanged((change) => {
    if (change.file === file) handler(change)
  })
}

/**
 * Relaunch attempts. A second launch opens no window — the host focuses this
 * one and forwards its argv here, which is how `--tray` and `--restart-prompt`
 * reach an already-running app.
 */
export function onSecondInstance(
  handler: (payload: SecondInstancePayload) => void,
): Promise<UnlistenFn> {
  return listen<SecondInstancePayload>(EVENT_SECOND_INSTANCE, (event) => handler(event.payload))
}
