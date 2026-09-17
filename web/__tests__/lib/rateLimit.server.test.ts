/** @jest-environment node */

/**
 * Unit tests for `web/lib/rateLimit.server.ts`: in-memory token bucket,
 * firestore sharded counter (including fail-open), the combined entry point,
 * and the `{ ok: false, reason: 'rate_limited', retryAfterSec }` envelope.
 *
 * Firestore is mocked at the `@/lib/firebase-admin` boundary — no emulator, so
 * these stay fast and hermetic.
 */

import { Capability, type Actor } from '@/lib/capabilities';

interface ShardDoc {
  count: number;
  windowStart: number;
}

// Absolute path → shard doc; reset in beforeEach.
const fakeStore = new Map<string, ShardDoc>();
const fakeObservationWrites: Array<{ path: string; data: Record<string, unknown> }> = [];

// Per-test fail-mode toggles.
let failTransaction = false;
let failGetAll = false;

// Lets tests assert transaction call counts.
const transactionSpy = jest.fn();

function makeDocRef(path: string) {
  return {
    __path: path,
    get: jest.fn(async () => {
      if (failGetAll) throw new Error('mock firestore get failure');
      const data = fakeStore.get(path);
      return {
        exists: !!data,
        data: () => data,
      };
    }),
    set: jest.fn(async (data: ShardDoc) => {
      fakeStore.set(path, data);
    }),
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeCollectionRef(path: string) {
  return {
    __path: path,
    add: jest.fn(async (data: Record<string, unknown>) => {
      fakeObservationWrites.push({ path, data });
      return { id: `obs-${fakeObservationWrites.length}` };
    }),
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    get: jest.fn(async () => {
      if (failGetAll) throw new Error('mock firestore listing failure');
      const docs: Array<{ id: string; data: () => ShardDoc }> = [];
      for (const [key, value] of fakeStore) {
        if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
          docs.push({
            id: key.slice(path.length + 1),
            data: () => value,
          });
        }
      }
      return {
        forEach: (cb: (d: { id: string; data: () => ShardDoc }) => void) => {
          docs.forEach(cb);
        },
      };
    }),
  };
}

const fakeDb = {
  collection: (name: string) => makeCollectionRef(name),
  runTransaction: jest.fn(
    async <T>(handler: (tx: unknown) => Promise<T>): Promise<T> => {
      transactionSpy();
      if (failTransaction) throw new Error('mock firestore transaction failure');
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (data: ShardDoc) => Promise<void> }, data: ShardDoc) => {
          // Synchronous here; the real txn `set` is staged, not awaited.
          void ref.set(data);
        },
      };
      return handler(tx);
    }
  ),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__' },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Import AFTER mocks so the module under test resolves them.
import {
  USER_LIMITS,
  SYSTEM_LIMITS,
  WINDOW_SEC,
  SHARD_COUNT,
  bucketForActor,
  actorIdentifier,
  rateLimitSubjectKey,
  rateLimitSubjectDocId,
  rateLimitHeaders,
  checkInMemoryBurst,
  checkFirestoreLimit,
  checkRateLimit,
  pickShardIndex,
  __resetInMemoryBucketsForTests,
} from '@/lib/rateLimit.server';

const userActor: Actor = {
  type: 'user',
  userId: 'user-1',
  role: 'admin',
  siteRoles: { ['site-1']: 'admin' },
};

const otherUserActor: Actor = {
  type: 'user',
  userId: 'user-2',
  role: 'admin',
  siteRoles: { ['site-1']: 'admin' },
};

const apiKeyActorA: Actor = {
  type: 'user',
  userId: 'user-1',
  apiKeyId: 'key-a',
  role: 'admin',
  siteRoles: { ['site-1']: 'admin' },
};

const apiKeyActorB: Actor = {
  type: 'user',
  userId: 'user-1',
  apiKeyId: 'key-b',
  role: 'admin',
  siteRoles: { ['site-1']: 'admin' },
};

