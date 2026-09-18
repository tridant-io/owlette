/** @jest-environment node */

/**
 * Http-shape coverage for the user-facing swoop session endpoints:
 *
 *   POST   /api/sites/{siteId}/machines/{machineId}/swoop/sessions
 *   GET    /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}
 *   DELETE /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}
 *
 * The real `authorizedSiteHandler` runs here — the api-key, membership and
 * capability answers are the wrapper's, and mocking it away would prove nothing
 * about the route.
 */

import { generateKeyPairSync } from 'crypto';
import { createMockRequest, parseResponse } from '../helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  seedMember,
  seedSiteOwner,
  apiKeyAuth,
  SITE_OWNER,
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

const capabilityEnforcement = { value: true };
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: capabilityEnforcement.value,
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

const mfaFactors = { totp: false, passkeys: 0 };
jest.mock('@/lib/mfaFactors.server', () => ({
  readMfaFactors: jest.fn(async () => mfaFactors),
  deriveMfaEnrolled: (f: { totp: boolean; passkeys: number }) => f.totp || f.passkeys > 0,
}));

const mockVerifyMfaProof = jest.fn();
jest.mock('@/lib/mfaProof.server', () => {
  const actual = jest.requireActual('@/lib/mfaProof.server');
  return { ...actual, verifyMfaProof: (...a: unknown[]) => mockVerifyMfaProof(...a) };
});

const mockRing = jest.fn(async () => ({ ok: true }));
const mockKill = jest.fn(async () => ({ ok: true }));
jest.mock('@/lib/swoop/signal.server', () => ({
  ringDoorbell: (...a: unknown[]) => mockRing(...a),
  killSession: (...a: unknown[]) => mockKill(...a),
}));

jest.mock('@/lib/swoop/turn.server', () => ({
  mintTurnCredentials: jest.fn(async () => ({ ok: false, reason: 'not_configured' })),
}));

import { POST } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/route';
import {
  GET,
  DELETE,
} from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/route';
import { stepUpSessionBinding } from '@/lib/swoop/policy.server';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const FP = 'sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const SID = 'sid0000000000000000000000000001';

/** Documents the route reads, keyed by their full Firestore path. */
const staged = new Map<string, Record<string, unknown> | null>();

function keypair(): { priv: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64url'),
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'),
  };
}
const KEYS = keypair();

function url(path = ''): string {
  return `http://localhost/api/sites/${SITE}/machines/${MACHINE}/swoop/sessions${path}`;
}

function routeContext(sessionId?: string) {
  return {
    params: Promise.resolve({ siteId: SITE, machineId: MACHINE, ...(sessionId ? { sessionId } : {}) }),
  };
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  mockSession.userId = userId;
  mockSession.expiresAt = Date.now() + 86_400_000;
}

function openWindow(userId: string): void {
  const binding = stepUpSessionBinding({ userId, expiresAt: mockSession.expiresAt });
  staged.set(`users/${userId}/swoop_step_up/${binding}`, {
    openedAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    factorUsed: 'totp',
  });
}

