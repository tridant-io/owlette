import { useCallback, useEffect, useRef, useState } from 'react'
import { useOwletteFileWatch } from '@/hooks/useOwletteFileWatch'
import {
  ARG_PAIR,
  ARG_RESTART_PROMPT,
  ARG_TRAY,
  commandWasIssued,
  launchArgs,
  OWLETTE_FILES,
  readOwletteJson,
  serviceStart,
  serviceStatus,
  type ServiceState,
  type ServiceStatus,
} from '@/lib/ipc'
import type { ServiceStatusFile } from '@/lib/serviceHealth'

/**
 * SCM re-query interval — the app's only timer. A dead service stops writing
 * `service_status.json`, so there are no events left and the staleness rule (the
 * tray's two minutes) can only be applied by asking again. An SCM query costs
 * microseconds and never touches the seam files.
 */
const SCM_REFRESH_MS = 15_000

/** When a start is requested, when to look for the result. */
const START_CONFIRM_DELAYS_MS = [2_000, 6_000]

/**
 * How long a start this app watched is allowed to take before the footer stops
 * making excuses for it and reports whatever it actually finds.
 *
 * Covers the whole bring-up rather than one phase of it: owlette-host reaches
 * RUNNING almost at once, the python agent behind it takes ~8 s to boot, and the
 * cloud connection lands a few seconds after that. All three are "connecting" to
 * the person watching. Past this, a service that still has not published is
 * wedged and one that still has not reached the cloud is disconnected — both
 * worth saying plainly.
 */
const STARTUP_GRACE_MS = 45_000

export interface StartOptions {
  /**
   * Whether a UAC prompt may be raised if the SCM refuses. `true` means the
   * operator asked for this by hand.
   */
  allowElevation?: boolean
}

export interface ServiceHealthStore {
  status: ServiceStatus | null
  statusFile: ServiceStatusFile | null
  /** True while a start request is in flight (it may be waiting on a UAC prompt). */
  starting: boolean
  /**
   * True when the last start was declined for want of elevation rather than
   * failing. Not an error — this machine simply predates the interactive
   * service grant, or has had it trimmed by policy.
   */
  elevationRequired: boolean
  /**
   * True while this app is getting the service up: a start is in flight, one is
   * about to be issued, or one it watched is still inside {@link STARTUP_GRACE_MS}.
   *
   * The footer needs this because "the service is stopped" and "the service is
   * stopped and we are three hundred milliseconds from starting it" look
   * identical in an SCM query, and only one of them is worth telling the
   * operator about.
   */
  bringingUp: boolean
  /**
   * Last start/stop failure. Deliberately sticky: the operator should keep
   * seeing why the thing they pressed did not work.
   */
  error: string | null
  /**
   * Last SCM *poll* failure, cleared by the next successful poll. Separate from
   * {@link ServiceHealthStore.error} so a recovered blip stops being reported,
   * without a 15-second poll wiping a failed start's message out from under it.
   */
  scmError: string | null
  refresh: () => void
  start: (options?: StartOptions) => Promise<void>
  /**
   * Claim the service's state for an operation that deliberately stops it (e.g.
   * leaving a site: stop, deregister, start). Returns a release the caller must
   * call however it ends. Auto-start stands down while a claim is out — its UAC
   * prompt would restart the service mid-deregistration and recreate the machine
   * document.
   */
  hold: () => () => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `OwletteService`'s state and the status file it publishes. On launch an
 * installed-but-stopped service is started — opening the app is a clear signal
 * the operator wants supervision running. An uninstalled service is left alone.
 */
export function useServiceHealth(): ServiceHealthStore {
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [statusFile, setStatusFile] = useState<ServiceStatusFile | null>(null)
  const [starting, setStarting] = useState(false)
  const [elevationRequired, setElevationRequired] = useState(false)
  const [bringUpActive, setBringUpActive] = useState(false)
  /**
   * True until the launch-time auto-start has been decided one way or the other.
   * Starts true: on the first render nothing is known yet, and guessing "the
   * service is down and nobody is doing anything about it" is the guess that
   * puts a `start service` button under an operator who just opened the app.
   */
  const [awaitingAutoStart, setAwaitingAutoStart] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scmError, setScmError] = useState<string | null>(null)
  /**
   * Whether the operator launched this app, or the service did. Null until argv
   * comes back — the auto-start waits for it rather than guessing, because
   * guessing wrong means a UAC prompt at logon.
   */
  const [explicitLaunch, setExplicitLaunch] = useState<boolean | null>(null)

