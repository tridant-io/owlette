/**
 * Distributed rate limiting via Upstash Redis, with a per-process in-memory
 * fallback when Redis isn't configured.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { NextRequest } from 'next/server';

// Missing credentials are tolerated so local dev works without Redis.
let redis: Redis | null = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('[RateLimit] Upstash Redis initialized');
} else {
  // Not "disabled": every endpoint collapses to the same flat 15/min/identifier
  // budget, per replica — a ~90x loosening for signupRateLimit (10/hr) before
  // you multiply by replica count. Say so plainly.
  console.warn(
    '[RateLimit] Upstash Redis not configured — falling back to a per-process ' +
    'in-memory limiter (15 req/min/identifier, NOT shared across replicas). ' +
    'Per-endpoint limits are not enforced in this mode. ' +
    'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable ' +
    'distributed rate limiting.'
  );
}

/**
 * Whether the Upstash-backed limiter is active; false means the per-process
 * in-memory fallback. Consumed by the startup check in `instrumentation.ts`.
 */
export function isDistributedRateLimitEnabled(): boolean {
  return redis !== null;
}

const isDevEnv = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.includes('-dev');

/** General auth endpoints: 10/min per IP. */
export const authRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '1 m'),
      prefix: 'auth',
      analytics: true,
    })
  : null;

/**
 * Self-serve signup — guards POST /api/users/bootstrap, which creates a
 * `users/{uid}` doc. Deliberately far tighter than the general auth limiter:
 * signups from one IP are rare, so 10/hr blunts a spraying bot without
 * blocking a human onboarding a team. Dev gets 100/hr.
 */
export const signupRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(isDevEnv ? 100 : 10, '1 h'),
      prefix: 'signup',
      analytics: true,
    })
  : null;

/** Token exchange / device code. 60/hr prod — bulk deploys share one IP. Dev 200/hr. */
export const tokenExchangeRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(isDevEnv ? 200 : 60, '1 h'),
      prefix: 'token-exchange',
      analytics: true,
    })
  : null;

/** Token refresh: 120/hr per IP — agents refresh hourly, so ~120 machines per NAT. */
export const tokenRefreshRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(120, '1 h'),
      prefix: 'token-refresh',
      analytics: true,
    })
  : null;

/** Authenticated user operations: 60/hr per user. */
export const userRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(60, '1 h'),
      prefix: 'user-ops',
      analytics: true,
    })
  : null;

/** Agent alerts: 5/hr per IP — a broken agent must not spam email. */
export const agentAlertRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(5, '1 h'),
      prefix: 'agent-alert',
      analytics: true,
    })
  : null;

/** Installer uploads: 5/hr per IP against storage abuse; 30/hr in dev. */
export const uploadRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(isDevEnv ? 30 : 5, '1 h'),
      prefix: 'upload',
      analytics: true,
    })
  : null;

/**
 * Screenshot upload urls: 1000/hr per machine. Keyed on the machine, never the
 * client ip — behind Cloudflare every machine at a site shares the site's NAT
 * egress address. Talon visual checks run at up to one per five seconds per
 * machine (720/hr, `lib/talons/visualCheck.server.ts`) and the fielded agent
 * raises on a 429 with no retry, so the ceiling sits above the fastest
 * legitimate cadence with headroom, and still bounds a stuck capture loop or a
 * leaked machine credential.
 */
export const screenshotUploadRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(1000, '1 h'),
      prefix: 'screenshot-upload',
      analytics: true,
    })
  : null;

/** API key consumers: 300/hr per IP — headroom for CI. */
export const apiRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(300, '1 h'),
      prefix: 'api-ops',
      analytics: true,
    })
  : null;

/** Process alerts: 3/hr per machineId:processName — crash loops must not spam. */
export const processAlertRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(3, '1 h'),
      prefix: 'process-alert',
      analytics: true,
    })
  : null;

/** Display alerts: 1/hr per (machineId, eventType). Drift overrides below. */
export const displayAlertRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(1, '1 h'),
      prefix: 'display-alert',
      analytics: true,
    })
  : null;

/**
 * Drift: 1 per 4h. Drift flaps the most in the field (rack vibration, EDID
 * handshake retries, bad cables); a 1h window still lets one loose cable email
 * the operator six times a day.
 */
export const displayDriftRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.fixedWindow(1, '4 h'),
      prefix: 'display-drift',
      analytics: true,
    })
  : null;

/** Drift gets the 4h window, everything else the 1h default. Null without Redis. */
export function getDisplayAlertRateLimit(eventType: string) {
  return eventType === 'display_drift'
    ? displayDriftRateLimit
    : displayAlertRateLimit;
}

/**
 * Client IP, resistant to header spoofing. Precedence runs from
 * infrastructure-controlled to weakest — only headers a trusted hop overwrites
 * or appends are safe:
 *
 *   1. `CF-Connecting-IP` — rewritten at the Cloudflare edge, so a
 *      client-supplied value never survives. Authoritative in prod.
 *   2. `X-Forwarded-For`, read RIGHT-TO-LEFT: each proxy appends, so the
 *      right-most entry is our own edge's and everything left of it is
 *      client-seeded. Reading left-most let a caller rotate the header to mint
 *      a fresh bucket per request and defeat the per-IP cap (issue #23).
 *   3. `X-Real-IP` / `X-Railway-IP`.
 *   4. `'unknown'` — all such callers share one bucket.
 *
 * The result is shape-clamped (IP charset, <=64 chars) so a hostile header
 * can't become an oversized or injected Redis key.
 */
