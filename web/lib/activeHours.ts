/**
 * Active hours as the dashboard sees them: the window the agent heartbeats as
 * `activeHours`, the inside-or-not rule its guard applies
 * (agent/src/active_hours.py), and the wire options of the restart and shutdown
 * commands that guard holds back.
 *
 * The agent decides at execution time; the dashboard only has to agree with
 * it, so the confirm asks for a choice exactly when the agent would refuse.
 */

import { ACTIVE_HOURS_GUARD_MIN_AGENT_VERSION, compareVersions } from '@/lib/versionUtils';

const ACTIVE_HOURS_SOURCES = ['policy', 'mdm', 'user', 'default'] as const;

/** where the agent read the window: policy, MDM, the person's setting, or windows' 8–17 default. */
export type ActiveHoursSource = (typeof ACTIVE_HOURS_SOURCES)[number];

/** whole hours on the machine clock: the start inclusive, the end exclusive, wrapping past midnight when start > end. */
export interface ActiveHours {
  start: number;
  end: number;
  source: ActiveHoursSource | null;
}

/** the active hours a machine's agent holds restarts and shutdowns to. */
export interface ActiveHoursGuard {
  window: ActiveHours;
  /** the machine's IANA zone; undefined when the agent could not name it. */
  timezone?: string;
}

/** the agent's countdown before the OS restarts or shuts down (REBOOT_OS_COUNTDOWN_SECONDS). */
export const POWER_COUNTDOWN_SECONDS = 60;

/** the longest override reason the server accepts; the agent treats a longer one as no override. */
export const OVERRIDE_REASON_MAX = 500;

export type PowerAction = 'restart' | 'shutdown';

export interface PowerCommandOptions {
  /** a person's reason to act inside active hours, sent as `active_hours_override`. */
  override?: { reason: string };
  /** restart only: `after_active_hours` waits for the window to end. */
  when?: 'now' | 'after_active_hours';
}

/** a restart or shutdown the commands route queued. */
export interface PowerCommandSent {
  commandId: string;
  /** drops the countdown the dashboard drew before the agent answered. */
  revertCountdown?: () => void;
}

function isHour(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23;
}

/** The agent's `activeHours`, or undefined when it is absent or a window the agent never reports. */
export function parseActiveHours(value: unknown): ActiveHours | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (!isHour(v.start) || !isHour(v.end) || v.start === v.end) return undefined;
  const source = (ACTIVE_HOURS_SOURCES as readonly unknown[]).includes(v.source)
    ? (v.source as ActiveHoursSource)
    : null;
  return { start: v.start, end: v.end, source };
}

/**
 * `capabilities.activeHoursGuard === 1` on an agent of 4.1.21 or later: only
 * such a windows agent writes it, and only it refuses inside active hours or
 * can hold a restart until they end. the version is the machine doc's
 * `agent_version`, since an older agent never clears the key; a missing or
 * unreadable one counts as no guard.
 */
export function hasActiveHoursGuard(machine: {
  capabilities?: { activeHoursGuard?: unknown } | null;
  agent_version?: unknown;
}): boolean {
  if (machine.capabilities?.activeHoursGuard !== 1) return false;
  const version = typeof machine.agent_version === 'string' ? machine.agent_version : null;
  return (compareVersions(version, ACTIVE_HOURS_GUARD_MIN_AGENT_VERSION) ?? -1) >= 0;
}

/**
 * why a `reboot_machine` with `when: after_active_hours` is refused on a machine
 * without the guard: its agent ignores `when` and would restart at once. the
 * API's 409 detail as is; hoot adds what a model does next (hoot-utils.server).
 */
export const HELD_RESTART_UNSUPPORTED_REASON =
  "this machine's agent can't hold a restart for active hours: it is older than owlette 4.1.21, or the machine isn't on Windows, the only platform with active hours. sending it would restart the machine right away, so nothing was sent.";

