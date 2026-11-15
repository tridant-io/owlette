/**
 * @jest-environment node
 */

import { Timestamp } from 'firebase-admin/firestore';
import { loadActivityPage, loadActivitySince, InvalidPageTokenError } from '@/lib/activity/feed.server';
import { AUTH_CAPABILITIES, MUTATION_KINDS, type ActivityRow } from '@/lib/activity/types';

type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Where = [string, string, unknown];

const store = new Map<string, Data>();
const queries: Array<{ scope: string; where: Where[]; order?: string }> = [];

const at = (path: string, data: Data) => store.set(path, data);
const dig = (data: Data, field: string) => field.split('.').reduce<any>((v, k) => v?.[k], data); // eslint-disable-line @typescript-eslint/no-explicit-any
const num = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : v);

function snapOf(path: string) {
  const parts = path.split('/');
  return {
    id: parts[parts.length - 1],
    data: () => store.get(path),
    ref: { parent: { parent: parts.length >= 4 ? { id: parts[parts.length - 3] } : null } },
  };
}

function matches(data: Data, [field, op, value]: Where) {
  const v = num(dig(data, field));
  if (op === '==') return v === value;
  if (op === 'in') return (value as unknown[]).includes(v);
  if (v === undefined) return false;
  return op === '<' ? (v as number) < (num(value) as number) : (v as number) > (num(value) as number);
}

function makeQuery(scope: string, inScope: (path: string) => boolean, where: Where[] = [], order?: string, max = 1e9, after?: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const next = (patch: Record<string, unknown>) =>
    makeQuery(scope, inScope, (patch.where as Where[]) ?? where, (patch.order as string) ?? order, (patch.max as number) ?? max, (patch.after as string) ?? after);
  return {
    where: (f: string, op: string, v: unknown) => next({ where: [...where, [f, op, v]] }),
    orderBy: (f: string) => next({ order: f }),
    limit: (n: number) => next({ max: n }),
    startAfter: (s: { id: string }) => next({ after: s.id }),
    get: async () => {
      queries.push({ scope, where, order });
      let paths = [...store.keys()].filter(inScope).filter((p) => where.every((w) => matches(store.get(p)!, w)));
      if (order) {
        paths = paths.filter((p) => dig(store.get(p)!, order) !== undefined);
        const t = (p: string) => num(dig(store.get(p)!, order)) as number;
        paths.sort((a, b) => t(b) - t(a) || (a < b ? 1 : -1));
      }
      if (after) paths = paths.slice(paths.findIndex((p) => p.endsWith(`/${after}`)) + 1);
      return { docs: paths.slice(0, max).map(snapOf) };
    },
  };
}

const collection = (path: string) => {
  const depth = path.split('/').length;
  return makeQuery(path, (p) => p.startsWith(`${path}/`) && p.split('/').length === depth + 1);
};

const db: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
  collection: (name: string) => ({
    ...collection(name),
    doc: (id: string) => ({ collection: (sub: string) => collection(`${name}/${id}/${sub}`) }),
  }),
  collectionGroup: (name: string) =>
    makeQuery(`group:${name}`, (p) => p.split('/').slice(-2)[0] === name),
};

const change = (id: string, recordedAt: number, o: { siteId?: string; actor?: string; kind?: string } = {}) =>
  at(`sites/${o.siteId ?? 'site-a'}/audit_log/${id}`, {
    event: { kind: o.kind ?? 'user_mutated', siteId: o.siteId ?? 'site-a', actor: o.actor ?? 'user:u1', occurredAt: recordedAt, attributes: { verb: 'promoted' } },
    recordedAt,
    hash: id,
  });

const decision = (path: string, ms: number, o: Data = {}) =>
  at(path, {
    correlationId: path,
    actor: { type: 'user', userId: 'u1', role: 'admin' },
    capability: 'MACHINE_REMOVE',
    target: { kind: 'machine', id: 'm1' },
    outcome: 'deny',
    denyReason: 'nope',
    timestamp: Timestamp.fromMillis(ms),
    ...o,
  });

const finding = (id: string, detectedAt: number, subject: Data = { userId: 'u1' }) =>
  at(`global/activity_watch/findings/${id}`, { rule: 'mfa_removed', severity: 'high', title: 't', summary: 's', subject, at: detectedAt, facts: [], rowIds: [], detectedAt });

const ids = (rows: ActivityRow[]) => rows.map((r) => r.id);
const scopes = () => queries.map((q) => q.scope).sort();

beforeEach(() => {
  store.clear();
  queries.length = 0;
});

