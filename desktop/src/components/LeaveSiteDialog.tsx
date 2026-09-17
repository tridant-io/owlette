import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InlineNotice } from '@/components/ui/inline-notice'
import { startAgentRun } from '@/lib/agentCli'
import { logEvent, serviceStart, serviceStatus, serviceStop } from '@/lib/ipc'

interface LeaveSiteDialogProps {
  open: boolean
  /**
   * Site for the confirmation copy — display name when published, id otherwise
   * ({@link import('@/lib/serviceHealth').siteNameOf}). The operator has to
   * recognise the name for the sentence to be a decision rather than a riddle.
   */
  site: string
  onClose: () => void
  onLeft: () => void
  /**
   * Claim the service's state for the teardown ({@link
   * import('@/hooks/useServiceHealth').ServiceHealthStore.hold}) so nothing
   * else restarts it mid-leave. Returns the release, always called.
   */
  onHold: () => () => void
}

type Phase = 'confirm' | 'working' | 'left' | 'failed'

/**
 * Which step gave up. A failed stop means nothing was touched; a failed helper
 * leaves the machine's membership in doubt.
 */
type Failure = 'stop' | 'leave'

interface Result {
  /** False when the machine's row could not be deleted from the dashboard. */
  deregistered: boolean
  /** True when we stopped the service and could not start it again. */
  serviceDown: boolean
}

/** How often the SCM is re-queried while waiting for a stop or a start. */
const POLL_MS = 500

/** How long the service gets to stop before the leave is abandoned. */
const STOP_TIMEOUT_MS = 45_000

/** How long the service gets to come back up before the operator is told. */
const START_TIMEOUT_MS = 45_000

/**
 * Grace for the helper to exit after its last line. It exits immediately; the
 * bound only stops a wedged interpreter trapping the dialog open.
 */
const HELPER_EXIT_GRACE_MS = 5_000

/**
 * Helper lines about the service, suppressed. `configure_site.py --leave` still
 * asks NSSM to stop/start but runs unelevated, so both calls fail — which is
 * why this dialog stops the service itself. Echoing them would narrate nothing.
 */
const HELPER_SERVICE_STATUSES = new Set(['stopping the service', 'restarting the service'])

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Log one teardown step. 2026-08-13: stopping the watched service killed the
 * app mid-sequence and the log just stopped, with no record of how far it got.
 * Every step now announces itself before running and reports how it ended.
 */
function leaveLog(step: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  void logEvent(level, `leave-site: ${step}`)
}

/** The host's elevation failure, in words that name what the operator saw. */
function stopReason(error: string): string {
  return /elevation was declined/i.test(error)
    ? 'the administrator prompt was declined or could not be shown'
    : error
}

/**
 * Poll the SCM for the requested state: an elevated start/stop only confirms
 * the shell accepted the request. A throwing query means "not yet" (the SCM is
 * briefly unhelpful mid-transition); a missing service counts as stopped.
 */
