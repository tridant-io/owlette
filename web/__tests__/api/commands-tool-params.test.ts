/** @jest-environment node */

/**
 * `mcp_tool_call` on the real POST /api/sites/{siteId}/machines/{machineId}/commands:
 * a value out of its tool's schema is refused, with nothing queued.
 */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedMember,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
  getAdminStorage: () => ({ bucket: jest.fn() }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({ capability_enforcement: true, rate_limit_enforcement: true })),
  },
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  assertUserHasSiteAccess: jest.fn(async () => ({ siteId: 'site-alpha', siteData: {} })),
}));

import { POST as commandsPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/route';

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const RQ = '\u201d';
const P = "Set-Content -LiteralPath 'c:/x/marker.txt' -Value x";

let idemCounter = 0;

async function post(params: Record<string, unknown>) {
  mocks.get.mockReset();
  mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
  mocks.get.mockResolvedValueOnce(docSnapshot(MACHINE, { online: true }));
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', null)));
  idemCounter += 1;
  const req = createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `idem-params-${idemCounter}` },
    body: { type: 'mcp_tool_call', params },
  });
  return commandsPOST(req, { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) });
}

function queued(): Array<Record<string, unknown>> {
  return mocks.set.mock.calls
    .filter((c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true)
    .map((c: unknown[]) => Object.values(c[0] as Record<string, Record<string, unknown>>)[0])
    .filter((entry) => entry?.type === 'mcp_tool_call');
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-1' });
  mocks.userDocs.set('user-1', { role: 'superadmin', sites: [SITE] });
  seedMember(SITE, 'user-1', 'owner');
  mocks.set.mockResolvedValue(undefined);
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
  mockResolveAuth.mockResolvedValue({
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      scopes: [{ resource: 'machine', id: '*', permissions: ['write'] }],
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
      // past the tier gate, so these reach the parameter check
      maxToolTier: 3,
    },
  });
});

describe('refused, with nothing queued', () => {
  it.each<[string, string, Record<string, unknown>]>([
    ['get_event_logs log_name', 'get_event_logs', { log_name: `Application -Newest 1; ${P}; #` }],
    ['get_event_logs level', 'get_event_logs', { log_name: 'Application', level: `Error; ${P}; #` }],
    ['get_event_logs_filtered process_name', 'get_event_logs_filtered', { log_name: 'Application', process_name: `x'+(${P})+'` }],
    ['manage_windows_feature name_filter', 'manage_windows_feature', { type: 'appx_package', action: 'list', name_filter: `x${RQ}}; ${P}; #` }],
    ['show_notification title', 'show_notification', { title: `x'; ${P}; $y='`, message: 'm' }],
    ['an unknown parameter', 'get_system_info', { verbose: true }],
    ['an unknown tool', 'not_a_real_tool', {}],
  ])('%s', async (_label, tool_name, tool_params) => {
    const res = await post({ tool_name, tool_params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('tool_params_invalid');
    expect(body.detail).not.toContain('Set-Content');
    expect(queued()).toHaveLength(0);
  });
});

describe('still queued', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['get_system_info', undefined],
    ['get_event_logs', { log_name: 'System', level: 'Error', max_events: 5 }],
    ['get_event_logs_filtered', { log_name: 'Application', process_name: 'Application Error' }],
    ['manage_windows_feature', { type: 'capability', action: 'install', name: 'OpenSSH.Client~~~~0.0.1.0' }],
    ['show_notification', { title: 'owlette', message: 'back at 5pm' }],
    ['execute_script', { script: "Write-Output 'x; y'", timeout_seconds: 600 }],
  ])('%s', async (tool_name, tool_params) => {
    const res = await post({ tool_name, ...(tool_params ? { tool_params } : {}) });
    expect(res.status).toBe(202);
    expect(queued()).toHaveLength(1);
    expect(queued()[0].tool_name).toBe(tool_name);
    if (tool_params) expect(queued()[0].tool_params).toEqual(tool_params);
  });

  it('the override names are still dropped, not refused', async () => {
    const res = await post({
      tool_name: 'manage_windows_update',
      tool_params: { action: 'get_status', active_hours_override: { reason: 'x' } },
    });
    expect(res.status).toBe(202);
    expect(queued()[0].tool_params).toEqual({ action: 'get_status' });
  });
});
