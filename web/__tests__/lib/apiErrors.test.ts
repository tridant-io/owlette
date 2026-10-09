/**
 * @jest-environment node
 *
 * tests for the rfc 7807 problem+json error envelope used by /api/v2/* routes.
 */
import {
  problem,
  problemFromError,
  problemValidation,
  problemUnauthorized,
  problemForbidden,
  problemNotFound,
  problemRateLimited,
  problemQuotaExceeded,
  problemPlanRequired,
  ProblemType,
} from '@/lib/apiErrors';

// suppress sentry + console noise from problemFromError tests
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

describe('apiErrors (rfc 7807 problem+json)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  async function readResponse(res: Response): Promise<{
    status: number;
    contentType: string | null;
    requestId: string | null;
    body: Record<string, unknown>;
  }> {
    return {
      status: res.status,
      contentType: res.headers.get('Content-Type'),
      requestId: res.headers.get('X-Request-Id'),
      body: await res.json(),
    };
  }

  describe('problem()', () => {
    it('produces application/problem+json content type', () => {
      const res = problem({
        type: ProblemType.ValidationFailed,
        title: 'oops',
        status: 400,
      });
      expect(res.headers.get('Content-Type')).toBe(
        'application/problem+json; charset=utf-8',
      );
    });

    it('mirrors status into both response and body', async () => {
      const res = problem({ type: ProblemType.NotFound, title: 'gone', status: 404 });
      const { status, body } = await readResponse(res);
      expect(status).toBe(404);
      expect(body.status).toBe(404);
    });

    it('auto-generates a requestId via crypto.randomUUID() if not provided', async () => {
      const res = problem({ type: ProblemType.Internal, title: 'oops', status: 500 });
      const { requestId, body } = await readResponse(res);
      expect(requestId).toBeTruthy();
      expect(body.requestId).toBe(requestId);
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('preserves a caller-provided requestId', async () => {
      const res = problem({
        type: ProblemType.Internal,
        title: 'oops',
        status: 500,
        requestId: 'caller-provided-id-123',
      });
      const { requestId, body } = await readResponse(res);
      expect(requestId).toBe('caller-provided-id-123');
      expect(body.requestId).toBe('caller-provided-id-123');
    });

    it('falls back to auto-generated when caller passes empty-string requestId', async () => {
      // bug fix: previously `??` allowed '' to slip through, producing
      // an invalid `X-Request-Id: ''` header.
      const res = problem({
        type: ProblemType.Internal,
        title: 'oops',
        status: 500,
        requestId: '',
      });
      const { requestId } = await readResponse(res);
      expect(requestId).toBeTruthy();
      expect(requestId).not.toBe('');
    });

    it('echoes additional implementation-specific fields', async () => {
      const res = problem({
        type: ProblemType.QuotaExceeded,
        title: 'quota',
        status: 402,
        upgradeUrl: 'https://owlette.app/upgrade',
        usedBytes: 5_000_000_000,
      });
      const { body } = await readResponse(res);
      expect(body.upgradeUrl).toBe('https://owlette.app/upgrade');
      expect(body.usedBytes).toBe(5_000_000_000);
    });

    it('adds a stable code and docsUrl for known problem types', async () => {
      const res = problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: 400,
      });
      const { body } = await readResponse(res);
      expect(body.code).toBe('validation_failed');
      expect(body.docsUrl).toBe(
        'https://owlette.app/docs/api/errors#validation_failed',
      );
    });

    it('preserves caller-provided code and docsUrl', async () => {
      const res = problem({
        type: ProblemType.Conflict,
        title: 'duplicate',
        status: 409,
        code: 'duplicate_name',
        docsUrl: 'https://owlette.app/docs/api/errors#duplicate_name',
      });
      const { body } = await readResponse(res);
      expect(body.code).toBe('duplicate_name');
      expect(body.docsUrl).toBe('https://owlette.app/docs/api/errors#duplicate_name');
    });

    it('respects custom headers', () => {
      const res = problem(
        { type: ProblemType.RateLimited, title: 'slow down', status: 429 },
        { 'X-Custom': 'yes' },
      );
      expect(res.headers.get('X-Custom')).toBe('yes');
    });

    it('handles unicode + special chars in detail without breaking JSON', async () => {
      const res = problem({
        type: ProblemType.ValidationFailed,
        title: 't',
        status: 400,
        detail: 'oops "quotes" + \nnewline + 🦉 emoji',
      });
      const { body } = await readResponse(res);
      expect(body.detail).toBe('oops "quotes" + \nnewline + 🦉 emoji');
    });
  });

  describe('problemFromError()', () => {
    it('wraps an unknown error as 500 internal with generic detail (no leak)', async () => {
      const err = new Error('SECRET firebase permission-denied for site_xyz');
      const res = problemFromError(err, 'v2/test/route');
      const { status, body } = await readResponse(res);
      expect(status).toBe(500);
      expect(body.type).toBe(ProblemType.Internal);
      expect(body.instance).toBe('v2/test/route');
      // detail must NOT contain the original error text — generic only
      expect(body.detail).not.toContain('SECRET');
      expect(body.detail).not.toContain('firebase');
      expect(body.detail).not.toContain('permission-denied');
      expect(body.detail).toMatch(/internal error.*requestId/i);
    });

    it('respects an explicit status override', () => {
      const res = problemFromError(new Error('x'), 'ctx', 503);
      expect(res.status).toBe(503);
    });

    it('handles thrown non-Error value without leaking it to the client', async () => {
      const res = problemFromError('arbitrary thrown string with /etc/secret', 'v2/ctx');
      const { body } = await readResponse(res);
      expect(body.detail).not.toContain('arbitrary');
      expect(body.detail).not.toContain('/etc/secret');
    });
  });

  describe('convenience constructors', () => {
    it('problemValidation includes field errors when provided', async () => {
      const res = problemValidation('invalid input', {
        'body.hashes': ['must be a non-empty array'],
      });
      const { status, body } = await readResponse(res);
      expect(status).toBe(400);
      expect(body.type).toBe(ProblemType.ValidationFailed);
      expect((body.errors as Record<string, string[]>)['body.hashes']).toEqual([
        'must be a non-empty array',
      ]);
    });

    it('problemUnauthorized → 401', async () => {
      const { status, body } = await readResponse(problemUnauthorized());
      expect(status).toBe(401);
      expect(body.type).toBe(ProblemType.Unauthorized);
    });

    it('problemForbidden → 403', async () => {
      const { status, body } = await readResponse(problemForbidden());
      expect(status).toBe(403);
      expect(body.type).toBe(ProblemType.Forbidden);
    });

    it('problemNotFound → 404', async () => {
      const { status, body } = await readResponse(problemNotFound());
      expect(status).toBe(404);
      expect(body.type).toBe(ProblemType.NotFound);
    });

    it('problemRateLimited → 429 with Retry-After header (clamped)', async () => {
      const res = problemRateLimited(60, 'too many uploads');
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('60');
      const body = await res.json();
      expect(body.retryAfter).toBe(60);
    });

    it('problemRateLimited clamps zero to 1 second (semantically "retry now")', async () => {
      const res = problemRateLimited(0);
      expect(res.headers.get('Retry-After')).toBe('1');
      const body = await res.json();
      expect(body.retryAfter).toBe(1);
    });

    it('problemRateLimited clamps negative to 1 second', async () => {
      const res = problemRateLimited(-60);
      expect(res.headers.get('Retry-After')).toBe('1');
    });

    it('problemRateLimited caps very large values at 3600', async () => {
      const res = problemRateLimited(Number.MAX_SAFE_INTEGER);
      expect(res.headers.get('Retry-After')).toBe('3600');
    });

    it('problemQuotaExceeded → 402 with upgradeUrl when provided', async () => {
      const { status, body } = await readResponse(
        problemQuotaExceeded('used 5gb of 5gb', 'https://owlette.app/upgrade'),
      );
      expect(status).toBe(402);
      expect(body.type).toBe(ProblemType.QuotaExceeded);
      expect(body.upgradeUrl).toBe('https://owlette.app/upgrade');
    });

    it('problemQuotaExceeded omits upgradeUrl when not provided', async () => {
      const { status, body } = await readResponse(
        problemQuotaExceeded('used 5gb of 5gb'),
      );
      expect(status).toBe(402);
      expect(body.upgradeUrl).toBeUndefined();
    });

    it('problemPlanRequired → 402 plan_required naming the entitlement', async () => {
      const { status, body } = await readResponse(
        problemPlanRequired("your plan doesn't include roost. upgrade to continue.", 'owlette.roost'),
      );
      expect(status).toBe(402);
      expect(body).toMatchObject({
        type: ProblemType.PlanRequired,
        title: 'plan required',
        detail: "your plan doesn't include roost. upgrade to continue.",
        code: 'plan_required',
        docsUrl: 'https://owlette.app/docs/api/errors#plan_required',
        entitlement: 'owlette.roost',
        upgradeUrl: '/settings/plan',
      });
    });
  });

  describe('requestId generation', () => {
    it('produces unique ids across calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const res = problem({ type: ProblemType.Internal, title: 't', status: 500 });
        ids.add(res.headers.get('X-Request-Id') as string);
      }
      expect(ids.size).toBe(100);
    });
  });
});
