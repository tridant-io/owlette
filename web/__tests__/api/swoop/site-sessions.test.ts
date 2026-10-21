/** @jest-environment node */

/**
 * Http-shape coverage for the admin swoop page's list:
 *
 *   GET /api/sites/{siteId}/swoop/sessions
 *
 * The real `authorizedSiteHandler` runs here, so the membership and capability
 * answers are the wrapper's own. The store's site lister is mocked — it is a
 * collection-group query, which the shared mock db does not model, and its own
 * filtering is covered in `sessionStore.server.test.ts`.
 */

import { createMockRequest, parseResponse } from '../helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  apiKeyAuth,
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

const mockListLive = jest.fn();
jest.mock('@/lib/swoop/sessionStore.server', () => ({
  listLiveSwoopSessionsForSite: (...a: unknown[]) => mockListLive(...a),
}));

import { GET } from '@/app/api/sites/[siteId]/swoop/sessions/route';

const SITE = 'site-a';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const ANN = 'viewer-ann';
const BOB = 'viewer-bob';
const GONE = 'viewer-gone';
const DELETED = 'viewer-deleted';

/** Documents the route reads, keyed by their full Firestore path. */
const staged = new Map<string, Record<string, unknown> | null>();

function sessionsUrl(): string {
  return `http://localhost/api/sites/${SITE}/swoop/sessions`;
}

function siteContext() {
  return { params: Promise.resolve({ siteId: SITE }) };
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

/**
 * `apiKeyAuth` grants every scope on purpose: the refusal must not depend on
 * the key being under-scoped, or it proves only that the scope check works.
 */
function signInWithApiKey(userId: string): void {
  mockResolveAuth.mockResolvedValue(apiKeyAuth(userId));
}

/** A session as the store hands it back. */
function sessionRecord(
  sid: string,
  machineId: string,
  startedAt: number,
  viewers: Array<{ uid: string; ctl: boolean }>,
  state: string = 'live',
) {
  return {
    sid,
    siteId: SITE,
    machineId,
    state,
    createdBy: `user:${ADMIN}`,
    startedAt,
    viewers: viewers.map((viewer, i) => ({
      viewerId: `v${i}`,
      uid: viewer.uid,
      ctl: viewer.ctl,
      joinedAt: startedAt + i,
      leaseExpiresAt: startedAt + 300_000,
    })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListLive.mockResolvedValue([]);

  staged.clear();
  staged.set(`users/${ANN}`, { email: 'ann@example.test', displayName: 'Ann' });
  staged.set(`users/${BOB}`, { email: 'bob@example.test' });
  staged.set(`users/${DELETED}`, { email: 'gone@example.test', deletedAt: 1 });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('GET swoop/sessions', () => {
  it('a member cannot list the site sessions', async () => {
    signIn(MEMBER);

    const res = await GET(createMockRequest(sessionsUrl()), siteContext());

    expect(res.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ outcome: 'deny', denyReason: 'capability_missing' }),
    );
    expect(mockListLive).not.toHaveBeenCalled();
  });

  it('refuses an api key, even an admin key, before reading anything', async () => {
    signInWithApiKey(ADMIN);

    const res = await GET(createMockRequest(sessionsUrl()), siteContext());

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('api_key_not_permitted');
    expect(mockListLive).not.toHaveBeenCalled();
  });

  it('lists the sessions oldest first, with each viewer named', async () => {
    mockListLive.mockResolvedValue([
      sessionRecord('sid-new', 'machine-2', 2_000, [{ uid: BOB, ctl: false }], 'pending'),
      sessionRecord('sid-old', 'machine-1', 1_000, [
        { uid: ANN, ctl: true },
        { uid: GONE, ctl: false },
        { uid: DELETED, ctl: false },
      ]),
    ]);

    const res = await GET(createMockRequest(sessionsUrl()), siteContext());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect(mockListLive).toHaveBeenCalledWith({ siteId: SITE });
    expect(body).toEqual({
      ok: true,
      data: {
        sessions: [
          {
            sid: 'sid-old',
            machineId: 'machine-1',
            state: 'live',
            startedAt: 1_000,
            viewers: [
              { uid: ANN, email: 'ann@example.test', displayName: 'Ann', ctl: true, joinedAt: 1_000 },
              // an account that is gone, or soft-deleted, keeps its row with no name.
              { uid: GONE, email: null, displayName: null, ctl: false, joinedAt: 1_001 },
              { uid: DELETED, email: null, displayName: null, ctl: false, joinedAt: 1_002 },
            ],
          },
          {
            sid: 'sid-new',
            machineId: 'machine-2',
            state: 'pending',
            startedAt: 2_000,
            viewers: [
              { uid: BOB, email: 'bob@example.test', displayName: null, ctl: false, joinedAt: 2_000 },
            ],
          },
        ],
      },
    });
  });

  it('reads every viewer name in one batch, once per person', async () => {
    mockListLive.mockResolvedValue([
      sessionRecord('sid-a', 'machine-1', 1_000, [{ uid: ANN, ctl: true }]),
      sessionRecord('sid-b', 'machine-2', 2_000, [{ uid: ANN, ctl: false }, { uid: BOB, ctl: false }]),
    ]);

    const res = await GET(createMockRequest(sessionsUrl()), siteContext());

    expect(res.status).toBe(200);
    const userReads = mocks.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.startsWith('users/'));
    expect(userReads).toEqual([`users/${ANN}`, `users/${BOB}`]);
  });

  it('answers an empty list when nothing is running', async () => {
    const res = await GET(createMockRequest(sessionsUrl()), siteContext());
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, data: { sessions: [] } });
  });
});
