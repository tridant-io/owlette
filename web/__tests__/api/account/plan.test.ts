/** @jest-environment node */

/**
 * GET /api/account/plan — the signed-in user's account as an owner who pays for
 * sites. pins the session-only auth (agents refused), the off answer that reads
 * nothing, the lazy trial start and the trial states, each owned site's plan,
 * billing pointer, period and usage window, the free counts and live machines,
 * and that a failed trial start, founders read or usage count only costs its
 * own field.
 */

import {
  CORE_ENTITLEMENTS,
  enforcePlans,
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  stopEnforcingPlans,
  TRIAL_ENTITLEMENTS,
} from '../helpers/planEnforcement';
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

const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
}));

const mockEnsureTrial = jest.fn();
jest.mock('@/lib/planTrial.server', () => ({
  ensureTrial: (uid: string) => mockEnsureTrial(uid),
}));

const mockGetPlanAccount = jest.fn();
jest.mock('@/lib/planAccounts.server', () => ({
  getPlanAccount: (uid: string) => mockGetPlanAccount(uid),
}));

const mockFoundersRemaining = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  foundersRemaining: () => mockFoundersRemaining(),
}));

const mockActiveMachinesBetween = jest.fn();
jest.mock('@/lib/planUsage.server', () => ({
  activeMachinesBetween: (...a: unknown[]) => mockActiveMachinesBetween(...a),
}));

interface MockSite {
  owner: string;
  name?: string;
  billing?: unknown;
  /** each machine's pairedAt in ms (null: never stamped). */
  machines?: Record<string, number | null>;
}

