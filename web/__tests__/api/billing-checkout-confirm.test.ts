/** @jest-environment node */

/**
 * GET /api/billing/checkout/{sessionId} — the return from stripe checkout. pins
 * the session-only auth, the shape check on an id that comes from a url, that
 * only the account that started a checkout reads it, and what a pending, a
 * failed and a complete purchase each answer and write.
 */

import { createMockRequest, parseResponse } from './helpers/utils';
import { mockDbFactory, mocks } from './helpers/firestore-mock';

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

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));

jest.mock('@/lib/resendClient.server', () => ({ trustedBaseUrl: () => 'https://dev.owlette.app' }));

const mockRequireSessionOrIdToken = jest.fn();
const mockAssertActiveUser = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSessionOrIdToken: (...a: unknown[]) => mockRequireSessionOrIdToken(...a),
    assertActiveUser: (uid: string) => mockAssertActiveUser(uid),
  };
});

const mockConfirmCheckout = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  PRODUCT: { core: 'prd_owlette_core', pro: 'prd_owlette_pro' },
  confirmCheckout: (sessionId: string) => mockConfirmCheckout(sessionId),
}));

const mockGetCheckout = jest.fn();
const mockRecordOrg = jest.fn();
jest.mock('@/lib/planAccounts.server', () => ({
  getCheckout: (sessionId: string) => mockGetCheckout(sessionId),
  recordOrg: (...a: unknown[]) => mockRecordOrg(...a),
  recordCheckout: jest.fn(),
}));

const mockInvalidate = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getSiteEntitlements: jest.fn(),
  invalidateSiteEntitlements: (siteId: string) => mockInvalidate(siteId),
}));

import { GET } from '@/app/api/billing/checkout/[sessionId]/route';
import { ApiAuthError } from '@/lib/apiAuth.server';

const UID = 'user-owner';
const SITE = 'site-a';
const SESSION = 'cs_test_a1B2c3';
const ENDS_AT = Date.UTC(2026, 11, 1);

function confirm(sessionId: string = SESSION) {
  return GET(createMockRequest(`http://localhost/api/billing/checkout/${encodeURIComponent(sessionId)}`), {
    params: Promise.resolve({ sessionId }),
  });
}

const billedSite = (extra: Record<string, unknown> = {}) => ({
  siteId: SITE,
  productId: 'prd_owlette_pro',
  founders: true,
  status: 'active',
  endsAt: null,
  ...extra,
});

const complete = (sites: unknown[] = [billedSite()]) => ({ ok: true, status: 'complete', orgId: 'org_1', sites });

function pointerWrites(): unknown[] {
  return mocks.update.mock.calls.map(([payload]) => (payload as Record<string, unknown>).billing);
}

function expectNothingWritten(): void {
  expect(pointerWrites()).toHaveLength(0);
  expect(mockRecordOrg).not.toHaveBeenCalled();
  expect(mockInvalidate).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.update.mockResolvedValue(undefined);
  mockRequireSessionOrIdToken.mockResolvedValue(UID);
  mockAssertActiveUser.mockResolvedValue({ role: 'member' });
  mockGetCheckout.mockResolvedValue({ uid: UID, siteId: SITE, tier: 'pro', founders: true });
  mockConfirmCheckout.mockResolvedValue(complete());
  mockRecordOrg.mockResolvedValue(undefined);
});

describe('who may confirm a checkout', () => {
  it('asks for a session, and refuses agent tokens', async () => {
    await confirm();

    expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(expect.anything(), { rejectAgentTokens: true });
  });

  it('answers 401 without a session', async () => {
    mockRequireSessionOrIdToken.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));

    expect((await confirm()).status).toBe(401);
    expect(mockGetCheckout).not.toHaveBeenCalled();
  });

  it('answers 403 to an agent token', async () => {
    mockRequireSessionOrIdToken.mockRejectedValue(new ApiAuthError(403, 'Forbidden: agent credentials'));

    expect((await confirm()).status).toBe(403);
    expect(mockGetCheckout).not.toHaveBeenCalled();
  });

  it('answers 403 to a deleted account', async () => {
    mockAssertActiveUser.mockRejectedValue(new ApiAuthError(403, 'Forbidden: User is deleted or inactive'));

    expect((await confirm()).status).toBe(403);
    expect(mockGetCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty id', ''],
    ['an id longer than 200 characters', 'a'.repeat(201)],
    ['a path', 'cs_test/../users'],
    ['a hyphen', 'cs-test-1'],
    ['a space', 'cs test'],
    ['an id firestore reserves', '__checkout__'],
  ])('answers 404 for %s before any read', async (_case, sessionId) => {
    const { status, body } = await parseResponse(await confirm(sessionId));

    expect({ status, code: body.code }).toEqual({ status: 404, code: 'not_found' });
    expect(mockAssertActiveUser).not.toHaveBeenCalled();
    expect(mockGetCheckout).not.toHaveBeenCalled();
    expect(mockConfirmCheckout).not.toHaveBeenCalled();
  });

  it('accepts an id of 200 characters', async () => {
    expect((await confirm('a'.repeat(200))).status).toBe(200);
  });

  it('answers 404 for a checkout nobody recorded', async () => {
    mockGetCheckout.mockResolvedValue(null);

    const { status, body } = await parseResponse(await confirm());

    expect({ status, code: body.code }).toEqual({ status: 404, code: 'not_found' });
    expect(mockConfirmCheckout).not.toHaveBeenCalled();
  });

  it('answers the same 404 for a checkout another account started, and asks tridant nothing', async () => {
    mockGetCheckout.mockResolvedValue({ uid: 'user-other', siteId: SITE, tier: 'pro', founders: true });

    const { status, body } = await parseResponse(await confirm());

    expect({ status, code: body.code, detail: body.detail }).toEqual({
      status: 404,
      code: 'not_found',
      detail: 'checkout not found',
    });
    expect(mockConfirmCheckout).not.toHaveBeenCalled();
    expectNothingWritten();
  });
});

