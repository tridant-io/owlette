import type { ActivityActor, ActivityRow, Finding } from './types';

type Fact = Finding['facts'][number];

export const WINDOW_MS = 15 * 60 * 1000;
export const SECOND_FACTOR_BURST = 5;
export const DESTRUCTIVE_BURST = 5;
export const REFUSAL_BURST = 20;

export interface RuleInput {
  rows: ActivityRow[];
  /** network keys seen on each user's earlier sign-ins */
  knownNetworks: Record<string, string[]>;
  hasHistory: Record<string, boolean>;
  /** each user's highest site role */
  siteRoles: Record<string, 'owner' | 'admin' | 'member' | null>;
  /** uid to email, so a finding names a person; a uid without one prints as itself */
  labels?: Record<string, string>;
}

const DESTRUCTIVE_VERBS = new Set([
  'machine.remove',
  'uninstall',
  'uninstall_software',
  'member_removed',
  'agent_token.revoke',
  'soft_deleted',
  'reboot_machine',
  'shutdown_machine',
]);

const NOT_A_REFUSAL = new Set(['rate_limited', 'plan_locked']);

const fact = (label: string, value: string): Fact => ({ label, value });
const safe = (s: string) => s.replace(/\//g, '_');
const verbOf = (row: ActivityRow) => row.action.slice(row.action.indexOf(':') + 1);
const actorKey = (row: ActivityRow) => `${row.actor.type}:${row.actor.id}`;

// a user is found by userId; anyone else by the string the change rows name them with, which `parseChangeActor` reads back
function actorSubject({ type, id }: ActivityActor): Finding['subject'] {
  if (type === 'user') return { userId: id };
  return { actor: type === 'api_key' ? `apiKey:${id}` : type === 'unknown' ? id : `${type}:${id}` };
}

function isDestructive(row: ActivityRow): boolean {
  if (row.kind !== 'change') return false;
  return row.action === 'site_mutated:deleted' || DESTRUCTIVE_VERBS.has(verbOf(row));
}

// the first run of `min`+ rows inside one window per time bucket; keyed on the run's newest row
// so a later scan over a longer span names the same burst
function bursts(rows: ActivityRow[], min: number): { newestAt: number; rows: ActivityRow[] }[] {
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const out: { newestAt: number; rows: ActivityRow[] }[] = [];
  const seen = new Set<number>();
  let start = 0;
  for (let j = 0; j < sorted.length; j++) {
    const newestAt = sorted[j].at;
    while (sorted[start].at <= newestAt - WINDOW_MS) start++;
    const inWindow = sorted.slice(start, j + 1);
    // a burst straddling a bucket edge can raise two findings; accepted
    const bucket = Math.floor(newestAt / WINDOW_MS);
    if (inWindow.length < min || seen.has(bucket)) continue;
    seen.add(bucket);
    out.push({ newestAt, rows: inWindow });
  }
  return out;
}

function groupBy(rows: ActivityRow[], key: (row: ActivityRow) => string): Map<string, ActivityRow[]> {
  const groups = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

function single(
  row: ActivityRow,
  rule: Finding['rule'],
  severity: Finding['severity'],
  title: string,
  summary: string,
  facts: Fact[],
): Finding {
  return {
    id: safe(`${rule}:${row.id}`),
    rule,
    severity,
    title,
    summary,
    subject: { ...actorSubject(row.actor), siteId: row.siteId },
    at: row.at,
    facts,
    rowIds: [row.id],
  };
}

export function evaluateRules({ rows, knownNetworks, hasHistory, siteRoles, labels }: RuleInput): Finding[] {
  const findings: Finding[] = [];
  const lab = (id: string) => labels?.[id] ?? id;
  const who = (row: ActivityRow) => row.actor.label ?? (row.actor.type === 'user' ? lab(row.actor.id) : row.actor.id);

  for (const row of rows) {
    const target = row.target?.id ?? 'unknown';
    const person = lab(target);
    if (row.action === 'user_mutated:promoted' && row.details.to === 'superadmin') {
      findings.push(single(row, 'superadmin_promoted', 'high', 'superadmin promoted',
        `${who(row)} made ${person} a superadmin.`,
        [fact('by', who(row)), fact('user', person), fact('from', String(row.details.from ?? 'unknown'))]));
    } else if (row.action === 'user_mutated:mfa_disabled' || row.action === 'user_mutated:mfa_force_reset') {
      const reset = row.action.endsWith('force_reset');
      findings.push(single(row, 'mfa_removed', 'high', '2fa removed',
        `${who(row)} ${reset ? 'force-reset' : 'turned off'} 2fa for ${person}.`,
        [fact('by', who(row)), fact('user', person), fact('change', reset ? 'forced reset' : 'disabled')]));
    } else if (row.kind === 'refused' && row.action === 'SITE_DELETE' && row.outcome === 'allow') {
      findings.push(single(row, 'site_deleted', 'high', 'site deleted',
        `${who(row)} deleted site ${target}.`,
        [fact('by', who(row)), fact('site', target)]));
    } else if (row.action === 'site_member_mutated:ownership_transferred') {
      findings.push(single(row, 'ownership_transferred', 'digest', 'site ownership transferred',
        `${who(row)} transferred ownership of site ${row.siteId ?? 'unknown'} to ${person}.`,
        [fact('by', who(row)), fact('site', row.siteId ?? 'unknown'), fact('new owner', person)]));
    } else if (row.action === 'user_mutated:soft_deleted') {
      findings.push(single(row, 'user_deleted', 'digest', 'user deleted',
        `${who(row)} deleted the account ${person}.`,
        [fact('by', who(row)), fact('user', person)]));
    }
  }

  const secondFactor = rows.filter((r) => r.kind === 'sign_in' && r.outcome === 'deny');
  for (const [uid, group] of groupBy(secondFactor, (r) => r.actor.id)) {
    for (const b of bursts(group, SECOND_FACTOR_BURST)) {
      findings.push({
        id: safe(`second_factor_burst:${uid}:${Math.floor(b.newestAt / WINDOW_MS)}`),
        rule: 'second_factor_burst',
        severity: 'high',
        title: 'second factor burst',
        summary: `${b.rows.length} failed sign-in or second-factor attempts for ${lab(uid)} within 15 minutes.`,
        subject: { userId: uid },
        at: b.newestAt,
        facts: [fact('user', lab(uid)), fact('failures', String(b.rows.length))],
        rowIds: b.rows.map((r) => r.id),
      });
    }
  }

  for (const [actor, group] of groupBy(rows.filter(isDestructive), actorKey)) {
    for (const b of bursts(group, DESTRUCTIVE_BURST)) {
      findings.push({
        id: safe(`destructive_burst:${actor}:${Math.floor(b.newestAt / WINDOW_MS)}`),
        rule: 'destructive_burst',
        severity: 'high',
        title: 'destructive burst',
        summary: `${who(group[0])} made ${b.rows.length} destructive changes within 15 minutes.`,
        subject: actorSubject(group[0].actor),
        at: b.newestAt,
        facts: [fact('actor', who(group[0])), fact('changes', String(b.rows.length))],
        rowIds: b.rows.map((r) => r.id),
      });
    }
  }

  const refused = rows.filter(
    (r) => r.kind === 'refused' && r.outcome === 'deny' && !NOT_A_REFUSAL.has(r.reason ?? ''),
  );
  for (const [actor, group] of groupBy(refused, actorKey)) {
    for (const b of bursts(group, REFUSAL_BURST)) {
      findings.push({
        id: safe(`refusal_burst:${actor}:${Math.floor(b.newestAt / WINDOW_MS)}`),
        rule: 'refusal_burst',
        severity: 'digest',
        title: 'refusal burst',
        summary: `${who(group[0])} was refused ${b.rows.length} times within 15 minutes.`,
        subject: actorSubject(group[0].actor),
        at: b.newestAt,
        facts: [fact('actor', who(group[0])), fact('refusals', String(b.rows.length))],
        rowIds: b.rows.map((r) => r.id),
      });
    }
  }

  const seenNetworks = new Set<string>();
  for (const row of [...rows].sort((a, b) => a.at - b.at)) {
    const key = row.network?.key;
    if (row.kind !== 'sign_in' || row.action !== 'sign_in' || row.outcome !== 'allow') continue;
    if (!key || key === 'unknown' || !hasHistory[row.actor.id]) continue;
    if (knownNetworks[row.actor.id]?.includes(key)) continue;
    const severity =
      row.details.role === 'superadmin'
        ? 'high'
        : siteRoles[row.actor.id] === 'owner' || siteRoles[row.actor.id] === 'admin'
          ? 'digest'
          : null;
    const id = safe(`new_network_sign_in:${row.actor.id}:${key}`);
    if (!severity || seenNetworks.has(id)) continue;
    seenNetworks.add(id);
    findings.push({
      id,
      rule: 'new_network_sign_in',
      severity,
      title: 'sign-in from a new network',
      summary: `${who(row)} signed in from a network they have not used before.`,
      subject: { userId: row.actor.id },
      at: row.at,
      facts: [fact('user', who(row)), fact('network', key), ...(row.network?.prefix ? [fact('prefix', row.network.prefix)] : [])],
      rowIds: [row.id],
    });
  }

  return findings;
}
