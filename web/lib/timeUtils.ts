/**
 * Heartbeat/timezone display helpers. Under 5 min: clock time, muted. Over:
 * relative time, red. Tooltips always carry the full timestamp + tz.
 */

import type { FirestoreTs } from '@/hooks/useFirestore';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

/** Stale = heartbeat older than 5 min. `timestampSeconds` is unix seconds. */
export function isHeartbeatStale(timestampSeconds: number): boolean {
  const now = Date.now();
  const heartbeatMs = timestampSeconds * 1000;
  return now - heartbeatMs > STALE_THRESHOLD_MS;
}

/** Unix seconds → "14h ago" / "3m ago" / "just now". */
export function formatRelativeTime(timestampSeconds: number): string {
  const now = Date.now();
  const heartbeatMs = timestampSeconds * 1000;
  const diffMs = now - heartbeatMs;

  const minutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return 'just now';
  }
}

/** Unix seconds → clock time in an IANA `timezone`, lowercased. */
export function formatTimeOnly(
  timestampSeconds: number,
  timezone: string = 'UTC',
  timeFormat: '12h' | '24h' = '12h'
): string {
  const date = new Date(timestampSeconds * 1000);
  const hour12 = timeFormat === '12h';

  try {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12,
      timeZone: timezone,
    }).toLowerCase();
  } catch {
    // Invalid timezone — render in the browser's zone.
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12,
    }).toLowerCase();
  }
}

/**
 * Unix seconds → "January 2, 2026, 3:09:15 PM EST" for tooltips. `monthStyle`
 * 'short' abbreviates the month ("Jan 2") for width-constrained list columns.
 */
export function formatFullTimestamp(
  timestampSeconds: number,
  timezone: string = 'UTC',
  timeFormat: '12h' | '24h' = '12h',
  monthStyle: 'long' | 'short' = 'long'
): string {
  const date = new Date(timestampSeconds * 1000);
  const hour12 = timeFormat === '12h';

  try {
    return date.toLocaleString('en-US', {
      month: monthStyle,
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12,
      timeZone: timezone,
      timeZoneName: 'short',
    });
  } catch {
    // Invalid timezone — render in the browser's zone.
    return date.toLocaleString('en-US', {
      month: monthStyle,
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12,
    });
  }
}

/** Heartbeat cell: clock time when fresh, relative time when stale. */
export function formatHeartbeatTime(
  timestampSeconds: number,
  timezone: string = 'UTC',
  timeFormat: '12h' | '24h' = '12h'
): { display: string; isStale: boolean; tooltip: string } {
  // Reject epoch 0 / negative / sub-day timestamps as "never seen".
  if (!timestampSeconds || timestampSeconds < 86400) {
    return { display: '--', isStale: true, tooltip: 'No heartbeat received' };
  }
  const isStale = isHeartbeatStale(timestampSeconds);
  const tooltip = formatFullTimestamp(timestampSeconds, timezone, timeFormat);

  if (isStale) {
    return {
      display: formatRelativeTime(timestampSeconds),
      isStale: true,
      tooltip,
    };
  } else {
    return {
      display: formatTimeOnly(timestampSeconds, timezone, timeFormat),
      isStale: false,
      tooltip,
    };
  }
}

/** Browser-detected IANA timezone, 'UTC' if unavailable. */
export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

// Three timezone actors: machine (agent-reported `machine_timezone_iana`),
// user (preferences), site (manage-sites). The user's `timeDisplayMode` picks
// one frame for all absolute timestamps. Schedule editors ignore it — schedules
// are wall-clock config tied to the physical machine, always shown in its tz.

/** User-chosen reference frame for displaying absolute timestamps. */
export type TimeDisplayMode = 'user' | 'machine' | 'site';

/**
 * Per-machine (two machines on one page can render in different zones).
 * Fallbacks: user → browser → UTC; machine → site → browser → UTC;
 * site → browser → UTC. Machine falls back to SITE, not user — the site tz is
 * the closest "this installation lives in X" guess.
 */
export function getDisplayTimezone(
  mode: TimeDisplayMode,
  userTz: string | undefined,
  machineTz: string | undefined,
  siteTz: string | undefined
): string {
  switch (mode) {
    case 'user':
      return userTz || getBrowserTimezone() || 'UTC';
    case 'machine':
      return machineTz || siteTz || getBrowserTimezone() || 'UTC';
    case 'site':
      return siteTz || getBrowserTimezone() || 'UTC';
  }
}

