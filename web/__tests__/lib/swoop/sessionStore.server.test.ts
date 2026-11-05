/**
 * @jest-environment node
 */

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn().mockResolvedValue({ exists: false, data: () => undefined });
const mockQueryGet = jest.fn().mockResolvedValue({ docs: [] });
const mockWhere = jest.fn();
const mockWarn = jest.fn();
const mockViewerNames = jest.fn();
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
    // a transaction reads and writes the same mocks, a query and a document each through its own get
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: (ref: { get: () => unknown }) => ref.get(),
        set: (_ref: unknown, ...args: unknown[]) => mockSet(...args),
      }),
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

// the users read is viewerNames' own; here it answers whatever each test says
jest.mock('@/lib/swoop/viewerNames.server', () => ({
  viewerNames: (...args: unknown[]) => mockViewerNames(...args),
}));

import {
  SwoopSessionStoreError,
  assertNoKeyMaterial,
  endSwoopSession,
  enterSwoopSession,
  getSwoopSession,
  listLiveSwoopSessionsForSite,
  liveSessionToJoin,
  removeSwoopViewers,
  renewSwoopViewerLease,
  setSwoopSessionState,
  syncMachineSwoopViewers,
  type SwoopSession,
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
  mockViewerNames.mockResolvedValue(new Map());
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
  it('creates a session at sites/{s}/machines/{m}/swoop_sessions/{sid}, with its first viewer in it', async () => {
    const entry = await enterSwoopSession({
      siteId: SITE,
      machineId: MACHINE,
      newSid: SID,
      createdBy: 'uid-1',
      viewer: viewer('v1'),
      continuityHash: () => 'c'.repeat(64),
      nowMs: 1000,
    });

    expect(entry).toEqual({ outcome: 'created', sid: SID });
    // the machine's unended sessions, read in the transaction that decides
    expect(mockWhere.mock.calls[0]).toEqual(['state', 'in', ['pending', 'live']]);
    expect(mockPath.slice(0, 5)).toEqual(['sites', SITE, 'machines', MACHINE, 'swoop_sessions']);
    expect(mockPath).toContain(SID);
    const [payload, options] = mockSet.mock.calls[0];
    expect(options).toEqual({ merge: true });
    expect(payload).toMatchObject({
      sid: SID,
      state: 'pending',
      startedAt: 1000,
      viewers: [viewer('v1')],
      continuity: { v1: { uid: 'uid-v1', hash: 'c'.repeat(64) } },
    });
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

  it('names whom a revocation ended it for, and reads it back', async () => {
    await endSwoopSession({ siteId: SITE, machineId: MACHINE, sid: SID, endReason: 'revoked', endedFor: 'uid-removed' });
    const written = mockSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written).toMatchObject({ state: 'ended', endReason: 'revoked', endedFor: 'uid-removed' });

    mockGet.mockResolvedValue({ exists: true, data: () => ({ ...sessionDoc(SID, 'ended', []), ...written }) });
    expect(await getSwoopSession(SITE, MACHINE, SID)).toMatchObject({ endReason: 'revoked', endedFor: 'uid-removed' });
  });

  it('refuses a write that would carry key material', async () => {
    mockQueryGet.mockResolvedValue(sessionDocs(sessionDoc(SID, 'live', [viewer('v1')])));
    await expect(
      enterSwoopSession({
        siteId: SITE,
        machineId: MACHINE,
        newSid: 'sid-new',
        createdBy: 'uid-v2',
        viewer: {
          ...viewer('v2'),
          // A future field addition that smuggles a secret in must fail here.
          viewerKey: 'AAAA',
        } as never,
        nowMs: NOW,
      }),
    ).rejects.toThrow(SwoopSessionStoreError);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('the session a new viewer joins', () => {
  const ago = (ms: number) => NOW - ms;

  /** a viewer that renewed `renewedAgoMs` ago, so its lease runs five minutes from then. */
  function renewing(viewerId: string, renewedAgoMs = 60_000) {
    return {
      viewerId,
      uid: `uid-${viewerId}`,
      ctl: false,
      joinedAt: ago(600_000),
      leaseExpiresAt: ago(renewedAgoMs) + 300_000,
      renewedAt: ago(renewedAgoMs),
    };
  }

  /** a viewer that joined `joinedAgoMs` ago and has not renewed since. */
  function arriving(viewerId: string, joinedAgoMs: number) {
    return { viewerId, uid: `uid-${viewerId}`, ctl: false, joinedAt: ago(joinedAgoMs), leaseExpiresAt: ago(joinedAgoMs) + 300_000 };
  }

  function session(sid: string, over: Partial<SwoopSession> = {}): SwoopSession {
    return {
      sid,
      siteId: SITE,
      machineId: MACHINE,
      state: 'pending',
      createdBy: 'user:uid-v1',
      startedAt: ago(600_000),
      viewers: [renewing('v1')],
      ...over,
    };
  }

  const join = (...sessions: SwoopSession[]) => liveSessionToJoin(sessions, NOW)?.sid ?? null;

  it('is one a viewer is still renewing a lease in', () => {
    expect(join(session('s1'))).toBe('s1');
  });

  it('is one still starting: under a minute old, its first viewer not through to the machine yet', () => {
    expect(join(session('s1', { startedAt: ago(30_000), viewers: [arriving('v1', 30_000)] }))).toBe('s1');
  });

  // a renewal is the page saying it reached the streamer and is still there;
  // a row that never renewed is a page still waiting, which proves nothing.
  it('is not one nobody reached the machine from in its first minute', () => {
    expect(join(session('s1', { startedAt: ago(90_000), viewers: [arriving('v1', 90_000)] }))).toBeNull();
  });

  it('keeps a seat through the grace the host gives a late renewal', () => {
    expect(join(session('s1', { viewers: [renewing('v1', 320_000)] }))).toBe('s1');
  });

  it('is not one whose every lease has run out past that grace', () => {
    expect(join(session('s1', { viewers: [renewing('v1', 340_000)] }))).toBeNull();
  });

  it('is not one that ended, or one nobody is in', () => {
    expect(join(session('s1', { state: 'ended' }))).toBeNull();
    expect(join(session('s1', { viewers: [] }))).toBeNull();
  });

  it('is the newest of two: the machine runs the one it was asked for last', () => {
    expect(join(session('old', { startedAt: ago(900_000) }), session('new', { startedAt: ago(300_000) }))).toBe('new');
  });
});

describe('seats', () => {
  const joiner = { viewerId: 'v9', uid: 'uid-v9', ctl: true, joinedAt: NOW, leaseExpiresAt: NOW + 300_000 };
  const stage = (doc: Record<string, unknown> | null) =>
    mockGet.mockResolvedValue(doc ? { exists: true, data: () => doc } : { exists: false, data: () => undefined });
  /** the machine's unended sessions, as the entry's query reads them. */
  const unended = (...docs: Array<ReturnType<typeof sessionDoc>>) => mockQueryGet.mockResolvedValue(sessionDocs(...docs));
  const enter = () =>
    enterSwoopSession({
      siteId: SITE,
      machineId: MACHINE,
      newSid: 'sid-new',
      createdBy: 'user:uid-v9',
      viewer: joiner,
      continuityHash: (sid) => `${sid}-hash`,
      nowMs: NOW,
    });

  it('joins in one transaction, beside the seats still held, with the joiner’s continuity grant', async () => {
    unended(sessionDoc(SID, 'pending', [viewer('v1'), viewer('v2', LAPSED)]));

    await expect(enter()).resolves.toEqual({ outcome: 'joined', sid: SID });

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.calls[0][0]).toMatchObject({
      viewers: [viewer('v1'), joiner],
      continuity: { v9: { uid: 'uid-v9', hash: `${SID}-hash` } },
    });
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('state');
  });

  it('turns away a fifth person, and counts one person’s several tabs once', async () => {
    unended(sessionDoc(SID, 'pending', ['a', 'b', 'c', 'd'].map((id) => viewer(id))));
    await expect(enter()).resolves.toEqual({ outcome: 'full', sid: SID });
    expect(mockSet).not.toHaveBeenCalled();

    unended(sessionDoc(SID, 'pending', ['a', 'b', 'c', 'd'].map((id) => ({ ...viewer(id), uid: 'uid-same' }))));
    await expect(enter()).resolves.toEqual({ outcome: 'joined', sid: SID });
  });

  it('starts a session of its own when there is none to join, its viewer in it', async () => {
    unended();
    await expect(enter()).resolves.toEqual({ outcome: 'created', sid: 'sid-new' });
    expect(mockSet.mock.calls[0][0]).toMatchObject({
      sid: 'sid-new',
      state: 'pending',
      createdBy: 'user:uid-v9',
      viewers: [joiner],
      continuity: { v9: { uid: 'uid-v9', hash: 'sid-new-hash' } },
    });

    // nobody left in the one there: nothing to join
    mockSet.mockClear();
    unended(sessionDoc(SID, 'pending', [viewer('v1', LAPSED)]));
    await expect(enter()).resolves.toEqual({ outcome: 'created', sid: 'sid-new' });
  });

  it('takes viewers out, drops the lapsed seats with them, and answers who is still in', async () => {
    stage(sessionDoc(SID, 'live', [viewer('v1'), viewer('v2'), viewer('v3', LAPSED)]));

    const left = await removeSwoopViewers({ siteId: SITE, machineId: MACHINE, sid: SID, viewerIds: ['v1'], nowMs: NOW });

    expect(left).toEqual([viewer('v2')]);
    expect(mockSet.mock.calls[0][0].viewers).toEqual([viewer('v2')]);
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('continuity');
  });

  it('spends the continuity of the seats it takes out when the leaving was a decision', async () => {
    stage({
      ...sessionDoc(SID, 'live', [viewer('v1'), viewer('v2')]),
      continuity: { v1: { uid: 'uid-v1', hash: 'a'.repeat(64) }, v2: { uid: 'uid-v2', hash: 'b'.repeat(64) } },
    });

    await removeSwoopViewers({
      siteId: SITE,
      machineId: MACHINE,
      sid: SID,
      viewerIds: ['v1'],
      spendContinuity: true,
      nowMs: NOW,
    });

    expect(mockSet.mock.calls[0][0].continuity).toEqual({ v1: { usedAt: NOW } });
  });

  it('answers null for a session that is not there, and writes nothing', async () => {
    stage(null);
    await expect(
      removeSwoopViewers({ siteId: SITE, machineId: MACHINE, sid: SID, viewerIds: ['v1'], nowMs: NOW }),
    ).resolves.toBeNull();
    expect(mockSet).not.toHaveBeenCalled();
  });

  // in the same write as the seat, so no join can land between the last one out and the end
  it('ends the record with the last seat when asked, and only then', async () => {
    const leave = (viewerIds: string[]) =>
      removeSwoopViewers({
        siteId: SITE,
        machineId: MACHINE,
        sid: SID,
        viewerIds,
        endWhenEmpty: { endReason: 'closed', viewerReason: 'closed' },
        nowMs: NOW,
      });

    stage(sessionDoc(SID, 'live', [viewer('v1'), viewer('v2')]));
    await expect(leave(['v1'])).resolves.toEqual([viewer('v2')]);
    expect(mockSet.mock.calls[0][0]).not.toHaveProperty('state');

    stage(sessionDoc(SID, 'live', [viewer('v1')]));
    await expect(leave(['v1'])).resolves.toEqual([]);
    expect(mockSet.mock.calls[1][0]).toMatchObject({
      viewers: [],
      state: 'ended',
      endReason: 'closed',
      viewerReason: 'closed',
      endedAt: NOW,
    });
  });

  it('leaves a record that already ended with the reason it ended for', async () => {
    stage({ ...sessionDoc(SID, 'ended', []), endReason: 'idle' });

    await expect(
      removeSwoopViewers({
        siteId: SITE,
        machineId: MACHINE,
        sid: SID,
        viewerIds: [],
        endWhenEmpty: { endReason: 'closed' },
        nowMs: NOW,
      }),
    ).resolves.toEqual([]);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('renews one viewer’s lease in a transaction, stamping when, and leaves the others as they were', async () => {
    stage(sessionDoc(SID, 'live', [viewer('v1'), viewer('v2')]));

    await expect(
      renewSwoopViewerLease({
        siteId: SITE,
        machineId: MACHINE,
        sid: SID,
        viewerId: 'v1',
        leaseExpiresAt: NOW + 300_000,
        nowMs: NOW,
      }),
    ).resolves.toBe(true);

    expect(mockSet.mock.calls[0][0].viewers).toEqual([
      { ...viewer('v1'), leaseExpiresAt: NOW + 300_000, renewedAt: NOW },
      viewer('v2'),
    ]);
  });

  it('renews nobody it cannot find', async () => {
    stage(sessionDoc(SID, 'live', [viewer('v2')]));
    await expect(
      renewSwoopViewerLease({ siteId: SITE, machineId: MACHINE, sid: SID, viewerId: 'v1', leaseExpiresAt: NOW, nowMs: NOW }),
    ).resolves.toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
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

describe('the machine viewer count and seats', () => {
  it('counts and lists the seats of live, un-lapsed sessions only, in one update', async () => {
    mockQueryGet.mockResolvedValue(
      sessionDocs(
        sessionDoc('s-live', 'live', [{ ...viewer('v1'), ctl: true }, viewer('v2')]),
        sessionDoc('s-pending', 'pending', [viewer('v3')]),
        sessionDoc('s-lapsed', 'live', [viewer('v4', LAPSED)]),
      ),
    );
    // uid-v2's account is gone, so viewerNames leaves it out
    mockViewerNames.mockResolvedValue(
      new Map([['uid-v1', { email: 'ada@example.com', displayName: 'Ada Lovelace' }]]),
    );

    await syncMachineSwoopViewers(SITE, MACHINE, NOW);

    expect(mockWhere.mock.calls).toEqual([['state', 'in', ['pending', 'live']]]);
    // names for the seats that count, and for no others
    expect(mockViewerNames).toHaveBeenCalledTimes(1);
    expect((mockViewerNames.mock.calls[0][0] as SwoopSession[]).map((session) => session.sid)).toEqual(['s-live']);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    // the name and never the email: every member of the site reads the machine
    expect(mockUpdate).toHaveBeenCalledWith({
      swoopViewers: 2,
      swoopSeats: [
        { uid: 'uid-v1', displayName: 'Ada Lovelace', ctl: true },
        { uid: 'uid-v2', displayName: null, ctl: false },
      ],
    });
  });

  it('writes nothing when the names cannot be read, the count included, and says so', async () => {
    mockQueryGet.mockResolvedValue(sessionDocs(sessionDoc('s-live', 'live', [viewer('v1')])));
    mockViewerNames.mockRejectedValue(new Error('14 UNAVAILABLE'));

    await expect(syncMachineSwoopViewers(SITE, MACHINE, NOW)).resolves.toBeUndefined();

    // the next session write recounts in full, so the machine keeps its last count and seats meanwhile
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('viewer count'),
      expect.objectContaining({
        data: expect.objectContaining({ siteId: SITE, machineId: MACHINE, err: '14 UNAVAILABLE' }),
      }),
    );
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
      'removeSwoopViewers',
      () => removeSwoopViewers({ siteId: SITE, machineId: MACHINE, sid: SID, viewerIds: ['v1'], nowMs: NOW }),
    ],
    [
      'endSwoopSession',
      () => endSwoopSession({ siteId: SITE, machineId: MACHINE, sid: SID, endReason: 'closed' }),
    ],
    ['setSwoopSessionState', () => setSwoopSessionState(SITE, MACHINE, SID, 'live')],
  ])('%s recounts once, after its own write', async (_name, mutate) => {
    mockGet.mockResolvedValue({ exists: true, data: () => sessionDoc(SID, 'live', [viewer('v1'), viewer('v2')]) });

    await mutate();

    expect(mockQueryGet).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueryGet.mock.invocationCallOrder[0],
    );
  });

  it('enterSwoopSession recounts once, after the write it decided on', async () => {
    await enterSwoopSession({
      siteId: SITE,
      machineId: MACHINE,
      newSid: SID,
      createdBy: 'user:uid-v3',
      viewer: viewer('v3'),
      nowMs: NOW,
    });

    // the entry's own read of the machine's sessions, then the recount
    expect(mockQueryGet).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet.mock.invocationCallOrder[0]).toBeLessThan(mockQueryGet.mock.invocationCallOrder[1]);
  });

  it('writes 0 and no seats when the machine\'s last session ends', async () => {
    // the ended record no longer matches `state in [pending, live]`
    mockQueryGet.mockResolvedValue(sessionDocs());

    await endSwoopSession({ siteId: SITE, machineId: MACHINE, sid: SID, endReason: 'closed' });

    expect(mockUpdate).toHaveBeenCalledWith({ swoopViewers: 0, swoopSeats: [] });
  });
});
