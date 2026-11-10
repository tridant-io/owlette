/**
 * Talon document shapes — the automation primitive (trigger → condition →
 * outputs) at `sites/{siteId}/talons/{talonId}`, runs at
 * `sites/{siteId}/talon_runs/{runId}`.
 *
 * The term is **talon** everywhere — never "action" (`web/lib/actions/` is
 * unrelated) and never "automation".
 *
 * Keep dependency-free (no Firestore imports) so client editor, server store,
 * scheduler and run recorder can all import it without dragging in an SDK.
 */

/**
 * Every shape a Firestore time field can arrive in: admin/client SDK
 * `Timestamp`, `Date`, epoch ms, a `{seconds}` / `{_seconds}` pair from JSON
 * round-tripping, or ISO string. Mirrors `BillingTimestamp` in
 * `@/lib/types/customer` rather than importing it — no cross-domain coupling.
 */
export type TalonTimestamp =
  | Date
  | number
  | string
  | { toMillis: () => number }
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number; _nanoseconds?: number };

/**
 * Redeclared rather than imported from `@/components/DayPillSelector` (that is
 * `'use client'` and would drag React into server importers). Must stay
 * identical to it and to `ScheduleEditor`'s block days.
 */
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Canonical week order — normalized schedule entries are sorted by this. */
export const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Metrics a threshold trigger can watch. MUST stay in sync with `METRIC_PATHS`
 * in `functions/src/metricsHistory.ts` — a metric here without a path there has
 * no history to evaluate; one there but not here is invisible to talons.
 */
export const TALON_METRICS = [
  'cpu_percent',
  'memory_percent',
  'disk_percent',
  'gpu_percent',
  'cpu_temp',
  'gpu_temp',
  'network_latency',
  'network_packet_loss',
] as const;

export type TalonMetric = (typeof TALON_METRICS)[number];

/** Comparison operators available to a threshold trigger. */
export const TALON_OPERATORS = ['>', '<', '>=', '<='] as const;

export type TalonOperator = (typeof TALON_OPERATORS)[number];

/**
 * Closed catalog of subscribable events. Must track the `display_*` events in
 * `@/lib/alerts/displayEventRouting` (snake_case agent form; dotted `display.*`
 * is the webhook wire format, not a subscription key) or talons can never fire.
 *
 * Dispatch paths: `process_crash` / `process_start_failed` / `exe_missing` —
 * agent POSTs `/api/agent/alert`. `machine_offline` — synthesized by the
 * health-check cron (an offline machine cannot report itself).
 * `process_restarted` and all `display_*` — agent writes `sites/{siteId}/logs`,
 * reaching talons via the `onTalonLogEventCreated` trigger, not an http route.
 */
export const TALON_EVENT_TYPES = [
  'process_crash',
  'process_start_failed',
  'process_restarted',
  'exe_missing',
  'machine_offline',
  'display_monitor_removed',
  'display_apply_failed',
  'display_auto_revert_fired',
  'display_sync_lost',
  'display_drift',
  'display_monitor_swapped',
  'display_mosaic_disabled',
  'display_apply_refused_mosaic',
  'display_monitor_added',
  'display_apply_succeeded',
] as const;

export type TalonEventType = (typeof TALON_EVENT_TYPES)[number];

/** Command types a `command` output may queue — strict subset of `ALLOWED_COMMAND_TYPES`. */
export const TALON_COMMAND_TYPES = ['restart_process', 'start_process', 'stop_process'] as const;

export type TalonCommandType = (typeof TALON_COMMAND_TYPES)[number];

/** One fixed clock time on a set of weekdays, e.g. every mon/wed at 09:30. */
export interface TalonScheduleEntry {
  /** Stable client-generated id so editor rows keep identity across edits. */
  id: string;
  days: DayKey[];
  /** 24-hour `HH:MM`, matching what `ScheduleEditor` writes. */
  time: string;
}

/** Fixed clock times. Mutually exclusive with the interval form. */
export interface TalonScheduleEntriesTrigger {
  type: 'schedule';
  entries: TalonScheduleEntry[];
  intervalMinutes?: never;
}

