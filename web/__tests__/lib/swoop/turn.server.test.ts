/**
 * @jest-environment node
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  TURN_MAX_TTL_SECONDS,
  mintTurnCredentials,
  revokeTurnCredentials,
} from '@/lib/swoop/turn.server';

const ICE_RESPONSE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'user-abc',
      credential: 'cred-abc',
    },
  ],
};

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CLOUDFLARE_TURN_KEY_ID = 'turn-key-1';
  process.env.CLOUDFLARE_TURN_KEY_API_TOKEN = 'turn-token-1';
  global.fetch = mockFetch as unknown as typeof fetch;
});

function ok(body: unknown, status = 201) {
  return { ok: true, status, json: async () => body } as unknown as Response;
}

describe('mintTurnCredentials', () => {
  it('posts to generate-ice-servers with customIdentifier = siteId', async () => {
    mockFetch.mockResolvedValue(ok(ICE_RESPONSE));
    const result = await mintTurnCredentials({ siteId: 'site-a', ttlSeconds: 600 });

    expect(result).toMatchObject({ ok: true, username: 'user-abc' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-1/credentials/generate-ice-servers',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer turn-token-1');
    expect(JSON.parse(init.body)).toEqual({ ttl: 600, customIdentifier: 'site-a' });
  });

  it('clamps the ttl to cloudflare 48 hour ceiling', async () => {
    mockFetch.mockResolvedValue(ok(ICE_RESPONSE));
    await mintTurnCredentials({ siteId: 'site-a', ttlSeconds: 999_999 });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).ttl).toBe(TURN_MAX_TTL_SECONDS);
  });

  it('reports not_configured rather than calling cloudflare unauthenticated', async () => {
    delete process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
    expect(await mintTurnCredentials({ siteId: 'site-a' })).toEqual({
      ok: false,
      reason: 'not_configured',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports rejected on a non-2xx and unreachable on a network failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
    expect(await mintTurnCredentials({ siteId: 'site-a' })).toEqual({
      ok: false,
      reason: 'rejected',
    });

    mockFetch.mockRejectedValue(new Error('timeout'));
    expect(await mintTurnCredentials({ siteId: 'site-a' })).toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('reports malformed_response when no credential comes back', async () => {
    mockFetch.mockResolvedValue(ok({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }));
    expect(await mintTurnCredentials({ siteId: 'site-a' })).toEqual({
      ok: false,
      reason: 'malformed_response',
    });
  });
});

describe('revokeTurnCredentials', () => {
  it('posts the documented revoke path for the username', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204 } as unknown as Response);
    expect(await revokeTurnCredentials('user-abc')).toEqual({ ok: true });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-1/credentials/user-abc/revoke',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer turn-token-1');
  });

  it('treats an already-gone credential as revoked', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    expect(await revokeTurnCredentials('user-abc')).toEqual({ ok: true });
  });

  it('reports unreachable rather than throwing at the caller', async () => {
    mockFetch.mockRejectedValue(new Error('econnreset'));
    expect(await revokeTurnCredentials('user-abc')).toEqual({ ok: false, reason: 'unreachable' });
  });
});
