/**
 * @jest-environment node
 *
 * plan.md decision 8 in the `_shared` resolvers: creating roosts and webhooks
 * needs the payer's flag, an api-key request needs the site payer's
 * `owlette.api_keys`, minting a key needs the minter's own, and agent tokens are
 * never plan-gated. the real plan resolver runs; only tridant and firestore are faked.
 */
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

let mockUsers: Record<string, Record<string, unknown>> = {};
const mockCollection = jest.fn((name: string) => {
  if (name !== 'users') throw new Error(`unexpected collection ${name}`);
  return { doc: (uid: string) => ({ get: async () => ({ data: () => mockUsers[uid] }) }) };
});
const mockVerifyIdToken = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockCollection }),
  getAdminAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));

const mockEmitApiKeyUsed = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: (...a: unknown[]) => mockEmitApiKeyUsed(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
}));

const mockResolveSiteAccess = jest.fn();
jest.mock('@/lib/sitePolicy.server', () => ({
  ...jest.requireActual('@/lib/sitePolicy.server'),
  resolveSiteAccess: (...a: unknown[]) => mockResolveSiteAccess(...a),
}));

import {
  requireAgentOrSiteAuthAndScope,
  requireApiKeyMintPlan,
  requireChatAuthAndScope,
  requireDistributionManageCapability,
  requireMachineAuthAndScope,
  requireRoostAuthAndScope,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
} from '@/app/api/_shared';
import { CURRENT_ROOST_VERSION } from '@/app/api/version/route';
import type { ApiKeyPermission } from '@/lib/apiKeyTypes';
import { ROOST_VERSION_HEADER } from '@/lib/versionHeader';
import {
  enforcePlans,
  FREE_ENTITLEMENTS as FREE,
  PRO_ENTITLEMENTS as PRO,
  stopEnforcingPlans,
} from './helpers/planEnforcement';

const SITE = 'site-alpha';
const ROOST = 'rst_roostidexa';
const MACHINE = 'machine-1';
const CALLER = 'user-1';
const PAYER = 'owner-1';
const SITE_DATA = { owner: PAYER };

const ALL_PERMISSIONS: ApiKeyPermission[] = ['read', 'write', 'deploy', 'rollback', 'admin'];
const SESSION = { userId: CALLER, keyContext: null };
const API_KEY = {
  userId: CALLER,
  keyContext: {
    keyId: 'key-1',
    scopes: (['site', 'machine', 'roost', 'chat'] as const).map((resource) => ({
      resource,
      id: '*',
      permissions: ALL_PERMISSIONS,
    })),
    environment: 'live',
    expiresAt: null,
    isLegacy: false,
  },
};

function request(method = 'POST', bearer?: string): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method,
    headers: {
      [ROOST_VERSION_HEADER]: CURRENT_ROOST_VERSION,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });
}

const refusalOf = (result: { ok: true } | { ok: false; response: Response }) =>
  result.ok ? null : result.response;

async function expectPlanRequired(response: Response | null, entitlement: string) {
  expect(response?.status).toBe(402);
  expect(await response?.json()).toMatchObject({ code: 'plan_required', entitlement });
}

function expectNoPlanLookup() {
  expect(mockGetEntitlements).not.toHaveBeenCalled();
  expect(mockCollection).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  enforcePlans();
  mockUsers = {};
  mockGetEntitlements.mockResolvedValue(FREE);
  mockResolveAuth.mockResolvedValue(SESSION);
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: SITE_DATA });
  mockResolveSiteAccess.mockResolvedValue({
    ok: true,
    facts: { siteData: SITE_DATA, globalRole: 'member', membershipRole: 'owner' },
  });
  mockVerifyIdToken.mockRejectedValue(new Error('not an id token'));
});

afterAll(stopEnforcingPlans);

describe('api-key requests need the site payer’s owlette.api_keys', () => {
  const resolvers = {
    site: () => requireSiteAuthAndScope(request(), SITE, 'write'),
    machine: () => requireMachineAuthAndScope(request(), SITE, MACHINE, 'write'),
    chat: () => requireChatAuthAndScope(request(), SITE, 'write'),
    roost: () => requireRoostAuthAndScope(request('GET'), SITE, ROOST, 'read'),
    'agent-or-site (operator)': () => requireAgentOrSiteAuthAndScope(request(), SITE, 'read'),
  };

  it.each(Object.entries(resolvers))('%s: refuses a key on free, asking the payer, not the key holder', async (_, run) => {
    mockResolveAuth.mockResolvedValue(API_KEY);

    await expectPlanRequired(refusalOf(await run()), 'owlette.api_keys');
    expect(mockGetEntitlements).toHaveBeenCalledWith(PAYER);
    expect(mockEmitApiKeyUsed).not.toHaveBeenCalled();
  });

  it.each(Object.entries(resolvers))('%s: lets a key through on pro', async (_, run) => {
    mockResolveAuth.mockResolvedValue(API_KEY);
    mockGetEntitlements.mockResolvedValue(PRO);

    expect((await run()).ok).toBe(true);
  });

  it.each(Object.entries(resolvers))('%s: leaves a session alone on free', async (_, run) => {
    expect((await run()).ok).toBe(true);
    expectNoPlanLookup();
  });

  it.each(Object.entries(resolvers))('%s: lets a key through with enforcement off, before any read', async (_, run) => {
    delete process.env.PLAN_ENFORCEMENT;
    mockResolveAuth.mockResolvedValue(API_KEY);

    expect((await run()).ok).toBe(true);
    expectNoPlanLookup();
  });
});

