'use client';

/**
 * Stage 1 of the talon pipeline — WHEN the talon fires.
 *
 * Owns `TriggerDraft` and the conversions to/from the wire form, so the dialog
 * needn't know an interval is edited as number + unit but persists as flat
 * minutes. The draft keeps every branch alive at once: schedule -> threshold ->
 * schedule must not discard the entries the user already built.
 *
 * Deliberately lenient (numbers as strings) because `validateTalonInput` is the
 * single rule set. This card never re-implements a bound; it renders the
 * validator's message next to the field that earned it.
 */

import { Info, Plus, Trash2 } from 'lucide-react';

import DayPillSelector from '@/components/DayPillSelector';
import { TimePicker } from '@/components/ScheduleEditor';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/contexts/AuthContext';
import {
  DAY_KEYS,
  TALON_EVENT_TYPES,
  TALON_METRICS,
  TALON_OPERATORS,
  type DayKey,
  type TalonEventType,
  type TalonMetric,
  type TalonOperator,
  type TalonScheduleEntry,
  type TalonTrigger,
  type TalonTriggerType,
} from '@/lib/talons/types';
import { TALON_MAX_DELAY_MINUTES } from '@/lib/talons/validation';

/**
 * Tooltip copy per event type. Wording matches DISPLAY_EVENT_LABEL in
 * emailTemplates.server.ts so UI and alert emails say the same thing. Keyed
 * exhaustively — a new catalog entry without a description fails the build.
 */
const TALON_EVENT_INFO: Record<TalonEventType, string> = {
  process_crash: 'a managed process crashed or exited with an error — not a clean exit, and not stopped by an operator or a schedule',
  process_start_failed: 'owlette tried to launch a process and it failed to start',
  process_restarted: 'a process came back up — via recovery, a schedule, or an operator restart',
  exe_missing: 'a process executable no longer exists at its configured path',
  machine_offline:
    'a machine stopped heartbeating and was confirmed offline — detection takes roughly 10–17 minutes',
  display_monitor_removed: 'monitor removed — a connected display disappeared from the machine',
  display_apply_failed: 'display apply failed — a saved layout could not be applied',
  display_auto_revert_fired:
    'display auto-reverted — an applied layout rolled back before it was confirmed',
  display_sync_lost: 'display sync lost — the machine lost its sync/framelock signal',
  display_drift: 'display drift detected — the live topology no longer matches the saved layout',
  display_monitor_swapped: 'monitor swapped — a display was replaced by different hardware',
  display_mosaic_disabled: 'nvidia mosaic disabled on a machine that expects it',
  display_apply_refused_mosaic: 'display apply refused — nvidia mosaic controls this topology',
  display_monitor_added: 'monitor added — a new display was connected',
  display_apply_succeeded: 'display apply succeeded — a saved layout applied cleanly',
};

export type ScheduleMode = 'entries' | 'interval';

export interface TriggerDraft {
  type: TalonTriggerType;
  scheduleMode: ScheduleMode;
  entries: TalonScheduleEntry[];
  /** Raw text — parsed on submit so a half-typed number never snaps back. */
  intervalValue: string;
  intervalUnit: 'minutes' | 'hours';
  metric: TalonMetric;
  operator: TalonOperator;
  value: string;
  eventTypes: TalonEventType[];
  /** Raw text, same reason as `intervalValue`. `''` and `'0'` both mean no wait. */
  delayValue: string;
}

/**
 * Local by design: the canonical `METRIC_LABELS` lives in
 * `@/lib/emailTemplates.server`, which pulls in the Resend client — importing
 * it here would drag server-only code into the client bundle. Exhaustively
 * keyed, so a new `TALON_METRICS` entry fails the build until labelled.
 */
const METRIC_META: Record<TalonMetric, { label: string; unit: string }> = {
  cpu_percent: { label: 'CPU usage', unit: '%' },
  memory_percent: { label: 'memory usage', unit: '%' },
  disk_percent: { label: 'disk usage', unit: '%' },
  gpu_percent: { label: 'GPU usage', unit: '%' },
  cpu_temp: { label: 'CPU temperature', unit: '°C' },
  gpu_temp: { label: 'GPU temperature', unit: '°C' },
  network_latency: { label: 'network latency', unit: 'ms' },
  network_packet_loss: { label: 'packet loss', unit: '%' },
};

const TRIGGER_TYPE_LABELS: Record<TalonTriggerType, string> = {
  schedule: 'on a schedule',
  threshold: 'when a metric crosses',
  event: 'when an event happens',
};

const DEFAULT_ENTRY_DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DEFAULT_ENTRY_TIME = '09:00';

/** `crypto.randomUUID` needs a secure context; the fallback keeps the editor
 * working on plain-http dev origins and in jsdom. */
function newEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newScheduleEntry(): TalonScheduleEntry {
  return { id: newEntryId(), days: [...DEFAULT_ENTRY_DAYS], time: DEFAULT_ENTRY_TIME };
}

export function newTriggerDraft(): TriggerDraft {
  return {
    type: 'schedule',
    scheduleMode: 'entries',
    entries: [newScheduleEntry()],
    intervalValue: '60',
    intervalUnit: 'minutes',
    metric: 'cpu_percent',
    operator: '>',
    value: '90',
    eventTypes: [],
    delayValue: '0',
  };
}

/** Hydrate the draft from a stored talon, leaving untouched branches at their defaults. */
export function triggerDraftFromTalon(trigger: TalonTrigger): TriggerDraft {
  const draft = newTriggerDraft();
  draft.type = trigger.type;

  if (trigger.type === 'schedule') {
    if (trigger.entries) {
      draft.scheduleMode = 'entries';
      draft.entries = trigger.entries.map((entry) => ({ ...entry, days: [...entry.days] }));
    } else {
      draft.scheduleMode = 'interval';
      // Whole hours read back as hours, so "every 2 hours" isn't reopened as 120.
      const minutes = trigger.intervalMinutes;
      const useHours = minutes >= 60 && minutes % 60 === 0;
      draft.intervalUnit = useHours ? 'hours' : 'minutes';
      draft.intervalValue = String(useHours ? minutes / 60 : minutes);
    }
  } else if (trigger.type === 'threshold') {
    draft.metric = trigger.metric;
    draft.operator = trigger.operator;
    draft.value = String(trigger.value);
  } else {
    draft.eventTypes = [...trigger.eventTypes];
    // Absent and explicit-0 are the same talon post-validation; both reopen as 0.
    draft.delayValue = String(trigger.delayMinutes ?? 0);
  }

  return draft;
}

/** `''` must not read as 0 — the validator's "must be an integer" is the honest message. */
function toNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

/** Invalid numbers pass through as `NaN`, not coerced — the validator messages. */
export function triggerDraftToInput(draft: TriggerDraft): TalonTrigger {
  switch (draft.type) {
    case 'schedule':
      if (draft.scheduleMode === 'entries') {
        return { type: 'schedule', entries: draft.entries };
      }
      return {
        type: 'schedule',
        intervalMinutes:
          draft.intervalUnit === 'hours'
            ? toNumber(draft.intervalValue) * 60
            : toNumber(draft.intervalValue),
      };
    case 'threshold':
      return {
        type: 'threshold',
        metric: draft.metric,
        operator: draft.operator,
        value: toNumber(draft.value),
      };
    case 'event': {
      const delayMinutes = toNumber(draft.delayValue);
      // An emptied box means "no wait" and is simply not sent; a typed number
      // always is, including a bad one the validator will name.
      return Number.isNaN(delayMinutes)
        ? { type: 'event', eventTypes: draft.eventTypes }
        : { type: 'event', eventTypes: draft.eventTypes, delayMinutes };
    }
  }
}

const DAY_ORDER_FROM_SUNDAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const DAY_LONG_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Next fire time across all entries, walked day-by-day in calendar tuples.
 * `Intl`, not `Date.setHours`, which silently reinterprets the clock time in
 * the browser's zone. The editor has no site timezone, so this preview is in
 * the VIEWER'S zone and is labelled "local time"; the scheduler resolves the
 * same entries against the site's zone at fire time.
 */
function nextRunPreview(entries: TalonScheduleEntry[], timeFormat: '12h' | '24h'): string {
  if (entries.length === 0) return 'no times set';

  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const nowHour = parseInt(get('hour'), 10);
  const nowMinute = parseInt(get('minute'), 10);
  const nowDayIndex = DAY_ORDER_FROM_SUNDAY.indexOf(
    get('weekday').toLowerCase().slice(0, 3) as (typeof DAY_ORDER_FROM_SUNDAY)[number],
  );
  if (nowDayIndex < 0 || Number.isNaN(nowHour) || Number.isNaN(nowMinute)) return 'unknown';

  let best: { dayOffset: number; hour: number; minute: number; dayIndex: number } | null = null;
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const dayIndex = (nowDayIndex + dayOffset) % 7;
    const dayName = DAY_ORDER_FROM_SUNDAY[dayIndex];
    for (const entry of entries) {
      if (!entry.days.includes(dayName)) continue;
      const [hour, minute] = entry.time.split(':').map(Number);
      if (Number.isNaN(hour) || Number.isNaN(minute)) continue;
      const isFuture =
        dayOffset > 0 || hour > nowHour || (hour === nowHour && minute > nowMinute);
      if (!isFuture) continue;
      if (
        best === null ||
        dayOffset < best.dayOffset ||
        (dayOffset === best.dayOffset &&
          (hour < best.hour || (hour === best.hour && minute < best.minute)))
      ) {
        best = { dayOffset, hour, minute, dayIndex };
      }
    }
  }
  if (!best) return 'no upcoming times';

  const timeStr =
    timeFormat === '24h'
      ? `${String(best.hour).padStart(2, '0')}:${String(best.minute).padStart(2, '0')}`
      : `${best.hour % 12 || 12}:${String(best.minute).padStart(2, '0')} ${best.hour >= 12 ? 'pm' : 'am'}`;

  if (best.dayOffset === 0) return `today at ${timeStr}`;
  if (best.dayOffset === 1) return `tomorrow at ${timeStr}`;
  return `${DAY_LONG_NAMES[best.dayIndex]} at ${timeStr}`;
}

