/** @jest-environment node */

/**
 * `mcp_tool_call` on POST /api/sites/{siteId}/machines/{machineId}/commands, per
 * actor: an api key up to its `maxToolTier` (missing means 1), a person up to
 * tier 2 freely and tier 3 on an open step-up window, and the machine's hoot
 * switch for everyone.
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

// the login cookie and the window are the two facts step-up reads; the decision between them stays real.
const mockGetSessionFromRequest = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  ...jest.requireActual('@/lib/sessionManager.server'),
  getSessionFromRequest: (...a: unknown[]) => mockGetSessionFromRequest(...a),
}));

const mockHasOpenStepUpWindow = jest.fn();
const mockFreshCeremonyCovers = jest.fn();
jest.mock('@/lib/swoop/policy.server', () => ({
  ...jest.requireActual('@/lib/swoop/policy.server'),
  hasOpenStepUpWindow: (...a: unknown[]) => mockHasOpenStepUpWindow(...a),
  freshCeremonyCovers: (...a: unknown[]) => mockFreshCeremonyCovers(...a),
}));

import { emitMutation } from '@/lib/auditLogClient';
import type { ResolvedAuth } from '@/lib/apiAuth.server';
import { POST as commandsPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/route';

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const TIER_1_TOOL = 'get_system_info';
const TIER_2_TOOL = 'manage_windows_service';
const TIER_3_TOOL = 'run_powershell';
const UNKNOWN_TOOL = 'not_a_real_tool';

// parameters each tool accepts, so a call reaches the tier gate's verdict and not the parameter check's
const VALID_PARAMS: Record<string, Record<string, unknown>> = {
  [TIER_2_TOOL]: { action: 'get_details', service_name: 'Spooler' },
  [TIER_3_TOOL]: { script: 'Get-Date' },
};

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

// the key audit rows hash with
process.env.CORTEX_INTERNAL_SECRET = 'test-secret';

function authedKey(maxToolTier?: unknown): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      scopes: [{ resource: 'machine', id: '*', permissions: ['write'] }],
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
      ...(maxToolTier === undefined ? {} : { maxToolTier: maxToolTier as 1 | 2 | 3 }),
    },
  };
}

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function liveSession(mfaSatisfiedBy?: string) {
  return {
    userId: 'user-1',
    expiresAt: Date.now() + 60_000,
    mfaRequired: true,
    mfaVerified: true,
    mfaCompletedAt: Date.now() - 60_000,
    ...(mfaSatisfiedBy ? { mfaSatisfiedBy } : {}),
  };
}

let idemCounter = 0;

async function post(call: Record<string, unknown>, machine: Record<string, unknown> | null = { online: true }) {
  const params = { tool_params: VALID_PARAMS[call.tool_name as string], ...call };
  mocks.get.mockReset();
  mocks.get.mockResolvedValueOnce(docSnapshot('idem', null));
  mocks.get.mockResolvedValueOnce(docSnapshot(MACHINE, machine));
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', null)));
  idemCounter += 1;
  const req = createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/commands`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `idem-tier-${idemCounter}` },
    body: { type: 'mcp_tool_call', params },
  });
  return commandsPOST(req, { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) });
}

function queuedCommands(): Array<Record<string, unknown>> {
  return mocks.set.mock.calls
    .filter((c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true)
    .map((c: unknown[]) => Object.values(c[0] as Record<string, Record<string, unknown>>)[0]);
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
  mockGetSessionFromRequest.mockResolvedValue({});
  mockHasOpenStepUpWindow.mockResolvedValue(false);
  mockFreshCeremonyCovers.mockResolvedValue(false);
});

describe('an api key runs tools up to its maxToolTier', () => {
  it.each([
    ['no value', TIER_1_TOOL, undefined, 202],
    ['no value', TIER_2_TOOL, undefined, 403],
    ['no value', TIER_3_TOOL, undefined, 403],
    ['no value', UNKNOWN_TOOL, undefined, 403],
    ['tier 1', TIER_1_TOOL, 1, 202],
    ['tier 1', TIER_2_TOOL, 1, 403],
    ['tier 2', TIER_2_TOOL, 2, 202],
    ['tier 2', TIER_3_TOOL, 2, 403],
    ['tier 2', UNKNOWN_TOOL, 2, 403],
    ['tier 3', TIER_3_TOOL, 3, 202],
    // past the tier gate, the parameter check refuses a name no tool has
    ['tier 3', UNKNOWN_TOOL, 3, 400],
    ['a malformed "3"', TIER_2_TOOL, '3', 403],
    ['a malformed 99', TIER_2_TOOL, 99, 403],
    ['a malformed 2.5', TIER_2_TOOL, 2.5, 403],
  ])('a key with %s running %s', async (_label, tool, maxToolTier, status) => {
    mockResolveAuth.mockResolvedValue(authedKey(maxToolTier));
    const res = await post({ tool_name: tool });
    expect(res.status).toBe(status);
    if (status === 403) {
      const body = await res.json();
      expect(body.code).toBe('max_tool_tier_exceeded');
      expect(body.detail).toContain('maxToolTier');
      expect(queuedCommands()).toHaveLength(0);
      expect(mockedEmit).not.toHaveBeenCalled();
    } else if (status === 400) {
      expect((await res.json()).code).toBe('tool_params_invalid');
      expect(queuedCommands()).toHaveLength(0);
    } else {
      expect(queuedCommands()).toHaveLength(1);
    }
  });

  it.each([
    ['tier 2', 2, 403],
    ['tier 3', 3, 202],
  ])('a key with %s changing what a machine launches', async (_label, maxToolTier, status) => {
    mockResolveAuth.mockResolvedValue(authedKey(maxToolTier));
    const res = await post({ tool_name: 'update_process', tool_params: { process_name: 'TD', launch_mode: 'always' } });
    expect(res.status).toBe(status);
    expect(queuedCommands()).toHaveLength(status === 202 ? 1 : 0);
  });

  it.each([
    ['reads', { action: 'read', hive: 'HKLM', key_path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', value_name: 'DefaultPassword' }],
    ['writes', { action: 'write', hive: 'HKLM', key_path: 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', value_name: 'Shell', value_data: 'x.exe' }],
  ])('a tier 3 key that %s a registry value hoot refuses is refused the same, before anything is queued', async (_label, params) => {
    mockResolveAuth.mockResolvedValue(authedKey(3));
    const res = await post({ tool_name: 'registry_operation', tool_params: params });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('registry_value_refused');
    expect(queuedCommands()).toHaveLength(0);
  });

  it('a key with tier 2 still runs the same tool where the call leaves what runs alone', async () => {
    mockResolveAuth.mockResolvedValue(authedKey(2));
    const res = await post({ tool_name: 'update_process', tool_params: { process_name: 'TD', priority: 'High' } });
    expect(res.status).toBe(202);
  });

  it('a key needs no step-up window, whatever its tier', async () => {
    mockResolveAuth.mockResolvedValue(authedKey(3));
    await post({ tool_name: TIER_3_TOOL });
    expect(mockHasOpenStepUpWindow).not.toHaveBeenCalled();
  });
});

describe('a person runs tier 3 on an open step-up window', () => {
  beforeEach(() => {
    mockResolveAuth.mockResolvedValue(authedSession());
  });

  it.each([TIER_1_TOOL, TIER_2_TOOL])('%s needs no window', async (tool) => {
    const res = await post({ tool_name: tool });
    expect(res.status).toBe(202);
    expect(mockHasOpenStepUpWindow).not.toHaveBeenCalled();
  });

  it.each([TIER_3_TOOL, UNKNOWN_TOOL])('%s is refused without a window and queues nothing', async (tool) => {
    mockGetSessionFromRequest.mockResolvedValue(liveSession('challenge'));
    const res = await post({ tool_name: tool });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('step_up_required');
    expect(queuedCommands()).toHaveLength(0);
  });

  it('a tier 2 tool that changes what a machine launches needs a window too', async () => {
    mockGetSessionFromRequest.mockResolvedValue(liveSession('challenge'));
    const res = await post({ tool_name: 'update_process', tool_params: { process_name: 'TD', launch_mode: 'always' } });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('step_up_required');
    expect(queuedCommands()).toHaveLength(0);
  });

  it('an id token, with no login cookie behind it, is refused', async () => {
    mockHasOpenStepUpWindow.mockImplementation(async (args: { sessionPassedCeremony: boolean }) =>
      args.sessionPassedCeremony,
    );
    const res = await post({ tool_name: TIER_3_TOOL });
    expect(res.status).toBe(401);
    expect(queuedCommands()).toHaveLength(0);
  });

  it('a device-trust sign-in inherits no window', async () => {
    mockHasOpenStepUpWindow.mockImplementation(async (args: { sessionPassedCeremony: boolean }) =>
      args.sessionPassedCeremony,
    );
    mockGetSessionFromRequest.mockResolvedValue(liveSession('device-trust'));
    const res = await post({ tool_name: TIER_3_TOOL });
    expect(res.status).toBe(401);
    expect(queuedCommands()).toHaveLength(0);
  });

  it('an open window on this machine lets it through', async () => {
    mockHasOpenStepUpWindow.mockImplementation(async (args: { sessionPassedCeremony: boolean }) =>
      args.sessionPassedCeremony,
    );
    mockGetSessionFromRequest.mockResolvedValue(liveSession('challenge'));
    const res = await post({ tool_name: TIER_3_TOOL });
    expect(res.status).toBe(202);
    expect(mockHasOpenStepUpWindow).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', siteId: SITE, machineId: MACHINE }),
    );
    expect(queuedCommands()).toHaveLength(1);
  });

  it("a sign-in's fresh ceremony stands in, as it does for swoop", async () => {
    mockGetSessionFromRequest.mockResolvedValue(liveSession('challenge'));
    mockFreshCeremonyCovers.mockResolvedValue(true);
    const res = await post({ tool_name: TIER_3_TOOL });
    expect(res.status).toBe(202);
  });

  it('a read-only member still gets no tool call at all', async () => {
    mocks.siteDocs.set(SITE, { owner: 'someone-else' });
    seedMember(SITE, 'someone-else', 'owner');
    mocks.userDocs.set('user-1', { role: 'member', sites: [SITE] });
    seedMember(SITE, 'user-1', 'member');
    const res = await post({ tool_name: TIER_1_TOOL });
    expect(res.status).toBe(403);
    expect(queuedCommands()).toHaveLength(0);
  });
});

describe("the machine's hoot switch", () => {
  it.each([
    ['a tier 3 key', () => authedKey(3)],
    ['a person', () => authedSession()],
  ])('%s is refused while hoot is off on the machine, and nothing is queued', async (_label, auth) => {
    mockResolveAuth.mockResolvedValue(auth());
    const res = await post({ tool_name: TIER_1_TOOL }, { online: true, cortexEnabled: false });
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe('hoot_disabled');
    expect(queuedCommands()).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('a machine that never set the field runs the call', async () => {
    mockResolveAuth.mockResolvedValue(authedSession());
    const res = await post({ tool_name: TIER_1_TOOL }, { online: true });
    expect(res.status).toBe(202);
  });
});

describe('the audit row', () => {
  it('names the tool and hashes the parameters, with no values', async () => {
    mockResolveAuth.mockResolvedValue(authedKey(3));
    const res = await post({
      tool_name: TIER_3_TOOL,
      tool_params: { script: 'Get-Content C:/not-for-the-log', user_session: true },
    });
    expect(res.status).toBe(202);
    expect(mockedEmit).toHaveBeenCalledTimes(1);
    const row = mockedEmit.mock.calls[0][0];
    expect(row.kind).toBe('machine_command_dispatched');
    expect(row.actor).toBe('apiKey:key-test');
    expect(row.attributes).toMatchObject({
      commandType: 'mcp_tool_call',
      toolName: TIER_3_TOOL,
      paramNames: ['script', 'user_session'],
      paramsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(row)).not.toContain('not-for-the-log');
  });

  it('hashes the same parameters to the same value, in any key order', async () => {
    mockResolveAuth.mockResolvedValue(authedKey(3));
    await post({ tool_name: TIER_3_TOOL, tool_params: { script: 'Get-Date', user_session: true } });
    await post({ tool_name: TIER_3_TOOL, tool_params: { user_session: true, script: 'Get-Date' } });
    await post({ tool_name: TIER_3_TOOL, tool_params: { script: 'Get-Date', user_session: false } });
    const hashes = mockedEmit.mock.calls.map((call) => call[0].attributes?.paramsHash);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });
});
