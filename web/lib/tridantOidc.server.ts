/**
 * tridant id as an openid connect provider, as owlette uses it to link an
 * account to a tridant organization that already exists (plan.md, "link"). the
 * contract is tridant-id `internal-docs/oidc.md`: authorization code, pkce
 * s256, `client_secret_basic` at the token endpoint.
 *
 * the id token is not verified here: tridant id verifies it when it is
 * presented as link consent (`POST /v1/billing/link`), and owlette reads it
 * only to pick the organization. the calls to tridant never throw, and nothing
 * here logs a code, a verifier, a token or an email.
 */

import 'server-only';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sealData, unsealData } from 'iron-session';
import logger from '@/lib/logger';
import { trustedBaseUrl } from '@/lib/resendClient.server';

const OIDC_TIMEOUT_MS = 5000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const SCOPE = 'openid email orgs';
/** tridant accepts an id token as link consent only when the sign-in is this fresh. */
const MAX_AGE_S = 600;

export const OIDC_STATE_COOKIE = '__Host-owlette_tridant_oidc';
const OIDC_STATE_TTL_S = 600;
/** lax, because the callback arrives as a top-level navigation from tridant id. */
export const OIDC_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: OIDC_STATE_TTL_S,
} as const;

/** `code` is safe in a url: an oauth error code or one of this module's own. */
export type OidcFailure = { ok: false; code: string };
export type OidcEndpoints = { authorizationEndpoint: string; tokenEndpoint: string };
export type OidcOrg = { id: string; name: string; role: string };
export type IdTokenClaims = { sub: string; email: string | null; orgs: OidcOrg[] };

/** what the browser carries between the two routes; `purpose` lets a later sign-in share the callback. */
export type OidcState = {
  purpose: 'link';
  state: string;
  nonce: string;
  verifier: string;
  uid: string;
  org: string | null;
  return: string;
};

type OidcConfig = { issuer: string; clientId: string; clientSecret: string };

const NOT_CONFIGURED: OidcFailure = { ok: false, code: 'oidc_not_configured' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function config(): OidcConfig | null {
  const issuer = process.env.TRIDANT_OIDC_ISSUER?.trim().replace(/\/+$/, '');
  const clientId = process.env.TRIDANT_OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.TRIDANT_OIDC_CLIENT_SECRET?.trim();
  return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : null;
}

export function oidcConfigured(): boolean {
  return config() !== null;
}

/** an oauth or tridant error code as it may appear in a url, or null. */
export function urlSafeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

function failed(step: string, code: string, status?: number): OidcFailure {
  logger.warn('[tridant] oidc request failed', { context: 'tridant', data: { step, code, status } });
  return { ok: false, code };
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const json: unknown = JSON.parse(await response.text());
    return isRecord(json) ? json : {};
  } catch {
    return {};
  }
}

let discovered: { issuer: string; expiresAt: number; endpoints: OidcEndpoints } | null = null;

