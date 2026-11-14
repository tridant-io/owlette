/**
 * @jest-environment node
 */

/**
 * tridant id as an oidc provider: discovery and its cache, the authorize url,
 * the code exchange, reading an id token without verifying it, the return-path
 * guard, and the sealed state cookie.
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { sealData } from 'iron-session';
import logger from '@/lib/logger';
import {
  __resetForTests,
  buildAuthorizeUrl,
  codeChallengeFor,
  DEFAULT_RETURN_PATH,
  discover,
  exchangeCode,
  oidcConfigured,
  oidcRedirectUri,
  openState,
  randomToken,
  readIdTokenClaims,
  safeReturnPath,
  sealState,
  urlSafeCode,
  type OidcState,
} from '@/lib/tridantOidc.server';

const ISSUER = 'https://id-staging.tridant.io';
const CLIENT_ID = 'oic_testclient';
const CLIENT_SECRET = 'ocs_secret/+value';
const AUTHORIZE = `${ISSUER}/oauth/authorize`;
const TOKEN = 'https://api-staging.tridant.io/v1/oidc/token';
const REDIRECT = 'https://dev.owlette.app/api/auth/tridant/callback';
const NOW = 1_800_000_000_000;

const DISCOVERY = { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN };

const mockFetch = jest.fn();
const mockWarn = logger.warn as jest.Mock;

function reply(status: number, body: unknown = '') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, text: async () => text } as unknown as Response;
}

function idToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(payload)}.c2lnbmF0dXJl`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: 'usr_abc',
  aud: CLIENT_ID,
  exp: NOW / 1000 + 600,
  nonce: 'nonce-1',
  email: 'ada@example.com',
  orgs: [{ id: 'org_one', name: 'Ada Studio', role: 'owner' }],
  ...over,
});

const STATE: OidcState = {
  purpose: 'link',
  state: 'state-1',
  nonce: 'nonce-1',
  verifier: 'verifier-1',
  uid: 'uid-1',
  org: null,
  return: '/settings/plan',
};

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  process.env.TRIDANT_OIDC_ISSUER = `${ISSUER}/`;
  process.env.TRIDANT_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.TRIDANT_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  global.fetch = mockFetch as unknown as typeof fetch;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  delete process.env.TRIDANT_OIDC_ISSUER;
  delete process.env.TRIDANT_OIDC_CLIENT_ID;
  delete process.env.TRIDANT_OIDC_CLIENT_SECRET;
  delete process.env.NEXT_PUBLIC_BASE_URL;
});

describe('oidcConfigured', () => {
  it('needs the issuer, the client id and the secret', () => {
    expect(oidcConfigured()).toBe(true);
    for (const name of ['TRIDANT_OIDC_ISSUER', 'TRIDANT_OIDC_CLIENT_ID', 'TRIDANT_OIDC_CLIENT_SECRET']) {
      const value = process.env[name];
      process.env[name] = '  ';
      expect(oidcConfigured()).toBe(false);
      process.env[name] = value;
    }
  });
});

describe('discover', () => {
  it('reads the issuer discovery document and caches it for ten minutes', async () => {
    mockFetch.mockResolvedValue(reply(200, DISCOVERY));

    const expected = { ok: true, authorizationEndpoint: AUTHORIZE, tokenEndpoint: TOKEN };
    expect(await discover()).toEqual(expected);
    expect(await discover()).toEqual(expected);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(`${ISSUER}/.well-known/openid-configuration`);
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    (Date.now as jest.Mock).mockReturnValue(NOW + 10 * 60_000 + 1);
    await discover();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('is not configured without calling out', async () => {
    delete process.env.TRIDANT_OIDC_CLIENT_SECRET;
    expect(await discover()).toEqual({ ok: false, code: 'oidc_not_configured' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a document from another issuer, and does not cache it', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, { ...DISCOVERY, issuer: 'https://evil.example' }));
    expect(await discover()).toEqual({ ok: false, code: 'oidc_discovery_invalid' });

    mockFetch.mockResolvedValueOnce(reply(200, DISCOVERY));
    expect((await discover()).ok).toBe(true);
  });

  it('refuses an endpoint that is not https', async () => {
    mockFetch.mockResolvedValue(reply(200, { ...DISCOVERY, token_endpoint: 'http://api-staging.tridant.io/v1/oidc/token' }));
    expect(await discover()).toEqual({ ok: false, code: 'oidc_discovery_invalid' });
  });

  it('answers unreachable for a network error, a 5xx and a body that is not json', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    expect(await discover()).toEqual({ ok: false, code: 'oidc_unreachable' });
    mockFetch.mockResolvedValueOnce(reply(503, 'down'));
    expect(await discover()).toEqual({ ok: false, code: 'oidc_unreachable' });
    mockFetch.mockResolvedValueOnce(reply(200, '<html>'));
    expect(await discover()).toEqual({ ok: false, code: 'oidc_discovery_invalid' });
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks for a code with pkce s256, the link scopes and a ten-minute max_age', async () => {
    mockFetch.mockResolvedValue(reply(200, DISCOVERY));

    const built = await buildAuthorizeUrl({
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: 'challenge-1',
      redirectUri: REDIRECT,
    });

    if (!built.ok) throw new Error(built.code);
    const url = new URL(built.url);
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid email orgs',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: 'challenge-1',
      code_challenge_method: 'S256',
      max_age: '600',
    });
    expect(built.url).not.toContain(CLIENT_SECRET);
  });

  it('passes a discovery failure on', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    expect(
      await buildAuthorizeUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: REDIRECT }),
    ).toEqual({ ok: false, code: 'oidc_unreachable' });
  });
});

describe('exchangeCode', () => {
  const input = { code: 'code-1', codeVerifier: 'verifier-1', redirectUri: REDIRECT };

  it('posts the code and the verifier as a form with client_secret_basic, and returns the id token', async () => {
    mockFetch
      .mockResolvedValueOnce(reply(200, DISCOVERY))
      .mockResolvedValueOnce(reply(200, { access_token: 'oat_x', token_type: 'Bearer', id_token: 'a.b.c' }));

    expect(await exchangeCode(input)).toEqual({ ok: true, idToken: 'a.b.c' });

    const [url, init] = mockFetch.mock.calls[1];
    expect(url).toBe(TOKEN);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const basic = Buffer.from(init.headers.Authorization.replace(/^Basic /, ''), 'base64').toString('utf8');
    expect(basic.split(':').map(decodeURIComponent)).toEqual([CLIENT_ID, CLIENT_SECRET]);
    expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
      code_verifier: 'verifier-1',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("answers the provider's oauth error on a refusal, and logs no code, verifier or secret", async () => {
    mockFetch
      .mockResolvedValueOnce(reply(200, DISCOVERY))
      .mockResolvedValueOnce(reply(400, { error: 'invalid_grant' }));

    expect(await exchangeCode(input)).toEqual({ ok: false, code: 'invalid_grant' });
    const logged = JSON.stringify(mockWarn.mock.calls);
    expect(logged).toContain('invalid_grant');
    for (const secret of ['code-1', 'verifier-1', CLIENT_SECRET]) expect(logged).not.toContain(secret);
  });

  it('never passes on an error string that is not a plain code', async () => {
    mockFetch
      .mockResolvedValueOnce(reply(200, DISCOVERY))
      .mockResolvedValueOnce(reply(401, { error: 'Bad Client <script>' }));
    expect(await exchangeCode(input)).toEqual({ ok: false, code: 'token_exchange_failed' });
  });

  it('answers unreachable when the token endpoint cannot be reached', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, DISCOVERY)).mockRejectedValueOnce(new Error('timeout'));
    expect(await exchangeCode(input)).toEqual({ ok: false, code: 'oidc_unreachable' });
  });

  it('answers malformed when a 200 carries no id token', async () => {
    mockFetch.mockResolvedValueOnce(reply(200, DISCOVERY)).mockResolvedValueOnce(reply(200, { access_token: 'oat_x' }));
    expect(await exchangeCode(input)).toEqual({ ok: false, code: 'token_response_malformed' });
  });
});

describe('readIdTokenClaims', () => {
  it('reads sub, email and the organizations from the payload', () => {
    const orgs = [
      { id: 'org_one', name: 'Ada Studio', role: 'owner' },
      { id: 'org_two', name: 'Elsewhere', role: 'member' },
      { id: 'org_bad', role: 'owner' },
      'nonsense',
    ];
    expect(readIdTokenClaims(idToken(claims({ orgs })), 'nonce-1')).toEqual({
      ok: true,
      sub: 'usr_abc',
      email: 'ada@example.com',
      orgs: orgs.slice(0, 2),
    });
  });

  it('reads no organizations when the claim is absent', () => {
    const { orgs: _orgs, email: _email, ...rest } = claims();
    expect(readIdTokenClaims(idToken(rest), 'nonce-1')).toEqual({ ok: true, sub: 'usr_abc', email: null, orgs: [] });
  });

  it.each([
    ['oidc_issuer_mismatch', { iss: 'https://id.tridant.io' }],
    ['oidc_audience_mismatch', { aud: 'oic_another' }],
    ['oidc_audience_mismatch', { aud: [CLIENT_ID, 'oic_another'] }],
    ['oidc_nonce_mismatch', { nonce: 'nonce-2' }],
    ['oidc_nonce_mismatch', { nonce: undefined }],
    ['oidc_id_token_expired', { exp: NOW / 1000 }],
    ['oidc_id_token_expired', { exp: undefined }],
    ['oidc_id_token_malformed', { sub: '' }],
  ])('answers %s for %j', (code, over) => {
    expect(readIdTokenClaims(idToken(claims(over)), 'nonce-1')).toEqual({ ok: false, code });
  });

  it('answers malformed for anything that is not a three-part token with a json payload', () => {
    for (const token of ['', 'a.b', 'a.!!!.c', `a.${Buffer.from('[1]').toString('base64url')}.c`]) {
      expect(readIdTokenClaims(token, 'nonce-1')).toEqual({ ok: false, code: 'oidc_id_token_malformed' });
    }
  });
});

describe('safeReturnPath', () => {
  it.each(['/settings/plan', '/admin/sites/site-1?tab=billing#billing', '/'])('keeps %s', (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    '/ok\\..\\evil',
    'https://evil.example',
    'javascript:alert(1)',
    'settings/plan',
    '/\t/evil.example',
    '/\n/evil.example',
    '/a\u0000b',
    '/a\u007fb',
    '',
    `/${'a'.repeat(512)}`,
    null,
    undefined,
    7,
  ])('falls back to the plan page for %j', (path) => {
    expect(safeReturnPath(path)).toBe(DEFAULT_RETURN_PATH);
  });
});

describe('urlSafeCode', () => {
  it('keeps a plain code and nothing else', () => {
    expect(urlSafeCode('id_token_not_fresh')).toBe('id_token_not_fresh');
    for (const value of ['', 'Access Denied', 'a&b=c', 'x'.repeat(65), null, 4]) expect(urlSafeCode(value)).toBeNull();
  });
});

describe('pkce and the redirect uri', () => {
  it('derives the s256 challenge (rfc 7636 appendix b)', () => {
    expect(codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('makes 256-bit url-safe tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('builds the redirect uri from the configured base url, never a request', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3000/';
    expect(oidcRedirectUri()).toBe('http://localhost:3000/api/auth/tridant/callback');
  });
});

describe('the sealed state', () => {
  it('round-trips', async () => {
    const sealed = await sealState({ ...STATE, org: 'org_one' });
    expect(sealed).not.toContain('verifier-1');
    expect(await openState(sealed)).toEqual({ ...STATE, org: 'org_one' });
  });

  it('refuses a tampered seal and plain nonsense', async () => {
    const sealed = await sealState(STATE);
    const flipped = sealed.slice(0, 80) + (sealed[80] === 'A' ? 'B' : 'A') + sealed.slice(81);
    expect(await openState(flipped)).toBeNull();
    expect(await openState('not-a-seal')).toBeNull();
  });

  it('refuses a seal past its ten minutes', async () => {
    const sealed = await sealState(STATE);
    // iron allows a minute of clock skew on top of the ttl.
    (Date.now as jest.Mock).mockReturnValue(NOW + 11 * 60_000 + 1);
    expect(await openState(sealed)).toBeNull();
  });

  it('refuses a seal made with the session secret itself, so a session cookie is never read as state', async () => {
    const sealed = await sealData(STATE, { password: process.env.SESSION_SECRET as string, ttl: 600 });
    expect(await openState(sealed)).toBeNull();
  });

  it('refuses a seal that is not a link state', async () => {
    const { verifier: _verifier, ...missing } = STATE;
    for (const data of [{ ...STATE, purpose: 'signin' }, missing, { ...STATE, org: 7 }]) {
      expect(await openState(await sealState(data as OidcState))).toBeNull();
    }
  });
});
