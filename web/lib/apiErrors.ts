/**
 * RFC 7807 problem+json envelope for public API routes — type URIs, stable
 * codes, docs links, and a requestId for trace correlation.
 * https://datatracker.ietf.org/doc/html/rfc7807
 */
import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

/** Public identifiers clients switch on — keep stable across versions. */
export const ProblemType = {
  ValidationFailed: 'https://owlette.app/problems/validation-failed',
  Unauthorized: 'https://owlette.app/problems/unauthorized',
  Forbidden: 'https://owlette.app/problems/forbidden',
  ScopeInsufficient: 'https://owlette.app/problems/scope-insufficient',
  TokenExpired: 'https://owlette.app/problems/token-expired',
  NotFound: 'https://owlette.app/problems/not-found',
  Conflict: 'https://owlette.app/problems/conflict',
  PreconditionFailed: 'https://owlette.app/problems/precondition-failed',
  PayloadTooLarge: 'https://owlette.app/problems/payload-too-large',
  RateLimited: 'https://owlette.app/problems/rate-limited',
  QuotaExceeded: 'https://owlette.app/problems/quota-exceeded',
  PlanRequired: 'https://owlette.app/problems/plan-required',
  Internal: 'https://owlette.app/problems/internal-error',
  ServiceUnavailable: 'https://owlette.app/problems/service-unavailable',
} as const;

export type ProblemTypeUri = typeof ProblemType[keyof typeof ProblemType];

const PROBLEM_CODES: Record<ProblemTypeUri, string> = {
  [ProblemType.ValidationFailed]: 'validation_failed',
  [ProblemType.Unauthorized]: 'unauthorized',
  [ProblemType.Forbidden]: 'forbidden',
  [ProblemType.ScopeInsufficient]: 'scope_insufficient',
  [ProblemType.TokenExpired]: 'token_expired',
  [ProblemType.NotFound]: 'not_found',
  [ProblemType.Conflict]: 'conflict',
  [ProblemType.PreconditionFailed]: 'precondition_failed',
  [ProblemType.PayloadTooLarge]: 'payload_too_large',
  [ProblemType.RateLimited]: 'rate_limited',
  [ProblemType.QuotaExceeded]: 'quota_exceeded',
  [ProblemType.PlanRequired]: 'plan_required',
  [ProblemType.Internal]: 'internal_error',
  [ProblemType.ServiceUnavailable]: 'service_unavailable',
};

function isKnownProblemType(type: string): type is ProblemTypeUri {
  return Object.prototype.hasOwnProperty.call(PROBLEM_CODES, type);
}

function docsUrlForCode(code: string): string {
  return `https://owlette.app/docs/api/errors#${code}`;
}

export interface ProblemDetails {
  /** absolute URI identifying the problem type. SHOULD be dereferenceable to docs. */
  type: ProblemTypeUri | string;
  /** short, human-readable summary. SHOULD NOT change between occurrences. */
  title: string;
  /** HTTP status code, mirrored in the response status. */
  status: number;
  /** human-readable explanation specific to this occurrence. */
  detail?: string;
  /** URI reference identifying the specific occurrence. */
  instance?: string;
  /** correlation id for log/trace lookup. */
  requestId?: string;
  /** stable machine-readable code for client branching. */
  code?: string;
  /** public documentation anchor for this error code. */
  docsUrl?: string;
  /** field-level errors when status=400/422; key is dotted JSON path. */
  errors?: Record<string, string[]>;
  /** any additional implementation-specific fields. */
  [key: string]: unknown;
}

/** Build the RFC 7807 response, Content-Type `application/problem+json`. */
export function problem(details: ProblemDetails, headers?: HeadersInit): NextResponse {
  // Not `??`: an empty-string requestId would become an invalid `X-Request-Id: ''`.
  const callerRid = typeof details.requestId === 'string' && details.requestId.length > 0
    ? details.requestId
    : undefined;
  const requestId = callerRid ?? crypto.randomUUID();
  const code = typeof details.code === 'string' && details.code.length > 0
    ? details.code
    : isKnownProblemType(details.type)
      ? PROBLEM_CODES[details.type]
      : undefined;
  const docsUrl = typeof details.docsUrl === 'string' && details.docsUrl.length > 0
    ? details.docsUrl
    : code
      ? docsUrlForCode(code)
      : undefined;
  const body = { ...details, ...(code ? { code } : {}), ...(docsUrl ? { docsUrl } : {}), requestId };

  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/problem+json; charset=utf-8');
  responseHeaders.set('X-Request-Id', requestId);

  return new NextResponse(JSON.stringify(body), {
    status: details.status,
    headers: responseHeaders,
  });
}

