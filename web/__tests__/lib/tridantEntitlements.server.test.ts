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

import { __resetForTests, getEntitlements } from '@/lib/tridantEntitlements.server';

const LICENSE_KEY = 'tid_license_read_key';
const mockFetch = jest.fn();

const PRO_ANSWER = {
  subject: 'owlette:u1',
  resolved: true,
  org_id: 'org_1',
  standing: 'active',
  in_good_standing: true,
  grace_until: null,
  ent: { 'owlette.control': '1', 'owlette.machines': 25, 'owlette.sites': 'unlimited' },
  ent_epoch: 7,
  sites: [],
  resolved_at: '2026-10-08T00:00:00Z',
};

const UNMAPPED_ANSWER = {
  subject: 'owlette:u2',
  resolved: false,
  note: 'subject not mapped',
  standing: 'expired',
  in_good_standing: false,
  grace_until: null,
  ent: { 'owlette.control': '0', 'owlette.machines': '1' },
  ent_epoch: 0,
  sites: [],
  resolved_at: '2026-10-08T00:00:00Z',
};

function reply(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text } as unknown as Response;
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

describe('getEntitlements', () => {
  it('asks tridant for owlette:{uid} with the license key', async () => {
    mockFetch.mockResolvedValue(reply(200, PRO_ANSWER));

    expect(await getEntitlements('u1')).toEqual({
      ok: true,
      resolved: true,
      standing: 'active',
      inGoodStanding: true,
      ent: { 'owlette.control': '1', 'owlette.machines': '25', 'owlette.sites': 'unlimited' },
      epoch: 7,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://api-staging.tridant.io/v1/licenses/owlette:u1/entitlements?app=owlette',
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${LICENSE_KEY}`);
  });

  it('passes an unmapped subject through as resolved:false with the defaults', async () => {
    mockFetch.mockResolvedValue(reply(200, UNMAPPED_ANSWER));

    expect(await getEntitlements('u2')).toEqual({
      ok: true,
      resolved: false,
      standing: 'expired',
      inGoodStanding: false,
      ent: { 'owlette.control': '0', 'owlette.machines': '1' },
      epoch: 0,
    });
  });

  it('encodes the uid into the path', async () => {
    mockFetch.mockResolvedValue(reply(200, PRO_ANSWER));
    await getEntitlements('a/b?c');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://api-staging.tridant.io/v1/licenses/owlette:a%2Fb%3Fc/entitlements?app=owlette',
    );
  });

  it('reports not_configured without calling out when the url or the key is missing', async () => {
    delete process.env.TRIDANT_API_URL;
    expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'not_configured' });

    __resetForTests();
    process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io';
    delete process.env.TRIDANT_LICENSE_KEY;
    expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'not_configured' });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports unreachable on a timeout', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports rejected on a refused key', async () => {
    mockFetch.mockResolvedValue(reply(401, { error: 'invalid_api_key' }));
    expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'rejected' });
  });

  it.each([
    ['a non-object body', [1, 2]],
    ['no ent', { ...PRO_ANSWER, ent: undefined }],
    ['an ent array', { ...PRO_ANSWER, ent: ['owlette.control'] }],
    ['an ent value that is not a string or a number', { ...PRO_ANSWER, ent: { 'owlette.control': true } }],
    ['no standing', { ...PRO_ANSWER, standing: undefined }],
    ['a string resolved', { ...PRO_ANSWER, resolved: 'true' }],
    ['no in_good_standing', { ...PRO_ANSWER, in_good_standing: undefined }],
  ])('reports malformed_response for %s', async (_label, body) => {
    mockFetch.mockResolvedValue(reply(200, body));
    expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'malformed_response' });
  });

  it('reads a missing ent_epoch as null', async () => {
    mockFetch.mockResolvedValue(reply(200, { ...PRO_ANSWER, ent_epoch: undefined }));
    expect(await getEntitlements('u1')).toMatchObject({ ok: true, epoch: null });
  });

  describe('cache', () => {
    it('serves a repeat lookup within 60 s from memory, and asks again after', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_ANSWER));

      await getEntitlements('u1');
      now += 59_999;
      expect(await getEntitlements('u1')).toMatchObject({ ok: true, standing: 'active' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      now += 1;
      mockFetch.mockResolvedValue(reply(200, UNMAPPED_ANSWER));
      expect(await getEntitlements('u1')).toMatchObject({ ok: true, standing: 'expired' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('keys by uid', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_ANSWER));
      await getEntitlements('u1');
      await getEntitlements('u2');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('shares one call between concurrent lookups', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_ANSWER));
      const [a, b] = await Promise.all([getEntitlements('u1'), getEntitlements('u1')]);
      expect(a).toEqual(b);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('caches a failure for the same 60 s, so an outage is not retried on every request', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));
      await getEntitlements('u1');
      now += 30_000;
      expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'unreachable' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('is emptied by __resetForTests', async () => {
      mockFetch.mockResolvedValue(reply(200, PRO_ANSWER));
      await getEntitlements('u1');
      __resetForTests();
      await getEntitlements('u1');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('e2e seam', () => {
    beforeEach(() => {
      process.env.OWLETTE_E2E = '1';
    });

    it('reads e2e_entitlements/{uid} instead of calling tridant', async () => {
      mockSeedGet.mockResolvedValue({
        exists: true,
        data: () => ({ resolved: false, standing: 'expired', ent: { 'owlette.control': '0' } }),
      });

      expect(await getEntitlements('u1')).toEqual({
        ok: true,
        resolved: false,
        standing: 'expired',
        inGoodStanding: false,
        ent: { 'owlette.control': '0' },
        epoch: null,
      });
      expect(mockCollection).toHaveBeenCalledWith('e2e_entitlements');
      expect(mockDoc).toHaveBeenCalledWith('u1');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('works without tridant configured', async () => {
      delete process.env.TRIDANT_API_URL;
      delete process.env.TRIDANT_LICENSE_KEY;
      mockSeedGet.mockResolvedValue({
        exists: true,
        data: () => ({ resolved: true, standing: 'trialing', ent: { 'owlette.control': '1' } }),
      });
      expect(await getEntitlements('u1')).toMatchObject({
        ok: true,
        standing: 'trialing',
        inGoodStanding: true,
      });
    });

    it('reports not_configured when no doc is seeded', async () => {
      mockSeedGet.mockResolvedValue({ exists: false, data: () => undefined });
      expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'not_configured' });
    });

    it('reads the doc on every call, so a spec can change the plan mid-run', async () => {
      mockSeedGet
        .mockResolvedValueOnce({
          exists: true,
          data: () => ({ resolved: true, standing: 'active', ent: { 'owlette.control': '1' } }),
        })
        .mockResolvedValueOnce({
          exists: true,
          data: () => ({ resolved: false, standing: 'expired', ent: { 'owlette.control': '0' } }),
        });

      expect(await getEntitlements('u1')).toMatchObject({ ent: { 'owlette.control': '1' } });
      expect(await getEntitlements('u1')).toMatchObject({ ent: { 'owlette.control': '0' } });
    });

    it('reports malformed_response for a bad seed and unreachable when firestore throws', async () => {
      mockSeedGet.mockResolvedValueOnce({ exists: true, data: () => ({ standing: 'active' }) });
      expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'malformed_response' });

      mockSeedGet.mockRejectedValueOnce(new Error('emulator down'));
      expect(await getEntitlements('u1')).toEqual({ ok: false, reason: 'unreachable' });
    });
  });
});
