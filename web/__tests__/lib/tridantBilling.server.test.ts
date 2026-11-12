/** @jest-environment node */

/**
 * tridantBilling.server — what owlette sends tridant id's billing api and how
 * each answer and refusal is read, the usage chunks, the founders cache, and
 * the firestore-backed fake that answers instead under OWLETTE_E2E.
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockStore = new Map<string, Record<string, unknown>>();
let mockFirestoreDown = false;
let mockAutoId = 0;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (mockFirestoreDown) throw new Error('firestore down');
      const doc = (id: string) => {
        const key = `${name}/${id}`;
        return {
          get: async () => ({ data: () => mockStore.get(key) }),
          set: async (data: Record<string, unknown>) => {
            mockStore.set(key, structuredClone(data));
          },
          // like firestore, a dotted top-level key addresses a nested field.
          update: async (patch: Record<string, unknown>) => {
            const data = structuredClone(mockStore.get(key) ?? {});
            for (const [path, value] of Object.entries(patch)) {
              const keys = path.split('.');
              let target = data;
              for (const step of keys.slice(0, -1)) target = target[step] as Record<string, unknown>;
              target[keys[keys.length - 1]] = value;
            }
            mockStore.set(key, data);
          },
        };
      };
      return { doc, add: async (data: Record<string, unknown>) => doc(`auto-${mockAutoId++}`).set(data) };
    },
  }),
}));

jest.mock('@/lib/tridant.server', () => ({
  ...jest.requireActual('@/lib/tridant.server'),
  tridantFetch: jest.fn(),
}));

import logger from '@/lib/logger';
import { tridantFetch, type TridantResult } from '@/lib/tridant.server';
import {
  PRODUCT,
  __resetForTests,
  addSite,
  confirmCheckout,
  foundersRemaining,
  linkAccount,
  pushSite,
  reportUsage,
  siteRef,
  startCheckout,
  startTrial,
  stopSite,
  subjectFor,
  switchTier,
  unlinkAccount,
} from '@/lib/tridantBilling.server';

const KEY = 'tri_billing_key';
const EMAIL = 'ops@acme.example';
const ID_TOKEN = 'eyJ.id.token';
const NOW = Date.UTC(2026, 10, 11, 12);
const MONTH_START = Date.UTC(2026, 10, 1);
const MONTH_END = Date.UTC(2026, 11, 1);

const mockTridantFetch = tridantFetch as jest.MockedFunction<typeof tridantFetch>;
const mockFetch = jest.fn();

const answer = (json: unknown, status = 200): TridantResult => ({ ok: true, status, json });
const refusal = (status: number, json: unknown): TridantResult => ({ ok: false, reason: 'rejected', status, json });

function expectCall(method: string, path: string, body?: unknown) {
  expect(mockTridantFetch).toHaveBeenCalledTimes(1);
  const [calledPath, request] = mockTridantFetch.mock.calls[0];
  expect(calledPath).toBe(path);
  expect(request.key).toBe(KEY);
  expect(request.method).toBe(method);
  expect(request.body).toEqual(body);
}

function reply(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === undefined) throw new SyntaxError('not json');
      return body;
    },
  } as unknown as Response;
}

const CHECKOUT = {
  uid: 'u1',
  email: EMAIL,
  name: 'Acme',
  siteId: 'site-7',
  siteName: 'Venue A',
  tier: 'pro' as const,
  founders: true,
  successUrl: 'https://dev.owlette.app/admin/sites/site-7?section=billing&session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://dev.owlette.app/admin/sites/site-7?section=billing',
};

const SUBSCRIPTION = {
  id: 'ssb_1',
  status: 'active',
  card_group: 'owlette',
  current_period_start: MONTH_START,
  current_period_end: MONTH_END,
  cancel_at_period_end: false,
};

const BILLED_SITE = {
  site: 'owlette:site-7',
  site_id: 'ste_1',
  name: 'Venue A',
  product_id: 'prd_owlette_pro',
  license_id: 'lic_1',
  founders: true,
  status: 'active',
  ends_at: null,
};

beforeEach(() => {
  // only the clock is faked: the fake's month and the founders cache read it, and nothing here waits on a timer.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  jest.clearAllMocks();
  __resetForTests();
  mockStore.clear();
  mockFirestoreDown = false;
  mockAutoId = 0;
  process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io/';
  process.env.TRIDANT_LICENSE_KEY = KEY;
  delete process.env.OWLETTE_E2E;
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => {
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
  delete process.env.OWLETTE_E2E;
});

describe('references', () => {
  it('names products, payers and sites the way tridant knows them', () => {
    expect(PRODUCT).toEqual({ core: 'prd_owlette_core', pro: 'prd_owlette_pro' });
    expect(subjectFor('u1')).toBe('owlette:u1');
    expect(siteRef('site-7')).toBe('owlette:site-7');
  });
});

describe('startCheckout', () => {
  it('posts the payer, the site, the product and the return urls', async () => {
    mockTridantFetch.mockResolvedValue(answer({ checkout_url: 'https://checkout.stripe.com/c/1', session_id: 'cs_1' }, 201));

    expect(await startCheckout(CHECKOUT)).toEqual({
      ok: true,
      checkoutUrl: 'https://checkout.stripe.com/c/1',
      sessionId: 'cs_1',
    });
    expectCall('POST', '/v1/billing/checkout', {
      payer: { subject: 'owlette:u1', email: EMAIL, name: 'Acme' },
      site: { ref: 'owlette:site-7', name: 'Venue A' },
      product: 'prd_owlette_pro',
      founders: true,
      success_url: CHECKOUT.successUrl,
      cancel_url: CHECKOUT.cancelUrl,
    });
  });

  it("carries tridant's error as the code", async () => {
    mockTridantFetch.mockResolvedValue(refusal(409, { error: 'subscription_exists', hint: 'POST /v1/billing/sites' }));

    expect(await startCheckout({ ...CHECKOUT, tier: 'core', founders: false })).toEqual({
      ok: false,
      reason: 'rejected',
      status: 409,
      code: 'subscription_exists',
    });
    expect(mockTridantFetch.mock.calls[0][1].body).toMatchObject({ product: 'prd_owlette_core', founders: false });
  });

  it('reads an answer without a session as malformed, and logs no email', async () => {
    mockTridantFetch.mockResolvedValue(answer({ checkout_url: 'https://checkout.stripe.com/c/1' }, 201));

    expect(await startCheckout(CHECKOUT)).toEqual({ ok: false, reason: 'malformed_response', status: 201 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain(EMAIL);
  });

  it.each([
    [{ ok: false, reason: 'not_configured' } as const, { ok: false, reason: 'not_configured' }],
    [{ ok: false, reason: 'unreachable', status: 503 } as const, { ok: false, reason: 'unreachable', status: 503 }],
    [{ ok: false, reason: 'malformed_response', status: 200 } as const, { ok: false, reason: 'malformed_response', status: 200 }],
    [{ ok: false, reason: 'rejected', status: 401, json: 'nope' } as const, { ok: false, reason: 'rejected', status: 401 }],
  ])('passes a failure through with no code: %j', async (failure, expected) => {
    mockTridantFetch.mockResolvedValue(failure);
    expect(await startCheckout(CHECKOUT)).toEqual(expected);
  });
});

describe('confirmCheckout', () => {
  it('reads a fulfilled purchase, with sites by their owlette id', async () => {
    mockTridantFetch.mockResolvedValue(
      answer({
        session_id: 'cs_1',
        status: 'complete',
        org_id: 'org_1',
        subscription: SUBSCRIPTION,
        sites: [
          BILLED_SITE,
          { ...BILLED_SITE, site: 'owlette:site-8', product_id: 'prd_owlette_core', founders: false, ends_at: MONTH_END },
          // a site with no owlette reference answers by its tridant id.
          { ...BILLED_SITE, site: 'ste_other' },
        ],
      }),
    );

    expect(await confirmCheckout('cs_1')).toEqual({
      ok: true,
      status: 'complete',
      orgId: 'org_1',
      sites: [
        { siteId: 'site-7', productId: 'prd_owlette_pro', founders: true, status: 'active', endsAt: null },
        { siteId: 'site-8', productId: 'prd_owlette_core', founders: false, status: 'active', endsAt: MONTH_END },
      ],
    });
    expectCall('GET', '/v1/billing/checkout/cs_1');
  });

  it('reads a purchase the webhook has not fulfilled yet', async () => {
    mockTridantFetch.mockResolvedValue(answer({ session_id: 'cs_1', status: 'pending', org_id: null, subscription: null, sites: [] }));
    expect(await confirmCheckout('cs_1')).toEqual({ ok: true, status: 'pending', orgId: null, sites: [] });
  });

  it('carries the error of a failed purchase', async () => {
    mockTridantFetch.mockResolvedValue(
      answer({ session_id: 'cs_1', status: 'failed', error: 'site_billed_elsewhere', org_id: null, subscription: null, sites: [] }),
    );
    expect(await confirmCheckout('cs_1')).toEqual({
      ok: true,
      status: 'failed',
      error: 'site_billed_elsewhere',
      orgId: null,
      sites: [],
    });
  });

  it('encodes the session id and maps an unknown session', async () => {
    mockTridantFetch.mockResolvedValue(refusal(404, { error: 'checkout_not_found' }));
    expect(await confirmCheckout('a/b?c')).toEqual({ ok: false, reason: 'rejected', status: 404, code: 'checkout_not_found' });
    expect(mockTridantFetch.mock.calls[0][0]).toBe('/v1/billing/checkout/a%2Fb%3Fc');
  });

  it.each([
    ['an unknown status', { status: 'paid', sites: [] }],
    ['no sites', { status: 'complete' }],
    ['a site without a product', { status: 'complete', sites: [{ site: 'owlette:site-7', status: 'active' }] }],
    ['a body that is not an object', ['complete']],
  ])('reads %s as malformed', async (_name, body) => {
    mockTridantFetch.mockResolvedValue(answer(body));
    expect(await confirmCheckout('cs_1')).toEqual({ ok: false, reason: 'malformed_response', status: 200 });
  });
});

describe('addSite', () => {
  const INPUT = { uid: 'u1', siteId: 'site-8', siteName: 'Venue B', tier: 'core' as const, founders: false };

  it('posts the payer by subject only', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subscription: SUBSCRIPTION, sites: [BILLED_SITE] }, 201));

    expect(await addSite(INPUT)).toEqual({ ok: true, already: false });
    expectCall('POST', '/v1/billing/sites', {
      payer: { subject: 'owlette:u1' },
      site: { ref: 'owlette:site-8', name: 'Venue B' },
      product: 'prd_owlette_core',
      founders: false,
    });
  });

  it('says when the site was billed already', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subscription: SUBSCRIPTION, sites: [BILLED_SITE], already: true }));
    expect(await addSite(INPUT)).toEqual({ ok: true, already: true });
  });

  it('maps a refusal', async () => {
    mockTridantFetch.mockResolvedValue(refusal(409, { error: 'no_subscription' }));
    expect(await addSite(INPUT)).toEqual({ ok: false, reason: 'rejected', status: 409, code: 'no_subscription' });
  });
});

describe('switchTier', () => {
  it('patches the site by its reference', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subscription: SUBSCRIPTION, sites: [BILLED_SITE] }));

    expect(await switchTier('site-7', 'core', false)).toEqual({ ok: true });
    expectCall('PATCH', '/v1/billing/sites/owlette:site-7', { product: 'prd_owlette_core', founders: false });
  });

  it('leaves founders out when the caller does not say, so tridant keeps the rate', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subscription: SUBSCRIPTION, sites: [] }));

    await switchTier('a/b', 'pro');
    const [path, request] = mockTridantFetch.mock.calls[0];
    expect(path).toBe('/v1/billing/sites/owlette:a%2Fb');
    expect(JSON.parse(JSON.stringify(request.body))).toEqual({ product: 'prd_owlette_pro' });
  });

  it.each([
    [404, 'site_not_billed'],
    [409, 'founders_sold_out'],
  ])('maps %i %s', async (status, code) => {
    mockTridantFetch.mockResolvedValue(refusal(status, { error: code }));
    expect(await switchTier('site-7', 'pro', true)).toEqual({ ok: false, reason: 'rejected', status, code });
  });
});

describe('stopSite', () => {
  it('deletes the site and answers when it ends', async () => {
    mockTridantFetch.mockResolvedValue(answer({ site: 'owlette:site-7', ends_at: MONTH_END, subscription: SUBSCRIPTION }));

    expect(await stopSite('site-7')).toEqual({ ok: true, endsAt: MONTH_END });
    expectCall('DELETE', '/v1/billing/sites/owlette:site-7');
  });

  it('reads an answer without an end as malformed', async () => {
    mockTridantFetch.mockResolvedValue(answer({ site: 'owlette:site-7' }));
    expect(await stopSite('site-7')).toEqual({ ok: false, reason: 'malformed_response', status: 200 });
  });

  it('maps a site nobody bills', async () => {
    mockTridantFetch.mockResolvedValue(refusal(404, { error: 'site_not_billed' }));
    expect(await stopSite('site-7')).toEqual({ ok: false, reason: 'rejected', status: 404, code: 'site_not_billed' });
  });
});

describe('startTrial', () => {
  const INPUT = { uid: 'u1', email: EMAIL, name: 'Acme' };
  const LICENSE = {
    id: 'lic_t',
    product_id: 'prd_owlette_pro',
    billing_type: 'trial',
    status: 'active',
    issued_at: NOW,
    expires_at: NOW + 14 * 86_400_000,
  };

  it('asks for 14 days of pro', async () => {
    mockTridantFetch.mockResolvedValue(answer({ org_id: 'org_1', license: LICENSE, already: false }, 201));

    expect(await startTrial(INPUT)).toEqual({ ok: true, orgId: 'org_1', expiresAt: LICENSE.expires_at, already: false });
    expectCall('POST', '/v1/billing/trial', {
      payer: { subject: 'owlette:u1', email: EMAIL, name: 'Acme' },
      product: 'prd_owlette_pro',
      days: 14,
    });
  });

  it('answers the first trial again on a repeat', async () => {
    mockTridantFetch.mockResolvedValue(answer({ org_id: 'org_1', license: LICENSE, already: true }));
    expect(await startTrial(INPUT)).toMatchObject({ ok: true, already: true });
  });

  it.each(['link_required', 'already_subscribed'])('maps 409 %s', async (code) => {
    mockTridantFetch.mockResolvedValue(refusal(409, { error: code }));
    expect(await startTrial(INPUT)).toEqual({ ok: false, reason: 'rejected', status: 409, code });
  });

  it('reads an answer without an expiry as malformed', async () => {
    mockTridantFetch.mockResolvedValue(answer({ org_id: 'org_1', license: { id: 'lic_t' }, already: false }, 201));
    expect(await startTrial(INPUT)).toEqual({ ok: false, reason: 'malformed_response', status: 201 });
  });
});

describe('reportUsage', () => {
  const recorded = (site: string) => ({ site, status: 'recorded', recorded: true, machines: 1, as_of: NOW });
  const sitesSent = (call: number) =>
    (mockTridantFetch.mock.calls[call][1].body as { sites: Array<{ site: string }> }).sites;

  it('reports each site with the moment it was counted', async () => {
    mockTridantFetch.mockResolvedValue(
      answer({ recorded: 2, max: 500, results: [recorded('owlette:site-7'), recorded('owlette:site-8')] }),
    );

    expect(
      await reportUsage(
        [
          { siteId: 'site-7', machines: 12 },
          { siteId: 'site-8', machines: 3 },
        ],
        NOW,
      ),
    ).toEqual({
      ok: true,
      results: [
        { siteId: 'site-7', status: 'recorded', recorded: true },
        { siteId: 'site-8', status: 'recorded', recorded: true },
      ],
    });
    expectCall('POST', '/v1/usage', {
      sites: [
        { site: 'owlette:site-7', machines: 12, as_of: NOW },
        { site: 'owlette:site-8', machines: 3, as_of: NOW },
      ],
    });
  });

  it.each([
    'stale',
    'period_rolled_over',
    'period_closed',
    'site_not_found',
    'site_not_billed',
    'product_not_in_key_scope',
    'invalid_site_ref',
    'invalid_machines',
    'invalid_as_of',
  ])('passes the status %s through as not recorded', async (status) => {
    mockTridantFetch.mockResolvedValue(
      answer({ recorded: 0, max: 500, results: [{ site: 'owlette:site-7', status, recorded: false, error: status }] }),
    );
    expect(await reportUsage([{ siteId: 'site-7', machines: 1 }], NOW)).toEqual({
      ok: true,
      results: [{ siteId: 'site-7', status, recorded: false }],
    });
  });

  it('sends 500 entries a call and keeps the outcomes in order', async () => {
    const entries = Array.from({ length: 1200 }, (_, i) => ({ siteId: `s${i}`, machines: i }));
    mockTridantFetch.mockImplementation(async (_path, request) =>
      answer({ results: (request.body as { sites: Array<{ site: string }> }).sites.map(({ site }) => recorded(site)) }),
    );

    const result = await reportUsage(entries, NOW);

    expect(mockTridantFetch).toHaveBeenCalledTimes(3);
    expect([0, 1, 2].map((call) => sitesSent(call).length)).toEqual([500, 500, 200]);
    expect(sitesSent(1)[0].site).toBe('owlette:s500');
    expect(result).toEqual({
      ok: true,
      results: entries.map(({ siteId }) => ({ siteId, status: 'recorded', recorded: true })),
    });
  });

  it('marks a failed chunk and still sends the others', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({ siteId: `s${i}`, machines: 1 }));
    mockTridantFetch
      .mockResolvedValueOnce({ ok: false, reason: 'unreachable', status: 503 })
      .mockResolvedValueOnce(refusal(403, { error: 'missing_scope:billing.write' }))
      .mockResolvedValueOnce(answer({ results: [recorded('owlette:s1000')] }));

    const result = await reportUsage(entries, NOW);

    if (!result.ok) throw new Error('expected per-entry outcomes');
    expect(result.results).toHaveLength(1001);
    expect(result.results[0]).toEqual({ siteId: 's0', status: 'unreachable', recorded: false });
    expect(result.results[499].status).toBe('unreachable');
    expect(result.results[500]).toEqual({ siteId: 's500', status: 'rejected', recorded: false });
    expect(result.results[999].status).toBe('rejected');
    expect(result.results[1000]).toEqual({ siteId: 's1000', status: 'recorded', recorded: true });
  });

  it('marks an entry tridant did not answer for, or answered out of order, as malformed', async () => {
    mockTridantFetch.mockResolvedValue(
      answer({
        results: [
          recorded('owlette:site-8'),
          { site: 'owlette:site-8', status: 'brand_new_status', recorded: false },
        ],
      }),
    );

    expect(
      await reportUsage(
        [
          { siteId: 'site-7', machines: 1 },
          { siteId: 'site-8', machines: 1 },
          { siteId: 'site-9', machines: 1 },
        ],
        NOW,
      ),
    ).toEqual({
      ok: true,
      results: [
        { siteId: 'site-7', status: 'malformed_response', recorded: false },
        { siteId: 'site-8', status: 'malformed_response', recorded: false },
        { siteId: 'site-9', status: 'malformed_response', recorded: false },
      ],
    });
  });

  it('marks a chunk whose answer was not json as malformed', async () => {
    mockTridantFetch.mockResolvedValue({ ok: false, reason: 'malformed_response', status: 200 });
    expect(await reportUsage([{ siteId: 'site-7', machines: 1 }], NOW)).toEqual({
      ok: true,
      results: [{ siteId: 'site-7', status: 'malformed_response', recorded: false }],
    });
  });

  it('fails as a whole when tridant is not configured', async () => {
    mockTridantFetch.mockResolvedValue({ ok: false, reason: 'not_configured' });
    expect(await reportUsage([{ siteId: 'site-7', machines: 1 }], NOW)).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('makes no call for nothing to report', async () => {
    expect(await reportUsage([], NOW)).toEqual({ ok: true, results: [] });
    expect(mockTridantFetch).not.toHaveBeenCalled();
  });
});

describe('pushSite', () => {
  const INPUT = { uid: 'u1', siteId: 'site-7', name: 'Venue A' };

  it('registers the site under the owner', async () => {
    mockTridantFetch.mockResolvedValue(
      answer({ ok: true, created: true, moved: false, site: { id: 'ste_1', name: 'Venue A', org_id: 'org_1' } }, 201),
    );

    expect(await pushSite(INPUT)).toEqual({ ok: true, created: true, moved: false });
    expectCall('POST', '/v1/sites', {
      subject: 'owlette:u1',
      provider: 'owlette',
      external_id: 'site-7',
      name: 'Venue A',
    });
  });

  it('says when the site moved to the new owner', async () => {
    mockTridantFetch.mockResolvedValue(answer({ ok: true, created: false, moved: true, site: {} }));
    expect(await pushSite(INPUT)).toEqual({ ok: true, created: false, moved: true });
  });

  it("carries tridant's reason for a site that cannot move", async () => {
    mockTridantFetch.mockResolvedValue(refusal(409, { error: 'site_belongs_to_another_org', reason: 'site_running' }));
    expect(await pushSite(INPUT)).toEqual({
      ok: false,
      reason: 'rejected',
      status: 409,
      code: 'site_belongs_to_another_org',
      detail: 'site_running',
    });
  });
});

describe('linkAccount and unlinkAccount', () => {
  it('links the subject with the id token as consent', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subject: 'owlette:u1', org_id: 'org_1', linked: true, already: false }));

    expect(await linkAccount({ uid: 'u1', orgId: 'org_1', idToken: ID_TOKEN })).toEqual({ ok: true, already: false });
    expectCall('POST', '/v1/billing/link', { subject: 'owlette:u1', org_id: 'org_1', id_token: ID_TOKEN });
  });

  it('says when the subject was linked already', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subject: 'owlette:u1', org_id: 'org_1', linked: true, already: true }));
    expect(await linkAccount({ uid: 'u1', orgId: 'org_1', idToken: ID_TOKEN })).toEqual({ ok: true, already: true });
  });

  it.each([
    [401, 'id_token_not_fresh'],
    [403, 'owner_required'],
    [409, 'subject_linked_elsewhere'],
  ])('maps %i %s', async (status, code) => {
    mockTridantFetch.mockResolvedValue(refusal(status, { error: code }));
    expect(await linkAccount({ uid: 'u1', orgId: 'org_1', idToken: ID_TOKEN })).toEqual({
      ok: false,
      reason: 'rejected',
      status,
      code,
    });
  });

  it('unlinks by subject', async () => {
    mockTridantFetch.mockResolvedValue(answer({ subject: 'owlette:u1', unlinked: true }));

    expect(await unlinkAccount('u1')).toEqual({ ok: true });
    expectCall('DELETE', '/v1/billing/link/owlette:u1');
  });
});

describe('foundersRemaining', () => {
  const CATALOGUE = {
    products: [
      { id: 'prd_moonshine', founders_limit: 200, founders_remaining: 137 },
      { id: 'prd_owlette_core', founders_limit: 200, founders_remaining: 180 },
      { id: 'prd_owlette_pro', founders_limit: 200, founders_remaining: 0 },
    ],
  };

  it('reads the public catalogue without a key', async () => {
    mockFetch.mockResolvedValue(reply(200, CATALOGUE));

    expect(await foundersRemaining()).toEqual({ ok: true, core: 180, pro: 0 });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api-staging.tridant.io/v1/products');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(mockTridantFetch).not.toHaveBeenCalled();
  });

  it('answers null for a tier with no cap or one tridant does not list', async () => {
    mockFetch.mockResolvedValue(
      reply(200, { products: [{ id: 'prd_owlette_core', founders_limit: null, founders_remaining: null }] }),
    );
    expect(await foundersRemaining()).toEqual({ ok: true, core: null, pro: null });
  });

  it('keeps an answer for five minutes', async () => {
    mockFetch.mockResolvedValue(reply(200, CATALOGUE));

    await foundersRemaining();
    jest.setSystemTime(NOW + 5 * 60_000 - 1);
    await foundersRemaining();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + 5 * 60_000);
    await foundersRemaining();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shares one call between concurrent reads', async () => {
    mockFetch.mockResolvedValue(reply(200, CATALOGUE));
    await Promise.all([foundersRemaining(), foundersRemaining()]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a failure for a minute only', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue(reply(200, CATALOGUE));

    expect(await foundersRemaining()).toEqual({ ok: false, reason: 'unreachable' });
    jest.setSystemTime(NOW + 59_999);
    expect(await foundersRemaining()).toEqual({ ok: false, reason: 'unreachable' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + 60_000);
    expect(await foundersRemaining()).toEqual({ ok: true, core: 180, pro: 0 });
  });

  it.each([
    [503, { ok: false, reason: 'unreachable', status: 503 }],
    [429, { ok: false, reason: 'unreachable', status: 429 }],
    [404, { ok: false, reason: 'rejected', status: 404 }],
  ])('reads a %i as a failure', async (status, expected) => {
    mockFetch.mockResolvedValue(reply(status, { error: 'nope' }));
    expect(await foundersRemaining()).toEqual(expected);
  });

  it.each([
    ['a body that is not json', undefined],
    ['a body without products', { items: [] }],
  ])('reads %s as malformed', async (_name, body) => {
    mockFetch.mockResolvedValue(reply(200, body));
    expect(await foundersRemaining()).toEqual({ ok: false, reason: 'malformed_response', status: 200 });
  });

  it('is not configured without the api url, and makes no call', async () => {
    delete process.env.TRIDANT_API_URL;
    expect(await foundersRemaining()).toEqual({ ok: false, reason: 'not_configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('the e2e fake', () => {
  const PRO_ENT = {
    'owlette.machines': 'unlimited',
    'owlette.sites': 'unlimited',
    'owlette.control': true,
    'owlette.deployments': true,
    'owlette.swoop': true,
    'owlette.hoot': true,
    'owlette.roost': true,
    'owlette.talons': true,
    'owlette.webhooks': true,
    'owlette.api_keys': true,
  };
  const CORE_ENT = {
    'owlette.machines': 'unlimited',
    'owlette.sites': 1,
    'owlette.control': true,
    'owlette.deployments': false,
    'owlette.swoop': false,
    'owlette.hoot': false,
    'owlette.roost': false,
    'owlette.talons': false,
    'owlette.webhooks': false,
    'owlette.api_keys': false,
  };
  const BILLING = { periodStart: MONTH_START, periodEnd: MONTH_END, endsAt: null, cancelAtPeriodEnd: false };
  const calls = () => [...mockStore].filter(([key]) => key.startsWith('e2e_billing_calls/')).map(([, call]) => call);

  beforeEach(() => {
    process.env.OWLETTE_E2E = '1';
  });

  afterEach(() => {
    expect(mockTridantFetch).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('starts a checkout that returns straight to the success url', async () => {
    const started = await startCheckout(CHECKOUT);

    if (!started.ok) throw new Error('expected a checkout');
    expect(started.sessionId).toMatch(/^e2e_[0-9a-f]{16}$/);
    expect(started.checkoutUrl).toBe(
      `https://dev.owlette.app/admin/sites/site-7?section=billing&session_id=${started.sessionId}`,
    );
    expect(mockStore.get(`e2e_billing/${started.sessionId}`)).toEqual({
      uid: 'u1',
      siteId: 'site-7',
      tier: 'pro',
      founders: true,
      createdAt: NOW,
    });
    // nothing is billed until the return is confirmed.
    expect(mockStore.has('e2e_entitlements/site:site-7')).toBe(false);
  });

  it('confirms a checkout by billing the site for this calendar month', async () => {
    const started = await startCheckout(CHECKOUT);
    if (!started.ok) throw new Error('expected a checkout');

    expect(await confirmCheckout(started.sessionId)).toEqual({
      ok: true,
      status: 'complete',
      orgId: 'org_e2e_u1',
      sites: [{ siteId: 'site-7', productId: 'prd_owlette_pro', founders: true, status: 'active', endsAt: null }],
    });
    expect(mockStore.get('e2e_entitlements/site:site-7')).toEqual({
      resolved: true,
      standing: 'active',
      ent: PRO_ENT,
      orgId: 'org_e2e_u1',
      billing: BILLING,
    });
  });

  it('does not know a session it never started', async () => {
    expect(await confirmCheckout('cs_unknown')).toEqual({
      ok: false,
      reason: 'rejected',
      status: 404,
      code: 'checkout_not_found',
    });
  });

  it('adds a site at core', async () => {
    expect(await addSite({ uid: 'u1', siteId: 'site-8', siteName: 'Venue B', tier: 'core', founders: false })).toEqual({
      ok: true,
      already: false,
    });
    expect(mockStore.get('e2e_entitlements/site:site-8')).toEqual({
      resolved: true,
      standing: 'active',
      ent: CORE_ENT,
      orgId: 'org_e2e_u1',
      billing: BILLING,
    });
  });

  it('switches a billed site and keeps its organization and period', async () => {
    await addSite({ uid: 'u1', siteId: 'site-8', siteName: 'Venue B', tier: 'core', founders: false });

    expect(await switchTier('site-8', 'pro')).toEqual({ ok: true });
    expect(mockStore.get('e2e_entitlements/site:site-8')).toEqual({
      resolved: true,
      standing: 'active',
      ent: PRO_ENT,
      orgId: 'org_e2e_u1',
      billing: BILLING,
    });
  });

  it('stops a billed site at the month end', async () => {
    await addSite({ uid: 'u1', siteId: 'site-8', siteName: 'Venue B', tier: 'pro', founders: true });

    expect(await stopSite('site-8')).toEqual({ ok: true, endsAt: MONTH_END });
    expect(mockStore.get('e2e_entitlements/site:site-8')).toMatchObject({
      standing: 'active',
      ent: PRO_ENT,
      billing: { ...BILLING, endsAt: MONTH_END },
    });
  });

  it('refuses to switch or stop a site nobody bills', async () => {
    mockStore.set('e2e_entitlements/site:free', { resolved: false, standing: 'expired', ent: {} });
    const notBilled = { ok: false, reason: 'rejected', status: 404, code: 'site_not_billed' };

    expect(await switchTier('free', 'pro')).toEqual(notBilled);
    expect(await stopSite('free')).toEqual(notBilled);
    expect(await stopSite('never-seen')).toEqual(notBilled);
    expect(mockStore.get('e2e_entitlements/site:free')).toEqual({ resolved: false, standing: 'expired', ent: {} });
  });

  it('starts a 14-day trial', async () => {
    expect(await startTrial({ uid: 'u1', email: EMAIL, name: 'Acme' })).toEqual({
      ok: true,
      orgId: 'org_e2e_u1',
      expiresAt: NOW + 14 * 86_400_000,
      already: false,
    });
  });

  it('asks the accounts the rig lists to link first', async () => {
    mockStore.set('e2e_billing_config/trial', { linkRequired: ['u2'] });

    expect(await startTrial({ uid: 'u2', email: EMAIL, name: 'Acme' })).toEqual({
      ok: false,
      reason: 'rejected',
      status: 409,
      code: 'link_required',
    });
    expect(await startTrial({ uid: 'u1', email: EMAIL, name: 'Acme' })).toMatchObject({ ok: true });
  });

  it('records the calls that leave nothing else behind, without the id token', async () => {
    expect(await pushSite({ uid: 'u1', siteId: 'site-7', name: 'Venue A' })).toEqual({ ok: true, created: true, moved: false });
    expect(await linkAccount({ uid: 'u1', orgId: 'org_1', idToken: ID_TOKEN })).toEqual({ ok: true, already: false });
    expect(await unlinkAccount('u1')).toEqual({ ok: true });
    expect(await reportUsage([{ siteId: 'site-7', machines: 3 }], NOW)).toEqual({
      ok: true,
      results: [{ siteId: 'site-7', status: 'recorded', recorded: true }],
    });

    expect(calls()).toEqual([
      { fn: 'pushSite', uid: 'u1', siteId: 'site-7', name: 'Venue A', at: NOW },
      { fn: 'linkAccount', uid: 'u1', orgId: 'org_1', at: NOW },
      { fn: 'unlinkAccount', uid: 'u1', at: NOW },
      { fn: 'reportUsage', entries: [{ siteId: 'site-7', machines: 3 }], asOfMs: NOW, at: NOW },
    ]);
    expect(JSON.stringify([...mockStore])).not.toContain(ID_TOKEN);
  });

  it('offers founders places', async () => {
    expect(await foundersRemaining()).toEqual({ ok: true, core: 200, pro: 200 });
  });

  it('answers unreachable, and does not throw, when firestore fails', async () => {
    mockFirestoreDown = true;
    const down = { ok: false, reason: 'unreachable' };

    expect(await startCheckout(CHECKOUT)).toEqual(down);
    expect(await confirmCheckout('e2e_1')).toEqual(down);
    expect(await stopSite('site-7')).toEqual(down);
    expect(await startTrial({ uid: 'u1', email: EMAIL, name: 'Acme' })).toEqual(down);
    expect(await pushSite({ uid: 'u1', siteId: 'site-7', name: 'Venue A' })).toEqual(down);
  });
});
