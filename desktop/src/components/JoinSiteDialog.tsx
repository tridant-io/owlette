import { Check, Copy, ExternalLink } from 'lucide-react'
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
import {
  startAgentRun,
  openExternalUrl,
  type AgentRun,
  type PairPhrase,
} from '@/lib/agentCli'
import { copyText } from '@/lib/clipboard'
import { environmentToken, hostForServer, hostOf } from '@/lib/environment'

interface JoinSiteDialogProps {
  open: boolean
  /**
   * Which server to pair against, when the installer asked for this dialog.
   * Omitted (the tray/menu path) = the environment the config is already bound
   * to.
   */
  server?: 'dev' | 'prod'
  /** Closes the dialog. Any run still in flight is cancelled first. */
  onClose: () => void
  /**
   * Called on success with the joined site's id — an id, not a label: the
   * display name is unknown here until the service connects and publishes it.
   * Treat it as a signal, never as copy.
   */
  onJoined: (siteId: string) => void
  /**
   * Whether the service is currently reaching owlette. Read only after pairing,
   * to settle the "restarting" line onto a real outcome — an operator must never
   * be left watching a progress sentence that can no longer change.
   */
  serviceConnected?: boolean
}

type Phase = 'starting' | 'waiting' | 'joined' | 'failed'

/**
 * How long to wait for the restarted service to report a connection before
 * telling the operator to intervene. Generous: a cold Firebase init on a slow
 * machine is seconds, and the service re-reads its config every other 5 s loop.
 */
const SERVICE_SETTLE_TIMEOUT_MS = 45_000

/**
 * Device-code pairing, driven by `configure_site.py --json-progress`: it
 * streams the phrase as soon as the server issues it, then polls until someone
 * approves. Cancel kills the helper and lets the code expire server-side, as
 * the legacy GUI's Cancel did.
 *
 * No token handling here — the helper writes `.tokens.enc` and restarts the
 * service; this window only watches. Off windows the pairing is the daemon's
 * own run (`src-tauri/src/seam.rs`): cancel asks it to end the run, and the
 * service takes the new site up without a restart.
 */
