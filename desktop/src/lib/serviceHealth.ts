/**
 * The status footer's single source of truth.
 *
 * Three inputs only: SCM state + `tmp/service_status.json` age, that file's
 * contents, and config.json's `firebase` block. Deliberately NOT the encrypted
 * token store the legacy GUI opened — tokens are the service's business, and it
 * already publishes the verdict as `health_probe.STATUS_AUTH_ERROR`.
 */

import { type ServiceStatus } from '@/lib/ipc'
import type { OwletteConfig } from '@/lib/owletteConfig'

/** `tmp/service_status.json`, as written by `owlette_service._write_service_status`. */
export interface ServiceStatusFile {
  service?: {
    running?: boolean
    last_update?: number
    version?: string
  }
  firebase?: {
    enabled?: boolean
    connected?: boolean
    site_id?: string
    /**
     * Display name from `sites/{site_id}`. Empty whenever the service could not
     * read it (old agent, never connected, token without site read), so it is
     * never the only thing a surface can say about the site.
     */
    site_name?: string
    last_heartbeat?: number
  }
  health?: {
    status?: string
    error_code?: string | null
    error_message?: string | null
    checked_at?: number
    probe_results?: Record<string, boolean>
  }
  [key: string]: unknown
}

/**
 * What the status word and its dot are coloured by. One meaning each:
 *
 * - `ok` (green) — owlette is doing its job.
 * - `warn` (yellow) — in transit, or waiting on the operator. Nothing is broken,
 *   but it is not finished either, so the eye should land on it.
 * - `error` (red) — something is wrong that nobody chose.
 * - `muted` (grey) — off, on purpose, or not known yet. Not an alarm.
 */
export type FooterTone = 'ok' | 'warn' | 'error' | 'muted'

/** The one call to action the footer may offer. `none` is the common case. */
export type FooterAction = 'start' | 'join' | 'none'

export interface FooterState {
  /** Lowercase copy for the status word. */
  label: string
  tone: FooterTone
  /** Longer explanation, when there is one worth a tooltip. */
  detail: string | null
  /** True while the service is not supervising this machine. */
  serviceDown: boolean
  /**
   * Decided here rather than in the footer, so "is there anything to press" is
   * answered in the same place as "what is going on" and the two cannot drift.
   */
  action: FooterAction
}

/**
 * Where the service is in its lifecycle.
 *
 * This is the distinction the footer used to be missing. `isServiceDown` folds
 * "not running *yet*" into "not running", so a service coming up perfectly
 * normally was announced as an unsupervised machine with a button offering to
 * fix it — for the ten-odd seconds between the SCM reporting RUNNING and the
 * agent publishing its first status. Anything in transit is `starting` or
 * `stopping`: states with nothing wrong and nothing for the operator to do.
 */
export type ServiceLifecycle =
  | 'unknown'
  | 'not_installed'
  | 'starting'
  | 'stopping'
  | 'running'
  | 'stopped'
  | 'crashed'
  | 'wedged'

export function serviceLifecycle(status: ServiceStatus | null): ServiceLifecycle {
  if (!status) return 'unknown'
  if (!status.installed) return 'not_installed'

  switch (status.state) {
    case 'start_pending':
    case 'continue_pending':
      return 'starting'
    case 'stop_pending':
      return 'stopping'
    case 'running':
      // The SCM says RUNNING as soon as owlette-host is up, which is well before
      // the agent it supervises has finished booting and written its first
      // status file. Until that lands the file on disk is the *previous* run's,
      // and therefore stale — which is wedged, unless the caller says a start is
      // in progress.
      //
      // KNOWN, DELIBERATE DIVERGENCE from the tray. `tray.rs::determine_status`
      // maps a stale file straight to Error/"not responding", locked by
      // `a_service_that_stopped_publishing_is_not_reported_as_starting` — it has
      // no memory of transitions, so it cannot tell a watched start from an
      // agent that went quiet, and for the icon that is the safer default.
      // Teaching the tray the same rule is the fix; it belongs in its own change,
      // with its own pass over that test.
      return status.statusFile.stale ? 'wedged' : 'running'
    default:
      // A quit and a crash both land the SCM on STOPPED. `stoppedCleanly` is the
      // only thing that separates them, and painting a crash-looping agent the
      // same calm grey as a deliberate quit is exactly the wrong way round.
      return status.stoppedCleanly === false ? 'crashed' : 'stopped'
  }
}

/**
 * What to call a down service. `not responding` is deliberately the same phrase
 * the tray already uses for a stale status file (`tray.rs::determine_status`),
 * so the two surfaces name the same condition the same way.
 */
const DOWN_LABEL: Partial<Record<ServiceLifecycle, string>> = {
  stopped: 'stopped',
  crashed: 'stopped unexpectedly',
  wedged: 'not responding',
  not_installed: 'not installed',
}