describe('loadActivityPage merge', () => {
  it('merges every source newest first', async () => {
    change('c1', 5000);
    decision('sites/site-a/audit_log/d1', 4000);
    decision('global/audit_log/entries/p1', 3000);
    decision('global/audit_log/entries/s1', 2000, { capability: 'AUTH_SIGN_IN', outcome: 'allow', denyReason: undefined });
    finding('f1', 1000);

    const page = await loadActivityPage(db, { view: 'all', pageSize: 10 });

    expect(ids(page.rows)).toEqual(['change:c1', 'decision:d1', 'platform:p1', 'platform:s1', 'finding:f1']);
    expect(page.rows[1].siteId).toBe('site-a');
    expect(page.rows[2].siteId).toBeNull();
    expect(page.nextPageToken).toBe('');
  });

  it('returns a denied sign-in once, as a sign-in', async () => {
    decision('global/audit_log/entries/s1', 2000, { capability: 'AUTH_SIGN_IN', denyReason: 'bad_password' });

    const page = await loadActivityPage(db, { view: 'all', pageSize: 10 });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ id: 'platform:s1', kind: 'sign_in', outcome: 'deny' });
  });

  it('pages through rows sharing one millisecond with none lost or repeated', async () => {
    for (const n of [1, 2, 3, 4]) change(`c${n}`, 1000);
    decision('sites/site-a/audit_log/d1', 1000);
    decision('global/audit_log/entries/p1', 1000);
    change('older', 900);
    change('newer', 1100);

    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof loadActivityPage>> = await loadActivityPage(db, { view: 'all', pageSize: 2, pageToken: token });
      seen.push(...ids(page.rows));
      token = page.nextPageToken || null;
      pages += 1;
    } while (token && pages < 20);

    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
    expect(seen[0]).toBe('change:newer');
    expect(seen[seen.length - 1]).toBe('change:older');
  });

  it('rejects a malformed page token', async () => {
    await expect(loadActivityPage(db, { view: 'all', pageSize: 5, pageToken: 'nonsense' })).rejects.toBeInstanceOf(InvalidPageTokenError);
  });
});

describe('loadActivityPage horizon', () => {
  it('stops at the oldest scanned time when a filtered source hits its cap, then continues from it', async () => {
    // 350 allow rows of u1 the refused view must scan past, newest 1349 down to 1000
    for (let ms = 1000; ms < 1350; ms++) {
      decision(`sites/site-a/audit_log/a${ms}`, ms, { outcome: 'allow', denyReason: undefined });
    }
    decision('sites/site-a/audit_log/old', 500);
    decision('global/audit_log/entries/new', 2000);
    decision('global/audit_log/entries/mid', 800);

    const first = await loadActivityPage(db, { view: 'refused', userId: 'u1', pageSize: 5 });

    // 300 scanned: 1349..1050, so the platform row at 800 is below the horizon and held back
    expect(ids(first.rows)).toEqual(['platform:new']);
    expect(JSON.parse(Buffer.from(first.nextPageToken, 'base64url').toString())).toEqual({ t: 1050, ids: [] });

    const second = await loadActivityPage(db, { view: 'refused', userId: 'u1', pageSize: 5, pageToken: first.nextPageToken });

    expect(ids(second.rows)).toEqual(['platform:mid', 'decision:old']);
    expect(second.nextPageToken).toBe('');
  });
});

