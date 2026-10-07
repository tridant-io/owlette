/** @jest-environment node */

/**
 * POST /api/sites/{siteId}/machines/{machineId}/swoop/sessions/{sessionId}/stall
 *
 * a viewer's report that its picture froze. it writes one log line and nothing
 * else, so what is under test is who may write it and what it may carry: the
 * session's own viewer, an allow-listed body, and no more than one a session
 * every 30 seconds.
 */

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

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

// the per-session limit; the capability limiter above is the handler wrapper's.
const mockSessionLimit = jest.fn(async (_limiter: unknown, _key: string) => ({ success: true }) as {
  success: boolean;
  retryAfter?: number;
});
jest.mock('@/lib/rateLimit', () => ({
  ...jest.requireActual('@/lib/rateLimit'),
  checkRateLimit: (limiter: unknown, key: string) => mockSessionLimit(limiter, key),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

const mockWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    warn: (...a: unknown[]) => mockWarn(...a),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
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

import { POST } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/sessions/[sessionId]/stall/route';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const SID = 'sid0000000000000000000000000001';
const VIEWER = 'viewer000000000000000000000001';
const SESSION_PATH = `sites/${SITE}/machines/${MACHINE}/swoop_sessions/${SID}`;

const REPORT = {
  viewerId: VIEWER,
  kind: 'decode',
  action: 'reconnect',
  codec: 'hevc',
  stalledMs: 3012,
  hostFrames: 180,
  before: { packetsReceived: 51200, framesReceived: 9100, framesDecoded: 9040, codecMimeType: 'video/H265' },
  after: {
    packetsReceived: 52900,
    framesReceived: 9280,
    framesDecoded: 9040,
    framesPerSecond: 0,
    decoderImplementation: 'ExternalDecoder (D3D11VideoDecoder)',
    codecMimeType: 'video/H265',
  },
};

const staged = new Map<string, Record<string, unknown> | null>();

function stageSession(opts: { uid?: string; state?: string } = {}): void {
  const startedAt = Date.now();
  staged.set(SESSION_PATH, {
    sid: SID,
    state: opts.state ?? 'live',
    createdBy: `user:${opts.uid ?? ADMIN}`,
    startedAt,
    viewers: [
      { viewerId: VIEWER, uid: opts.uid ?? ADMIN, ctl: true, joinedAt: startedAt, leaseExpiresAt: startedAt + 300_000 },
    ],
  });
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  mockSession.userId = userId;
  mockSession.expiresAt = Date.now() + 86_400_000;
}

function request(body: Record<string, unknown> = REPORT, headers?: Record<string, string>) {
  return createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/swoop/sessions/${SID}/stall`, {
    method: 'POST',
    body,
    headers,
  });
}

const routeContext = {
  params: Promise.resolve({ siteId: SITE, machineId: MACHINE, sessionId: SID }),
};

beforeEach(() => {
  staged.clear();
  staged.set(`sites/${SITE}/settings/swoop`, { enabled: true });
  stageSession();
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );
  mockWarn.mockClear();
  mockSessionLimit.mockClear();
  mockSessionLimit.mockImplementation(async () => ({ success: true }));

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

const stallLines = () => mockWarn.mock.calls.filter(([, options]) => options?.context === 'swoop/stall');

describe('POST swoop/sessions/{sid}/stall', () => {
  it('writes one structured log line for the session’s own viewer and answers 204', async () => {
    const res = await POST(request(), routeContext);

    expect(res.status).toBe(204);
    expect(stallLines()).toEqual([
      [
        expect.stringMatching(/^\[swoop\/stall\]/),
        { context: 'swoop/stall', data: { siteId: SITE, machineId: MACHINE, sid: SID, ...REPORT } },
      ],
    ]);
    // nothing is stored.
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('takes a negative packetsLost, which the stats spec allows for duplicates', async () => {
    const res = await POST(request({ ...REPORT, after: { ...REPORT.after, packetsLost: -3 } }), routeContext);
    expect(res.status).toBe(204);
  });

  it('refuses an api-key caller with 403 api_key_not_permitted', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(SITE_OWNER));
    stageSession({ uid: SITE_OWNER });

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(403);
    expect(body.code).toBe('api_key_not_permitted');
    expect(stallLines()).toHaveLength(0);
  });

  it.each([
    ['a field outside the allow-list', { ...REPORT, note: 'hello' }, 'note'],
    ['a candidate address in the stats', { ...REPORT, after: { ...REPORT.after, address: '192.168.1.20' } }, 'after.address'],
    ['a kind it does not know', { ...REPORT, kind: 'gpu' }, 'kind'],
    ['an action it does not know', { ...REPORT, action: 'reboot' }, 'action'],
    ['a counter that is not a number', { ...REPORT, before: { framesDecoded: '9040' } }, 'before.framesDecoded'],
    ['a negative duration', { ...REPORT, stalledMs: -1 }, 'stalledMs'],
    ['a frame count that is not a whole number', { ...REPORT, hostFrames: 4.5 }, 'hostFrames'],
    ['a negative counter other than packetsLost', { ...REPORT, before: { framesReceived: -1 } }, 'before.framesReceived'],
    ['a codec mime type that is not one', { ...REPORT, after: { codecMimeType: 'text/html' } }, 'after.codecMimeType'],
    ['no viewer id', { ...REPORT, viewerId: undefined }, 'viewerId'],
  ])('refuses %s with 400', async (_what, body, field) => {
    const res = await POST(request(body as Record<string, unknown>), routeContext);
    const { status, body: problem } = await parseResponse(res);

    expect(status).toBe(400);
    expect(Object.keys((problem.errors ?? {}) as Record<string, unknown>)).toEqual([field]);
    expect(stallLines()).toHaveLength(0);
  });

  it('refuses a body over 4 KB with 413', async () => {
    const res = await POST(
      request({ ...REPORT, after: { ...REPORT.after, decoderImplementation: 'x'.repeat(5000) } }),
      routeContext,
    );
    expect(res.status).toBe(413);
  });

  it('refuses another user’s viewer row as if it did not exist', async () => {
    stageSession({ uid: MEMBER });

    const res = await POST(request(), routeContext);
    expect(res.status).toBe(404);
    expect(stallLines()).toHaveLength(0);
  });

  it('refuses a report for an ended session', async () => {
    stageSession({ state: 'ended' });

    const res = await POST(request(), routeContext);
    expect(res.status).toBe(404);
  });

  it('refuses once the site turns swoop off', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const res = await POST(request(), routeContext);
    const { status, body } = await parseResponse(res);
    expect(status).toBe(403);
    expect(body.code).toBe('swoop_disabled');
  });

  it('holds a session to one report every 30 seconds, keyed on the session', async () => {
    mockSessionLimit.mockImplementation(async () => ({ success: false, retryAfter: 30 }));

    const res = await POST(request(), routeContext);

    expect(res.status).toBe(429);
    expect(mockSessionLimit.mock.calls.map(([, key]) => key)).toEqual([`swoop_stall:${SITE}:${MACHINE}:${SID}`]);
    expect(stallLines()).toHaveLength(0);
  });
});
