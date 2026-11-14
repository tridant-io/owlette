/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockSeedGet = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockSeedGet }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockCollection }),
}));

import logger from '@/lib/logger';
import {
  __resetForTests,
  getSiteEntitlements,
  invalidateSiteEntitlements,
} from '@/lib/tridantEntitlements.server';

const LICENSE_KEY = 'tid_license_read_key';
const mockFetch = jest.fn();

const FLAGS = [
  'owlette.control',
  'owlette.deployments',
  'owlette.swoop',
  'owlette.hoot',
  'owlette.roost',
  'owlette.talons',
  'owlette.webhooks',
  'owlette.api_keys',
];

// as tridant sends them: flags are booleans, limits numbers or 'unlimited', storage null.
const PRO_ENT = {
  ...Object.fromEntries(FLAGS.map((flag) => [flag, true])),
  'owlette.machines': 'unlimited',
  'owlette.sites': 'unlimited',
  'owlette.storage_bytes': null,
};
const FREE_ENT = {
  ...Object.fromEntries(FLAGS.map((flag) => [flag, false])),
  'owlette.machines': 1,
  'owlette.sites': 1,
  'owlette.storage_bytes': null,
};

// as plan.server.ts reads them.
const PRO_ENT_READ = {
  ...Object.fromEntries(FLAGS.map((flag) => [flag, '1'])),
  'owlette.machines': 'unlimited',
  'owlette.sites': 'unlimited',
};
const FREE_ENT_READ = {
  ...Object.fromEntries(FLAGS.map((flag) => [flag, '0'])),
  'owlette.machines': '1',
  'owlette.sites': '1',
};

const PERIOD_START = Date.UTC(2026, 10, 1);
const PERIOD_END = Date.UTC(2026, 11, 1);

const PRO_SITE = {
  subject: 'owlette:site-1',
  resolved: true,
  org_id: 'org_1',
  site: { id: 'ste_1', name: 'arena', is_default: false },
  billing: {
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    cancel_at_period_end: false,
    ends_at: null,
  },
  license_keys: ['OWLT-AAAAA'],
  standing: 'active',
  in_good_standing: true,
  grace_until: null,
  ent: PRO_ENT,
  ent_epoch: 47,
  resolved_at: '2026-11-11T00:00:00Z',
};

const TRIAL_SITE = { ...PRO_SITE, billing: undefined, standing: 'trialing' };

const UNKNOWN_SITE = {
  subject: 'owlette:site-2',
  resolved: false,
  note: 'no_mapping_for_site',
  standing: 'expired',
  in_good_standing: false,
  grace_until: null,
  ent: FREE_ENT,
  ent_epoch: 47,
  resolved_at: '2026-11-11T00:00:00Z',
};

const LAPSED_SITE = {
  subject: 'owlette:site-3',
  resolved: true,
  org_id: 'org_1',
  site: { id: 'ste_3', name: 'annexe', is_default: false },
  note: 'no_active_licenses',
  standing: 'expired',
  in_good_standing: false,
  grace_until: null,
  ent: FREE_ENT,
  ent_epoch: 47,
  license_keys: [],
  resolved_at: '2026-11-11T00:00:00Z',
};

function reply(status: number, body: unknown, headers?: Record<string, string>) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    ...(headers ? { headers: new Headers(headers) } : {}),
  } as unknown as Response;
}

function seed(data: Record<string, unknown> | undefined) {
  return { exists: data !== undefined, data: () => data };
}

let now = 1_000_000;
let dateNow: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  now = 1_000_000;
  dateNow = jest.spyOn(Date, 'now').mockImplementation(() => now);
  process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
  process.env.TRIDANT_LICENSE_KEY = LICENSE_KEY;
  delete process.env.OWLETTE_E2E;
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  dateNow.mockRestore();
});

afterAll(() => {
  delete process.env.TRIDANT_API_URL;
  delete process.env.TRIDANT_LICENSE_KEY;
});

