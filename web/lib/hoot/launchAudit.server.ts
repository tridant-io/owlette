/**
 * The old and new values an approved launch change records. Arguments hold whatever
 * someone typed, and every list of secret-looking shapes has leaked, so nothing
 * tries to spot a secret: a value is written plainly only when its field can't hold
 * one and it is a scalar, or it reads as a bare path. Anything else is a keyed hash
 * and a length, which says whether it changed without saying what it was. Site
 * admins read these rows, so a hash anyone could recompute would give up a short
 * value to a few thousand guesses: with no key, no hash is written.
 *
 * Server-side only.
 */

import { createHash, createHmac } from 'crypto';
import { hootInternalSecret } from '@/lib/hootInternalSecret';

/** Fields that hold a name or a setting from a fixed vocabulary, never free text. */
const PLAIN_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'autolaunch',
  'day_of_week',
  'days',
  'enabled',
  'first_failure',
  'hive',
  'hour',
  'key_path',
  'launch_mode',
  'mode',
  'process_name',
  'relaunch_attempts',
  'schedule',
  'schedulePresetId',
  'schedules',
  'second_failure',
  'service_name',
  'start',
  'startup_type',
  'stop',
  'subsequent_failures',
  'talon_id',
  'task_name',
  'time_delay',
  'time_to_init',
  'type',
  'value_name',
  'value_type',
]);

/** A bare path: a space can't start a flag, and nothing in it can be an assignment, a query or a URL's password. */
const BARE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)[^\s"'=&?@;:|<>]*(?: [^\s"'=&?@;:|<>-][^\s"'=&?@;:|<>]*)*$/;

/** Never plain, path or not: a registry value's data is whatever the value holds. */
const NEVER_PLAIN_FIELDS: ReadonlySet<string> = new Set(['value_data']);

const AUDIT_VALUE_MAX = 1000;

/** HMAC over the internal secret, for anything an audit row hashes. Null with no secret to key it. */
export function keyedHash(text: string): string | null {
  const key = hootInternalSecret();
  return key ? createHmac('sha256', key).update(`launch-audit:${text}`).digest('hex') : null;
}

/** Every value tagged by shape, as entries: an own `__proto__` key survives, and an object is never an array. */
function hashable(value: unknown): unknown {
  if (Array.isArray(value)) return ['a', value.map(hashable)];
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return ['o', Object.keys(record).sort().map((key) => [key, hashable(record[key])])];
  }
  return value;
}

/**
 * The whole call: a resumed input that differs in any field is not the one approved.
 * Unkeyed, so it never goes on a row anyone reads: rows carry `keyedHash` of it.
 */
export function toolCallHash(toolName: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([toolName, hashable(input)])).digest('hex');
}

function fingerprint(text: string): string {
  const hash = keyedHash(text);
  return hash ? `[hash:${hash.slice(0, 16)} length:${text.length}]` : `[length:${text.length}]`;
}

/** A plain field is plain only as a scalar: a model can put anything in an object or a list under one. */
function recordedValue(field: string, value: unknown): unknown {
  if (typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => recordedValue(field === 'days' ? field : '', entry));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, recordedValue(key, entry)]),
    );
  }
  if (PLAIN_FIELDS.has(field)) return value;
  const text = String(value);
  return typeof value === 'string' && !NEVER_PLAIN_FIELDS.has(field) && BARE_PATH.test(text) ? text : fingerprint(text);
}

function auditValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const recorded = recordedValue(field, value);
  const text = typeof recorded === 'string' ? recorded : JSON.stringify(recorded);
  return text.slice(0, AUDIT_VALUE_MAX);
}

/** Old and new values on an audit row; `from: null` on a create, `to: null` on a delete. */
export type LaunchChanges = Record<string, { from: string | null; to: string | null }>;

/** The process fields that say what runs and when. There is no environment field to record. */
const LAUNCH_AUDIT_FIELDS = [
  'exe_path',
  'file_path',
  'cwd',
  'launch_mode',
  'autolaunch',
  'schedules',
  'schedule',
  'schedulePresetId',
  'time_delay',
  'time_to_init',
  'relaunch_attempts',
] as const;

export function launchChangesBetween(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): LaunchChanges | undefined {
  const changes: LaunchChanges = {};
  for (const field of LAUNCH_AUDIT_FIELDS) {
    const from = before?.[field] ?? '';
    const to = after?.[field] ?? '';
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[field] = { from: auditValue(field, from), to: auditValue(field, to) };
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * The old and new values of an approved launch change. `current` is the process as
 * configured; a tool the agent carries out has no old value the server can read,
 * so its `from` stays null.
 */
export function launchChangesForCall(
  toolName: string,
  params: Record<string, unknown>,
  current: Record<string, unknown> | null,
): LaunchChanges {
  switch (toolName) {
    case 'update_process':
      return launchChangesBetween(current, { ...current, ...params }) ?? {};
    case 'add_process':
      return launchChangesBetween(null, params) ?? {};
    case 'delete_process':
      return launchChangesBetween(current, null) ?? {};
    case 'set_launch_mode':
      return (
        launchChangesBetween(current, {
          ...current,
          launch_mode: params.mode,
          schedules: params.schedules ?? current?.schedules,
        }) ?? {}
      );
    default:
      return Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, { from: null, to: auditValue(key, value) }]),
      );
  }
}
