/** @jest-environment node */

/**
 * POST/PATCH/DELETE /api/sites/{siteId}/billing — the owner's billing actions on
 * a site (adr 0018). the real `authorizedSiteHandler` runs, so the owner-only
 * answers are the wrapper's own; tridant id's billing client is mocked, and what
 * is asserted is which call went out, what the route answered and what landed in
 * the site's billing pointer.
 */

import {
  enforcePlans,
  PRO_ENTITLEMENTS,
  stopEnforcingPlans,
  TRIAL_ENTITLEMENTS,
} from './helpers/planEnforcement';
import { createMockRequest, parseResponse } from './helpers/utils';
import {
  apiKeyAuth,
  docSnapshot,
  mockDbFactory,
  mocks,
  seedMember,
  seedSiteOwner,
  SITE_OWNER,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockGetUser = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    getUser: (uid: string) => mockGetUser(uid),
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

// flipped by the break-glass test; reset to on in `beforeEach`.
const capabilityEnforcement = { value: true };
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: capabilityEnforcement.value,
      rate_limit_enforcement: true,
    })),
  },
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

const mockLogError = jest.fn();
jest.mock('@/lib/logger', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => mockLogError(...a) };
  return { __esModule: true, default: logger, logger };
});

jest.mock('@/lib/resendClient.server', () => ({ trustedBaseUrl: () => 'https://dev.owlette.app' }));

const mockStartCheckout = jest.fn();
const mockAddSite = jest.fn();
const mockSwitchTier = jest.fn();
const mockStopSite = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  PRODUCT: { core: 'prd_owlette_core', pro: 'prd_owlette_pro' },
  startCheckout: (...a: unknown[]) => mockStartCheckout(...a),
  addSite: (...a: unknown[]) => mockAddSite(...a),
  switchTier: (...a: unknown[]) => mockSwitchTier(...a),
  stopSite: (...a: unknown[]) => mockStopSite(...a),
  confirmCheckout: jest.fn(),
}));

const mockRecordCheckout = jest.fn();
const mockGetPlanAccount = jest.fn();
jest.mock('@/lib/planAccounts.server', () => ({
  recordCheckout: (...a: unknown[]) => mockRecordCheckout(...a),
  getCheckout: jest.fn(),
  getPlanAccount: (...a: unknown[]) => mockGetPlanAccount(...a),
  recordOrg: jest.fn(),
  markLinkRequired: jest.fn(),
}));

const mockInvalidate = jest.fn();
const mockSiteEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  // an api key's own plan check, in the wrapper, and what tridant bills for a site with no pointer.
  getSiteEntitlements: (siteId: string) => mockSiteEntitlements(siteId),
  getEntitlements: jest.fn(),
  invalidateSiteEntitlements: (siteId: string) => mockInvalidate(siteId),
}));

import { DELETE, PATCH, POST } from '@/app/api/sites/[siteId]/billing/route';

const SITE = 'site-a';
const ADMIN = 'user-admin';
const SUPERADMIN = 'user-super';
const ENDS_AT = Date.UTC(2026, 11, 1);
const POINTER = { tier: 'pro', founders: true, payerUid: SITE_OWNER, endsAt: null, updatedAt: 'then' };

const url = `http://localhost/api/sites/${SITE}/billing`;
const siteContext = () => ({ params: Promise.resolve({ siteId: SITE }) });

function post(body: unknown, headers?: Record<string, string>) {
  return POST(createMockRequest(url, { method: 'POST', body: body as Record<string, unknown>, headers }), siteContext());
}

function patch(body: unknown) {
  return PATCH(createMockRequest(url, { method: 'PATCH', body: body as Record<string, unknown> }), siteContext());
}

function del() {
  return DELETE(createMockRequest(url, { method: 'DELETE' }), siteContext());
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

function stageSite(extra: Record<string, unknown> = {}): void {
  mocks.siteDocs.set(SITE, { owner: SITE_OWNER, name: 'venue a', ...extra });
}

/** every write of the site's billing pointer. */
function pointerWrites(): unknown[] {
  return mocks.update.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => 'billing' in payload)
    .map((payload) => payload.billing);
}

