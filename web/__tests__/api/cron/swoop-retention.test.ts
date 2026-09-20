/** @jest-environment node */

/**
 * GET /api/cron/swoop-retention.
 *
 * Two things have to be true of this sweep and are not obvious from reading it:
 * a record past its 12-hour cap is CLOSED rather than left answering as live to
 * the revocation sweep, and a session inside the retention window SURVIVES —
 * which is only observable if the query stub actually applies the cutoff rather
 * than handing back whatever it was seeded with.
 */

import { NextRequest } from 'next/server';

const mockWriterClose = jest.fn().mockResolvedValue(undefined);
const mockOnWriteError = jest.fn();
const mockSitesGet = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface SessionDoc {
  id: string;
  state?: string;
  startedAt?: number;
  absoluteExpiresAt?: number;
  viewers?: unknown[];
  endReason?: string;
}

/** Session backlogs keyed `${siteId}/${machineId}`. */
const sessions = new Map<string, SessionDoc[]>();
/** Machine ids per site, in traversal order. */
const machines = new Map<string, string[]>();
/** Every document id this run deleted. */
const deletedIds: string[] = [];
/** Every recorded query, so the shape can be asserted rather than assumed. */
const queryLog: Array<{ where: unknown[][]; limit?: number }> = [];

function backlog(siteId: string, machineId: string): SessionDoc[] {
  const key = `${siteId}/${machineId}`;
  if (!sessions.has(key)) sessions.set(key, []);
  return sessions.get(key) as SessionDoc[];
}

function matches(doc: SessionDoc, filters: unknown[][]): boolean {
  return filters.every(([field, op, value]) => {
    if (field === 'state' && op === 'in') return (value as string[]).includes(doc.state ?? '');
    if (field === 'startedAt' && op === '<') {
      // Loud on purpose: a window quietly switched to '<=' would otherwise pass.
      return typeof doc.startedAt === 'number' && doc.startedAt < (value as number);
    }
    throw new Error(`unexpected swoop retention filter: ${String(field)} ${String(op)}`);
  });
}

function sessionDocRef(siteId: string, machineId: string, id: string) {
  return {
    path: `sites/${siteId}/machines/${machineId}/swoop_sessions/${id}`,
    __site: siteId,
    __machine: machineId,
    __id: id,
    get: async () => {
      const doc = backlog(siteId, machineId).find((d) => d.id === id);
      return { exists: doc !== undefined, data: () => doc };
    },
    // Merged in place, as `{ merge: true }` is: a test holding a reference to a
    // seeded document can then assert what the sweep did to it.
    set: async (data: Record<string, unknown>) => {
      const list = backlog(siteId, machineId);
      const doc = list.find((d) => d.id === id);
      if (doc) Object.assign(doc, data);
      else list.push({ id, ...data } as SessionDoc);
    },
  };
}

function sessionQuery(siteId: string, machineId: string) {
  const entry: { where: unknown[][]; limit?: number } = { where: [] };
  queryLog.push(entry);
  let pageSize = Number.MAX_SAFE_INTEGER;
  const q = {
    where: (...args: unknown[]) => {
      entry.where.push(args);
      return q;
    },
    orderBy: () => q,
    limit: (n: number) => {
      entry.limit = n;
      pageSize = n;
      return q;
    },
    doc: (id: string) => sessionDocRef(siteId, machineId, id),
    get: async () => {
      const page = backlog(siteId, machineId)
        .filter((doc) => matches(doc, entry.where))
        .slice(0, pageSize);
      return {
        empty: page.length === 0,
        size: page.length,
        docs: page.map((doc) => ({
          id: doc.id,
          data: () => doc,
          ref: sessionDocRef(siteId, machineId, doc.id),
        })),
      };
    },
  };
  return q;
}

function machineRef(siteId: string, machineId: string) {
  return { collection: () => sessionQuery(siteId, machineId) };
}

function siteRef(siteId: string) {
  return {
    collection: () => ({
      get: async () => ({
        docs: (machines.get(siteId) ?? []).map((id) => ({ id, ref: machineRef(siteId, id) })),
      }),
    }),
  };
}

const mockDb = {
  collection: (name: string) => {
    if (name !== 'sites') throw new Error(`unexpected root collection: ${name}`);
    return {
      get: mockSitesGet,
      doc: (siteId: string) => ({
        collection: () => ({
          doc: (machineId: string) => machineRef(siteId, machineId),
        }),
      }),
    };
  },
  bulkWriter: () => ({
    onWriteError: mockOnWriteError,
    close: mockWriterClose,
    delete: async (ref: { __site: string; __machine: string; __id: string }) => {
      const list = backlog(ref.__site, ref.__machine);
      const index = list.findIndex((d) => d.id === ref.__id);
      if (index >= 0) list.splice(index, 1);
      deletedIds.push(ref.__id);
    },
  }),
};

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDb }));

import { GET, SWOOP_SESSION_RETENTION_DAYS } from '@/app/api/cron/swoop-retention/route';

const SITE = 'site-a';
const MACHINE = 'machine-1';

/** A session document that started `days` ago and ran its full 12-hour cap. */
function session(id: string, days: number, state = 'ended'): SessionDoc {
  const startedAt = Date.now() - days * DAY_MS;
  return { id, state, startedAt, absoluteExpiresAt: startedAt + 12 * HOUR_MS, viewers: [] };
}

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/swoop-retention', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

