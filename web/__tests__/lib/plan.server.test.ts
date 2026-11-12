/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
}));

type FakeSite = { data: Record<string, unknown>; machines: string[] };
let mockUsers: Record<string, Record<string, unknown>> = {};
let mockSites: Record<string, FakeSite> = {};
/** tridant's answer per site; a site not listed answers free. */
let mockAnswers: Record<string, unknown> = {};

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

const mockSiteGet = jest.fn(async (siteId: string) => ({ data: () => mockSites[siteId]?.data }));
const mockOwnedSites = jest.fn(async (owner: unknown) => ({
  docs: Object.keys(mockSites)
    .filter((id) => mockSites[id].data.owner === owner)
    .map((id) => ({ id, ref: mockSiteRef(id) })),
}));
const mockCollection = jest.fn((name: string) => {
  if (name === 'users') {
    return { doc: (uid: string) => ({ get: async () => ({ data: () => mockUsers[uid] }) }) };
  }
  if (name === 'sites') {
    return {
      doc: (siteId: string) => ({ get: () => mockSiteGet(siteId) }),
      where: (field: string, op: string, value: unknown) => {
        if (field !== 'owner' || op !== '==') throw new Error(`unexpected query ${field} ${op}`);
        return { select: () => ({ get: () => mockOwnedSites(value) }) };
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
  PLAN_REQUIRED_DETAIL,
  entitled,
  machineSlotAvailable,
  missingPlanKeys,
  planLimit,
  planTier,
  requireEntitlement,
  resolveSitePlan,
  siteSlotAvailable,
  tridantConfigured,
  type Plan,
} from '@/lib/plan.server';
import {
  CORE_ENTITLEMENTS as CORE,
  FREE_ENTITLEMENTS as FREE,
  PRO_ENTITLEMENTS as PRO,
  TRIAL_ENTITLEMENTS as TRIAL,
} from '../api/helpers/planEnforcement';

// a site tridant knows whose licences all ended: the defaults again, under its organization.
const LAPSED = { ...FREE, resolved: true, orgId: 'org_1' };
const PAST_DUE = { ...PRO, standing: 'past_due', graceUntil: Date.UTC(2026, 10, 20) };
// past the grace window tridant stops entitling: not in good standing, and the defaults.
const GRACE_OVER = { ...LAPSED, standing: 'past_due' };
const UNREACHABLE = { ok: false, reason: 'unreachable' };

const FLAGS = [
  'owlette.control',
  'owlette.deployments',
  'owlette.swoop',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
] as const;

const enforced = (ent: Record<string, string>, standing = 'active', inGoodStanding = true): Plan => ({
  enforced: true,
  resolved: true,
  standing,
  inGoodStanding,
  ent,
  billing: null,
  orgId: null,
});

const site = (owner: string, machines: string[] = []): FakeSite => ({ data: { owner }, machines });

beforeEach(() => {
  __resetForTests();
  mockUsers = { u1: { role: 'user' }, root: { role: 'superadmin' } };
  mockSites = {};
  mockAnswers = {};
  mockGetSiteEntitlements.mockImplementation(async (siteId: string) => mockAnswers[siteId] ?? FREE);
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
  expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
}

describe('tridantConfigured', () => {
  it('is true with the url and key set, whatever PLAN_ENFORCEMENT says', () => {
    delete process.env.PLAN_ENFORCEMENT;
    expect(tridantConfigured()).toBe(true);
  });

  it('is false with the url or the key blank, and true under the e2e seam without either', () => {
    process.env.TRIDANT_LICENSE_KEY = '  ';
    expect(tridantConfigured()).toBe(false);
    process.env.TRIDANT_LICENSE_KEY = 'tid_license_read_key';
    delete process.env.TRIDANT_API_URL;
    expect(tridantConfigured()).toBe(false);

    delete process.env.TRIDANT_LICENSE_KEY;
    process.env.OWLETTE_E2E = '1';
    expect(tridantConfigured()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('resolveSitePlan', () => {
  beforeEach(() => {
    mockSites.s1 = site('u1');
  });

  it.each([undefined, 'off', 'true', 'ON'])('is off before any read when PLAN_ENFORCEMENT is %s', async (value) => {
    if (value === undefined) delete process.env.PLAN_ENFORCEMENT;
    else process.env.PLAN_ENFORCEMENT = value;

    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason: 'enforcement_off' });
    expectNoReads();
  });

  it('is not_configured before any read when the tridant url or key is missing, and warns once', async () => {
    delete process.env.TRIDANT_API_URL;
    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason: 'not_configured' });

    process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
    process.env.TRIDANT_LICENSE_KEY = '  ';
    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason: 'not_configured' });

    expectNoReads();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('counts the e2e seam as configured', async () => {
    delete process.env.TRIDANT_API_URL;
    delete process.env.TRIDANT_LICENSE_KEY;
    process.env.OWLETTE_E2E = '1';

    expect(await resolveSitePlan('s1')).toMatchObject({ enforced: true, resolved: false });
  });

  it('asks tridant about the site, never about its owner', async () => {
    await resolveSitePlan('s1');

    expect(mockGetSiteEntitlements).toHaveBeenCalledWith('s1');
    });

  it('reports no_payer for a missing site, a missing owner or a blank one, without asking tridant', async () => {
    mockSites.s2 = { data: {}, machines: [] };
    mockSites.s3 = { data: { owner: '' }, machines: [] };

    for (const siteId of ['nope', 's2', 's3']) {
      expect(await resolveSitePlan(siteId)).toEqual({ enforced: false, reason: 'no_payer' });
    }
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  it('uses site data already read instead of reading the site', async () => {
    expect(await resolveSitePlan('other', { owner: 'u1' })).toMatchObject({ enforced: true });
    // a missing site is null, not undefined, so it still skips the read.
    expect(await resolveSitePlan('gone', null)).toEqual({ enforced: false, reason: 'no_payer' });
    expect(mockSiteGet).not.toHaveBeenCalled();
  });

  it.each(['unreachable', 'malformed_response', 'not_configured'])('fails open on %s', async (reason) => {
    mockAnswers.s1 = { ok: false, reason };
    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails open on a rejected key, and logs an error once', async () => {
    mockAnswers.s1 = { ok: false, reason: 'rejected' };

    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason: 'rejected' });
    await resolveSitePlan('s1');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('leaves a site owned by a superadmin unrestricted, whatever tridant says', async () => {
    mockSites.s1 = site('root');
    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason: 'superadmin' });

    mockAnswers.s1 = UNREACHABLE;
    expect(await resolveSitePlan('s1')).toEqual({ enforced: false, reason: 'superadmin' });
  });

  it('reads an owner with no user doc as not a superadmin', async () => {
    mockSites.s1 = site('ghost');
    expect(await resolveSitePlan('s1')).toMatchObject({ enforced: true });
  });

  it('enforces a site tridant does not know as its defaults, which is free', async () => {
    const plan = await resolveSitePlan('s1');

    expect(plan).toEqual({
      enforced: true,
      resolved: false,
      standing: 'expired',
      inGoodStanding: false,
      ent: FREE.ent,
      billing: null,
      orgId: null,
    });
    expect(planTier(plan)).toBe('free');
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(false);
  });

  it('reads a known site with no active licence as free', async () => {
    mockAnswers.s1 = LAPSED;
    const plan = await resolveSitePlan('s1');

    expect(plan).toMatchObject({ enforced: true, resolved: true, inGoodStanding: false, orgId: 'org_1' });
    expect(planTier(plan)).toBe('free');
    expect(entitled(plan, 'owlette.control')).toBe(false);
  });

  it('reads a site under a trial as in good standing, with every flag and no billing period', async () => {
    mockAnswers.s1 = TRIAL;
    const plan = await resolveSitePlan('s1');

    expect(plan).toMatchObject({ enforced: true, standing: 'trialing', inGoodStanding: true, billing: null });
    expect(planTier(plan)).toBe('trial');
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(true);
  });

  it('reads a core site: in good standing, control only, with its billing period', async () => {
    mockAnswers.s1 = CORE;
    const plan = await resolveSitePlan('s1');

    expect(plan).toMatchObject({ enforced: true, inGoodStanding: true, billing: CORE.billing });
    expect(planTier(plan)).toBe('core');
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(flag === 'owlette.control');
  });

  it('reads a pro site: in good standing, every flag, with its billing period and organization', async () => {
    mockAnswers.s1 = PRO;
    const plan = await resolveSitePlan('s1');

    expect(plan).toMatchObject({ enforced: true, standing: 'active', inGoodStanding: true, billing: PRO.billing, orgId: 'org_1' });
    expect(planTier(plan)).toBe('pro');
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(true);
  });

  it('keeps a past_due site in good standing inside its grace, and reads it as free after', async () => {
    mockAnswers.s1 = PAST_DUE;
    const inGrace = await resolveSitePlan('s1');
    expect(inGrace).toMatchObject({ standing: 'past_due', inGoodStanding: true });
    expect(planTier(inGrace)).toBe('pro');
    expect(entitled(inGrace, 'owlette.roost')).toBe(true);

    mockAnswers.s1 = GRACE_OVER;
    const after = await resolveSitePlan('s1');
    expect(after).toMatchObject({ standing: 'past_due', inGoodStanding: false });
    expect(planTier(after)).toBe('free');
    expect(entitled(after, 'owlette.roost')).toBe(false);
  });
});

describe('planLimit and entitled', () => {
  it('leave an unenforced plan unrestricted', () => {
    const plan: Plan = { enforced: false, reason: 'unreachable' };
    expect(planLimit(plan, 'owlette.machines')).toBe(Infinity);
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(true);
  });

  it('read free: no flags, one machine, one site', () => {
    const plan = enforced(FREE.ent, 'expired', false);
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(false);
    expect(planLimit(plan, 'owlette.machines')).toBe(1);
    expect(planLimit(plan, 'owlette.sites')).toBe(1);
  });

  it('read core: control and unlimited machines, none of pro', () => {
    const plan = enforced(CORE.ent);
    for (const flag of FLAGS) expect(entitled(plan, flag)).toBe(flag === 'owlette.control');
    expect(planLimit(plan, 'owlette.machines')).toBe(Infinity);
  });

  it('read trial and pro: every flag, unlimited or counted limits', () => {
    for (const ent of [TRIAL.ent, PRO.ent]) {
      for (const flag of FLAGS) expect(entitled(enforced(ent), flag)).toBe(true);
    }
    expect(planLimit(enforced(PRO.ent), 'owlette.machines')).toBe(Infinity);
    expect(planLimit(enforced({ ...PRO.ent, 'owlette.machines': '3' }), 'owlette.machines')).toBe(3);
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
      'owlette.deployments',
      'owlette.swoop',
      'owlette.hoot',
      'owlette.roost',
      'owlette.talons',
      'owlette.webhooks',
      'owlette.api_keys',
    ]);
  });
});

describe('planTier', () => {
  it('is null while plans are not enforced', () => {
    expect(planTier({ enforced: false, reason: 'superadmin' })).toBeNull();
  });

  it.each(['expired', 'canceled', 'past_due'])('reads a %s site not in good standing as free, even with pro keys', (standing) => {
    expect(planTier(enforced(PRO.ent, standing, false))).toBe('free');
  });

  it('reads trialing as trial', () => {
    expect(planTier(enforced(TRIAL.ent, 'trialing'))).toBe('trial');
  });

  it.each(['active', 'past_due'])('reads a %s site in good standing from its flags', (standing) => {
    expect(planTier(enforced(PRO.ent, standing))).toBe('pro');
    expect(planTier(enforced(CORE.ent, standing))).toBe('core');
    expect(planTier(enforced(FREE.ent, standing))).toBe('free');
  });

  it('reads deployments or roost alone as pro', () => {
    expect(planTier(enforced({ ...CORE.ent, 'owlette.deployments': '1' }))).toBe('pro');
    expect(planTier(enforced({ ...CORE.ent, 'owlette.roost': '1' }))).toBe('pro');
  });

  it('reads a site in good standing whose keys are missing as pro, since missing is unrestricted', () => {
    expect(planTier(enforced({}))).toBe('pro');
  });
});

describe('requireEntitlement', () => {
  beforeEach(() => {
    mockSites.s1 = site('u1');
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

  it('refuses a free site with 402 plan_required', async () => {
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
    expect(mockGetSiteEntitlements).toHaveBeenCalledWith('s1');
  });

  it("decides by the site's plan, not by the owner's other sites", async () => {
    mockSites.s2 = site('u1');
    mockAnswers.s2 = PRO;

    expect((await requireEntitlement('s1', 'owlette.roost'))?.status).toBe(402);
    expect(await requireEntitlement('s2', 'owlette.roost')).toBeNull();
  });

  it.each([['trial', TRIAL], ['pro', PRO]])('lets a %s site through', async (_label, answer) => {
    mockAnswers.s1 = answer;
    for (const flag of FLAGS) expect(await requireEntitlement('s1', flag)).toBeNull();
  });

  it('lets a core site through on control only, refusing deployments, swoop and hoot by name', async () => {
    mockAnswers.s1 = CORE;
    expect(await requireEntitlement('s1', 'owlette.control')).toBeNull();
    for (const flag of ['owlette.deployments', 'owlette.swoop', 'owlette.hoot'] as const) {
      const res = await requireEntitlement('s1', flag);
      expect(res?.status).toBe(402);
      expect(await res?.json()).toMatchObject({ entitlement: flag, detail: PLAN_REQUIRED_DETAIL[flag] });
    }
  });

  it('lets an ownerless site through, and one tridant cannot answer for', async () => {
    mockSites.s1.data = {};
    expect(await requireEntitlement('s1', 'owlette.control')).toBeNull();
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();

    mockSites.s1.data = { owner: 'u1' };
    mockAnswers.s1 = UNREACHABLE;
    expect(await requireEntitlement('s1', 'owlette.control')).toBeNull();
  });

  it('uses site data already read', async () => {
    const res = await requireEntitlement('other', 'owlette.control', { owner: 'u1' });
    expect(res?.status).toBe(402);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });
});

describe('machineSlotAvailable', () => {
  it('fits before any read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    mockSites.s1 = site('u1', ['m1']);
    expect(await machineSlotAvailable('s1', 'm2')).toBe(true);
    expectNoReads();
  });

  it.each([['trialing', TRIAL], ['core', CORE], ['pro', PRO], ['past_due', PAST_DUE]])(
    'fits any machine on a %s site, without counting',
    async (_label, answer) => {
      mockSites.s1 = site('u1', ['m1', 'm2', 'm3']);
      mockAnswers.s1 = answer;

      expect(await machineSlotAvailable('s1', 'm4')).toBe(true);
      expect(mockOwnedSites).not.toHaveBeenCalled();
    },
  );

  it('fits a site whose plan cannot be read, an ownerless one, and a superadmin owner', async () => {
    mockSites.s1 = site('u1', ['m1']);
    mockSites.orphan = { data: {}, machines: ['m1'] };
    mockSites.staff = site('root', ['m1']);
    mockAnswers.s1 = UNREACHABLE;

    expect(await machineSlotAvailable('s1', 'm2')).toBe(true);
    expect(await machineSlotAvailable('orphan', 'm2')).toBe(true);
    expect(await machineSlotAvailable('staff', 'm2')).toBe(true);
    expect(mockOwnedSites).not.toHaveBeenCalled();
  });

  it('gives a free account its first machine', async () => {
    mockSites.s1 = site('u1');
    expect(await machineSlotAvailable('s1', 'm1')).toBe(true);
  });

  it('refuses a free account a second machine, but lets the first re-pair', async () => {
    mockSites.s1 = site('u1', ['m1']);
    expect(await machineSlotAvailable('s1', 'm2')).toBe(false);
    expect(await machineSlotAvailable('s1', 'm1')).toBe(true);
  });

  it("counts the machines on the owner's free sites only, among billed, trialing and other owners' sites", async () => {
    mockSites = {
      free1: site('u1'),
      free2: site('u1'),
      pro: site('u1', ['p1', 'p2', 'p3']),
      trial: site('u1', ['t1']),
      theirs: site('u2', ['x1', 'x2']),
    };
    mockAnswers = { pro: PRO, trial: TRIAL };
    expect(await machineSlotAvailable('free1', 'm1')).toBe(true);

    mockSites.free2.machines.push('m1');
    expect(await machineSlotAvailable('free1', 'm2')).toBe(false);
    expect(await machineSlotAvailable('free2', 'm2')).toBe(false);
  });

  it('fits a machine already on any site the owner has, as a re-pair', async () => {
    mockSites = { free1: site('u1'), free2: site('u1', ['m1']), pro: site('u1', ['p1']), theirs: site('u2', ['x1']) };
    mockAnswers = { pro: PRO };

    expect(await machineSlotAvailable('free1', 'm1')).toBe(true);
    expect(await machineSlotAvailable('free1', 'p1')).toBe(true);
    expect(await machineSlotAvailable('free1', 'x1')).toBe(false);
  });

  it('counts a machine id on two free sites once', async () => {
    mockSites = { free1: site('u1', ['m1']), free2: site('u1', ['m1']) };
    mockAnswers = { free1: { ...FREE, ent: { ...FREE.ent, 'owlette.machines': '2' } } };

    expect(await machineSlotAvailable('free1', 'm2')).toBe(true);
  });

  it('leaves an owned site whose plan cannot be read out of the count', async () => {
    mockSites = { s1: site('u1'), s2: site('u1', ['m1', 'm2']) };
    mockAnswers = { s2: UNREACHABLE };

    expect(await machineSlotAvailable('s1', 'm9')).toBe(true);
  });

  it("takes the free limit from the site's answer, and one when tridant sends none", async () => {
    mockSites.s1 = site('u1', ['m1']);
    mockAnswers.s1 = { ...FREE, ent: { ...FREE.ent, 'owlette.machines': '2' } };
    expect(await machineSlotAvailable('s1', 'm2')).toBe(true);
    mockSites.s1.machines.push('m2');
    expect(await machineSlotAvailable('s1', 'm3')).toBe(false);

    mockSites.s1.machines = ['m1'];
    mockAnswers.s1 = { ...FREE, ent: {} };
    expect(await machineSlotAvailable('s1', 'm2')).toBe(false);
  });

  it('uses site data already read instead of reading the site', async () => {
    mockSites.s1 = site('u1', ['m1']);
    expect(await machineSlotAvailable('s1', 'm2', { owner: 'u1' })).toBe(false);
    expect(mockSiteGet).not.toHaveBeenCalled();
  });
});

describe('siteSlotAvailable', () => {
  it('fits before any read when enforcement is off', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    mockSites.s1 = site('u1');
    expect(await siteSlotAvailable('u1')).toBe(true);
    expectNoReads();
  });

  it('gives an account its first site, counting only its own', async () => {
    mockSites.theirs = site('u2');
    expect(await siteSlotAvailable('u1')).toBe(true);
  });

  it('refuses a second free site', async () => {
    mockSites.s1 = site('u1');
    expect(await siteSlotAvailable('u1')).toBe(false);
  });

  it('never counts billed or trialing sites', async () => {
    mockSites = { core: site('u1'), pro: site('u1'), trial: site('u1'), due: site('u1') };
    mockAnswers = { core: CORE, pro: PRO, trial: TRIAL, due: PAST_DUE };
    expect(await siteSlotAvailable('u1')).toBe(true);

    mockSites.free = site('u1');
    expect(await siteSlotAvailable('u1')).toBe(false);
  });

  it('leaves a site whose plan cannot be read out of the count', async () => {
    mockSites.s1 = site('u1');
    mockAnswers.s1 = UNREACHABLE;
    expect(await siteSlotAvailable('u1')).toBe(true);
  });

  it('counts a lapsed site as free', async () => {
    mockSites.s1 = site('u1');
    mockAnswers.s1 = LAPSED;
    expect(await siteSlotAvailable('u1')).toBe(false);
  });

  it('takes the free limit from a free answer, and one when tridant sends none', async () => {
    mockSites.s1 = site('u1');
    mockAnswers.s1 = { ...FREE, ent: { ...FREE.ent, 'owlette.sites': '2' } };
    expect(await siteSlotAvailable('u1')).toBe(true);

    mockAnswers.s1 = { ...FREE, ent: {} };
    expect(await siteSlotAvailable('u1')).toBe(false);
  });

  it('fits a superadmin without counting', async () => {
    mockSites.s1 = site('root');
    expect(await siteSlotAvailable('root')).toBe(true);
    expect(mockOwnedSites).not.toHaveBeenCalled();
  });
});