let mockUsers: Record<string, Record<string, unknown>> = {};
let mockSites: Record<string, MockSite> = {};
let mockSitesError: Error | null = null;
const mockGetUser = jest.fn();
const mockSitesQuery = jest.fn();
const mockMachinesRead = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ getUser: (uid: string) => mockGetUser(uid) }),
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'users') {
        return { doc: (uid: string) => ({ get: async () => ({ data: () => mockUsers[uid] }) }) };
      }
      if (name !== 'sites') throw new Error(`unexpected collection ${name}`);
      return {
        where: (field: string, op: string, value: string) => ({
          select: (...fields: string[]) => ({
            get: async () => {
              mockSitesQuery(field, op, value, fields);
              if (mockSitesError) throw mockSitesError;
              return {
                docs: Object.entries(mockSites)
                  .filter(([, site]) => site.owner === value)
                  .map(([siteId, site]) => ({
                    id: siteId,
                    data: () => ({ owner: site.owner, name: site.name, billing: site.billing }),
                    ref: {
                      collection: (sub: string) => ({
                        select: (...machineFields: string[]) => ({
                          get: async () => {
                            mockMachinesRead(siteId, sub, machineFields);
                            return {
                              docs: Object.entries(site.machines ?? {}).map(([id, pairedAt]) => ({
                                id,
                                get: (machineField: string) =>
                                  machineField === 'pairedAt' && pairedAt !== null
                                    ? { toMillis: () => pairedAt }
                                    : undefined,
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

import { ApiAuthError } from '@/lib/apiAuth.server';
import { __resetForTests } from '@/lib/plan.server';
import type { PlanAccount } from '@/lib/planAccounts.server';
import type { EntitlementsResult } from '@/lib/tridantEntitlements.server';
import { GET } from '@/app/api/account/plan/route';

const NOW = Date.UTC(2026, 10, 11, 12);
const MONTH_START = Date.UTC(2026, 10, 1);
const TRIAL_END = Date.UTC(2026, 10, 15);

/** tridant's answer per site; a site not named here is one tridant does not know, so owlette free. */
let mockEntitlements: Record<string, EntitlementsResult> = {};

const account = (over: Partial<PlanAccount> = {}): PlanAccount => ({
  trialStartedAt: null,
  trialEndsAt: null,
  orgId: null,
  linkRequired: false,
  trialError: null,
  claimedAt: null,
  ...over,
});

const FREE_SITE = {
  siteId: 'site-a',
  name: 'lobby',
  tier: 'free',
  standing: 'expired',
  inGoodStanding: false,
  billing: null,
  period: null,
  activeMachinesThisPeriod: 1,
};

const FREE_ONE_OF_ONE = {
  sitesUsed: 1,
  sitesLimit: 1,
  machinesUsed: 1,
  machinesLimit: 1,
  liveMachines: [{ siteId: 'site-a', machineId: 'kiosk-1' }],
};

async function getPlan() {
  return parseResponse(await GET(createMockRequest('/api/account/plan')));
}

beforeEach(() => {
  __resetForTests();
  jest.useFakeTimers({ now: new Date(NOW) });
  jest.clearAllMocks();
  mockUsers = { u1: { role: 'user' }, root: { role: 'superadmin' } };
  mockSites = {
    'site-a': { owner: 'u1', name: 'lobby', machines: { 'kiosk-1': Date.UTC(2026, 8, 1) } },
    'site-x': { owner: 'someone-else', name: 'theirs', machines: { 'kiosk-9': Date.UTC(2026, 7, 1) } },
  };
  mockSitesError = null;
  mockEntitlements = {};
  mockRequireSessionOrIdToken.mockResolvedValue('u1');
  mockGetSiteEntitlements.mockImplementation(async (siteId: string) => mockEntitlements[siteId] ?? FREE_ENTITLEMENTS);
  mockEnsureTrial.mockResolvedValue({ status: 'already_started' });
  mockGetUser.mockResolvedValue({ emailVerified: true });
  mockGetPlanAccount.mockResolvedValue(
    account({ trialStartedAt: MONTH_START, trialEndsAt: TRIAL_END, orgId: 'org_1' }),
  );
  mockFoundersRemaining.mockResolvedValue({ ok: true, core: 40, pro: null });
  mockActiveMachinesBetween.mockResolvedValue(1);
  delete process.env.TRIDANT_OIDC_ISSUER;
  delete process.env.TRIDANT_OIDC_CLIENT_ID;
  delete process.env.TRIDANT_OIDC_CLIENT_SECRET;
  enforcePlans();
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  stopEnforcingPlans();
  delete process.env.TRIDANT_OIDC_ISSUER;
  delete process.env.TRIDANT_OIDC_CLIENT_ID;
  delete process.env.TRIDANT_OIDC_CLIENT_SECRET;
});

function expectNothingRead() {
  expect(mockEnsureTrial).not.toHaveBeenCalled();
  expect(mockGetUser).not.toHaveBeenCalled();
  expect(mockGetPlanAccount).not.toHaveBeenCalled();
  expect(mockFoundersRemaining).not.toHaveBeenCalled();
  expect(mockSitesQuery).not.toHaveBeenCalled();
  expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  expect(mockActiveMachinesBetween).not.toHaveBeenCalled();
}

describe('GET /api/account/plan', () => {
  it('asks for a session or id token and refuses agent tokens', async () => {
    await getPlan();
    expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(expect.anything(), { rejectAgentTokens: true });
  });

  it.each([
    [401, 'Unauthorized: No valid session'],
    [403, 'Forbidden: agent credentials cannot create api keys'],
  ])('answers %i problem+json without starting a trial or reading a plan', async (status, message) => {
    mockRequireSessionOrIdToken.mockRejectedValue(new ApiAuthError(status, message));

    const res = await getPlan();

    expect(res.status).toBe(status);
    expect(res.body.status).toBe(status);
    expectNothingRead();
  });

  it('answers enforced false with the reason and reads nothing while enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enforced: false, reason: 'enforcement_off' });
    expectNothingRead();
  });

  it('answers not_configured, and reads nothing, when enforcement is on without a tridant key', async () => {
    delete process.env.TRIDANT_LICENSE_KEY;

    const res = await getPlan();

    expect(res.body).toEqual({ enforced: false, reason: 'not_configured' });
    expectNothingRead();
  });

  it('answers an unverified account as on free, told to verify, with its site and live machine', async () => {
    mockEnsureTrial.mockResolvedValue({ status: 'unverified' });
    mockGetUser.mockResolvedValue({ emailVerified: false });
    mockGetPlanAccount.mockResolvedValue(null);

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforced: true,
      emailVerified: false,
      trial: { status: 'unverified', endsAt: null },
      sites: [FREE_SITE],
      free: FREE_ONE_OF_ONE,
      foundersRemaining: { core: 40, pro: null },
      linkAvailable: false,
    });
    expect(mockEnsureTrial).toHaveBeenCalledWith('u1');
    expect(mockSitesQuery).toHaveBeenCalledWith('owner', '==', 'u1', ['name', 'owner', 'billing']);
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith('site-a', MONTH_START, NOW);
    expect(mockMachinesRead).toHaveBeenCalledWith('site-a', 'machines', ['pairedAt']);
  });

  it('starts the trial before it reads the sites, which then answer as trialing and count nothing as free', async () => {
    mockEnsureTrial.mockResolvedValue({ status: 'started' });
    mockEntitlements = { 'site-a': TRIAL_ENTITLEMENTS };

    const res = await getPlan();

    expect(res.body).toEqual({
      enforced: true,
      emailVerified: true,
      trial: { status: 'active', endsAt: TRIAL_END },
      sites: [{ ...FREE_SITE, tier: 'trial', standing: 'trialing', inGoodStanding: true }],
      free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
      foundersRemaining: { core: 40, pro: null },
      linkAvailable: false,
    });
    expect(mockEnsureTrial.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetSiteEntitlements.mock.invocationCallOrder[0],
    );
    expect(mockEnsureTrial.mock.invocationCallOrder[0]).toBeLessThan(mockGetPlanAccount.mock.invocationCallOrder[0]);
    // no period under a trial: the count runs from the 1st of the month.
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith('site-a', MONTH_START, NOW);
    expect(mockMachinesRead).not.toHaveBeenCalled();
  });

  it('answers an ended trial on free: both sites count, and the earliest paired machine stays live', async () => {
    mockGetPlanAccount.mockResolvedValue(
      account({ trialStartedAt: Date.UTC(2026, 9, 20), trialEndsAt: Date.UTC(2026, 10, 3), orgId: 'org_1' }),
    );
    mockSites = {
      'site-a': { owner: 'u1', name: 'lobby', machines: { 'kiosk-b': null, 'kiosk-c': Date.UTC(2026, 9, 2) } },
      'site-b': { owner: 'u1', name: 'annex', machines: { 'kiosk-a': null, 'kiosk-d': Date.UTC(2026, 9, 1) } },
    };

    const res = await getPlan();

    expect(res.body.trial).toEqual({ status: 'ended', endsAt: Date.UTC(2026, 10, 3) });
    expect(res.body.sites.map((site: { siteId: string; tier: string }) => [site.siteId, site.tier])).toEqual([
      ['site-a', 'free'],
      ['site-b', 'free'],
    ]);
    expect(res.body.free).toEqual({
      sitesUsed: 2,
      sitesLimit: 1,
      machinesUsed: 4,
      machinesLimit: 1,
      liveMachines: [{ siteId: 'site-b', machineId: 'kiosk-d' }],
    });
  });

  it('breaks a pairedAt tie, and orders unstamped machines, by machine id', async () => {
    const at = Date.UTC(2026, 9, 1);
    const fourMachines = { ...FREE_ENTITLEMENTS, ent: { ...FREE_ENTITLEMENTS.ent, 'owlette.machines': '4' } };
    mockEntitlements = { 'site-a': fourMachines, 'site-b': fourMachines };
    mockSites = {
      'site-a': { owner: 'u1', machines: { 'kiosk-z': null, 'kiosk-b': at } },
      'site-b': { owner: 'u1', machines: { 'kiosk-y': null, 'kiosk-a': at, 'kiosk-x': null } },
    };

    const res = await getPlan();

    expect(res.body.free).toMatchObject({ machinesUsed: 5, machinesLimit: 4 });
    expect(res.body.free.liveMachines).toEqual([
      { siteId: 'site-b', machineId: 'kiosk-a' },
      { siteId: 'site-a', machineId: 'kiosk-b' },
      { siteId: 'site-b', machineId: 'kiosk-x' },
      { siteId: 'site-b', machineId: 'kiosk-y' },
    ]);
  });

  it('counts a machine left on two free sites once, as pairing does, and keeps both live', async () => {
    mockSites = {
      'site-a': { owner: 'u1', machines: { 'kiosk-1': Date.UTC(2026, 8, 1) } },
      'site-b': { owner: 'u1', machines: { 'kiosk-1': Date.UTC(2026, 9, 1), 'kiosk-2': Date.UTC(2026, 9, 2) } },
    };

    const res = await getPlan();

    expect(res.body.free).toMatchObject({ machinesUsed: 2, machinesLimit: 1 });
    expect(res.body.free.liveMachines).toEqual([
      { siteId: 'site-a', machineId: 'kiosk-1' },
      { siteId: 'site-b', machineId: 'kiosk-1' },
    ]);
  });

  it('answers billed sites with their pointer, period and usage since the period started', async () => {
    const firstPeriod = Date.UTC(2026, 10, 5);
    const periodEnd = Date.UTC(2026, 11, 1);
    mockSites = {
      'site-a': {
        owner: 'u1',
        name: 'lobby',
        billing: { tier: 'pro', founders: true, payerUid: 'u1', endsAt: null, updatedAt: { seconds: 1 } },
        machines: { 'kiosk-1': Date.UTC(2026, 8, 1) },
      },
      'site-b': {
        owner: 'u1',
        name: 'annex',
        billing: { tier: 'core', founders: false, payerUid: 'u1', endsAt: periodEnd, updatedAt: { seconds: 1 } },
        machines: { 'kiosk-2': Date.UTC(2026, 8, 2) },
      },
      'site-c': { owner: 'u1', name: 'shed', machines: { 'kiosk-3': Date.UTC(2026, 8, 3) } },
    };
    mockEntitlements = {
      'site-a': { ...PRO_ENTITLEMENTS, billing: { ...PRO_ENTITLEMENTS.billing!, periodStart: firstPeriod } },
      'site-b': { ...CORE_ENTITLEMENTS, billing: { ...CORE_ENTITLEMENTS.billing!, endsAt: periodEnd } },
    };
    mockActiveMachinesBetween.mockImplementation(
      async (siteId: string) => ({ 'site-a': 5, 'site-b': 2 })[siteId] ?? 0,
    );

    const res = await getPlan();

    expect(res.body.sites).toEqual([
      {
        siteId: 'site-a',
        name: 'lobby',
        tier: 'pro',
        standing: 'active',
        inGoodStanding: true,
        billing: { tier: 'pro', founders: true, endsAt: null },
        period: { start: firstPeriod, end: periodEnd },
        activeMachinesThisPeriod: 5,
      },
      {
        siteId: 'site-b',
        name: 'annex',
        tier: 'core',
        standing: 'active',
        inGoodStanding: true,
        billing: { tier: 'core', founders: false, endsAt: periodEnd },
        period: { start: MONTH_START, end: periodEnd },
        activeMachinesThisPeriod: 2,
      },
      { ...FREE_SITE, siteId: 'site-c', name: 'shed', activeMachinesThisPeriod: 0 },
    ]);
    expect(res.body.free).toEqual({
      sitesUsed: 1,
      sitesLimit: 1,
      machinesUsed: 1,
      machinesLimit: 1,
      liveMachines: [{ siteId: 'site-c', machineId: 'kiosk-3' }],
    });
    expect(mockActiveMachinesBetween).toHaveBeenCalledTimes(3);
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith('site-a', firstPeriod, NOW);
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith('site-b', MONTH_START, NOW);
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith('site-c', MONTH_START, NOW);
    // only a free site's machines are read.
    expect(mockMachinesRead).toHaveBeenCalledTimes(1);
    expect(mockMachinesRead).toHaveBeenCalledWith('site-c', 'machines', ['pairedAt']);
  });

  it.each([
    ['the account is marked', { status: 'already_started' }, account({ linkRequired: true })],
    ['tridant just refused the trial', { status: 'link_required' }, null],
  ])('answers link_required when %s, and offers the link when the oidc client is set', async (_case, trial, stored) => {
    process.env.TRIDANT_OIDC_ISSUER = 'https://id-staging.tridant.io';
    process.env.TRIDANT_OIDC_CLIENT_ID = 'oic_test';
    process.env.TRIDANT_OIDC_CLIENT_SECRET = 'secret';
    mockEnsureTrial.mockResolvedValue(trial);
    mockGetPlanAccount.mockResolvedValue(stored);

    const res = await getPlan();

    expect(res.body).toMatchObject({
      enforced: true,
      emailVerified: true,
      trial: { status: 'link_required', endsAt: null },
      sites: [FREE_SITE],
      free: FREE_ONE_OF_ONE,
      linkAvailable: true,
    });
  });

  it('does not offer the link without the oidc client secret', async () => {
    process.env.TRIDANT_OIDC_CLIENT_ID = 'oic_test';

    const res = await getPlan();

    expect(res.body.linkAvailable).toBe(false);
  });

  it('answers ended with no end for an account that paid before it ever had a trial', async () => {
    mockEnsureTrial.mockResolvedValue({ status: 'subscribed' });
    mockGetPlanAccount.mockResolvedValue(account({ trialStartedAt: MONTH_START, orgId: 'org_1' }));

    const res = await getPlan();

    expect(res.body.trial).toEqual({ status: 'ended', endsAt: null });
  });

  it('answers none for a verified account whose trial has not started', async () => {
    mockEnsureTrial.mockResolvedValue({ status: 'busy' });
    mockGetPlanAccount.mockResolvedValue(account({ claimedAt: NOW }));

    const res = await getPlan();

    expect(res.body).toMatchObject({ emailVerified: true, trial: { status: 'none', endsAt: null } });
  });

  it('still answers when the trial start, the auth and account reads, founders and a usage count all fail', async () => {
    mockEnsureTrial.mockResolvedValue({ status: 'error' });
    mockGetUser.mockRejectedValue(new Error('auth down'));
    mockGetPlanAccount.mockRejectedValue(new Error('firestore down'));
    mockFoundersRemaining.mockResolvedValue({ ok: false, reason: 'unreachable' });
    mockActiveMachinesBetween.mockRejectedValue(new Error('firestore down'));

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforced: true,
      emailVerified: true,
      trial: { status: 'none', endsAt: null },
      sites: [{ ...FREE_SITE, activeMachinesThisPeriod: null }],
      free: FREE_ONE_OF_ONE,
      foundersRemaining: null,
      linkAvailable: false,
    });
  });

  it('answers unverified from the trial start when the auth read fails', async () => {
    mockEnsureTrial.mockResolvedValue({ status: 'unverified' });
    mockGetUser.mockRejectedValue(new Error('auth down'));
    mockGetPlanAccount.mockResolvedValue(null);

    const res = await getPlan();

    expect(res.body).toMatchObject({ emailVerified: false, trial: { status: 'unverified', endsAt: null } });
  });

  it.each([
    ['superadmin', 'root', TRIAL_ENTITLEMENTS],
    ['unreachable', 'u1', { ok: false, reason: 'unreachable' }],
    ['rejected', 'u1', { ok: false, reason: 'rejected' }],
  ] as const)('reports %s as not enforced when no owned site is held to a plan, without a usage read', async (reason, uid, tridant) => {
    mockRequireSessionOrIdToken.mockResolvedValue(uid);
    mockSites = { 'site-a': { owner: uid, name: 'lobby', machines: { 'kiosk-1': null } } };
    mockEntitlements = { 'site-a': tridant };

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enforced: false, reason });
    expect(mockActiveMachinesBetween).not.toHaveBeenCalled();
    expect(mockMachinesRead).not.toHaveBeenCalled();
  });

  it('answers a site whose plan could not be read as unrestricted beside the ones that could', async () => {
    mockSites = {
      'site-a': { owner: 'u1', name: 'lobby', machines: { 'kiosk-1': Date.UTC(2026, 8, 1) } },
      'site-b': { owner: 'u1', name: 'annex', machines: { 'kiosk-2': Date.UTC(2026, 7, 1) } },
    };
    mockEntitlements = { 'site-b': { ok: false, reason: 'unreachable' } };

    const res = await getPlan();

    expect(res.body.sites).toEqual([
      FREE_SITE,
      {
        siteId: 'site-b',
        name: 'annex',
        tier: null,
        standing: null,
        inGoodStanding: true,
        reason: 'unreachable',
        billing: null,
        period: null,
        activeMachinesThisPeriod: null,
      },
    ]);
    // it fails open: neither the site nor its machine counts toward free.
    expect(res.body.free).toEqual(FREE_ONE_OF_ONE);
    expect(mockActiveMachinesBetween).toHaveBeenCalledTimes(1);
  });

  it('answers a user who owns no site with no sites and nothing used', async () => {
    mockSites = { 'site-x': { owner: 'someone-else', machines: { 'kiosk-9': null } } };

    const res = await getPlan();

    expect(res.body).toMatchObject({
      enforced: true,
      sites: [],
      free: { sitesUsed: 0, sitesLimit: 1, machinesUsed: 0, machinesLimit: 1, liveMachines: [] },
    });
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  it('names a site with no name by its id', async () => {
    mockSites = { 'site-a': { owner: 'u1' } };

    const res = await getPlan();

    expect(res.body.sites[0]).toMatchObject({ siteId: 'site-a', name: 'site-a' });
  });

  it('names the keys a site answer left out, which read as unrestricted', async () => {
    mockEntitlements = {
      'site-a': {
        ...PRO_ENTITLEMENTS,
        ent: { 'owlette.machines': '5', 'owlette.sites': '1', 'owlette.control': '1' },
      },
    };

    const res = await getPlan();

    expect(res.body.missingKeys).toEqual([
      'owlette.deployments',
      'owlette.swoop',
      'owlette.hoot',
      'owlette.roost',
      'owlette.talons',
      'owlette.webhooks',
      'owlette.api_keys',
    ]);
    expect(res.body.sites[0]).toMatchObject({ tier: 'pro' });
  });

  it('answers 500 when the sites read fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSitesError = new Error('firestore down');

    const res = await getPlan();

    expect(res.status).toBe(500);
  });
});