/** Fire every N minutes. Mutually exclusive with the entries form. */
export interface TalonIntervalTrigger {
  type: 'schedule';
  intervalMinutes: number;
  entries?: never;
}

/** Fire when a machine metric crosses a bound. */
export interface TalonThresholdTrigger {
  type: 'threshold';
  metric: TalonMetric;
  operator: TalonOperator;
  value: number;
}

/** Fire when one of the subscribed events lands. */
export interface TalonEventTrigger {
  type: 'event';
  eventTypes: TalonEventType[];
  /**
   * Delay between event and run, 1–1440 min. Absent = run immediately; the
   * validator normalizes an explicit 0 away so no-delay talons persist
   * identically. Event triggers ONLY — schedules carry their own timing and a
   * threshold breach is a level, not an edge.
   *
   * A delayed match is not run inline: the matcher writes a `pending` deferral
   * to `talon_runs` and `/api/cron/talons` fires it once `runAfterAt` passes.
   */
  delayMinutes?: number;
}

export type TalonTrigger =
  | TalonScheduleEntriesTrigger
  | TalonIntervalTrigger
  | TalonThresholdTrigger
  | TalonEventTrigger;

export type TalonTriggerType = TalonTrigger['type'];

/** No gate — the outputs run whenever the trigger fires. */
export interface TalonNoCondition {
  type: 'none';
}

/** Gate the outputs on a vision check of a fresh screenshot. */
export interface TalonVisualCheckCondition {
  type: 'visual_check';
  /** Natural-language statement the screenshot must satisfy. */
  expectation: string;
  /** `capture_screenshot` convention: 0 = all monitors combined, 1 = primary, … */
  monitor?: number;
}

export type TalonCondition = TalonNoCondition | TalonVisualCheckCondition;

export type TalonConditionType = TalonCondition['type'];

/** Notify the site's configured alert recipients. */
export interface TalonEmailOutput {
  type: 'email';
}

/** POST the run payload to an endpoint. Signing secret lives in `talon_secrets`. */
export interface TalonWebhookOutput {
  type: 'webhook';
  url: string;
}

/** Hand a directive to hoot to act on. */
export interface TalonHootOutput {
  type: 'cortex';
  directive: string;
  /**
   * Let the unattended turn reach tier-2 tools instead of read-only tier-1.
   * Absent (default) = read-only; the validator drops an explicit `false` so an
   * opted-out talon has one representation. Authoring is site-admin only,
   * gated in `store.server.ts` alongside the `command` output gate. Tier 3 stays
   * unreachable on this path regardless — see `hootOutput.server`.
   */
  allowActions?: boolean;
}

/** Queue a process-control command against the machines in scope. */
export interface TalonCommandOutput {
  type: 'command';
  commandType: TalonCommandType;
  processId?: string;
  processName?: string;
}

export type TalonOutput =
  | TalonEmailOutput
  | TalonWebhookOutput
  | TalonHootOutput
  | TalonCommandOutput;

export type TalonOutputType = TalonOutput['type'];

/** Which machines the talon applies to. `null` = every machine in the site. */
export interface TalonScope {
  machineIds: string[] | null;
}

/** How the talon was authored — the UI editor or a hoot conversation. */
export type TalonCreatedVia = 'ui' | 'cortex';

/**
 * `running` → `succeeded`/`failed`/`skipped` is an EXECUTION's lifecycle;
 * `pending` → `fired`/`missed`/`skipped` is a DEFERRAL's (the crumb a delayed
 * event trigger writes while it waits out `delayMinutes`). Both live in
 * `talon_runs`; `missed` means the window closed on either.
 */
export type TalonRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'missed'
  | 'pending'
  | 'fired';

export type TalonOutputStatus = 'sent' | 'failed' | 'skipped';