/** Why a down service is down, in the words the footer's tooltip uses. */
function downServiceDetail(lifecycle: ServiceLifecycle): string {
  switch (lifecycle) {
    case 'not_installed':
      return 'OwletteService is not installed on this machine'
    case 'crashed':
      return 'the service exited on its own — check the agent log. windows retries three times before giving up'
    case 'wedged':
      return 'the service is running but has not written its status file for over two minutes'
    default:
      return 'nothing is supervising this machine right now'
  }
}

export const FOOTER_TONE_CLASS: Record<FooterTone, string> = {
  ok: 'text-green-500',
  warn: 'text-amber-400',
  error: 'text-red-400',
  muted: 'text-muted-foreground',
}

export const FOOTER_DOT_CLASS: Record<FooterTone, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  muted: 'bg-muted-foreground/60',
}

/** The `health.error_code` the service writes when the token store will not authenticate. */
const AUTH_ERROR = 'auth_error'

export interface FooterInputs {
  /** SCM state + status-file freshness, or null before the first query lands. */
  status: ServiceStatus | null
  /** Parsed `service_status.json`, or null when it could not be read. */
  statusFile: ServiceStatusFile | null
  /** Parsed `config.json`, or null before the first read lands. */
  config: OwletteConfig | null
  /**
   * True while the app is getting the service up — see
   * `useServiceHealth`'s `bringingUp`. Defaults to "nobody is doing anything
   * about it", which is what makes the `start service` button appear.
   */
  bringingUp?: boolean
  /** Last SCM poll failure, so a query that is failing is not read as pending. */
  scmError?: string | null
}

/** The `firebase` block of config.json, as far as any surface here reads it. */
export interface FirebaseSection {
  enabled?: boolean
  site_id?: string
  /** Base URL of the owlette deployment the service talks to. */
  api_base?: string
}

/** `config.firebase` narrowed to an object — `{}` when it is missing or not one. */
export function firebaseSection(config: OwletteConfig | null): FirebaseSection {
  const section = config?.firebase
  return section && typeof section === 'object' ? (section as FirebaseSection) : {}
}

/** The site this machine belongs to, config first — it is what the service reads. */
export function siteIdOf(config: OwletteConfig | null, statusFile: ServiceStatusFile | null): string {
  return firebaseSection(config).site_id || statusFile?.firebase?.site_id || ''
}

/**
 * On-screen site: the service-published display name, else the id.
 *
 * The name is only used when its `site_id` matches the current one. Between a
 * join/leave and the next status write they disagree (config.json is rewritten
 * first) and a stale name would name the site this machine just left.
 */
export function siteNameOf(
  config: OwletteConfig | null,
  statusFile: ServiceStatusFile | null,
): string {
  const site = siteIdOf(config, statusFile)
  const published = statusFile?.firebase
  if (published?.site_name && published.site_id === site) return published.site_name
  return site
}

/**
 * Whether this machine belongs to a site. Read from `config.json`, not the
 * status file — the config is what the service acts on and what join/leave
 * rewrite. Null before the first read so no affordance flashes on startup.
 */
export function isPaired(config: OwletteConfig | null): boolean | null {
  if (!config) return null
  const firebase = firebaseSection(config)
  return Boolean(firebase.enabled && firebase.site_id)
}

/**
 * Resolve the footer's state. ORDER MATTERS: a stopped service — or one whose
 * status file is over two minutes stale, which the tray also treats as stopped —
 * outranks every cloud check, or a green light shows on an unsupervised machine.
 */
