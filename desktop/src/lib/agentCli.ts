/**
 * Run the agent's python helper and read what it says back.
 *
 * Pairing, leaving a site and filing a bug report need the agent's cloud client
 * and encrypted token store, which this app deliberately does not have. The
 * host spawns `agent/src/configure_site.py` (`src-tauri/src/agent_cli.rs`) and
 * forwards every line as an `owlette://agent-cli` event; this module turns that
 * stream into one promise per run. Off windows every mode but `report-issue` is
 * a request the daemon carries out instead (`src-tauri/src/seam.rs`), answered
 * in the same stream.
 *
 * Wire format is one JSON object per line:
 * `{"event": "phrase"|"status"|"authorized"|"done"|"error", "value": …}`.
 * The "Headless modes" section of `configure_site.py` is the other half —
 * change both sides together.
 *
 * `join` may additionally name the cloud it pairs against; the host turns that
 * into `--server dev|prod`, and omitting it keeps the config's current
 * environment. `agent_cli::MODES` in `desktop/src-tauri/src/agent_cli.rs` is
 * the other half of that contract — the mode names and which of them carry a
 * server live there.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Emitted per line and on exit. */
const EVENT_AGENT_CLI = 'owlette://agent-cli'

/** Mirrors `agent_cli::MODES`. */
export type AgentMode = 'join' | 'leave' | 'report-issue' | 'reboot-now' | 'dismiss-reboot'

export interface PairPhrase {
  pairPhrase: string
  /** owlette.app/add with the phrase pre-filled. */
  pairingUrl: string
  verificationUri: string
  /** Seconds until the phrase expires. */
  expiresIn: number
}

export interface Authorized {
  siteId: string
  /**
   * False when the helper couldn't restart the service (needs rights a standard
   * user lacks). Pairing still succeeded, but the machine stays off the
   * dashboard until the service restarts.
   */
  serviceRestarted: boolean
}

export type AgentEvent =
  | { event: 'phrase'; value: PairPhrase }
  | { event: 'status'; value: string }
  | { event: 'authorized'; value: Authorized }
  | { event: 'done'; value: Record<string, unknown> }
  | { event: 'error'; value: string }

/** Run-ending events; exactly one per successful protocol run. */
const TERMINAL_EVENTS = ['authorized', 'done', 'error'] as const

export function isTerminal(event: AgentEvent): boolean {
  return (TERMINAL_EVENTS as readonly string[]).includes(event.event)
}

/** One output line, or the exit. Mirrors `agent_cli::AgentCliEvent`. */
interface AgentCliLine {
  run: string
  stream: 'stdout' | 'stderr' | 'exit'
  line: string | null
  code: number | null
}

/**
 * Parse one stdout line. Malformed input is ignored, never thrown: python can
 * write unsolicited warnings to stdout, and a lost progress line must not fail
 * an otherwise-fine pairing.
 */
export function parseAgentLine(line: string): AgentEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const { event, value } = parsed as { event?: unknown; value?: unknown }

  switch (event) {
    case 'phrase': {
      if (!value || typeof value !== 'object') return null
      const phrase = value as Partial<PairPhrase>
      if (typeof phrase.pairPhrase !== 'string' || !phrase.pairPhrase) return null
      return {
        event: 'phrase',
        value: {
          pairPhrase: phrase.pairPhrase,
          pairingUrl: typeof phrase.pairingUrl === 'string' ? phrase.pairingUrl : '',
          verificationUri:
            typeof phrase.verificationUri === 'string' ? phrase.verificationUri : '',
          expiresIn: typeof phrase.expiresIn === 'number' ? phrase.expiresIn : 600,
        },
      }
    }
    case 'status':
      return typeof value === 'string' ? { event: 'status', value } : null
    case 'authorized': {
      const authorized = (value ?? {}) as { siteId?: unknown; serviceRestarted?: unknown }
      return {
        event: 'authorized',
        value: {
          siteId: typeof authorized.siteId === 'string' ? authorized.siteId : '',
          // Absent means an older helper, which did restart the service.
          serviceRestarted: authorized.serviceRestarted !== false,
        },
      }
    }
    case 'done':
      return {
        event: 'done',
        value: value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
      }
    case 'error':
      return { event: 'error', value: typeof value === 'string' ? value : 'the agent helper failed' }
    default:
      return null
  }
}