function tridantCalls(): number {
  return [mockStartCheckout, mockAddSite, mockSwitchTier, mockStopSite].reduce(
    (count, fn) => count + fn.mock.calls.length,
    0,
  );
}

const refused = (code: string, status = 409) => ({ ok: false, reason: 'rejected', status, code });

async function expectProblem(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const { status: actual, body } = await parseResponse(res);
  expect({ status: actual, code: body.code }).toEqual({ status, code });
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  return body;
}

/** refused before anything was asked of tridant or written. */
async function expectUntouched(res: Response, status: number, code: string): Promise<void> {
  await expectProblem(res, status, code);
  expect(tridantCalls()).toBe(0);
  expect(pointerWrites()).toHaveLength(0);
  expect(mockRecordCheckout).not.toHaveBeenCalled();
  expect(mockEmitMutation).not.toHaveBeenCalled();
}

/** what the idempotency cache holds, so a second request with the same key replays it. */
let idempotencyDoc: Record<string, unknown> | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  enforcePlans();
  capabilityEnforcement.value = true;
  idempotencyDoc = null;

  mocks.update.mockResolvedValue(undefined);
  mocks.set.mockImplementation(async (payload: Record<string, unknown>) => {
    if ('bodyHash' in payload) idempotencyDoc = payload;
  });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot('doc', path.startsWith('idempotency_cache/') ? idempotencyDoc : null)),
  );

  seedSiteOwner(SITE);
  stageSite();
  seedMember(SITE, ADMIN, 'admin');
  mocks.userDocs.set(SUPERADMIN, { role: 'superadmin' });
  signIn(SITE_OWNER);

  mockGetUser.mockResolvedValue({ email: 'owner@example.test', emailVerified: true, displayName: 'olive owner' });
  mockStartCheckout.mockResolvedValue({ ok: true, checkoutUrl: 'https://checkout.stripe.com/c/pay_1', sessionId: 'cs_test_1' });
  mockAddSite.mockResolvedValue({ ok: true, already: false, sites: [] });
  // under the owner's trial: pro values and no billing period, so tridant bills nothing here.
  mockSiteEntitlements.mockResolvedValue(TRIAL_ENTITLEMENTS);
  mockGetPlanAccount.mockResolvedValue({ orgId: 'org_1' });
  mockSwitchTier.mockResolvedValue({ ok: true });
  mockStopSite.mockResolvedValue({ ok: true, endsAt: ENDS_AT });
  mockRecordCheckout.mockResolvedValue(undefined);
});

afterAll(stopEnforcingPlans);

describe('who may change a site\'s billing', () => {
  const verbs: Array<[string, () => Promise<Response>]> = [
    ['POST', () => post({ tier: 'pro', founders: false })],
    ['PATCH', () => patch({ tier: 'core' })],
    ['DELETE', () => del()],
  ];

  beforeEach(() => stageSite({ billing: POINTER }));

  it.each(verbs)('refuses a site admin on %s', async (_verb, call) => {
    signIn(ADMIN);

    await expectUntouched(await call(), 403, 'capability_missing');
  });

  // the switch fails toward availability, and a member spending the owner's card is not availability
  it.each(verbs)('still refuses a site admin on %s with capability_enforcement off', async (_verb, call) => {
    capabilityEnforcement.value = false;
    signIn(ADMIN);

    await expectUntouched(await call(), 403, 'capability_missing');
  });

  it.each(verbs)('refuses an api key on %s, even the owner\'s', async (_verb, call) => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(SITE_OWNER));

    await expectUntouched(await call(), 403, 'api_key_not_permitted');
  });

  // a superadmin holds every capability, but the payer is always the owner
  it.each(verbs)('refuses a superadmin who does not own the site on %s', async (_verb, call) => {
    signIn(SUPERADMIN);

    await expectUntouched(await call(), 403, 'not_owner');
  });
});

