/** @jest-environment node */

/**
 * GET /api/account/plan — the signed-in user's own plan. pins the session-only
 * auth (agents refused), the unenforced answer that reads no usage, the derived
 * tier, the wire limits (null for unrestricted), the keys_missing reason, the
 * calendar-month usage window, whether the user owns a site, and which
 * machines a machine limit keeps live.
 */

import { enforcePlans, stopEnforcingPlans } from '../helpers/planEnforcement';
import { createMockRequest, parseResponse } from '../helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

const mockRequireSessionOrIdToken = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSessionOrIdToken: (...a: unknown[]) => mockRequireSessionOrIdToken(...a),
  };
});

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

let mockUsers: Record<string, Record<string, unknown>> = {};
/** the owner of every site that exists. */
let mockSiteOwners: string[] = [];
/** the payer's sites, their machines, and each machine's pairedAt in ms (null: never stamped). */
let mockOwnedMachines: Record<string, Record<string, number | null>> = {};
const mockSitesQuery = jest.fn();
const mockMachinesRead = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'users') {
        return { doc: (uid: string) => ({ get: async () => ({ data: () => mockUsers[uid] }) }) };
      }
      if (name !== 'sites') throw new Error(`unexpected collection ${name}`);
      return {
        where: (field: string, op: string, value: string) => ({
          limit: (n: number) => ({
            select: () => ({
              get: async () => {
                mockSitesQuery(field, op, value, n);
                return { empty: !mockSiteOwners.includes(value) };
              },
            }),
          }),
          select: () => ({
            get: async () => {
              mockSitesQuery(field, op, value);
              return {
                docs: Object.entries(mockOwnedMachines).map(([siteId, machines]) => ({
                  id: siteId,
                  ref: {
                    collection: (sub: string) => ({
                      select: (...fields: string[]) => ({
                        get: async () => {
                          mockMachinesRead(siteId, sub, fields);
                          return {
                            docs: Object.entries(machines).map(([id, pairedAt]) => ({
                              id,
                              get: (field: string) =>
                                field === 'pairedAt' && pairedAt !== null ? { toMillis: () => pairedAt } : undefined,
                            })),
                          };
                        },
                      }),
                    }),
                  },
                })),
              };
            },
          }),
        }),
      };
    },
  }),
}));

const mockActiveMachinesBetween = jest.fn();
jest.mock('@/lib/planUsage.server', () => ({
  activeMachinesBetween: (...a: unknown[]) => mockActiveMachinesBetween(...a),
}));

import { ApiAuthError } from '@/lib/apiAuth.server';
import { __resetForTests } from '@/lib/plan.server';
import { GET } from '@/app/api/account/plan/route';

const ALL_KEYS = (machines: string, sites: string, flag: '0' | '1') => ({
  'owlette.machines': machines,
  'owlette.sites': sites,
  'owlette.control': flag,
  'owlette.deployments': flag,
  'owlette.swoop': flag,
  'owlette.hoot': flag,
  'owlette.roost': flag,
  'owlette.talons': flag,
  'owlette.webhooks': flag,
  'owlette.api_keys': flag,
});

const answer = (resolved: boolean, standing: string, ent: Record<string, string>) => ({
  ok: true,
  resolved,
  standing,
  inGoodStanding: standing === 'active' || standing === 'trialing',
  ent,
  epoch: 1,
});

const ALL_FLAGS = {
  control: true,
  deployments: true,
  swoop: true,
  hoot: true,
  roost: true,
  talons: true,
  webhooks: true,
  api_keys: true,
};
const NO_FLAGS = {
  control: false,
  deployments: false,
  swoop: false,
  hoot: false,
  roost: false,
  talons: false,
  webhooks: false,
  api_keys: false,
};

const UNRESTRICTED = { limits: { machines: null, sites: null }, flags: ALL_FLAGS };

async function getPlan() {
  return parseResponse(await GET(createMockRequest('/api/account/plan')));
}

