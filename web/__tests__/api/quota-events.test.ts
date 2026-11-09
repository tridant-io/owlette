/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedMember,
  seedSiteOwner,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));
jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    constructor(private readonly ms: number) {}
    toMillis(): number {
      return this.ms;
    }
    static fromMillis(ms: number): MockTimestamp {
      return new MockTimestamp(ms);
    }
  }
  return {
    FieldValue: { serverTimestamp: () => '__SERVER_TS__', delete: () => '__DELETE__' },
    Timestamp: MockTimestamp,
  };
});

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

import { GET as quotaGET } from '@/app/api/sites/[siteId]/quota/route';
import { GET as quotaHistoryGET } from '@/app/api/sites/[siteId]/quota/history/route';
import { GET as eventsGET } from '@/app/api/events/stream/route';

const SITE = 'site-alpha';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
  mocks.get.mockResolvedValue(docSnapshot('any', {}));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('GET /api/sites/{siteId}/quota', () => {
  it('returns current quota with pending bytes and alarm serialization', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot('quota', {
        tier: 'pro',
        usedBytes: 1000,
        planLimitBytes: 2000,
        lastAlarmLevel: 0.5,
        lastAlarmAt: 1_700_000_000_000,
        lastReconciledAt: 1_700_000_100_000,
      }),
    );
    mocks.collectionGet
      .mockResolvedValueOnce(
        querySnapshot([
          { id: 'pending-a', data: { bytes: 250 } },
          { id: 'pending-b', data: { bytes: 50 } },
        ]),
      )
      .mockResolvedValueOnce(
        querySnapshot([
          { id: 'alarm-50', data: { threshold: 0.5, firedAt: 1_700_000_000_000 } },
        ]),
      );

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/quota`);
    const res = await quotaGET(req, { params: Promise.resolve({ siteId: SITE }) });
    const body = (await res.json()) as {
      siteId: string;
      usedBytes: number;
      pendingBytes: number;
      committedBytes: number;
      fractionUsed: number | null;
      alarms: Array<{ id: string; firedAt: string | null }>;
    };

    expect(res.status).toBe(200);
    expect(body.siteId).toBe(SITE);
    expect(body.pendingBytes).toBe(300);
    expect(body.committedBytes).toBe(1300);
    expect(body.fractionUsed).toBe(0.65);
    expect(body.alarms[0]).toEqual({
      id: 'alarm-50',
      threshold: 0.5,
      firedAt: '2023-11-14T22:13:20.000Z',
    });
  });

  it('falls back to the standard per-site cap when the doc has no planLimitBytes', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot('quota', { usedBytes: 500 }));
    mocks.collectionGet
      .mockResolvedValueOnce(querySnapshot([]))
      .mockResolvedValueOnce(querySnapshot([]));

    const req = createMockRequest(`http://localhost/api/sites/${SITE}/quota`);
    const res = await quotaGET(req, { params: Promise.resolve({ siteId: SITE }) });
    const body = (await res.json()) as { limitBytes: number };

    expect(res.status).toBe(200);
    expect(body.limitBytes).toBe(1024 ** 4); // 1 TiB
  });
});

describe('GET /api/sites/{siteId}/quota/history', () => {
  it('rejects unsupported period values', async () => {
    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/quota/history?period=365d`,
    );
    const res = await quotaHistoryGET(req, { params: Promise.resolve({ siteId: SITE }) });
    expect(res.status).toBe(400);
  });

  it('returns daily buckets with empty days preserved', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 3, 28, 12));
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'storage',
          data: {
            kind: 'storage_snapshot',
            bytes: 1000,
            timestamp: Date.UTC(2026, 3, 28, 1),
          },
        },
        {
          id: 'egress',
          data: {
            kind: 'egress',
            bytes: 300,
            timestamp: Date.UTC(2026, 3, 28, 2),
          },
        },
      ]),
    );

    const req = createMockRequest(
      `http://localhost/api/sites/${SITE}/quota/history?period=7d`,
    );
    const res = await quotaHistoryGET(req, { params: Promise.resolve({ siteId: SITE }) });
    const body = (await res.json()) as {
      days: number;
      daily: Array<{ date: string; storageBytesAvg: number | null; egressBytes: number }>;
    };
    nowSpy.mockRestore();

    expect(res.status).toBe(200);
    expect(body.days).toBe(7);
    expect(body.daily).toHaveLength(7);
    expect(body.daily[body.daily.length - 1]).toMatchObject({
      date: '2026-04-28',
      storageBytesAvg: 1000,
      egressBytes: 300,
    });
  });
});

