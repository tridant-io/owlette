import { useCallback, useEffect, useRef, useState } from 'react'
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
import { Switch } from '@/components/ui/switch'
import { runAgent } from '@/lib/agentCli'
import {
  formatRemaining,
  hasExpired,
  startCountdown,
  tick,
  togglePause,
  type CountdownState,
} from '@/lib/countdown'

interface RestartCountdownProps {
  open: boolean
  /** Dismissed, either by the operator or because the reboot was issued. */
  onClose: () => void
}

/**
 * The reboot prompt, ported from the python one 3.0.0 removed (`prompt_restart.py`).
 *
 * The service relaunches the app with `--restart-prompt` after a process burns through
 * its relaunch budget: two minutes, a pause the operator can hold, restart-now, cancel.
 * Deliberately not dismissable by clicking away or pressing escape — an accidental click
 * must not silently cancel a recovery someone is relying on.
 *
 * Both buttons go through the agent. **restart now** runs `--reboot-now`, which records
 * `owlette_reboot` in `session_state.json` BEFORE issuing the shutdown, so the startup
 * classifier treats the reboot as planned. **cancel** runs `--dismiss-reboot`, clearing
 * the machine's cloud `rebootPending` flag (the same field the dashboard's dismiss
 * command clears). The service's in-memory prompt gate is left alone; it expires
 * RESTART_PROMPT_ACTIVE_SECONDS after the prompt was launched.
 */
export function RestartCountdown({ open, onClose }: RestartCountdownProps) {
  const [state, setState] = useState<CountdownState>(startCountdown)
  const [busy, setBusy] = useState<'restarting' | 'dismissing' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // The reboot must fire exactly once, even if a render lands between the tick
  // that hits zero and the effect that acts on it.
  const fired = useRef(false)

  useEffect(() => {
    if (!open) return
    fired.current = false
    setState(startCountdown())
    setBusy(null)
    setError(null)
  }, [open])

  useEffect(() => {
    if (!open || state.paused || hasExpired(state)) return
    const timer = setInterval(() => setState(tick), 1000)
    return () => clearInterval(timer)
  }, [open, state])

  const restart = useCallback(() => {
    if (fired.current) return
    fired.current = true
    setBusy('restarting')
    setError(null)
    void runAgent('reboot-now')
      .then(() => onClose())
      .catch((cause: unknown) => {
        // The machine is still up, so let the operator try again rather than
        // leaving a dead dialog on screen.
        fired.current = false
        setBusy(null)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [onClose])

  useEffect(() => {
    if (open && hasExpired(state) && !fired.current) restart()
  }, [open, state, restart])

  const dismiss = useCallback(() => {
    setBusy('dismissing')
    setError(null)
    // The window closes either way: the flag is a dashboard nicety, and refusing
    // to let the operator out because the cloud is unreachable would be worse
    // than leaving a stale flag for the service to clear on its next reboot.
    void runAgent('dismiss-reboot')
      .catch(() => {})
      .finally(() => {
        setBusy(null)
        onClose()
      })
  }, [onClose])

  return (
    <Dialog open={open}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        data-testid="restart-countdown"
      >
        <DialogHeader>
          <DialogTitle>a process keeps failing</DialogTitle>
          <DialogDescription>
            owlette could not keep it running. restarting this machine usually recovers it.
          </DialogDescription>
        </DialogHeader>

        <p
          className="text-center font-mono text-4xl font-semibold tabular-nums"
          data-testid="restart-remaining"
        >
          {formatRemaining(state.remaining)}
        </p>
        <p className="text-center text-sm text-muted-foreground">
          {state.paused ? 'countdown paused' : 'restarting automatically'}
        </p>

        {error && (
          <InlineNotice data-testid="restart-error">
            <p className="text-sm">could not restart this machine</p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        )}

        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">pause the countdown</span>
          <Switch
            checked={state.paused}
            disabled={busy !== null}
            data-testid="restart-pause"
            aria-label="pause the countdown"
            onCheckedChange={() => setState(togglePause)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={dismiss} disabled={busy !== null}>
            {busy === 'dismissing' ? 'cancelling…' : 'cancel'}
          </Button>
          <Button variant="destructive" onClick={restart} disabled={busy !== null}>
            {busy === 'restarting' ? 'restarting…' : 'restart now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
