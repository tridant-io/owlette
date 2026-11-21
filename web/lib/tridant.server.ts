/**
 * tridant id client, shared by plan entitlements and installer releases. the
 * key is passed per call because each job holds its own scoped key
 * (license.read, release.write); only the base url is shared. never throws,
 * never logs a key or a body.
 */

import logger from '@/lib/logger';

const TRIDANT_TIMEOUT_MS = 5000;

/**
 * `unreachable` also covers 429 and 5xx: tridant could not answer, as opposed
 * to `rejected`, where it answered no (key, scope or request). callers that
 * fail open do so on the first and decide for themselves on the second.
 */
export type TridantFailureReason =
  | 'not_configured'
  | 'unreachable'
  | 'rejected'
  | 'malformed_response';

export type TridantFailure = {
  ok: false;
  reason: TridantFailureReason;
  status?: number;
  json?: unknown;
};

export type TridantResult = { ok: true; status: number; json: unknown } | TridantFailure;

export interface TridantRequest {
  /** blank means not configured. */
  key: string | undefined;
  /** the env var `key` came from, so the expiry warning can say which one to rotate. */
  keyName?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** defaults to 5 s. */
  timeoutMs?: number;
}

/** `TRIDANT_API_URL` without a trailing slash, or null when blank. */
export function tridantApiUrl(): string | null {
  return process.env.TRIDANT_API_URL?.trim().replace(/\/+$/, '') || null;
}

/** null when empty, undefined when it is not json. */
function parseBody(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function failed(method: string, path: string, result: TridantFailure): TridantFailure {
  logger.warn('[tridant] request failed', {
    context: 'tridant',
    data: { method, path: path.split('?')[0], status: result.status, reason: result.reason },
  });
  return result;
}

// one warning per key name: each job's key expires on its own date.
const expiryWarned = new Set<string>();

/** tridant sends `Sunset` (rfc 8594) on every answer in a key's last 30 days. */
function warnOfExpiry(sunset: string | null | undefined, keyName: string | undefined): void {
  const expiresAt = Date.parse(sunset ?? '');
  const name = keyName ?? '';
  if (Number.isNaN(expiresAt) || expiryWarned.has(name)) return;
  expiryWarned.add(name);
  // at error because an expired key is refused, and every plan check then fails open.
  logger.error(
    `[tridant] tridant id says this api key expires on ${new Date(expiresAt).toISOString().slice(0, 10)}; rotate ${keyName ?? 'it'} before then`,
    { context: 'tridant' },
  );
}

/**
 * `path` starts with `/`. a rejection carries tridant's parsed error body, so a
 * caller can read its error code.
 */
export async function tridantFetch(path: string, request: TridantRequest): Promise<TridantResult> {
  const base = tridantApiUrl();
  const key = request.key?.trim();
  if (!base || !key) return { ok: false, reason: 'not_configured' };

  const method = request.method ?? 'GET';
  const hasBody = request.body !== undefined;
  let status: number;
  let text: string;
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(request.timeoutMs ?? TRIDANT_TIMEOUT_MS),
    });
    status = response.status;
    // optional, because fetch doubles across the test suite answer without headers.
    warnOfExpiry(response.headers?.get('Sunset'), request.keyName);
    text = await response.text();
  } catch {
    return failed(method, path, { ok: false, reason: 'unreachable' });
  }

  if (status === 429 || status >= 500) {
    return failed(method, path, { ok: false, reason: 'unreachable', status });
  }
  const json = parseBody(text);
  if (status < 200 || status >= 300) {
    return failed(method, path, { ok: false, reason: 'rejected', status, json });
  }
  if (json === undefined) {
    return failed(method, path, { ok: false, reason: 'malformed_response', status });
  }
  return { ok: true, status, json };
}

export type TridantKeyName = 'TRIDANT_LICENSE_KEY' | 'TRIDANT_RELEASE_KEY';

export interface TridantKeyCheck {
  keyName: TridantKeyName;
  /** tridant answered and the key holds every scope owlette needs. */
  ok: boolean;
  /** set when the key's scopes could not be read. */
  reason?: TridantFailureReason;
  /** the required scopes the key lacks; empty when its scopes could not be read. */
  missing: string[];
  expiresAt: number | null;
  expiresInDays: number | null;
}

// tridant grants a product-bound scope across its product's whole group, so a
// trailing `*` here stands for any owlette product.
const REQUIRED_SCOPES: Record<TridantKeyName, string[]> = {
  TRIDANT_LICENSE_KEY: ['license.read', 'site.write', 'billing.write:prd_owlette_*'],
  TRIDANT_RELEASE_KEY: ['release.write:prd_owlette_*'],
};

// a legacy `*` key holds these, and never a product-bound scope.
const WILDCARD_GRANTS = ['license.read', 'license.validate', 'site.write'];

function holds(scopes: string[], required: string): boolean {
  if (required.endsWith('*')) return scopes.some((scope) => scope.startsWith(required.slice(0, -1)));
  return scopes.includes(required) || (scopes.includes('*') && WILDCARD_GRANTS.includes(required));
}

async function checkKey(keyName: TridantKeyName): Promise<TridantKeyCheck> {
  const answer = { keyName, missing: [], expiresAt: null, expiresInDays: null };
  if (process.env.OWLETTE_E2E === '1') return { ...answer, ok: true };

  const response = await tridantFetch('/v1/key', { key: process.env[keyName], keyName });
  if (!response.ok) return { ...answer, ok: false, reason: response.reason };
  const body = typeof response.json === 'object' && response.json !== null ? (response.json as Record<string, unknown>) : {};
  const { scopes, expires_at, expires_in_days } = body;
  if (!Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === 'string')) {
    return { ...answer, ok: false, reason: 'malformed_response' };
  }

  const missing = REQUIRED_SCOPES[keyName].filter((required) => !holds(scopes, required));
  return {
    keyName,
    ok: missing.length === 0,
    missing,
    expiresAt: typeof expires_at === 'number' ? expires_at : null,
    expiresInDays: typeof expires_in_days === 'number' ? expires_in_days : null,
  };
}

/** what tridant id says each of owlette's keys can do, license key first. `GET /v1/key` writes nothing. */
export function checkTridantKeys(): Promise<TridantKeyCheck[]> {
  return Promise.all((Object.keys(REQUIRED_SCOPES) as TridantKeyName[]).map(checkKey));
}
