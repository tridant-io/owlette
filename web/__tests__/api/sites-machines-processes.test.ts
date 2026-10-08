/** @jest-environment node */

/**
 * HTTP-shape tests for `/api/sites/{siteId}/machines/{machineId}/processes/*`:
 * all 9 verbs, each with its happy path, 401/403/404/409 negatives, idempotency
 * where applicable, and audit + command-queue side effects.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

// Auth gate, defaulting to a pass-through admin actor in the canonical
// _shared.ts shape. Flip with authForbidden() / authUnauthorized().
const mockRequireMachineAuthAndScope = jest.fn().mockResolvedValue({
  ok: true,
  userId: 'test-user',
  auth: { userId: 'test-user', keyContext: null },
  scopeCheck: { isLegacy: false },
});
jest.mock('@/app/api/_shared', () => ({
  requireMachineAuthAndScope: (...args: unknown[]) => mockRequireMachineAuthAndScope(...args),
  // Advisory-header sink. The real one mutates and returns the SAME response;
  // mirror that or the routes' `return applyAuthDeprecations(...)` breaks.
  applyAuthDeprecations: (response: unknown) => response,
}));

const mockResolveAuth = jest.fn().mockResolvedValue({
  userId: 'test-user',
  keyContext: null,
});
jest.mock('@/lib/apiAuth.server', () => {
  class FakeApiAuthError extends Error {
    status: number;
    code?: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      message: string,
      opts?: { code?: string; details?: Record<string, unknown> },
    ) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.details = opts?.details;
    }
  }
  return {
    ApiAuthError: FakeApiAuthError,
    resolveAuth: (...args: unknown[]) => mockResolveAuth(...args),
  };
});

// Jest hoists mock factories above lexical initializers; `var` keeps this
// backing store available when route modules invoke authorizedSiteHandler.
// eslint-disable-next-line no-var
var mockAuthorizedSiteOptions: Array<Record<string, unknown>> | undefined;

function mockAuthorizedSiteHandler(options: Record<string, unknown>) {
  mockAuthorizedSiteOptions ??= [];
  mockAuthorizedSiteOptions.push(options);
  return (
  handler: (
    request: NextRequest,
    ctx: {
      actor: { type: 'user'; userId: string; role: 'admin'; sites: string[] };
      siteId: string;
      correlationId: string;
      auth: { userId: string; keyContext: null };
      scopeCheck: { isLegacy: boolean };
    },
    routeContext: { params: Promise<Record<string, string>> },
  ) => Promise<Response>,
) => async (request: NextRequest, routeContext: { params: Promise<Record<string, string>> }) => {
  const params = await routeContext.params;
  const auth = await mockRequireMachineAuthAndScope(
    request,
    params.siteId,
    params.machineId,
    'write',
  );
  if (!auth.ok) return auth.response;
  return handler(
    request,
      {
        actor: { type: 'user', userId: auth.userId, role: 'admin', siteRoles: { [params.siteId]: 'admin' } },
        siteId: params.siteId,
        correlationId: `corr-${options.targetKind ?? 'site'}`,
        auth: auth.auth,
        scopeCheck: auth.scopeCheck,
      },
      { params: Promise.resolve(params) },
    );
};
}
jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler: (options: { targetKind?: string }) =>
    mockAuthorizedSiteHandler(options),
}));

// Idempotency: pass-through unless we explicitly override.
type IdemHandler = () => Promise<unknown>;
const mockWithIdempotency = jest.fn(
  async (_req: unknown, _ctx: unknown, _body: unknown, fn: IdemHandler) => fn()
);
jest.mock('@/lib/idempotency', () => ({
  withIdempotency: (...args: unknown[]) => mockWithIdempotency(...(args as [unknown, unknown, unknown, IdemHandler])),
}));

// Audit: capture calls.
const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

const mockExecuteMachineCommand = jest.fn().mockResolvedValue({ commandId: 'cmd-process-1' });
jest.mock('@/lib/actions/executeMachineCommand.server', () => {
  class FakeExecuteMachineCommandError extends Error {
    status: number;
    code: string;
    detail: string;
    entitlement?: string;
    constructor(status: number, code: string, detail: string, entitlement?: string) {
      super(detail);
      this.status = status;
      this.code = code;
      this.detail = detail;
      this.entitlement = entitlement;
    }
  }
  return {
    executeMachineCommand: (...args: unknown[]) => mockExecuteMachineCommand(...args),
    ExecuteMachineCommandError: FakeExecuteMachineCommandError,
  };
});

// Process config helpers.
interface MockProcRow {
  processId: string;
  name: string;
  [key: string]: unknown;
}
const mockWithProcessLock = jest.fn();
const mockReadProcessList = jest.fn();
const mockGenerateProcessId = jest.fn(() => 'gen-uuid-1');
const mockFindProcessIndex = jest.fn((procs: MockProcRow[], id: string) =>
  procs.findIndex((p) => p.processId === id)
);
jest.mock('@/lib/processConfig.server', () => {
  class FakeProcessConfigError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    withProcessLock: (...args: unknown[]) => mockWithProcessLock(...args),
    readProcessList: (...args: unknown[]) => mockReadProcessList(...args),
    generateProcessId: () => mockGenerateProcessId(),
    findProcessIndex: (procs: MockProcRow[], id: string) => mockFindProcessIndex(procs, id),
    ProcessConfigError: FakeProcessConfigError,
  };
});

// Import after mock is registered so the class identity stays consistent.
import { ProcessConfigError as FakeProcessConfigError } from '@/lib/processConfig.server';
import { ExecuteMachineCommandError as FakeExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';

// Firestore admin.
const mockFsGet = jest.fn();
const mockFsSet = jest.fn().mockResolvedValue(undefined);
const mockFsUpdate = jest.fn().mockResolvedValue(undefined);

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: mockFsGet,
        set: mockFsSet,
        update: mockFsUpdate,
        collection: () => ({
          doc: () => ({
            get: mockFsGet,
            set: mockFsSet,
            update: mockFsUpdate,
            collection: () => ({
              doc: () => ({
                get: mockFsGet,
                set: mockFsSet,
                update: mockFsUpdate,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
}));


import { GET as GET_LIST, POST as POST_CREATE } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/route';
import {
  GET as GET_DETAIL,
  PATCH as PATCH_UPDATE,
  DELETE as DELETE_REMOVE,
} from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/route';
import { POST as POST_KILL } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/kill/route';
import { POST as POST_RESTART } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/restart/route';
import { POST as POST_START } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/start/route';
import { POST as POST_STOP } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/stop/route';
import { POST as POST_SCHEDULE } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/schedule/route';
import { PATCH as PATCH_LAUNCH_MODE } from '@/app/api/sites/[siteId]/machines/[machineId]/processes/[processId]/launch-mode/route';

const SITE = 's1';
const MACHINE = 'm1';
const PID = 'proc-1';

function ctx(opts: { siteId?: string; machineId?: string; processId?: string } = {}) {
  return {
    params: Promise.resolve({
      siteId: opts.siteId ?? SITE,
      machineId: opts.machineId ?? MACHINE,
      processId: opts.processId ?? PID,
    }),
  };
}

function jsonReq(url: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers } as HeadersInit,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function urlList() {
  return `http://localhost/api/sites/${SITE}/machines/${MACHINE}/processes`;
}
function urlDetail() {
  return `${urlList()}/${PID}`;
}

function makeProcRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PID,
    processId: PID,
    name: 'TestProc',
    exe_path: 'C:/test.exe',
    file_path: '',
    cwd: '',
    priority: 'Normal',
    visibility: 'Show',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    autolaunch: false,
    launch_mode: 'off',
    schedules: null,
    ...overrides,
  };
}

function makeProblemResponse(status: number, code: string, title: string) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title, status, code, detail: title }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  ) as unknown as import('next/server').NextResponse;
}

function lastIdempotencyOptions(): unknown {
  const call = mockWithIdempotency.mock.calls[mockWithIdempotency.mock.calls.length - 1];
  return call?.[4];
}

function authForbidden() {
  mockRequireMachineAuthAndScope.mockResolvedValueOnce({
    ok: false,
    response: makeProblemResponse(403, 'scope_insufficient', 'Forbidden: missing scope machine=m1:write'),
  });
}

function authUnauthorized() {
  mockRequireMachineAuthAndScope.mockResolvedValueOnce({
    ok: false,
    response: makeProblemResponse(401, 'unauthorized', 'Unauthorized'),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireMachineAuthAndScope.mockResolvedValue({
    ok: true,
    userId: 'test-user',
    auth: { userId: 'test-user', keyContext: null },
    scopeCheck: { isLegacy: false },
  });
  mockWithIdempotency.mockImplementation(async (_req, _ctx, _body, fn) => fn());
  mockExecuteMachineCommand.mockResolvedValue({ commandId: 'cmd-process-1' });
});

describe('GET /api/sites/{siteId}/machines/{machineId}/processes', () => {
  it('returns 200 with merged config + status', async () => {
    mockReadProcessList.mockResolvedValueOnce([makeProcRow()]);
    mockFsGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ metrics: { processes: { [PID]: { status: 'running', pid: 1234 } } } }),
    });

    const res = await GET_LIST(jsonReq(urlList(), 'GET'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.processes).toHaveLength(1);
    expect(body.data.processes[0].processId).toBe(PID);
    expect(body.data.processes[0].status).toBe('running');
    expect(body.data.processes[0].pid).toBe(1234);
    expect(body.data.nextPageToken).toBeNull();
  });

  it('returns empty list when no config doc', async () => {
    mockReadProcessList.mockResolvedValueOnce(null);
    mockFsGet.mockResolvedValueOnce({ exists: false, data: () => null });

    const res = await GET_LIST(jsonReq(urlList(), 'GET'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.processes).toEqual([]);
  });

  it('marks unknown status when no live metrics', async () => {
    mockReadProcessList.mockResolvedValueOnce([makeProcRow()]);
    mockFsGet.mockResolvedValueOnce({ exists: false, data: () => null });

    const res = await GET_LIST(jsonReq(urlList(), 'GET'), ctx());
    const body = await res.json();
    expect(body.data.processes[0].status).toBe('unknown');
  });

  it('returns 401 when auth fails', async () => {
    authUnauthorized();
    const res = await GET_LIST(jsonReq(urlList(), 'GET'), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when scope insufficient', async () => {
    authForbidden();
    const res = await GET_LIST(jsonReq(urlList(), 'GET'), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
  });

  it('does not emit audit on read', async () => {
    mockReadProcessList.mockResolvedValueOnce([]);
    mockFsGet.mockResolvedValueOnce({ exists: false, data: () => null });
    await GET_LIST(jsonReq(urlList(), 'GET'), ctx());
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('process route authorization wrappers', () => {
  it('wraps process mutations with explicit role capabilities', () => {
    expect(mockAuthorizedSiteOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'MACHINE_CONFIG_WRITE', targetKind: 'machine' }),
        expect.objectContaining({ capability: 'MACHINE_CONFIG_WRITE', targetKind: 'process' }),
        expect.objectContaining({ capability: 'MACHINE_EXEC_COMMAND', targetKind: 'process' }),
      ]),
    );
  });
});

describe('POST /api/sites/{siteId}/machines/{machineId}/processes', () => {
  beforeEach(() => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([]);
      return undefined;
    });
  });

  it('creates a new process and returns 201 with processId', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'New', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'key-1' }),
      ctx()
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.processId).toBeTruthy();
  });

  it('requires idempotency at the route helper layer', async () => {
    await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'New', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'key-create-required' }),
      ctx()
    );
    expect(lastIdempotencyOptions()).toEqual({ requireKey: true });
  });

  it('returns 400 when name is missing', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { exe_path: 'C:/x.exe' }, { 'idempotency-key': 'key-2' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('missing_field');
  });

  it('returns 400 when exe_path is missing', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X' }, { 'idempotency-key': 'key-3' }),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when caller tries to set processId', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'a', processId: 'evil' }, { 'idempotency-key': 'k' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('forbidden_field');
  });

  it('returns 400 for unknown process config fields', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'a', injected: true }, { 'idempotency-key': 'k-unknown' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unknown_field');
  });

  it('returns 400 for invalid launch_mode', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'a', launch_mode: 'banana' }, { 'idempotency-key': 'k-mode' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_field');
  });

  it('returns 400 for scheduled create without schedules', async () => {
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'a', launch_mode: 'scheduled' }, { 'idempotency-key': 'k-sched' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('missing_schedules');
  });

  it('returns 400 on invalid JSON body', async () => {
    const req = new NextRequest(urlList(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' } as HeadersInit,
      body: '{not json',
    });
    const res = await POST_CREATE(req, ctx());
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate name (rejected inside transaction)', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new FakeProcessConfigError(409, 'Duplicate process name: New', 'duplicate_process_name')
    );
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'Dup', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'k' }),
      ctx()
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('duplicate_process_name');
  });

  it('returns 401 when auth fails', async () => {
    authUnauthorized();
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'k' }),
      ctx()
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when scope insufficient', async () => {
    authForbidden();
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'k' }),
      ctx()
    );
    expect(res.status).toBe(403);
  });

  it('emits process_mutated audit on create', async () => {
    await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'k' }),
      ctx()
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        attributes: expect.objectContaining({ verb: 'create', method: 'POST', machineId: MACHINE }),
      })
    );
  });

  it('returns Idempotent-Replayed: true on replay', async () => {
    // Override withIdempotency to simulate a cache-hit replay.
    mockWithIdempotency.mockImplementationOnce(async () => {
      const { NextResponse } = await import('next/server');
      const r = NextResponse.json({ ok: true, data: { processId: 'cached' } }, { status: 201 });
      r.headers.set('Idempotent-Replayed', 'true');
      return r;
    });
    const res = await POST_CREATE(
      jsonReq(urlList(), 'POST', { name: 'X', exe_path: 'C:/x.exe' }, { 'idempotency-key': 'k' }),
      ctx()
    );
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
  });
});

describe('GET /api/sites/{siteId}/machines/{machineId}/processes/{processId}', () => {
  it('returns 200 with the process detail', async () => {
    mockReadProcessList.mockResolvedValueOnce([makeProcRow()]);
    mockFsGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ metrics: { processes: { [PID]: { status: 'running' } } } }),
    });

    const res = await GET_DETAIL(jsonReq(urlDetail(), 'GET'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.processId).toBe(PID);
    expect(body.data.status).toBe('running');
  });

  it('merges live detail status by legacy process name', async () => {
    mockReadProcessList.mockResolvedValueOnce([
      makeProcRow({ id: 'legacy-proc-id', processId: PID, name: 'LegacyName' }),
    ]);
    mockFsGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ metrics: { processes: { LegacyName: { status: 'stopped', pid: 7 } } } }),
    });

    const res = await GET_DETAIL(jsonReq(urlDetail(), 'GET'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('stopped');
    expect(body.data.pid).toBe(7);
  });

  it('merges live detail status by legacy id', async () => {
    mockReadProcessList.mockResolvedValueOnce([
      makeProcRow({ id: 'legacy-proc-id', processId: PID, name: 'LegacyName' }),
    ]);
    mockFsGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ metrics: { processes: { 'legacy-proc-id': { status: 'running', pid: 8 } } } }),
    });

    const res = await GET_DETAIL(jsonReq(urlDetail(), 'GET'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('running');
    expect(body.data.pid).toBe(8);
  });

  it('returns 404 when process not found', async () => {
    mockReadProcessList.mockResolvedValueOnce([]);
    mockFsGet.mockResolvedValueOnce({ exists: false, data: () => null });

    const res = await GET_DETAIL(jsonReq(urlDetail(), 'GET'), ctx());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('process_not_found');
  });

  it('returns 404 when no config doc', async () => {
    mockReadProcessList.mockResolvedValueOnce(null);
    mockFsGet.mockResolvedValueOnce({ exists: false, data: () => null });

    const res = await GET_DETAIL(jsonReq(urlDetail(), 'GET'), ctx());
    expect(res.status).toBe(404);
  });

  it('returns 403 on scope failure', async () => {
    authForbidden();
    const res = await GET_DETAIL(jsonReq(urlDetail(), 'GET'), ctx());
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}', () => {
  beforeEach(() => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([makeProcRow()]);
      return undefined;
    });
  });

  it('returns 200 on successful update', async () => {
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { exe_path: 'C:/new.exe' }),
      ctx()
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when body is empty', async () => {
    const res = await PATCH_UPDATE(jsonReq(urlDetail(), 'PATCH', {}), ctx());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('no_fields');
  });

  it('rejects body that includes processId', async () => {
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { processId: 'evil' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('forbidden_field');
  });

  it('rejects body that includes id', async () => {
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { id: 'evil' }),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields on update', async () => {
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { unreviewed: true }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('unknown_field');
  });

  it('rejects invalid update field types', async () => {
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { autolaunch: 'yes' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_field');
  });

  it('rejects scheduled launch mode without existing or provided schedules', async () => {
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { launch_mode: 'scheduled' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('missing_schedules');
  });

  it('returns 404 when process not found', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new FakeProcessConfigError(404, 'Process p1 not found', 'process_not_found')
    );
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { exe_path: 'C:/new.exe' }),
      ctx()
    );
    expect(res.status).toBe(404);
  });

  it('returns 409 on duplicate-name mid-update', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new FakeProcessConfigError(409, 'Duplicate process name: Renamed', 'duplicate_process_name')
    );
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { name: 'Renamed' }),
      ctx()
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('duplicate_process_name');
  });

  it('returns 403 on scope failure', async () => {
    authForbidden();
    const res = await PATCH_UPDATE(
      jsonReq(urlDetail(), 'PATCH', { exe_path: 'C:/x.exe' }),
      ctx()
    );
    expect(res.status).toBe(403);
  });

  it('emits process_mutated with verb=update', async () => {
    await PATCH_UPDATE(jsonReq(urlDetail(), 'PATCH', { exe_path: 'C:/x.exe' }), ctx());
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: PID,
        attributes: expect.objectContaining({ verb: 'update', method: 'PATCH' }),
      })
    );
  });
});

describe('DELETE /api/sites/{siteId}/machines/{machineId}/processes/{processId}', () => {
  beforeEach(() => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([makeProcRow()]);
      return undefined;
    });
  });

  it('returns 200 with alreadyDeleted=false when process found', async () => {
    const res = await DELETE_REMOVE(jsonReq(urlDetail(), 'DELETE'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(false);
  });

  it('returns 200 with alreadyDeleted=true when process not in array (true-idempotent)', async () => {
    mockWithProcessLock.mockImplementationOnce(async (_s, _m, fn) => {
      fn([]); // empty array — index will be -1
      return undefined;
    });
    const res = await DELETE_REMOVE(jsonReq(urlDetail(), 'DELETE'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(true);
  });

  it('returns 200 with alreadyDeleted=true when config doc missing (404 from txn)', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new FakeProcessConfigError(404, 'Configuration not found for this machine')
    );
    const res = await DELETE_REMOVE(jsonReq(urlDetail(), 'DELETE'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.alreadyDeleted).toBe(true);
  });

  it('returns 401 when auth fails', async () => {
    authUnauthorized();
    const res = await DELETE_REMOVE(jsonReq(urlDetail(), 'DELETE'), ctx());
    expect(res.status).toBe(401);
  });

  it('returns 403 when scope insufficient', async () => {
    authForbidden();
    const res = await DELETE_REMOVE(jsonReq(urlDetail(), 'DELETE'), ctx());
    expect(res.status).toBe(403);
  });

  it('emits process_mutated audit on delete', async () => {
    await DELETE_REMOVE(jsonReq(urlDetail(), 'DELETE'), ctx());
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: PID,
        attributes: expect.objectContaining({ verb: 'delete', method: 'DELETE' }),
      })
    );
  });
});

describe.each([
  ['kill', POST_KILL, 'kill_process'],
  ['restart', POST_RESTART, 'restart_process'],
  ['start', POST_START, 'start_process'],
  ['stop', POST_STOP, 'stop_process'],
] as const)('POST .../processes/{id}/%s', (verb, handler, expectedCmdType) => {
  beforeEach(() => {
    mockReadProcessList.mockResolvedValue([makeProcRow()]);
  });

  it('returns 202 with commandId on success', async () => {
    const res = await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-key` }),
      ctx()
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.commandId).toBeTruthy();
    expect(body.data.status).toBe('pending');
  });

  it('requires idempotency at the route helper layer', async () => {
    await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-key-required` }),
      ctx()
    );
    expect(lastIdempotencyOptions()).toEqual({ requireKey: true });
  });

  it('queues through the canonical machine command action', async () => {
    await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-key` }),
      ctx()
    );
    expect(mockExecuteMachineCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: SITE,
        machineId: MACHINE,
        correlationId: 'corr-process',
      }),
      {
        type: expectedCmdType,
        payload: {
          process_id: PID,
          processId: PID,
          process_name: 'TestProc',
        },
      },
    );
  });

  it('returns 404 when process not found', async () => {
    mockReadProcessList.mockResolvedValueOnce([]);
    const res = await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-k404` }),
      ctx()
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('process_not_found');
  });

  it('returns 404 when no machine config', async () => {
    mockReadProcessList.mockResolvedValueOnce(null);
    const res = await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-k404b` }),
      ctx()
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 on scope failure', async () => {
    authForbidden();
    const res = await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-kf` }),
      ctx()
    );
    expect(res.status).toBe(403);
  });

  it('returns 402 plan_required when the payer lacks owlette.control', async () => {
    mockExecuteMachineCommand.mockRejectedValueOnce(
      new FakeExecuteMachineCommandError(
        402,
        'plan_required',
        "your plan doesn't include remote control. upgrade to continue.",
        'owlette.control',
      ),
    );
    const res = await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-k402` }),
      ctx()
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.control',
      upgradeUrl: '/settings/plan',
    });
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it(`emits process_mutated audit with verb=${verb}`, async () => {
    await handler(
      jsonReq(`${urlDetail()}/${verb}`, 'POST', {}, { 'idempotency-key': `${verb}-aud` }),
      ctx()
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        attributes: expect.objectContaining({ verb, commandType: expectedCmdType }),
      })
    );
  });
});

describe('PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}/launch-mode', () => {
  beforeEach(() => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([makeProcRow()]);
      return undefined;
    });
  });

  it('returns 200 when launch mode is updated', async () => {
    const res = await PATCH_LAUNCH_MODE(
      jsonReq(`${urlDetail()}/launch-mode`, 'PATCH', { mode: 'always' }, { 'idempotency-key': 'lm-1' }),
      ctx()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ processId: PID, mode: 'always' });
  });

  it('requires idempotency at the route helper layer', async () => {
    await PATCH_LAUNCH_MODE(
      jsonReq(`${urlDetail()}/launch-mode`, 'PATCH', { mode: 'off' }, { 'idempotency-key': 'lm-2' }),
      ctx()
    );
    expect(lastIdempotencyOptions()).toEqual({ requireKey: true });
  });

  it('returns 400 for invalid launch mode', async () => {
    const res = await PATCH_LAUNCH_MODE(
      jsonReq(`${urlDetail()}/launch-mode`, 'PATCH', { mode: 'bad' }, { 'idempotency-key': 'lm-3' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_mode');
  });

  it('returns 400 when scheduled mode omits schedules', async () => {
    const res = await PATCH_LAUNCH_MODE(
      jsonReq(`${urlDetail()}/launch-mode`, 'PATCH', { mode: 'scheduled' }, { 'idempotency-key': 'lm-4' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('missing_schedules');
  });

  it('returns 404 when process is not found', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new FakeProcessConfigError(404, 'Process p not found', 'process_not_found')
    );
    const res = await PATCH_LAUNCH_MODE(
      jsonReq(`${urlDetail()}/launch-mode`, 'PATCH', { mode: 'off' }, { 'idempotency-key': 'lm-5' }),
      ctx()
    );
    expect(res.status).toBe(404);
  });

  it('emits process_mutated with verb=set_launch_mode', async () => {
    await PATCH_LAUNCH_MODE(
      jsonReq(`${urlDetail()}/launch-mode`, 'PATCH', { mode: 'always' }, { 'idempotency-key': 'lm-6' }),
      ctx()
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: PID,
        attributes: expect.objectContaining({ verb: 'set_launch_mode', mode: 'always' }),
      })
    );
  });
});

describe('POST /api/sites/{siteId}/machines/{machineId}/processes/{processId}/schedule', () => {
  beforeEach(() => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      fn([makeProcRow()]);
      return undefined;
    });
  });

  it('returns 200 for mode=off', async () => {
    const res = await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'off' }, { 'idempotency-key': 'sk1' }),
      ctx()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mode).toBe('off');
  });

  it('requires idempotency at the route helper layer', async () => {
    await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'off' }, { 'idempotency-key': 'sk-required' }),
      ctx()
    );
    expect(lastIdempotencyOptions()).toEqual({ requireKey: true });
  });

  it('returns 200 for mode=always', async () => {
    const res = await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'always' }, { 'idempotency-key': 'sk2' }),
      ctx()
    );
    expect(res.status).toBe(200);
  });

  it('returns 200 for mode=scheduled with blocks', async () => {
    const res = await POST_SCHEDULE(
      jsonReq(
        `${urlDetail()}/schedule`,
        'POST',
        { mode: 'scheduled', blocks: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }] },
        { 'idempotency-key': 'sk3' }
      ),
      ctx()
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid mode', async () => {
    const res = await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'invalid' }, { 'idempotency-key': 'sk4' }),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_field');
  });

  it('returns 400 for mode=scheduled with no blocks', async () => {
    const res = await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'scheduled' }, { 'idempotency-key': 'sk5' }),
      ctx()
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed schedule blocks', async () => {
    const res = await POST_SCHEDULE(
      jsonReq(
        `${urlDetail()}/schedule`,
        'POST',
        { mode: 'scheduled', blocks: [{ days: 'mon', ranges: [] }] },
        { 'idempotency-key': 'sk-malformed' }
      ),
      ctx()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_field');
  });

  it('returns 404 when process not found', async () => {
    mockWithProcessLock.mockRejectedValueOnce(
      new FakeProcessConfigError(404, 'Process p not found', 'process_not_found')
    );
    const res = await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'off' }, { 'idempotency-key': 'sk6' }),
      ctx()
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 on scope failure', async () => {
    authForbidden();
    const res = await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'off' }, { 'idempotency-key': 'sk7' }),
      ctx()
    );
    expect(res.status).toBe(403);
  });

  it('does NOT write to command queue', async () => {
    await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'off' }, { 'idempotency-key': 'sk8' }),
      ctx()
    );
    // mockFsSet is the command-queue write — schedule must not touch it.
    expect(mockFsSet).not.toHaveBeenCalled();
    // It SHOULD call withProcessLock (via the mock).
    expect(mockWithProcessLock).toHaveBeenCalled();
  });

  it('emits process_mutated with verb=schedule', async () => {
    await POST_SCHEDULE(
      jsonReq(`${urlDetail()}/schedule`, 'POST', { mode: 'off' }, { 'idempotency-key': 'sk9' }),
      ctx()
    );
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        attributes: expect.objectContaining({ verb: 'schedule', mode: 'off' }),
      })
    );
  });
});
