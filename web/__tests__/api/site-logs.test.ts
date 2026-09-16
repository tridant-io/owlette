/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
} from './helpers/firestore-mock';

const mockRequireSiteAuthAndScope = jest.fn();
const mockClearLogs = jest.fn();
// Jest hoists mock factories above lexical initializers; `var` keeps this
// backing store available when route modules invoke authorizedSiteHandler.
// eslint-disable-next-line no-var
var mockAuthorizedOptions: unknown[] | undefined;

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    private readonly ms: number;

    constructor(ms: number) {
      this.ms = ms;
    }

    static fromDate(date: Date): MockTimestamp {
      return new MockTimestamp(date.getTime());
    }

    toDate(): Date {
      return new Date(this.ms);
    }

    toMillis(): number {
      return this.ms;
    }
  }

  return {
    Timestamp: MockTimestamp,
    FieldValue: {
      serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    },
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('@/app/api/_shared', () => ({
  applyAuthDeprecations: (response: Response) => response,
  requireSiteAuthAndScope: (...args: unknown[]) => mockRequireSiteAuthAndScope(...args),
  readAndParseJsonBody: async (request: Request) => {
    const raw = await request.text();
    if (raw.length === 0) return { ok: true, raw, body: {} };
    try {
      return { ok: true, raw, body: JSON.parse(raw) as unknown };
    } catch {
      return { ok: false, response: new Response('bad json', { status: 400 }) };
    }
  },
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: (options: unknown) => {
    (mockAuthorizedOptions ??= []).push(options);
    return (handler: (...args: unknown[]) => unknown) =>
      async (
        request: Request,
        routeContext: { params: Promise<{ siteId: string }> },
      ) => {
        const params = await routeContext.params;
        return handler(
          request,
          {
            actor: { type: 'user', userId: 'admin-uid', role: 'admin', siteRoles: { [params.siteId]: 'admin' } },
            siteId: params.siteId,
            correlationId: 'corr-test',
            auth: { userId: 'admin-uid', keyContext: null },
            scopeCheck: { isLegacy: false },
          },
          routeContext,
        );
      };
  },
}));

jest.mock('@/lib/idempotency', () => ({
  withIdempotency: async (
    request: Request,
    _ctx: unknown,
    _rawBody: string,
    handler: () => Promise<Response>,
    options?: { requireKey?: boolean },
  ) => {
    if (options?.requireKey && !request.headers.get('Idempotency-Key')) {
      const { NextResponse } = jest.requireActual('next/server');
      return NextResponse.json(
        {
          type: 'https://owlette.app/problems/validation-failed',
          title: 'idempotency key required',
          status: 400,
          code: 'idempotency_key_required',
          detail: 'Idempotency-Key is required for this mutation',
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    return handler();
  },
}));

jest.mock('@/lib/actions/clearLogs.server', () => {
  class ClearLogsValidationError extends Error {
    field: string;

    constructor(field: string, message: string) {
      super(message);
      this.field = field;
    }
  }

  return {
    ClearLogsValidationError,
    clearLogs: (...args: unknown[]) => mockClearLogs(...args),
  };
});

import { GET as logsGET, DELETE as logsDELETE } from '@/app/api/sites/[siteId]/logs/route';
import { GET as logDetailGET } from '@/app/api/sites/[siteId]/logs/[logId]/route';

const SITE = 'site-alpha';

function routeContext(siteId = SITE) {
  return { params: Promise.resolve({ siteId }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSiteAuthAndScope.mockResolvedValue({
    ok: true,
    userId: 'admin-uid',
    auth: { userId: 'admin-uid', keyContext: null },
    scopeCheck: { isLegacy: false },
  });
  mockClearLogs.mockResolvedValue({ siteId: SITE, deletedCount: 3, filters: {} });
  mocks.get.mockResolvedValue(docSnapshot('any', {}));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('GET /api/sites/{siteId}/logs', () => {
  it('returns canonical cursor pagination fields', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'log-1',
          data: {
            timestamp: 1_700_000_000_000,
            action: 'process_crash',
            level: 'error',
            machineId: 'm1',
            machineName: 'Lobby',
            processName: 'Player',
            details: 'crashed',
          },
        },
        {
          id: 'log-2',
          data: {
            timestamp: 1_699_999_000_000,
            action: 'agent_started',
            level: 'info',
            machineId: 'm2',
          },
        },
      ]),
    );

    const res = await logsGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs?page_size=1`),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]).toMatchObject({
      id: 'log-1',
      siteId: SITE,
      action: 'process_crash',
      level: 'error',
      machineId: 'm1',
    });
    expect(body.next_page_token).toBe('log-1');
    expect(body.nextPageToken).toBe('log-1');
  });

  it('filters by action, machineId, level, and timestamp range', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'match',
          data: {
            timestamp: 1_700_000_000_000,
            action: 'process_crash',
            level: 'error',
            machineId: 'm1',
          },
        },
        {
          id: 'wrong-action',
          data: {
            timestamp: 1_700_000_000_001,
            action: 'agent_started',
            level: 'error',
            machineId: 'm1',
          },
        },
      ]),
    );

    const res = await logsGET(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/logs?action=process_crash&machineId=m1&level=error&since=1699999999999&until=1700000000001`,
      ),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.logs.map((log: { id: string }) => log.id)).toEqual(['match']);
    expect(mocks.where).toHaveBeenCalledWith('timestamp', '>=', expect.anything());
    expect(mocks.where).toHaveBeenCalledWith('timestamp', '<=', expect.anything());
  });

  it('rejects invalid levels', async () => {
    const res = await logsGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs?level=verbose`),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('validation_failed');
  });
});

describe('GET /api/sites/{siteId}/logs/{logId}', () => {
  it('returns one log entry', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('log-1', {
        timestamp: 1_700_000_000_000,
        action: 'agent_started',
        level: 'info',
        machineId: 'm1',
      }),
    );

    const res = await logDetailGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs/log-1`),
      { params: Promise.resolve({ siteId: SITE, logId: 'log-1' }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      id: 'log-1',
      siteId: SITE,
      action: 'agent_started',
      level: 'info',
      machineId: 'm1',
    });
  });
});

