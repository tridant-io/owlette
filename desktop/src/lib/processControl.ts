/**
 * Stopping a process the way the service expects. Kill and restart differ only in the marker
 * written to `tmp/app_states.json`:
 *
 * - **kill**: terminate, THEN write `KILLED`. The service treats the exit as intentional.
 * - **restart**: write `RESTARTING` on BOTH sides of the kill. The service skips the crash alert,
 *   screenshot and Cortex event, writes a `process_restarted` audit event, and relaunches within
 *   one tick (`owlette_service.py:2598-2630`).
 *
 * The sides are deliberate. `KILLED` asserts the process is gone, so writing it early would lie
 * whenever the kill fails. `RESTARTING` asserts only intent and needs both writes:
 * *before*, because an exit the poller sees before the marker lands is reported as a crash;
 * *after*, because closing takes seconds and every tick in that window writes `RUNNING` over the
 * marker. Each half alone lost a race reproduced on a live agent.
 *
 * Writing early means it can outlive a kill that never happened — {@link stopProcess} undoes that.
 *
 * Both flows are purely local, no cloud command, matching `owlette_gui.py:1182-1303`.
 */

import { terminatePid, type TerminateMethod } from '@/lib/ipc'
import { launchCopy } from '@/lib/launchCopy'
import { expectedImagesFor, type ProcessEntry } from '@/lib/owletteConfig'
import {
  candidatePidsForProcess,
  markKilled,
  markRestarting,
  restoreState,
  type AppStates,
  type ProcessMarker,
} from '@/lib/processStatus'

export type StopMode = 'kill' | 'restart'

/** The marker each mode leaves behind for the service to find. */
const MARKERS: Record<StopMode, ProcessMarker> = {
  kill: 'KILLED',
  restart: 'RESTARTING',
}

export interface StopResult {
  pid: number
  method: TerminateMethod
  /** The marker written to `app_states.json` for the service to read. */
  marker: ProcessMarker
}

/** Nothing running to act on — a normal outcome, not a fault. */
export class NoLiveInstanceError extends Error {
  constructor(processName: string) {
    super(`no running instance of ${processName} was found`)
    this.name = 'NoLiveInstanceError'
  }
}

export interface StopDeps {
  /** Must be a fresh read of `app_states.json`; pids go stale fast. */
  readStates: () => Promise<AppStates>
  /** Read-modify-write of `app_states.json`. */
  mutateStates: (transform: (states: AppStates) => AppStates) => Promise<AppStates>
}

/** The host's wording when a pid turns out to be running something else entirely. */
const IDENTITY_MISMATCH = 'refusing to terminate'

function isIdentityMismatch(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(IDENTITY_MISMATCH)
}

/**
 * Terminate `pid`, trying each acceptable image in turn: full path first, bare file name second.
 * The host's identity check is the point — this try-order is the desktop's own (the service's
 * destructive ops instead prove identity against a recorded pid/create_time/exe snapshot,
 * `shared_utils.identity_matches`) — but configured vs actually-running legitimately differ for
 * adopted processes. Anything other than an identity mismatch (access denied, an unkillable pid)
 * aborts immediately.
 */
async function terminateAs(pid: number, images: string[]) {
  let lastError: unknown = new Error('no executable to identify the process by')

  for (const image of images) {
    try {
      return await terminatePid(pid, image)
    } catch (cause) {
      if (!isIdentityMismatch(cause)) throw cause
      lastError = cause
    }
  }

  throw lastError
}

/**
 * Stop the live instance of `entry`, marking the exit as the operator's. See the module note.
 *
 * Candidates are tried in turn: a pid the host reports as already gone is skipped, not a
 * failure — the table keeps dead generations around, and the identity check is what tells
 * them apart. Only when none of them is alive is there nothing to stop.
 */
export async function stopProcess(
  entry: ProcessEntry,
  mode: StopMode,
  deps: StopDeps,
): Promise<StopResult> {
  const name = String(entry.name ?? entry.id)
  const images = expectedImagesFor(entry)
  if (!images.length) {
    throw new Error(`${name} has no ${launchCopy().pathName}, so there is no way to identify its process`)
  }

  const states = await deps.readStates()
  for (const pid of candidatePidsForProcess(states, entry.id)) {
    const result =
      mode === 'restart'
        ? await restartPid(pid, states, entry, images, deps)
        : await killPid(pid, entry, images, deps)
    if (result) return result
  }
  throw new NoLiveInstanceError(name)
}

async function killPid(
  pid: number,
  entry: ProcessEntry,
  images: string[],
  deps: StopDeps,
): Promise<StopResult | null> {
  const result = await terminate(pid, images, 'kill')
  if (result) await deps.mutateStates((current) => markKilled(current, pid, entry.id))
  return result
}

async function restartPid(
  pid: number,
  states: AppStates,
  entry: ProcessEntry,
  images: string[],
  deps: StopDeps,
): Promise<StopResult | null> {
  const previous = states[String(pid)]
  await deps.mutateStates((current) => markRestarting(current, pid, entry.id))

  let result: StopResult | null
  try {
    result = await terminate(pid, images, 'restart')
  } catch (cause) {
    // No kill happened, so the marker claims an exit that isn't ours. Best-effort rollback: if
    // this write also fails, the original failure is still what the operator sees.
    await deps
      .mutateStates((current) => restoreState(current, pid, previous))
      .catch(() => undefined)
    throw cause
  }

  if (!result) {
    // Already gone: a process that died a moment before the click really did crash, and the
    // service must still be free to say so.
    await deps.mutateStates((current) => restoreState(current, pid, previous))
    return null
  }

  // Again, now the process is really gone: closing takes seconds (WM_CLOSE, grace, terminate)
  // and every service tick in that window writes `RUNNING` over the marker. Observed on a live
  // agent — marker written, overwritten, exit reported as a crash with screenshot.
  await deps.mutateStates((current) => markRestarting(current, pid, entry.id))
  return result
}

/** Terminate; null when the pid was already gone, which does not count as a stop. */
async function terminate(
  pid: number,
  images: string[],
  mode: StopMode,
): Promise<StopResult | null> {
  const outcome = await terminateAs(pid, images)
  if (outcome.method === 'not_found') return null
  return { pid, method: outcome.method, marker: MARKERS[mode] }
}
