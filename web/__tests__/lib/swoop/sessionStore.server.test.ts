/**
 * @jest-environment node
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => undefined });
const mockPath: string[] = [];

jest.mock('@/lib/firebase-admin', () => {
  const node = {
    collection: (name: string) => {
      mockPath.push(name);
      return node;
    },
    doc: (id: string) => {
      mockPath.push(id);
      return node;
    },
    set: (...args: unknown[]) => mockSet(...args),
    get: () => mockGet(),
  };
  return { getAdminDb: () => node };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));

import {
  SwoopSessionStoreError,
  assertNoKeyMaterial,
  createSwoopSession,
  endSwoopSession,
  getSwoopSession,
  upsertSwoopViewer,
} from '@/lib/swoop/sessionStore.server';

const SITE = 'site-a';
const MACHINE = 'machine-x';
const SID = 'sid-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPath.length = 0;
  mockGet.mockResolvedValue({ exists: false, data: () => undefined });
});

describe('assertNoKeyMaterial', () => {
  it.each([
    'sessionKey',
    'viewerKey',
    'hostToken',
    'viewerJwt',
    'turnCredential',
    'ringSecret',
    'authorization',
  ])('rejects the key-shaped field %s', (field) => {
    expect(() => assertNoKeyMaterial({ [field]: 'anything' })).toThrow(SwoopSessionStoreError);
  });

  it('rejects a key-shaped field however deeply it is nested', () => {
    expect(() => assertNoKeyMaterial({ viewers: [{ viewerId: 'v1', k: 'x', token: 'y' }] })).toThrow(
      /key_shaped_field:viewers\[0\]\.token/,
    );
  });

  it('rejects a token-shaped VALUE under an innocent field name', () => {
    expect(() =>
      assertNoKeyMaterial({ note: 'eyJhbGciOiJFZERTQSJ9.eyJzaWQiOiJzaWQtMSJ9.c2lnbmF0dXJl' }),
    ).toThrow(/token_shaped_value:note/);
  });

  it('accepts the session document as this module actually writes it', () => {
    expect(() =>
      assertNoKeyMaterial({
        sid: SID,
        siteId: SITE,
        machineId: MACHINE,
        state: 'live',
        createdBy: 'uid-1',
        startedAt: 1,
        absoluteExpiresAt: 2,
        endReason: 'idle',
        viewers: [{ viewerId: 'v1', uid: 'uid-1', ctl: true, joinedAt: 1, leaseExpiresAt: 2 }],
      }),
    ).not.toThrow();
  });
});

describe('writes', () => {
  it('creates a session at sites/{s}/machines/{m}/swoop_sessions/{sid}', async () => {
    await createSwoopSession({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      createdBy: 'uid-1',
      startedAt: 1000,
      absoluteExpiresAt: 2000,
    });

    expect(mockPath).toEqual([
      'sites',
      SITE,
      'machines',
      MACHINE,
      'swoop_sessions',
      SID,
    ]);
    const [payload, options] = mockSet.mock.calls[0];
    expect(options).toEqual({ merge: true });
    expect(payload).toMatchObject({ sid: SID, state: 'pending', viewers: [] });
  });

  it('records an endReason so the audit trail says why a session stopped', async () => {
    await endSwoopSession({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      endReason: 'killed',
      viewerReason: 'kill',
      endedAt: 5000,
    });
    expect(mockSet.mock.calls[0][0]).toMatchObject({ viewerReason: 'kill' });
    expect(mockSet.mock.calls[0][0]).toMatchObject({
      state: 'ended',
      endReason: 'killed',
      endedAt: 5000,
      viewers: [],
    });
  });

  it('refuses a write that would carry key material', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ state: 'live', viewers: [] }),
    });
    await expect(
      upsertSwoopViewer({
        siteId: SITE,
        machineId: MACHINE,
        sid: SID,
        viewer: {
          viewerId: 'v1',
          uid: 'uid-1',
          ctl: true,
          joinedAt: 1,
          leaseExpiresAt: 2,
          // A future field addition that smuggles a secret in must fail here.
          viewerKey: 'AAAA',
        } as never,
      }),
    ).rejects.toThrow(SwoopSessionStoreError);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('replaces a rejoining viewer rather than duplicating it', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        state: 'live',
        viewers: [{ viewerId: 'v1', uid: 'uid-1', ctl: false, joinedAt: 1, leaseExpiresAt: 2 }],
      }),
    });
    await upsertSwoopViewer({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      viewer: { viewerId: 'v1', uid: 'uid-1', ctl: true, joinedAt: 9, leaseExpiresAt: 99 },
    });
    expect(mockSet.mock.calls[0][0].viewers).toEqual([
      { viewerId: 'v1', uid: 'uid-1', ctl: true, joinedAt: 9, leaseExpiresAt: 99 },
    ]);
  });
});

describe('reads', () => {
  it('returns null for a session that does not exist', async () => {
    expect(await getSwoopSession(SITE, MACHINE, SID)).toBeNull();
  });

  it('normalises a partial document instead of trusting it', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ state: 'live', viewers: [{ viewerId: 'v1' }] }),
    });
    expect(await getSwoopSession(SITE, MACHINE, SID)).toEqual({
      sid: SID,
      siteId: SITE,
      machineId: MACHINE,
      state: 'live',
      createdBy: '',
      startedAt: 0,
      absoluteExpiresAt: 0,
      viewers: [{ viewerId: 'v1', uid: '', ctl: false, joinedAt: 0, leaseExpiresAt: 0 }],
    });
  });
});