beforeEach(() => {
  process.env.SWOOP_JWT_PRIVATE_KEY = KEYS.priv;
  process.env.SWOOP_JWT_PUBLIC_KEY = KEYS.pub;
  process.env.SWOOP_JWT_KID = 'kid-current';
  process.env.SWOOP_SESSION_MASTER_KEY = 'test-master-key-not-a-real-secret-0123456789';
  process.env.SWOOP_SIGNAL_URL = 'https://swoop-signal.example.workers.dev';

  capabilityEnforcement.value = true;
  mfaFactors.totp = true;
  mfaFactors.passkeys = 0;
  mockRing.mockResolvedValue({ ok: true });
  mockKill.mockResolvedValue({ ok: true });
  mockVerifyMfaProof.mockResolvedValue({ ok: true, factorUsed: 'totp' });

  staged.clear();
  staged.set(`sites/${SITE}/settings/swoop`, { enabled: true });
  staged.set(`sites/${SITE}/machines/${MACHINE}`, { online: true });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('POST swoop/sessions', () => {
  it('refuses an api-key caller with 403 api_key_not_permitted', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(SITE_OWNER));

    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: false, fp: FP } }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('api_key_not_permitted');
  });

  it('refuses a proof-less control request with 401 step_up_required', async () => {
    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: true, fp: FP } }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(401);
    expect(body.code).toBe('step_up_required');
  });

  it('refuses a zero-factor account rather than waving its proof through', async () => {
    mfaFactors.totp = false;
    mfaFactors.passkeys = 0;

    const res = await POST(
      createMockRequest(url(), {
        method: 'POST',
        body: { control: true, fp: FP, mfaProof: { code: '123456' } },
      }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(401);
    expect(body.code).toBe('step_up_required');
    expect(mockVerifyMfaProof).not.toHaveBeenCalled();
  });

  it('with capability_enforcement false, a member without MACHINE_REMOTE_CONTROL is still refused for capability_missing', async () => {
    capabilityEnforcement.value = false;
    signIn(MEMBER);
    openWindow(MEMBER);

    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: true, fp: FP } }),
      routeContext(),
    );

    // The kill switch does not reach swoop's capabilities
    // (`BYPASS_EXEMPT_CAPABILITIES`), so the wrapper answers before the handler
    // and the reason is on the deny audit rather than in the problem body.
    expect(res.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ outcome: 'deny', denyReason: 'capability_missing' }),
    );
  });

  it('refuses a request with no fp with 400', async () => {
    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: false } }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(400);
    expect(body.code).toBe('validation_failed');
  });

  it('refuses a non-member with 404', async () => {
    signIn('user-stranger');
    mocks.userDocs.set('user-stranger', { email: 'x@example.test', role: 'member', sites: [] });

    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: false, fp: FP } }),
      routeContext(),
    );

    expect(res.status).toBe(404);
  });

  it('refuses a watch request when the site has swoop off', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: false, fp: FP } }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('swoop_disabled');
  });

  it('refuses an offline machine with 409 and never rings it', async () => {
    staged.set(`sites/${SITE}/machines/${MACHINE}`, { online: false });

    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: false, fp: FP } }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(409);
    expect(body.code).toBe('machine_offline');
    expect(mockRing).not.toHaveBeenCalled();
  });

  it('creates a control session, rings the sid alone and returns k but never K_session', async () => {
    openWindow(ADMIN);

    const res = await POST(
      createMockRequest(url(), {
        method: 'POST',
        body: { control: true, fp: FP, clientCaps: { codecs: ['h264'] } },
      }),
      routeContext(),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(201);
    const data = body.data as Record<string, unknown>;
    expect(typeof data.sid).toBe('string');
    expect(data.sid).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(data.ctl).toBe(true);
    expect(typeof data.viewerJwt).toBe('string');
    expect(typeof data.k).toBe('string');
    expect(data.signalUrl).toBe(
      `wss://swoop-signal.example.workers.dev/v1/room/${SITE}/${MACHINE}`,
    );
    expect(Object.keys(data)).not.toContain('sessionKey');
    expect(JSON.stringify(body)).not.toContain('K_session');
    // No secret ever reaches a url.
    expect(String(data.signalUrl)).not.toContain(String(data.viewerJwt));
    expect(String(data.signalUrl)).not.toContain(String(data.k));

    expect(mockRing).toHaveBeenCalledWith({ siteId: SITE, machineId: MACHINE, sid: data.sid });

    // The fallback command is a notification, not a carrier (plan.md D9): every
    // site member can read it, so it holds the sid and the envelope, nothing else.
    const commandWrite = mocks.set.mock.calls.find(([payload]) =>
      Object.keys(payload as object).some((key) => key.startsWith('cmd_')),
    );
    expect(commandWrite).toBeDefined();
    const command = Object.values(
      commandWrite?.[0] as Record<string, Record<string, unknown>>,
    )[0];
    expect(command.type).toBe('swoop_session_requested');
    expect(command.sid).toBe(data.sid);
    const serialized = JSON.stringify(command);
    expect(serialized).not.toContain(String(data.viewerJwt));
    expect(serialized).not.toContain(String(data.k));
  });

  it('still returns the session when the doorbell ring fails', async () => {
    openWindow(ADMIN);
    mockRing.mockResolvedValue({ ok: false, reason: 'unreachable' });

    const res = await POST(
      createMockRequest(url(), { method: 'POST', body: { control: true, fp: FP } }),
      routeContext(),
    );

    expect(res.status).toBe(201);
  });
});

describe('GET / DELETE swoop/sessions/{sid}', () => {
  beforeEach(() => {
    staged.set(`sites/${SITE}/machines/${MACHINE}/swoop_sessions/${SID}`, {
      sid: SID,
      state: 'live',
      createdBy: `user:${ADMIN}`,
      startedAt: Date.now(),
      absoluteExpiresAt: Date.now() + 3_600_000,
      viewers: [],
    });
  });

  it('returns the session state', async () => {
    const res = await GET(createMockRequest(url(`/${SID}`)), routeContext(SID));
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).state).toBe('live');
  });

  it('404s an unknown session', async () => {
    staged.delete(`sites/${SITE}/machines/${MACHINE}/swoop_sessions/${SID}`);

    const res = await GET(createMockRequest(url(`/${SID}`)), routeContext(SID));
    expect(res.status).toBe(404);
  });

  it('ends a session with the caller endReason and broadcasts the kill', async () => {
    const res = await DELETE(
      createMockRequest(url(`/${SID}`), { method: 'DELETE', body: { endReason: 'closed' } }),
      routeContext(SID),
    );
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect((body.data as Record<string, unknown>).endReason).toBe('closed');
    expect(mockKill).toHaveBeenCalledWith({ siteId: SITE, machineId: MACHINE, sid: SID });
  });

  it('refuses an endReason only the host may record', async () => {
    const res = await DELETE(
      createMockRequest(url(`/${SID}`), { method: 'DELETE', body: { endReason: 'lease_expired' } }),
      routeContext(SID),
    );

    expect(res.status).toBe(400);
  });
});