/**
 * Wall-clock components in `timeZone` → UTC epoch ms. `new Date(y, m, d, …)`
 * would build the instant in the BROWSER's zone, which is wrong for surfaces
 * operating in the site/display zone. Offset-correction trick; inaccurate only
 * inside the ~1h DST fold, irrelevant for day-boundary bounds.
 */
export function zonedTimeToUtcMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
): number {
  const asUtc = Date.UTC(year, monthIndex, day, hour, minute, second, millisecond);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(asUtc));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const tzAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
      millisecond,
    );
    return asUtc - (tzAsUtc - asUtc);
  } catch {
    // Invalid timezone — treat the components as UTC.
    return asUtc;
  }
}

/**
 * Timezone plus the source that actually delivered it (for `<TimezoneChip>`
 * tooltips). `source` is the mode that produced the value, not the one the
 * user picked — so the chip can't lie about where the tz came from.
 */
export function getDisplayTimezoneWithSource(
  mode: TimeDisplayMode,
  userTz: string | undefined,
  machineTz: string | undefined,
  siteTz: string | undefined
): { tz: string; source: TimeDisplayMode } {
  switch (mode) {
    case 'user':
      if (userTz) return { tz: userTz, source: 'user' };
      // No user tz: still report source 'user' so the tooltip points at
      // preferences, which is where the fix lives.
      return { tz: getBrowserTimezone() || 'UTC', source: 'user' };
    case 'machine':
      if (machineTz) return { tz: machineTz, source: 'machine' };
      if (siteTz) return { tz: siteTz, source: 'site' };
      return { tz: getBrowserTimezone() || 'UTC', source: 'machine' };
    case 'site':
      if (siteTz) return { tz: siteTz, source: 'site' };
      return { tz: getBrowserTimezone() || 'UTC', source: 'site' };
  }
}

/**
 * Current wall-clock in a machine's tz for the "22:35 local" hostname label.
 * Recomputed on render (callers tick once a minute). '' when tz is unknown.
 */
export function formatMachineLocalClock(
  machineTimezone: string | undefined,
  timeFormat: '12h' | '24h' = '24h'
): string {
  if (!machineTimezone) return '';
  try {
    return new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: timeFormat === '12h',
      timeZone: machineTimezone,
    });
  } catch {
    return '';
  }
}

/** "America/Los_Angeles" → "Los Angeles". */
export function formatTimezoneShortName(tz: string | undefined): string {
  if (!tz) return 'unknown';
  return tz.replace(/_/g, ' ').split('/').pop() || tz;
}

/**
 * Timestamp for SITE-SCOPED surfaces (deployments, activity, tokens) that have
 * no single machine to anchor to; 'machine' mode therefore resolves to site →
 * browser. Accepts Date / ms number / parseable string / Firestore Timestamp.
 * Returns "Month D, YYYY, HH:MM:SS TZ", or '—' when unparseable. Pass
 * `'short'` as `monthStyle` where the column is narrow (the roosts list).
 */
export function formatSiteScopedTimestamp(
  input: FirestoreTs,
  mode: TimeDisplayMode,
  userTz: string | undefined,
  siteTz: string | undefined,
  timeFormat: '12h' | '24h' = '12h',
  monthStyle: 'long' | 'short' = 'long'
): string {
  if (input == null) return '—';

  let ms: number;
  if (input instanceof Date) {
    ms = input.getTime();
  } else if (typeof input === 'number') {
    ms = input;
  } else if (typeof input === 'string') {
    ms = Date.parse(input);
  } else if (typeof input === 'object') {
    const v = input as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof v.toMillis === 'function') {
      try { ms = v.toMillis(); } catch { return '—'; }
    } else if (typeof v.seconds === 'number') {
      ms = v.seconds * 1000;
    } else if (typeof v._seconds === 'number') {
      ms = v._seconds * 1000;
    } else {
      return '—';
    }
  } else {
    return '—';
  }

  if (!Number.isFinite(ms) || ms <= 0) return '—';

  const seconds = Math.floor(ms / 1000);
  // No machine here — 'machine' mode falls through to site, browser, UTC.
  const tz = getDisplayTimezone(mode, userTz, undefined, siteTz);
  return formatFullTimestamp(seconds, tz, timeFormat, monthStyle);
}