describe('getSiteEntitlements', () => {
  it('asks tridant for owlette:{siteId} with the license key, and reads a live pro answer', async () => {
    mockFetch.mockResolvedValue(reply(200, PRO_SITE));

    expect(await getSiteEntitlements('site-1')).toEqual({
      ok: true,
      resolved: true,
      standing: 'active',
      inGoodStanding: true,
      graceUntil: null,
      ent: PRO_ENT_READ,
      epoch: 47,
      orgId: 'org_1',
      billing: { periodStart: PERIOD_START, periodEnd: PERIOD_END, endsAt: null, cancelAtPeriodEnd: false },
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api-staging.tridant.io/v1/sites/owlette:site-1/entitlements?app=owlette');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${LICENSE_KEY}`);
  });

  it('encodes the site id into the path', async () => {
    mockFetch.mockResolvedValue(reply(200, PRO_SITE));
    await getSiteEntitlements('a/b?c');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api-staging.tridant.io/v1/sites/owlette:a%2Fb%3Fc/entitlements?app=owlette',
    );
  });

  it('reads a site tridant does not know as resolved:false with the free defaults', async () => {
    mockFetch.mockResolvedValue(reply(200, UNKNOWN_SITE));

    expect(await getSiteEntitlements('site-2')).toEqual({
      ok: true,
      resolved: false,
      standing: 'expired',
      inGoodStanding: false,
      graceUntil: null,
      ent: FREE_ENT_READ,
      epoch: 47,
      orgId: null,
      billing: null,
    });
  });

  it('reads a registered site with no active licenses as free, under its organization', async () => {
    mockFetch.mockResolvedValue(reply(200, LAPSED_SITE));

    expect(await getSiteEntitlements('site-3')).toEqual({
      ok: true,
      resolved: true,
      standing: 'expired',
      inGoodStanding: false,
      graceUntil: null,
      ent: FREE_ENT_READ,
      epoch: 47,
      orgId: 'org_1',
      billing: null,
    });
  });

  it('reads a site under a trial as trialing with no billing period', async () => {
    mockFetch.mockResolvedValue(reply(200, TRIAL_SITE));

    expect(await getSiteEntitlements('site-1')).toMatchObject({
      ok: true,
      standing: 'trialing',
      inGoodStanding: true,
      ent: PRO_ENT_READ,
      orgId: 'org_1',
      billing: null,
    });
  });

  it('carries the end of a billed site that is stopping, and the grace of a past due one', async () => {
    mockFetch.mockResolvedValue(
      reply(200, {
        ...PRO_SITE,
        standing: 'past_due',
        grace_until: PERIOD_END + 1000,
        billing: { ...PRO_SITE.billing, cancel_at_period_end: true, ends_at: PERIOD_END },
      }),
    );

    expect(await getSiteEntitlements('site-1')).toMatchObject({
      standing: 'past_due',
      graceUntil: PERIOD_END + 1000,
      billing: { periodStart: PERIOD_START, periodEnd: PERIOD_END, endsAt: PERIOD_END, cancelAtPeriodEnd: true },
    });
  });

  it('reads a billing period tridant has not filled in yet as nulls', async () => {
    mockFetch.mockResolvedValue(
      reply(200, {
        ...PRO_SITE,
        billing: { current_period_start: null, current_period_end: null, cancel_at_period_end: false, ends_at: null },
      }),
    );

    expect(await getSiteEntitlements('site-1')).toMatchObject({
      billing: { periodStart: null, periodEnd: null, endsAt: null, cancelAtPeriodEnd: false },
    });
  });

  it("keeps 'unlimited', turns counts into strings, and leaves a null value out", async () => {
    mockFetch.mockResolvedValue(
      reply(200, {
        ...PRO_SITE,
        ent: {
          'owlette.sites': 'unlimited',
          'owlette.machines': 25,
          'owlette.storage_bytes': null,
          'owlette.control': '1',
        },
      }),
    );

    const result = await getSiteEntitlements('site-1');
    expect(result).toMatchObject({
      ent: { 'owlette.sites': 'unlimited', 'owlette.machines': '25', 'owlette.control': '1' },
    });
    expect(result.ok && 'owlette.storage_bytes' in result.ent).toBe(false);
  });

  it('reports not_configured without calling out when the url or the key is missing', async () => {
    delete process.env.TRIDANT_API_URL;
    expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'not_configured' });

    __resetForTests();
    process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
    delete process.env.TRIDANT_LICENSE_KEY;
    expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'not_configured' });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports unreachable on a timeout and rejected on a refused key', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'unreachable' });

    mockFetch.mockResolvedValue(reply(401, { error: 'invalid_api_key' }));
    expect(await getSiteEntitlements('site-2')).toEqual({ ok: false, reason: 'rejected' });
  });

  it.each([
    ['a non-object body', [1, 2]],
    ['no ent', { ...PRO_SITE, ent: undefined }],
    ['an ent array', { ...PRO_SITE, ent: ['owlette.control'] }],
    ['no standing', { ...PRO_SITE, standing: undefined }],
    ['a string resolved', { ...PRO_SITE, resolved: 'true' }],
    ['no in_good_standing', { ...PRO_SITE, in_good_standing: undefined }],
  ])('reports malformed_response for %s', async (_label, body) => {
    mockFetch.mockResolvedValue(reply(200, body));
    expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'malformed_response' });
    expect(logger.warn).toHaveBeenCalledWith('[tridant] entitlement answer has an unexpected shape', {
      context: 'tridant',
      data: { siteId: 'site-1' },
    });
  });

  it('leaves out a value it cannot read and keeps the rest', async () => {
    mockFetch.mockResolvedValue(
      reply(200, { ...PRO_SITE, ent: { ...PRO_SITE.ent, 'owlette.theme': { accent: 'red' }, 'owlette.tags': ['a'] } }),
    );
    const result = await getSiteEntitlements('site-1');
    expect(result.ok && result.ent['owlette.control']).toBe('1');
    expect(result.ok && 'owlette.theme' in result.ent).toBe(false);
    expect(result.ok && 'owlette.tags' in result.ent).toBe(false);
  });

  it('names the license key when tridant says it is about to expire', async () => {
    mockFetch.mockResolvedValue(reply(200, PRO_SITE, { Sunset: 'Sat, 12 Dec 2026 00:00:00 GMT' }));
    await getSiteEntitlements('site-1');

    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify((logger.error as jest.Mock).mock.calls);
    expect(logged).toContain('2026-12-12');
    expect(logged).toContain('rotate TRIDANT_LICENSE_KEY');
    expect(logged).not.toContain(LICENSE_KEY);
  });

  describe('cache', () => {
    it('serves a repeat lookup within 60 s from memory, and asks again after', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_SITE));

      await getSiteEntitlements('site-1');
      now += 59_999;
      expect(await getSiteEntitlements('site-1')).toMatchObject({ ok: true, standing: 'active' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      now += 1;
      mockFetch.mockResolvedValue(reply(200, LAPSED_SITE));
      expect(await getSiteEntitlements('site-1')).toMatchObject({ ok: true, standing: 'expired' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('keys by site id', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_SITE));
      await getSiteEntitlements('x');
      await getSiteEntitlements('y');
      await getSiteEntitlements('x');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('shares one call between concurrent lookups', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_SITE));
      const [a, b] = await Promise.all([getSiteEntitlements('site-1'), getSiteEntitlements('site-1')]);
      expect(a).toEqual(b);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('caches a failure for the same 60 s, so an outage is not retried on every request', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      await getSiteEntitlements('site-1');
      now += 30_000;
      expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'unreachable' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('asks again after invalidateSiteEntitlements, for that site only', async () => {
      mockFetch.mockResolvedValue(reply(200, UNKNOWN_SITE));
      await getSiteEntitlements('site-1');
      await getSiteEntitlements('site-2');

      invalidateSiteEntitlements('site-1');
      mockFetch.mockResolvedValue(reply(200, PRO_SITE));
      expect(await getSiteEntitlements('site-1')).toMatchObject({ resolved: true, standing: 'active' });
      expect(await getSiteEntitlements('site-2')).toMatchObject({ resolved: false });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('is emptied by __resetForTests', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_SITE));
      await getSiteEntitlements('site-1');
      __resetForTests();
      await getSiteEntitlements('site-1');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('e2e seam', () => {
    beforeEach(() => {
      process.env.OWLETTE_E2E = '1';
    });

    it('reads e2e_entitlements/site:{siteId} instead of calling tridant', async () => {
      mockSeedGet.mockResolvedValue(
        seed({
          resolved: true,
          standing: 'active',
          ent: PRO_ENT,
          orgId: 'org_e2e_u1',
          billing: { periodStart: PERIOD_START, periodEnd: PERIOD_END, endsAt: null, cancelAtPeriodEnd: false },
        }),
      );

      expect(await getSiteEntitlements('site-1')).toEqual({
        ok: true,
        resolved: true,
        standing: 'active',
        inGoodStanding: true,
        graceUntil: null,
        ent: PRO_ENT_READ,
        epoch: null,
        orgId: 'org_e2e_u1',
        billing: { periodStart: PERIOD_START, periodEnd: PERIOD_END, endsAt: null, cancelAtPeriodEnd: false },
      });
      expect(mockCollection).toHaveBeenCalledWith('e2e_entitlements');
      expect(mockDoc).toHaveBeenCalledWith('site:site-1');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('works without tridant configured, and reads a seed with no billing or organization', async () => {
      delete process.env.TRIDANT_API_URL;
      delete process.env.TRIDANT_LICENSE_KEY;
      mockSeedGet.mockResolvedValue(seed({ resolved: false, standing: 'expired', ent: FREE_ENT }));

      expect(await getSiteEntitlements('site-1')).toEqual({
        ok: true,
        resolved: false,
        standing: 'expired',
        inGoodStanding: false,
        graceUntil: null,
        ent: FREE_ENT_READ,
        epoch: null,
        orgId: null,
        billing: null,
      });
    });

    it.each([
      ['active', true],
      ['trialing', true],
      ['past_due', true],
      ['expired', false],
      ['canceled', false],
    ])('reads standing %s as inGoodStanding %s when the seed leaves it out', async (standing, expected) => {
      mockSeedGet.mockResolvedValue(seed({ resolved: true, standing, ent: PRO_ENT }));
      expect(await getSiteEntitlements('site-1')).toMatchObject({ standing, inGoodStanding: expected });
    });

    it('lets the seed say inGoodStanding itself, for a past due site out of grace', async () => {
      mockSeedGet.mockResolvedValue(
        seed({ resolved: true, standing: 'past_due', inGoodStanding: false, ent: PRO_ENT }),
      );
      expect(await getSiteEntitlements('site-1')).toMatchObject({ standing: 'past_due', inGoodStanding: false });
    });

    it('reports not_configured when no doc is seeded', async () => {
      mockSeedGet.mockResolvedValue(seed(undefined));
      expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'not_configured' });
    });

    it('reads the doc on every call, so a spec can change the plan mid-run', async () => {
      mockSeedGet
        .mockResolvedValueOnce(seed({ resolved: true, standing: 'active', ent: PRO_ENT }))
        .mockResolvedValueOnce(seed({ resolved: false, standing: 'expired', ent: FREE_ENT }));

      expect(await getSiteEntitlements('site-1')).toMatchObject({ ent: { 'owlette.control': '1' } });
      expect(await getSiteEntitlements('site-1')).toMatchObject({ ent: { 'owlette.control': '0' } });
    });

    it('reports malformed_response for a bad seed and unreachable when firestore throws', async () => {
      mockSeedGet.mockResolvedValueOnce(seed({ standing: 'active' }));
      expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'malformed_response' });

      mockSeedGet.mockResolvedValueOnce(
        seed({ resolved: true, standing: 'active', inGoodStanding: 'yes', ent: PRO_ENT }),
      );
      expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'malformed_response' });

      mockSeedGet.mockRejectedValueOnce(new Error('emulator down'));
      expect(await getSiteEntitlements('site-1')).toEqual({ ok: false, reason: 'unreachable' });
    });
  });
});