describe('POST: upgrade a site', () => {
  it.each([
    ['no tier', { founders: false }],
    ['a tier that is not core or pro', { tier: 'free', founders: false }],
    ['no founders', { tier: 'pro' }],
    ['founders that is not a boolean', { tier: 'pro', founders: 'yes' }],
    ['a body that is not an object', ['pro']],
  ])('refuses %s', async (_case, body) => {
    await expectUntouched(await post(body), 400, 'validation_failed');
  });

  it('answers 503 while plans are not enforced, before any read', async () => {
    stopEnforcingPlans();

    await expectUntouched(await post({ tier: 'pro', founders: false }), 503, 'billing_unavailable');
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it.each([
    ['an unverified email', { email: 'owner@example.test', emailVerified: false }],
    ['no email at all', { emailVerified: true }],
  ])('refuses an owner with %s', async (_case, user) => {
    mockGetUser.mockResolvedValue(user);

    await expectUntouched(await post({ tier: 'pro', founders: false }), 403, 'email_unverified');
  });

  it('refuses a site that is already billed', async () => {
    stageSite({ billing: POINTER });

    await expectUntouched(await post({ tier: 'core', founders: false }), 409, 'already_billed');
  });

  it('starts a checkout that returns to the site\'s billing section, and records what it was for', async () => {
    const { status, body } = await parseResponse(await post({ tier: 'pro', founders: true }));

    expect(status).toBe(200);
    expect(body).toEqual({ checkoutUrl: 'https://checkout.stripe.com/c/pay_1' });
    expect(mockStartCheckout).toHaveBeenCalledWith({
      uid: SITE_OWNER,
      email: 'owner@example.test',
      name: 'olive owner',
      siteId: SITE,
      siteName: 'venue a',
      tier: 'pro',
      founders: true,
      successUrl: `https://dev.owlette.app/admin/sites/${SITE}?section=billing&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `https://dev.owlette.app/admin/sites/${SITE}?section=billing`,
    });
    expect(mockRecordCheckout).toHaveBeenCalledWith('cs_test_1', {
      uid: SITE_OWNER,
      siteId: SITE,
      tier: 'pro',
      founders: true,
    });
    // nothing is billed until the checkout is paid and confirmed
    expect(pointerWrites()).toHaveLength(0);
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'billing_mutated',
        siteId: SITE,
        actor: `user:${SITE_OWNER}`,
        targetId: SITE,
        attributes: expect.objectContaining({ method: 'POST', verb: 'checkout_started', tier: 'pro', founders: true }),
      }),
    );
  });

  it('names the payer after their email when the account has no display name', async () => {
    mockGetUser.mockResolvedValue({ email: 'owner@example.test', emailVerified: true });

    await post({ tier: 'core', founders: false });

    expect(mockStartCheckout).toHaveBeenCalledWith(expect.objectContaining({ name: 'owner' }));
  });

  it('switches a resumed site to the plan asked for when tridant brought it back at its old one', async () => {
    stageSite({ billing: { ...POINTER, endsAt: ENDS_AT } });
    mockStartCheckout.mockResolvedValue(refused('subscription_exists'));
    mockAddSite.mockResolvedValue({
      ok: true,
      already: false,
      sites: [{ siteId: SITE, productId: 'prd_owlette_pro', founders: true, status: 'active', endsAt: null }],
    });

    const { status, body } = await parseResponse(await post({ tier: 'core', founders: false }));

    expect({ status, body }).toEqual({ status: 200, body: { added: true } });
    expect(mockSwitchTier).toHaveBeenCalledWith(SITE, 'core', false);
    expect(pointerWrites()).toEqual([
      { tier: 'core', founders: false, payerUid: SITE_OWNER, endsAt: null, updatedAt: '__SERVER_TS__' },
    ]);
  });

  it('records the plan tridant resumed when the switch to the one asked for is refused', async () => {
    stageSite({ billing: { ...POINTER, endsAt: ENDS_AT } });
    mockStartCheckout.mockResolvedValue(refused('subscription_exists'));
    mockAddSite.mockResolvedValue({
      ok: true,
      already: false,
      sites: [{ siteId: SITE, productId: 'prd_owlette_pro', founders: true, status: 'active', endsAt: null }],
    });
    mockSwitchTier.mockResolvedValue({ ok: false, reason: 'unreachable' });

    await expectProblem(await post({ tier: 'core', founders: false }), 503, 'billing_unavailable');
    expect(pointerWrites()).toEqual([
      { tier: 'pro', founders: true, payerUid: SITE_OWNER, endsAt: null, updatedAt: '__SERVER_TS__' },
    ]);
  });

  it('does not switch when the added site is already at the plan asked for', async () => {
    mockStartCheckout.mockResolvedValue(refused('subscription_exists'));
    mockAddSite.mockResolvedValue({
      ok: true,
      already: false,
      sites: [{ siteId: SITE, productId: 'prd_owlette_core', founders: false, status: 'active', endsAt: null }],
    });

    expect((await post({ tier: 'core', founders: false })).status).toBe(200);
    expect(mockSwitchTier).not.toHaveBeenCalled();
  });

  it('refuses an upgrade while the previous owner still pays for the site', async () => {
    stageSite({ billing: { ...POINTER, payerUid: 'user-previous', endsAt: Date.now() + 86_400_000 } });

    await expectUntouched(await post({ tier: 'pro', founders: false }), 409, 'billed_by_previous_owner');
  });

  it('lets the new owner upgrade once the previous owner\'s period has ended', async () => {
    stageSite({ billing: { ...POINTER, payerUid: 'user-previous', endsAt: Date.now() - 1000 } });

    expect((await post({ tier: 'pro', founders: false })).status).toBe(200);
    expect(mockStartCheckout).toHaveBeenCalledTimes(1);
  });

  it('lets a site whose billing was stopped upgrade again', async () => {
    stageSite({ billing: { ...POINTER, endsAt: ENDS_AT } });

    expect((await post({ tier: 'pro', founders: false })).status).toBe(200);
    expect(mockStartCheckout).toHaveBeenCalledTimes(1);
  });

  it('adds the site to a running subscription when tridant says one exists', async () => {
    mockStartCheckout.mockResolvedValue(refused('subscription_exists'));

    const { status, body } = await parseResponse(await post({ tier: 'core', founders: false }));

    expect(status).toBe(200);
    expect(body).toEqual({ added: true });
    expect(mockAddSite).toHaveBeenCalledWith({
      uid: SITE_OWNER,
      siteId: SITE,
      siteName: 'venue a',
      tier: 'core',
      founders: false,
    });
    expect(pointerWrites()).toEqual([
      { tier: 'core', founders: false, payerUid: SITE_OWNER, endsAt: null, updatedAt: '__SERVER_TS__' },
    ]);
    expect(mockInvalidate).toHaveBeenCalledWith(SITE);
    expect(mockRecordCheckout).not.toHaveBeenCalled();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({ attributes: expect.objectContaining({ verb: 'site_added', tier: 'core' }) }),
    );
  });

  const conflicts = ['link_required', 'site_billed_elsewhere', 'founders_sold_out', 'site_is_default', 'subscription_paused'];

  it.each(conflicts)('answers 409 %s when the checkout is refused with it', async (code) => {
    mockStartCheckout.mockResolvedValue(refused(code));

    const body = await expectProblem(await post({ tier: 'pro', founders: true }), 409, code);

    expect(body.detail).toBe(String(body.detail).toLowerCase());
    expect(pointerWrites()).toHaveLength(0);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it.each(conflicts)('answers 409 %s when adding the site is refused with it', async (code) => {
    mockStartCheckout.mockResolvedValue(refused('subscription_exists'));
    mockAddSite.mockResolvedValue(refused(code));

    await expectProblem(await post({ tier: 'pro', founders: true }), 409, code);
    expect(pointerWrites()).toHaveLength(0);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it.each([
    ['tridant cannot be reached', { ok: false, reason: 'unreachable' }, 503, 'billing_unavailable'],
    ['tridant is not configured', { ok: false, reason: 'not_configured' }, 503, 'billing_unavailable'],
    ['tridant refuses the return url', refused('return_url_not_allowed', 400), 502, 'billing_upstream'],
    ['tridant refuses the key', { ok: false, reason: 'rejected', status: 403 }, 502, 'billing_upstream'],
    ['the answer is unreadable', { ok: false, reason: 'malformed_response', status: 201 }, 502, 'billing_upstream'],
  ])('answers a problem when %s', async (_case, failure, status, code) => {
    mockStartCheckout.mockResolvedValue(failure);

    await expectProblem(await post({ tier: 'pro', founders: false }), status, code);
    expect(mockAddSite).not.toHaveBeenCalled();
    expect(pointerWrites()).toHaveLength(0);
  });

  it('logs an unexpected refusal by its code, with nothing of the payer', async () => {
    mockStartCheckout.mockResolvedValue(refused('return_url_not_allowed', 400));

    await post({ tier: 'pro', founders: false });

    expect(mockLogError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mockLogError.mock.calls[0]);
    expect(logged).toContain('return_url_not_allowed');
    expect(logged).not.toContain('owner@example.test');
  });

  it('replays the first answer for a repeated idempotency key, and starts one checkout', async () => {
    const headers = { 'Idempotency-Key': 'upgrade-1' };

    const first = await post({ tier: 'pro', founders: true }, headers);
    const second = await post({ tier: 'pro', founders: true }, headers);

    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(mockStartCheckout).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('refuses a repeated idempotency key with another body', async () => {
    const headers = { 'Idempotency-Key': 'upgrade-1' };
    await post({ tier: 'pro', founders: true }, headers);

    await expectProblem(await post({ tier: 'core', founders: true }, headers), 422, 'idempotency_key_mismatch');
    expect(mockStartCheckout).toHaveBeenCalledTimes(1);
  });

  it('caches no refusal, so a retry after linking runs again', async () => {
    const headers = { 'Idempotency-Key': 'upgrade-1' };
    mockStartCheckout.mockResolvedValueOnce(refused('link_required'));

    await expectProblem(await post({ tier: 'pro', founders: true }, headers), 409, 'link_required');
    expect((await post({ tier: 'pro', founders: true }, headers)).status).toBe(200);
    expect(mockStartCheckout).toHaveBeenCalledTimes(2);
  });
});

describe('PATCH: switch plan', () => {
  beforeEach(() => stageSite({ billing: POINTER }));

  it.each([
    ['no tier', {}],
    ['a tier that is not core or pro', { tier: 'trial' }],
    ['founders that is not a boolean', { tier: 'core', founders: 1 }],
  ])('refuses %s', async (_case, body) => {
    await expectUntouched(await patch(body), 400, 'validation_failed');
  });

  it('answers 404 for a site with no billing', async () => {
    stageSite();

    await expectUntouched(await patch({ tier: 'core' }), 404, 'not_billed');
  });

  it('refuses a switch by a new owner while the previous owner still pays', async () => {
    stageSite({ billing: { ...POINTER, payerUid: 'user-previous', endsAt: ENDS_AT } });

    await expectUntouched(await patch({ tier: 'pro' }), 409, 'billed_by_previous_owner');
  });

  it('switches a site tridant bills that has no pointer, and writes one', async () => {
    stageSite();
    mockSiteEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);

    const { status } = await parseResponse(await patch({ tier: 'core' }));

    expect(status).toBe(200);
    expect(mockSwitchTier).toHaveBeenCalledWith(SITE, 'core', undefined);
    expect(pointerWrites()).toEqual([
      { tier: 'core', founders: false, payerUid: SITE_OWNER, endsAt: null, updatedAt: '__SERVER_TS__' },
    ]);
  });

  it('refuses a switch on a pointerless site billed under another organization', async () => {
    stageSite();
    mockSiteEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);
    mockGetPlanAccount.mockResolvedValue({ orgId: 'org_other' });

    await expectUntouched(await patch({ tier: 'core' }), 409, 'billed_by_previous_owner');
  });

  it('switches the tier and keeps the site\'s rate when founders is left out', async () => {
    const { status, body } = await parseResponse(await patch({ tier: 'core' }));

    expect(status).toBe(200);
    expect(body).toEqual({ billing: { tier: 'core', founders: true, endsAt: null } });
    expect(mockSwitchTier).toHaveBeenCalledWith(SITE, 'core', undefined);
    expect(pointerWrites()).toEqual([
      { tier: 'core', founders: true, payerUid: SITE_OWNER, endsAt: null, updatedAt: '__SERVER_TS__' },
    ]);
    expect(mockInvalidate).toHaveBeenCalledWith(SITE);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'billing_mutated',
        attributes: expect.objectContaining({ method: 'PATCH', verb: 'tier_switched', tier: 'core' }),
      }),
    );
  });

  it('passes founders on when it is given', async () => {
    const { body } = await parseResponse(await patch({ tier: 'core', founders: false }));

    expect(mockSwitchTier).toHaveBeenCalledWith(SITE, 'core', false);
    expect(body).toEqual({ billing: { tier: 'core', founders: false, endsAt: null } });
  });

  it.each([
    ['tridant bills no such site', refused('site_not_billed', 404), 404, 'not_billed'],
    ['the new tier has no founders place left', refused('founders_sold_out'), 409, 'founders_sold_out'],
    ['tridant cannot be reached', { ok: false, reason: 'unreachable' }, 503, 'billing_unavailable'],
    ['tridant answers anything else', refused('product_not_in_key_scope', 403), 502, 'billing_upstream'],
  ])('answers a problem when %s, and leaves the pointer alone', async (_case, failure, status, code) => {
    mockSwitchTier.mockResolvedValue(failure);

    await expectProblem(await patch({ tier: 'core' }), status, code);
    expect(pointerWrites()).toHaveLength(0);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('DELETE: stop billing', () => {
  beforeEach(() => stageSite({ billing: POINTER }));

  it('answers 404 for a site with no billing', async () => {
    stageSite();

    await expectUntouched(await del(), 404, 'not_billed');
  });

  it('stops a site tridant bills that has no pointer: the return from checkout never loaded', async () => {
    stageSite();
    mockSiteEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);

    const { status, body } = await parseResponse(await del());

    expect(status).toBe(200);
    expect(body).toEqual({ billing: { tier: 'pro', founders: false, endsAt: ENDS_AT } });
    expect(mockStopSite).toHaveBeenCalledWith(SITE);
  });

  it('lets a new owner stop a site the previous owner still pays for', async () => {
    stageSite({ billing: { ...POINTER, payerUid: 'user-previous' } });

    expect((await del()).status).toBe(200);
    expect(mockStopSite).toHaveBeenCalledWith(SITE);
  });

  it('stops billing and records when the site\'s plan ends', async () => {
    const { status, body } = await parseResponse(await del());

    expect(status).toBe(200);
    expect(body).toEqual({ billing: { tier: 'pro', founders: true, endsAt: ENDS_AT } });
    expect(mockStopSite).toHaveBeenCalledWith(SITE);
    expect(pointerWrites()).toEqual([
      { tier: 'pro', founders: true, payerUid: SITE_OWNER, endsAt: ENDS_AT, updatedAt: '__SERVER_TS__' },
    ]);
    expect(mockInvalidate).toHaveBeenCalledWith(SITE);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ method: 'DELETE', verb: 'billing_stopped', endsAt: ENDS_AT }),
      }),
    );
  });

  it.each([
    ['tridant bills no such site', refused('site_not_billed', 404), 404, 'not_billed'],
    ['tridant cannot be reached', { ok: false, reason: 'unreachable' }, 503, 'billing_unavailable'],
    ['the answer is unreadable', { ok: false, reason: 'malformed_response', status: 200 }, 502, 'billing_upstream'],
  ])('answers a problem when %s, and leaves the pointer alone', async (_case, failure, status, code) => {
    mockStopSite.mockResolvedValue(failure);

    await expectProblem(await del(), status, code);
    expect(pointerWrites()).toHaveLength(0);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