/**
 * Why the SYSTEM switched a talon off. Absent when an operator paused it — the
 * toggle clears it.
 *
 * The `creator_*` reasons are UNRECOVERABLE (the author can no longer back the
 * run), so they disable on first hit. `repeated_failures` is the transient case,
 * needing `AUTO_DISABLE_AFTER_FAILURES` in a row.
 *
 * Stored as a stable code, never a sentence, so copy changes apply retroactively.
 */
export type TalonDisabledReason =
  | 'creator_not_a_user'
  | 'creator_deleted'
  | 'creator_access_revoked'
  | 'creator_missing_llm_key'
  | 'repeated_failures';

/**
 * The `creator_*` subset — reasons a REASSIGNMENT resolves, re-armed by
 * `reassignTalons`. `repeated_failures` describes the talon, not its author; a
 * human-paused talon carries no reason and must stay paused.
 *
 * A total record, so a new reason cannot be added without choosing a side.
 */
const CREATOR_DISABLED_REASONS: Readonly<Record<TalonDisabledReason, boolean>> = {
  creator_not_a_user: true,
  creator_deleted: true,
  creator_access_revoked: true,
  creator_missing_llm_key: true,
  repeated_failures: false,
};

/** Whether a stored reason is one a reassignment fixes. */
export function isCreatorDisabledReason(
  reason: TalonDisabledReason | undefined | null,
): boolean {
  return reason ? CREATOR_DISABLED_REASONS[reason] === true : false;
}

/**
 * The one place a disable reason becomes words. No count baked into the text —
 * `AUTO_DISABLE_AFTER_FAILURES` is free to change.
 */
export const TALON_DISABLED_REASON_COPY: Readonly<Record<TalonDisabledReason, string>> = {
  creator_not_a_user:
    'nobody owns this talon, so there is no ai key it can run with',
  creator_deleted:
    'the person who created this talon no longer has an account',
  creator_access_revoked:
    'the person who created this talon no longer has whole-site access to this site',
  creator_missing_llm_key:
    'the person who created this talon has no ai key saved in settings → hoot',
  repeated_failures: 'it failed too many times in a row',
};

/** The human sentence for a stored reason, or `null` when it is unrecognized. */
export function describeTalonDisabledReason(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  return TALON_DISABLED_REASON_COPY[reason as TalonDisabledReason] ?? null;
}

/** `sites/{siteId}/talons/{talonId}` */
export interface TalonDoc {
  schemaVersion: 1;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: TalonTrigger;
  condition: TalonCondition;
  outputs: TalonOutput[];
  scope: TalonScope;
  /** Minimum gap between runs. */
  cooldownMinutes: number;
  /** uid of the authoring user. */
  createdBy: string;
  createdVia: TalonCreatedVia;
  /** Set when `createdVia === 'cortex'` — the chat the talon came from. */
  chatId?: string;
  createdAt: TalonTimestamp;
  updatedAt: TalonTimestamp;
  /** Schedule triggers only — when the scheduler should next evaluate. */
  nextRunAt?: TalonTimestamp;
  lastRunAt?: TalonTimestamp;
  lastRunStatus?: TalonRunStatus;
  lastRunId?: string;
  /** Reset to 0 on any successful run; drives auto-disable backoff. */
  consecutiveFailures: number;
  /** SYSTEM-disable only; cleared whenever a human toggles `enabled` either way. */
  disabledReason?: TalonDisabledReason;
}

/** Outcome of the condition gate, recorded on the run. */
export interface TalonRunCondition {
  type: TalonConditionType;
  verdict: 'pass' | 'fail';
  /** Vision-model confidence, 0–1, when the condition produced one. */
  confidence?: number;
  reason?: string;
  /** Storage path of the evaluated screenshot. */
  screenshotPath?: string;
  /** Signed read URL for `screenshotPath`, when one was minted. */
  screenshotUrl?: string;
}

