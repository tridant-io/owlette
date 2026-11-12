/** @jest-environment node */

/**
 * GET /api/sites/{siteId}/plan — one site's plan for the dashboard's gates. the
 * real site gate runs, so who is admitted is its own answer; tridant id's site
 * answer is mocked per test.
 */

import {
  CORE_ENTITLEMENTS,
  enforcePlans,
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  stopEnforcingPlans,
  TRIAL_ENTITLEMENTS,
} from './helpers/planEnforcement';
import { createMockRequest, parseResponse } from './helpers/utils';
import { apiKeyAuth, mockDbFactory, mocks, seedMember, seedSiteOwner, SITE_OWNER } from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/logger', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: logger, logger };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/resendClient.server', () => ({ trustedBaseUrl: () => 'https://dev.owlette.app' }));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

const mockGetSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: (siteId: string) => mockGetSiteEntitlements(siteId),
  invalidateSiteEntitlements: jest.fn(),
}));

import { GET } from '@/app/api/sites/[siteId]/plan/route';

const SITE = 'site-a';
const MEMBER = 'user-member';
const SCOPED = 'user-scoped';
const STRANGER = 'user-stranger';
const ENDS_AT = Date.UTC(2026, 11, 1);
const ALL_FLAGS = ['control', 'deployments', 'swoop', 'hoot', 'roost', 'talons', 'webhooks', 'api_keys'];

const flags = (on: string[]) => Object.fromEntries(ALL_FLAGS.map((flag) => [flag, on.includes(flag)]));

function get(siteId: string = SITE) {
  return GET(createMockRequest(`http://localhost/api/sites/${siteId}/plan`), {
    params: Promise.resolve({ siteId }),
  });
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

function stageSite(extra: Record<string, unknown> = {}): void {
  mocks.siteDocs.set(SITE, { owner: SITE_OWNER, name: 'venue a', ...extra });
}

beforeEach(() => {
  jest.clearAllMocks();
  enforcePlans();

  seedSiteOwner(SITE);
  stageSite();
  seedMember(SITE, MEMBER, 'member');
  seedMember(SITE, SCOPED, 'member');
  mocks.memberDocs.set(`${SITE}/${SCOPED}`, { ...mocks.memberDocs.get(`${SITE}/${SCOPED}`), machineIds: ['machine-1'] });
  mocks.userDocs.set(STRANGER, { role: 'member', sites: [] });
  signIn(MEMBER);

  mockGetSiteEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);
});

afterAll(stopEnforcingPlans);

