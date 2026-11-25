/** @jest-environment node */

/**
 * DELETE /api/agent/fleet/grant against a path-keyed admin-sdk fake. a machine
 * may only lower its own access (ADR 0017): the cases are the row it drops, the
 * rows it must leave alone, the refusals, and the no-row answer that writes
 * nothing.
 */

import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import { createMockRequest } from '../helpers/utils';

type Data = Record<string, unknown>;

const mockVerifyIdToken = jest.fn();
const mockEmitMutation = jest.fn();
const mockCheckRateLimit = jest.fn();

let store: Map<string, Data>;
let writes: string[];

function docRef(path: string) {
  return {
    id: path.split('/').pop() as string,
    path,
    get: async () => {
      const data = store.get(path);
      return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
    },
    set: async (payload: Data, options?: { merge?: boolean }) => {
      writes.push(path);
      store.set(path, options?.merge ? { ...store.get(path), ...payload } : payload);
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

/** a transaction that applies the one update the route makes, a field path deleted, and refuses any other. */
function transaction() {
  return {
    get: (ref: { get: () => Promise<unknown> }) => ref.get(),
    update: (ref: { path: string }, field: unknown, value: unknown, ...rest: unknown[]) => {
      if (!(field instanceof FieldPath) || value !== FieldValue.delete() || rest[0] !== 'updatedAt') {
        throw new Error('the route may only delete a field path');
      }
      writes.push(ref.path);
      const [key, machineId] = field.toString().replace(/`/g, '').split('.');
      const doc = store.get(ref.path) as { senders: Data } & Data;
      const remaining = { ...doc.senders };
      delete remaining[machineId];
      store.set(ref.path, { ...doc, [key]: remaining, updatedAt: 'stamped' });
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => ({
    collection: (name: string) => collectionRef(name),
    runTransaction: (fn: (tx: ReturnType<typeof transaction>) => Promise<unknown>) => fn(transaction()),
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

import { DELETE } from '@/app/api/agent/fleet/grant/route';
import { FLEET_GRANT_RATE_LIMIT_PER_MINUTE, fleetGrantRateLimit } from '@/lib/rateLimit';

const SITE = 'site-a';
const MACHINE = 'm-1';
const FLEET_DOC = `sites/${SITE}/settings/fleet`;
const T0 = 1_800_000_000_123;

function agentToken() {
  mockVerifyIdToken.mockResolvedValue({
    uid: `agent_${SITE}_${MACHINE}`,
    role: 'agent',
    site_id: SITE,
    machine_id: MACHINE,
  });
}

function paired() {
  store.set('agent_refresh_tokens/t1', {
    siteId: SITE,
    machineId: MACHINE,
    version: '4.1.27',
    agentUid: `agent_${SITE}_${MACHINE}`,
    createdBy: 'user-1',
  });
  store.set(`sites/${SITE}/machines/${MACHINE}`, { online: true });
}

function grant(senders: Data) {
  store.set(FLEET_DOC, { enabled: true, senders });
}

function sendersOf(): string[] {
  return Object.keys((store.get(FLEET_DOC) as { senders: Data }).senders);
}

function request(headers: Record<string, string> = { Authorization: 'Bearer agent-id-token' }) {
  return createMockRequest('http://localhost/api/agent/fleet/grant', { method: 'DELETE', headers });
}

function sessionDocs() {
  return [...store.keys()].filter((path) => path.startsWith('fleet_sessions/'));
}

function seedSession(id: string, machineId: string) {
  store.set(`fleet_sessions/${id}`, { siteId: SITE, machineId, expiresAt: T0 + 60_000 });
}

beforeEach(() => {
  jest.clearAllMocks();
  store = new Map();
  writes = [];
  mockCheckRateLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: T0 + 60_000 });
  jest.spyOn(Date, 'now').mockImplementation(() => T0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DELETE /api/agent/fleet/grant', () => {
  it('deletes the machine row, revokes its sessions, queues its refresh and audits', async () => {
    agentToken();
    paired();
    grant({ [MACHINE]: { maxTier: 2, wholeSite: true }, 'm-2': { maxTier: 3, wholeSite: true } });
    seedSession('s1', MACHINE);
    seedSession('s2', 'm-2');

    const res = await DELETE(request());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ dropped: true });
    expect(sendersOf()).toEqual(['m-2']);
    expect((store.get(FLEET_DOC) as { senders: Data }).senders['m-2']).toEqual({ maxTier: 3, wholeSite: true });
    expect(sessionDocs()).toEqual(['fleet_sessions/s2']);

    const pending = [...store.entries()].filter(([path]) => path.endsWith('/commands/pending'));
    expect(pending.map(([path]) => path)).toEqual([`sites/${SITE}/machines/${MACHINE}/commands/pending`]);
    const commands = Object.entries(pending[0][1]);
    expect(commands).toHaveLength(1);
    expect(commands[0][0]).toMatch(/^site_settings_refresh_m_1_/);
    expect(commands[0][1]).toMatchObject({ type: 'site_settings_refresh', siteId: SITE, queuedBy: `machine:${MACHINE}` });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: SITE,
      actor: `machine:${MACHINE}`,
      targetId: MACHINE,
      attributes: { verb: 'fleet_grant_dropped', endpoint: 'agent/fleet/grant', method: 'DELETE', machineId: MACHINE },
    });
  });

  it('answers dropped false with no writes when the machine has no row', async () => {
    agentToken();
    paired();
    grant({ 'm-2': { maxTier: 3, wholeSite: true } });
    seedSession('s2', 'm-2');
    const before = structuredClone([...store.entries()]);

    const res = await DELETE(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dropped: false });
    expect(writes).toEqual([]);
    expect([...store.entries()]).toEqual(before);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('answers dropped false when the site has no fleet document', async () => {
    agentToken();
    paired();

    const res = await DELETE(request());

    expect(await res.json()).toEqual({ dropped: false });
    expect(writes).toEqual([]);
  });

  it('is idempotent: the second drop finds no row', async () => {
    agentToken();
    paired();
    grant({ [MACHINE]: { maxTier: 2, wholeSite: true } });

    expect(await (await DELETE(request())).json()).toEqual({ dropped: true });
    expect(await (await DELETE(request())).json()).toEqual({ dropped: false });
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('refuses a machine whose pairing is gone, and leaves the grant', async () => {
    agentToken();
    grant({ [MACHINE]: { maxTier: 2, wholeSite: true } });
    store.set(`sites/${SITE}/machines/${MACHINE}`, { online: true });

    const res = await DELETE(request());

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('pairing_revoked');
    expect(sendersOf()).toEqual([MACHINE]);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  describe('refuses a caller that is not an agent', () => {
    beforeEach(() => {
      paired();
      grant({ [MACHINE]: { maxTier: 2, wholeSite: true } });
    });

    async function expectRefused(res: Response) {
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('unauthorized');
      expect(sendersOf()).toEqual([MACHINE]);
      expect(mockEmitMutation).not.toHaveBeenCalled();
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
    }

    it('no token', async () => {
      await expectRefused(await DELETE(request({})));
    });

    it('a token that does not verify', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('auth/id-token-expired'));
      await expectRefused(await DELETE(request()));
    });

    it('a user ID token', async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'user-1', email: 'a@example.com' });
      await expectRefused(await DELETE(request()));
    });

    it('an api key, without verifying it as an ID token', async () => {
      await expectRefused(await DELETE(request({ Authorization: `Bearer owk_live_${'a'.repeat(40)}` })));
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });
  });

  describe('the rate limit', () => {
    it('is 10 a minute per machine, on the fleet grant limiter', async () => {
      expect(FLEET_GRANT_RATE_LIMIT_PER_MINUTE).toBe(10);
      agentToken();
      await DELETE(request());
      expect(mockCheckRateLimit).toHaveBeenCalledWith(fleetGrantRateLimit, `fleet_grant:${SITE}:${MACHINE}`);
    });

    it('answers 429 with Retry-After and drops nothing', async () => {
      agentToken();
      paired();
      grant({ [MACHINE]: { maxTier: 2, wholeSite: true } });
      mockCheckRateLimit.mockResolvedValue({ success: false, limit: 10, remaining: 0, reset: T0 + 60_000, retryAfter: 30 });

      const res = await DELETE(request());

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('30');
      expect((await res.json()).code).toBe('rate_limited');
      expect(sendersOf()).toEqual([MACHINE]);
      expect(mockEmitMutation).not.toHaveBeenCalled();
    });
  });
});