interface TriggerCardProps {
  draft: TriggerDraft;
  onChange: (draft: TriggerDraft) => void;
  /** 5 normally, 15 when the condition is a visual check — mirrors the validator. */
  minIntervalMinutes: number;
  disabled: boolean;
  /**
   * Message for one error slot (`slotForField` in `TalonEditorDialog`). Exactly
   * one control renders each slot, so this can't duplicate another card.
   */
  errorFor: (slot: string) => string | undefined;
}

export function TriggerCard({
  draft,
  onChange,
  minIntervalMinutes,
  disabled,
  errorFor,
}: TriggerCardProps) {
  const { userPreferences } = useAuth();
  const timeFormat = userPreferences.timeFormat === '24h' ? '24h' : '12h';

  const patch = (changes: Partial<TriggerDraft>) => onChange({ ...draft, ...changes });

  const updateEntry = (index: number, changes: Partial<TalonScheduleEntry>) =>
    patch({
      entries: draft.entries.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)),
    });

  const allEventsSelected = draft.eventTypes.length === TALON_EVENT_TYPES.length;

  // `trigger.type`/`metric`/`operator` are absent on purpose: those selects
  // constrain their own values, so a violation can only come from the API and
  // belongs in the footer summary, not against a control the user can't misuse.
  const entriesError = errorFor('trigger.entries');
  const intervalError = errorFor('trigger.intervalMinutes');
  const eventsError = errorFor('trigger.eventTypes');
  const delayError = errorFor('trigger.delayMinutes');
  const valueError = errorFor('trigger.value');

  return (
    <section className="rounded-lg border border-border bg-background/40 p-5 space-y-4">
      <div className="space-y-4">
        <Label htmlFor="talon-trigger-type" className="text-xs uppercase tracking-wide text-muted-foreground">
          trigger
        </Label>
        <Select
          value={draft.type}
          onValueChange={(value) => patch({ type: value as TalonTriggerType })}
          disabled={disabled}
        >
          <SelectTrigger
            id="talon-trigger-type"
            data-testid="trigger-type"
            className="w-full bg-background border-border"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TRIGGER_TYPE_LABELS) as TalonTriggerType[]).map((type) => (
              <SelectItem key={type} value={type}>
                {TRIGGER_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {draft.type === 'schedule' && (
        <div className="space-y-4" data-testid="trigger-schedule">
          <div className="flex gap-1 rounded-md border border-border p-0.5">
            {(['entries', 'interval'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => patch({ scheduleMode: mode })}
                disabled={disabled}
                aria-pressed={draft.scheduleMode === mode}
                className={`flex-1 rounded px-2 py-1 text-xs transition-colors cursor-pointer ${
                  draft.scheduleMode === mode
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {mode === 'entries' ? 'at times' : 'every interval'}
              </button>
            ))}
          </div>

          {draft.scheduleMode === 'entries' ? (
            <div className="space-y-3" id="talon-trigger-entries">
              {draft.entries.map((entry, index) => (
                <div key={entry.id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <TimePicker
                      value={entry.time}
                      onChange={(time) => updateEntry(index, { time })}
                      compact
                    />
                    {draft.entries.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          patch({ entries: draft.entries.filter((_, i) => i !== index) })
                        }
                        disabled={disabled}
                        aria-label={`remove time ${index + 1}`}
                        className="h-6 w-6 rounded-md text-muted-foreground hover:text-red-400 hover:bg-muted transition-colors cursor-pointer flex items-center justify-center flex-shrink-0"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <DayPillSelector
                    value={entry.days}
                    onChange={(days) =>
                      updateEntry(index, {
                        days: days.filter((day): day is DayKey => DAY_KEYS.includes(day as DayKey)),
                      })
                    }
                    variant="pill"
                    compact
                  />
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => patch({ entries: [...draft.entries, newScheduleEntry()] })}
                disabled={disabled}
                className="w-full border-dashed border-border text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Plus className="h-3 w-3 mr-1" />
                add time
              </Button>

              {entriesError ? (
                <p role="alert" className="text-xs text-destructive">
                  {entriesError}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  next run {nextRunPreview(draft.entries, timeFormat)} — local time
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  id="talon-trigger-interval"
                  type="number"
                  inputMode="numeric"
                  min={draft.intervalUnit === 'hours' ? 1 : minIntervalMinutes}
                  value={draft.intervalValue}
                  onChange={(e) => patch({ intervalValue: e.target.value })}
                  disabled={disabled}
                  aria-invalid={!!intervalError}
                  aria-label="interval"
                  className="w-20 bg-background border-border"
                />
                <Select
                  value={draft.intervalUnit}
                  onValueChange={(value) =>
                    patch({ intervalUnit: value as TriggerDraft['intervalUnit'] })
                  }
                  disabled={disabled}
                >
                  <SelectTrigger aria-label="interval unit" className="flex-1 bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">minutes</SelectItem>
                    <SelectItem value="hours">hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {intervalError ? (
                <p role="alert" className="text-xs text-destructive">
                  {intervalError}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  minimum {minIntervalMinutes} minutes
                  {minIntervalMinutes > 5 ? ' for a visual check' : ''}.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {draft.type === 'threshold' && (
        <div className="space-y-3" data-testid="trigger-threshold">
          <Select
            value={draft.metric}
            onValueChange={(value) => patch({ metric: value as TalonMetric })}
            disabled={disabled}
          >
            <SelectTrigger
              id="talon-trigger-metric"
              aria-label="metric"
              className="w-full bg-background border-border"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TALON_METRICS.map((metric) => (
                <SelectItem key={metric} value={metric}>
                  {METRIC_META[metric].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Select
              value={draft.operator}
              onValueChange={(value) => patch({ operator: value as TalonOperator })}
              disabled={disabled}
            >
              <SelectTrigger
                id="talon-trigger-operator"
                aria-label="operator"
                className="w-20 bg-background border-border"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TALON_OPERATORS.map((operator) => (
                  <SelectItem key={operator} value={operator}>
                    {operator}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              id="talon-trigger-value"
              type="number"
              inputMode="decimal"
              value={draft.value}
              onChange={(e) => patch({ value: e.target.value })}
              disabled={disabled}
              aria-invalid={!!valueError}
              aria-label="threshold value"
              className="flex-1 bg-background border-border"
            />
            <span className="text-xs text-muted-foreground w-6">{METRIC_META[draft.metric].unit}</span>
          </div>

          {valueError ? (
            <p role="alert" className="text-xs text-destructive">
              {valueError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              fires per machine, the first time the metric crosses the bound.
            </p>
          )}
        </div>
      )}

      {draft.type === 'event' && (
        <div className="space-y-3" data-testid="trigger-event">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">events</Label>
            <button
              type="button"
              onClick={() =>
                patch({ eventTypes: allEventsSelected ? [] : [...TALON_EVENT_TYPES] })
              }
              disabled={disabled}
              className="hl-link text-xs text-accent-cyan cursor-pointer"
            >
              {allEventsSelected ? 'clear all' : 'select all'}
            </button>
          </div>
          <div
            id="talon-trigger-events"
            className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto border border-border rounded p-2"
          >
            {/* Local provider so the card mounts standalone in tests. */}
            <TooltipProvider delayDuration={200}>
            {TALON_EVENT_TYPES.map((eventType) => (
              <Tooltip key={eventType}>
                <TooltipTrigger asChild>
                  <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                    <Checkbox
                      checked={draft.eventTypes.includes(eventType)}
                      onCheckedChange={() =>
                        patch({
                          eventTypes: draft.eventTypes.includes(eventType)
                            ? draft.eventTypes.filter((value) => value !== eventType)
                            : [...draft.eventTypes, eventType],
                        })
                      }
                      disabled={disabled}
                    />
                    <span className="font-mono text-xs">{eventType}</span>
                    <Info className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </label>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-64">
                  {TALON_EVENT_INFO[eventType]}
                </TooltipContent>
              </Tooltip>
            ))}
            </TooltipProvider>
          </div>
          {eventsError && (
            <p role="alert" className="text-xs text-destructive">
              {eventsError}
            </p>
          )}

          {/* A restarted app is not a booted app — a visual check on the splash
              screen tells you nothing true. */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="talon-trigger-delay" className="text-xs text-muted-foreground">
                then wait
              </Label>
              <Input
                id="talon-trigger-delay"
                type="number"
                inputMode="numeric"
                min={0}
                max={TALON_MAX_DELAY_MINUTES}
                value={draft.delayValue}
                onChange={(e) => patch({ delayValue: e.target.value })}
                disabled={disabled}
                aria-invalid={!!delayError}
                className="w-20 bg-background border-border"
              />
              <span className="text-xs text-muted-foreground">minutes</span>
            </div>
            {delayError ? (
              <p role="alert" className="text-xs text-destructive">
                {delayError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                0 runs right away — give a restarted app time to boot before checking it
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
