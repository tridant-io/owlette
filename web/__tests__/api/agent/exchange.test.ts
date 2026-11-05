/** @jest-environment node */

/**
 * /api/agent/auth/exchange and the machine limit (plan.md decision 6): a
 * registration code mints credentials, so the limit is checked before the mint,
 * refused as 402 `{ error }` (never 401/403, which an agent reads as a dead
 * credential), and a successful mint stamps `pairedAt` once.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: <H,>(handler: H): H => handler,
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

type Doc = Record<string, unknown>;
// the whole fake store, keyed by document path
let mockDocs: Record<string, Doc> = {};
const mockSet = jest.fn();
const mockTxUpdate = jest.fn();
const mockTxSet = jest.fn();
const mockStampFailure = { on: false };
const mockPlanRead = jest.fn();
const mockCreateCustomToken = jest.fn();

function mockSnap(path: string) {
  const data = mockDocs[path];
  return { exists: data !== undefined, data: () => data };
}

function mockRef(path: string): Record<string, unknown> {
  return {
    path,
    get: async () => {
      if (/^(sites|users)\/[^/]+$/.test(path)) mockPlanRead(path);
      return mockSnap(path);
    },
    set: (data: Doc) => mockSet(path, data),
    collection: (sub: string) => mockCollection(`${path}/${sub}`),
  };
}

function mockCollection(path: string) {
  const children = () =>
    Object.keys(mockDocs)
      .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
      .map((p) => ({ id: p.slice(path.length + 1), ref: mockRef(p) }));
  return {
    doc: (id: string) => mockRef(`${path}/${id}`),
    select: () => ({ get: async () => ({ docs: children() }) }),
    where: (field: string, _op: string, value: unknown) => ({
      select: () => ({
        get: async () => {
          mockPlanRead(`${path}?${field}==${String(value)}`);
          return { docs: children().filter((d) => mockDocs[d.ref.path as string][field] === value) };
        },
      }),
    }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => mockCollection(name),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: { path: string }) => {
          if (mockStampFailure.on && ref.path.includes('/machines/')) throw new Error('contention');
          return mockSnap(ref.path);
        },
        update: (ref: { path: string }, data: Doc) => mockTxUpdate(ref.path, data),
        set: (ref: { path: string }, data: Doc, options?: unknown) => mockTxSet(ref.path, data, options),
      };
      return fn(tx);
    },
  }),
  getAdminAuth: () => ({
    createCustomToken: mockCreateCustomToken,
    setCustomUserClaims: jest.fn().mockResolvedValue(undefined),
  }),
}));

import logger from '@/lib/logger';
import { POST } from '@/app/api/agent/auth/exchange/route';
import { MACHINE_LIMIT_ERROR } from '@/lib/pairingPlan.server';

const FREE = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  ent: { 'owlette.machines': '1', 'owlette.sites': '1', 'owlette.control': '0' },
  epoch: 0,
};

const originalFetch = global.fetch;

function exchange(machineId: string) {
  return POST(
    new NextRequest(new URL('http://localhost/api/agent/auth/exchange'), {
      method: 'POST',
      body: JSON.stringify({ registrationCode: 'reg-code', machineId, version: '4.1.7' }),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function pairedAtWrite(machineId: string) {
  return mockTxSet.mock.calls.find(([path]) => path === `sites/site-1/machines/${machineId}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStampFailure.on = false;
  mockCreateCustomToken.mockResolvedValue('custom-token');
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-api-key';
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ idToken: 'id-token' }),
    body: { cancel: jest.fn() },
  });
  mockDocs = {
    'agent_tokens/reg-code': {
      siteId: 'site-1',
      createdBy: 'user-1',
      used: false,
      expiresAt: { toMillis: () => Date.now() + 600_000 },
    },
    'sites/site-1': { owner: 'owner-1' },
  };
});

afterEach(() => {
  delete process.env.PLAN_ENFORCEMENT;
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
});

afterAll(() => {
  global.fetch = originalFetch;
});

function enforceFree() {
  process.env.PLAN_ENFORCEMENT = 'on';
  process.env.TRIDANT_API_URL = 'https://id.tridant.test';
  process.env.TRIDANT_LICENSE_KEY = 'test-license-key';
  mockGetEntitlements.mockResolvedValue(FREE);
}

describe('POST /api/agent/auth/exchange', () => {
  it('pairs, claims the code and stamps pairedAt, never reading the plan with enforcement off', async () => {
    mockDocs['sites/site-1/machines/other-pc'] = {};
    mockGetEntitlements.mockResolvedValue(FREE);

    const res = await exchange('new-pc');

    expect(res.status).toBe(200);
    expect((await res.json()).accessToken).toBe('id-token');
    expect(mockTxUpdate).toHaveBeenCalledWith('agent_tokens/reg-code', expect.objectContaining({ used: true }));
    expect(pairedAtWrite('new-pc')?.slice(1)).toEqual([{ pairedAt: 'SERVER_TIMESTAMP' }, { merge: true }]);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(mockPlanRead).not.toHaveBeenCalled();
  });

  it('refuses a new machine past the limit with 402 { error }, minting nothing and leaving the code unused', async () => {
    enforceFree();
    mockDocs['sites/site-1/machines/other-pc'] = {};

    const res = await exchange('new-pc');

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: MACHINE_LIMIT_ERROR });
    expect(mockGetEntitlements).toHaveBeenCalledWith('owner-1');
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
  });

  it("lets a machine already in the payer's sites re-pair, keeping its first pairedAt", async () => {
    enforceFree();
    mockDocs['sites/site-1/machines/home-pc'] = { pairedAt: 'FIRST' };

    const res = await exchange('home-pc');

    expect(res.status).toBe(200);
    expect(mockCreateCustomToken).toHaveBeenCalled();
    expect(pairedAtWrite('home-pc')).toBeUndefined();
  });

  it('never stamps a nested doc for a machine id with a slash', async () => {
    const res = await exchange('pc/commands/pending');

    expect(res.status).toBe(200);
    expect(mockTxSet).not.toHaveBeenCalled();
  });

  it('still hands over the credentials when the pairedAt stamp fails', async () => {
    mockStampFailure.on = true;

    const res = await exchange('new-pc');

    expect(res.status).toBe(200);
    expect((await res.json()).refreshToken).toEqual(expect.any(String));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('pairedAt not stamped'),
      expect.objectContaining({ context: 'pairing' }),
    );
  });
});
