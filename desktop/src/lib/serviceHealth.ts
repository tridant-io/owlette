/**
 * The status footer's single source of truth.
 *
 * Three inputs only: SCM state + `tmp/service_status.json` age, that file's
 * contents, and config.json's `firebase` block. Deliberately NOT the encrypted
 * token store the legacy GUI opened — tokens are the service's business, and it
 * already publishes the verdict as `health_probe.STATUS_AUTH_ERROR`.
 */

import { isServiceDown, type ServiceStatus } from '@/lib/ipc'
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
    /**
     * IANA zone the SITE evaluates process launch windows in, published since
     * agent 3.2.3. Empty whenever windows follow this machine's own clock —
     * the site never opted in, opted back out, or has no timezone set — so it
     * is a three-state field collapsed to two on purpose: only a non-empty
     * value may claim a clock other than this machine's.
     */
    schedule_timezone?: string
    last_heartbeat?: number
  }
  /**
   * Live swoop state, published by every agent that carries swoop. `active`
   * is capture running, not the streamer being alive — it goes false the moment the last
   * viewer leaves, while the process lingers for another minute. Written with
   * every count zeroed when swoop is idle or absent, so the shape never
   * depends on whether a session has ever run.
   */
  swoop?: {
    active?: boolean
    viewers?: number
    controllers?: number
    /** Unix seconds capture started; 0 while inactive. */
    since?: number
    /** The site's indicator policy, as the streamer reported it back. */
    indicator?: 'banner' | 'tray' | 'none'
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

export type FooterTone = 'ok' | 'warn' | 'error' | 'muted'

export interface FooterState {
  /** Lowercase copy for the status word. */
  label: string
  tone: FooterTone
  /** Longer explanation, when there is one worth a tooltip. */
  detail: string | null
  /** True while the service is not supervising this machine. */
  serviceDown: boolean
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
 * The clock this site's process launch windows are evaluated in, or `''` for
 * this machine's own clock (plan decision D1 — absent and opted-out are the
 * same legacy behaviour, and scheduled REBOOTS stay machine-local either way).
 *
 * Site-id guarded exactly like `siteNameOf`, and for the same reason: config.json
 * is rewritten first on a join or a leave, so until the service's next status
 * write the file still carries the zone of the site this machine just left.
 * Naming a foreign site's clock on a schedule editor would be worse than the
 * legacy wording, which is always true of the machine in front of the operator.
 */
export function scheduleTimezoneOf(
  config: OwletteConfig | null,
  statusFile: ServiceStatusFile | null,
): string {
  const site = siteIdOf(config, statusFile)
  const published = statusFile?.firebase
  if (published?.schedule_timezone && published.site_id === site) {
    return published.schedule_timezone
  }
  return ''
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
export function deriveFooterState({ status, statusFile, config }: FooterInputs): FooterState {
  // Before the first SCM query, "disconnected" would be a lie that flashes.
  if (!status) {
    return { label: 'checking', tone: 'muted', detail: null, serviceDown: false }
  }

  if (isServiceDown(status)) {
    return {
      label: 'service not running',
      tone: 'error',
      detail: !status.installed
        ? 'OwletteService is not installed on this machine'
        : status.statusFile.stale && status.running
          ? 'the service is running but has not written its status file for over two minutes'
          : 'nothing is supervising this machine right now',
      serviceDown: true,
    }
  }

  const firebase = firebaseSection(config)
  if (config && !firebase.enabled) {
    return {
      label: 'disabled',
      tone: 'muted',
      detail: 'cloud features are turned off in config.json',
      serviceDown: false,
    }
  }

  if (config && !firebase.site_id) {
    return {
      label: 'removed from site',
      tone: 'error',
      detail: 'this machine is no longer assigned to a site',
      serviceDown: false,
    }
  }

  if (statusFile?.firebase?.connected) {
    return { label: 'connected', tone: 'ok', detail: null, serviceDown: false }
  }

  if (statusFile?.health?.error_code === AUTH_ERROR) {
    return {
      label: 'authentication required',
      tone: 'warn',
      detail: statusFile.health?.error_message ?? 'the service could not authenticate with owlette',
      serviceDown: false,
    }
  }

  return {
    label: 'disconnected',
    tone: 'error',
    detail: statusFile?.health?.error_message ?? 'the service is running but not reaching owlette',
    serviceDown: false,
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
      return { before: `${hostname} is `, after: site ? ` to ${site}` : '' }
    case 'disconnected':
      return { before: `${hostname} is `, after: site ? ` from ${site}` : '' }
    case 'service not running':
      return { before: '', after: ` on ${hostname}` }
    case 'removed from site':
      return { before: `${hostname} was `, after: '' }
    case 'authentication required':
      return { before: '', after: ` for ${hostname}` }
    default:
      // "checking" and "disabled" say everything by themselves.
      return { before: '', after: '' }
  }
}

/** `logs/update_in_progress.json`, written by `update_owlette` before the
 *  installer task is spawned and removed by `_check_update_status` afterwards. */
export interface UpdateMarker {
  /** Local time, `YYYY-MM-DD HH:MM:SS` — the format the service writes. */
  started_at?: string
  [key: string]: unknown
}

/** Path of the marker, relative to the owlette data root. */
export const UPDATE_MARKER_PATH = 'logs/update_in_progress.json'

/**
 * Past this age the marker is debris from a failed update, not a live one —
 * the same ten minutes `update_owlette` uses before overriding a stale marker.
 */
const UPDATE_MARKER_FRESH_MS = 10 * 60 * 1000

/**
 * Whether a self-update owns the service right now. While it does, nothing in
 * this app may start the service: the installer stops it on purpose, restarts
 * it itself, and has a watchdog for the failure case — a start from here races
 * the file replacement at best and raises a UAC prompt at worst.
 */
export function isUpdateInProgress(marker: UpdateMarker | null, nowMs: number): boolean {
  const startedAt = marker?.started_at
  if (typeof startedAt !== 'string') return false
  const started = Date.parse(startedAt.replace(' ', 'T'))
  if (Number.isNaN(started)) return false
  const age = nowMs - started
  return age >= 0 && age < UPDATE_MARKER_FRESH_MS
}