beforeEach(() => {
  __resetForTests();
  jest.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
  mockUsers = { u1: { role: 'user' }, root: { role: 'superadmin' } };
  mockSiteOwners = ['u1'];
  mockOwnedMachines = { 'site-a': { 'kiosk-1': Date.UTC(2026, 8, 1) } };
  mockSitesQuery.mockClear();
  mockMachinesRead.mockClear();
  mockRequireSessionOrIdToken.mockResolvedValue('u1');
  mockGetEntitlements.mockResolvedValue(answer(false, 'expired', ALL_KEYS('1', '1', '0')));
  mockActiveMachinesBetween.mockResolvedValue(1);
  enforcePlans();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(stopEnforcingPlans);

describe('GET /api/account/plan', () => {
  it('asks for a session or id token and refuses agent tokens', async () => {
    await getPlan();
    expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(expect.anything(), { rejectAgentTokens: true });
  });

  it.each([
    [401, 'Unauthorized: No valid session'],
    [403, 'Forbidden: agent credentials cannot create api keys'],
  ])('answers %i problem+json without reading a plan', async (status, message) => {
    mockRequireSessionOrIdToken.mockRejectedValue(new ApiAuthError(status, message));

    const res = await getPlan();

    expect(res.status).toBe(status);
    expect(res.body.status).toBe(status);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(mockActiveMachinesBetween).not.toHaveBeenCalled();
  });

  it('answers enforced false with the reason and reads nothing while enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforced: false,
      reason: 'enforcement_off',
      plan: null,
      standing: null,
      ...UNRESTRICTED,
      activeMachinesThisMonth: null,
    });
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(mockActiveMachinesBetween).not.toHaveBeenCalled();
    expect(mockSitesQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['superadmin', 'root', answer(true, 'active', ALL_KEYS('1', '1', '0'))],
    ['unreachable', 'u1', { ok: false, reason: 'unreachable' }],
    ['rejected', 'u1', { ok: false, reason: 'rejected' }],
  ])('reports %s as not enforced, without a usage read', async (reason, uid, tridant) => {
    mockRequireSessionOrIdToken.mockResolvedValue(uid);
    mockGetEntitlements.mockResolvedValue(tridant);

    const res = await getPlan();

    expect(res.body).toMatchObject({ enforced: false, reason, plan: null, ...UNRESTRICTED });
    expect(res.body).not.toHaveProperty('ownsSites');
    expect(res.body).not.toHaveProperty('liveMachines');
    expect(mockActiveMachinesBetween).not.toHaveBeenCalled();
    expect(mockSitesQuery).not.toHaveBeenCalled();
  });

  it('answers an unmapped payer as free, with this month of usage, the sites it owns and its live machine', async () => {
    mockActiveMachinesBetween.mockResolvedValue(2);

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforced: true,
      plan: 'free',
      standing: 'expired',
      limits: { machines: 1, sites: 1 },
      flags: NO_FLAGS,
      activeMachinesThisMonth: 2,
      ownsSites: true,
      liveMachines: [{ siteId: 'site-a', machineId: 'kiosk-1' }],
    });
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith(
      'u1',
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-07T12:00:00Z'),
    );
    expect(mockSitesQuery).toHaveBeenCalledWith('owner', '==', 'u1', 1);
    expect(mockSitesQuery).toHaveBeenCalledWith('owner', '==', 'u1');
    expect(mockMachinesRead).toHaveBeenCalledWith('site-a', 'machines', ['pairedAt']);
  });

  it('keeps the earliest paired machine live across every owned site, unstamped machines last', async () => {
    mockOwnedMachines = {
      'site-a': { 'kiosk-b': null, 'kiosk-c': Date.UTC(2026, 9, 2) },
      'site-b': { 'kiosk-a': null, 'kiosk-d': Date.UTC(2026, 9, 1) },
    };

    const res = await getPlan();

    expect(res.body.liveMachines).toEqual([{ siteId: 'site-b', machineId: 'kiosk-d' }]);
  });

  it('breaks a pairedAt tie, and orders unstamped machines, by machine id', async () => {
    const at = Date.UTC(2026, 9, 1);
    mockGetEntitlements.mockResolvedValue(answer(true, 'active', ALL_KEYS('4', 'unlimited', '1')));
    mockOwnedMachines = {
      'site-a': { 'kiosk-z': null, 'kiosk-b': at },
      'site-b': { 'kiosk-y': null, 'kiosk-a': at, 'kiosk-x': null },
    };

    const res = await getPlan();

    expect(res.body.liveMachines).toEqual([
      { siteId: 'site-b', machineId: 'kiosk-a' },
      { siteId: 'site-a', machineId: 'kiosk-b' },
      { siteId: 'site-b', machineId: 'kiosk-x' },
      { siteId: 'site-b', machineId: 'kiosk-y' },
    ]);
  });

  it('answers every machine live while the payer has fewer than the limit', async () => {
    mockGetEntitlements.mockResolvedValue(answer(true, 'active', ALL_KEYS('3', 'unlimited', '1')));

    const res = await getPlan();

    expect(res.body.liveMachines).toEqual([{ siteId: 'site-a', machineId: 'kiosk-1' }]);
  });

  it('answers an empty live list for a payer with no machines', async () => {
    mockOwnedMachines = {};

    const res = await getPlan();

    expect(res.body.liveMachines).toEqual([]);
  });

  it('answers ownsSites false for a user who owns no site, a member of others only', async () => {
    mockSiteOwners = ['someone-else'];

    const res = await getPlan();

    expect(res.body).toMatchObject({ enforced: true, plan: 'free', ownsSites: false });
  });

  it('answers core: control with unlimited machines on one site, without the pro flags', async () => {
    mockGetEntitlements.mockResolvedValue(
      answer(true, 'active', { ...ALL_KEYS('unlimited', '1', '0'), 'owlette.control': '1' }),
    );

    const res = await getPlan();

    expect(res.body).toMatchObject({
      enforced: true,
      plan: 'core',
      limits: { machines: null, sites: 1 },
      flags: { ...NO_FLAGS, control: true },
    });
    expect(res.body).not.toHaveProperty('reason');
    expect(res.body).not.toHaveProperty('liveMachines');
    expect(mockMachinesRead).not.toHaveBeenCalled();
  });

  it('answers a trial with unrestricted limits as null', async () => {
    mockGetEntitlements.mockResolvedValue(answer(true, 'trialing', ALL_KEYS('unlimited', 'unlimited', '1')));

    const res = await getPlan();

    expect(res.body).toMatchObject({ enforced: true, plan: 'trial', standing: 'trialing', ...UNRESTRICTED });
    expect(res.body).not.toHaveProperty('reason');
    expect(res.body).not.toHaveProperty('liveMachines');
  });

  it('answers pro with a counted machine limit', async () => {
    mockGetEntitlements.mockResolvedValue(answer(true, 'active', ALL_KEYS('3', 'unlimited', '1')));

    const res = await getPlan();

    expect(res.body).toMatchObject({ plan: 'pro', standing: 'active', limits: { machines: 3, sites: null } });
  });

  it('names the keys tridant sent no value for, which read as unrestricted', async () => {
    mockGetEntitlements.mockResolvedValue(
      answer(true, 'active', { 'owlette.machines': '5', 'owlette.sites': '1', 'owlette.control': '1' }),
    );

    const res = await getPlan();

    expect(res.body).toMatchObject({
      enforced: true,
      reason: 'keys_missing',
      missingKeys: [
        'owlette.deployments',
        'owlette.swoop',
        'owlette.hoot',
        'owlette.roost',
        'owlette.talons',
        'owlette.webhooks',
        'owlette.api_keys',
      ],
      plan: 'pro',
      limits: { machines: 5, sites: 1 },
      flags: ALL_FLAGS,
    });
  });

  it('answers 500 when the usage read fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockActiveMachinesBetween.mockRejectedValue(new Error('firestore down'));

    const res = await getPlan();

    expect(res.status).toBe(500);
  });
});
