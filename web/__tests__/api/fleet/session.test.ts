/** @jest-environment node */

/**
 * POST /api/agent/fleet/session against a path-keyed admin-sdk fake. the
 * session store is the real one, so what the route answers is what a fleet
 * route would later verify. the cases that matter are the refusals: a person's
 * credential, a machine whose pairing is gone, and a machine nobody granted.
 */

import crypto from 'crypto';
import { createMockRequest } from '../helpers/utils';

type Data = Record<string, unknown>;

const mockVerifyIdToken = jest.fn();
const mockEmitMutation = jest.fn();
const mockCheckRateLimit = jest.fn();

let store: Map<string, Data>;
let failQueriesOn: string | null;
let hits: Map<string, number>;

function docRef(path: string) {
  return {
    id: path.split('/').pop() as string,
    path,
    get: async () => {
      const data = store.get(path);
      return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
    },
    set: async (payload: Data) => {
      store.set(path, payload);
    },
    update: async (payload: Data) => {
      store.set(path, { ...store.get(path), ...payload });
    },
    delete: async () => {
      store.delete(path);
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function query(collectionPath: string, filters: Array<[string, unknown]>) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`fake firestore answers == only, got ${op}`);
      return query(collectionPath, [...filters, [field, value]]);
    },
    get: async () => {
      if (failQueriesOn === collectionPath) throw new Error('unavailable');
      const docs = [...store.entries()]
        .filter(([path]) => path.startsWith(`${collectionPath}/`) && !path.slice(collectionPath.length + 1).includes('/'))
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .map(([path, data]) => ({ id: path.split('/').pop(), ref: docRef(path), data: () => data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  };
}

function collectionRef(path: string) {
  return { doc: (id: string) => docRef(`${path}/${id}`), where: query(path, []).where };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => ({
    collection: (name: string) => collectionRef(name),
    batch: () => {
      const pending: string[] = [];
      return {
        delete: (ref: { path: string }) => {
          pending.push(ref.path);
        },
        commit: async () => {
          for (const path of pending) store.delete(path);
        },
      };
    },
  }),
}));
jest.mock('@/lib/rateLimit', () => ({
  ...jest.requireActual('@/lib/rateLimit'),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import logger from '@/lib/logger';
import { POST } from '@/app/api/agent/fleet/session/route';
import { FLEET_SESSION_TTL_MS, verifyFleetSession } from '@/lib/fleet/session.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { FLEET_SESSION_RATE_LIMIT_PER_HOUR, fleetSessionRateLimit } from '@/lib/rateLimit';

const SITE = 'site-a';
const MACHINE = 'm-1';
const T0 = 1_800_000_000_123;
let now: number;

const hashOf = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

function agentToken(claims: Data = {}) {
  mockVerifyIdToken.mockResolvedValue({
    uid: `agent_${SITE}_${MACHINE}`,
    role: 'agent',
    site_id: SITE,
    machine_id: MACHINE,
    ...claims,
  });
}

function seedRefreshToken(data: Data = {}, id = hashOf(`refresh-${store.size}`)) {
  store.set(`agent_refresh_tokens/${id}`, {
    siteId: SITE,
    machineId: MACHINE,
    version: '4.1.27',
    agentUid: `agent_${SITE}_${MACHINE}`,
    createdBy: 'user-1',
    ...data,
  });
}

function seedMachine(siteId = SITE, machineId = MACHINE) {
  store.set(`sites/${siteId}/machines/${machineId}`, { online: true });
}

function grant(settings: Data = { enabled: true, senders: { [MACHINE]: { maxTier: 2, wholeSite: true } } }) {
  store.set(`sites/${SITE}/settings/fleet`, settings);
}

function paired() {
  seedRefreshToken();
  seedMachine();
}

/** a fixed window per key, as upstash keeps one, holding the real budget. */
function fakeLimit(_limiter: unknown, key: string) {
  const count = (hits.get(key) ?? 0) + 1;
  hits.set(key, count);
  const success = count <= FLEET_SESSION_RATE_LIMIT_PER_HOUR;
  return Promise.resolve({
    success,
    limit: FLEET_SESSION_RATE_LIMIT_PER_HOUR,
    remaining: Math.max(0, FLEET_SESSION_RATE_LIMIT_PER_HOUR - count),
    reset: now + 3_600_000,
    retryAfter: success ? undefined : 120,
  });
}

function request(headers: Record<string, string> = { Authorization: 'Bearer agent-id-token' }, body?: Data) {
  return createMockRequest('http://localhost/api/agent/fleet/session', { method: 'POST', headers, body });
}

function sessionDocs() {
  return [...store.keys()].filter((path) => path.startsWith('fleet_sessions/'));
}

beforeEach(() => {
  jest.clearAllMocks();
  store = new Map();
  failQueriesOn = null;
  hits = new Map();
  mockCheckRateLimit.mockImplementation(fakeLimit);
  now = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/agent/fleet/session', () => {
  it('mints a session for the machine in its claims, with expiresAt in epoch seconds and no-store', async () => {
    agentToken();
    paired();
    grant();

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token', 'ttlSeconds']);
    expect(body.token).toMatch(/^owf_[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(Math.floor((T0 + FLEET_SESSION_TTL_MS) / 1000));
    expect(body.ttlSeconds).toBe(900);
    await expect(verifyFleetSession(getAdminDb(), body.token)).resolves.toEqual({
      siteId: SITE,
      machineId: MACHINE,
    });
  });

  it('takes the site and machine from the claims, never from the body', async () => {
    agentToken();
    paired();
    grant();
    seedMachine('site-b', 'm-2');

    const res = await POST(request(undefined, { siteId: 'site-b', machineId: 'm-2' }));

    expect(res.status).toBe(200);
    const { token } = await res.json();
    await expect(verifyFleetSession(getAdminDb(), token)).resolves.toEqual({
      siteId: SITE,
      machineId: MACHINE,
    });
  });

  it('audits the mint with the machine as actor and no token', async () => {
    agentToken();
    paired();
    grant();

    const res = await POST(request());
    const { token } = await res.json();

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: SITE,
      actor: `machine:${MACHINE}`,
      targetId: MACHINE,
      attributes: {
        verb: 'fleet_session_minted',
        endpoint: 'agent/fleet/session',
        method: 'POST',
        machineId: MACHINE,
      },
    });
    const audited = JSON.stringify(mockEmitMutation.mock.calls);
    expect(audited).not.toContain(token);
    expect(audited).not.toContain(hashOf(token));
  });

  describe('the rate limit', () => {
    function pairAndGrant(machineId: string) {
      seedRefreshToken({ machineId, agentUid: `agent_${SITE}_${machineId}` });
      seedMachine(SITE, machineId);
    }

    beforeEach(() => {
      pairAndGrant(MACHINE);
      pairAndGrant('m-2');
      grant({
        enabled: true,
        senders: { [MACHINE]: { maxTier: 2, wholeSite: true }, 'm-2': { maxTier: 2, wholeSite: true } },
      });
    });

    it('is 30 an hour, on the fleet session limiter', async () => {
      expect(FLEET_SESSION_RATE_LIMIT_PER_HOUR).toBe(30);
      agentToken();
      await POST(request());
      expect(mockCheckRateLimit).toHaveBeenCalledWith(fleetSessionRateLimit, `fleet_session:${SITE}:${MACHINE}`);
    });

    it('answers 429 with Retry-After once a machine spends it, and mints nothing', async () => {
      agentToken();
      for (let i = 0; i < FLEET_SESSION_RATE_LIMIT_PER_HOUR; i += 1) {
        expect((await POST(request())).status).toBe(200);
      }
      const minted = sessionDocs().length;
      const audited = mockEmitMutation.mock.calls.length;

      const res = await POST(request());

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('120');
      expect((await res.json()).code).toBe('rate_limited');
      expect(sessionDocs().length).toBe(minted);
      expect(mockEmitMutation.mock.calls.length).toBe(audited);
    });

    it('is per machine: another machine of the same site keeps its own', async () => {
      agentToken();
      for (let i = 0; i <= FLEET_SESSION_RATE_LIMIT_PER_HOUR; i += 1) await POST(request());
      expect((await POST(request())).status).toBe(429);

      agentToken({ uid: `agent_${SITE}_m-2`, machine_id: 'm-2' });
      expect((await POST(request())).status).toBe(200);
      expect(mockCheckRateLimit).toHaveBeenLastCalledWith(fleetSessionRateLimit, `fleet_session:${SITE}:m-2`);
    });
  });

  describe('refuses a caller that is not an agent', () => {
    beforeEach(() => {
      paired();
      grant();
    });

    async function expectRefused(res: Response) {
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('unauthorized');
      expect(sessionDocs()).toEqual([]);
      expect(mockEmitMutation).not.toHaveBeenCalled();
      // no machine is named yet, so no machine's budget is charged
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    }

    it("a user's ID token", async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'user-1', email: 'a@example.com' });
      await expectRefused(await POST(request()));
    });

    it("a user's ID token carrying the site and machine claims but another role", async () => {
      agentToken({ role: 'admin' });
      await expectRefused(await POST(request()));
    });

    it('a session cookie with no bearer', async () => {
      await expectRefused(await POST(request({ Cookie: '__session=abc' })));
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    it('an api key, without verifying it as an ID token', async () => {
      await expectRefused(await POST(request({ Authorization: `Bearer owk_live_${'a'.repeat(40)}` })));
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });

    it('a token that does not verify', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('auth/id-token-expired'));
      await expectRefused(await POST(request()));
    });

    it('an agent token with no machine_id claim', async () => {
      agentToken({ machine_id: undefined });
      await expectRefused(await POST(request()));
    });

    it('an agent token whose site_id claim is not a string', async () => {
      agentToken({ site_id: 42 });
      await expectRefused(await POST(request()));
    });
  });

  describe('refuses a machine whose pairing is gone', () => {
    beforeEach(() => {
      agentToken();
      grant();
    });

    async function expectRevoked(res: Response) {
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('pairing_revoked');
      expect(sessionDocs()).toEqual([]);
      expect(mockEmitMutation).not.toHaveBeenCalled();
    }

    it('when its agent tokens were revoked', async () => {
      seedMachine();
      await expectRevoked(await POST(request()));
    });

    it('when its only agent token was superseded past the grace', async () => {
      seedMachine();
      seedRefreshToken({ supersededAt: T0 - 600_000, supersededBy: 'next', retiresAt: T0 - 1 });
      await expectRevoked(await POST(request()));
    });

    it('when its only agent token has expired', async () => {
      seedMachine();
      seedRefreshToken({ expiresAt: T0 - 1 });
      await expectRevoked(await POST(request()));
    });

    it('when the live agent tokens are for another machine or another site', async () => {
      seedMachine();
      seedRefreshToken({ machineId: 'm-2' });
      seedRefreshToken({ siteId: 'site-b' });
      await expectRevoked(await POST(request()));
    });

    it('when its machine row is gone', async () => {
      seedRefreshToken();
      await expectRevoked(await POST(request()));
    });

    it('before it looks at the grant', async () => {
      seedMachine();
      store.delete(`sites/${SITE}/settings/fleet`);
      await expectRevoked(await POST(request()));
    });

    it('but accepts a token still within its rotation grace, as the refresh route does', async () => {
      seedMachine();
      seedRefreshToken({ supersededAt: T0 - 1_000, supersededBy: 'next', retiresAt: T0 + 60_000 });
      expect((await POST(request())).status).toBe(200);
    });
  });

  describe('refuses a machine that is not granted', () => {
    beforeEach(() => {
      agentToken();
      paired();
    });

    async function expectNotGranted(res: Response) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('fleet_not_granted');
      expect(sessionDocs()).toEqual([]);
      expect(mockEmitMutation).not.toHaveBeenCalled();
    }

    it('when the site has no settings document', async () => {
      await expectNotGranted(await POST(request()));
    });

    it('when the site has the feature off', async () => {
      grant({ enabled: false, senders: { [MACHINE]: { maxTier: 2, wholeSite: true } } });
      await expectNotGranted(await POST(request()));
    });

    it('when the machine is not a sender', async () => {
      grant({ enabled: true, senders: { 'm-2': { maxTier: 3, wholeSite: true } } });
      await expectNotGranted(await POST(request()));
    });
  });

  it('never hands a logger or the console the token', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation(() => {}),
    );
    agentToken();
    paired();
    grant();
    // the store's prune after a mint logs; make it, so there is a log line to inspect
    failQueriesOn = 'fleet_sessions';

    const res = await POST(request());
    expect(res.status).toBe(200);
    const { token } = await res.json();

    const loggerCalls = Object.values(logger)
      .filter((fn): fn is jest.Mock => jest.isMockFunction(fn))
      .flatMap((fn) => fn.mock.calls);
    expect(loggerCalls.length).toBeGreaterThan(0);
    const logged = JSON.stringify([...loggerCalls, ...consoleSpies.flatMap((spy) => spy.mock.calls)]);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.slice(4));
    expect(logged).not.toContain(hashOf(token));
  });
});
