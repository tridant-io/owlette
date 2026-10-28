/**
 * @jest-environment node
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => undefined });
const mockQueryGet = jest.fn().mockResolvedValue({ docs: [] });
const mockWhere = jest.fn();
const mockWarn = jest.fn();
const mockPath: string[] = [];

jest.mock('@/lib/firebase-admin', () => {
  // its own node, so a query read and a document read answer apart
  const query = {
    where: (...args: unknown[]) => {
      mockWhere(...args);
      return query;
    },
    get: () => mockQueryGet(),
  };
  const node = {
    collection: (name: string) => {
      mockPath.push(name);
      return node;
    },
    collectionGroup: (name: string) => {
      mockPath.push(name);
      return query;
    },
    doc: (id: string) => {
      mockPath.push(id);
      return node;
    },
    where: query.where,
    set: (...args: unknown[]) => mockSet(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    get: () => mockGet(),
  };
  return { getAdminDb: () => node };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: (...args: unknown[]) => mockWarn(...args) },
}));

import {
  SwoopSessionStoreError,
  assertNoKeyMaterial,
  createSwoopSession,
  endSwoopSession,
  getSwoopSession,
  listLiveSwoopSessionsForSite,
  removeSwoopViewer,
  setSwoopSessionState,
  syncMachineSwoopViewers,
  upsertSwoopViewer,
} from '@/lib/swoop/sessionStore.server';

const SITE = 'site-a';
const MACHINE = 'machine-x';
const SID = 'sid-1';
const MACHINE_PATH = ['sites', SITE, 'machines', MACHINE];
const NOW = 10_000_000;
// an hour past its lease: lapsed whatever the grace
const LAPSED = NOW - 3_600_000;

beforeEach(() => {
  jest.clearAllMocks();
  mockPath.length = 0;
  mockGet.mockResolvedValue({ exists: false, data: () => undefined });
  mockQueryGet.mockResolvedValue({ docs: [] });
  mockUpdate.mockResolvedValue(undefined);
});

function viewer(viewerId: string, leaseExpiresAt = NOW + 300_000) {
  return { viewerId, uid: `uid-${viewerId}`, ctl: false, joinedAt: NOW - 1_000, leaseExpiresAt };
}

function sessionDoc(sid: string, state: string, viewers: unknown[], machineId = MACHINE) {
  return { sid, siteId: SITE, machineId, state, createdBy: 'user:uid-1', startedAt: NOW - 1_000, viewers };
}

/** A query snapshot over session documents, as both listers read it. */
function sessionDocs(...docs: Array<ReturnType<typeof sessionDoc>>) {
  return { docs: docs.map((data) => ({ id: data.sid, data: () => data })) };
}

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
      viewers: [{ viewerId: 'v1', uid: '', ctl: false, joinedAt: 0, leaseExpiresAt: 0 }],
    });
  });

  it('lists the site\'s unended sessions on every machine and drops a lapsed one', async () => {
    mockQueryGet.mockResolvedValue(
      sessionDocs(
        sessionDoc('s-live', 'live', [viewer('v1')], 'm1'),
        sessionDoc('s-pending', 'pending', [viewer('v2')], 'm2'),
        sessionDoc('s-lapsed', 'live', [viewer('v3', LAPSED)], 'm1'),
      ),
    );

    const sessions = await listLiveSwoopSessionsForSite({ siteId: SITE, nowMs: NOW });

    expect(mockPath).toEqual(['swoop_sessions']);
    expect(mockWhere.mock.calls).toEqual([
      ['siteId', '==', SITE],
      ['state', 'in', ['pending', 'live']],
    ]);
    expect(sessions.map((s) => [s.sid, s.machineId, s.state])).toEqual([
      ['s-live', 'm1', 'live'],
      ['s-pending', 'm2', 'pending'],
    ]);
  });
});

describe('the machine viewer count', () => {
  it('counts the viewers of live, un-lapsed sessions only', async () => {
    mockQueryGet.mockResolvedValue(
      sessionDocs(
        sessionDoc('s-live', 'live', [viewer('v1'), viewer('v2')]),
        sessionDoc('s-pending', 'pending', [viewer('v3')]),
        sessionDoc('s-lapsed', 'live', [viewer('v4', LAPSED)]),
      ),
    );

    await syncMachineSwoopViewers(SITE, MACHINE, NOW);

    expect(mockWhere.mock.calls).toEqual([['state', 'in', ['pending', 'live']]]);
    expect(mockUpdate).toHaveBeenCalledWith({ swoopViewers: 2 });
  });

  it('writes it on the machine record with update, never set', async () => {
    await syncMachineSwoopViewers(SITE, MACHINE, NOW);

    // the read is the machine's own sessions, the write the machine itself
    expect(mockPath).toEqual([...MACHINE_PATH, 'swoop_sessions', ...MACHINE_PATH]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('a machine record that is gone fails the count, not the session write', async () => {
    mockUpdate.mockRejectedValue(new Error('5 NOT_FOUND: No document to update'));

    await expect(
      endSwoopSession({ siteId: SITE, machineId: MACHINE, sid: SID, endReason: 'closed' }),
    ).resolves.toBeUndefined();
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('viewer count'),
      expect.objectContaining({
        data: expect.objectContaining({ siteId: SITE, machineId: MACHINE }),
      }),
    );
  });

  // setSwoopSessionState too: the mint adds its viewer while the session is
  // still pending, so going live is when that viewer starts to count.
  it.each([
    [
      'upsertSwoopViewer',
      () => upsertSwoopViewer({ siteId: SITE, machineId: MACHINE, sid: SID, viewer: viewer('v1') }),
    ],
    [
      'removeSwoopViewer',
      () => removeSwoopViewer({ siteId: SITE, machineId: MACHINE, sid: SID, viewerId: 'v1' }),
    ],
    [
      'endSwoopSession',
      () => endSwoopSession({ siteId: SITE, machineId: MACHINE, sid: SID, endReason: 'closed' }),
    ],
    ['setSwoopSessionState', () => setSwoopSessionState(SITE, MACHINE, SID, 'live')],
  ])('%s recounts once, after its own write', async (_name, mutate) => {
    await mutate();

    expect(mockQueryGet).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueryGet.mock.invocationCallOrder[0],
    );
  });

  it('writes 0 when the machine\'s last session ends', async () => {
    // the ended record no longer matches `state in [pending, live]`
    mockQueryGet.mockResolvedValue(sessionDocs());

    await endSwoopSession({ siteId: SITE, machineId: MACHINE, sid: SID, endReason: 'closed' });

    expect(mockUpdate).toHaveBeenCalledWith({ swoopViewers: 0 });
  });
});
