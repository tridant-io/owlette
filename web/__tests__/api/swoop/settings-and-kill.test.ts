/** @jest-environment node */

/**
 * Http-shape coverage for the site enablement and kill-switch endpoints:
 *
 *   PATCH /api/sites/{siteId}/swoop-settings
 *   POST  /api/sites/{siteId}/machines/{machineId}/swoop/kill
 *
 * The real `authorizedSiteHandler` runs here, so the membership and capability
 * answers are the wrapper's own. The sessions route appears once, to prove the
 * per-machine exclusion the settings document carries actually refuses a
 * session.
 */

import { createMockRequest, parseResponse } from '../helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedMember,
  seedSiteOwner,
} from '../helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const writeAuditEntry = jest.fn();
jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: (...a: unknown[]) => writeAuditEntry(...a),
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

const mockSession = { userId: '', expiresAt: 0 };
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: jest.fn(async () => mockSession),
}));

jest.mock('@/lib/mfaFactors.server', () => ({
  readMfaFactors: jest.fn(async () => ({ totp: true, passkeys: 0 })),
  deriveMfaEnrolled: () => true,
}));

const mockKill = jest.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string });
jest.mock('@/lib/swoop/signal.server', () => ({
  ringDoorbell: jest.fn(async () => ({ ok: true })),
  killSession: (...a: unknown[]) => mockKill(...(a as [])),
}));

jest.mock('@/lib/swoop/turn.server', () => ({
  mintTurnCredentials: jest.fn(async () => ({ ok: false, reason: 'not_configured' })),
}));

import { PATCH } from '@/app/api/sites/[siteId]/swoop-settings/route';
import { POST as KILL } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/kill/route';
import { POST as START_SESSION } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/route';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const OFFLINE_MACHINE = 'machine-offline';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const SID = 'sid0000000000000000000000000001';
const FP = 'sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

/** Documents the routes read, keyed by their full Firestore path. */
const staged = new Map<string, Record<string, unknown> | null>();

function settingsUrl(): string {
  return `http://localhost/api/sites/${SITE}/swoop-settings`;
}
function killUrl(machineId = MACHINE): string {
  return `http://localhost/api/sites/${SITE}/machines/${machineId}/swoop/kill`;
}

function siteContext() {
  return { params: Promise.resolve({ siteId: SITE }) };
}
function machineContext(machineId = MACHINE) {
  return { params: Promise.resolve({ siteId: SITE, machineId }) };
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  mockSession.userId = userId;
  mockSession.expiresAt = Date.now() + 86_400_000;
}

