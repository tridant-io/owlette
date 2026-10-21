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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
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
      signal: AbortSignal.timeout(TRIDANT_TIMEOUT_MS),
    });
    status = response.status;
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
