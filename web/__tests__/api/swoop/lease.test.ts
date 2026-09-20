/** @jest-environment node */

/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}/lease
 *
 * The lease is where authorisation is re-checked while a session runs, so these
 * cases are all about a grant going away underneath a live viewer: membership,
 * site enablement, the machine exclusion list, the capability, and the 12-hour
 * cap that no renewal moves.
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

import { POST } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/lease/route';
import { SWOOP_SESSION_CAP_SECONDS } from '@/lib/swoop/policy.server';
import { verifySwoopToken } from '@/lib/swoop/tokens.server';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const FP = 'sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const SID = 'sid0000000000000000000000000001';
const VIEWER = 'viewer000000000000000000000001';

const staged = new Map<string, Record<string, unknown> | null>();

function keypair(): { priv: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64url'),
    pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64url'),
  };
}
const KEYS = keypair();

const SESSION_PATH = `sites/${SITE}/machines/${MACHINE}/swoop_sessions/${SID}`;

function stageSession(opts: { startedAt?: number; ctl?: boolean; uid?: string } = {}): void {
  const startedAt = opts.startedAt ?? Date.now();
  staged.set(SESSION_PATH, {
    sid: SID,
    state: 'live',
    createdBy: `user:${opts.uid ?? ADMIN}`,
    startedAt,
    absoluteExpiresAt: startedAt + SWOOP_SESSION_CAP_SECONDS * 1000,
    viewers: [
      {
        viewerId: VIEWER,
        uid: opts.uid ?? ADMIN,
        ctl: opts.ctl ?? false,
        joinedAt: startedAt,
        leaseExpiresAt: startedAt + 300_000,
      },
    ],
  });
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  mockSession.userId = userId;
  mockSession.expiresAt = Date.now() + 86_400_000;
}

function request(body: Record<string, unknown> = { viewerId: VIEWER, fp: FP }) {
  return createMockRequest(
    `http://localhost/api/sites/${SITE}/machines/${MACHINE}/swoop/sessions/${SID}/lease`,
    { method: 'POST', body },
  );
}

const routeContext = {
  params: Promise.resolve({ siteId: SITE, machineId: MACHINE, sessionId: SID }),
};

beforeEach(() => {
  process.env.SWOOP_JWT_PRIVATE_KEY = KEYS.priv;
  process.env.SWOOP_JWT_PUBLIC_KEY = KEYS.pub;
  process.env.SWOOP_JWT_KID = 'kid-current';
  process.env.SWOOP_SESSION_MASTER_KEY = 'test-master-key-not-a-real-secret-0123456789';

  staged.clear();
  staged.set(`sites/${SITE}/settings/swoop`, { enabled: true });
  stageSession();
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('POST swoop/sessions/{sid}/lease', () => {
  it('renews a watch lease and mints a fresh viewer token', async () => {
    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    const data = body.data as Record<string, unknown>;
    expect(typeof data.viewerJwt).toBe('string');
    expect(typeof data.expiresAt).toBe('number');

    const verified = verifySwoopToken(String(data.viewerJwt), {
      audience: 'swoop-host',
      roles: ['viewer'],
      site: SITE,
      machine: MACHINE,
      sid: SID,
      fingerprint: FP,
    });
    expect(verified.ok).toBe(true);
  });

  it('never renews a watch-only viewer into control', async () => {
    stageSession({ ctl: false });

    const res = await POST(request(), routeContext);
    const { body } = await parseResponse(res);

    const verified = verifySwoopToken(String((body.data as Record<string, unknown>).viewerJwt), {
      audience: 'swoop-host',
    });
    expect(verified.ok && verified.claims.ctl).toBe(false);
  });

  it('refuses an api-key caller with 403 api_key_not_permitted', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(SITE_OWNER));
    stageSession({ uid: SITE_OWNER });

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('api_key_not_permitted');
  });

  it('refuses a lease after the caller was removed from the site', async () => {
    signIn('user-stranger');
    mocks.userDocs.set('user-stranger', { email: 'x@example.test', role: 'member', sites: [] });

    const res = await POST(request(), routeContext);

    // 404, not 403: the site-access gate answers identically for "no such site"
    // and "no standing on it", deliberately (`authorizedHandler.server.ts`).
    expect(res.status).toBe(404);
  });

  it('refuses a control lease once the capability is gone, with 403 capability_missing', async () => {
    stageSession({ ctl: true, uid: MEMBER });
    signIn(MEMBER);

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('capability_missing');
  });

  it('refuses a lease once the site turns swoop off', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('swoop_disabled');
  });

  it('refuses a lease once the machine is excluded', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, {
      enabled: true,
      excludedMachineIds: [MACHINE],
    });

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('machine_excluded');
  });

  it('refuses a lease past the 12 hour cap with 403 session_cap_reached', async () => {
    stageSession({ startedAt: Date.now() - (SWOOP_SESSION_CAP_SECONDS * 1000 + 1000) });

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('session_cap_reached');
  });

  /**
   * The cap is absolute and no renewal moves it, so the refusal IS the end of
   * the session. Left open, the record answers as live to the revocation sweep
   * forever and nothing else would ever close it.
   */
  it('closes the record when the cap ends the session', async () => {
    stageSession({ startedAt: Date.now() - (SWOOP_SESSION_CAP_SECONDS * 1000 + 1000) });

    await POST(request(), routeContext);

    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'ended', endReason: 'session_cap', viewers: [] }),
      { merge: true },
    );
  });

  it('leaves the record alone on a refusal the session can come back from', async () => {
    // A site switched off, a membership restored: recoverable, so the session
    // is refused this renewal and not ended.
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const res = await POST(request(), routeContext);

    expect(res.status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('still answers 403 when the record cannot be closed at the cap', async () => {
    stageSession({ startedAt: Date.now() - (SWOOP_SESSION_CAP_SECONDS * 1000 + 1000) });
    mocks.set.mockRejectedValueOnce(new Error('firestore down'));

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    // The refusal is the enforcement; the record is bookkeeping behind it.
    expect(status).toBe(403);
    expect(body.code).toBe('session_cap_reached');
  });

  it('refuses another user’s viewer row as if it did not exist', async () => {
    stageSession({ uid: MEMBER });

    const res = await POST(request(), routeContext);
    expect(res.status).toBe(404);
  });

  it('refuses a renewal with no fp', async () => {
    const res = await POST(request({ viewerId: VIEWER }), routeContext);
    expect(res.status).toBe(400);
  });

  it('refuses a renewal for an ended session', async () => {
    staged.set(SESSION_PATH, { ...(staged.get(SESSION_PATH) as object), state: 'ended' });

    const res = await POST(request(), routeContext);
    expect(res.status).toBe(404);
  });

  // A lapsed lease is how a removed member loses a live session, so the refusal
  // is evidence — it lands in `sites/{siteId}/audit_log`, never in the site feed.
  it('records a lease refusal as a deny naming the session', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    await POST(request(), routeContext);

    const rows = (writeAuditEntry.mock.calls as [string, Record<string, unknown>][])
      .filter(([, entry]) => (entry.metadata as { event?: string } | undefined)?.event === 'lease_denied')
      .map(([, entry]) => entry);
    expect(rows).toEqual([
      expect.objectContaining({
        outcome: 'deny',
        denyReason: 'swoop_disabled',
        target: { kind: 'swoop_session', id: SID, machineId: MACHINE },
      }),
    ]);
  });
});