/**
 * Wrap an unexpected error into a generic 500. Deliberately does NOT forward
 * the message: v1's `handleError()` mapping leaks error categories
 * ("permission-denied" vs "not-found") that confirm resource existence. Log +
 * Sentry server-side, hand the client a requestId to quote.
 *
 * Known categories (validation, auth, quota) should call `problem()` directly
 * — their detail is safe to surface.
 */
export function problemFromError(
  err: unknown,
  context: string,
  status = 500,
): NextResponse {
  // Server-side only; never surfaces to the client.
  if (err instanceof Error) {
    Sentry.captureException(err, { tags: { context, surface: 'v2-api' } });
    console.error(`[v2-api error - ${context}]`, err.message, err.stack);
  } else {
    Sentry.captureMessage(`non-error thrown: ${String(err).slice(0, 200)}`, {
      tags: { context, surface: 'v2-api' },
    });
    console.error(`[v2-api non-error - ${context}]`, err);
  }
  return problem({
    type: ProblemType.Internal,
    title: 'internal error',
    status,
    detail: 'an internal error occurred. quote the requestId when contacting support.',
    instance: context,
  });
}

export function problemValidation(detail: string, errors?: Record<string, string[]>): NextResponse {
  return problem({
    type: ProblemType.ValidationFailed,
    title: 'validation failed',
    status: 400,
    detail,
    errors,
  });
}

export function problemUnauthorized(detail = 'authentication required'): NextResponse {
  return problem({
    type: ProblemType.Unauthorized,
    title: 'unauthorized',
    status: 401,
    detail,
  });
}

export function problemForbidden(detail = 'access denied'): NextResponse {
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    detail,
  });
}

export function problemNotFound(detail = 'resource not found'): NextResponse {
  return problem({
    type: ProblemType.NotFound,
    title: 'not found',
    status: 404,
    detail,
  });
}

export function problemRateLimited(
  retryAfterSeconds: number,
  detail?: string,
  headers?: HeadersInit,
): NextResponse {
  // Clamp to [1, 3600]s: 1 means "retry now", the cap catches garbage input.
  const safe = Math.max(1, Math.min(3600, Math.floor(retryAfterSeconds || 0)));
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Retry-After', String(safe));
  return problem(
    {
      type: ProblemType.RateLimited,
      title: 'rate limited',
      status: 429,
      detail: detail ?? `try again in ${safe} seconds`,
      retryAfter: safe,
    },
    responseHeaders,
  );
}

export function problemQuotaExceeded(detail: string, upgradeUrl?: string): NextResponse {
  return problem({
    type: ProblemType.QuotaExceeded,
    title: 'storage quota exceeded',
    status: 402,
    detail,
    ...(upgradeUrl ? { upgradeUrl } : {}),
  });
}

/**
 * the payer's plan lacks `entitlement`, a tridant key such as `owlette.control`
 * (plan.md decision 5). agent routes never answer this: agents read `error`.
 */
export function problemPlanRequired(detail: string, entitlement: string): NextResponse {
  return problem({
    type: ProblemType.PlanRequired,
    title: 'plan required',
    status: 402,
    detail,
    entitlement,
    upgradeUrl: '/settings/plan',
  });
}

export function problemScopeInsufficient(
  detail: string,
  required: { resource: string; id: string; permission: string },
): NextResponse {
  return problem({
    type: ProblemType.ScopeInsufficient,
    title: 'insufficient scope',
    status: 403,
    detail,
    code: 'scope_insufficient',
    required,
  });
}

export function problemTokenExpired(expiredAt?: number, detail?: string): NextResponse {
  return problem({
    type: ProblemType.TokenExpired,
    title: 'token expired',
    status: 401,
    detail: detail ?? 'the api key has expired; rotate or create a new key',
    code: 'token_expired',
    ...(typeof expiredAt === 'number' ? { expiredAt } : {}),
  });
}

