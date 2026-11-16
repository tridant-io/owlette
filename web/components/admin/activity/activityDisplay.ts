import type { ActivityActor, ActivityRow } from '@/lib/activity/types';
import { formatRelativeTime } from '@/lib/timeUtils';
import { formatIssueDate } from '../issues/issueDisplay';

/**
 * What the activity page shows for a row: who did it, what they did, and the
 * muted line under it. Pure, so every kind and actor type is testable on its own.
 */

export type SiteNames = Record<string, string>;

const words = (value: string) => value.replace(/_/g, ' ');

/** the thing a mutation kind changes, as it reads after a verb */
const MUTATION_NOUN: Record<string, string> = {
  api_key_mutated: 'api key',
  chunk_mutated: 'chunk',
  deployment_mutated: 'deployment',
  distribution_mutated: 'distribution',
  process_mutated: 'process',
  roost_mutated: 'roost',
  user_mutated: 'user',
  site_mutated: 'site',
  site_member_mutated: 'site member',
  installer_mutated: 'installer',
  webhook_mutated: 'webhook',
  chat_mutated: 'chat',
  billing_mutated: 'billing',
  talon_mutated: 'talon',
};

const SIGN_IN_METHOD: Record<string, string> = {
  passkey: 'a passkey',
  'google.com': 'google',
  password: 'a password',
  totp: 'an authenticator code',
  backup_code: 'a backup code',
  app_link: 'the app link',
};

export function actorName(actor: ActivityActor): string {
  switch (actor.type) {
    case 'user':
      return actor.label || actor.id;
    case 'api_key':
      return `api key ${actor.id}`;
    case 'machine':
      return `machine ${actor.id}`;
    case 'system':
      return `owlette · ${words(actor.id)}`;
    default:
      return actor.id || 'unknown';
  }
}

/** a flagged row leads with the rule's title; its summary already names the actor */
export function rowWho(row: ActivityRow): string {
  return row.kind === 'flagged' ? String(row.details.title ?? words(row.action)) : actorName(row.subject ?? row.actor);
}

/** the host's own event says more than the capability it was refused */
function hostEvent(row: ActivityRow): string | null {
  return row.actor.type === 'system' && typeof row.details.event === 'string' ? words(row.details.event) : null;
}

function changeWhat(row: ActivityRow): string {
  const [kind, ...rest] = row.action.split(':');
  const verb = rest.join(':');
  const target = row.target?.id;
  if (kind === 'machine_command_dispatched') {
    return `sent ${verb ? words(verb) : 'a command'}${target ? ` to ${target}` : ''}`;
  }
  const noun = MUTATION_NOUN[kind] ?? words(kind);
  return `${verb ? words(verb) : 'changed'} ${noun}${target ? ` ${target}` : ''}`;
}

function signInWhat(row: ActivityRow): string {
  const method = typeof row.details.method === 'string' ? row.details.method : '';
  const denied = row.outcome === 'deny' || row.outcome === 'error';
  if (row.action === 'second_factor') {
    if (!denied) return `passed a second factor${method ? ` (${method})` : ''}`;
    return `failed a second factor${row.reason ? ` (${words(row.reason)})` : ''}`;
  }
  if (denied) return `failed to sign in${row.reason ? ` (${words(row.reason)})` : ''}`;
  return method ? `signed in with ${SIGN_IN_METHOD[method] ?? words(method)}` : 'signed in';
}

export function rowWhat(row: ActivityRow): string {
  switch (row.kind) {
    case 'flagged':
      return String(row.details.summary ?? '');
    case 'change':
      return changeWhat(row);
    case 'refused':
      return `was refused: ${hostEvent(row) ?? words(row.action.toLowerCase())}${row.target?.id ? ` on ${row.target.machineId ?? row.target.id}` : ''}`;
    default:
      return signInWhat(row);
  }
}

export function siteLabel(row: ActivityRow, siteNames: SiteNames = {}): string {
  return row.siteId === null ? 'platform' : siteNames[row.siteId] ?? row.siteId;
}

