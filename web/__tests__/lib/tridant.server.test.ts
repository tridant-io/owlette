/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logger from '@/lib/logger';
import { tridantApiUrl, tridantFetch } from '@/lib/tridant.server';

const KEY = 'tid_live_secret_key';
const mockFetch = jest.fn();

function reply(status: number, body: unknown = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.TRIDANT_API_URL = 'https://api-staging.tridant.io/';
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  delete process.env.TRIDANT_API_URL;
});

describe('tridantApiUrl', () => {
  it('trims whitespace and trailing slashes', () => {
    process.env.TRIDANT_API_URL = '  https://api.tridant.io//  ';
    expect(tridantApiUrl()).toBe('https://api.tridant.io');
  });

  it('is null when unset or blank', () => {
    delete process.env.TRIDANT_API_URL;
    expect(tridantApiUrl()).toBeNull();
    process.env.TRIDANT_API_URL = '   ';
    expect(tridantApiUrl()).toBeNull();
  });
});

describe('tridantFetch', () => {
  it('reports not_configured without calling out when the url is blank', async () => {
    process.env.TRIDANT_API_URL = ' ';
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: false, reason: 'not_configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports not_configured without calling out when the key is blank', async () => {
    expect(await tridantFetch('/v1/x', { key: undefined })).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(await tridantFetch('/v1/x', { key: '  ' })).toEqual({ ok: false, reason: 'not_configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the per-call key as a bearer token with a 5 s timeout', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValue(reply(200, { hello: 'world' }));

    const result = await tridantFetch('/v1/licenses/owlette:u1/entitlements?app=owlette', { key: KEY });

    expect(result).toEqual({ ok: true, status: 200, json: { hello: 'world' } });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api-staging.tridant.io/v1/licenses/owlette:u1/entitlements?app=owlette');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });

  it('sends a json body with the method given', async () => {
    mockFetch.mockResolvedValue(reply(201, { id: 'rel_1' }));

    const result = await tridantFetch('/v1/admin/products/p/releases/import', {
      key: 'release-key',
      method: 'POST',
      body: { version: '4.1.7' },
    });

    expect(result).toEqual({ ok: true, status: 201, json: { id: 'rel_1' } });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer release-key');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ version: '4.1.7' });
  });

  it('answers json null for an empty 2xx', async () => {
    mockFetch.mockResolvedValue(reply(204));
    expect(await tridantFetch('/v1/x', { key: KEY, method: 'PATCH', body: {} })).toEqual({
      ok: true,
      status: 204,
      json: null,
    });
  });

  it('reports unreachable on a timeout or a network failure', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: false, reason: 'unreachable' });

    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports unreachable when the body read fails', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    } as unknown as Response);
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: false, reason: 'unreachable' });
  });

  it('reports a 5xx or 429 as unreachable, with the status', async () => {
    mockFetch.mockResolvedValueOnce(reply(503, 'upstream down'));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({
      ok: false,
      reason: 'unreachable',
      status: 503,
    });

    mockFetch.mockResolvedValueOnce(reply(429, { error: 'rate_limited' }));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({
      ok: false,
      reason: 'unreachable',
      status: 429,
    });
  });

  it('reports any other non-2xx as rejected, carrying the error body', async () => {
    mockFetch.mockResolvedValueOnce(reply(401, { error: 'invalid_api_key' }));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({
      ok: false,
      reason: 'rejected',
      status: 401,
      json: { error: 'invalid_api_key' },
    });

    mockFetch.mockResolvedValueOnce(reply(404, '<html>not found</html>'));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({
      ok: false,
      reason: 'rejected',
      status: 404,
    });
  });

  it('reports malformed_response when a 2xx body is not json', async () => {
    mockFetch.mockResolvedValue(reply(200, '<html>challenge</html>'));
    expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({
      ok: false,
      reason: 'malformed_response',
      status: 200,
    });
  });

  it('logs failures without the key, the body or the query string', async () => {
    mockFetch.mockResolvedValue(reply(403, { error: 'missing_scope', echo: KEY }));
    await tridantFetch('/v1/licenses/owlette:u1/entitlements?app=owlette', { key: KEY });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('missing_scope');
    expect(logged).not.toContain('app=owlette');
    expect(logged).toContain('/v1/licenses/owlette:u1/entitlements');
  });

  it('never throws, even on a body that cannot be serialised', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      tridantFetch('/v1/x', { key: KEY, method: 'POST', body: circular }),
    ).resolves.toEqual({ ok: false, reason: 'unreachable' });
  });

  // the warned names live as long as the process, so each test below warns under its own.
  describe('key expiry', () => {
    function expiring(status: number, body: unknown, sunset = 'Sat, 12 Dec 2026 00:00:00 GMT') {
      return { ...reply(status, body), headers: new Headers({ Sunset: sunset }) } as unknown as Response;
    }

    it('says nothing when no Sunset header comes back, or one that is not a date', async () => {
      mockFetch.mockResolvedValueOnce({ ...reply(200, {}), headers: new Headers() } as unknown as Response);
      expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: true, status: 200, json: {} });

      mockFetch.mockResolvedValueOnce(expiring(200, {}, 'soon'));
      expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: true, status: 200, json: {} });

      expect(logger.error).not.toHaveBeenCalled();
    });

    it('logs the date at error once per process, without the key', async () => {
      mockFetch.mockResolvedValue(expiring(200, { hello: 'world' }));

      expect(await tridantFetch('/v1/x', { key: KEY })).toEqual({ ok: true, status: 200, json: { hello: 'world' } });
      await tridantFetch('/v1/y', { key: KEY });

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        '[tridant] tridant id says this api key expires on 2026-12-12; rotate it before then',
        { context: 'tridant' },
      );
      expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(KEY);
    });

    it('names the env var the caller passes, once per name, also on a refused answer', async () => {
      mockFetch.mockResolvedValue(expiring(401, { error: 'api_key_unbound' }));

      const request = { key: KEY, keyName: 'TRIDANT_LICENSE_KEY' };
      expect(await tridantFetch('/v1/x', request)).toMatchObject({ ok: false, reason: 'rejected', status: 401 });
      await tridantFetch('/v1/x', request);
      await tridantFetch('/v1/x', { key: 'release-key', keyName: 'TRIDANT_RELEASE_KEY' });

      const messages = (logger.error as jest.Mock).mock.calls.map(([message]) => message);
      expect(messages).toEqual([
        '[tridant] tridant id says this api key expires on 2026-12-12; rotate TRIDANT_LICENSE_KEY before then',
        '[tridant] tridant id says this api key expires on 2026-12-12; rotate TRIDANT_RELEASE_KEY before then',
      ]);
      expect(JSON.stringify(messages)).not.toContain(KEY);
    });
  });
});
