/** @jest-environment node */

/**
 * fleet sessions against an in-memory admin-sdk fake (the deviceTrust.test.ts
 * pattern, passed in as `db` rather than mocked through `getAdminDb`). the fake
 * answers equality filters only, so a query that would need a composite index
 * fails here before it fails in production.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import logger from '@/lib/logger';
import {
  FLEET_SESSION_TTL_MS,
  mintFleetSession,
  revokeFleetSessions,
  verifyFleetSession,
} from '@/lib/fleet/session.server';

type Data = Record<string, unknown>;

let store: Map<string, Data>;
let collectionsUsed: Set<string>;
let getCalls: string[];
let batchCommits: number;
let queryError: Error | null;
let deleteError: Error | null;

function docRef(id: string) {
  return {
    id,
    get: async () => {
      getCalls.push(id);
      const data = store.get(id);
      return { exists: data !== undefined, id, data: () => data };
    },
    set: async (payload: Data) => {
      store.set(id, payload);
    },
    update: async (payload: Data) => {
      store.set(id, { ...store.get(id), ...payload });
    },
    delete: async () => {
      if (deleteError) throw deleteError;
      store.delete(id);
    },
  };
}

function query(filters: Array<[string, unknown]>) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`fake firestore answers == only, got ${op}`);
      return query([...filters, [field, value]]);
    },
    get: async () => {
      if (queryError) throw queryError;
      const docs = [...store.entries()]
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .map(([id, data]) => ({ id, ref: docRef(id), data: () => data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  };
}

function makeDb(): Firestore {
  return {
    collection: (name: string) => {
      collectionsUsed.add(name);
      return { doc: docRef, where: query([]).where };
    },
    batch: () => {
      const pending: string[] = [];
      return {
        delete: (ref: { id: string }) => {
          pending.push(ref.id);
        },
        commit: async () => {
          batchCommits += 1;
          for (const id of pending) store.delete(id);
        },
      };
    },
  } as unknown as Firestore;
}

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

const T0 = 1_800_000_000_000;
let now: number;
let db: Firestore;

beforeEach(() => {
  jest.clearAllMocks();
  store = new Map();
  collectionsUsed = new Set();
  getCalls = [];
  batchCommits = 0;
  queryError = null;
  deleteError = null;
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  db = makeDb();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('mintFleetSession', () => {
  it('lasts 15 minutes', () => {
    expect(FLEET_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('returns an owf_ token and stores only its hash, with the subject and both instants', async () => {
    const { token, expiresAt } = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    expect(token).toMatch(/^owf_[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(T0 + FLEET_SESSION_TTL_MS);
    expect([...collectionsUsed]).toEqual(['fleet_sessions']);
    expect([...store.keys()]).toEqual([hashOf(token)]);
    expect(store.get(hashOf(token))).toEqual({
      siteId: 'site-a',
      machineId: 'm-1',
      createdAt: T0,
      expiresAt: T0 + FLEET_SESSION_TTL_MS,
    });
    expect(JSON.stringify([...store.values()])).not.toContain(token.slice(4));
  });

  it('mints a different token every time', async () => {
    const a = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });
    const b = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });
    expect(a.token).not.toBe(b.token);
  });
});

describe('verifyFleetSession', () => {
  it('returns the subject of a live session with one document read', async () => {
    const { token } = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });
    getCalls = [];

    await expect(verifyFleetSession(db, token)).resolves.toEqual({ siteId: 'site-a', machineId: 'm-1' });
    expect(getCalls).toEqual([hashOf(token)]);
  });

  it('returns null for a token it never minted', async () => {
    const unknown = `owf_${crypto.randomBytes(32).toString('base64url')}`;
    await expect(verifyFleetSession(db, unknown)).resolves.toBeNull();
  });

  it('refuses anything not shaped like a fleet token without reading', async () => {
    for (const bad of ['', 'owf_short', 'eyJhbGciOiJSUzI1NiJ9.e30.sig', `owk_live_${'a'.repeat(43)}`, `owf_${'a'.repeat(43)}=`]) {
      await expect(verifyFleetSession(db, bad)).resolves.toBeNull();
    }
    expect(getCalls).toEqual([]);
  });

  it('accepts the stored instant as a number, a Timestamp or a Date', async () => {
    const token = `owf_${'b'.repeat(43)}`;
    const later = T0 + 60_000;
    for (const expiresAt of [later, { toMillis: () => later }, new Date(later)]) {
      store.set(hashOf(token), { siteId: 'site-a', machineId: 'm-1', createdAt: T0, expiresAt });
      await expect(verifyFleetSession(db, token)).resolves.toEqual({ siteId: 'site-a', machineId: 'm-1' });
    }
  });

  it('returns null for a malformed record and leaves it alone', async () => {
    const token = `owf_${'c'.repeat(43)}`;
    for (const data of [
      { siteId: 'site-a', machineId: 'm-1', createdAt: T0 },
      { siteId: 'site-a', machineId: 7, createdAt: T0, expiresAt: T0 + 60_000 },
      { machineId: 'm-1', createdAt: T0, expiresAt: T0 + 60_000 },
    ]) {
      store.set(hashOf(token), data);
      await expect(verifyFleetSession(db, token)).resolves.toBeNull();
      expect(store.has(hashOf(token))).toBe(true);
    }
  });
});

describe('expiry', () => {
  it('is live until the last millisecond, then null and deleted', async () => {
    const { token, expiresAt } = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    now = expiresAt - 1;
    await expect(verifyFleetSession(db, token)).resolves.not.toBeNull();

    now = expiresAt;
    await expect(verifyFleetSession(db, token)).resolves.toBeNull();
    expect(store.has(hashOf(token))).toBe(false);
  });

  it('still returns null when deleting the expired record fails', async () => {
    const { token, expiresAt } = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });
    now = expiresAt + 1;
    deleteError = new Error('unavailable');

    await expect(verifyFleetSession(db, token)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('rotation grace', () => {
  it('lets the previous session live 60 seconds past a rotation, and no longer', async () => {
    const first = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    // the keeper renews every 10 minutes, with 5 still left on the old session.
    const rotatedAt = T0 + 10 * 60_000;
    now = rotatedAt;
    const second = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    now = rotatedAt + 59_999;
    await expect(verifyFleetSession(db, first.token)).resolves.not.toBeNull();

    now = rotatedAt + 60_000;
    await expect(verifyFleetSession(db, first.token)).resolves.toBeNull();
    await expect(verifyFleetSession(db, second.token)).resolves.not.toBeNull();
  });

  it('never lengthens a session that was about to expire anyway', async () => {
    const first = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    now = first.expiresAt - 10_000;
    await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    expect(store.get(hashOf(first.token))?.expiresAt).toBe(first.expiresAt);
  });

  it('deletes the machine’s sessions that had already expired', async () => {
    const first = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    now = first.expiresAt;
    const second = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    expect([...store.keys()]).toEqual([hashOf(second.token)]);
  });

  it('never touches another machine’s sessions, nor the same machine id in another site', async () => {
    const other = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-2' });
    const elsewhere = await mintFleetSession(db, { siteId: 'site-b', machineId: 'm-1' });

    now = T0 + 10 * 60_000;
    await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    await expect(verifyFleetSession(db, other.token)).resolves.not.toBeNull();
    await expect(verifyFleetSession(db, elsewhere.token)).resolves.not.toBeNull();
  });

  it('keeps the new session when the prune fails', async () => {
    queryError = new Error('unavailable');
    const { token } = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });

    await expect(verifyFleetSession(db, token)).resolves.toEqual({ siteId: 'site-a', machineId: 'm-1' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('revokeFleetSessions', () => {
  async function seed() {
    return {
      a1: await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' }),
      a2: await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-2' }),
      b1: await mintFleetSession(db, { siteId: 'site-b', machineId: 'm-1' }),
    };
  }

  it('revokes one machine’s sessions and nothing else', async () => {
    const s = await seed();

    await expect(revokeFleetSessions(db, { siteId: 'site-a', machineId: 'm-1' })).resolves.toBe(1);
    await expect(verifyFleetSession(db, s.a1.token)).resolves.toBeNull();
    await expect(verifyFleetSession(db, s.a2.token)).resolves.not.toBeNull();
    await expect(verifyFleetSession(db, s.b1.token)).resolves.not.toBeNull();
  });

  it('revokes every session in a site and nothing in another', async () => {
    const s = await seed();

    await expect(revokeFleetSessions(db, { siteId: 'site-a' })).resolves.toBe(2);
    await expect(verifyFleetSession(db, s.a1.token)).resolves.toBeNull();
    await expect(verifyFleetSession(db, s.a2.token)).resolves.toBeNull();
    await expect(verifyFleetSession(db, s.b1.token)).resolves.not.toBeNull();
  });

  it('never widens an empty machine id to the whole site', async () => {
    await seed();
    await expect(revokeFleetSessions(db, { siteId: 'site-a', machineId: '' })).resolves.toBe(0);
    expect(store.size).toBe(3);
  });

  it('deletes in batches of 100', async () => {
    for (let i = 0; i < 250; i += 1) {
      store.set(`h${i}`, { siteId: 'site-a', machineId: `m-${i}`, createdAt: T0, expiresAt: T0 + 1 });
    }
    await expect(revokeFleetSessions(db, { siteId: 'site-a' })).resolves.toBe(250);
    expect(batchCommits).toBe(3);
    expect(store.size).toBe(0);
  });
});

describe('logging', () => {
  it('never hands a logger the token or the full hash, only the hash’s first 8 characters', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {}),
    );

    queryError = new Error('unavailable');
    const { token, expiresAt } = await mintFleetSession(db, { siteId: 'site-a', machineId: 'm-1' });
    queryError = null;
    await verifyFleetSession(db, token);
    now = expiresAt;
    deleteError = new Error('unavailable');
    await verifyFleetSession(db, token);

    const loggerCalls = Object.values(logger)
      .filter((fn): fn is jest.Mock => jest.isMockFunction(fn))
      .flatMap((fn) => fn.mock.calls);
    const consoleCalls = consoleSpies.flatMap((spy) => spy.mock.calls);
    expect(loggerCalls.length).toBe(2);

    const logged = JSON.stringify([...loggerCalls, ...consoleCalls]);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.slice(4));
    expect(logged).not.toContain(hashOf(token));
    expect(logged).toContain(hashOf(token).slice(0, 8));
  });
});