  const disposed = useRef(false)
  const autoStarted = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Counted, not a flag, so overlapping claims can't release each other's.
  const holds = useRef(0)
  // Last SCM state seen, so a start can be told from a state we merely walked in on.
  const previousState = useRef<ServiceState | null>(null)
  /**
   * When the current bring-up started — either a start this app issued, or one it
   * watched happen. Null when nothing is on its way up.
   *
   * Timed from the *request*, not from the SCM reaching `running`: for a second
   * or two after a start is issued the SCM still says `stopped`, and that gap is
   * where the footer used to flash "service not running" with a button under an
   * operator who had just opened the app.
   */
  const bringUpSince = useRef<number | null>(null)

  useEffect(() => {
    disposed.current = false
    const pending = timers.current
    return () => {
      disposed.current = true
      pending.forEach(clearTimeout)
      pending.length = 0
    }
  }, [])

  const readStatusFile = useCallback(() => {
    void readOwletteJson<ServiceStatusFile>(OWLETTE_FILES.serviceStatus)
      .then((document) => {
        if (!disposed.current) setStatusFile(document)
      })
      .catch(() => {
        // A torn read is transient: the footer keeps the last good state until the
        // next event, as the tray does.
      })
  }, [])

  const queryScm = useCallback(() => {
    void serviceStatus()
      .then((next) => {
        if (disposed.current) return
        setStatus(next)
        // Transient by nature — the SCM can be busy at logon, and a torn RPC
        // recovers on the next tick. Sticky here would leave "could not connect
        // to the service manager" under a green `connected` for the life of the
        // window, now that the footer actually renders these.
        setScmError(null)
      })
      .catch((cause) => {
        if (!disposed.current) setScmError(message(cause))
      })
  }, [])

  const refresh = useCallback(() => {
    queryScm()
    readStatusFile()
  }, [queryScm, readStatusFile])

  /**
   * Abandon the bring-up. Called the moment we learn nothing is actually coming
   * up, so the footer stops saying `connecting…` and puts `start service` back
   * where the operator can reach it.
   */
  const endBringUp = useCallback(() => {
    bringUpSince.current = null
    setBringUpActive(false)
  }, [])

  const start = useCallback(
    async ({ allowElevation = true }: StartOptions = {}) => {
      bringUpSince.current = Date.now()
      setBringUpActive(true)
      setStarting(true)
      setError(null)
      try {
        const outcome = await serviceStart(allowElevation)
        if (disposed.current) return
        // A refusal for want of a prompt is a successful call that did nothing,
        // so it must not read as a failure — the footer offers the prompt instead.
        setElevationRequired(outcome.method === 'needs_elevation')
        if (!commandWasIssued(outcome)) {
          // Refused or redundant. Optimistically stamping the bring-up before
          // the answer came back is right — the request usually succeeds — but
          // leaving it stamped after a refusal hid the recovery button behind
          // 45 seconds of yellow for a service that was never coming.
          endBringUp()
          return
        }
        // An elevated start only confirms the shell accepted the request — observe
        // the result rather than assuming it.
        START_CONFIRM_DELAYS_MS.forEach((delay) => {
          timers.current.push(setTimeout(() => refresh(), delay))
        })
      } catch (cause) {
        if (disposed.current) return
        endBringUp()
        setError(message(cause))
      } finally {
        if (!disposed.current) setStarting(false)
      }
    },
    [refresh, endBringUp],
  )