function seed(...docs: SessionDoc[]): void {
  machines.set(SITE, [MACHINE]);
  sessions.set(`${SITE}/${MACHINE}`, docs);
  mockSitesGet.mockResolvedValue({ docs: [{ id: SITE, ref: siteRef(SITE) }] });
}

describe('GET /api/cron/swoop-retention', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    sessions.clear();
    machines.clear();
    deletedIds.length = 0;
    queryLog.length = 0;
    process.env.CRON_SECRET = 'cron-secret';
    mockSitesGet.mockResolvedValue({ docs: [] });
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a missing cron secret before reading anything', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockSitesGet).not.toHaveBeenCalled();
  });

  it('rejects a wrong cron secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(mockSitesGet).not.toHaveBeenCalled();
  });

  it('reports nothing to do on an empty fleet', async () => {
    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      closed: 0,
      deleted: { swoopSessions: 0 },
      truncated: false,
      retentionDays: { swoopSessions: SWOOP_SESSION_RETENTION_DAYS },
    });
  });

  /**
   * The window is a decision, not an implementation detail: literal day counts,
   * NOT SWOOP_SESSION_RETENTION_DAYS ± 1, so a window quietly widened to a year
   * fails here instead of passing with the constant it moved.
   */
  it('deletes sessions past 30 days and leaves one inside the window', async () => {
    seed(session('old', 31), session('ancient', 400), session('recent', 29));

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.swoopSessions).toBe(2);
    expect(deletedIds.sort()).toEqual(['ancient', 'old']);
    expect(backlog(SITE, MACHINE).map((d) => d.id)).toEqual(['recent']);
    expect(body.truncated).toBe(false);
  });

  it('stays well inside the 400-day retention commitment', () => {
    // 400 days is the ceiling the privacy policy commits to, not the target for
    // a record of who watched which machine.
    expect(SWOOP_SESSION_RETENTION_DAYS).toBeLessThan(400);
  });

  it('deletes by startedAt, so a record that never ended goes too', async () => {
    seed(session('never-closed', 31, 'pending'));

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.swoopSessions).toBe(1);
    expect(deletedIds).toEqual(['never-closed']);
  });

  /**
   * The abandoned record is the expensive one: until it is closed it answers as
   * live to `listUnendedSwoopSessionsForUser`, so every membership change
   * re-kills a session that ended weeks ago.
   */
  it('closes a record still pending past its 12-hour cap', async () => {
    const abandoned = session('abandoned', 2, 'pending');
    seed(abandoned);

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.closed).toBe(1);
    expect(abandoned).toMatchObject({ state: 'ended', endReason: 'session_cap', viewers: [] });
    expect(deletedIds).toEqual([]);
  });

  it('leaves a session still inside its cap alone', async () => {
    const live: SessionDoc = {
      id: 'running',
      state: 'live',
      startedAt: Date.now() - HOUR_MS,
      absoluteExpiresAt: Date.now() + 11 * HOUR_MS,
      viewers: [{ viewerId: 'v1', uid: 'uid-1', ctl: false, joinedAt: 1, leaseExpiresAt: 2 }],
    };
    seed(live);

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.closed).toBe(0);
    expect(live.state).toBe('live');
    expect(deletedIds).toEqual([]);
  });

  it('never re-closes a record that already ended', async () => {
    const ended = session('done', 2);
    ended.endReason = 'killed';
    seed(ended);

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.closed).toBe(0);
    expect(ended.endReason).toBe('killed');
  });

  it('drains a machine across multiple pages in one run', async () => {
    // 900 stale sessions: more than one 400-doc page, inside the 2000 budget. A
    // one-page-per-machine loop deletes 400 and still reports truncated:false.
    seed(...Array.from({ length: 900 }, (_, i) => session(`s${i}`, 31)));

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.swoopSessions).toBe(900);
    expect(body.truncated).toBe(false);
    expect(backlog(SITE, MACHINE)).toHaveLength(0);
  });

  it('stops at the per-run ceiling and flags truncated', async () => {
    seed(...Array.from({ length: 2500 }, (_, i) => session(`s${i}`, 31)));

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.swoopSessions).toBe(2000);
    expect(body.truncated).toBe(true);
    expect(backlog(SITE, MACHINE)).toHaveLength(500);
  });

  /**
   * One filter per query, deliberately. `swoop_sessions` has no entry in
   * firestore.indexes.json, so a second filter would need a composite index
   * that does not exist and the sweep would fail in production only.
   */
  it('filters on one field per query, so no composite index is needed', async () => {
    seed(session('abandoned', 2, 'pending'));

    await GET(request('cron-secret'));

    const filtered = queryLog.filter((q) => q.where.length > 0);
    expect(filtered.every((q) => q.where.length === 1)).toBe(true);
    expect(filtered.map((q) => q.where[0][0]).sort()).toEqual(['startedAt', 'state']);
  });

  it('sweeps every machine in every site', async () => {
    machines.set('site-a', ['m1', 'm2']);
    machines.set('site-b', ['m3']);
    sessions.set('site-a/m1', [session('a1', 31)]);
    sessions.set('site-a/m2', [session('a2', 31)]);
    sessions.set('site-b/m3', [session('b1', 31)]);
    mockSitesGet.mockResolvedValue({
      docs: [
        { id: 'site-a', ref: siteRef('site-a') },
        { id: 'site-b', ref: siteRef('site-b') },
      ],
    });

    const body = await (await GET(request('cron-secret'))).json();

    expect(body.deleted.swoopSessions).toBe(3);
    expect(deletedIds.sort()).toEqual(['a1', 'a2', 'b1']);
  });
});