export function deriveFooterState({
  status,
  statusFile,
  config,
  bringingUp = false,
  scmError = null,
}: FooterInputs): FooterState {
  // Before the first SCM query, "disconnected" would be a lie that flashes.
  if (!status) {
    // ...but "checking" forever is its own lie. When the query is failing rather
    // than pending, say so: grey is right for "we cannot tell", the word was not.
    if (scmError) {
      return {
        label: 'service manager unreachable',
        tone: 'muted',
        detail: scmError,
        serviceDown: false,
        action: 'none',
      }
    }
    return { label: 'checking', tone: 'muted', detail: null, serviceDown: false, action: 'none' }
  }

  const lifecycle = serviceLifecycle(status)

  if (lifecycle === 'stopping') {
    return {
      label: 'stopping',
      tone: 'warn',
      detail: 'the owlette service is stopping',
      serviceDown: false,
      action: 'none',
    }
  }

  // One state for the whole bring-up, and no button anywhere in it.
  //
  // The operator does not care which of the four phases it is in — a start about
  // to be issued, one in flight, the SCM's own StartPending, or the agent behind
  // it still booting and reaching the cloud. They are all "wait a moment", and
  // splitting them apart is what produced a red "service not running" and a
  // `start service` button during an ordinary launch. `not_installed` is
  // excluded: nothing is coming up on a machine with no service on it.
  if (lifecycle !== 'not_installed' && (bringingUp || lifecycle === 'starting')) {
    return {
      // The ellipsis is doing real work. `connecting` and `connected` differ by
      // three characters mid-word at 12px, and amber-400 and green-500 collapse
      // to the same olive under red-green colour deficiency — so for ~8% of male
      // operators the dot and the word would both be uninformative. An ellipsis
      // survives every colour filter and independently reads as "in progress".
      label: 'connecting…',
      tone: 'warn',
      detail: 'the owlette service is starting — this takes a few seconds',
      serviceDown: false,
      action: 'none',
    }
  }

  // Genuinely down, with nobody doing anything about it. This is the one place
  // the button belongs — but the three ways to get here do not mean the same
  // thing, and colouring them alike made a machine somebody deliberately quit
  // look identical to one that had failed.
  if (lifecycle !== 'running') {
    return {
      // `stopped` is a choice someone made, and the button beside it is how it
      // is undone: grey, not red. `not responding` and `not installed` are
      // faults nobody asked for.
      label: DOWN_LABEL[lifecycle] ?? 'stopped',
      tone: lifecycle === 'stopped' ? 'muted' : 'error',
      detail: downServiceDetail(lifecycle),
      serviceDown: true,
      action: 'start',
    }
  }

  // Past here the service is up and publishing, so `join site` is the only
  // action that can make sense — and only when this machine belongs to nothing.
  const join: FooterAction = isPaired(config) === false ? 'join' : 'none'

  const firebase = firebaseSection(config)

  // No site. A fresh install, a local `leave site`, and an admin removing the
  // machine on the dashboard all write the SAME thing to config.json — enabled
  // false and an empty site_id (configure_site.py, firebase_client.py's 403/404
  // handler) — so nothing here can tell them apart and the copy must not
  // pretend otherwise.
  //
  // This replaces two states. `disabled` claimed "cloud features are turned off
  // in config.json", which blamed a local setting for what is usually a remote
  // action. `removed from site` needed enabled=true with an empty site_id — a
  // pair no writer in the product ever produces, so it was unreachable outside
  // its own test fixture, and the real removal landed on `disabled`.
  if (config && !firebase.site_id) {
    return {
      label: 'not paired',
      tone: 'muted',
      detail: 'this machine does not belong to a site — use join site to pair it',
      serviceDown: false,
      action: join,
    }
  }

  // Assigned to a site, but the cloud is switched off locally. Reachable only by
  // hand-editing config.json, and worth saying plainly when it happens.
  if (config && !firebase.enabled) {
    return {
      label: 'cloud disabled',
      tone: 'muted',
      detail: 'cloud features are turned off in config.json',
      serviceDown: false,
      action: join,
    }
  }

  if (statusFile?.firebase?.connected) {
    return { label: 'connected', tone: 'ok', detail: null, serviceDown: false, action: join }
  }

  if (statusFile?.health?.error_code === AUTH_ERROR) {
    return {
      label: 'authentication required',
      tone: 'warn',
      detail: statusFile.health?.error_message ?? 'the service could not authenticate with owlette',
      serviceDown: false,
      action: join,
    }
  }

  return {
    label: 'disconnected',
    tone: 'error',
    detail: statusFile?.health?.error_message ?? 'the service is running but not reaching owlette',
    serviceDown: false,
    action: join,
  }
}

export interface FooterSentence {
  /** Muted text before the status word ("TEC-A4D is "). Empty when none. */
  before: string
  /** Muted text after the status word (" to TEC"). Empty when none. */
  after: string
}

/**
 * Muted glue around the footer's status word: "TEC-A4D is [connected] to TEC".
 * Only the surrounding words — the status word keeps its tone colour. States
 * that don't fit a sentence get the bare word; before the hostname is known the
 * site is appended as a segment rather than faking a subject.
 */
export function footerSentence(state: FooterState, site: string, hostname: string | null): FooterSentence {
  if (!hostname) {
    return { before: '', after: site ? ` · ${site}` : '' }
  }
  switch (state.label) {
    case 'connected':
    case 'connecting…':
      return { before: `${hostname} is `, after: site ? ` to ${site}` : '' }
    case 'disconnected':
      return { before: `${hostname} is `, after: site ? ` from ${site}` : '' }
    case 'stopped':
    case 'stopped unexpectedly':
    case 'not responding':
    case 'not installed':
    case 'stopping':
      return { before: '', after: ` on ${hostname}` }
    case 'not paired':
      return { before: `${hostname} is `, after: '' }
    case 'authentication required':
      return { before: '', after: ` for ${hostname}` }
    default:
      // "checking" and "disabled" say everything by themselves.
      return { before: '', after: '' }
  }
}