  const hold = useCallback(() => {
    holds.current += 1
    let released = false
    return () => {
      if (released) return
      released = true
      holds.current -= 1
      // A deliberate drive outranks the launch-time auto-start: if it ended with
      // the service down (declined elevation), a second prompt 15s later would
      // take the decision off the operator. The footer's start button remains.
      autoStarted.current = true
    }
  }, [])

  useEffect(refresh, [refresh])
  useOwletteFileWatch('service_status', refresh)

  useEffect(() => {
    const timer = setInterval(queryScm, SCM_REFRESH_MS)
    return () => clearInterval(timer)
  }, [queryScm])

  useEffect(() => {
    let cancelled = false
    void launchArgs()
      .then((argv) => {
        if (cancelled) return
        // Something other than the operator spawned this app: `--tray` at logon,
        // `--restart-prompt` when a process has burned its relaunch budget, and
        // `--pair` when the installer hands off to finish pairing. In none of
        // them did anyone ask for the service, so none may put a UAC prompt on
        // screen — least of all `--pair`, where the grant has not been applied
        // yet on a fresh install and the operator is mid-setup being asked for
        // a pairing phrase.
        const passive = [ARG_TRAY, ARG_RESTART_PROMPT, ARG_PAIR]
        setExplicitLaunch(!argv.some((argument) => passive.includes(argument)))
      })
      .catch(() => {
        // Unknowable: assume the operator. An unwanted prompt is recoverable;
        // quietly declining to start the service is not.
        if (!cancelled) setExplicitLaunch(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Track whether a bring-up is in progress, and time it out. Only a start this
  // app issued or actually watched earns the grace: a service that was already
  // running-but-silent when the window opened is wedged, not booting, and nothing
  // about it is in progress.
  useEffect(() => {
    if (!status) return
    const previous = previousState.current
    previousState.current = status.state

    // Up and publishing: the bring-up is over, whoever started it.
    if (status.state === 'running' && !status.statusFile.stale) {
      bringUpSince.current = null
      setBringUpActive(false)
      return
    }
    // A start this app did not issue — the service came up on its own, or another
    // surface asked for it. Still worth the grace, and still not the operator's
    // problem to solve.
    if (
      status.state === 'running' &&
      previous !== null &&
      previous !== 'running' &&
      bringUpSince.current === null
    ) {
      bringUpSince.current = Date.now()
    }
    setBringUpActive(
      bringUpSince.current !== null && Date.now() - bringUpSince.current < STARTUP_GRACE_MS,
    )
  }, [status])

  // Auto-start once, on the first SETTLED status, unless a claim is holding the
  // service down.
  //
  // The ordering here is the whole point. This guard used to return early on
  // `status.running` *before* arming the latch, so a session that opened with a
  // healthy service left it unarmed — and the first not-running status it ever
  // saw was the stop the operator had just asked for from the tray's exit. It
  // then dutifully started the service they were quitting, which is where the
  // second UAC prompt on exit came from. Arm on any settled state; only then
  // decide whether a start is called for.
  //
  // Transitional states settle nothing: `start_pending` is already on its way,
  // and `stop_pending` is that same quit, in progress.
  useEffect(() => {
    if (autoStarted.current || holds.current > 0 || !status) return
    if (explicitLaunch === null) return
    if (!status.installed) return
    if (status.state === 'start_pending' || status.state === 'stop_pending') return
    autoStarted.current = true
    // Same tick as the `setStarting(true)` inside `start`, so the footer never
    // sees a frame where neither is true and reports the service as abandoned.
    setAwaitingAutoStart(false)
    if (status.running) return
    void start({ allowElevation: explicitLaunch })
  }, [status, start, explicitLaunch])

  return {
    status,
    statusFile,
    starting,
    elevationRequired,
    bringingUp: starting || awaitingAutoStart || bringUpActive,
    error,
    scmError,
    refresh,
    start,
    hold,
  }
}
