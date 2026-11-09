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
import {
  canonicalJson,
  computeChainHash,
} from '@/lib/auditLogVerify';

const mockRequireSiteAuthAndScope = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => {
  class MockTimestamp {
    private readonly ms: number;

    constructor(ms: number) {
      this.ms = ms;
    }

    static fromDate(date: Date): MockTimestamp {
      return new MockTimestamp(date.getTime());
    }

    toDate(): Date {
      return new Date(this.ms);
    }

    toMillis(): number {
      return this.ms;
    }
  }

  return {
    Timestamp: MockTimestamp,
    FieldValue: {
      serverTimestamp: () => ({ __op: 'serverTimestamp' }),
    },
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
}));

jest.mock('@/app/api/_shared', () => ({
  applyAuthDeprecations: (response: Response) => response,
  requireSiteAuthAndScope: (...args: unknown[]) => mockRequireSiteAuthAndScope(...args),
}));

// read only by the real gate the machine scope cases run
const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
}));

import { GET as auditListGET } from '@/app/api/sites/[siteId]/audit-log/route';
import { GET as auditDetailGET } from '@/app/api/sites/[siteId]/audit-log/[recordHash]/route';

const SITE = 'site-alpha';

function routeContext(siteId = SITE) {
  return { params: Promise.resolve({ siteId }) };
}

function auditDoc(id: string, kind = 'api_key_used') {
  return {
    id,
    data: {
      event: {
        kind,
        siteId: SITE,
        actor: 'apiKey:key-1',
        occurredAt: 1_700_000_000_000,
        attributes: { endpoint: '/api/sites/site-alpha/machines' },
      },
      recordedAt: 1_700_000_000_001,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSiteAuthAndScope.mockResolvedValue({
    ok: true,
    userId: 'admin-uid',
    auth: { userId: 'admin-uid', keyContext: null },
    scopeCheck: { isLegacy: false },
  });
  mocks.get.mockResolvedValue(docSnapshot('any', {}));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
});

describe('GET /api/sites/{siteId}/audit-log', () => {
  it('uses the last returned record as the next page token', async () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        auditDoc(first),
        auditDoc(second),
      ]),
    );

    const res = await auditListGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/audit-log?page_size=1`),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.records).toHaveLength(1);
    expect(body.records[0].hash).toBe(first);
    expect(body.next_page_token).toBe(first);
    expect(body.nextPageToken).toBe(first);
  });

  it('accepts legacy limit/cursor aliases while emitting canonical fields', async () => {
    const cursor = 'c'.repeat(64);
    const first = 'd'.repeat(64);
    mocks.get.mockResolvedValueOnce(docSnapshot(cursor, { recordedAt: 1 }));
    mocks.collectionGet.mockResolvedValueOnce(querySnapshot([auditDoc(first)]));

    const res = await auditListGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/audit-log?limit=10&cursor=${cursor}`),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.startAfter).toHaveBeenCalled();
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
  });

  it('pushes kind and actor filters through the collected page', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        auditDoc('e'.repeat(64), 'api_key_used'),
        {
          ...auditDoc('f'.repeat(64), 'roost_mutated'),
          data: {
            ...auditDoc('f'.repeat(64), 'roost_mutated').data,
            event: {
              ...auditDoc('f'.repeat(64), 'roost_mutated').data.event,
              actor: 'user:other',
            },
          },
        },
      ]),
    );

    const res = await auditListGET(
      createMockRequest(
        `http://localhost/api/sites/${SITE}/audit-log?kind=api_key_used&actor=apiKey:key-1`,
      ),
      routeContext(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.records.map((record: { hash: string }) => record.hash)).toEqual(['e'.repeat(64)]);
  });
});

describe('GET /api/sites/{siteId}/audit-log/{recordHash}', () => {
  it('marks non-genesis records invalid when the predecessor is missing', async () => {
    const previousHash = '1'.repeat(64);
    const event = {
      kind: 'api_key_used',
      siteId: SITE,
      actor: 'apiKey:key-1',
      occurredAt: 1_700_000_000_000,
      attributes: { endpoint: '/api/sites/site-alpha/machines' },
    };
    const recordedAt = 1_700_000_000_001;
    const hash = computeChainHash(previousHash, recordedAt, canonicalJson(event));

    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(hash, {
          event,
          recordedAt,
          previousHash,
          hash,
        }),
      )
      .mockResolvedValueOnce(docSnapshot(previousHash, null));

    const res = await auditDetailGET(
      createMockRequest(`http://localhost/api/sites/${SITE}/audit-log/${hash}`),
      { params: Promise.resolve({ siteId: SITE, recordHash: hash }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.verification).toMatchObject({
      ok: false,
      hashValid: true,
      linkageValid: false,
      isGenesis: false,
      predecessorPresent: false,
      reason: 'predecessor_missing',
    });
  });
});

// the audit log spans every machine on the site, so the _shared gate refuses a
// scoped member of any role (ADR 0016). the real gate and site-access adapter
// run here, so the scope is read off the member row itself.
describe('a machine scope', () => {
  const SCOPED_MEMBER = 'user-scoped-member';
  const SCOPED_ADMIN = 'user-scoped-admin';
  const MEMBER = 'user-member';
  const HASH = 'a'.repeat(64);
  const realGate = jest.requireActual('@/app/api/_shared').requireSiteAuthAndScope;

  beforeEach(() => {
    mockRequireSiteAuthAndScope.mockImplementation(realGate);
    seedSiteOwner(SITE);
    for (const [uid, role] of [[SCOPED_MEMBER, 'member'], [SCOPED_ADMIN, 'admin']] as const) {
      seedMember(SITE, uid, role);
      const key = `${SITE}/${uid}`;
      mocks.memberDocs.set(key, { ...mocks.memberDocs.get(key), machineIds: ['machine-1'] });
    }
    seedMember(SITE, MEMBER, 'member');
    // a genesis record, so the control reads no predecessor
    mocks.get.mockResolvedValue(docSnapshot(HASH, auditDoc(HASH).data));
  });

  describe.each([
    ['the audit log', () => auditListGET(createMockRequest(`http://localhost/api/sites/${SITE}/audit-log`), routeContext())],
    [
      'an audit record',
      () =>
        auditDetailGET(createMockRequest(`http://localhost/api/sites/${SITE}/audit-log/${HASH}`), {
          params: Promise.resolve({ siteId: SITE, recordHash: HASH }),
        }),
    ],
  ] as const)('%s', (_route, call) => {
    it.each([
      ['a scoped member', SCOPED_MEMBER],
      ['a scoped admin', SCOPED_ADMIN],
    ])('refuses %s with 403 before reading it', async (_who, uid) => {
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
    });
  });
});
