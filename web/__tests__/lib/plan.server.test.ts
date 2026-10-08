/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

type FakeSite = { data: Record<string, unknown>; machines: string[] };
let mockUsers: Record<string, Record<string, unknown>> = {};
let mockSites: Record<string, FakeSite> = {};

function mockSiteRef(siteId: string) {
  return {
    collection: (name: string) => {
      if (name !== 'machines') throw new Error(`unexpected subcollection ${name}`);
      return {
        select: () => ({
          get: async () => ({ docs: mockSites[siteId].machines.map((id) => ({ id })) }),
        }),
      };
    },
  };
}

const mockCollection = jest.fn((name: string) => {
  if (name === 'users') {
    return { doc: (uid: string) => ({ get: async () => ({ data: () => mockUsers[uid] }) }) };
  }
  if (name === 'sites') {
    return {
      doc: (siteId: string) => ({ get: async () => ({ data: () => mockSites[siteId]?.data }) }),
      where: (field: string, op: string, value: unknown) => {
        if (op !== '==') throw new Error(`unexpected operator ${op}`);
        const owned = Object.keys(mockSites).filter((id) => mockSites[id].data[field] === value);
        return {
          select: () => ({
            get: async () => ({ docs: owned.map((id) => ({ id, ref: mockSiteRef(id) })) }),
          }),
          count: () => ({ get: async () => ({ data: () => ({ count: owned.length }) }) }),
        };
      },
    };
  }
  throw new Error(`unexpected collection ${name}`);
});
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockCollection }),
}));

import logger from '@/lib/logger';
import {
  __resetForTests,
  entitled,
  machineSlotAvailable,
  missingPlanKeys,
  payerForSite,
  planLimit,
  planTier,
  requireEntitlement,
  resolvePlan,
  siteSlotAvailable,
  type Plan,
} from '@/lib/plan.server';

const FREE = {
  ok: true,
  resolved: false,
  standing: 'expired',
  inGoodStanding: false,
  ent: {
    'owlette.machines': '1',
    'owlette.sites': '1',
    'owlette.control': '0',
    'owlette.roost': '0',
    'owlette.talons': '0',
    'owlette.webhooks': '0',
    'owlette.api_keys': '0',
  },
  epoch: 0,
};

const TRIAL = {
  ok: true,
  resolved: true,
  standing: 'trialing',
  inGoodStanding: true,
  ent: {
    'owlette.machines': 'unlimited',
    'owlette.sites': 'unlimited',
    'owlette.control': '1',
    'owlette.roost': '1',
    'owlette.talons': '1',
    'owlette.webhooks': '1',
    'owlette.api_keys': '1',
  },
  epoch: 4,
};

const PRO = { ...TRIAL, standing: 'active', ent: { ...TRIAL.ent, 'owlette.machines': '3' } };

const FLAGS = [
  'owlette.control',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
] as const;

const enforced = (ent: Record<string, string>): Plan => ({
  enforced: true,
  resolved: true,
  standing: 'active',
  ent,
});

beforeEach(() => {
  __resetForTests();
  mockUsers = { u1: { role: 'user' }, root: { role: 'superadmin' } };
  mockSites = {};
  mockGetEntitlements.mockResolvedValue(FREE);
  process.env.PLAN_ENFORCEMENT = 'on';
  process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
  process.env.TRIDANT_LICENSE_KEY = 'tid_license_read_key';
  delete process.env.OWLETTE_E2E;
});

afterAll(() => {
  delete process.env.PLAN_ENFORCEMENT;
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
});

function expectNoReads() {
  expect(mockCollection).not.toHaveBeenCalled();
  expect(mockGetEntitlements).not.toHaveBeenCalled();
}

