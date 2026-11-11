/** @jest-environment node */

/**
 * Unit tests for `web/lib/hoot/followupSweep.server.ts` — the follow-up pass of
 * the talons cron sweep.
 *
 * Pins the behaviours the feature turns on: a due follow-up starts a turn
 * that CONTINUES its chat (history preserved), a watched command finishing
 * early pulls the turn forward, the status flip is the claim so overlapping
 * sweeps fire once, access is re-resolved at fire time (a departed user never
 * runs) under the scheduling turn's recorded tier ceiling (a capped turn cannot
 * promise itself the owner's reach), and a live turn is never superseded — the
 * follow-up goes back to `scheduled` and waits.
 *
 * The target is re-resolved the same way: the fire lands on the set the
 * scheduling turn was aimed at, minus whatever has left the site, gone offline
 * or had hoot switched off — and fails rather than dispatching when nothing is
 * left. An early fire is gated on that set naming exactly ONE machine.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { UIMessage } from 'ai';

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { delete: () => ({ __op: 'delete' }) },
  // `@/lib/firestoreTime.server` does `value instanceof Timestamp`, so the
  // binding must exist even though the fixtures use Dates.
  Timestamp: class Timestamp {},
}));

jest.mock('@/lib/hoot-utils.server', () => {
  class SiteAccessError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'SiteAccessError';
      this.code = code;
    }
  }
  return {
    __esModule: true,
    SiteAccessError,
    verifyUserSiteAccess: jest.fn(),
    resolveHootTargets: jest.fn(),
  };
});

jest.mock('@/lib/hoot/turnStore.server', () => {
  class TurnActiveError extends Error {
    readonly chatId: string;
    readonly activeTurnId: string;
    constructor(chatId: string, activeTurnId: string) {
      super(`a turn is already running for chat ${chatId}`);
      this.name = 'TurnActiveError';
      this.chatId = chatId;
      this.activeTurnId = activeTurnId;
    }
  }
  return {
    __esModule: true,
    TurnActiveError,
    acquireTurnLock: jest.fn(),
    generateTurnId: jest.fn(() => 'turn_fixed'),
  };
});

jest.mock('@/lib/hoot/turnRunner.server', () => ({
  __esModule: true,
  startTurn: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { SiteAccessError, resolveHootTargets, verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import { TurnActiveError, acquireTurnLock } from '@/lib/hoot/turnStore.server';
import { startTurn } from '@/lib/hoot/turnRunner.server';
import { fireDueFollowups } from '@/lib/hoot/followupSweep.server';

const verifyUserSiteAccessMock = verifyUserSiteAccess as jest.Mock;
const resolveHootTargetsMock = resolveHootTargets as jest.Mock;
const acquireTurnLockMock = acquireTurnLock as jest.Mock;
const startTurnMock = startTurn as jest.Mock;

const MIN = 60_000;

/** What the resolver hands back for a healthy target. */
function resolvedOn(ids: string[], fanOut = ids.length !== 1) {
  return { ok: true, resolved: { ids, fanOut, skipped: { offline: [], disabled: [] } } };
}
const ADMIN_ACCESS = {
  role: 'admin',
  siteRole: 'owner',
  swoopMode: null,
  standing: { role: 'owner', swoopMode: null, machineIds: null },
  isSuperadmin: false,
  isSiteAdmin: true,
  isSiteOwner: true,
};

/** Follow-up docs by id. The claim transaction reads and writes through this map. */
const followups = new Map<string, Record<string, unknown>>();
/** Chat docs by id — the runner's history source. */
const chats = new Map<string, Record<string, unknown>>();
/** `commands/completed` entry maps, keyed `${siteId}/${machineId}`. */
const completed = new Map<string, Record<string, unknown>>();

const followupUpdate = jest.fn();
const completedGet = jest.fn();
const queryWhere = jest.fn();
const queryOrderBy = jest.fn();
const queryLimit = jest.fn();

