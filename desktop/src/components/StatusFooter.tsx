import { Button } from '@/components/ui/button'
import { environmentFromConfig } from '@/lib/environment'
import type { OwletteConfig } from '@/lib/owletteConfig'
import {
  deriveFooterState,
  footerSentence,
  FOOTER_DOT_CLASS,
  FOOTER_TONE_CLASS,
  siteNameOf,
  type ServiceStatusFile,
} from '@/lib/serviceHealth'
import type { ServiceStatus } from '@/lib/ipc'
import { cn } from '@/lib/utils'

interface StatusFooterProps {
  status: ServiceStatus | null
  statusFile: ServiceStatusFile | null
  config: OwletteConfig | null
  /** COMPUTERNAME, shown as-is — machine names keep their real casing. */
  hostname?: string | null
  starting: boolean
  /** True while the app is getting the service up — see `useServiceHealth`. */
  bringingUp?: boolean
  /** The last start was declined for want of an administrator prompt. */
  elevationRequired?: boolean
  /** Last service-command failure. Shown in the tooltip; nothing else surfaces it. */
  error?: string | null
  /** Last SCM poll failure, cleared when polling recovers. */
  scmError?: string | null
  onStart: () => void
  /** Open the pairing dialog. */
  onJoin: () => void
}

/**
 * One sentence saying whether this machine is looked after — "TEC-A4D is
 * connected to TEC" — with the status word carrying the tone colour, and the
 * running SERVICE version (not this app's) on the right, preceded by an
 * environment chip on every owlette but production.
 *
 * At most one call to action, and which one is `deriveFooterState`'s decision
 * rather than this component's: `start service` only when the service is
 * genuinely down, `join site` only when a healthy machine belongs to nothing.
 * Mutually exclusive on purpose — a dead service can't usefully be paired, and
 * two competing buttons in a status line means neither is read.
 *
 * A service merely *coming up* gets neither. Offering to start one that is
 * already starting is what made an ordinary launch read as a fault.
 */
export function StatusFooter({
  status,
  statusFile,
  config,
  hostname,
  starting,
  bringingUp,
  elevationRequired,
  error,
  scmError,
  onStart,
  onJoin,
}: StatusFooterProps) {
  const state = deriveFooterState({ status, statusFile, config, bringingUp, scmError })
  // `detail` was computed and dropped on the floor before this, and a failed
  // start had nowhere at all to appear.
  const detail = [state.detail, error, scmError].filter(Boolean).join(' — ') || undefined
  // Name when the service knows it, id until then: operators know the place as
  // "TEC", not "default_site".
  const site = siteNameOf(config, statusFile)
  const sentence = footerSentence(state, site, hostname ?? null)
  const version = statusFile?.service?.version
  // null on production on purpose: an unbadged footer IS the "this is the real
  // fleet" signal, so the chip only ever appears where a mistake is possible.
  const environment = environmentFromConfig(config)

  return (
    <footer className="flex items-center gap-3 border-t px-4 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-2" data-testid="footer-status" title={detail}>
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', FOOTER_DOT_CLASS[state.tone])}
        />
        <span className="truncate text-muted-foreground">
          {sentence.before}
          <span className={FOOTER_TONE_CLASS[state.tone]}>{state.label}</span>
          {sentence.after}
        </span>
      </span>

      {state.action === 'start' && (
        <>
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2"
            disabled={starting}
            onClick={() => onStart()}
          >
            {starting ? 'starting…' : 'start service'}
          </Button>
          {/* Never disable the button for this — the prompt is the way through. */}
          {elevationRequired && (
            <span
              className="shrink-0 text-muted-foreground"
              title="this machine was set up before owlette could start its service without an administrator prompt"
            >
              needs admin
            </span>
          )}
        </>
      )}

      {/* `disabled` and `removed from site` both mean a healthy machine that
          belongs to nothing; without this button the only way back is a menu a
          new operator has no reason to open. */}
      {state.action === 'join' && (
        <Button size="sm" variant="secondary" className="h-6 px-2" onClick={onJoin}>
          join site
        </Button>
      )}

      <span className="flex-1" />

      {environment && (
        <span
          className="rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap text-amber-400"
          data-testid="footer-environment"
        >
          {environment}
        </span>
      )}

      {version && <span className="text-muted-foreground">v{version}</span>}
    </footer>
  )
}