describe('loadActivityPage queries', () => {
  beforeEach(() => {
    change('c1', 5000);
    change('key1', 4900, { actor: 'apiKey:k1', kind: 'api_key_used' });
  });

  it('changes: collection group on event.kind in the mutation kinds, never api_key_used', async () => {
    const page = await loadActivityPage(db, { view: 'changes', pageSize: 10 });

    expect(ids(page.rows)).toEqual(['change:c1']);
    expect(queries).toEqual([{ scope: 'group:audit_log', where: [['event.kind', 'in', MUTATION_KINDS]], order: 'recordedAt' }]);
    expect(MUTATION_KINDS).not.toContain('api_key_used');
    expect(MUTATION_KINDS).toHaveLength(15);
  });

  it('refused: outcome in deny/error on the group and on the platform entries', async () => {
    await loadActivityPage(db, { view: 'refused', pageSize: 10 });

    expect(scopes()).toEqual(['global/audit_log/entries', 'group:audit_log']);
    for (const q of queries) {
      expect(q.where).toEqual([['outcome', 'in', ['deny', 'error']]]);
      expect(q.order).toBe('timestamp');
    }
  });

  it('sign-ins: capability in the auth capabilities on entries', async () => {
    await loadActivityPage(db, { view: 'sign-ins', pageSize: 10 });

    expect(queries).toEqual([{ scope: 'global/audit_log/entries', where: [['capability', 'in', AUTH_CAPABILITIES]], order: 'timestamp' }]);
  });

  it('flagged: findings by detectedAt', async () => {
    await loadActivityPage(db, { view: 'flagged', pageSize: 10 });

    expect(queries).toEqual([{ scope: 'global/activity_watch/findings', where: [], order: 'detectedAt' }]);
  });

  it('user filter: changes by the user and their keys, decisions by actor.userId, rest in memory', async () => {
    at('users/u1/api_keys/k1', {});
    change('mine', 4000, { actor: 'user:u1' });
    change('viaKey', 3000, { actor: 'apiKey:k1' });
    change('viaHoot', 2950, { actor: 'cortex:user_u1' });
    change('other', 3500, { actor: 'user:u2' });
    change('keyUsed', 3900, { actor: 'apiKey:k1', kind: 'api_key_used' });
    decision('global/audit_log/entries/allowed', 2000, { outcome: 'allow', denyReason: undefined, capability: 'SITE_READ' });
    decision('global/audit_log/entries/denied', 1900);
    decision('global/audit_log/entries/in1', 1800, { capability: 'AUTH_SIGN_IN', outcome: 'allow', denyReason: undefined });
    finding('fMine', 1000, { userId: 'u1' });
    finding('fOther', 900, { userId: 'u2' });

    const page = await loadActivityPage(db, { view: 'all', userId: 'u1', pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:c1', 'change:mine', 'change:viaKey', 'change:viaHoot', 'platform:denied', 'platform:in1', 'finding:fMine']);
    const byScope = (s: string) => queries.filter((q) => q.scope === s).map((q) => q.where);
    expect(byScope('group:audit_log')).toContainEqual([['event.actor', 'in', ['user:u1', 'cortex:user_u1', 'apiKey:k1']]]);
    expect(byScope('group:audit_log')).toContainEqual([['actor.userId', '==', 'u1']]);
    expect(byScope('global/audit_log/entries')).toEqual([[['actor.userId', '==', 'u1']], [['actor.userId', '==', 'u1']]]);
  });

  it('user filter: keeps the actor list inside the in-limit of 30', async () => {
    for (let i = 0; i < 40; i++) at(`users/u1/api_keys/k${i}`, {});

    await loadActivityPage(db, { view: 'changes', userId: 'u1', pageSize: 20 });

    const actors = queries.find((q) => q.scope === 'group:audit_log')!.where[0][2] as string[];
    expect(actors).toHaveLength(30);
    expect(actors.slice(0, 2)).toEqual(['user:u1', 'cortex:user_u1']);
  });

  it('site filter: reads the site collection only, filtering kinds and outcomes in memory', async () => {
    decision('sites/site-a/audit_log/d1', 4000);
    decision('sites/site-a/audit_log/read', 3000, { outcome: 'allow', denyReason: undefined });
    change('otherSite', 4500, { siteId: 'site-b' });
    decision('global/audit_log/entries/p1', 3500);
    finding('fSite', 1000, { siteId: 'site-a' });
    finding('fPlatform', 900, { siteId: null });

    const page = await loadActivityPage(db, { view: 'all', siteId: 'site-a', pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:c1', 'decision:d1', 'finding:fSite']);
    expect(scopes()).toEqual(['global/activity_watch/findings', 'sites/site-a/audit_log', 'sites/site-a/audit_log']);
    expect(queries.filter((q) => q.scope === 'sites/site-a/audit_log').map((q) => q.order).sort()).toEqual(['recordedAt', 'timestamp']);
  });
});

describe('loadActivitySince', () => {
  it('returns every change, refused, auth and site-delete row after the bound, all descending with a > bound', async () => {
    change('old', 900);
    change('c1', 2000);
    change('key1', 2100, { kind: 'api_key_used' });
    decision('sites/site-a/audit_log/d1', 3000);
    decision('sites/site-a/audit_log/read', 3100, { outcome: 'allow', denyReason: undefined });
    decision('global/audit_log/entries/p1', 4000);
    decision('global/audit_log/entries/s1', 5000, { capability: 'AUTH_SIGN_IN', outcome: 'deny' });
    decision('global/audit_log/entries/del', 6000, { capability: 'SITE_DELETE', outcome: 'allow', denyReason: undefined });
    decision('global/audit_log/entries/oldDel', 800, { capability: 'SITE_DELETE', outcome: 'allow', denyReason: undefined });

    const rows = await loadActivitySince(db, 1000);

    expect(ids(rows)).toEqual(['platform:del', 'platform:s1', 'platform:p1', 'decision:d1', 'change:c1']);
    expect(rows.find((r) => r.id === 'decision:d1')?.siteId).toBe('site-a');
    expect(rows.find((r) => r.id === 'platform:del')?.siteId).toBeNull();
    expect(queries).toHaveLength(5);
    for (const q of queries) {
      expect(q.order === 'recordedAt' || q.order === 'timestamp').toBe(true);
      expect(q.where.some(([f, op]) => f === q.order && op === '>')).toBe(true);
    }
  });
});
