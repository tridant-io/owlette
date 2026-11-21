/**
 * @jest-environment node
 */

import { Timestamp } from 'firebase-admin/firestore';
import { attachSubjects, loadActivityPage, loadActivitySince, InvalidPageTokenError } from '@/lib/activity/feed.server';
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
  const [a, b] = [v as number, num(value) as number];
  return op === '<' ? a < b : op === '<=' ? a <= b : op === '>=' ? a >= b : a > b;
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

const change = (id: string, recordedAt: number, o: { siteId?: string; actor?: string; kind?: string; verb?: string } = {}) =>
  at(`sites/${o.siteId ?? 'site-a'}/audit_log/${id}`, {
    event: { kind: o.kind ?? 'user_mutated', siteId: o.siteId ?? 'site-a', actor: o.actor ?? 'user:u1', occurredAt: recordedAt, attributes: { verb: o.verb ?? 'promoted' } },
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
    // 3,500 allow rows of u1 the refused view must scan past, newest 4499 down to 1000
    for (let ms = 1000; ms < 4500; ms++) {
      decision(`sites/site-a/audit_log/a${ms}`, ms, { outcome: 'allow', denyReason: undefined });
    }
    decision('sites/site-a/audit_log/old', 500);
    decision('global/audit_log/entries/new', 5000);
    decision('global/audit_log/entries/mid', 800);

    const first = await loadActivityPage(db, { view: 'refused', userIds: ['u1'], pageSize: 5 });

    // 3,200 scanned: 4499..1300, so the platform row at 800 is below the horizon and held back
    expect(ids(first.rows)).toEqual(['platform:new']);
    expect(JSON.parse(Buffer.from(first.nextPageToken, 'base64url').toString())).toEqual({ t: 1300, ids: [] });

    const second = await loadActivityPage(db, { view: 'refused', userIds: ['u1'], pageSize: 5, pageToken: first.nextPageToken });

    expect(ids(second.rows)).toEqual(['platform:mid', 'decision:old']);
    expect(second.nextPageToken).toBe('');
  });
});

describe('loadActivityPage date range', () => {
  const seed = () => {
    change('before', 900);
    change('since', 1000);
    decision('sites/site-a/audit_log/mid', 1500);
    decision('global/audit_log/entries/signin', 1800, { capability: 'AUTH_SIGN_IN', outcome: 'allow', denyReason: undefined });
    decision('global/audit_log/entries/until', 2000);
    finding('after', 2100);
  };

  it('keeps every source to rows from since to until, both included', async () => {
    seed();

    const page = await loadActivityPage(db, { view: 'all', pageSize: 10, sinceMs: 1000, untilMs: 2000 });

    expect(ids(page.rows)).toEqual(['platform:until', 'platform:signin', 'decision:mid', 'change:since']);
    expect(page.nextPageToken).toBe('');
    for (const q of queries) {
      expect(q.where.some(([f, op]) => f === q.order && op === '>=')).toBe(true);
    }
  });

  it('pages inside the range with none lost, repeated or outside it', async () => {
    seed();

    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof loadActivityPage>> = await loadActivityPage(db, {
        view: 'all',
        pageSize: 1,
        pageToken: token,
        sinceMs: 1000,
        untilMs: 2000,
      });
      seen.push(...ids(page.rows));
      token = page.nextPageToken || null;
      pages += 1;
    } while (token && pages < 20);

    expect(seen).toEqual(['platform:until', 'platform:signin', 'decision:mid', 'change:since']);
  });

  it('takes either bound alone', async () => {
    seed();

    const since = await loadActivityPage(db, { view: 'all', pageSize: 10, sinceMs: 1800 });
    const until = await loadActivityPage(db, { view: 'all', pageSize: 10, untilMs: 1000 });

    expect(ids(since.rows)).toEqual(['finding:after', 'platform:until', 'platform:signin']);
    expect(ids(until.rows)).toEqual(['change:since', 'change:before']);
  });
});

const routine = (id: string, recordedAt: number, o: { siteId?: string; actor?: string } = {}) =>
  change(id, recordedAt, { ...o, kind: 'site_mutated', verb: 'fleet_session_minted' });

