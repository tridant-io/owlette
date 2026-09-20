/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { killSession, ringDoorbell } from '@/lib/swoop/signal.server';

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SWOOP_SIGNAL_URL = 'https://swoop-signal.example.workers.dev/';
  process.env.SWOOP_SIGNAL_RING_SECRET = 'ring-secret-test-only';
  global.fetch = mockFetch as unknown as typeof fetch;
});

function status(code: number, body?: unknown) {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body ?? {},
  } as unknown as Response;
}

describe('ringDoorbell', () => {
  it('posts a sid and nothing else, authenticated by the shared secret', async () => {
    mockFetch.mockResolvedValue(status(200));
    expect(await ringDoorbell({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' })).toEqual({
      ok: true,
    });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://swoop-signal.example.workers.dev/v1/ring');
    expect(init.method).toBe('POST');
    expect(init.headers['x-swoop-ring-secret']).toBe('ring-secret-test-only');
    // The whole point of the sid-only contract: no bundle, no jwt, no key, no
    // turn credential, no viewer id, no uid — a deep comparison so a future
    // field addition fails here.
    expect(JSON.parse(init.body)).toEqual({ site: 'site-a', machine: 'machine-x', sid: 'sid-1' });
  });

  it('never puts the secret in the url or the body', async () => {
    mockFetch.mockResolvedValue(status(200));
    await ringDoorbell({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).not.toContain('ring-secret-test-only');
    expect(init.body).not.toContain('ring-secret-test-only');
  });

  it('reports not_configured without calling out', async () => {
    delete process.env.SWOOP_SIGNAL_RING_SECRET;
    expect(await ringDoorbell({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' })).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'no_doorbell'],
    [409, 'no_doorbell'],
    [500, 'rejected'],
  ])('maps %i to the typed failure %s', async (code, reason) => {
    mockFetch.mockResolvedValue(status(code));
    expect(await ringDoorbell({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' })).toEqual({
      ok: false,
      reason,
    });
  });

  it('carries retryAfterMs off the ring cap', async () => {
    mockFetch.mockResolvedValue(status(429, { code: 'ring_capped', retryAfterMs: 4200 }));
    expect(await ringDoorbell({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' })).toEqual({
      ok: false,
      reason: 'ring_capped',
      retryAfterMs: 4200,
    });
  });

  it('is unreachable rather than a 500 when the worker is down', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    expect(await ringDoorbell({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });
});

describe('killSession', () => {
  it('posts to /v1/kill with the sid', async () => {
    mockFetch.mockResolvedValue(status(200));
    expect(await killSession({ siteId: 'site-a', machineId: 'machine-x', sid: 'sid-1' })).toEqual({
      ok: true,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://swoop-signal.example.workers.dev/v1/kill');
    expect(JSON.parse(init.body)).toEqual({ site: 'site-a', machine: 'machine-x', sid: 'sid-1' });
  });

  it('omits the sid entirely when the caller means "kill whatever is running"', async () => {
    mockFetch.mockResolvedValue(status(200));
    await killSession({ siteId: 'site-a', machineId: 'machine-x' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      site: 'site-a',
      machine: 'machine-x',
    });
  });
});
