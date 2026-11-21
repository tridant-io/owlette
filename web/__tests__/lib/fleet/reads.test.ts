/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));

import {
  readAlertRules,
  readAuditLog,
  readInstalledSoftware,
  readMetricsHistory,
} from '@/lib/fleet/reads.server';

type Data = Record<string, unknown>;
type Where = [unknown, string, unknown];
interface QueryState {
  wheres: Where[];
  order?: [unknown, 'asc' | 'desc'];
  max?: number;
}

// an in-memory stand-in for the admin sdk: collections, doc refs, where / orderBy / limit
function query(path: string, store: Record<string, Data>, state: QueryState = { wheres: [] }): unknown {
  const fieldOf = (field: unknown, id: string, data: Data) => (typeof field === 'string' ? data[field] : id);
  return {
    where: (field: unknown, op: string, value: unknown) =>
      query(path, store, { ...state, wheres: [...state.wheres, [field, op, value]] }),
    orderBy: (field: unknown, dir: 'asc' | 'desc' = 'asc') => query(path, store, { ...state, order: [field, dir] }),
    limit: (max: number) => query(path, store, { ...state, max }),
    doc: (id: string) => docRef(`${path}/${id}`, store),
    get: async () => {
      let rows = Object.keys(store)
        .filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
        .map((key) => ({ id: key.slice(path.length + 1), data: store[key] }));
      for (const [field, op, value] of state.wheres) {
        rows = rows.filter((row) => {
          const actual = fieldOf(field, row.id, row.data) as string | number;
          if (op === 'in') return (value as unknown[]).includes(actual);
          if (op === '>=') return actual >= (value as string | number);
          if (op === '<=') return actual <= (value as string | number);
          throw new Error(`fake db: no ${op}`);
        });
      }
      if (state.order) {
        const [field, dir] = state.order;
        rows.sort((a, b) => {
          const x = fieldOf(field, a.id, a.data) as string | number;
          const y = fieldOf(field, b.id, b.data) as string | number;
          return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
      }
      if (state.max !== undefined) rows = rows.slice(0, state.max);
      const docs = rows.map((row) => ({ id: row.id, data: () => row.data }));
      return { docs, size: docs.length };
    },
  };
}

function docRef(path: string, store: Record<string, Data>) {
  return {
    get: async () => ({ exists: path in store, data: () => store[path] }),
    collection: (name: string) => query(`${path}/${name}`, store),
  };
}

function makeDb(store: Record<string, Data>): Firestore {
  return { collection: (name: string) => query(name, store) } as unknown as Firestore;
}

const SITE = 'site-a';
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const seconds = (iso: string) => Date.parse(iso) / 1000;
const history = (machine: string, bucket: string) => `sites/${SITE}/machines/${machine}/metrics_history/${bucket}`;

describe('readMetricsHistory', () => {
  const opts = { hours: 2, metrics: ['cpu_percent', 'memory_percent'] as const, maxPoints: 200, now: NOW };

  it('keeps only samples inside the range, from hourly and daily buckets', async () => {
    const db = makeDb({
      [history('m1', '2026-11-11-09')]: { samples: [{ t: seconds('2026-11-11T09:59:00Z'), c: 1, m: 1 }] },
      [history('m1', '2026-11-11-10')]: { samples: [{ t: seconds('2026-11-11T10:30:00Z'), c: 10, m: 20 }] },
      [history('m1', '2026-11-11')]: { samples: [{ t: seconds('2026-11-11T11:00:00Z'), c: 30, m: 40 }] },
      [history('m1', '2026-11-11-12')]: { samples: [{ t: seconds('2026-11-11T12:30:00Z'), c: 99, m: 99 }] },
    });

    const result = await readMetricsHistory(db, SITE, 'm1', opts);

    expect(result.from).toBe('2026-11-11T10:00:00.000Z');
    expect(result.to).toBe('2026-11-11T12:00:00.000Z');
    expect(result.points).toEqual([
      { time: '2026-11-11T10:30:00.000Z', cpu_percent: 10, memory_percent: 20 },
      { time: '2026-11-11T11:00:00.000Z', cpu_percent: 30, memory_percent: 40 },
    ]);
    expect(result.sampleCount).toBe(2);
    expect(result.downsampled).toBe(false);
  });

  it('returns only the metrics asked for, and leaves out ones the sample lacks', async () => {
    const db = makeDb({
      [history('m1', '2026-11-11-11')]: { samples: [{ t: seconds('2026-11-11T11:00:00Z'), c: 5, m: 6, ct: 70 }] },
    });

    const result = await readMetricsHistory(db, SITE, 'm1', { ...opts, metrics: ['cpu_temp', 'gpu_temp'] });

    expect(result.points).toEqual([{ time: '2026-11-11T11:00:00.000Z', cpu_temp: 70 }]);
  });

  it('downsamples to at most max_points and says so', async () => {
    const samples = Array.from({ length: 120 }, (_, i) => ({ t: seconds('2026-11-11T11:00:00Z') + i * 30, c: i, m: i }));
    const db = makeDb({ [history('m1', '2026-11-11-11')]: { samples } });

    const result = await readMetricsHistory(db, SITE, 'm1', { ...opts, maxPoints: 10 });

    expect(result.sampleCount).toBe(120);
    expect(result.downsampled).toBe(true);
    expect(result.points.length).toBeLessThanOrEqual(10);
    expect(result.points.length).toBeGreaterThan(1);
  });

  it('reads the named machine\'s buckets and no other\'s', async () => {
    const db = makeDb({
      [history('m2', '2026-11-11-11')]: { samples: [{ t: seconds('2026-11-11T11:00:00Z'), c: 5, m: 6 }] },
    });

    const result = await readMetricsHistory(db, SITE, 'm1', opts);

    expect(result.points).toEqual([]);
  });

  it('is empty when the machine has no history', async () => {
    const result = await readMetricsHistory(makeDb({}), SITE, 'm1', opts);

    expect(result).toMatchObject({ sampleCount: 0, downsampled: false, points: [] });
  });
});

describe('readInstalledSoftware', () => {
  const software = (machine: string, id: string) => `sites/${SITE}/machines/${machine}/installed_software/${id}`;
  const store = {
    [software('m1', 'a')]: { name: 'Zoom', version: '6.0', publisher: 'Zoom Inc', uninstall_command: 'secret-ish' },
    [software('m1', 'b')]: { name: 'Google Chrome', version: '130' },
    [software('m1', 'c')]: { name: 'chromium tools', version: '1' },
    [software('m2', 'd')]: { name: 'Other Machine App', version: '1' },
  };

  it('lists a machine\'s software by name, with name, version and publisher only', async () => {
    const result = await readInstalledSoftware(makeDb(store), SITE, 'm1', { limit: 100 });

    expect(result.entries).toEqual([
      { name: 'chromium tools', version: '1', publisher: null },
      { name: 'Google Chrome', version: '130', publisher: null },
      { name: 'Zoom', version: '6.0', publisher: 'Zoom Inc' },
    ]);
    expect(result.matched).toBe(3);
    expect(result.incomplete).toBe(false);
  });

  it('filters by name, ignoring case', async () => {
    const result = await readInstalledSoftware(makeDb(store), SITE, 'm1', { limit: 100, name: 'CHROM' });

    expect(result.entries.map((entry) => entry.name)).toEqual(['chromium tools', 'Google Chrome']);
  });

  it('caps the entries and still reports how many matched', async () => {
    const result = await readInstalledSoftware(makeDb(store), SITE, 'm1', { limit: 1 });

    expect(result.entries).toHaveLength(1);
    expect(result.matched).toBe(3);
  });

  it('says incomplete when the inventory fills the read', async () => {
    const big: Record<string, Data> = {};
    for (let i = 0; i < 2000; i++) big[software('m1', `s${i}`)] = { name: `app ${i}` };

    const result = await readInstalledSoftware(makeDb(big), SITE, 'm1', { limit: 5 });

    expect(result.incomplete).toBe(true);
    expect(result.matched).toBe(2000);
  });

  it('is empty when nothing is installed or nothing matches', async () => {
    expect((await readInstalledSoftware(makeDb({}), SITE, 'm1', { limit: 5 })).entries).toEqual([]);
    expect((await readInstalledSoftware(makeDb(store), SITE, 'm1', { limit: 5, name: 'nope' })).entries).toEqual([]);
  });
});

describe('readAlertRules', () => {
  const rule = {
    id: 'r1',
    name: 'rule r1',
    metric: 'cpu_percent',
    operator: '>',
    value: 90,
    severity: 'warning',
    channels: ['email', 3],
    enabled: true,
    cooldownMinutes: 30,
  };

  it('reads the rules and nothing else on the alerts document', async () => {
    const store = { [`sites/${SITE}/settings/alerts`]: { rules: [rule, { junk: true }], lastFired: { r1: 1 } } };

    expect(await readAlertRules(makeDb(store), SITE)).toEqual([{ ...rule, channels: ['email'] }]);
  });

  it('is empty when the site has no rules', async () => {
    expect(await readAlertRules(makeDb({}), SITE)).toEqual([]);
  });
});

describe('readAuditLog', () => {
  const row = (n: number, event: Data) => ({
    [`sites/${SITE}/audit_log/h${n}`]: { recordedAt: n * 1000, event: { kind: 'process_mutated', occurredAt: n, ...event } },
  });
  const store = {
    ...row(1, { actor: 'user:u1', target: 'm1' }),
    ...row(2, { actor: 'user:u1', target: 'proc-1', attributes: { machineId: 'm1' } }),
    ...row(3, { actor: 'machine:caller' }),
  };
  const hashes = async (opts: { limit: number; sinceMs?: number }) =>
    (await readAuditLog(makeDb(store), SITE, opts)).map((r) => r.hash);

  it('reads newest first', async () => {
    expect(await hashes({ limit: 50 })).toEqual(['h3', 'h2', 'h1']);
  });

  it('reads the row as the route does', async () => {
    expect((await readAuditLog(makeDb(store), SITE, { limit: 2 }))[1]).toEqual({
      hash: 'h2',
      kind: 'process_mutated',
      actor: 'user:u1',
      target: 'proc-1',
      occurredAt: 2,
      recordedAt: 2000,
      attributes: { machineId: 'm1' },
    });
  });

  it('keeps rows from since on', async () => {
    expect(await hashes({ limit: 50, sinceMs: 2000 })).toEqual(['h3', 'h2']);
  });

  it('caps the rows at the limit', async () => {
    expect(await hashes({ limit: 1 })).toEqual(['h3']);
  });

  it('is empty when the log is', async () => {
    expect(await readAuditLog(makeDb({}), SITE, { limit: 50 })).toEqual([]);
  });
});