/** Timezone selector shortlist, ordered west → east by UTC offset. */
export const COMMON_TIMEZONES = [
  { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
  { value: 'America/Anchorage', label: 'Alaska (AKST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PST)' },
  { value: 'America/Denver', label: 'Mountain Time (MST)' },
  { value: 'America/Chicago', label: 'Central Time (CST)' },
  { value: 'America/New_York', label: 'Eastern Time (EST)' },
  { value: 'America/Sao_Paulo', label: 'Brasilia (BRT)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEDT)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZDT)' },
] as const;

/** True if `timezone` is a valid IANA zone id. */
export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Option shape for the searchable timezone picker. */
export interface TimezoneOption {
  value: string;
  label: string;
  offset: number;
  offsetLabel: string;
  region: string;
  /** Extra search terms (alternative city spellings, old IANA names, etc.) */
  aliases?: string[];
}

/** IANA id → extra search terms: renamed cities, transliterations, misspellings. */
const TIMEZONE_SEARCH_ALIASES: Record<string, string[]> = {
  'Europe/Kiev': ['kyiv'],
  'Europe/Kyiv': ['kiev'],
  'Asia/Kolkata': ['bombay', 'mumbai', 'calcutta'],
  'Asia/Ho_Chi_Minh': ['saigon'],
  'Asia/Yangon': ['rangoon'],
  'Atlantic/Reykjavik': ['reykjavík'],
  'America/Nuuk': ['godthab', 'godthåb'],
  'Pacific/Honolulu': ['hawaii'],
  'America/Anchorage': ['alaska'],
  'Asia/Istanbul': ['constantinople'],
  'Europe/Istanbul': ['constantinople'],
  'Africa/Abidjan': ['gmt', 'greenwich'],
};

/** Current UTC offset for a zone, in minutes plus a "UTC±HH:MM" label. */
export function getTimezoneOffset(timezone: string): { offset: number; offsetLabel: string } {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(now);
    const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value || 'UTC';

    // shortOffset yields "GMT+2", "GMT-5:30", "GMT+5:45", or bare "GMT".
    if (tzPart === 'GMT' || tzPart === 'UTC') {
      return { offset: 0, offsetLabel: 'UTC+00:00' };
    }

    const match = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const minutes = parseInt(match[3] || '0', 10);
      const offset = sign * (hours * 60 + minutes);
      const offsetLabel = `UTC${match[1]}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      return { offset, offsetLabel };
    }

    return { offset: 0, offsetLabel: 'UTC+00:00' };
  } catch {
    return { offset: 0, offsetLabel: 'UTC+00:00' };
  }
}

/** "America/New_York" → "America / New York". */
export function formatTimezoneLabel(timezone: string): string {
  if (timezone === 'UTC') return 'UTC';
  return timezone.replace(/_/g, ' ').replace(/\//g, ' / ');
}

let cachedTimezones: TimezoneOption[] | null = null;

/**
 * All IANA zones with labels and offsets, cached. Falls back to
 * COMMON_TIMEZONES where `Intl.supportedValuesOf` is missing (SSR, old browsers).
 */
export function getAllTimezones(): TimezoneOption[] {
  if (cachedTimezones) return cachedTimezones;

  let tzIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tzIds = (Intl as any).supportedValuesOf('timeZone');
  } catch {
    cachedTimezones = COMMON_TIMEZONES.map((tz) => {
      const { offset, offsetLabel } = getTimezoneOffset(tz.value);
      const region = tz.value.includes('/') ? tz.value.split('/')[0] : 'Other';
      const aliases = TIMEZONE_SEARCH_ALIASES[tz.value];
      return { value: tz.value, label: formatTimezoneLabel(tz.value), offset, offsetLabel, region, ...(aliases && { aliases }) };
    });
    return cachedTimezones;
  }

  cachedTimezones = tzIds.map((tz) => {
    const { offset, offsetLabel } = getTimezoneOffset(tz);
    const region = tz.includes('/') ? tz.split('/')[0] : 'Other';
    const aliases = TIMEZONE_SEARCH_ALIASES[tz];
    return { value: tz, label: formatTimezoneLabel(tz), offset, offsetLabel, region, ...(aliases && { aliases }) };
  });

  cachedTimezones.sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label));
  return cachedTimezones;
}
