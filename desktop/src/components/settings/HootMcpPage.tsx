import { Check, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { openExternalUrl } from '@/lib/agentCli'
import { copyText } from '@/lib/clipboard'
import { HOOT_MCP_DOCS_URL, hootCommandLine } from '@/lib/hootMcp'
import {
  fleetState,
  hootTools,
  onHootToolsSynced,
  setHootTool,
  type FleetState,
  type HootTool,
} from '@/lib/ipc'
import { SettingsRow } from './SettingsRow'

/** How often the page asks again what the service knows; the host's own poll is the same. */
const REFRESH_MS = 10_000

const TIER_NAMES: Record<number, string> = { 1: 'read', 2: 'bounded changes', 3: 'privileged' }

function machinesText(state: FleetState): string {
  if (state.wholeSite) return 'the whole site'
  return state.machineIds.length > 0 ? state.machineIds.join(', ') : 'no machines'
}

function openLink(url: string, what: string) {
  void openExternalUrl(url).catch((cause: unknown) => {
    toast.error(`could not open ${what}`, {
      description: cause instanceof Error ? cause.message : String(cause),
    })
  })
}

/**
 * Whether ai tools on this computer may act on the other machines of the site.
 *
 * The switch only asks: turning it on asks a site admin (App confirms and
 * opens the admin panel), and the grant itself arrives from the admin panel
 * through the service's state file, which this page re-reads. `pending` is
 * App's: it asked and has not yet seen the grant. Under the switch: how far and
 * on which machines the admin allowed, then, allowed or not, the tools the app
 * adds hoot to and the command for any other tool. hoot tells a tool on a
 * machine not allowed why and where to allow it.
 */
export function HootMcpPage({
  command,
  paired,
  siteName,
  pending,
  onTurnOn,
  onTurnOff,
}: {
  command: string[]
  paired: boolean
  siteName: string | null
  pending: boolean
  onTurnOn: () => void
  onTurnOff: () => void
}) {
  const [state, setState] = useState<FleetState | null>(null)
  const [tools, setTools] = useState<HootTool[] | null>(null)

  const read = useCallback(() => {
    void fleetState()
      .then(setState)
      .catch(() => {
        // no bridge: the page keeps waiting for the service
      })
    void hootTools()
      .then(setTools)
      .catch(() => {})
  }, [])

  useEffect(() => {
    read()
    const timer = window.setInterval(read, REFRESH_MS)
    window.addEventListener('focus', read)
    let unlisten: (() => void) | undefined
    let disposed = false
    void onHootToolsSynced(read)
      .then((off) => {
        if (disposed) off()
        else unlisten = off
      })
      .catch(() => {})
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', read)
      unlisten?.()
    }
  }, [read])

  const toggleTool = useCallback((tool: HootTool, on: boolean) => {
    void setHootTool(tool.id, on)
      .catch((cause: unknown) => {
        toast.error('could not save that choice', {
          description: cause instanceof Error ? cause.message : String(cause),
        })
      })
      .then(() => hootTools().then(setTools))
      .catch(() => {})
  }, [])

  const granted = state?.granted === true
  const on = granted || pending
  const usable = paired && state !== null

  return (
    <div className="flex flex-col">
      <SettingsRow
        htmlFor="settings-hoot-switch"
        label={`let ai tools on this computer act on other machines in ${siteName ?? 'your site'}`}
      >
        <Switch
          id="settings-hoot-switch"
          checked={paired && on}
          disabled={!usable}
          onCheckedChange={(next) => (next ? onTurnOn() : onTurnOff())}
        />
      </SettingsRow>

      {!paired ? (
        <Status>join a site first.</Status>
      ) : state === null ? (
        <Status>waiting for the owlette service to check with the server.</Status>
      ) : (
        <>
          {granted ? (
            <Grant state={state} />
          ) : pending ? (
            <Status>
              waiting for a site admin to allow it.
              {state.adminUrl && (
                <LinkButton onClick={() => openLink(state.adminUrl!, 'the admin panel')}>
                  open admin panel
                </LinkButton>
              )}
            </Status>
          ) : (
            <Status>
              ai tools on this computer list hoot but can&apos;t act on other machines until a site
              admin allows it. turning this on asks one.
            </Status>
          )}
          <Tools tools={tools} onToggleTool={toggleTool} />
          <CommandBox command={command} />
        </>
      )}

      <div className="border-t py-3">
        <LinkButton onClick={() => openLink(HOOT_MCP_DOCS_URL, 'the guide')}>how it works</LinkButton>
      </div>
    </div>
  )
}