const systemActor: Actor = {
  type: 'system',
  name: 'cortex_autonomous',
  siteId: 'site-1',
};

function shardPath(
  siteId: string,
  bucket: 'user' | 'system',
  subjectKey: string,
  capability: Capability,
  shard = '0',
): string {
  return `sites/${siteId}/rate_limits/${bucket}/subjects/${rateLimitSubjectDocId(subjectKey)}/capabilities/${capability}/shards/${shard}`;
}

function hasRateLimitPath(
  keys: string[],
  bucket: 'user' | 'system',
  capability: Capability,
): boolean {
  return keys.some((key) =>
    key.includes(`/rate_limits/${bucket}/subjects/`) &&
    key.includes(`/capabilities/${capability}/shards/`)
  );
}

beforeEach(() => {
  fakeStore.clear();
  fakeObservationWrites.length = 0;
  failTransaction = false;
  failGetAll = false;
  delete process.env.RATE_LIMIT_OBSERVE_ONLY;
  transactionSpy.mockClear();
  fakeDb.runTransaction.mockClear();
  __resetInMemoryBucketsForTests();
  jest.spyOn(Math, 'random').mockReturnValue(0); // deterministic shard 0
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('default limits', () => {
  it('declares a per-minute limit for every capability in the user bucket', () => {
    for (const cap of Object.values(Capability)) {
      expect(USER_LIMITS[cap]).toBeDefined();
      expect(USER_LIMITS[cap].perMinute).toBeGreaterThan(0);
    }
  });

  it('declares a per-minute limit for every capability in the system bucket', () => {
    for (const cap of Object.values(Capability)) {
      expect(SYSTEM_LIMITS[cap]).toBeDefined();
      expect(SYSTEM_LIMITS[cap].perMinute).toBeGreaterThan(0);
    }
  });

  it('grants system limits >= user limits for every capability (hoot headroom)', () => {
    for (const cap of Object.values(Capability)) {
      expect(SYSTEM_LIMITS[cap].perMinute).toBeGreaterThanOrEqual(
        USER_LIMITS[cap].perMinute
      );
    }
  });

  it('matches the brief for hot-path capabilities', () => {
    expect(USER_LIMITS[Capability.MACHINE_EXEC_COMMAND].perMinute).toBe(60);
    expect(USER_LIMITS[Capability.DEPLOYMENT_MANAGE].perMinute).toBe(30);
    expect(SYSTEM_LIMITS[Capability.MACHINE_EXEC_COMMAND].perMinute).toBe(300);
  });

  it('gives both swoop capabilities a user AND a system limit', () => {
    // checkRateLimit returns { ok: true } for a capability with no entry, so a
    // missing row here is not a smaller limit — it is no limit at all.
    expect(USER_LIMITS[Capability.MACHINE_REMOTE_CONTROL].perMinute).toBe(10);
    expect(USER_LIMITS[Capability.MACHINE_REMOTE_VIEW].perMinute).toBe(20);
    expect(SYSTEM_LIMITS[Capability.MACHINE_REMOTE_CONTROL].perMinute).toBe(50);
    expect(SYSTEM_LIMITS[Capability.MACHINE_REMOTE_VIEW].perMinute).toBe(100);
  });

  it('rate-limits swoop control more tightly than watching, and both below MACHINE_VIEW', () => {
    expect(USER_LIMITS[Capability.MACHINE_REMOTE_CONTROL].perMinute).toBeLessThan(
      USER_LIMITS[Capability.MACHINE_REMOTE_VIEW].perMinute
    );
    expect(USER_LIMITS[Capability.MACHINE_REMOTE_VIEW].perMinute).toBeLessThan(
      USER_LIMITS[Capability.MACHINE_VIEW].perMinute
    );
  });
});

describe('bucketForActor', () => {
  it('routes user actors to the user bucket', () => {
    expect(bucketForActor(userActor)).toBe('user');
  });

  it('routes system actors to the system bucket', () => {
    expect(bucketForActor(systemActor)).toBe('system');
  });
});

describe('actorIdentifier', () => {
  it('uses userId for user actors', () => {
    expect(actorIdentifier(userActor)).toBe('user-1');
  });

  it('uses apiKeyId for API-key-mediated user actors', () => {
    expect(actorIdentifier(apiKeyActorA)).toBe('key-a');
  });

  it('uses name for system actors', () => {
    expect(actorIdentifier(systemActor)).toBe('cortex_autonomous');
  });
});

describe('rateLimitSubjectKey', () => {
  it('distinguishes sessions and API keys owned by the same user', () => {
    expect(rateLimitSubjectKey(userActor)).toBe('user:user-1');
    expect(rateLimitSubjectKey(apiKeyActorA)).toBe('apiKey:key-a');
    expect(rateLimitSubjectKey(apiKeyActorB)).toBe('apiKey:key-b');
  });

  it('produces a stable Firestore-safe subject doc id', () => {
    expect(rateLimitSubjectDocId('apiKey:key-a')).toMatch(/^[0-9a-f]{32}$/);
    expect(rateLimitSubjectDocId('apiKey:key-a')).toBe(rateLimitSubjectDocId('apiKey:key-a'));
    expect(rateLimitSubjectDocId('apiKey:key-a')).not.toBe(rateLimitSubjectDocId('apiKey:key-b'));
  });
});

describe('checkInMemoryBurst', () => {
  it('allows the first request from a fresh actor', () => {
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
  });

  it('allows up to capacity within the same instant', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute; // 5
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
  });

  it('keys separately by userId — two users do not share a bucket', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute;
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    // user-1 is now empty; user-2 starts fresh.
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
    expect(checkInMemoryBurst(otherUserActor, Capability.USER_DELETE)).toBe(true);
  });

  it('keys separately by apiKeyId for two keys owned by one user', () => {
    const limit = USER_LIMITS[Capability.USER_SELF_DELETE].perMinute; // 1
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(apiKeyActorA, Capability.USER_SELF_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(apiKeyActorA, Capability.USER_SELF_DELETE)).toBe(false);
    expect(checkInMemoryBurst(apiKeyActorB, Capability.USER_SELF_DELETE)).toBe(true);
  });

  it('keys separately by capability — exhausting one does not affect another', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute;
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
    expect(checkInMemoryBurst(userActor, Capability.MACHINE_EXEC_COMMAND)).toBe(true);
  });

  it('keys separately by actor type — system actor does NOT consume user bucket', () => {
    const userLimit = USER_LIMITS[Capability.MACHINE_EXEC_COMMAND].perMinute;
    for (let i = 0; i < userLimit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.MACHINE_EXEC_COMMAND)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.MACHINE_EXEC_COMMAND)).toBe(false);
    // The system actor still has its own untouched bucket.
    expect(checkInMemoryBurst(systemActor, Capability.MACHINE_EXEC_COMMAND)).toBe(true);
  });

  it('refills tokens proportionally as time passes', () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute; // 5
    const start = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < limit; i++) {
      expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    }
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);

    // 5 tokens/min = 1 per 12s.
    jest.spyOn(Date, 'now').mockReturnValue(start + 13_000);
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(true);
    // The next call should reject again (refill is gradual, not full).
    expect(checkInMemoryBurst(userActor, Capability.USER_DELETE)).toBe(false);
  });
});