describe('loadActivityPage routine rows', () => {
  it('omits routine fleet session rows from a mixed page and keeps the order', async () => {
    change('c1', 5000);
    routine('r1', 4500);
    change('c2', 4000);
    routine('r2', 3500);
    change('c3', 3000, { kind: 'site_mutated', verb: 'renamed' });

    for (const view of ['all', 'changes'] as const) {
      const page = await loadActivityPage(db, { view, pageSize: 10 });
      expect(ids(page.rows)).toEqual(['change:c1', 'change:c2', 'change:c3']);
      expect(page.nextPageToken).toBe('');
    }
  });

  it('hides them under the site filter and under the user filter', async () => {
    change('c1', 5000, { actor: 'user:u1' });
    routine('r1', 4500, { actor: 'machine:m1' });
    routine('r2', 4400, { actor: 'user:u1' });

    const site = await loadActivityPage(db, { view: 'all', siteIds: ['site-a'], pageSize: 10 });
    const user = await loadActivityPage(db, { view: 'all', userIds: ['u1'], pageSize: 10 });

    expect(ids(site.rows)).toEqual(['change:c1']);
    expect(ids(user.rows)).toEqual(['change:c1']);
  });

  it('reaches every real row behind a long run of routine ones, none lost or repeated', async () => {
    for (let ms = 1000; ms < 4500; ms++) routine(`r${ms}`, ms);
    for (let n = 1; n <= 5; n++) change(`real${n}`, 100 + n);

    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof loadActivityPage>> = await loadActivityPage(db, { view: 'all', pageSize: 3, pageToken: token });
      seen.push(...ids(page.rows));
      token = page.nextPageToken || null;
      pages += 1;
    } while (token && pages < 10);

    expect(seen).toEqual(['change:real5', 'change:real4', 'change:real3', 'change:real2', 'change:real1']);
    expect(pages).toBeLessThanOrEqual(4);
  });

  it('answers a page that scanned only routine rows with no rows and a token', async () => {
    for (let ms = 1000; ms < 4500; ms++) routine(`r${ms}`, ms);
    change('real', 500);

    const first = await loadActivityPage(db, { view: 'changes', pageSize: 5 });

    // a probe of 6, doubling until the cap of 3,200: 4499 down to 1300
    expect(first.rows).toEqual([]);
    expect(JSON.parse(Buffer.from(first.nextPageToken, 'base64url').toString())).toEqual({ t: 1300, ids: [] });
  });

  it("fills the first page past dev's 3,000 old renewals in one request and a handful of reads", async () => {
    for (let ms = 1000; ms < 4000; ms++) routine(`r${ms}`, ms);
    for (let n = 1; n <= 5; n++) change(`real${n}`, 100 + n);
    decision('global/audit_log/entries/p1', 50);

    const page = await loadActivityPage(db, { view: 'all', pageSize: 50 });

    expect(ids(page.rows)).toEqual([
      'change:real5',
      'change:real4',
      'change:real3',
      'change:real2',
      'change:real1',
      'platform:p1',
    ]);
    expect(page.nextPageToken).toBe('');
    // a probe of 51, then doubling: 102, 204, 408, 816, and the rest of the cap
    expect(queries.filter((q) => q.order === 'recordedAt')).toHaveLength(6);
  });

  it('costs one read of page size plus one when nothing is routine', async () => {
    for (let n = 1; n <= 8; n++) change(`c${n}`, 1000 + n);

    await loadActivityPage(db, { view: 'all', pageSize: 5 });

    expect(queries.filter((q) => q.order === 'recordedAt')).toHaveLength(1);
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

    const page = await loadActivityPage(db, { view: 'all', userIds: ['u1'], pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:c1', 'change:mine', 'change:viaKey', 'change:viaHoot', 'platform:denied', 'platform:in1', 'finding:fMine']);
    const byScope = (s: string) => queries.filter((q) => q.scope === s).map((q) => q.where);
    expect(byScope('group:audit_log')).toContainEqual([['event.actor', 'in', ['user:u1', 'cortex:user_u1', 'apiKey:k1']]]);
    expect(byScope('group:audit_log')).toContainEqual([['actor.userId', '==', 'u1']]);
    expect(byScope('global/audit_log/entries')).toEqual([[['actor.userId', '==', 'u1']], [['actor.userId', '==', 'u1']]]);
  });

  it('user filter: keeps the actor list inside the in-limit of 30', async () => {
    for (let i = 0; i < 40; i++) at(`users/u1/api_keys/k${i}`, {});

    await loadActivityPage(db, { view: 'changes', userIds: ['u1'], pageSize: 20 });

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

    const page = await loadActivityPage(db, { view: 'all', siteIds: ['site-a'], pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:c1', 'decision:d1', 'finding:fSite']);
    expect(scopes()).toEqual(['global/activity_watch/findings', 'sites/site-a/audit_log', 'sites/site-a/audit_log']);
    expect(queries.filter((q) => q.scope === 'sites/site-a/audit_log').map((q) => q.order).sort()).toEqual(['recordedAt', 'timestamp']);
  });
});

describe('loadActivityPage with several users or sites', () => {
  const byScope = (s: string) => queries.filter((q) => q.scope === s).map((q) => q.where);
  const userActor = (userId: string) => ({ actor: { type: 'user', userId, role: 'admin' } });

  it('several users: changes by any of their actors, decisions by actor.userId in, findings in memory', async () => {
    at('users/u1/api_keys/k1', {});
    change('mine', 5000, { actor: 'user:u1' });
    change('viaKey', 4900, { actor: 'apiKey:k1' });
    change('theirs', 4800, { actor: 'user:u2' });
    change('theirHoot', 4700, { actor: 'cortex:user_u2' });
    change('other', 4600, { actor: 'user:u3' });
    decision('sites/site-a/audit_log/d2', 4000, userActor('u2'));
    decision('sites/site-a/audit_log/d3', 3900, userActor('u3'));
    decision('global/audit_log/entries/in1', 3000, { capability: 'AUTH_SIGN_IN', outcome: 'allow', denyReason: undefined });
    decision('global/audit_log/entries/in3', 2900, { ...userActor('u3'), capability: 'AUTH_SIGN_IN', outcome: 'allow', denyReason: undefined });
    finding('f1', 1000, { userId: 'u1' });
    finding('f2', 900, { userId: 'u2' });
    finding('f3', 800, { userId: 'u3' });

    const page = await loadActivityPage(db, { view: 'all', userIds: ['u1', 'u2'], pageSize: 20 });

    expect(ids(page.rows)).toEqual([
      'change:mine',
      'change:viaKey',
      'change:theirs',
      'change:theirHoot',
      'decision:d2',
      'platform:in1',
      'finding:f1',
      'finding:f2',
    ]);
    expect(byScope('group:audit_log')).toContainEqual([['event.actor', 'in', ['user:u1', 'cortex:user_u1', 'apiKey:k1', 'user:u2', 'cortex:user_u2']]]);
    expect(byScope('group:audit_log')).toContainEqual([['actor.userId', 'in', ['u1', 'u2']]]);
    expect(byScope('global/audit_log/entries')).toEqual([[['actor.userId', 'in', ['u1', 'u2']]], [['actor.userId', 'in', ['u1', 'u2']]]]);
  });

  it('splits the actors of several users past the in-limit of 30 into several queries, none dropped', async () => {
    for (let i = 0; i < 28; i++) at(`users/u1/api_keys/k${String(i).padStart(2, '0')}`, {});
    change('lastKey', 5000, { actor: 'apiKey:k27' });
    change('secondUser', 4000, { actor: 'cortex:user_u2' });

    const page = await loadActivityPage(db, { view: 'changes', userIds: ['u1', 'u2'], pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:lastKey', 'change:secondUser']);
    const lists = byScope('group:audit_log').map((where) => where[0][2] as string[]);
    expect(lists.map((l) => l.length)).toEqual([30, 2]);
    expect(lists[1]).toEqual(['user:u2', 'cortex:user_u2']);
  });

  it('several sites: reads each site collection, filters findings in memory, and leaves out platform rows', async () => {
    change('a1', 5000, { siteId: 'site-a' });
    change('b1', 4900, { siteId: 'site-b' });
    change('c1', 4800, { siteId: 'site-c' });
    decision('sites/site-b/audit_log/db', 4000);
    decision('sites/site-c/audit_log/dc', 3900);
    decision('global/audit_log/entries/p1', 3500);
    decision('global/audit_log/entries/s1', 3400, { capability: 'AUTH_SIGN_IN', outcome: 'allow', denyReason: undefined });
    finding('fa', 1000, { siteId: 'site-a' });
    finding('fb', 900, { siteId: 'site-b' });
    finding('fc', 800, { siteId: 'site-c' });
    finding('fPlatform', 700, { siteId: null });

    const page = await loadActivityPage(db, { view: 'all', siteIds: ['site-a', 'site-b'], pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:a1', 'change:b1', 'decision:db', 'finding:fa', 'finding:fb']);
    expect(page.rows.find((r) => r.id === 'decision:db')?.siteId).toBe('site-b');
    expect(scopes()).toEqual([
      'global/activity_watch/findings',
      'sites/site-a/audit_log',
      'sites/site-a/audit_log',
      'sites/site-b/audit_log',
      'sites/site-b/audit_log',
    ]);
  });

  it('several users on several sites: each site, by any of the users or their keys', async () => {
    at('users/u2/api_keys/k2', {});
    change('a-u1', 5000, { siteId: 'site-a', actor: 'user:u1' });
    change('b-key', 4900, { siteId: 'site-b', actor: 'apiKey:k2' });
    change('b-u3', 4800, { siteId: 'site-b', actor: 'user:u3' });
    change('c-u1', 4700, { siteId: 'site-c', actor: 'user:u1' });
    decision('sites/site-b/audit_log/d-u2', 4000, userActor('u2'));
    decision('sites/site-a/audit_log/d-u3', 3900, userActor('u3'));
    finding('f-a-u1', 1000, { userId: 'u1', siteId: 'site-a' });
    finding('f-c-u1', 900, { userId: 'u1', siteId: 'site-c' });
    finding('f-b-u3', 800, { userId: 'u3', siteId: 'site-b' });

    const page = await loadActivityPage(db, { view: 'all', userIds: ['u1', 'u2'], siteIds: ['site-a', 'site-b'], pageSize: 20 });

    expect(ids(page.rows)).toEqual(['change:a-u1', 'change:b-key', 'decision:d-u2', 'finding:f-a-u1']);
  });

  it('pages through several sites sharing one millisecond with none lost or repeated', async () => {
    for (const n of [1, 2, 3]) {
      change(`a${n}`, 1000, { siteId: 'site-a' });
      change(`b${n}`, 1000, { siteId: 'site-b' });
    }
    change('older', 900, { siteId: 'site-b' });

    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof loadActivityPage>> = await loadActivityPage(db, {
        view: 'changes',
        siteIds: ['site-a', 'site-b'],
        pageSize: 2,
        pageToken: token,
      });
      seen.push(...ids(page.rows));
      token = page.nextPageToken || null;
      pages += 1;
    } while (token && pages < 20);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[seen.length - 1]).toBe('change:older');
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

describe('loadActivitySince routine rows', () => {
  it('still returns them', async () => {
    change('c1', 2000);
    routine('r1', 3000);

    expect(ids(await loadActivitySince(db, 1000))).toEqual(['change:r1', 'change:c1']);
  });
});

describe('attachSubjects', () => {
  const started = (path: string, viewerId: string, actor: Data = { type: 'user', userId: 'u9', role: 'admin' }) =>
    at(path, { actor, capability: 'MACHINE_REMOTE_CONTROL', outcome: 'allow', metadata: { event: 'session_started', viewerId }, timestamp: Timestamp.fromMillis(1000) });
  const hostRow = (id: string, viewerId: unknown = 'v1', over: Partial<ActivityRow> = {}): ActivityRow => ({
    id,
    kind: 'refused',
    at: 5000,
    actor: { type: 'system', id: 'swoop_host' },
    siteId: 'site-a',
    action: 'MACHINE_REMOTE_CONTROL',
    outcome: 'deny',
    details: { viewerId },
    ...over,
  });
  const lookups = () => queries.filter((q) => q.scope === 'sites/site-a/audit_log');

  it('names the viewer from the session start row of the same site', async () => {
    started('sites/site-a/audit_log/s1', 'v1');
    started('sites/site-b/audit_log/s2', 'v1', { type: 'user', userId: 'other', role: 'admin' });
    const rows = [hostRow('decision:h1')];

    await attachSubjects(db, rows);

    expect(rows[0].subject).toEqual({ type: 'user', id: 'u9' });
    expect(lookups()[0].where).toEqual([['metadata.viewerId', '==', 'v1']]);
    expect(lookups()[0].order).toBeUndefined();
  });

  it('costs one lookup for two rows of the same viewer', async () => {
    started('sites/site-a/audit_log/s1', 'v1');
    const rows = [hostRow('decision:h1'), hostRow('decision:h2')];

    await attachSubjects(db, rows);

    expect(lookups()).toHaveLength(1);
    expect(rows.map((r) => r.subject?.id)).toEqual(['u9', 'u9']);
  });

  it('leaves a row alone when no user row names the viewer', async () => {
    started('sites/site-a/audit_log/s1', 'v1', { type: 'system', name: 'swoop_host' });
    const rows = [hostRow('decision:h1')];

    await attachSubjects(db, rows);

    expect(rows[0].subject).toBeUndefined();
  });

  it('does not fail the page when a lookup rejects', async () => {
    const broken: any = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ get: () => Promise.reject(new Error('boom')) }) }) }) }) }) }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rows = [hostRow('decision:h1')];

    await expect(attachSubjects(broken, rows)).resolves.toBeUndefined();

    expect(rows[0].subject).toBeUndefined();
  });

  it('looks nothing up for a user actor, a row with a subject, no site or no viewer id', async () => {
    const rows = [
      hostRow('decision:a', 'v1', { actor: { type: 'user', id: 'u1' } }),
      hostRow('decision:b', 'v1', { subject: { type: 'user', id: 'u2' } }),
      hostRow('decision:c', 'v1', { siteId: null }),
      hostRow('decision:d', null),
      hostRow('decision:e', 7),
    ];

    await attachSubjects(db, rows);

    expect(queries).toHaveLength(0);
  });

  it('runs for a page', async () => {
    started('sites/site-a/audit_log/s1', 'v1');
    decision('sites/site-a/audit_log/h1', 5000, {
      actor: { type: 'system', name: 'swoop_host' },
      metadata: { event: 'input_not_permitted', viewerId: 'v1' },
    });

    const page = await loadActivityPage(db, { view: 'refused', pageSize: 10 });

    expect(page.rows[0].subject).toEqual({ type: 'user', id: 'u9' });
  });
});
