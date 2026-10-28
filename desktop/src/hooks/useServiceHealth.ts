import { useCallback, useEffect, useRef, useState } from 'react'
import { useOwletteFileWatch } from '@/hooks/useOwletteFileWatch'
import {
  OWLETTE_FILES,
  readOwletteJson,
  serviceStart,
  serviceStatus,
  type ServiceStatus,
} from '@/lib/ipc'
import {
  isUpdateInProgress,
  UPDATE_MARKER_PATH,
  type ServiceStatusFile,
  type UpdateMarker,
} from '@/lib/serviceHealth'

/**
 * SCM re-query interval — the app's only timer. A dead service stops writing
 * `service_status.json`, so there are no events left and the staleness rule (the
 * tray's two minutes) can only be applied by asking again. An SCM query costs
 * microseconds and never touches the seam files.
 */
const SCM_REFRESH_MS = 15_000

/** When a start is requested, when to look for the result. */
const START_CONFIRM_DELAYS_MS = [2_000, 6_000]

export interface ServiceHealthStore {
  status: ServiceStatus | null
  statusFile: ServiceStatusFile | null
  /** True while a start request is in flight (it may be waiting on a UAC prompt). */
  starting: boolean
  error: string | null
  refresh: () => void
  start: () => Promise<void>
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
  const [error, setError] = useState<string | null>(null)

  const disposed = useRef(false)
  const autoStarted = useRef(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  // Counted, not a flag, so overlapping claims can't release each other's.
  const holds = useRef(0)

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
        if (!disposed.current) setStatus(next)
      })
      .catch((cause) => {
        if (!disposed.current) setError(message(cause))
      })
  }, [])

  const refresh = useCallback(() => {
    queryScm()
    readStatusFile()
  }, [queryScm, readStatusFile])

  const start = useCallback(async (allowElevation = true) => {
    setStarting(true)
    setError(null)
    try {
      await serviceStart(allowElevation)
      // An elevated start only confirms the shell accepted the request — observe
      // the result rather than assuming it.
      START_CONFIRM_DELAYS_MS.forEach((delay) => {
        timers.current.push(setTimeout(() => refresh(), delay))
      })
    } catch (cause) {
      if (!disposed.current) setError(message(cause))
    } finally {
      if (!disposed.current) setStarting(false)
    }
  }, [refresh])

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

  // Auto-start once, at launch, when the service is found down, unless a claim
  // is holding it down. Two rules keep this path silent: it never elevates (an
  // unattended UAC prompt is never acceptable — the footer's start button is
  // the consent path), and it stands down entirely while a self-update owns the
  // service, whose installer stops it on purpose and restarts it itself.
  // Without the second rule every machine's tray app raised a UAC prompt over
  // whatever was running, on every fleet update.
  useEffect(() => {
    if (autoStarted.current || holds.current > 0 || !status) return
    // a service seen running and later down was stopped by someone; linux's
    // polkit rule let this start through and cancel their `systemctl stop`.
    if (status.running) {
      autoStarted.current = true
      return
    }
    if (!status.installed || status.state === 'start_pending') return
    let cancelled = false
    void readOwletteJson<UpdateMarker>(UPDATE_MARKER_PATH)
      // Missing marker file = no update = clear to start.
      .catch(() => null)
      .then((marker) => {
        if (cancelled || autoStarted.current || holds.current > 0) return
        // autoStarted stays unconsumed: when the marker goes stale with the
        // service still down, the next status poll gets another chance.
        if (isUpdateInProgress(marker, Date.now())) return
        autoStarted.current = true
        void start(false)
      })
    return () => {
      cancelled = true
    }
  }, [status, start])

  return { status, statusFile, starting, error, refresh, start, hold }
}
