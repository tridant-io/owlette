/** @jest-environment node */

/**
 * GET /api/auth/tridant/link and /api/auth/tridant/callback — linking an
 * existing tridant account. the oidc library runs for real against a mocked
 * `fetch`, so the sealed cookie makes the whole round trip; the billing client
 * and the plan account writes are mocked. pins who may start the flow, the
 * authorize request, the cookie, every `?link=` outcome, and that no token,
 * code or email reaches a url.
 */

import { NextRequest } from 'next/server';

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

const mockRequireSession = jest.fn();
const mockAssertActiveUser = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
    assertActiveUser: (...a: unknown[]) => mockAssertActiveUser(...a),
  };
});

const mockGetUser = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ getUser: (uid: string) => mockGetUser(uid) }),
  getAdminDb: jest.fn(),
}));

const mockLinkAccount = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  linkAccount: (input: unknown) => mockLinkAccount(input),
}));

const mockCalls: string[] = [];
const mockClearLinkRequired = jest.fn(async (..._a: unknown[]) => void mockCalls.push('clearLinkRequired'));
const mockRecordOrg = jest.fn(async (..._a: unknown[]) => void mockCalls.push('recordOrg'));
jest.mock('@/lib/planAccounts.server', () => ({
  clearLinkRequired: (...a: unknown[]) => mockClearLinkRequired(...a),
  recordOrg: (...a: unknown[]) => mockRecordOrg(...a),
}));

const mockEnsureTrial = jest.fn(async (..._a: unknown[]) => {
  mockCalls.push('ensureTrial');
  return { status: 'started' };
});
jest.mock('@/lib/planTrial.server', () => ({
  ensureTrial: (...a: unknown[]) => mockEnsureTrial(...a),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (event: unknown) => mockEmitMutation(event),
}));

import { GET as link } from '@/app/api/auth/tridant/link/route';
import { GET as callback } from '@/app/api/auth/tridant/callback/route';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { __resetForTests, OIDC_STATE_COOKIE } from '@/lib/tridantOidc.server';

const ISSUER = 'https://id-staging.tridant.io';
const CLIENT_ID = 'oic_testclient';
const AUTHORIZE = `${ISSUER}/oauth/authorize`;
const TOKEN = 'https://api-staging.tridant.io/v1/oidc/token';
const BASE = 'https://dev.owlette.app';
const REDIRECT = `${BASE}/api/auth/tridant/callback`;
const UID = 'uid-1';

type Org = { id: string; name: string; role: string };
const ONE: Org = { id: 'org_one', name: 'Ada Studio', role: 'owner' };
const TWO: Org = { id: 'org_two', name: 'Second Shop', role: 'owner' };
const MEMBER: Org = { id: 'org_member', name: 'Elsewhere', role: 'member' };

const mockFetch = jest.fn();
/** what the token endpoint answers; set per test. */
let tokenReply: () => Promise<Response>;

function reply(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) } as unknown as Response;
}

function idToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(payload)}.c2lnbmF0dXJl`;
}

function get(path: string, cookie?: string): NextRequest {
  return new NextRequest(`${BASE}${path}`, cookie ? { headers: { cookie: `${OIDC_STATE_COOKIE}=${cookie}` } } : undefined);
}

/** runs the link route and answers what the browser would carry to tridant id. */
async function start(query = '') {
  const response = await link(get(`/api/auth/tridant/link${query}`));
  const location = response.headers.get('location');
  if (response.status !== 302 || !location) throw new Error(`link answered ${response.status}`);
  const authorize = new URL(location);
  return {
    response,
    authorize,
    cookie: response.cookies.get(OIDC_STATE_COOKIE)?.value ?? '',
    state: authorize.searchParams.get('state') ?? '',
    nonce: authorize.searchParams.get('nonce') ?? '',
  };
}

/** the token endpoint answers an id token for this flow's nonce. */
function tokenFor(nonce: string, orgs: Org[], over: Record<string, unknown> = {}): string {
  const token = idToken({
    iss: ISSUER,
    sub: 'usr_abc',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce,
    email: 'ada@example.com',
    orgs,
    ...over,
  });
  tokenReply = async () => reply(200, { access_token: 'oat_x', token_type: 'Bearer', id_token: token });
  return token;
}

async function finish(flow: { cookie: string; state: string }, query = 'code=code-1') {
  const response = await callback(get(`/api/auth/tridant/callback?${query}&state=${flow.state}`, flow.cookie));
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  return { response, location, params: Object.fromEntries(location.searchParams) };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  mockCalls.length = 0;
  process.env.TRIDANT_OIDC_ISSUER = ISSUER;
  process.env.TRIDANT_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.TRIDANT_OIDC_CLIENT_SECRET = 'ocs_secret';
  process.env.NEXT_PUBLIC_BASE_URL = BASE;

  mockRequireSession.mockResolvedValue(UID);
  mockAssertActiveUser.mockResolvedValue({});
  mockGetUser.mockResolvedValue({ uid: UID, email: 'ada@example.com', emailVerified: true });
  mockLinkAccount.mockResolvedValue({ ok: true, already: false });

  tokenReply = async () => reply(400, { error: 'invalid_grant' });
  mockFetch.mockImplementation(async (url: string) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return reply(200, { issuer: ISSUER, authorization_endpoint: AUTHORIZE, token_endpoint: TOKEN });
    }
    if (url === TOKEN) return tokenReply();
    throw new Error(`unexpected fetch ${url}`);
  });
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  delete process.env.TRIDANT_OIDC_ISSUER;
  delete process.env.TRIDANT_OIDC_CLIENT_ID;
  delete process.env.TRIDANT_OIDC_CLIENT_SECRET;
  delete process.env.NEXT_PUBLIC_BASE_URL;
});

describe('GET /api/auth/tridant/link', () => {
  it('redirects to the authorize endpoint with pkce, the link scopes and max_age', async () => {
    const { response, authorize } = await start();

    expect(`${authorize.origin}${authorize.pathname}`).toBe(AUTHORIZE);
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid email orgs',
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
      max_age: '600',
    });
    expect(params.state).not.toBe(params.nonce);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sets the state in a __Host- cookie: httpOnly, secure, lax, ten minutes, sealed', async () => {
    const { response, cookie, state } = await start();

    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^__Host-owlette_tridant_oidc=/);
    expect(header).toMatch(/; Path=\/(;|$)/);
    expect(header).toMatch(/; Max-Age=600(;|$)/);
    expect(header).toMatch(/; Secure(;|$)/i);
    expect(header).toMatch(/; HttpOnly(;|$)/i);
    expect(header).toMatch(/; SameSite=lax(;|$)/i);
    expect(header).not.toMatch(/domain=/i);
    expect(cookie).not.toContain(state);
  });

  it('answers 401 without a session, before anything is fetched', async () => {
    mockRequireSession.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));
    const response = await link(get('/api/auth/tridant/link'));
    expect(response.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a start that another site navigated to, and sets no cookie', async () => {
    const request = new NextRequest(`${BASE}/api/auth/tridant/link`, { headers: { 'sec-fetch-site': 'cross-site' } });
    const response = await link(request);

    expect(response.status).toBe(403);
    expect(response.cookies.get(OIDC_STATE_COOKIE)).toBeUndefined();
  });

  it('starts from a same-origin click', async () => {
    const request = new NextRequest(`${BASE}/api/auth/tridant/link`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect((await link(request)).status).toBe(302);
  });

  it('answers 403 for a deleted account and for an unverified email', async () => {
    mockAssertActiveUser.mockRejectedValueOnce(new ApiAuthError(403, 'Forbidden: User is deleted or inactive'));
    expect((await link(get('/api/auth/tridant/link'))).status).toBe(403);

    mockGetUser.mockResolvedValue({ uid: UID, email: 'ada@example.com', emailVerified: false });
    const response = await link(get('/api/auth/tridant/link'));
    expect(response.status).toBe(403);
    expect((await response.json()).detail).toMatch(/verify your email/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('answers a 503 problem when the oidc client is not configured', async () => {
    delete process.env.TRIDANT_OIDC_CLIENT_SECRET;
    const response = await link(get('/api/auth/tridant/link'));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect((await response.json()).code).toBe('tridant_link_not_configured');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('answers 503 and sets no cookie when discovery fails', async () => {
    mockFetch.mockRejectedValue(new Error('down'));
    const response = await link(get('/api/auth/tridant/link'));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('oidc_unreachable');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('GET /api/auth/tridant/callback', () => {
  it('links the one organization the user owns, then retries the trial and audits', async () => {
    const flow = await start();
    const token = tokenFor(flow.nonce, [ONE, MEMBER]);

    const { response, location, params } = await finish(flow);

    expect(`${location.origin}${location.pathname}`).toBe(`${BASE}/settings/plan`);
    expect(params).toEqual({ link: 'done' });
    expect(mockLinkAccount).toHaveBeenCalledWith({ uid: UID, orgId: 'org_one', idToken: token });
    expect(mockCalls).toEqual(['clearLinkRequired', 'recordOrg', 'ensureTrial']);
    expect(mockClearLinkRequired).toHaveBeenCalledWith(UID);
    expect(mockRecordOrg).toHaveBeenCalledWith(UID, 'org_one');
    expect(mockEnsureTrial).toHaveBeenCalledWith(UID);
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'billing_mutated',
      siteId: '',
      actor: `user:${UID}`,
      targetId: UID,
      attributes: {
        endpoint: '/api/auth/tridant/callback',
        method: 'GET',
        verb: 'tridant_account_linked',
        orgId: 'org_one',
        tridantUser: 'usr_abc',
        already: false,
        trial: 'started',
      },
    });

    // the cookie's verifier and the registered redirect uri reach the token endpoint.
    const [, init] = mockFetch.mock.calls.find(([url]) => url === TOKEN) ?? [];
    const form = Object.fromEntries(new URLSearchParams(init.body));
    expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: REDIRECT });
    expect(form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // cleared, with the attributes a __Host- cookie needs to be cleared at all.
    const cleared = response.headers.get('set-cookie') ?? '';
    expect(cleared).toMatch(/^__Host-owlette_tridant_oidc=;/);
    expect(cleared).toMatch(/; Max-Age=0(;|$)/);
    expect(cleared).toMatch(/; Secure(;|$)/i);
    expect(cleared).toMatch(/; Path=\/(;|$)/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns to the path the flow started with, keeping its query and hash', async () => {
    const flow = await start(`?return=${encodeURIComponent('/admin/sites/site-1?tab=billing&link=old#billing')}`);
    tokenFor(flow.nonce, [ONE]);

    const { location, params } = await finish(flow);

    expect(location.pathname).toBe('/admin/sites/site-1');
    expect(location.hash).toBe('#billing');
    expect(params).toEqual({ tab: 'billing', link: 'done' });
  });

  it.each(['//evil.example/x', 'https://evil.example/x', '/\\evil.example'])(
    'never leaves this origin for return=%s',
    async (target) => {
      const flow = await start(`?return=${encodeURIComponent(target)}`);
      tokenFor(flow.nonce, [ONE]);

      const { location } = await finish(flow);

      expect(`${location.origin}${location.pathname}`).toBe(`${BASE}/settings/plan`);
    },
  );

  it('sends the user back to choose when several organizations are owned', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [ONE, TWO, MEMBER]);

    const { params } = await finish(flow);

    expect(params.link).toBe('choose');
    expect(JSON.parse(Buffer.from(params.orgs, 'base64url').toString('utf8'))).toEqual([
      { id: 'org_one', name: 'Ada Studio' },
      { id: 'org_two', name: 'Second Shop' },
    ]);
    expect(Object.keys(params).sort()).toEqual(['link', 'orgs']);
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('links the chosen organization when several are owned', async () => {
    const flow = await start('?org=org_two');
    tokenFor(flow.nonce, [ONE, TWO]);

    const { params } = await finish(flow);

    expect(params).toEqual({ link: 'done' });
    expect(mockLinkAccount).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org_two' }));
    expect(mockRecordOrg).toHaveBeenCalledWith(UID, 'org_two');
  });

  it('never links a chosen organization the user does not own', async () => {
    const flow = await start('?org=org_member');
    tokenFor(flow.nonce, [ONE, TWO, MEMBER]);

    const result = await finish(flow);
    expect(result.params.link).toBe('failed');
    expect(result.params.code).toBe('org_not_owned');
    expect(mockLinkAccount).not.toHaveBeenCalled();
  });

  it('ignores an org that is not an organization id', async () => {
    const flow = await start(`?org=${encodeURIComponent('org_two&x=1')}`);
    tokenFor(flow.nonce, [ONE, TWO]);

    expect((await finish(flow)).params.link).toBe('choose');
  });

  it('answers no_org when the user owns no organization', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [MEMBER]);

    const { params } = await finish(flow);

    expect(params).toEqual({ link: 'no_org' });
    expect(mockLinkAccount).not.toHaveBeenCalled();
  });

  it('fails on a state that is not the cookie state, without redeeming the code', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [ONE]);

    const { params, response } = await finish({ cookie: flow.cookie, state: 'another-state' });

    expect(params).toEqual({ link: 'failed', code: 'state_mismatch' });
    expect(mockFetch.mock.calls.some(([url]) => url === TOKEN)).toBe(false);
    expect(mockLinkAccount).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('fails without the cookie, or with one that does not open', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [ONE]);

    expect((await finish({ cookie: '', state: flow.state })).params).toEqual({ link: 'failed', code: 'state_missing' });
    expect((await finish({ cookie: 'forged', state: flow.state })).params).toEqual({
      link: 'failed',
      code: 'state_missing',
    });
    expect(mockFetch.mock.calls.some(([url]) => url === TOKEN)).toBe(false);
  });

  it('fails when the session is another account, or gone', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [ONE]);

    mockRequireSession.mockResolvedValue('uid-2');
    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'session_mismatch' });

    mockRequireSession.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));
    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'session_mismatch' });

    expect(mockFetch.mock.calls.some(([url]) => url === TOKEN)).toBe(false);
    expect(mockLinkAccount).not.toHaveBeenCalled();
  });

  it("passes on the provider's error, and only as a plain code", async () => {
    const flow = await start();

    expect((await finish(flow, 'error=access_denied')).params).toEqual({ link: 'failed', code: 'access_denied' });
    expect((await finish(flow, `error=${encodeURIComponent('<script>')}`)).params).toEqual({
      link: 'failed',
      code: 'oidc_error',
    });
    expect((await finish(flow, 'x=1')).params).toEqual({ link: 'failed', code: 'code_missing' });
  });

  it('fails with the oauth error when the token endpoint refuses the code', async () => {
    const flow = await start();

    const { params } = await finish(flow);

    expect(params).toEqual({ link: 'failed', code: 'invalid_grant' });
    expect(mockLinkAccount).not.toHaveBeenCalled();
  });

  it('fails when the token endpoint cannot be reached', async () => {
    const flow = await start();
    tokenReply = async () => {
      throw new Error('timeout');
    };

    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'oidc_unreachable' });
  });

  it('never reads an id token minted for another flow or client', async () => {
    const flow = await start();

    tokenFor('another-nonce', [ONE]);
    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'oidc_nonce_mismatch' });
    tokenFor(flow.nonce, [ONE], { aud: 'oic_another' });
    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'oidc_audience_mismatch' });
    expect(mockLinkAccount).not.toHaveBeenCalled();
  });

  it("fails with tridant's code when the sign-in is not fresh, and records nothing", async () => {
    const flow = await start();
    const token = tokenFor(flow.nonce, [ONE]);
    mockLinkAccount.mockResolvedValue({ ok: false, reason: 'rejected', status: 401, code: 'id_token_not_fresh' });

    const { location, params } = await finish(flow);

    expect(params).toEqual({ link: 'failed', code: 'id_token_not_fresh' });
    expect(mockCalls).toEqual([]);
    expect(mockEmitMutation).not.toHaveBeenCalled();
    for (const secret of [token, 'code-1', 'ada@example.com', 'ada%40example.com']) {
      expect(location.toString()).not.toContain(secret);
    }
  });

  it('falls back to the failure reason when tridant gives no code', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [ONE]);
    mockLinkAccount.mockResolvedValue({ ok: false, reason: 'unreachable' });

    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'unreachable' });
  });

  it('answers internal_error when recording the link throws', async () => {
    const flow = await start();
    tokenFor(flow.nonce, [ONE]);
    mockRecordOrg.mockRejectedValueOnce(new Error('firestore down'));

    expect((await finish(flow)).params).toEqual({ link: 'failed', code: 'internal_error' });
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