export interface AgentRunOutcome {
  /** Exit code; null when the process couldn't be reaped. */
  code: number | null
  /** Last terminal event, or null if the helper died mid-protocol. */
  terminal: AgentEvent | null
  /** Full stderr, for diagnostics nothing else explains. */
  stderr: string
}

export interface AgentRunOptions {
  /** `report-issue` only; every other mode takes none. */
  payload?: unknown
  /** 'join' only: which owlette server to pair against. Omitted = the config's environment. */
  server?: 'dev' | 'prod'
  onEvent?: (event: AgentEvent) => void
}

export interface AgentRun {
  id: string
  /** Resolves however the helper exits. */
  completed: Promise<AgentRunOutcome>
  /** Kill the helper. Safe after it has exited. */
  cancel: () => Promise<void>
}

/**
 * Message for a run that ends without saying why. Non-zero exit with no `error`
 * event means it crashed before its own handler ran (missing interpreter,
 * import error), so the stderr tail is all that's left.
 */
function unexplained(outcome: { code: number | null; stderr: string }): string {
  const tail = outcome.stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n')
  if (tail) return tail
  return `the agent helper exited with code ${outcome.code ?? 'unknown'}`
}

/**
 * Start a run and stream it. The subscription opens BEFORE the spawn and
 * buffers, because the host can emit its first line before `invoke` resolves
 * the run id back to us — pairing emits a status line immediately.
 */
export async function startAgentRun(
  mode: AgentMode,
  options: AgentRunOptions = {},
): Promise<AgentRun> {
  const buffered: AgentCliLine[] = []
  let id: string | null = null
  let settle: ((outcome: AgentRunOutcome) => void) | null = null

  let terminal: AgentEvent | null = null
  let stderr = ''

  const completed = new Promise<AgentRunOutcome>((resolve) => {
    settle = resolve
  })

  const handle = (payload: AgentCliLine) => {
    if (payload.run !== id) return

    if (payload.stream === 'stderr') {
      stderr += `${payload.line ?? ''}\n`
      return
    }

    if (payload.stream === 'exit') {
      void unlisten().finally(() => settle?.({ code: payload.code, terminal, stderr }))
      return
    }

    const event = parseAgentLine(payload.line ?? '')
    if (!event) return
    if (isTerminal(event)) terminal = event
    options.onEvent?.(event)
  }

  let stop: UnlistenFn | null = null
  const unlisten = async () => {
    stop?.()
    stop = null
  }

  stop = await listen<AgentCliLine>(EVENT_AGENT_CLI, (event) => {
    if (id === null) {
      buffered.push(event.payload)
      return
    }
    handle(event.payload)
  })

  try {
    id = await invoke<string>('agent_cli_start', {
      mode,
      payload: options.payload ?? null,
      server: options.server ?? null,
    })
  } catch (cause) {
    await unlisten()
    throw cause
  }

  // Drain what arrived while the id was in flight, in order.
  for (const payload of buffered.splice(0)) handle(payload)

  return {
    id,
    completed,
    cancel: async () => {
      try {
        await invoke<boolean>('agent_cli_cancel', { run: id })
      } catch {
        // Already finished; the exit event settles the promise.
      }
    },
  }
}

/**
 * Run a mode to completion, rejecting with something worth showing. For modes
 * with no progress to render — leave, report-issue, dismiss-reboot.
 */
export async function runAgent(
  mode: AgentMode,
  options: AgentRunOptions = {},
): Promise<AgentRunOutcome> {
  const run = await startAgentRun(mode, options)
  const outcome = await run.completed

  if (outcome.terminal?.event === 'error') throw new Error(outcome.terminal.value)
  if (outcome.terminal === null || outcome.code !== 0) throw new Error(unexplained(outcome))
  return outcome
}

/** Open a path inside the owlette tree with its default handler. */
export function openOwlettePath(path: string): Promise<void> {
  return invoke<void>('open_owlette_path', { path })
}

/** Open an `http(s)` link in the default browser. */
export function openExternalUrl(url: string): Promise<void> {
  return invoke<void>('open_external_url', { url })
}