describe('who may read a site\'s plan', () => {
  it('answers a member, who is not the owner', async () => {
    const { status, body } = await parseResponse(await get());

    expect(status).toBe(200);
    expect(body.isOwner).toBe(false);
    expect(mockGetSiteEntitlements).toHaveBeenCalledWith(SITE);
  });

  it('tells the owner they are the owner', async () => {
    signIn(SITE_OWNER);

    const { status, body } = await parseResponse(await get());

    expect(status).toBe(200);
    expect(body.isOwner).toBe(true);
  });

  // the plan says nothing about machines, and a scoped member's gates follow it too
  it('answers a member held to a machine scope', async () => {
    signIn(SCOPED);

    const { status, body } = await parseResponse(await get());

    expect(status).toBe(200);
    expect(body.tier).toBe('pro');
  });

  it('answers 404 to someone who is not a member, and reads no plan', async () => {
    signIn(STRANGER);

    expect((await get()).status).toBe(404);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  it('refuses an api key scoped to another site', async () => {
    mockResolveAuth.mockResolvedValue({
      ...apiKeyAuth(MEMBER),
      keyContext: {
        ...apiKeyAuth(MEMBER).keyContext,
        scopes: [{ resource: 'site', id: 'site-other', permissions: ['read'] }],
      },
    });

    expect((await get()).status).toBe(403);
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });
});

describe('what the plan says', () => {
  it('describes a billed pro site with its billing and its period', async () => {
    stageSite({ billing: { tier: 'pro', founders: true, payerUid: SITE_OWNER, endsAt: null, updatedAt: 'then' } });

    const { body } = await parseResponse(await get());

    expect(body).toEqual({
      enforced: true,
      tier: 'pro',
      standing: 'active',
      inGoodStanding: true,
      flags: flags(ALL_FLAGS),
      billing: { tier: 'pro', founders: true, endsAt: null },
      period: { start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 11, 1) },
      isOwner: false,
      billedByPreviousOwner: false,
    });
  });

  it('keeps who pays out of the answer', async () => {
    stageSite({ billing: { tier: 'pro', founders: true, payerUid: SITE_OWNER, endsAt: null } });

    expect(JSON.stringify((await parseResponse(await get())).body)).not.toContain('payerUid');
  });

  // after a transfer the pointer still names the outgoing owner, until the billing it stopped has ended
  it.each([
    ['a stop that has not landed', null, true],
    ['billing that ends later', Date.now() + 86_400_000, true],
    ['billing that has ended', Date.now() - 1, false],
  ])('says whether the previous owner still pays, with %s', async (_case, endsAt, billedByPreviousOwner) => {
    stageSite({ billing: { tier: 'pro', founders: false, payerUid: 'user-previous-owner', endsAt } });
    signIn(SITE_OWNER);

    const { body } = await parseResponse(await get());

    expect(body.billedByPreviousOwner).toBe(billedByPreviousOwner);
    expect(body.isOwner).toBe(true);
  });

  it('does not say so while the owner is the one who pays', async () => {
    stageSite({ billing: { tier: 'pro', founders: false, payerUid: SITE_OWNER, endsAt: ENDS_AT } });

    expect((await parseResponse(await get())).body.billedByPreviousOwner).toBe(false);
  });

  it('shows when a stopped site\'s billing ends', async () => {
    stageSite({ billing: { tier: 'core', founders: false, payerUid: SITE_OWNER, endsAt: ENDS_AT } });
    mockGetSiteEntitlements.mockResolvedValue(CORE_ENTITLEMENTS);

    const { body } = await parseResponse(await get());

    expect(body.billing).toEqual({ tier: 'core', founders: false, endsAt: ENDS_AT });
    expect(body.tier).toBe('core');
    expect(body.flags).toEqual(flags(['control']));
  });

  it('describes a site under its owner\'s trial: pro flags, no billing, no period', async () => {
    mockGetSiteEntitlements.mockResolvedValue(TRIAL_ENTITLEMENTS);

    const { body } = await parseResponse(await get());

    expect(body).toMatchObject({
      enforced: true,
      tier: 'trial',
      standing: 'trialing',
      inGoodStanding: true,
      flags: flags(ALL_FLAGS),
      billing: null,
      period: null,
    });
  });

  it('describes a site tridant does not know as owlette free', async () => {
    mockGetSiteEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);

    const { body } = await parseResponse(await get());

    expect(body).toEqual({
      enforced: true,
      tier: 'free',
      standing: 'expired',
      inGoodStanding: false,
      flags: flags([]),
      billing: null,
      period: null,
      isOwner: false,
      billedByPreviousOwner: false,
    });
  });

  it('reads a pointer that is not a billing pointer as none', async () => {
    stageSite({ billing: { tier: 'enterprise', payerUid: SITE_OWNER } });

    expect((await parseResponse(await get())).body.billing).toBeNull();
  });

  it('answers unrestricted with the reason while plans are not enforced, and asks tridant nothing', async () => {
    stopEnforcingPlans();

    const { status, body } = await parseResponse(await get());

    expect(status).toBe(200);
    expect(body).toEqual({
      enforced: false,
      reason: 'enforcement_off',
      tier: null,
      standing: null,
      inGoodStanding: true,
      flags: flags(ALL_FLAGS),
      billing: null,
      period: null,
      isOwner: false,
      billedByPreviousOwner: false,
    });
    expect(mockGetSiteEntitlements).not.toHaveBeenCalled();
  });

  it('fails open with the reason when tridant cannot be reached', async () => {
    mockGetSiteEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });

    const { body } = await parseResponse(await get());

    expect(body).toMatchObject({ enforced: false, reason: 'unreachable', tier: null, flags: flags(ALL_FLAGS) });
  });
});
