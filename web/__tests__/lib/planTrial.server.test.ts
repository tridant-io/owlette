/** @jest-environment node */

/** planTrial.server: when the trial starts, what each tridant answer records, and site registration. */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetUser = jest.fn();
let mockSites: { id: string; data: Record<string, unknown> }[] = [];
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ getUser: mockGetUser }),
  getAdminDb: () => ({
    collection: () => ({
      where: () => ({ get: async () => ({ docs: mockSites.map((s) => ({ id: s.id, data: () => s.data })) }) }),
    }),
  }),
}));

const mockEnforced = jest.fn();
jest.mock('@/lib/plan.server', () => ({ plansEnforced: () => mockEnforced() }));

const mockGetAccount = jest.fn();
const mockClaim = jest.fn();
const mockRecordTrial = jest.fn();
const mockRecordSubscribed = jest.fn();
const mockMarkLink = jest.fn();
const mockRecordError = jest.fn();
jest.mock('@/lib/planAccounts.server', () => ({
  getPlanAccount: (...a: unknown[]) => mockGetAccount(...a),
  claimTrialStart: (...a: unknown[]) => mockClaim(...a),
  recordTrial: (...a: unknown[]) => mockRecordTrial(...a),
  recordSubscribed: (...a: unknown[]) => mockRecordSubscribed(...a),
  markLinkRequired: (...a: unknown[]) => mockMarkLink(...a),
  recordTrialError: (...a: unknown[]) => mockRecordError(...a),
}));

const mockStartTrial = jest.fn();
const mockPushSite = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  startTrial: (...a: unknown[]) => mockStartTrial(...a),
  pushSite: (...a: unknown[]) => mockPushSite(...a),
}));

const mockInvalidate = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  invalidateSiteEntitlements: (...a: unknown[]) => mockInvalidate(...a),
}));

import logger from '@/lib/logger';
import { ensureTrial, registerOwnedSites, registerSite } from '@/lib/planTrial.server';

const account = (over: Record<string, unknown> = {}) => ({
  trialStartedAt: null,
  trialEndsAt: null,
  orgId: null,
  linkRequired: false,
  trialError: null,
  claimedAt: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSites = [];
  mockEnforced.mockReturnValue(true);
  mockGetAccount.mockResolvedValue(null);
  mockClaim.mockResolvedValue(true);
  mockGetUser.mockResolvedValue({ emailVerified: true, email: 'ann@example.com', displayName: 'Ann' });
  mockStartTrial.mockResolvedValue({ ok: true, orgId: 'org_1', expiresAt: 5000, already: false });
  mockPushSite.mockResolvedValue({ ok: true, created: true, moved: false });
});