export function getClientIp(request: NextRequest): string {
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return normalizeIp(cfConnectingIp);
  }

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Right-most = appended by our edge; everything left is client-controlled.
    const ips = forwardedFor.split(',');
    return normalizeIp(ips[ips.length - 1]);
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return normalizeIp(realIp);
  }

  const railwayIp = request.headers.get('x-railway-ip');
  if (railwayIp) {
    return normalizeIp(railwayIp);
  }

  return 'unknown';
}

/**
 * Trim and shape-clamp an IP token to the IPv4/IPv6 charset. 'unknown' for
 * anything else, so a hostile header can't become a Redis key.
 */
function normalizeIp(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[0-9a-fA-F.:]+$/.test(trimmed)) {
    return 'unknown';
  }
  return trimmed.slice(0, 64);
}

/** Per-process fallback when Redis is unavailable. Fixed window, self-cleaning. */
const inMemoryStore = new Map<string, { count: number; resetAt: number }>();
const IN_MEMORY_WINDOW_MS = 60_000; // 1 minute
const IN_MEMORY_MAX_REQUESTS = 15; // per window per identifier

function checkInMemoryRateLimit(identifier: string): {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
} {
  const now = Date.now();
  const entry = inMemoryStore.get(identifier);

  if (!entry || now >= entry.resetAt) {
    const resetAt = now + IN_MEMORY_WINDOW_MS;
    inMemoryStore.set(identifier, { count: 1, resetAt });
    return {
      success: true,
      limit: IN_MEMORY_MAX_REQUESTS,
      remaining: IN_MEMORY_MAX_REQUESTS - 1,
      reset: resetAt,
    };
  }

  entry.count++;
  const remaining = Math.max(0, IN_MEMORY_MAX_REQUESTS - entry.count);
  if (entry.count > IN_MEMORY_MAX_REQUESTS) {
    return {
      success: false,
      limit: IN_MEMORY_MAX_REQUESTS,
      remaining: 0,
      reset: entry.resetAt,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return {
    success: true,
    limit: IN_MEMORY_MAX_REQUESTS,
    remaining,
    reset: entry.resetAt,
  };
}

// Evict expired entries — unbounded growth otherwise.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inMemoryStore) {
    if (now >= entry.resetAt) {
      inMemoryStore.delete(key);
    }
  }
}, 60_000);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

/** Check a limit for `identifier` (IP, user id, ...); falls back to in-memory. */
export async function checkRateLimit(
  ratelimiter: Ratelimit | null,
  identifier: string
): Promise<{
  success: boolean;
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
}> {
  // E2E escape hatch: back-to-back admin calls across specs trip the 15/min
  // in-memory bucket. Set only in playwright.config.ts's webServer env.
  if (process.env.E2E_DISABLE_RATE_LIMIT === 'true') {
    return { success: true };
  }

  if (!ratelimiter) {
    return checkInMemoryRateLimit(identifier);
  }

  try {
    const result = await ratelimiter.limit(identifier);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.success ? undefined : Math.ceil((result.reset - Date.now()) / 1000),
    };
  } catch (error) {
    console.error('[RateLimit] Redis error, falling back to in-memory rate limit:', error);
    // Degrade to in-memory rather than fail open.
    return checkInMemoryRateLimit(identifier);
  }
}

/** 429 reason taxonomy, emitted as the `Roost-Rate-Limited-Reason` header. */
export type RateLimitedReason =
  | 'global-rate'
  | 'endpoint-rate'
  | 'key-rate'
  | 'site-concurrency';

/**
 * Rate limit response headers. Emits both the IETF draft names (`RateLimit-*`)
 * and the legacy `X-RateLimit-*` ones so existing clients keep working.
 * Note the reset units differ: `RateLimit-Reset` is delta-seconds,
 * `X-RateLimit-Reset` is an epoch-ms timestamp.
 */
export function getRateLimitHeaders(result: {
  limit?: number;
  remaining?: number;
  reset?: number;
  retryAfter?: number;
  reason?: RateLimitedReason;
}): Record<string, string> {
  const headers: Record<string, string> = {};

  if (result.limit !== undefined) {
    headers['RateLimit-Limit'] = result.limit.toString();
    headers['X-RateLimit-Limit'] = result.limit.toString();
  }

  if (result.remaining !== undefined) {
    headers['RateLimit-Remaining'] = result.remaining.toString();
    headers['X-RateLimit-Remaining'] = result.remaining.toString();
  }

  if (result.reset !== undefined) {
    const deltaSeconds = Math.max(0, Math.ceil((result.reset - Date.now()) / 1000));
    headers['RateLimit-Reset'] = deltaSeconds.toString();
    headers['X-RateLimit-Reset'] = result.reset.toString();
  }

  if (result.retryAfter !== undefined) {
    headers['Retry-After'] = result.retryAfter.toString();
  }

  if (result.reason) {
    headers['Roost-Rate-Limited-Reason'] = result.reason;
  }

  return headers;
}
