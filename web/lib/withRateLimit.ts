/**
 * Wraps a Next.js route handler with IP- or user-based rate limiting.
 *
 * ```ts
 * export const POST = withRateLimit(handler, {
 *   strategy: 'auth',  // 'tokenExchange' | 'tokenRefresh' | 'user'
 *   identifier: 'ip',  // 'user' for authenticated endpoints
 * });
 * ```
 */

import type { NextRequest, NextResponse } from 'next/server';
import {
  authRateLimit,
  signupRateLimit,
  tokenExchangeRateLimit,
  tokenRefreshRateLimit,
  userRateLimit,
  agentAlertRateLimit,
  uploadRateLimit,
  apiRateLimit,
  getClientIp,
  checkRateLimit,
  getRateLimitHeaders,
  type RateLimitedReason,
} from './rateLimit';
import { problem, ProblemType } from './apiErrors';

type RateLimitStrategy = 'auth' | 'signup' | 'tokenExchange' | 'tokenRefresh' | 'user' | 'agentAlert' | 'upload' | 'api';
type IdentifierType = 'ip' | 'user';

interface RateLimitOptions {
  strategy: RateLimitStrategy;
  identifier: IdentifierType;
  getUserId?: (request: NextRequest) => Promise<string | null>;
  /** Override the derived reason used in the Roost-Rate-Limited-Reason header. */
  reason?: RateLimitedReason;
}

function reasonFor(strategy: RateLimitStrategy, identifier: IdentifierType): RateLimitedReason {
  if (strategy === 'user' || strategy === 'api') {
    return identifier === 'user' ? 'key-rate' : 'endpoint-rate';
  }
  if (
    strategy === 'auth' ||
    strategy === 'signup' ||
    strategy === 'tokenExchange' ||
    strategy === 'tokenRefresh'
  ) {
    return 'endpoint-rate';
  }
  if (strategy === 'upload' || strategy === 'agentAlert') {
    return 'endpoint-rate';
  }
  return 'global-rate';
}

function requestHasApiKeyCredential(request: NextRequest): boolean {
  const queryOrHeader =
    request.nextUrl.searchParams.get('api_key') ||
    request.headers.get('x-api-key') ||
    null;
  if (queryOrHeader?.startsWith('owk_')) return true;

  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return Boolean(match?.[1]?.startsWith('owk_'));
}

async function getApiKeyRateLimitIdentifier(request: NextRequest): Promise<string | null> {
  if (!requestHasApiKeyCredential(request)) return null;

  try {
    const { resolveApiKeyRateLimitIdentity } = await import('@/lib/apiAuth.server');
    return await resolveApiKeyRateLimitIdentity(request);
  } catch {
    return null;
  }
}

/**
 * The 429 a rate-limited request gets, for the wrapper and for routes that
 * check a limiter inside their handler (after auth has resolved the key).
 */
export function rateLimitedResponse(
  result: Awaited<ReturnType<typeof checkRateLimit>>,
  reason: RateLimitedReason,
): NextResponse {
  const headers = getRateLimitHeaders({ ...result, reason });

  const retryAfter = result.retryAfter ?? 1;
  const message = `Too many requests. Please try again in ${retryAfter} seconds.`;

  return problem(
    {
      type: ProblemType.RateLimited,
      title: 'rate limited',
      status: 429,
      detail: message,
      retryAfter,
      error: 'Rate limit exceeded',
      message,
    },
    headers,
  );
}

/** The counters a request under the limit carries on its own response. */
export function applyRateLimitCounters(
  response: NextResponse,
  result: Awaited<ReturnType<typeof checkRateLimit>>,
): NextResponse {
  // Counters only on success — no Retry-After or reason on 200s.
  const headers = getRateLimitHeaders({
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
  });
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

/**
 * Generic over the extra args Next.js passes the route (e.g. the App-Router
 * `context` with dynamic params); they are forwarded to the handler unchanged.
 */
export function withRateLimit<TArgs extends unknown[]>(
  handler: (request: NextRequest, ...rest: TArgs) => Promise<NextResponse>,
  options: RateLimitOptions
) {
  return async (request: NextRequest, ...rest: TArgs): Promise<NextResponse> => {
    const ratelimiter =
      options.strategy === 'auth' ? authRateLimit :
      options.strategy === 'signup' ? signupRateLimit :
      options.strategy === 'tokenExchange' ? tokenExchangeRateLimit :
      options.strategy === 'tokenRefresh' ? tokenRefreshRateLimit :
      options.strategy === 'user' ? userRateLimit :
      options.strategy === 'agentAlert' ? agentAlertRateLimit :
      options.strategy === 'upload' ? uploadRateLimit :
      options.strategy === 'api' ? apiRateLimit :
      null;

    let identifier: string;
    let usedApiKeyIdentifier = false;

    if (options.identifier === 'ip') {
      const apiKeyIdentifier = options.strategy === 'api'
        ? await getApiKeyRateLimitIdentifier(request)
        : null;
      usedApiKeyIdentifier = !!apiKeyIdentifier;
      identifier = apiKeyIdentifier || getClientIp(request);
    } else if (options.identifier === 'user') {
      if (!options.getUserId) {
        console.error('[RateLimit] getUserId function required for user-based rate limiting');
        identifier = getClientIp(request); // Fallback to IP
      } else {
        const userId = await options.getUserId(request);
        identifier = userId || getClientIp(request); // Fallback to IP if no user
      }
    } else {
      identifier = getClientIp(request);
    }

    const result = await checkRateLimit(ratelimiter, identifier);
    const reason = options.reason ?? (usedApiKeyIdentifier ? 'key-rate' : reasonFor(options.strategy, options.identifier));

    if (!result.success) {
      console.warn(`[RateLimit] Rate limit exceeded for ${options.strategy}:`, identifier);
      return rateLimitedResponse(result, reason);
    }

    return applyRateLimitCounters(await handler(request, ...rest), result);
  };
}

/** getUserId implementation for user-based rate limiting. */
export async function getUserIdFromSession(request: NextRequest): Promise<string | null> {
  try {
    const { getSessionFromRequest } = await import('@/lib/sessionManager.server');
    const session = await getSessionFromRequest(request);
    return session.userId || null;
  } catch {
    // Fall back to IP-based limiting.
    return null;
  }
}
