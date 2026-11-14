/**
 * Centralized API error responses in the public problem+json envelope.
 * Sanitizes messages in production (Firebase internals, stack traces,
 * third-party details) and stays verbose in development. The `error` extension
 * is a transitional alias for dashboard callers that still read it.
 */
import type { NextResponse } from 'next/server';
import { handleError } from './errorHandler';
import { mfaChallengeProblem, problem, ProblemType, type ProblemTypeUri } from './apiErrors';

/**
 * @param context Short label for log/Sentry context (e.g. 'agent/auth/refresh')
 * @param status  HTTP status code (default 500)
 */
export function apiError(
  error: unknown,
  context?: string,
  status = 500,
): NextResponse {
  const refused = mfaChallengeProblem(error);
  if (refused) return refused;
  const message = handleError(error, context);
  return problem({
    type: problemTypeForStatus(status),
    title: problemTitleForStatus(status),
    status,
    detail: message,
    instance: context,
    error: message,
  });
}

function problemTypeForStatus(status: number): ProblemTypeUri {
  switch (status) {
    case 400:
      return ProblemType.ValidationFailed;
    case 401:
      return ProblemType.Unauthorized;
    case 403:
      return ProblemType.Forbidden;
    case 404:
      return ProblemType.NotFound;
    case 409:
      return ProblemType.Conflict;
    case 412:
      return ProblemType.PreconditionFailed;
    case 413:
      return ProblemType.PayloadTooLarge;
    case 429:
      return ProblemType.RateLimited;
    case 503:
      return ProblemType.ServiceUnavailable;
    default:
      return status >= 500 ? ProblemType.Internal : ProblemType.ValidationFailed;
  }
}

function problemTitleForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'validation failed';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not found';
    case 409:
      return 'conflict';
    case 412:
      return 'precondition failed';
    case 413:
      return 'payload too large';
    case 429:
      return 'rate limited';
    case 503:
      return 'service unavailable';
    default:
      return status >= 500 ? 'internal error' : 'request failed';
  }
}