describe('DELETE /api/sites/{siteId}/logs', () => {
  it('is wrapped as site-scoped log admin surface', () => {
    expect(mockAuthorizedOptions ?? []).toContainEqual(
      expect.objectContaining({
        capability: 'SITE_LOGS_MANAGE',
        siteIdParam: 'path',
        targetKind: 'site',
        apiKeyPermission: 'admin',
      }),
    );
  });

  it('requires Idempotency-Key before clearing', async () => {
    const res = await logsDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
        method: 'DELETE',
        body: { all: true },
      }),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('idempotency_key_required');
    expect(mockClearLogs).not.toHaveBeenCalled();
  });

  it('requires explicit all=true for whole-site clearing', async () => {
    const res = await logsDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'clear-all-missing' },
        body: {},
      }),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.errors['body.all']).toBeDefined();
    expect(mockClearLogs).not.toHaveBeenCalled();
  });

  it('clears all logs only when all=true is explicit', async () => {
    mockClearLogs.mockResolvedValueOnce({ siteId: SITE, deletedCount: 2, filters: {} });

    const res = await logsDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'clear-all' },
        body: { all: true },
      }),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deletedCount).toBe(2);
    expect(mockClearLogs).toHaveBeenCalledWith(
      { siteId: SITE, auditActor: 'user:admin-uid' },
      {},
    );
  });

  it('clears with filters without all=true', async () => {
    mockClearLogs.mockResolvedValueOnce({
      siteId: SITE,
      deletedCount: 1,
      filters: { action: 'process_crash', machineId: 'm1', level: 'error' },
    });

    const res = await logsDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'clear-filtered' },
        body: { action: 'process_crash', machineId: 'm1', level: 'error' },
      }),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.filters).toEqual({ action: 'process_crash', machineId: 'm1', level: 'error' });
    expect(mockClearLogs).toHaveBeenCalledWith(
      { siteId: SITE, auditActor: 'user:admin-uid' },
      { action: 'process_crash', machineId: 'm1', level: 'error' },
    );
  });

  it('clears with a multi-action scope', async () => {
    mockClearLogs.mockResolvedValueOnce({
      siteId: SITE,
      deletedCount: 4,
      filters: { actions: ['process_crash', 'agent_started'] },
    });

    const res = await logsDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'clear-actions' },
        body: { actions: ['process_crash', 'agent_started'] },
      }),
      routeContext(),
    );

    // An actions list is a filter, so `all: true` must NOT be required — the
    // multi-select view would otherwise fall through to clearing the site.
    expect(res.status).toBe(200);
    expect(mockClearLogs).toHaveBeenCalledWith(
      { siteId: SITE, auditActor: 'user:admin-uid' },
      { actions: ['process_crash', 'agent_started'] },
    );
  });

  it('rejects action and actions together', async () => {
    const res = await logsDELETE(
      createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': 'clear-both' },
        body: { action: 'process_crash', actions: ['agent_started'] },
      }),
      routeContext(),
    );

    expect(res.status).toBe(400);
    expect(mockClearLogs).not.toHaveBeenCalled();
  });

  it('rejects a malformed actions list', async () => {
    for (const actions of [[], [''], 'process_crash', [1]]) {
      mockClearLogs.mockClear();
      const res = await logsDELETE(
        createMockRequest(`http://localhost/api/sites/${SITE}/logs`, {
          method: 'DELETE',
          headers: { 'Idempotency-Key': `clear-bad-${JSON.stringify(actions)}` },
          body: { actions },
        }),
        routeContext(),
      );

      expect(res.status).toBe(400);
      expect(mockClearLogs).not.toHaveBeenCalled();
    }
  });
});
