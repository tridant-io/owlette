/** @jest-environment node */

/**
 * POST /api/sites/{siteId}/machines/{machineId}/path-check: who may learn what is
 * on a machine's disk. the gate is exactly MACHINE_CONFIG_WRITE, the capability
 * that edits the machine's process config, and an api key gains nothing, here or
 * through the public command route.
 */

import { createMockRequest } from './helpers/utils';
import { mocks, mockDbFactory, docSnapshot, querySnapshot, seedMember } from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
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
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: jest.fn(),
}));

const mockResolveAuth = jest.fn();

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

import { emitMutation } from '@/lib/auditLogClient';
import type { ResolvedAuth } from '@/lib/apiAuth.server';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import { POST as pathCheckPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/path-check/route';
import { POST as commandsPOST } from '@/app/api/sites/[siteId]/machines/[machineId]/commands/route';
import { executeMachineCommand, ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const URL_BASE = `http://localhost/api/sites/${SITE}/machines/${MACHINE}`;

function session(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function apiKey(scopes: ApiKeyScope[]): ResolvedAuth {
  return {
    userId: 'user-1',
    keyContext: {
      keyId: 'key-test',
      scopes,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  };
}

const WRITE_SCOPE: ApiKeyScope = { resource: 'machine', id: MACHINE, permissions: ['write'] };

function call(body: unknown) {
  return pathCheckPOST(createMockRequest(`${URL_BASE}/path-check`, { method: 'POST', body }), {
    params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
  });
}

function queuedCommand(): Record<string, unknown> | null {
  const merge = mocks.set.mock.calls.find((c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true);
  if (!merge) return null;
  const envelope = merge[0] as Record<string, Record<string, unknown>>;
  return envelope[Object.keys(envelope)[0]];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAuth.mockResolvedValue(session());
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-1' });
  mocks.userDocs.set('user-1', { role: 'member', sites: [SITE] });
  seedMember(SITE, 'user-1', 'admin');
  mocks.set.mockReset();
  mocks.set.mockResolvedValue(undefined);
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
  mocks.get.mockReset();
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot(MACHINE, { online: true })));
});

describe('who may call it', () => {
  it.each(['owner', 'admin'] as const)('a site %s queues check_path', async (role) => {
    seedMember(SITE, 'user-1', role);

    const res = await call({ field: 'exe_path', value: 'C:\\show\\app.exe' });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.commandId).toMatch(/^cmd_/);
    expect(queuedCommand()).toMatchObject({
      type: 'check_path',
      field: 'exe_path',
      value: 'C:\\show\\app.exe',
      queuedBy: 'user:user-1',
    });
  });

  it('a superadmin queues check_path on a site it holds no row for', async () => {
    mocks.memberDocs.clear();
    mocks.userDocs.set('user-1', { role: 'superadmin', sites: [] });

    expect((await call({ field: 'cwd', value: 'C:\\show' })).status).toBe(202);
  });

  it('a read-only member is refused: it may not edit the config either', async () => {
    seedMember(SITE, 'user-1', 'member');

    const res = await call({ field: 'folder', value: 'C:\\' });

    expect(res.status).toBe(403);
    expect(queuedCommand()).toBeNull();
  });

  it('someone with no membership learns nothing about the site', async () => {
    mocks.memberDocs.clear();

    expect((await call({ field: 'folder', value: 'C:\\' })).status).toBe(404);
    expect(queuedCommand()).toBeNull();
  });

  it('an api key is refused even with machine write and an owner behind it', async () => {
    seedMember(SITE, 'user-1', 'owner');
    mockResolveAuth.mockResolvedValue(apiKey([WRITE_SCOPE]));

    expect((await call({ field: 'folder', value: 'C:\\' })).status).toBe(403);
    expect(queuedCommand()).toBeNull();
  });

  it('an api key is refused even with site write and an owner behind it', async () => {
    seedMember(SITE, 'user-1', 'owner');
    mockResolveAuth.mockResolvedValue(apiKey([{ resource: 'site', id: SITE, permissions: ['write'] }]));

    const res = await call({ field: 'folder', value: 'C:\\' });

    expect(res.status).toBe(403);
    expect((await res.json()).detail).toContain('api keys cannot use this route');
    expect(queuedCommand()).toBeNull();
  });

  it('an api key without the scope is refused too', async () => {
    seedMember(SITE, 'user-1', 'owner');
    mockResolveAuth.mockResolvedValue(apiKey([]));

    expect((await call({ field: 'folder', value: 'C:\\' })).status).toBe(403);
    expect(queuedCommand()).toBeNull();
  });
});

describe('the other doors stay shut', () => {
  it('the public command route refuses check_path for a session', async () => {
    seedMember(SITE, 'user-1', 'owner');

    const res = await commandsPOST(
      createMockRequest(`${URL_BASE}/commands`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-1' },
        body: { type: 'check_path', params: { field: 'folder', value: 'C:\\' } },
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unsupported_command_type');
    expect(queuedCommand()).toBeNull();
  });

  it('the public command route refuses check_path for an api key', async () => {
    seedMember(SITE, 'user-1', 'owner');
    mockResolveAuth.mockResolvedValue(apiKey([WRITE_SCOPE]));

    const res = await commandsPOST(
      createMockRequest(`${URL_BASE}/commands`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-2' },
        body: { type: 'check_path', params: { field: 'folder', value: 'C:\\' } },
      }),
      { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
    );

    expect(res.status).toBe(400);
    expect(queuedCommand()).toBeNull();
  });

  it('the action refuses check_path to any caller that is not the dashboard route', async () => {
    await expect(
      executeMachineCommand(
        { siteId: SITE, machineId: MACHINE, actor: { type: 'system', name: 'talon_runner', siteId: SITE }, auditActor: 'system:talon_runner' },
        { type: 'check_path', payload: { field: 'folder', value: 'C:\\' } },
      ),
    ).rejects.toBeInstanceOf(ExecuteMachineCommandError);
    expect(queuedCommand()).toBeNull();
  });
});

describe('what it accepts', () => {
  it.each([
    ['no field', { value: 'C:\\x' }],
    ['an unknown field', { field: 'name', value: 'C:\\x' }],
    ['no value', { field: 'cwd' }],
    ['a non-string value', { field: 'cwd', value: 7 }],
    ['a blank value', { field: 'cwd', value: '   ' }],
    ['a value past the limit', { field: 'cwd', value: `C:\\${'x'.repeat(1024)}` }],
    ['a control character', { field: 'cwd', value: 'C:\\a\u0000b' }],
    ['a newline', { field: 'cwd', value: 'C:\\a\nb' }],
  ])('%s is a 400 and queues nothing', async (_name, body) => {
    const res = await call(body);

    expect(res.status).toBe(400);
    expect(queuedCommand()).toBeNull();
  });

  it('only the field and value reach the agent, so nothing can pose as an override', async () => {
    await call({ field: 'exe_path', value: 'C:\\x.exe', activeHoursOverride: { reason: 'x' }, type: 'reboot_machine' });

    const command = queuedCommand();
    expect(command?.type).toBe('check_path');
    expect(command).not.toHaveProperty('activeHoursOverride');
  });

  it('trims the value', async () => {
    await call({ field: 'exe_path', value: '  C:\\x.exe  ' });

    expect(queuedCommand()?.value).toBe('C:\\x.exe');
  });
});

describe('how it answers', () => {
  it('an offline machine is a 409 and nothing is queued', async () => {
    mocks.get.mockImplementation(() => Promise.resolve(docSnapshot(MACHINE, { online: false })));

    const res = await call({ field: 'exe_path', value: 'C:\\x.exe' });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('machine_offline');
    expect(queuedCommand()).toBeNull();
  });

  it('an unknown machine is a 404', async () => {
    mocks.get.mockImplementation(() => Promise.resolve(docSnapshot(MACHINE, null)));

    expect((await call({ field: 'exe_path', value: 'C:\\x.exe' })).status).toBe(404);
  });

  it('writes an audit entry naming the field and the path', async () => {
    await call({ field: 'folder', value: 'C:\\show' });

    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(jest.mocked(emitMutation).mock.calls[0][0]).toMatchObject({
      kind: 'machine_command_dispatched',
      siteId: SITE,
      actor: 'user:user-1',
      attributes: {
        commandType: 'check_path',
        endpoint: `/api/sites/${SITE}/machines/${MACHINE}/path-check`,
        field: 'folder',
        value: 'C:\\show',
      },
    });
  });
});