describe('what a checkout answers', () => {
  it('answers pending until tridant has fulfilled the purchase, and writes nothing', async () => {
    mockConfirmCheckout.mockResolvedValue({ ok: true, status: 'pending', orgId: null, sites: [] });

    const { status, body } = await parseResponse(await confirm());

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'pending', siteId: SITE, tier: 'pro' });
    expectNothingWritten();
  });

  it('answers failed with tridant\'s reason, and writes nothing', async () => {
    mockConfirmCheckout.mockResolvedValue({
      ok: true,
      status: 'failed',
      error: 'link_required',
      orgId: null,
      sites: [],
    });

    const { status, body } = await parseResponse(await confirm());

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'failed', siteId: SITE, tier: 'pro', error: 'link_required' });
    expectNothingWritten();
  });

  it('records the site\'s billing and the account\'s organization once the purchase is complete', async () => {
    const { status, body } = await parseResponse(await confirm());

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'complete', siteId: SITE, tier: 'pro' });
    expect(mockConfirmCheckout).toHaveBeenCalledWith(SESSION);
    expect(pointerWrites()).toEqual([
      { tier: 'pro', founders: true, payerUid: UID, endsAt: null, updatedAt: '__SERVER_TS__' },
    ]);
    expect(mockRecordOrg).toHaveBeenCalledWith(UID, 'org_1');
    expect(mockInvalidate).toHaveBeenCalledWith(SITE);
  });

  // tridant lists what it bills now, so an old return url cannot undo a later switch or stop
  it('writes what tridant bills today when the return url is opened again later', async () => {
    mockConfirmCheckout.mockResolvedValue(
      complete([
        { ...billedSite(), siteId: 'site-b' },
        billedSite({ productId: 'prd_owlette_core', founders: false, endsAt: ENDS_AT }),
      ]),
    );

    const { body } = await parseResponse(await confirm());

    expect(body).toEqual({ status: 'complete', siteId: SITE, tier: 'core' });
    expect(pointerWrites()).toEqual([
      { tier: 'core', founders: false, payerUid: UID, endsAt: ENDS_AT, updatedAt: '__SERVER_TS__' },
    ]);
  });

  it('writes no pointer for a site tridant no longer bills', async () => {
    mockConfirmCheckout.mockResolvedValue(complete([]));

    const { status, body } = await parseResponse(await confirm());

    expect(status).toBe(200);
    expect(body).toEqual({ status: 'complete', siteId: SITE, tier: 'pro' });
    expect(pointerWrites()).toHaveLength(0);
    expect(mockInvalidate).toHaveBeenCalledWith(SITE);
  });

  it.each([
    ['tridant does not know the session', { ok: false, reason: 'rejected', status: 404, code: 'checkout_not_found' }, 404, 'not_found'],
    ['tridant cannot be reached', { ok: false, reason: 'unreachable' }, 503, 'billing_unavailable'],
    ['tridant refuses the key', { ok: false, reason: 'rejected', status: 403, code: 'product_not_in_key_scope' }, 502, 'billing_upstream'],
    ['the answer is unreadable', { ok: false, reason: 'malformed_response', status: 200 }, 502, 'billing_upstream'],
  ])('answers a problem when %s', async (_case, failure, status, code) => {
    mockConfirmCheckout.mockResolvedValue(failure);

    const { status: actual, body } = await parseResponse(await confirm());

    expect({ status: actual, code: body.code }).toEqual({ status, code });
    expectNothingWritten();
  });
});