/** Follow-up ids the scan returns, in `runAt` order (production sorts by index). */
let scanResult: string[] = [];
/** Ids whose claim transaction should throw, to prove one failure isn't fatal. */
let claimThrowsFor = new Set<string>();

function applyUpdate(id: string, patch: Record<string, unknown>): void {
  const data = followups.get(id);
  if (!data) return;
  for (const [field, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && (value as { __op?: string }).__op === 'delete') {
      delete data[field];
    } else {
      data[field] = value;
    }
  }
}

function followupRef(id: string) {
  return {
    id,
    update: jest.fn(async (patch: Record<string, unknown>) => {
      followupUpdate(id, patch);
      applyUpdate(id, patch);
    }),
  };
}

const query = {
  where: jest.fn((...args: unknown[]) => {
    queryWhere(...args);
    return query;
  }),
  orderBy: jest.fn((...args: unknown[]) => {
    queryOrderBy(...args);
    return query;
  }),
  limit: jest.fn((...args: unknown[]) => {
    queryLimit(...args);
    return query;
  }),
  get: jest.fn(async () => ({
    docs: scanResult.map((id) => ({ id, ref: followupRef(id), data: () => followups.get(id) })),
  })),
};

const transaction = {
  get: jest.fn(async (ref: { id: string }) => {
    if (claimThrowsFor.has(ref.id)) throw new Error('firestore unavailable');
    return { exists: followups.has(ref.id), data: () => followups.get(ref.id) };
  }),
  update: jest.fn((ref: { id: string }, patch: Record<string, unknown>) => {
    applyUpdate(ref.id, patch);
  }),
};

/** `sites/{siteId}/machines/{machineId}/commands/completed`. */
function sitesCollection() {
  return {
    doc: (siteId: string) => ({
      collection: (machines: string) => {
        if (machines !== 'machines') throw new Error(`unexpected subcollection: ${machines}`);
        return {
          doc: (machineId: string) => ({
            collection: (commands: string) => {
              if (commands !== 'commands') {
                throw new Error(`unexpected subcollection: ${commands}`);
              }
              return {
                doc: (name: string) => ({
                  get: async () => {
                    completedGet(siteId, machineId, name);
                    const entries = completed.get(`${siteId}/${machineId}`);
                    return { exists: entries !== undefined, data: () => entries };
                  },
                }),
              };
            },
          }),
        };
      },
    }),
  };
}

const db = {
  collection: jest.fn((name: string) => {
    if (name === 'cortex-followups') return { ...query, doc: (id: string) => followupRef(id) };
    if (name === 'chats') {
      return {
        doc: (id: string) => ({
          get: async () => ({ exists: chats.has(id), data: () => chats.get(id) }),
        }),
      };
    }
    if (name === 'sites') return sitesCollection();
    throw new Error(`unexpected collection: ${name}`);
  }),
  runTransaction: jest.fn(
    async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  ),
} as unknown as Firestore;

function followup(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatId: 'chat-1',
    siteId: 'node-pa',
    machineId: 'lobby-01',
    userId: 'user-1',
    note: 'did the render finish?',
    runAt: new Date(Date.now() - MIN),
    status: 'scheduled',
    createdAt: new Date(Date.now() - 10 * MIN),
    ...overrides,
  };
}

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

/** Seed a follow-up and put it in the scan result. */
function seedFollowup(id: string, data: Record<string, unknown> = followup()): void {
  followups.set(id, { ...data });
  scanResult.push(id);
}

async function sweep(now = new Date(), budgetMs = 50_000) {
  return fireDueFollowups(db, now, Date.now() + budgetMs);
}