describe('ensureTrial', () => {
  it('does nothing while plans are not enforced', async () => {
    mockEnforced.mockReturnValue(false);
    expect(await ensureTrial('u1')).toEqual({ status: 'off' });
    expect(mockGetAccount).not.toHaveBeenCalled();
  });

  it('returns unverified without claiming', async () => {
    mockGetUser.mockResolvedValue({ emailVerified: false, email: 'ann@example.com' });
    expect(await ensureTrial('u1')).toEqual({ status: 'unverified' });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockStartTrial).not.toHaveBeenCalled();
  });

  it('returns early when the trial already started or a link is required', async () => {
    mockGetAccount.mockResolvedValueOnce(account({ trialStartedAt: 1 }));
    expect(await ensureTrial('u1')).toEqual({ status: 'already_started' });
    mockGetAccount.mockResolvedValueOnce(account({ linkRequired: true }));
    expect(await ensureTrial('u1')).toEqual({ status: 'link_required' });
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('starts the trial, records it and registers the owned sites', async () => {
    mockSites = [{ id: 's1', data: { name: 'lobby' } }];
    expect(await ensureTrial('u1')).toEqual({ status: 'started' });
    expect(mockStartTrial).toHaveBeenCalledWith({ uid: 'u1', email: 'ann@example.com', name: 'Ann' });
    expect(mockRecordTrial).toHaveBeenCalledWith('u1', { orgId: 'org_1', endsAtMs: 5000 });
    expect(mockPushSite).toHaveBeenCalledWith({ uid: 'u1', siteId: 's1', name: 'lobby' });
  });

  it('names the payer after the email local part without a display name', async () => {
    mockGetUser.mockResolvedValue({ emailVerified: true, email: 'ann@example.com' });
    await ensureTrial('u1');
    expect(mockStartTrial).toHaveBeenCalledWith(expect.objectContaining({ name: 'ann' }));
  });

  it('loses the claim race quietly', async () => {
    mockClaim.mockResolvedValue(false);
    expect(await ensureTrial('u1')).toEqual({ status: 'busy' });
    expect(mockStartTrial).not.toHaveBeenCalled();
  });

  it('marks the account on link_required', async () => {
    mockStartTrial.mockResolvedValue({ ok: false, reason: 'rejected', status: 409, code: 'link_required' });
    expect(await ensureTrial('u1')).toEqual({ status: 'link_required' });
    expect(mockMarkLink).toHaveBeenCalledWith('u1');
    expect(mockRecordTrial).not.toHaveBeenCalled();
  });

  it('settles already_subscribed without touching the org a purchase recorded', async () => {
    mockStartTrial.mockResolvedValue({ ok: false, reason: 'rejected', status: 409, code: 'already_subscribed' });
    expect(await ensureTrial('u1')).toEqual({ status: 'subscribed' });
    expect(mockRecordSubscribed).toHaveBeenCalledWith('u1');
    expect(mockRecordTrial).not.toHaveBeenCalled();
    expect(mockRecordError).not.toHaveBeenCalled();
  });

  it('records an upstream failure and does not throw', async () => {
    mockStartTrial.mockResolvedValue({ ok: false, reason: 'unreachable' });
    expect(await ensureTrial('u1')).toEqual({ status: 'error' });
    expect(mockRecordError).toHaveBeenCalledWith('u1', 'unreachable');
    mockStartTrial.mockResolvedValue({ ok: false, reason: 'rejected', status: 400, code: 'bad_days' });
    await ensureTrial('u1');
    expect(mockRecordError).toHaveBeenLastCalledWith('u1', 'bad_days');
  });

  it('never throws, and never logs the email', async () => {
    mockGetUser.mockRejectedValue(new Error('auth down'));
    expect(await ensureTrial('u1')).toEqual({ status: 'error' });
    mockStartTrial.mockResolvedValue({ ok: false, reason: 'unreachable' });
    mockGetUser.mockResolvedValue({ emailVerified: true, email: 'ann@example.com' });
    await ensureTrial('u1');
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('ann@example.com');
  });
});

describe('registerOwnedSites', () => {
  it('pushes every owned site, skips a 409 and invalidates each', async () => {
    mockSites = [
      { id: 's1', data: { name: 'one' } },
      { id: 's2', data: { name: 'two' } },
      { id: 's3', data: {} },
    ];
    mockPushSite.mockImplementation(async ({ siteId }: { siteId: string }) =>
      siteId === 's2'
        ? { ok: false, reason: 'rejected', status: 409, code: 'site_belongs_to_another_org', detail: 'site_running' }
        : { ok: true, created: true, moved: false },
    );
    await registerOwnedSites('u1');
    expect(mockPushSite).toHaveBeenCalledTimes(3);
    expect(mockPushSite).toHaveBeenCalledWith({ uid: 'u1', siteId: 's3', name: 's3' });
    expect(mockInvalidate.mock.calls.map((c) => c[0]).sort()).toEqual(['s1', 's2', 's3']);
    expect(logger.warn).toHaveBeenCalledWith(
      '[plan] site registration refused',
      expect.objectContaining({ data: expect.objectContaining({ siteId: 's2', detail: 'site_running' }) }),
    );
  });

  it('runs at most ten at a time', async () => {
    mockSites = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, data: {} }));
    let live = 0;
    let peak = 0;
    mockPushSite.mockImplementation(async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
      return { ok: true, created: true, moved: false };
    });
    await registerOwnedSites('u1');
    expect(mockPushSite).toHaveBeenCalledTimes(25);
    expect(peak).toBe(10);
  });
});

describe('registerSite', () => {
  it('is a no-op without an organization', async () => {
    mockGetAccount.mockResolvedValue(account());
    expect(await registerSite('u1', 's1', 'one')).toBeNull();
    expect(mockPushSite).not.toHaveBeenCalled();
  });

  it('pushes, invalidates and returns the wrapper result', async () => {
    mockGetAccount.mockResolvedValue(account({ orgId: 'org_1' }));
    expect(await registerSite('u1', 's1', 'one')).toEqual({ ok: true, created: true, moved: false });
    expect(mockInvalidate).toHaveBeenCalledWith('s1');
  });

  it('does not throw', async () => {
    mockGetAccount.mockRejectedValue(new Error('firestore down'));
    expect(await registerSite('u1', 's1', 'one')).toEqual({ ok: false, reason: 'unreachable' });
  });
});
