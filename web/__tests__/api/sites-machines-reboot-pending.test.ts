/** @jest-environment node */

/**
 * DELETE /api/sites/{siteId}/machines/{machineId}/reboot-pending.
 *
 * The flag is cloud state the agent writes and only its own next service start
 * clears locally, so dismissal cannot be an agent command — that is what made
 * the banner un-dismissable on a machine that had been offline for days. This
 * route clears the field itself and relays the command best-effort; an offline
 * machine still gets a clean 200 with `commandId: null`.
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

const mockResolveAuth = jest.fn();

jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

import { emitMutation } from '@/lib/auditLogClient';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import type { ResolvedAuth } from '@/lib/apiAuth.server';

import { DELETE as rebootPendingDELETE } from '@/app/api/sites/[siteId]/machines/[machineId]/reboot-pending/route';

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const MACHINE_PATH = `sites/${SITE}/machines/${MACHINE}`;

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

function authedSession(): ResolvedAuth {
  return { userId: 'user-1', keyContext: null };
}

function authedKey(scopes: ApiKeyScope[]): ResolvedAuth {
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

/** Path-addressed so the wrapper's own reads can't shift what the route sees. */
function seedMachine(data: Record<string, unknown> | null): void {
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(
      path === MACHINE_PATH ? docSnapshot(MACHINE, data) : docSnapshot('any', null),
    ),
  );
}

function callDelete() {
  const req = createMockRequest(
    `http://localhost/api/sites/${SITE}/machines/${MACHINE}/reboot-pending`,
    { method: 'DELETE' },
  );
  return rebootPendingDELETE(req, {
    params: Promise.resolve({ siteId: SITE, machineId: MACHINE }),
  });
}

/** The queued agent command, or null when nothing was relayed. */
function relayedCommand(): Record<string, unknown> | null {
  const mergeCalls = mocks.set.mock.calls.filter(
    (c: unknown[]) => (c[1] as { merge?: boolean })?.merge === true,
  );
  if (mergeCalls.length === 0) return null;
  const envelope = mergeCalls[mergeCalls.length - 1][0] as Record<
    string,
    Record<string, unknown>
  >;
  return envelope[Object.keys(envelope)[0]];
}

const CLEARED = { active: false, processName: null, reason: null, timestamp: null };

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAuth.mockResolvedValue(authedSession());
  mocks.siteDocs.clear();
  mocks.memberDocs.clear();
  mocks.userDocs.clear();
  mocks.siteDocs.set(SITE, { owner: 'user-1' });
  seedMember(SITE, 'user-1', 'owner');
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('DELETE /api/sites/{siteId}/machines/{machineId}/reboot-pending', () => {
  it('clears the flag on an OFFLINE machine and reports no agent command', async () => {
    seedMachine({
      online: false,
      rebootPending: {
        active: true,
        processName: 'lab-sleep',
        reason: 'lab-sleep crashed 9 times',
        timestamp: 1,
      },
    });

    const res = await callDelete();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ machineId: MACHINE, commandId: null });

    expect(mocks.update).toHaveBeenCalledWith({ rebootPending: CLEARED });
    // The command executor refuses an offline machine; that must not undo the clear.
    expect(relayedCommand()).toBeNull();

    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine_command_dispatched',
        siteId: SITE,
        targetId: MACHINE,
        attributes: expect.objectContaining({
          commandType: 'dismiss_reboot_pending',
          method: 'DELETE',
          machineId: MACHINE,
          agentCommandId: null,
        }),
      }),
    );
  });

  it('clears a flag whose processName is null', async () => {
    seedMachine({
      online: false,
      rebootPending: { active: true, processName: null, reason: null, timestamp: null },
    });

    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ rebootPending: CLEARED });
  });

  it('relays the agent command when the machine is online, carrying the process name', async () => {
    seedMachine({
      online: true,
      rebootPending: { active: true, processName: 'lab-sleep', reason: 'crashed', timestamp: 1 },
    });

    const res = await callDelete();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.commandId).toMatch(/^cmd_/);
    expect(mocks.update).toHaveBeenCalledWith({ rebootPending: CLEARED });
    expect(relayedCommand()).toEqual(
      expect.objectContaining({ type: 'dismiss_reboot_pending', process_name: 'lab-sleep' }),
    );
  });

  it('omits process_name from the relay when the flag carried none', async () => {
    seedMachine({
      online: true,
      rebootPending: { active: true, processName: null, reason: null, timestamp: null },
    });

    await callDelete();

    expect(relayedCommand()).not.toHaveProperty('process_name');
  });

  it('404s on a machine that does not exist, without writing', async () => {
    seedMachine(null);

    const res = await callDelete();

    expect(res.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('accepts an api key scoped machine=<id>:write', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['write'] }]),
    );
    seedMachine({ online: false, rebootPending: { active: true } });

    const res = await callDelete();

    expect(res.status).toBe(200);
  });

  it('403 scope_insufficient when the key only holds machine:read', async () => {
    mockResolveAuth.mockResolvedValue(
      authedKey([{ resource: 'machine', id: MACHINE, permissions: ['read'] }]),
    );
    seedMachine({ online: false, rebootPending: { active: true } });

    const res = await callDelete();

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('scope_insufficient');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('403 — a plain member may not dismiss (MACHINE_EXEC_COMMAND)', async () => {
    mocks.siteDocs.set(SITE, { owner: 'someone-else' });
    seedMember(SITE, 'someone-else', 'owner');
    mocks.userDocs.set('user-1', { role: 'member', sites: [SITE] });
    seedMember(SITE, 'user-1', 'member');
    seedMachine({ online: false, rebootPending: { active: true } });

    const res = await callDelete();

    expect(res.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