async function load(): Promise<{ ok: true; oidc: OidcConfig; endpoints: OidcEndpoints } | OidcFailure> {
  const oidc = config();
  if (!oidc) return NOT_CONFIGURED;
  if (discovered && discovered.issuer === oidc.issuer && discovered.expiresAt > Date.now()) {
    return { ok: true, oidc, endpoints: discovered.endpoints };
  }

  let status: number;
  let doc: Record<string, unknown>;
  try {
    const response = await fetch(`${oidc.issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
    status = response.status;
    doc = await readJson(response);
  } catch {
    return failed('discovery', 'oidc_unreachable');
  }
  if (status < 200 || status >= 300) return failed('discovery', 'oidc_unreachable', status);

  const authorizationEndpoint = httpsUrl(doc.authorization_endpoint);
  const tokenEndpoint = httpsUrl(doc.token_endpoint);
  // the client secret goes to the token endpoint this document names, so it must be the configured issuer's.
  if (doc.issuer !== oidc.issuer || !authorizationEndpoint || !tokenEndpoint) {
    return failed('discovery', 'oidc_discovery_invalid', status);
  }

  const endpoints = { authorizationEndpoint, tokenEndpoint };
  discovered = { issuer: oidc.issuer, expiresAt: Date.now() + DISCOVERY_TTL_MS, endpoints };
  return { ok: true, oidc, endpoints };
}

/** the provider's endpoints, cached for ten minutes. */
export async function discover(): Promise<({ ok: true } & OidcEndpoints) | OidcFailure> {
  const loaded = await load();
  return loaded.ok ? { ok: true, ...loaded.endpoints } : loaded;
}

/** must equal a redirect uri registered for the client, so it never follows the Host header. */
export const oidcRedirectUri = () => `${trustedBaseUrl().replace(/\/+$/, '')}/api/auth/tridant/callback`;

export const DEFAULT_RETURN_PATH = '/settings/plan';

/**
 * the open-redirect guard for `return`: a path on this origin, or the plan
 * page. one leading slash only, and no backslash or control character, which
 * browsers read as a slash or drop.
 */
export function safeReturnPath(value: unknown): string {
  return typeof value === 'string' && value.length <= 512 && /^\/(?!\/)[^\\\p{Cc}]*$/u.test(value)
    ? value
    : DEFAULT_RETURN_PATH;
}

export const randomToken = () => randomBytes(32).toString('base64url');

/** the s256 challenge for a pkce verifier. */
export const codeChallengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export async function buildAuthorizeUrl(input: {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}): Promise<{ ok: true; url: string } | OidcFailure> {
  const loaded = await load();
  if (!loaded.ok) return loaded;
  const url = new URL(loaded.endpoints.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: loaded.oidc.clientId,
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    max_age: String(MAX_AGE_S),
  }).toString();
  return { ok: true, url: url.toString() };
}

/** redeems the code. on a refusal `code` is the provider's oauth error (`invalid_grant`, `invalid_client`). */
export async function exchangeCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ ok: true; idToken: string } | OidcFailure> {
  const loaded = await load();
  if (!loaded.ok) return loaded;
  const { oidc, endpoints } = loaded;
  // rfc 6749 2.3.1: each half is url-encoded before the base64.
  const basic = Buffer.from(
    `${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`,
  ).toString('base64');

  let status: number;
  let body: Record<string, unknown>;
  try {
    const response = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
    status = response.status;
    body = await readJson(response);
  } catch {
    return failed('token', 'oidc_unreachable');
  }

  if (status < 200 || status >= 300) {
    return failed('token', urlSafeCode(body.error) ?? 'token_exchange_failed', status);
  }
  if (typeof body.id_token !== 'string' || !body.id_token) {
    return failed('token', 'token_response_malformed', status);
  }
  return { ok: true, idToken: body.id_token };
}

function readOrgs(value: unknown): OidcOrg[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.role === 'string'
      ? [{ id: entry.id, name: entry.name, role: entry.role }]
      : [],
  );
}

/**
 * the payload of an id token this client just received, unverified: the
 * signature is tridant id's to check. `iss`, `aud`, `nonce` and `exp` are
 * checked so a token from another flow or client is never read.
 */
export function readIdTokenClaims(idToken: string, nonce: string): ({ ok: true } & IdTokenClaims) | OidcFailure {
  const oidc = config();
  if (!oidc) return NOT_CONFIGURED;

  const parts = idToken.split('.');
  let payload: unknown = null;
  if (parts.length === 3) {
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      // not json: malformed below
    }
  }
  if (!isRecord(payload) || typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, code: 'oidc_id_token_malformed' };
  }
  if (payload.iss !== oidc.issuer) return { ok: false, code: 'oidc_issuer_mismatch' };
  if (payload.aud !== oidc.clientId) return { ok: false, code: 'oidc_audience_mismatch' };
  if (payload.nonce !== nonce) return { ok: false, code: 'oidc_nonce_mismatch' };
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
    return { ok: false, code: 'oidc_id_token_expired' };
  }
  return {
    ok: true,
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    orgs: readOrgs(payload.orgs),
  };
}

// iron-session seals the session cookie with SESSION_SECRET (aes-256-cbc,
// hmac-sha256). this cookie uses a key derived from it, so its seal can never
// be read as a session, nor a session as this.
function statePassword(): string {
  return createHmac('sha256', process.env.SESSION_SECRET as string)
    .update('owlette-tridant-oidc-state-v1')
    .digest('base64url');
}

export function sealState(state: OidcState): Promise<string> {
  return sealData(state, { password: statePassword(), ttl: OIDC_STATE_TTL_S });
}

/** null for a cookie that is forged, expired, or not this flow's. */
export async function openState(sealed: string): Promise<OidcState | null> {
  try {
    const data = await unsealData<Partial<OidcState>>(sealed, { password: statePassword(), ttl: OIDC_STATE_TTL_S });
    const { purpose, state, nonce, verifier, uid, org, return: returnPath } = data;
    if (
      purpose !== 'link' ||
      typeof state !== 'string' || !state ||
      typeof nonce !== 'string' || !nonce ||
      typeof verifier !== 'string' || !verifier ||
      typeof uid !== 'string' || !uid ||
      typeof returnPath !== 'string' || !returnPath ||
      (org !== null && typeof org !== 'string')
    ) {
      return null;
    }
    return { purpose, state, nonce, verifier, uid, org, return: returnPath };
  } catch {
    return null;
  }
}

export function __resetForTests(): void {
  discovered = null;
}