/** Every `commands/pending` write this test run produced. */
function commandWrites(): Array<Record<string, unknown>> {
  return mocks.set.mock.calls
    .filter(([payload]) => Object.keys(payload as object).every((k) => k.startsWith('cmd_')))
    .flatMap(([payload]) => Object.values(payload as Record<string, Record<string, unknown>>));
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SWOOP_SIGNAL_URL = 'https://signal-dev.example.workers.dev';
  mockKill.mockResolvedValue({ ok: true });

  staged.clear();
  staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });
  staged.set(`sites/${SITE}/machines/${MACHINE}`, { online: true });
  staged.set(`sites/${SITE}/machines/${OFFLINE_MACHINE}`, { online: false });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );
  // The machines query answers with the online machine only — the filter the
  // action asks for is asserted separately.
  mocks.collectionGet.mockResolvedValue(querySnapshot([{ id: MACHINE, data: { online: true } }]));

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('PATCH swoop-settings', () => {
  it('a member cannot PATCH settings', async () => {
    signIn(MEMBER);

    const res = await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: true } }),
      siteContext(),
    );

    expect(res.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ outcome: 'deny', denyReason: 'capability_missing' }),
    );
    expect(commandWrites()).toHaveLength(0);
  });

  it('enabling sends swoop_refresh only to online machines', async () => {
    const res = await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: true } }),
      siteContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as { settings: { enabled: boolean } }).settings.enabled).toBe(true);
    expect(mocks.where).toHaveBeenCalledWith('online', '==', true);

    const commands = commandWrites();
    expect(commands).toHaveLength(1);
    expect(commands[0].type).toBe('swoop_refresh');
    expect(commands[0].machineId).toBe(MACHINE);
    // No session exists on an enablement toggle, so the type carries no sid.
    expect(commands[0]).not.toHaveProperty('sid');
  });

  it('disabling also tells connected machines to re-dial', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: true });

    const res = await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: false } }),
      siteContext(),
    );

    expect(res.status).toBe(200);
    expect(commandWrites().map((c) => c.type)).toEqual(['swoop_refresh']);
  });

  it('a machine that went offline between the query and the write is skipped, not fatal', async () => {
    mocks.collectionGet.mockResolvedValue(
      querySnapshot([
        { id: MACHINE, data: { online: true } },
        { id: OFFLINE_MACHINE, data: { online: true } },
      ]),
    );

    const res = await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: true } }),
      siteContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as { refreshed: number }).refreshed).toBe(1);
    expect(commandWrites().map((c) => c.machineId)).toEqual([MACHINE]);
  });

  it('does not re-notify when enablement did not change', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const res = await PATCH(
      createMockRequest(settingsUrl(), {
        method: 'PATCH',
        body: { enabled: false, membersMayWatch: false },
      }),
      siteContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as { settings: { membersMayWatch: boolean } }).settings.membersMayWatch).toBe(
      false,
    );
    expect(commandWrites()).toHaveLength(0);
  });

  it('refuses a non-boolean enabled', async () => {
    const res = await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: 'true' } }),
      siteContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
  });

  it('an excluded machine is refused a session', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, {
      enabled: true,
      excludedMachineIds: [MACHINE],
    });

    const res = await START_SESSION(
      createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/swoop/sessions`, {
        method: 'POST',
        body: { control: false, fp: FP },
      }),
      machineContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('machine_excluded');
  });
});

describe('POST swoop/kill', () => {
  it('kills over the worker and does not queue a command when it lands', async () => {
    const res = await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockKill).toHaveBeenCalledWith({ siteId: SITE, machineId: MACHINE, sid: SID });
    expect((body.data as { via: string }).via).toBe('signal');
    expect(commandWrites()).toHaveLength(0);
  });

  it('falls back to the polled command when the worker reports no session', async () => {
    mockKill.mockResolvedValue({ ok: false, reason: 'no_doorbell' });

    const res = await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as { via: string }).via).toBe('command');
    expect(commandWrites().map((c) => c.type)).toEqual(['swoop_kill']);
  });

  it('falls back when the worker is unreachable — the fast path being down is why you are killing', async () => {
    mockKill.mockResolvedValue({ ok: false, reason: 'unreachable' });

    const res = await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: {} }),
      machineContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as { via: string }).via).toBe('command');
    // No sid: kill whatever is running.
    expect(commandWrites()[0]).not.toHaveProperty('sid');
  });

  it('kills an offline machine over the command path', async () => {
    mockKill.mockResolvedValue({ ok: false, reason: 'no_doorbell' });

    const res = await KILL(
      createMockRequest(killUrl(OFFLINE_MACHINE), { method: 'POST', body: {} }),
      machineContext(OFFLINE_MACHINE),
    );

    expect(res.status).toBe(200);
    expect(commandWrites().map((c) => c.machineId)).toEqual([OFFLINE_MACHINE]);
  });

  it('kills while the site has swoop switched off', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const res = await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );

    expect(res.status).toBe(200);
    expect(mockKill).toHaveBeenCalled();
  });

  it('a member cannot kill another viewer session', async () => {
    signIn(MEMBER);

    const res = await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );

    expect(res.status).toBe(403);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('refuses a sid that is not an opaque id', async () => {
    const res = await KILL(
      createMockRequest(killUrl(), {
        method: 'POST',
        body: { sid: 'https://evil.example/bundle.json' },
      }),
      machineContext(),
    );

    expect(res.status).toBe(400);
    expect(mockKill).not.toHaveBeenCalled();
  });

  it('404s a machine neither path can reach', async () => {
    mockKill.mockResolvedValue({ ok: false, reason: 'no_doorbell' });
    staged.set(`sites/${SITE}/machines/${MACHINE}`, null);

    const res = await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );

    expect(res.status).toBe(404);
  });
});

describe('the enqueued command document', () => {
  const ENVELOPE = [
    'type',
    'siteId',
    'machineId',
    'timestamp',
    'status',
    'queuedBy',
    'createdAt',
    'expiresAt',
    'auditCorrelationId',
  ];

  it('carries exactly the contract for swoop_kill — sid and the envelope, nothing else', async () => {
    mockKill.mockResolvedValue({ ok: false, reason: 'no_doorbell' });

    await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );

    const command = commandWrites()[0];
    expect(Object.keys(command).sort()).toEqual([...ENVELOPE, 'sid'].sort());
    expect(command.sid).toBe(SID);
    expect(command.queuedBy).toBe(`user:${ADMIN}`);
  });

  it('carries exactly the contract for swoop_refresh — the envelope and no sid', async () => {
    await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: true } }),
      siteContext(),
    );

    const command = commandWrites()[0];
    // Same contract minus the sid: `swoop_refresh` names no session.
    expect(Object.keys(command).sort()).toEqual([...ENVELOPE].sort());
    expect(command.auditCorrelationId).toBe('corr-test');
  });

  it('carries no bundle, jwt, key, turn credential or url', async () => {
    mockKill.mockResolvedValue({ ok: false, reason: 'no_doorbell' });

    await KILL(
      createMockRequest(killUrl(), { method: 'POST', body: { sid: SID } }),
      machineContext(),
    );
    await PATCH(
      createMockRequest(settingsUrl(), { method: 'PATCH', body: { enabled: true } }),
      siteContext(),
    );

    for (const command of commandWrites()) {
      const serialized = JSON.stringify(command);
      expect(serialized).not.toMatch(/https?:|wss?:|turn:|stun:/i);
      expect(serialized).not.toMatch(/bundle|jwt|token|secret|credential|\bkey\b/i);
    }
  });
});