/** Per-output delivery result, recorded on the run. */
export interface TalonRunOutput {
  type: TalonOutputType;
  status: TalonOutputStatus;
  detail?: string;
  /** Webhook outputs only. */
  httpStatus?: number;
  /**
   * Hoot outputs only: online machines a site-wide directive did not reach
   * because hoot is switched off on them (D-A). Without it a fan-out that
   * reached 2 of 5 machines reads on the run exactly like one that reached 5.
   */
  skippedMachineIds?: string[];
  error?: string;
  /**
   * Set when THIS output's failure cost the talon its enabled state — a run can
   * hold several outputs with only one fatal, so this says which was the problem
   * and the run-level field says what it cost.
   */
  disabledReason?: TalonDisabledReason;
}

/**
 * `sites/{siteId}/talon_runs/{runId}`
 *
 * Two document kinds share this shape: an EXECUTION (written `running`, then
 * finalized in place) and a DEFERRAL (written `pending` by the matcher for an
 * event trigger with `delayMinutes`, resolved by the sweep after `runAfterAt`).
 * The `runAfterAt`/`createdAt`/`firedAt`/`firedRunIds` fields are deferral-only.
 *
 * A deferral still stamps `startedAt` (= `createdAt`): run history orders by it
 * and Firestore excludes docs missing an ordered field, so a crumb without it
 * would be invisible on the surface it exists to explain.
 */
export interface TalonRunDoc {
  talonId: string;
  /** Denormalized so the run list renders without a talon lookup. */
  talonName: string;
  triggerType: TalonTriggerType;
  /** Human-readable trigger summary, e.g. `cpu_percent > 90`. */
  triggerSummary: string;
  machineId?: string;
  machineName?: string;
  status: TalonRunStatus;
  startedAt: TalonTimestamp;
  completedAt?: TalonTimestamp;
  durationMs?: number;
  condition?: TalonRunCondition;
  outputs: TalonRunOutput[];
  /** Ties the run to its audit-log entries and downstream commands. */
  correlationId: string;
  chatId?: string;
  error?: string;
  /** Set when this run is the one that disabled the talon. */
  disabledReason?: TalonDisabledReason;
  /** True when an operator ran the talon on demand rather than the trigger firing. */
  manual?: boolean;
  /** Deferral only — the instant the delay expires and the sweep may fire it. */
  runAfterAt?: TalonTimestamp;
  /** Deferral only — when the event landed and the deferral was written. */
  createdAt?: TalonTimestamp;
  /** Deferral only — when the sweep claimed it out of `pending`. */
  firedAt?: TalonTimestamp;
  /** Deferral only — ids of the runs the fire produced, empty when none were. */
  firedRunIds?: string[];
}

/**
 * Something a template needs before its talon can be created. `llm_key` — a
 * visual-check condition or hoot output, which the store refuses unless the
 * author has an llm key. `process_target` — a `command` output whose process id
 * is per-machine and never travels in a template.
 */
export type TalonPresetRequirement = 'llm_key' | 'process_target';

/**
 * The talon-shaped payload a preset carries: the caller-owned half of a talon
 * MINUS `scope` and `enabled`. Machine ids mean nothing in another site (and an
 * empty array is rejected), so a template seeds "every machine"; `enabled` is
 * the instance's own armed/paused state, not the template's call.
 */
export interface TalonPresetTemplate {
  /** Default name for the talon this preset seeds — NOT the preset's own name. */
  name: string;
  description?: string;
  trigger: TalonTrigger;
  condition: TalonCondition;
  outputs: TalonOutput[];
  cooldownMinutes: number;
}

/**
 * `config/{siteId}/talon_presets/{presetId}`
 *
 * Same field vocabulary as the other `config/{siteId}/*_presets` families
 * (`isBuiltIn`/`order`/`createdBy`) so the built-in merge and shared preset
 * routes behave identically. Ids are `talon-{slug}-{epochMs}`, except a built-in
 * override which pins `builtin-{slug}`.
 *
 * The payload is nested under `template`, not flattened: flat fields would
 * collide the preset's own `name`/`description` with the talon's.
 */
export interface TalonPresetDoc {
  name: string;
  description?: string;
  template: TalonPresetTemplate;
  isBuiltIn: boolean;
  order: number;
  createdBy: string;
  createdAt: TalonTimestamp;
  updatedAt?: TalonTimestamp;
}