describe('agent tokens are never plan-gated', () => {
  beforeEach(() => {
    mockVerifyIdToken.mockResolvedValue({
      uid: 'agent-uid',
      role: 'agent',
      site_id: SITE,
      machine_id: MACHINE,
    });
  });

  it('screenshot upload-url/finalize: requireMachineAuthAndScope passes an agent on free', async () => {
    const result = await requireMachineAuthAndScope(request('POST', 'agent-id-token'), SITE, MACHINE, 'write');

    expect(result.ok).toBe(true);
    expectNoPlanLookup();
  });

  it('roost pulls: requireAgentOrSiteAuthAndScope passes an agent on free', async () => {
    const result = await requireAgentOrSiteAuthAndScope(request('POST', 'agent-id-token'), SITE, 'read');

    expect(result).toMatchObject({ ok: true, isAgent: true });
    expectNoPlanLookup();
  });
});

describe('roost writes need owlette.roost', () => {
  it.each([
    ['POST', 'write'],
    ['PATCH', 'write'],
    ['POST', 'deploy'],
    ['POST', 'rollback'],
  ] as const)('refuses %s with %s on free', async (method, permission) => {
    await expectPlanRequired(
      refusalOf(await requireRoostAuthAndScope(request(method), SITE, ROOST, permission)),
      'owlette.roost',
    );
  });

  it('keeps reads open on free', async () => {
    expect((await requireRoostAuthAndScope(request('GET'), SITE, ROOST, 'read')).ok).toBe(true);
    expectNoPlanLookup();
  });

  it('keeps delete open on free', async () => {
    expect((await requireRoostAuthAndScope(request('DELETE'), SITE, ROOST, 'write')).ok).toBe(true);
    expectNoPlanLookup();
  });

  it('allows a deploy on pro', async () => {
    mockGetEntitlements.mockResolvedValue(PRO);
    expect((await requireRoostAuthAndScope(request(), SITE, ROOST, 'deploy')).ok).toBe(true);
  });

  it('allows a deploy on free with enforcement off, before any read', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    expect((await requireRoostAuthAndScope(request(), SITE, ROOST, 'deploy')).ok).toBe(true);
    expectNoPlanLookup();
  });

  it('answers the capability before the plan', async () => {
    mockResolveSiteAccess.mockResolvedValue({
      ok: true,
      facts: { siteData: SITE_DATA, globalRole: 'member', membershipRole: 'member' },
    });

    const result = await requireRoostAuthAndScope(request(), SITE, ROOST, 'deploy');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
    expectNoPlanLookup();
  });

  describe('requireDistributionManageCapability (roost create, chunk upload and mount)', () => {
    it('refuses on free', async () => {
      await expectPlanRequired(await requireDistributionManageCapability(SESSION, SITE), 'owlette.roost');
      expect(mockGetEntitlements).toHaveBeenCalledWith(PAYER);
    });

    it('allows on pro', async () => {
      mockGetEntitlements.mockResolvedValue(PRO);
      expect(await requireDistributionManageCapability(SESSION, SITE)).toBeNull();
    });

    it('allows with enforcement off, before any read', async () => {
      delete process.env.PLAN_ENFORCEMENT;
      expect(await requireDistributionManageCapability(SESSION, SITE)).toBeNull();
      expectNoPlanLookup();
    });
  });
});

describe('webhook create needs owlette.webhooks', () => {
  it('refuses a create on free', async () => {
    await expectPlanRequired(
      await requireWebhookManageCapability(SESSION, SITE, { create: true }),
      'owlette.webhooks',
    );
  });

  it('keeps update, rotate, test and delete open on free', async () => {
    expect(await requireWebhookManageCapability(SESSION, SITE)).toBeNull();
    expectNoPlanLookup();
  });

  it('allows a create on pro', async () => {
    mockGetEntitlements.mockResolvedValue(PRO);
    expect(await requireWebhookManageCapability(SESSION, SITE, { create: true })).toBeNull();
  });

  it('allows a create with enforcement off, before any read', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    expect(await requireWebhookManageCapability(SESSION, SITE, { create: true })).toBeNull();
    expectNoPlanLookup();
  });
});

describe('requireApiKeyMintPlan', () => {
  it('refuses on the minting user’s own free plan', async () => {
    await expectPlanRequired(await requireApiKeyMintPlan(CALLER), 'owlette.api_keys');
    expect(mockGetEntitlements).toHaveBeenCalledWith(CALLER);
  });

  it('allows on pro', async () => {
    mockGetEntitlements.mockResolvedValue(PRO);
    expect(await requireApiKeyMintPlan(CALLER)).toBeNull();
  });

  it('allows a superadmin on free', async () => {
    mockUsers = { [CALLER]: { role: 'superadmin' } };
    expect(await requireApiKeyMintPlan(CALLER)).toBeNull();
  });

  it('allows with enforcement off, before any read', async () => {
    delete process.env.PLAN_ENFORCEMENT;
    expect(await requireApiKeyMintPlan(CALLER)).toBeNull();
    expectNoPlanLookup();
  });
});