/** "asn:7922" and its prefix, as "AS7922 · 73.162.14.0/24" */
export function networkLabel(network: NonNullable<ActivityRow['network']>): string {
  const key = network.key.startsWith('asn:') ? `AS${network.key.slice(4)}` : 'unknown network';
  return network.prefix ? `${key} · ${network.prefix}` : key;
}

/** whether the owner has been told: a high finding is emailed at once, the rest wait for the digest */
function mailState(row: ActivityRow): string {
  if (row.details.emailedAt) return 'emailed';
  if (row.details.digestedAt) return 'in a digest';
  return row.severity === 'high' ? 'not emailed yet' : 'in the next digest';
}

export function rowMeta(row: ActivityRow, siteNames: SiteNames = {}): string {
  // a sign-in belongs to no site, and of the global roles only superadmin still means anything
  const parts = row.kind === 'sign_in' ? [] : [siteLabel(row, siteNames)];
  if (row.kind === 'change' && row.details.via === 'hoot') parts.push('through hoot');
  if (row.kind === 'flagged') parts.push(mailState(row));
  if (row.kind === 'sign_in' && row.details.role === 'superadmin') parts.push('superadmin');
  if (row.network) parts.push(networkLabel(row.network));
  if (row.subject) parts.push(`reported by ${actorName(row.actor)}`);
  if (row.kind === 'refused' && !row.subject && row.reason && words(row.reason) !== hostEvent(row)) parts.push(words(row.reason));
  return parts.join(' · ');
}

/** the badge's text; the severity is in the label, so colour never carries it alone */
export function kindLabel(row: ActivityRow): string {
  switch (row.kind) {
    case 'flagged':
      return `flagged · ${row.severity ?? 'digest'}`;
    case 'sign_in':
      return 'sign-in';
    case 'change':
      return 'change';
    default:
      return 'refused';
  }
}

export function rowTime(row: ActivityRow): string {
  return formatRelativeTime(row.at / 1000);
}

const fullTime = (ms: number) => formatIssueDate(new Date(ms).toISOString());

export function rowFullTime(row: ActivityRow): string {
  return fullTime(row.at);
}

function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'id' in value) {
    const { kind, id } = value as { kind?: string; id: string };
    return kind ? `${words(kind)} ${id}` : String(id);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** the opened row's definition list: the row's own fields, then what the record carries */
export function rowFacts(row: ActivityRow, siteNames: SiteNames = {}): [string, string][] {
  const facts: [string, string][] = [['time', rowFullTime(row)]];
  if (row.kind === 'flagged') {
    facts.push(['rule', words(row.action)], ['severity', row.severity ?? 'digest']);
    const found = row.details.facts;
    if (Array.isArray(found)) {
      for (const f of found) {
        if (typeof f?.label === 'string' && typeof f?.value === 'string') facts.push([f.label, f.value]);
      }
    }
    const { emailedAt, digestedAt } = row.details;
    if (typeof emailedAt === 'number') facts.push(['emailed', fullTime(emailedAt)]);
    else if (typeof digestedAt === 'number') facts.push(['in a digest', fullTime(digestedAt)]);
    const rowIds = row.details.rowIds;
    if (Array.isArray(rowIds)) facts.push(['rows', String(rowIds.length)]);
    return facts;
  }
  if (row.subject) facts.push(['viewer', actorName(row.subject)]);
  if (row.target?.machineId) facts.push(['machine', row.target.machineId]);
  facts.push(['action', row.action], ['site', siteLabel(row, siteNames)]);
  if (row.outcome) facts.push(['outcome', row.reason ? `${row.outcome} · ${words(row.reason)}` : row.outcome]);
  if (row.network) facts.push(['network', networkLabel(row.network)]);
  for (const [key, value] of Object.entries(row.details)) {
    if (key === 'network' || value === undefined || value === null || value === '') continue;
    facts.push([words(key), show(value)]);
  }
  return facts;
}