describe('GET /api/events/stream', () => {
  it('requires siteId', async () => {
    const req = createMockRequest('http://localhost/api/events/stream');
    const res = await eventsGET(req);
    expect(res.status).toBe(400);
  });

  it('rejects unknown event filters before opening a stream', async () => {
    const req = createMockRequest(
      `http://localhost/api/events/stream?siteId=${SITE}&events=bogus.event`,
    );
    const res = await eventsGET(req);
    expect(res.status).toBe(400);
  });

  it('opens a scoped event stream and emits connected metadata', async () => {
    const req = createMockRequest(
      `http://localhost/api/events/stream?siteId=${SITE}&events=version.published`,
    );
    const res = await eventsGET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    const chunk = new TextDecoder().decode(first.value);

    expect(chunk).toContain('event: connected');
    expect(chunk).toContain(`"siteId":"${SITE}"`);
    expect(chunk).toContain('"events":["version.published"]');
    expect(chunk).toContain('"transportOnly":true');
  });
});

// quota and the events stream span every machine on the site, so the _shared
// gate refuses a scoped member of any role (ADR 0016). the real site-access
// adapter runs here, so the scope is read off the member row itself.
describe('a machine scope', () => {
  const SCOPED_MEMBER = 'user-scoped-member';
  const SCOPED_ADMIN = 'user-scoped-admin';
  const MEMBER = 'user-member';
  const realAssertSite = jest.requireActual('@/lib/apiAuth.server').assertUserHasSiteAccess;
  const siteContext = () => ({ params: Promise.resolve({ siteId: SITE }) });

  beforeEach(() => {
    mockAssertSite.mockImplementation(realAssertSite);
    seedSiteOwner(SITE);
    for (const [uid, role] of [[SCOPED_MEMBER, 'member'], [SCOPED_ADMIN, 'admin']] as const) {
      seedMember(SITE, uid, role);
      const key = `${SITE}/${uid}`;
      mocks.memberDocs.set(key, { ...mocks.memberDocs.get(key), machineIds: ['machine-1'] });
    }
    seedMember(SITE, MEMBER, 'member');
  });

  describe.each([
    ['the quota', () => quotaGET(createMockRequest(`http://localhost/api/sites/${SITE}/quota`), siteContext())],
    [
      'the quota history',
      () => quotaHistoryGET(createMockRequest(`http://localhost/api/sites/${SITE}/quota/history?period=7d`), siteContext()),
    ],
    [
      'the events stream',
      () => eventsGET(createMockRequest(`http://localhost/api/events/stream?siteId=${SITE}&events=version.published`)),
    ],
  ] as const)('%s', (_route, call) => {
    it.each([
      ['a scoped member', SCOPED_MEMBER],
      ['a scoped admin', SCOPED_ADMIN],
    ])('refuses %s with 403 before reading anything of the site', async (_who, uid) => {
      mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });

      const res = await call();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ detail: 'capability not granted' });
      expect(mocks.get).not.toHaveBeenCalled();
      expect(mocks.collectionGet).not.toHaveBeenCalled();
    });

    it('CONTROL: still answers a whole-site member 200', async () => {
      mockResolveAuth.mockResolvedValue({ userId: MEMBER, keyContext: null });

      const res = await call();

      expect(res.status).toBe(200);
      // the stream keeps a keepalive timer until it is cancelled
      await res.body?.cancel();
    });
  });
});