describe('checkFirestoreLimit', () => {
  it('allows the first call and stamps shard 0 with count=1', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      60
    );
    expect(result).toMatchObject({ ok: true });
    expect(transactionSpy).toHaveBeenCalledTimes(1);

    // The store should have exactly one shard recorded.
    const storedKeys = [...fakeStore.keys()];
    expect(storedKeys).toHaveLength(1);
    expect(storedKeys[0]).toContain('/rate_limits/user/subjects/');
    expect(storedKeys[0]).toContain('/capabilities/MACHINE_EXEC_COMMAND/shards/');
    expect(storedKeys[0]).toMatch(/\/0$/); // shard index 0
    const stored = fakeStore.get(storedKeys[0])!;
    expect(stored.count).toBe(1);
  });

  it('returns rate_limited with retryAfterSec once the summed total exceeds limit', async () => {
    // Shard 0 at `count = limit` in the active window, so this call exceeds it.
    const limit = 3;
    const nowSec = Math.floor(Date.now() / 1000);
    const path = shardPath('site-1', 'user', 'user', Capability.MACHINE_REMOVE);
    fakeStore.set(path, { count: limit, windowStart: nowSec });

    jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_REMOVE,
      limit
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('rate_limited');
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSec).toBeLessThanOrEqual(WINDOW_SEC);
  });

  it('rolls a stale window forward when the existing windowStart is older than windowSec', async () => {
    // Existing shard has count=999 but its window expired.
    const oldStart = Math.floor(Date.now() / 1000) - (WINDOW_SEC + 5);
    const path = shardPath('site-1', 'user', 'user', Capability.MACHINE_REMOVE);
    fakeStore.set(path, { count: 999, windowStart: oldStart });

    jest.spyOn(Math, 'random').mockReturnValue(0);
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_REMOVE,
      5
    );
    expect(result).toMatchObject({ ok: true });

    // Window should have rolled — count=1, windowStart is fresh.
    const stored = fakeStore.get(path)!;
    expect(stored.count).toBe(1);
    expect(stored.windowStart).toBeGreaterThan(oldStart);
  });

  it('separates user and system bucket counters at distinct firestore paths', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    await checkFirestoreLimit('site-1', 'user', Capability.MACHINE_EXEC_COMMAND, 60);
    await checkFirestoreLimit('site-1', 'system', Capability.MACHINE_EXEC_COMMAND, 300);

    const keys = [...fakeStore.keys()];
    expect(keys).toHaveLength(2);
    expect(hasRateLimitPath(keys, 'user', Capability.MACHINE_EXEC_COMMAND)).toBe(true);
    expect(hasRateLimitPath(keys, 'system', Capability.MACHINE_EXEC_COMMAND)).toBe(true);
  });

  it('distributes increments across all shards when Math.random varies', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < SHARD_COUNT; i++) {
      jest.spyOn(Math, 'random').mockReturnValue(i / SHARD_COUNT);
      await checkFirestoreLimit(
        'site-1',
        'user',
        Capability.MACHINE_EXEC_COMMAND,
        100
      );
      seen.add(i);
    }
    // We should have written into each of the 10 shard slots exactly once.
    const shardKeys = [...fakeStore.keys()].filter((k) =>
      k.includes('/rate_limits/user/subjects/') &&
      k.includes('/capabilities/MACHINE_EXEC_COMMAND/shards/')
    );
    expect(shardKeys).toHaveLength(SHARD_COUNT);
    expect(seen.size).toBe(SHARD_COUNT);
  });

  it('fails open when the firestore transaction throws', async () => {
    failTransaction = true;
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      60
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('fails open when the shard read throws after a successful increment', async () => {
    // The transaction succeeds, but the subsequent `col.get()` throws —
    // simulating a partial firestore failure mid-call.
    failGetAll = true;
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      60
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('rejects immediately when limit is zero or negative', async () => {
    const result = await checkFirestoreLimit(
      'site-1',
      'user',
      Capability.MACHINE_EXEC_COMMAND,
      0
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('rate_limited');
    // No transaction should have been issued.
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});

describe('pickShardIndex', () => {
  it('returns an integer in [0, SHARD_COUNT)', () => {
    jest.restoreAllMocks();
    for (let i = 0; i < 100; i++) {
      const idx = pickShardIndex();
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(SHARD_COUNT);
      expect(Number.isInteger(idx)).toBe(true);
    }
  });
});

describe('checkRateLimit (combined)', () => {
  it('returns ok:true under normal conditions and writes to the user bucket', async () => {
    const result = await checkRateLimit(
      userActor,
      Capability.MACHINE_EXEC_COMMAND,
      'site-1'
    );
    expect(result).toMatchObject({ ok: true });
    const keys = [...fakeStore.keys()];
    expect(hasRateLimitPath(keys, 'user', Capability.MACHINE_EXEC_COMMAND)).toBe(true);
  });

  it('routes system actors to the system bucket — never the user bucket', async () => {
    const result = await checkRateLimit(
      systemActor,
      Capability.MACHINE_EXEC_COMMAND,
      'site-1'
    );
    expect(result).toMatchObject({ ok: true });
    const keys = [...fakeStore.keys()];
    expect(hasRateLimitPath(keys, 'system', Capability.MACHINE_EXEC_COMMAND)).toBe(true);
    expect(hasRateLimitPath(keys, 'user', Capability.MACHINE_EXEC_COMMAND)).toBe(false);
  });

  it('user-bucket exhaustion does NOT block a system actor on the same capability+site', async () => {
    // Saturate the user bucket on shard 0.
    const userLimit = USER_LIMITS[Capability.MACHINE_REMOVE].perMinute;
    const path = shardPath(
      'site-1',
      'user',
      rateLimitSubjectKey(userActor),
      Capability.MACHINE_REMOVE,
    );
    fakeStore.set(path, {
      count: userLimit,
      windowStart: Math.floor(Date.now() / 1000),
    });

    const userResult = await checkRateLimit(
      userActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(userResult.ok).toBe(false);

    // Reset so the firestore layer, not the separate in-memory prefix, is
    // what this assertion exercises.
    __resetInMemoryBucketsForTests();
    const systemResult = await checkRateLimit(
      systemActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(systemResult).toMatchObject({ ok: true });
  });

  it('system-bucket exhaustion does NOT block a user actor on the same capability+site', async () => {
    const systemLimit = SYSTEM_LIMITS[Capability.MACHINE_REMOVE].perMinute;
    const path = shardPath(
      'site-1',
      'system',
      rateLimitSubjectKey(systemActor),
      Capability.MACHINE_REMOVE,
    );
    fakeStore.set(path, {
      count: systemLimit,
      windowStart: Math.floor(Date.now() / 1000),
    });

    const systemResult = await checkRateLimit(
      systemActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(systemResult.ok).toBe(false);

    __resetInMemoryBucketsForTests();
    const userResult = await checkRateLimit(
      userActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );
    expect(userResult).toMatchObject({ ok: true });
  });

  it('short-circuits on in-memory layer without ever hitting firestore', async () => {
    const limit = USER_LIMITS[Capability.USER_DELETE].perMinute; // 5
    // Drain the in-memory bucket (firestore allows all of these — limit is 5).
    for (let i = 0; i < limit; i++) {
      const r = await checkRateLimit(userActor, Capability.USER_DELETE, 'site-1');
      expect(r.ok).toBe(true);
    }
    transactionSpy.mockClear();
    const denied = await checkRateLimit(userActor, Capability.USER_DELETE, 'site-1');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.reason).toBe('rate_limited');
    expect(denied.retryAfterSec).toBe(WINDOW_SEC);
    // Firestore was NOT consulted on the rejected call.
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('returns the structured rate_limited envelope verbatim on rejection', async () => {
    // USER_SELF_DELETE has a per-minute limit of 1; second call rejects.
    const ok = await checkRateLimit(userActor, Capability.USER_SELF_DELETE, 'site-1');
    expect(ok).toMatchObject({ ok: true });
    const denied = await checkRateLimit(userActor, Capability.USER_SELF_DELETE, 'site-1');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.reason).toBe('rate_limited');
    expect(typeof denied.retryAfterSec).toBe('number');
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('gives two API keys owned by the same user independent buckets', async () => {
    const keyAOk = await checkRateLimit(apiKeyActorA, Capability.USER_SELF_DELETE, 'site-1');
    const keyADenied = await checkRateLimit(apiKeyActorA, Capability.USER_SELF_DELETE, 'site-1');
    const keyBOk = await checkRateLimit(apiKeyActorB, Capability.USER_SELF_DELETE, 'site-1');

    expect(keyAOk).toMatchObject({
      ok: true,
      limit: 1,
      remaining: 0,
      rateLimitReason: 'key-rate',
    });
    expect(keyADenied).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      limit: 1,
      remaining: 0,
      rateLimitReason: 'key-rate',
    });
    expect(keyBOk).toMatchObject({
      ok: true,
      limit: 1,
      remaining: 0,
      rateLimitReason: 'key-rate',
    });

    const keys = [...fakeStore.keys()];
    expect(keys.some((key) => key.includes(rateLimitSubjectDocId('apiKey:key-a')))).toBe(true);
    expect(keys.some((key) => key.includes(rateLimitSubjectDocId('apiKey:key-b')))).toBe(true);
  });

  it('formats capability rate-limit headers for allowed and rejected requests', async () => {
    const ok = await checkRateLimit(apiKeyActorA, Capability.USER_SELF_DELETE, 'site-1');
    expect(rateLimitHeaders(ok)).toMatchObject({
      'RateLimit-Limit': '1',
      'RateLimit-Remaining': '0',
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
    });
    expect(rateLimitHeaders(ok)).not.toHaveProperty('Retry-After');

    const denied = await checkRateLimit(apiKeyActorA, Capability.USER_SELF_DELETE, 'site-1');
    expect(rateLimitHeaders(denied)).toMatchObject({
      'RateLimit-Limit': '1',
      'RateLimit-Remaining': '0',
      'Retry-After': String(WINDOW_SEC),
      'Roost-Rate-Limited-Reason': 'key-rate',
    });
  });

  it('observe-only mode records in-memory rejections and allows the request', async () => {
    process.env.RATE_LIMIT_OBSERVE_ONLY = 'true';

    const ok = await checkRateLimit(userActor, Capability.USER_SELF_DELETE, 'site-1');
    expect(ok).toMatchObject({ ok: true });
    transactionSpy.mockClear();

    const observed = await checkRateLimit(userActor, Capability.USER_SELF_DELETE, 'site-1');

    expect(observed).toEqual({ ok: true });
    expect(transactionSpy).not.toHaveBeenCalled();
    expect(fakeObservationWrites).toHaveLength(1);
    expect(fakeObservationWrites[0]).toMatchObject({
      path: 'rate_limit_observations',
      data: {
        siteId: 'site-1',
        bucket: 'user',
        capability: Capability.USER_SELF_DELETE,
        actorType: 'user',
        actorId: 'user-1',
        source: 'in_memory',
        configuredLimitPerMinute: USER_LIMITS[Capability.USER_SELF_DELETE].perMinute,
        retryAfterSec: WINDOW_SEC,
      },
    });
  });

  it('observe-only mode records firestore rejections and allows the request', async () => {
    process.env.RATE_LIMIT_OBSERVE_ONLY = 'true';

    const userLimit = USER_LIMITS[Capability.MACHINE_REMOVE].perMinute;
    const path = shardPath(
      'site-1',
      'user',
      rateLimitSubjectKey(userActor),
      Capability.MACHINE_REMOVE,
    );
    fakeStore.set(path, {
      count: userLimit,
      windowStart: Math.floor(Date.now() / 1000),
    });

    const observed = await checkRateLimit(
      userActor,
      Capability.MACHINE_REMOVE,
      'site-1'
    );

    expect(observed).toEqual({ ok: true });
    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(fakeObservationWrites).toHaveLength(1);
    expect(fakeObservationWrites[0]).toMatchObject({
      path: 'rate_limit_observations',
      data: {
        siteId: 'site-1',
        bucket: 'user',
        capability: Capability.MACHINE_REMOVE,
        actorType: 'user',
        actorId: 'user-1',
        source: 'firestore',
        configuredLimitPerMinute: userLimit,
      },
    });
  });
});