async function waitForService(want: 'running' | 'stopped', timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const status = await serviceStatus()
      const there =
        want === 'running' ? status.running : !status.installed || status.state === 'stopped'
      if (there) return true
    } catch {
      // Treated as "not yet".
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

interface HelperOutcome {
  ok: boolean
  deregistered: boolean
  /** What to show when `ok` is false. */
  error: string | null
}

/**
 * Run `configure_site.py --leave` to EXIT, not just to its last line —
 * restarting the service while it is still deleting the machine document is
 * the one way a deleted row comes back.
 */
async function runLeaveHelper(onStatus: (status: string) => void): Promise<HelperOutcome> {
  // Object, not `let`: written from a callback and read after an await, which
  // a property survives without narrowing games.
  const state: { terminal: HelperOutcome | null; spoke: (() => void) | null } = {
    terminal: null,
    spoke: null,
  }
  const spoken = new Promise<void>((resolve) => {
    state.spoke = resolve
  })

  const run = await startAgentRun('leave', {
    onEvent: (event) => {
      switch (event.event) {
        case 'status':
          if (!HELPER_SERVICE_STATUSES.has(event.value)) onStatus(event.value)
          return
        case 'done':
          state.terminal = {
            ok: true,
            deregistered: event.value.deregistered !== false,
            error: null,
          }
          state.spoke?.()
          return
        case 'error':
          state.terminal = { ok: false, deregistered: false, error: event.value }
          state.spoke?.()
          return
        default:
          return
      }
    },
  })

  await Promise.race([
    run.completed,
    spoken.then(() => new Promise((resolve) => setTimeout(resolve, HELPER_EXIT_GRACE_MS))),
  ])

  if (state.terminal) return state.terminal

  const outcome = await run.completed
  return {
    ok: false,
    deregistered: false,
    error: outcome.stderr.trim() || 'the leave helper stopped before it finished',
  }
}

/** What to tell the operator once the machine is out of the site. */
function leftCopy(site: string, result: Result): string {
  const lines = [`this machine has left ${site} and is no longer monitored.`]
  if (!result.deregistered) {
    lines.push('its row is still on the dashboard — you can remove it there.')
  }
  if (result.serviceDown) {
    lines.push('the owlette service is still stopped — use start service in the footer to start it.')
  }
  return lines.join(' ')
}

/** What to tell the operator when a step gave up. */
function failedCopy(failure: Failure, site: string, result: Result): string {
  if (failure === 'stop') {
    // Nothing was written yet — the payoff of stopping before the teardown.
    return `leaving stops the owlette service first, and it is still running. nothing on this machine changed — it is still paired to ${site}.`
  }
  const lines = [`leaving ${site} did not finish. the footer shows whether this machine is still in the site.`]
  if (result.serviceDown) {
    lines.push('the owlette service is still stopped — use start service in the footer to start it.')
  }
  return lines.join(' ')
}

/**
 * Leave a site: confirm, then watch it happen. Order is the legacy GUI's
 * (`owlette_gui.on_leave_site_click`, :1994-2074) — sync off in `config.json`
 * and the machine document deleted while the service is STOPPED, so nothing
 * recreates the row between delete and restart.
 *
 * The stop happens here, not in the helper: `configure_site.py` runs as the
 * logged-in user and lacks SERVICE_STOP, so it asked, was refused, and carried
 * on. The host elevates (`service_ctl.rs`); declining the prompt aborts before
 * `config.json` is touched. Steps are shown live — a fifteen-second freeze
 * looks broken.
 */
export function LeaveSiteDialog({
  open,
  site: siteLabel,
  onClose,
  onLeft,
  onHold,
}: LeaveSiteDialogProps) {
  const [phase, setPhase] = useState<Phase>('confirm')
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure>('stop')
  const [result, setResult] = useState<Result>({ deregistered: true, serviceDown: false })

  useEffect(() => {
    if (!open) return
    setPhase('confirm')
    setStatus('')
    setError(null)
    setFailure('stop')
    setResult({ deregistered: true, serviceDown: false })
  }, [open])

  const site = siteLabel || 'its site'

  const leave = useCallback(async () => {
    setPhase('working')
    setStatus('stopping the owlette service')
    setError(null)
    setResult({ deregistered: true, serviceDown: false })

    const release = onHold()
    leaveLog('started')
    try {
      // 1. Stop the service, elevating if needed. Nothing before this point
      //    changes the machine; everything after does.
      let stopped = false
      try {
        const before = await serviceStatus()
        leaveLog(`service before the stop: ${before.state} (installed=${before.installed})`)
        if (before.installed && (before.running || before.state === 'start_pending')) {
          leaveLog('requesting the service stop')
          const outcome = await serviceStop(true)
          leaveLog(`stop requested via ${outcome.method}, waiting for the scm`)
          if (!(await waitForService('stopped', STOP_TIMEOUT_MS))) {
            throw new Error('the service was still running after 45 seconds')
          }
          stopped = true
          leaveLog('service stopped')
        } else {
          leaveLog('service was already down, nothing to stop')
        }
      } catch (cause) {
        leaveLog(`stop failed: ${message(cause)} — nothing was changed`, 'error')
        setFailure('stop')
        setError(stopReason(message(cause)))
        setPhase('failed')
        return
      }

      // 2. Tear down via the helper — it owns the cloud client and encrypted
      //    token store, which this app deliberately does not. A spawn failure
      //    is reported, never thrown: step 3 must run regardless.
      setStatus('leaving the site')
      leaveLog('spawning the leave helper')
      let outcome: HelperOutcome
      try {
        outcome = await runLeaveHelper((status) => {
          leaveLog(`helper: ${status}`)
          setStatus(status)
        })
      } catch (cause) {
        outcome = { ok: false, deregistered: false, error: message(cause) }
      }
      leaveLog(
        outcome.ok
          ? `helper finished, deregistered=${outcome.deregistered}`
          : `helper failed: ${outcome.error}`,
        outcome.ok ? 'info' : 'error',
      )

      // 3. Restart the service however the teardown went — an unsupervised
      //    machine is worse than one still on a dashboard.
      let serviceDown = false
      if (stopped) {
        setStatus('starting the owlette service')
        leaveLog('starting the service again')
        serviceDown = !(await serviceStart(true)
          .then(() => waitForService('running', START_TIMEOUT_MS))
          .catch(() => false))
        leaveLog(
          serviceDown ? 'the service did not come back up' : 'service running again',
          serviceDown ? 'error' : 'info',
        )
      }

      setResult({ deregistered: outcome.deregistered, serviceDown })
      if (!outcome.ok) {
        setFailure('leave')
        setError(outcome.error)
        setPhase('failed')
        return
      }

      leaveLog('done')
      setPhase('left')
      onLeft()
    } finally {
      release()
    }
  }, [onHold, onLeft])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing would not stop the teardown, so the dialog stays put.
        if (!next && phase !== 'working') onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-testid="leave-site-dialog">
        <DialogHeader>
          <DialogTitle>leave site</DialogTitle>
          <DialogDescription>
            {phase === 'confirm'
              ? `remove this machine from ${site}? the owlette service is stopped while the machine is deregistered, then started again — on older installs windows will ask you to approve that. pairing it again needs a new phrase.`
              : phase === 'left'
                ? leftCopy(site, result)
                : phase === 'failed'
                  ? failedCopy(failure, site, result)
                  : 'this takes a few seconds. the owlette service is stopped while it happens, then started again.'}
          </DialogDescription>
        </DialogHeader>

        {phase === 'failed' && error && (
          <InlineNotice data-testid="leave-error">
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        )}

        {phase === 'working' && (
          <p className="text-sm text-amber-400" data-testid="leave-status">
            {status}…
          </p>
        )}

        <DialogFooter>
          {phase === 'confirm' ? (
            <>
              <Button variant="outline" onClick={onClose}>
                cancel
              </Button>
              <Button variant="destructive" onClick={() => void leave()}>
                leave site
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={phase === 'working'}>
                close
              </Button>
              {/* Retry only after a failed stop — the one failure that wrote nothing. */}
              {phase === 'failed' && failure === 'stop' && (
                <Button variant="destructive" onClick={() => void leave()}>
                  try again
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