export function JoinSiteDialog({ open, server, serviceConnected, onClose, onJoined }: JoinSiteDialogProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const [phrase, setPhrase] = useState<PairPhrase | null>(null)
  const [status, setStatus] = useState('requesting a pairing phrase')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** True between "paired" and the service coming back; drives the settle effect. */
  const [awaitingService, setAwaitingService] = useState(false)

  const run = useRef<AgentRun | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // In a ref so an inline parent callback can't re-run the effect and start a
  // second pairing attempt.
  const joined = useRef(onJoined)
  joined.current = onJoined

  useEffect(() => {
    if (!open) return

    let disposed = false
    // Set by a terminal event; the exit handler only invents a failure if unset.
    let settled = false

    setPhase('starting')
    setPhrase(null)
    setStatus('requesting a pairing phrase')
    setError(null)
    setCopied(false)
    setAwaitingService(false)

    void startAgentRun('join', {
      server,
      onEvent: (event) => {
        if (disposed) return
        switch (event.event) {
          case 'phrase':
            setPhrase(event.value)
            setPhase('waiting')
            return
          case 'status':
            setStatus(event.value)
            return
          case 'authorized':
            settled = true
            setPhase('joined')
            setAwaitingService(!!event.value.serviceRestarted)
            setStatus(
              event.value.serviceRestarted
                ? 'paired — the service is restarting'
                : // No restart needed: the running service re-reads the firebase
                  // config every second main-loop iteration and re-initialises
                  // its client on the false → true transition, so the machine
                  // shows up within ~10s on its own.
                  'paired — this machine will appear on your dashboard shortly',
            )
            joined.current(event.value.siteId)
            return
          case 'error':
            settled = true
            setPhase('failed')
            setError(event.value)
            return
          default:
            return
        }
      },
    })
      .then((started) => {
        run.current = started
        if (disposed) void started.cancel()
        return started.completed
      })
      .then((outcome) => {
        // A helper dying without an error event still has to close "waiting".
        if (disposed || settled) return
        setPhase('failed')
        setError(outcome.stderr.trim() || 'the pairing helper stopped unexpectedly')
      })
      .catch((cause: unknown) => {
        if (disposed) return
        settled = true
        setPhase('failed')
        setError(cause instanceof Error ? cause.message : String(cause))
      })

    return () => {
      disposed = true
      void run.current?.cancel()
      run.current = null
    }
    // `server` restarts the run: a different cloud is a different phrase, so
    // reusing the one already in flight would pair against the wrong one.
  }, [open, server])

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  /**
   * Settle the post-pair line. `serviceRestarted` is true at the instant the
   * helper stopped and started the service, and then goes stale — it left the
   * operator watching "restarting" forever with nothing able to change it.
   * Resolve it onto what actually happened, and give up after a bounded wait
   * rather than never.
   */
  useEffect(() => {
    if (!awaitingService) return

    if (serviceConnected) {
      setAwaitingService(false)
      setStatus('paired — the service is running')
      return
    }

    const timer = setTimeout(() => {
      setAwaitingService(false)
      setStatus('paired — the service has not come back yet. restart it from the tray menu.')
    }, SERVICE_SETTLE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [awaitingService, serviceConnected])

  const handleCopy = useCallback(() => {
    if (!phrase) return
    void copyText(phrase.pairPhrase).then((ok) => {
      setCopied(ok)
      if (!ok) return
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [phrase])

  const handleOpen = useCallback(() => {
    const url = phrase?.pairingUrl || phrase?.verificationUri
    if (!url) return
    void openExternalUrl(url).catch(() => {
      setError('could not open a browser on this machine — use the phrase from another device')
    })
  }, [phrase])

  // Read the host off the URLs the server minted rather than off the `server`
  // prop: `web/app/api/agent/auth/device-code/route.ts` builds them from the
  // request's own Host header, so they name the deployment that actually
  // answered — if that is not the one we asked for, the operator sees it.
  // Before the phrase lands (`pairingUrl` defaults to '') the requested server
  // is the best available answer, and with neither we name no host at all.
  const host = hostOf(phrase?.pairingUrl) || hostOf(phrase?.verificationUri) || hostForServer(server)
  const environment = environmentToken(host)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="join-site-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>join a site</DialogTitle>
            {environment && (
              <span
                data-testid="join-environment"
                className="rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap text-amber-400"
              >
                {environment}
              </span>
            )}
          </div>
          <DialogDescription>
            {/* Once paired, the approve instruction is a stale next step — it
                sends the operator back to a page they no longer need. Say where
                the machine went instead. */}
            {phase === 'joined' ? (
              host ? (
                <>
                  it will appear on your dashboard at <span className="font-mono">{host}</span>{' '}
                  shortly.
                </>
              ) : (
                'it will appear on your dashboard shortly.'
              )
            ) : host ? (
              <>
                approve this machine at <span className="font-mono">{host}/add</span> — from here or
                from any other device.
              </>
            ) : (
              'approve this machine from here or from any other device.'
            )}
          </DialogDescription>
        </DialogHeader>

        {phase === 'failed' && error ? (
          <InlineNotice data-testid="join-error">
            <p className="text-sm">pairing failed</p>
            <p className="font-mono text-xs text-muted-foreground">{error}</p>
          </InlineNotice>
        ) : phase === 'joined' ? (
          <p className="text-sm text-green-500" data-testid="join-status">
            {status}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              disabled={!phrase}
              onClick={handleCopy}
              data-testid="join-phrase"
              className="btn-sweep flex items-center justify-center gap-2 rounded-md border bg-secondary px-4 py-4 font-mono text-xl font-semibold tracking-tight text-primary disabled:opacity-60"
            >
              {phrase?.pairPhrase ?? '…'}
              {phrase &&
                (copied ? (
                  <Check className="size-4 text-green-500" />
                ) : (
                  <Copy className="size-4 text-muted-foreground" />
                ))}
            </button>
            <p className="text-center text-xs text-muted-foreground">
              {phrase ? (copied ? 'copied to clipboard' : 'click to copy') : 'asking owlette…'}
            </p>
            <p className="text-center text-sm text-amber-400" data-testid="join-status">
              {status}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {phase === 'joined' || phase === 'failed' ? 'close' : 'cancel'}
          </Button>
          {phase === 'waiting' && (
            <Button onClick={handleOpen} disabled={!phrase?.pairingUrl && !phrase?.verificationUri}>
              <ExternalLink className="size-4" />
              {host ? `open ${host}/add` : 'open pairing page'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