/**
 * The window this machine's agent enforces, or null where it enforces none:
 * only windows agents with the guard ({@link hasActiveHoursGuard}: the
 * capability on 4.1.21 or later) refuse, and only while they report a window. Every other agent ignores `when` and restarts at
 * once, so the dashboard keeps its plain confirm for them.
 */
export function activeHoursGuardOf(machine: {
  osFamily?: string | null;
  capabilities?: { activeHoursGuard?: number } | null;
  agent_version?: string | null;
  activeHours?: unknown;
  machineTimezone?: string | null;
}): ActiveHoursGuard | null {
  // an absent osFamily is a pre-3.4 agent, and those are all windows
  if ((machine.osFamily ?? 'windows') !== 'windows') return null;
  if (!hasActiveHoursGuard(machine)) return null;
  const window = parseActiveHours(machine.activeHours);
  if (!window) return null;
  return { window, timezone: machine.machineTimezone ?? undefined };
}

export function isInsideActiveHours(window: ActiveHours, hour: number): boolean {
  if (window.start < window.end) return window.start <= hour && hour < window.end;
  return hour >= window.start || hour < window.end;
}

/** The hour on a machine's clock, or null when its zone is missing or unknown here. */
export function machineHour(timezone: string | undefined, now: Date): number | null {
  if (!timezone) return null;
  try {
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(now)
      .find((part) => part.type === 'hour')?.value;
    const parsed = Number(hour);
    return isHour(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether the machine is inside its active hours now; null when its clock is unknown here. */
export function insideActiveHoursNow(guard: ActiveHoursGuard, now: Date = new Date()): boolean | null {
  const hour = machineHour(guard.timezone, now);
  return hour === null ? null : isInsideActiveHours(guard.window, hour);
}

function clockHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** The window as the clock reads it, the way the agent writes it: `08:00–17:00`. */
export function describeActiveHours(window: ActiveHours): string {
  return `${clockHour(window.start)}–${clockHour(window.end)}`;
}

/** When the window ends on the machine clock: `17:00`. */
export function activeHoursEnd(window: ActiveHours): string {
  return clockHour(window.end);
}

function clockTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date);
}

/**
 * A unix instant on the machine clock, the way the agent writes it: `17:00`.
 * An agent that cannot name its zone writes none, and then the instant reads
 * in UTC, which `machineTime: false` says.
 */
export function machineClockAt(
  unixSeconds: number,
  timezone: string | undefined,
): { time: string; machineTime: boolean } {
  const date = new Date(unixSeconds * 1000);
  if (timezone) {
    try {
      return { time: clockTime(date, timezone), machineTime: true };
    } catch {
      // a zone this browser does not know reads in UTC, like a missing one
    }
  }
  return { time: clockTime(date, 'UTC'), machineTime: false };
}

const REFUSAL = /active_hours: inside active hours (\S+)(?: \(machine time\))?(?:; they end at (\d{2}:\d{2}))?/;

/** The window named in the agent's refusal (`Error: active_hours: inside active hours …`), or null for any other failure. */
export function parseActiveHoursRefusal(error: string): { window: string; endsAt: string | null } | null {
  const match = REFUSAL.exec(error);
  return match ? { window: match[1], endsAt: match[2] ?? null } : null;
}

/** A command's error as the dashboard shows it: the agent's active-hours refusal in plain words, anything else as written. */
export function describeCommandError(error: string): string {
  const refusal = parseActiveHoursRefusal(error);
  if (!refusal) return error;
  const ends = refusal.endsAt ? `, they end at ${refusal.endsAt}` : '';
  return `refused: inside active hours ${refusal.window} (machine time)${ends}`;
}

/** The commands route's `params` for a restart (`reboot_machine`) or shutdown (`shutdown_machine`). */
export function powerCommandParams(
  action: PowerAction,
  options: PowerCommandOptions = {},
): Record<string, unknown> {
  return {
    delay_seconds: POWER_COUNTDOWN_SECONDS,
    ...(action === 'restart' && options.when ? { when: options.when } : {}),
    ...(options.override ? { active_hours_override: { reason: options.override.reason } } : {}),
  };
}