beforeEach(() => {
  jest.clearAllMocks();
  followups.clear();
  chats.clear();
  completed.clear();
  scanResult = [];
  claimThrowsFor = new Set();
  chats.set('chat-1', {
    userId: 'user-1',
    siteId: 'node-pa',
    machineName: 'lobby wall',
    messages: [userMessage('m1', 'restart the player')],
  });
  verifyUserSiteAccessMock.mockResolvedValue(ADMIN_ACCESS);
  resolveHootTargetsMock.mockResolvedValue(resolvedOn(['lobby-01']));
  acquireTurnLockMock.mockResolvedValue(null);
  startTurnMock.mockReturnValue({ cancel: jest.fn(async () => {}) });
});

describe('fireDueFollowups', () => {
  it('scans scheduled follow-ups soonest first, capped', async () => {
    await sweep();

    expect(queryWhere).toHaveBeenCalledWith('status', '==', 'scheduled');
    expect(queryOrderBy).toHaveBeenCalledWith('runAt', 'asc');
    expect(queryLimit).toHaveBeenCalledWith(25);
  });

  it('fires a due follow-up as a turn that continues its chat', async () => {
    seedFollowup('fu-1');

    const counts = await sweep();

    expect(counts).toEqual({ due: 1, fired: 1, failed: 0, skipped: 0, turnActive: 0 });
    expect(startTurnMock).toHaveBeenCalledTimes(1);
    expect(startTurnMock).toHaveBeenCalledWith(db, {
      chatId: 'chat-1',
      turnId: 'turn_fixed',
      siteId: 'node-pa',
      // The prior history is carried, or the runner's persist would replace the
      // conversation with the note alone.
      messages: [
        userMessage('m1', 'restart the player'),
        userMessage('followup_msg_fu-1', '[scheduled follow-up] did the render finish?'),
      ],
      userId: 'user-1',
      access: ADMIN_ACCESS,
      // Re-resolved at fire time against the machines it was scheduled on…
      resolved: { ids: ['lobby-01'], fanOut: false, skipped: { offline: [], disabled: [] } },
      turnTarget: { machineIds: ['lobby-01'], fanOut: false, source: 'followup' },
      // …and NO chatTarget: firing must not move the chat's own selection, and
      // the client-sent `machineName` never reaches the turn.
      priorTurn: null,
      // Nobody is watching a follow-up start, so tier 3 must wait for a person
      // even on a site that lets an attended turn auto-run it.
      forceTier3Approval: true,
      source: 'followup',
    });
    expect(acquireTurnLockMock).toHaveBeenCalledWith(db, 'chat-1', {
      turnId: 'turn_fixed',
      siteId: 'node-pa',
      machineId: 'lobby-01',
      target: { machineIds: ['lobby-01'], fanOut: false, source: 'followup' },
      resolvedMachineIds: ['lobby-01'],
    });
    expect(followups.get('fu-1')).toMatchObject({ status: 'fired', firedAt: expect.any(Date) });
  });

  it('threads the prior turn record recovery index into the fired turn', async () => {
    // The lock returns the whole prior record now; the runner still takes only
    // the index, so a fired follow-up can splice in a dead turn's real results.
    seedFollowup('fu-1');
    acquireTurnLockMock.mockResolvedValue({
      toolCommands: { call_1: { 'lobby-01': { commandId: 'cmd_1' } } },
      fanOut: false,
      resolvedMachineIds: ['lobby-01'],
      messageId: 'msg_a',
      pendingApprovals: [],
    });

    await sweep();

    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      priorTurn: { toolCommands: { call_1: { 'lobby-01': { commandId: 'cmd_1' } } } },
    });
  });

  it('fires under the tier ceiling the scheduling turn recorded', async () => {
    // The owner is a site admin (tier 3 earned), so only the recorded ceiling
    // keeps a promise made by a tier-1-capped turn — a chat-scoped API key — from
    // coming back with tier-2 reach. `startTurn` intersects it with what access
    // earns now, so this is the lower of the two, never a widening.
    // The exact-shape assertion above is the legacy control: a doc with no
    // ceiling passes none and fires on re-resolved access alone.
    seedFollowup('fu-1', followup({ maxToolTier: 1 }));

    await sweep();

    expect(startTurnMock.mock.calls[0][1]).toMatchObject({ maxToolTier: 1 });
  });

  it('fires a subset follow-up on the machines it was scheduled with', async () => {
    // The doc records the scheduling turn's whole target; the legacy `machineId`
    // beside it only ever narrows, so old sweep code cannot widen this.
    seedFollowup(
      'fu-1',
      followup({ targetMachineIds: ['lobby-01', 'lobby-02'], machineId: 'lobby-01' }),
    );
    resolveHootTargetsMock.mockResolvedValue(resolvedOn(['lobby-01', 'lobby-02']));

    await sweep();

    expect(resolveHootTargetsMock).toHaveBeenCalledWith(db, 'node-pa', {
      requested: ['lobby-01', 'lobby-02'],
      machineScope: null,
    });
    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      resolved: { ids: ['lobby-01', 'lobby-02'], fanOut: true },
      turnTarget: { machineIds: ['lobby-01', 'lobby-02'], fanOut: true, source: 'followup' },
    });
  });

  it('fires a recorded site-wide follow-up against every machine, dynamically', async () => {
    seedFollowup('fu-1', followup({ targetMachineIds: null, machineId: '__site__' }));
    resolveHootTargetsMock.mockResolvedValue(resolvedOn(['lobby-01', 'lobby-02']));

    await sweep();

    expect(resolveHootTargetsMock).toHaveBeenCalledWith(db, 'node-pa', { requested: null, machineScope: null });
    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      turnTarget: { machineIds: null, source: 'followup' },
    });
  });

  it('fires a legacy follow-up on the one machine its legacy field names', async () => {
    // No `targetMachineIds`: a doc written before targets were recorded reads as
    // that single machine, never as the site.
    seedFollowup('fu-1');

    await sweep();

    expect(resolveHootTargetsMock).toHaveBeenCalledWith(db, 'node-pa', {
      requested: ['lobby-01'],
      machineScope: null,
    });
    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      turnTarget: { machineIds: ['lobby-01'], fanOut: false, source: 'followup' },
    });
  });

  it('drops a machine that has left the site and fires on the rest', async () => {
    // Decommissioned, or moved to another site: either way it is absent from the
    // listing. The promise is still worth keeping on the machine that remains.
    seedFollowup(
      'fu-1',
      followup({ targetMachineIds: ['lobby-01', 'lobby-gone'], machineId: 'lobby-01' }),
    );
    resolveHootTargetsMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        reason: 'unknown_machine',
        machineIds: ['lobby-gone'],
      })
      .mockResolvedValueOnce(resolvedOn(['lobby-01']));

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 1, failed: 0 });
    expect(resolveHootTargetsMock).toHaveBeenNthCalledWith(2, db, 'node-pa', {
      requested: ['lobby-01'],
      machineScope: null,
    });
    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      resolved: { ids: ['lobby-01'], fanOut: false },
      turnTarget: { machineIds: ['lobby-01'], fanOut: false, source: 'followup' },
    });
    expect(acquireTurnLockMock.mock.calls[0][2]).toMatchObject({
      machineId: 'lobby-01',
      resolvedMachineIds: ['lobby-01'],
    });
  });

  it('fails a follow-up whose machines have all left the site', async () => {
    // Nothing to narrow to, so there is no second resolve — and no turn, which
    // would otherwise queue commands under machine documents that are gone.
    seedFollowup(
      'fu-1',
      followup({ targetMachineIds: ['gone-01', 'gone-02'], machineId: 'gone-01' }),
    );
    resolveHootTargetsMock.mockResolvedValue({
      ok: false,
      status: 400,
      reason: 'unknown_machine',
      machineIds: ['gone-01', 'gone-02'],
    });

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 0, failed: 1 });
    expect(resolveHootTargetsMock).toHaveBeenCalledTimes(1);
    expect(acquireTurnLockMock).not.toHaveBeenCalled();
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(followups.get('fu-1')).toMatchObject({
      status: 'failed',
      // Readable on the record the owner can see: which machines went missing.
      turnError: 'target_machines_gone: gone-01, gone-02',
    });
  });

  it('narrows to the owner scope as it stands now, as for a machine that left the site', async () => {
    // scheduled over two machines; the owner has since been limited to one
    verifyUserSiteAccessMock.mockResolvedValue({
      ...ADMIN_ACCESS,
      siteRole: 'admin',
      standing: { role: 'admin', swoopMode: null, machineIds: ['lobby-01'] },
      isSiteOwner: false,
    });
    seedFollowup(
      'fu-1',
      followup({ targetMachineIds: ['lobby-01', 'lobby-02'], machineId: 'lobby-01' }),
    );
    // the resolver reads a machine outside the scope as one the site does not have
    resolveHootTargetsMock
      .mockResolvedValueOnce({ ok: false, status: 400, reason: 'unknown_machine', machineIds: ['lobby-02'] })
      .mockResolvedValueOnce(resolvedOn(['lobby-01']));

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 1, failed: 0 });
    expect(resolveHootTargetsMock).toHaveBeenNthCalledWith(1, db, 'node-pa', {
      requested: ['lobby-01', 'lobby-02'],
      machineScope: ['lobby-01'],
    });
    expect(resolveHootTargetsMock).toHaveBeenNthCalledWith(2, db, 'node-pa', {
      requested: ['lobby-01'],
      machineScope: ['lobby-01'],
    });
    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      resolved: { ids: ['lobby-01'], fanOut: false },
      turnTarget: { machineIds: ['lobby-01'], fanOut: false, source: 'followup' },
    });
  });

  it('fails a follow-up when every machine it names has left the owner scope', async () => {
    verifyUserSiteAccessMock.mockResolvedValue({
      ...ADMIN_ACCESS,
      siteRole: 'admin',
      standing: { role: 'admin', swoopMode: null, machineIds: ['lobby-09'] },
      isSiteOwner: false,
    });
    seedFollowup('fu-1', followup({ targetMachineIds: ['lobby-01'], machineId: 'lobby-01' }));
    resolveHootTargetsMock.mockResolvedValue({
      ok: false,
      status: 400,
      reason: 'unknown_machine',
      machineIds: ['lobby-01'],
    });

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 0, failed: 1 });
    expect(resolveHootTargetsMock).toHaveBeenCalledWith(db, 'node-pa', {
      requested: ['lobby-01'],
      machineScope: ['lobby-09'],
    });
    expect(startTurnMock).not.toHaveBeenCalled();
    // the record a machine that left the site leaves, which says nothing more about it
    expect(followups.get('fu-1')).toMatchObject({ status: 'failed', turnError: 'target_machines_gone: lobby-01' });
  });

  it('dispatches to nothing on a target machine with hoot switched off', async () => {
    // D-A at the dispatch layer: the kill switch removes the machine from the
    // resolved set, so no command is queued for it — while the promise stays
    // recorded against the set it was made on.
    seedFollowup(
      'fu-1',
      followup({ targetMachineIds: ['lobby-01', 'lobby-02'], machineId: 'lobby-01' }),
    );
    resolveHootTargetsMock.mockResolvedValue({
      ok: true,
      resolved: { ids: ['lobby-01'], fanOut: true, skipped: { offline: [], disabled: ['lobby-02'] } },
    });

    await sweep();

    expect(startTurnMock.mock.calls[0][1]).toMatchObject({
      resolved: {
        ids: ['lobby-01'],
        fanOut: true,
        skipped: { offline: [], disabled: ['lobby-02'] },
      },
      turnTarget: { machineIds: ['lobby-01', 'lobby-02'], fanOut: true, source: 'followup' },
    });
    expect(acquireTurnLockMock.mock.calls[0][2]).toMatchObject({
      resolvedMachineIds: ['lobby-01'],
    });
  });

  it('fails a follow-up whose machines are all unreachable, instead of dispatching', async () => {
    seedFollowup('fu-1');
    resolveHootTargetsMock.mockResolvedValue({
      ok: false,
      status: 503,
      reason: 'machine_offline',
      machineIds: ['lobby-01'],
    });

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 0, failed: 1 });
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(acquireTurnLockMock).not.toHaveBeenCalled();
    expect(followups.get('fu-1')).toMatchObject({
      status: 'failed',
      turnError: 'machine_offline',
    });
  });

  it('leaves a follow-up that is not due yet alone', async () => {
    seedFollowup('fu-1', followup({ runAt: new Date(Date.now() + 5 * MIN) }));

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 0, fired: 0 });
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(followups.get('fu-1')?.status).toBe('scheduled');
  });

  it('fires early once the watched command reaches a terminal state', async () => {
    seedFollowup(
      'fu-1',
      followup({ runAt: new Date(Date.now() + 30 * MIN), watchCommandId: 'cmd-42' }),
    );
    completed.set('node-pa/lobby-01', { 'cmd-42': { status: 'completed' } });

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 1 });
    expect(completedGet).toHaveBeenCalledWith('node-pa', 'lobby-01', 'completed');
    expect(followups.get('fu-1')?.status).toBe('fired');
  });

  it('waits while the watched command is still running', async () => {
    // The agent writes a non-terminal `running` marker at command START; firing
    // on it would report back before the work is done.
    seedFollowup(
      'fu-1',
      followup({ runAt: new Date(Date.now() + 30 * MIN), watchCommandId: 'cmd-42' }),
    );
    completed.set('node-pa/lobby-01', { 'cmd-42': { status: 'running' } });

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 0, fired: 0 });
    expect(startTurnMock).not.toHaveBeenCalled();
  });

  it('does not chase a watched command for a site-wide chat', async () => {
    // One command id cannot name a command across a site fan-out.
    seedFollowup(
      'fu-1',
      followup({
        machineId: '__site__',
        runAt: new Date(Date.now() + 30 * MIN),
        watchCommandId: 'cmd-42',
      }),
    );

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 0 });
    expect(completedGet).not.toHaveBeenCalled();
  });

  it('does not chase a watched command for a multi-machine follow-up', async () => {
    // The legacy `machineId` narrows a subset to its FIRST machine, so gating on
    // it would fire the turn the moment that one machine finished — while the
    // rest of the set was still working.
    seedFollowup(
      'fu-1',
      followup({
        targetMachineIds: ['lobby-01', 'lobby-02'],
        machineId: 'lobby-01',
        runAt: new Date(Date.now() + 30 * MIN),
        watchCommandId: 'cmd-42',
      }),
    );
    completed.set('node-pa/lobby-01', { 'cmd-42': { status: 'completed' } });

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 0, fired: 0 });
    expect(completedGet).not.toHaveBeenCalled();
    expect(followups.get('fu-1')?.status).toBe('scheduled');
  });

  it('chases the watched command of a recorded single-machine follow-up', async () => {
    seedFollowup(
      'fu-1',
      followup({
        targetMachineIds: ['lobby-02'],
        machineId: 'lobby-02',
        runAt: new Date(Date.now() + 30 * MIN),
        watchCommandId: 'cmd-42',
      }),
    );
    completed.set('node-pa/lobby-02', { 'cmd-42': { status: 'completed' } });
    resolveHootTargetsMock.mockResolvedValue(resolvedOn(['lobby-02']));

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 1 });
    expect(completedGet).toHaveBeenCalledWith('node-pa', 'lobby-02', 'completed');
  });

  it('lets only one of two overlapping sweeps fire the same follow-up', async () => {
    seedFollowup('fu-1');

    const first = await sweep();
    // Stale scan result: the loser re-reads a no-longer-scheduled doc and no-ops.
    const second = await sweep();

    expect(first).toMatchObject({ due: 1, fired: 1, skipped: 0 });
    expect(second).toMatchObject({ due: 1, fired: 0, skipped: 1 });
    expect(startTurnMock).toHaveBeenCalledTimes(1);
  });

  it('never runs for a user who lost access since scheduling', async () => {
    seedFollowup('fu-1');
    verifyUserSiteAccessMock.mockRejectedValue(
      new SiteAccessError('no_site_access', 'You do not have access to this site'),
    );

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 0, failed: 1 });
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(followups.get('fu-1')).toMatchObject({
      status: 'failed',
      turnError: 'no_site_access',
    });
  });

  it('leaves the follow-up scheduled when a live turn owns the chat', async () => {
    // Someone typing in the chat right now outranks a reminder — the next sweep
    // tries again rather than superseding them.
    seedFollowup('fu-1');
    acquireTurnLockMock.mockRejectedValue(new TurnActiveError('chat-1', 'turn_live'));

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 1, fired: 0, turnActive: 1 });
    expect(startTurnMock).not.toHaveBeenCalled();
    expect(followups.get('fu-1')?.status).toBe('scheduled');
    expect(followups.get('fu-1')?.firedAt).toBeUndefined();
  });

  it('fails a follow-up whose chat was deleted', async () => {
    chats.clear();
    seedFollowup('fu-1');

    const counts = await sweep();

    expect(counts).toMatchObject({ failed: 1 });
    expect(followups.get('fu-1')).toMatchObject({ status: 'failed', turnError: 'chat_deleted' });
  });

  it('fails a follow-up whose chat now belongs to someone else', async () => {
    chats.set('chat-1', { userId: 'other-user', messages: [] });
    seedFollowup('fu-1');

    const counts = await sweep();

    expect(counts).toMatchObject({ failed: 1 });
    expect(followups.get('fu-1')).toMatchObject({
      status: 'failed',
      turnError: 'chat_owner_mismatch',
    });
    expect(startTurnMock).not.toHaveBeenCalled();
  });

  it('records an unexpected dispatch failure on the doc it already claimed', async () => {
    seedFollowup('fu-1');
    verifyUserSiteAccessMock.mockRejectedValue(new Error('firestore unavailable'));

    const counts = await sweep();

    expect(counts).toMatchObject({ failed: 1 });
    expect(followups.get('fu-1')?.status).toBe('failed');
    expect(followups.get('fu-1')?.turnError).toContain('firestore unavailable');
  });

  it('keeps the pass going after one follow-up throws', async () => {
    seedFollowup('fu-1');
    seedFollowup('fu-2');
    claimThrowsFor = new Set(['fu-1']);

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 2, fired: 1 });
    expect(startTurnMock).toHaveBeenCalledTimes(1);
  });

  it('fires at most ten follow-ups per sweep, leaving the rest scheduled', async () => {
    for (let index = 1; index <= 12; index++) seedFollowup(`fu-${index}`);

    const counts = await sweep();

    expect(counts).toMatchObject({ due: 10, fired: 10 });
    expect(followups.get('fu-11')?.status).toBe('scheduled');
    expect(followups.get('fu-12')?.status).toBe('scheduled');
  });

  it('stops at the sweep budget with work left', async () => {
    seedFollowup('fu-1');
    seedFollowup('fu-2');

    const base = Date.now();
    let offset = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => base + offset);
    // The first dispatch burns the whole budget.
    startTurnMock.mockImplementation(() => {
      offset += 60_000;
      return { cancel: jest.fn(async () => {}) };
    });

    const counts = await fireDueFollowups(db, new Date(base), base + 50_000);

    expect(counts).toMatchObject({ due: 1, fired: 1 });
    expect(followups.get('fu-2')?.status).toBe('scheduled');

    nowSpy.mockRestore();
  });
});
