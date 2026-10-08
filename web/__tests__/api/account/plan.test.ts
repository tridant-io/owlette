/** @jest-environment node */

/**
 * GET /api/account/plan — the signed-in user's own plan. pins the session-only
 * auth (agents refused), the unenforced answer that reads no usage, the derived
 * tier, the wire limits (null for unrestricted), the keys_missing reason, and
 * the calendar-month usage window.
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
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection ${name}`);
      return { doc: (uid: string) => ({ get: async () => ({ data: () => mockUsers[uid] }) }) };
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

const UNRESTRICTED = {
  limits: { machines: null, sites: null },
  flags: { control: true, roost: true, talons: true, webhooks: true, api_keys: true },
};

async function getPlan() {
  return parseResponse(await GET(createMockRequest('/api/account/plan')));
}

beforeEach(() => {
  __resetForTests();
  jest.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
  mockUsers = { u1: { role: 'user' }, root: { role: 'superadmin' } };
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
    expect(mockActiveMachinesBetween).not.toHaveBeenCalled();
  });

  it('answers an unmapped payer as free, with this month of usage', async () => {
    mockActiveMachinesBetween.mockResolvedValue(2);

    const res = await getPlan();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enforced: true,
      plan: 'free',
      standing: 'expired',
      limits: { machines: 1, sites: 1 },
      flags: { control: false, roost: false, talons: false, webhooks: false, api_keys: false },
      activeMachinesThisMonth: 2,
    });
    expect(mockActiveMachinesBetween).toHaveBeenCalledWith(
      'u1',
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-07T12:00:00Z'),
    );
  });

  it('answers a trial with unrestricted limits as null', async () => {
    mockGetEntitlements.mockResolvedValue(answer(true, 'trialing', ALL_KEYS('unlimited', 'unlimited', '1')));

    const res = await getPlan();

    expect(res.body).toMatchObject({ enforced: true, plan: 'trial', standing: 'trialing', ...UNRESTRICTED });
    expect(res.body).not.toHaveProperty('reason');
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
      missingKeys: ['owlette.roost', 'owlette.talons', 'owlette.webhooks', 'owlette.api_keys'],
      plan: 'pro',
      limits: { machines: 5, sites: 1 },
      flags: { control: true, roost: true, talons: true, webhooks: true, api_keys: true },
    });
  });

  it('answers 500 when the usage read fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockActiveMachinesBetween.mockRejectedValue(new Error('firestore down'));

    const res = await getPlan();

    expect(res.status).toBe(500);
  });
});