describe('resolvePlan', () => {
  it.each([undefined, 'off', 'true', 'ON'])('is off before any read when PLAN_ENFORCEMENT is %s', async (value) => {
    if (value === undefined) delete process.env.PLAN_ENFORCEMENT;
    else process.env.PLAN_ENFORCEMENT = value;

    expect(await resolvePlan('u1')).toEqual({ enforced: false, reason: 'enforcement_off' });
    expectNoReads();
  });

  it('is not_configured before any read when the tridant url or key is missing, and warns once', async () => {
    delete process.env.TRIDANT_API_URL;
    expect(await resolvePlan('u1')).toEqual({ enforced: false, reason: 'not_configured' });

    process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
    process.env.TRIDANT_LICENSE_KEY = '  ';
    expect(await resolvePlan('u1')).toEqual({ enforced: false, reason: 'not_configured' });

    expectNoReads();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('counts the e2e seam as configured', async () => {
    delete process.env.TRIDANT_API_URL;
    delete process.env.TRIDANT_LICENSE_KEY;
    process.env.OWLETTE_E2E = '1';

    expect(await resolvePlan('u1')).toMatchObject({ enforced: true, resolved: false });
    expect(mockGetEntitlements).toHaveBeenCalledWith('u1');
  });

  it('reports no_payer without a read', async () => {
    expect(await resolvePlan(null)).toEqual({ enforced: false, reason: 'no_payer' });
    expectNoReads();
  });

  it.each(['unreachable', 'malformed_response', 'not_configured'])('fails open on %s', async (reason) => {
    mockGetEntitlements.mockResolvedValue({ ok: false, reason });
    expect(await resolvePlan('u1')).toEqual({ enforced: false, reason });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails open on a rejected key, and logs an error once', async () => {
    mockGetEntitlements.mockResolvedValue({ ok: false, reason: 'rejected' });

    expect(await resolvePlan('u1')).toEqual({ enforced: false, reason: 'rejected' });
    await resolvePlan('u1');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('leaves a superadmin payer unrestricted, whatever tridant says', async () => {
    expect(await resolvePlan('root')).toEqual({ enforced: false, reason: 'superadmin' });

    mockGetEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });
    expect(await resolvePlan('root')).toEqual({ enforced: false, reason: 'superadmin' });
  });

  it('enforces an unmapped payer as tridant defaults, which is free', async () => {
    const plan = await resolvePlan('u1');
    expect(plan).toEqual({ enforced: true, resolved: false, standing: 'expired', ent: FREE.ent });
    expect(entitled(plan, 'owlette.control')).toBe(false);
    expect(planLimit(plan, 'owlette.machines')).toBe(1);
  });

  it('reads a payer with no user doc as not a superadmin', async () => {
    expect(await resolvePlan('ghost')).toMatchObject({ enforced: true });
  });
});

describe('planLimit and entitled', () => {
  it('leave an unenforced plan unrestricted', () => {
    const plan: Plan = { enforced: false, reason: 'unreachable' };
    expect(planLimit(plan, 'owlette.machines')).toBe(Infinity);
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(true);
  });

  it('read free: no flags, one machine, one site', () => {
    const plan = enforced(FREE.ent);
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(false);
    expect(planLimit(plan, 'owlette.machines')).toBe(1);
    expect(planLimit(plan, 'owlette.sites')).toBe(1);
  });

  it('read trial and pro: every flag, unlimited or counted limits', () => {
    for (const ent of [TRIAL.ent, PRO.ent]) {
      for (const flag of FLAGS) expect(entitled(enforced(ent), flag)).toBe(true);
    }
    expect(planLimit(enforced(TRIAL.ent), 'owlette.machines')).toBe(Infinity);
    expect(planLimit(enforced(PRO.ent), 'owlette.machines')).toBe(3);
  });

  it('treat a missing key as unrestricted, warning once per key', () => {
    const plan = enforced({ 'owlette.machines': '1' });

    expect(entitled(plan, 'owlette.control')).toBe(true);
    expect(entitled(plan, 'owlette.control')).toBe(true);
    expect(planLimit(plan, 'owlette.sites')).toBe(Infinity);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(jest.mocked(logger.warn).mock.calls[0][0]).toContain('owlette.control');
    expect(jest.mocked(logger.warn).mock.calls[1][0]).toContain('owlette.sites');
  });

  it.each(['-1', 'lots', '1.5', ''])('treat an unreadable value %p as unrestricted', (value) => {
    expect(planLimit(enforced({ 'owlette.machines': value }), 'owlette.machines')).toBe(Infinity);
  });
});

describe('missingPlanKeys', () => {
  it('is empty for an unenforced plan and for a full answer', () => {
    expect(missingPlanKeys({ enforced: false, reason: 'enforcement_off' })).toEqual([]);
    expect(missingPlanKeys(enforced(FREE.ent))).toEqual([]);
    expect(missingPlanKeys(enforced(TRIAL.ent))).toEqual([]);
  });

  it('lists the keys sent without a readable value, limits first', () => {
    const plan = enforced({ 'owlette.machines': '1', 'owlette.sites': 'lots', 'owlette.control': '0' });
    expect(missingPlanKeys(plan)).toEqual([
      'owlette.sites',
      'owlette.roost',
      'owlette.talons',
      'owlette.webhooks',
      'owlette.api_keys',
    ]);
  });
});

describe('planTier', () => {
  const withStanding = (standing: string, ent: Record<string, string>, resolved = true): Plan => ({
    enforced: true,
    resolved,
    standing,
    ent,
  });
  const CORE = { ...PRO.ent, 'owlette.roost': '0', 'owlette.talons': '0', 'owlette.webhooks': '0', 'owlette.api_keys': '0' };

  it('is null while plans are not enforced', () => {
    expect(planTier({ enforced: false, reason: 'superadmin' })).toBeNull();
  });

  it('reads an unmapped payer as free, whatever its standing or keys', () => {
    expect(planTier(withStanding('expired', FREE.ent, false))).toBe('free');
    expect(planTier(withStanding('active', PRO.ent, false))).toBe('free');
  });

  it.each(['expired', 'canceled'])('reads a %s subscription as free, even with pro keys', (standing) => {
    expect(planTier(withStanding(standing, PRO.ent))).toBe('free');
  });

  it('reads trialing as trial', () => {
    expect(planTier(withStanding('trialing', TRIAL.ent))).toBe('trial');
  });

  it.each(['active', 'past_due'])('reads %s from the entitlements: roost is pro, control is core, else free', (standing) => {
    expect(planTier(withStanding(standing, PRO.ent))).toBe('pro');
    expect(planTier(withStanding(standing, CORE))).toBe('core');
    expect(planTier(withStanding(standing, FREE.ent))).toBe('free');
  });

  it('reads an active payer whose keys are missing as pro, since missing is unrestricted', () => {
    expect(planTier(withStanding('active', {}))).toBe('pro');
  });
});

describe('payerForSite', () => {
  it('reads the site owner', async () => {
    mockSites.s1 = { data: { owner: 'u1' }, machines: [] };
    expect(await payerForSite('s1')).toBe('u1');
  });

  it('uses site data already read instead of reading again', async () => {
    expect(await payerForSite('s1', { owner: 'u9' })).toBe('u9');
    expect(await payerForSite('s1', null)).toBeNull();
    expect(mockCollection).not.toHaveBeenCalled();
  });

  it('is null for a missing site, a missing owner or a blank one', async () => {
    mockSites.s2 = { data: {}, machines: [] };
    mockSites.s3 = { data: { owner: '' }, machines: [] };
    expect(await payerForSite('nope')).toBeNull();
    expect(await payerForSite('s2')).toBeNull();
    expect(await payerForSite('s3')).toBeNull();
  });
});

describe('requireEntitlement', () => {
  beforeEach(() => {
    mockSites.s1 = { data: { owner: 'u1' }, machines: [] };
  });

  it('answers null before any read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    expect(await requireEntitlement('s1', 'owlette.control')).toBeNull();
    expectNoReads();
  });

  it('answers null before any read when tridant is not configured', async () => {
    delete process.env.TRIDANT_LICENSE_KEY;
    expect(await requireEntitlement('s1', 'owlette.control')).toBeNull();
    expectNoReads();
  });

  it('refuses a free payer with 402 plan_required', async () => {
    const res = await requireEntitlement('s1', 'owlette.roost');

    expect(res?.status).toBe(402);
    expect(res?.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(await res?.json()).toMatchObject({
      type: 'https://owlette.app/problems/plan-required',
      code: 'plan_required',
      status: 402,
      detail: "your plan doesn't include roost. upgrade to continue.",
      entitlement: 'owlette.roost',
      upgradeUrl: '/settings/plan',
    });
    expect(mockGetEntitlements).toHaveBeenCalledWith('u1');
  });

  it.each([['trial', TRIAL], ['pro', PRO]])('lets a %s payer through', async (_label, answer) => {
    mockGetEntitlements.mockResolvedValue(answer);
    for (const flag of FLAGS) expect(await requireEntitlement('s1', flag)).toBeNull();
  });

  it('lets an ownerless site through', async () => {
    mockSites.s1.data = {};
    expect(await requireEntitlement('s1', 'owlette.control')).toBeNull();
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });

  it('uses site data already read', async () => {
    const res = await requireEntitlement('other', 'owlette.control', { owner: 'u1' });
    expect(res?.status).toBe(402);
    expect(mockCollection).not.toHaveBeenCalledWith('sites');
  });
});

describe('machineSlotAvailable', () => {
  it('fits before any read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    mockSites.s1 = { data: { owner: 'u1' }, machines: ['m1'] };
    expect(await machineSlotAvailable('u1', 'm2')).toBe(true);
    expectNoReads();
  });

  it('gives free its first machine', async () => {
    mockSites.s1 = { data: { owner: 'u1' }, machines: [] };
    expect(await machineSlotAvailable('u1', 'm1')).toBe(true);
  });

  it('refuses free a second machine, but lets the first re-pair', async () => {
    mockSites.s1 = { data: { owner: 'u1' }, machines: ['m1'] };
    expect(await machineSlotAvailable('u1', 'm2')).toBe(false);
    expect(await machineSlotAvailable('u1', 'm1')).toBe(true);
  });

  it("counts distinct machines across every one of the payer's sites, and only theirs", async () => {
    mockGetEntitlements.mockResolvedValue(PRO);
    mockSites.s1 = { data: { owner: 'u1' }, machines: ['m1', 'm2'] };
    mockSites.s2 = { data: { owner: 'u1' }, machines: ['m2'] };
    mockSites.other = { data: { owner: 'u2' }, machines: ['x1', 'x2', 'x3'] };
    expect(await machineSlotAvailable('u1', 'm3')).toBe(true);

    mockSites.s2.machines.push('m3');
    expect(await machineSlotAvailable('u1', 'm4')).toBe(false);
    expect(await machineSlotAvailable('u1', 'm3')).toBe(true);
  });

  it('skips the count when machines are unlimited', async () => {
    mockGetEntitlements.mockResolvedValue(TRIAL);
    expect(await machineSlotAvailable('u1', 'm9')).toBe(true);
    expect(mockCollection).not.toHaveBeenCalledWith('sites');
  });

  it('fits a payer it cannot resolve', async () => {
    mockGetEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });
    mockSites.s1 = { data: { owner: 'u1' }, machines: ['m1'] };
    expect(await machineSlotAvailable('u1', 'm2')).toBe(true);
    expect(await machineSlotAvailable(null, 'm2')).toBe(true);
  });
});

describe('siteSlotAvailable', () => {
  it('fits before any read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    mockSites.s1 = { data: { owner: 'u1' }, machines: [] };
    expect(await siteSlotAvailable('u1')).toBe(true);
    expectNoReads();
  });

  it("gives free its first site, counting only the payer's", async () => {
    mockSites.other = { data: { owner: 'u2' }, machines: [] };
    expect(await siteSlotAvailable('u1')).toBe(true);
  });

  it('refuses free a second site', async () => {
    mockSites.s1 = { data: { owner: 'u1' }, machines: [] };
    expect(await siteSlotAvailable('u1')).toBe(false);
  });

  it('skips the count when sites are unlimited, and for a superadmin', async () => {
    mockSites.s1 = { data: { owner: 'u1' }, machines: [] };
    mockSites.s2 = { data: { owner: 'root' }, machines: [] };
    expect(await siteSlotAvailable('root')).toBe(true);

    mockGetEntitlements.mockResolvedValue(TRIAL);
    expect(await siteSlotAvailable('u1')).toBe(true);
    expect(mockCollection).not.toHaveBeenCalledWith('sites');
  });
});