function Status({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 border-t py-3 text-sm text-muted-foreground">
      {children}
    </p>
  )
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="link" className="h-auto p-0" onClick={onClick}>
      {children}
    </Button>
  )
}

function Grant({ state }: { state: FleetState }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t py-3 text-sm">
      <dt className="text-muted-foreground">how far</dt>
      <dd>{state.maxTier === null ? 'not set' : (TIER_NAMES[state.maxTier] ?? 'not set')}</dd>
      <dt className="text-muted-foreground">on which machines</dt>
      <dd className="break-words">{machinesText(state)}</dd>
      {state.adminUrl && (
        <>
          <dt />
          <dd>
            <LinkButton onClick={() => openLink(state.adminUrl!, 'the admin panel')}>
              change in the admin panel
            </LinkButton>
          </dd>
        </>
      )}
    </dl>
  )
}

function Tools({
  tools,
  onToggleTool,
}: {
  tools: HootTool[] | null
  onToggleTool: (tool: HootTool, on: boolean) => void
}) {
  if (!tools) return null
  const found = tools.filter((tool) => tool.found)
  const missing = tools.filter((tool) => !tool.found).map((tool) => tool.label)
  if (found.length === 0) {
    return (
      <Status>
        no ai tools the app knows are on this computer. add hoot to yours with the command below.
      </Status>
    )
  }
  return (
    <div className="flex flex-col gap-2 border-t py-3 text-sm">
      <span className="text-muted-foreground">add hoot to these ai tools on this computer</span>
      {found.map((tool) => (
        <div key={tool.id} className="flex items-center gap-2">
          <Checkbox
            id={`settings-tool-${tool.id}`}
            checked={tool.on}
            onCheckedChange={(next) => onToggleTool(tool, next === true)}
          />
          <Label htmlFor={`settings-tool-${tool.id}`} className="font-normal">
            {tool.label}
          </Label>
        </div>
      ))}
      <span className="text-xs text-muted-foreground">
        restart a tool after a change.
        {missing.length > 0 && ` not found here: ${missing.join(', ')}.`}
      </span>
    </div>
  )
}

function CommandBox({ command }: { command: string[] }) {
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const line = hootCommandLine(command)

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    [],
  )

  const copy = useCallback(() => {
    void copyText(line).then((ok) => {
      setCopied(ok)
      if (!ok) {
        toast.error('could not copy the command', { description: 'select it and copy it by hand.' })
        return
      }
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    })
  }, [line])

  return (
    <div className="flex flex-col gap-1.5 border-t py-3">
      <span className="text-sm text-muted-foreground">
        other ai tools: add a stdio server with this command
      </span>
      <button
        type="button"
        onClick={copy}
        data-testid="hoot-command"
        className="btn-sweep flex items-start justify-between gap-3 rounded-md border bg-card-sunken px-3 py-2.5 text-left font-mono text-xs break-all text-foreground"
      >
        <span>{line}</span>
        {copied ? (
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
        ) : (
          <Copy aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      <p className="text-xs text-muted-foreground" data-testid="hoot-command-state">
        {copied ? 'copied to clipboard' : 'click to copy'}
      </p>
    </div>
  )
}
