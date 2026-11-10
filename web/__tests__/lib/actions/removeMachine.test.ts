/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/removeMachine.server.ts`: the four-path cascade (the same
 * paths the legacy `useMachineOperations.ts` hook deleted) and tolerance of missing
 * `commands/pending` / `commands/completed` docs.
 *
 * Authorization (superadmin via MACHINE_REMOVE) belongs to the route's `authorizedSiteHandler`
 * wrapper, so those tests live with the route shim and `authorizedHandler.test.ts`.
 */

const loggerWarnSpy = jest.fn();
const loggerErrorSpy = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => loggerWarnSpy(...a),
    error: (...a: unknown[]) => loggerErrorSpy(...a),
  },
}));

// `removeMachine` resolves the default db at the top of its body, so the firebase-admin mock
// must exist before import even though every test injects an explicit `db`.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

// the session store reads through `getAdminDb`, not the injected db
const mockListSessions = jest.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const mockEndSession = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/lib/swoop/sessionStore.server', () => ({
  listUnendedSwoopSessionsForMachine: (...a: unknown[]) => mockListSessions(...a),
  endSwoopSession: (...a: unknown[]) => mockEndSession(...a),
}));

const mockRecordEnded = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/lib/swoop/audit.server', () => ({
  recordSwoopSessionEnded: (...a: unknown[]) => mockRecordEnded(...a),
}));

const mockPrune = jest.fn(async (..._a: unknown[]) => 0);
jest.mock('@/lib/membership.server', () => ({
  pruneMachineFromMembers: (...a: unknown[]) => mockPrune(...a),
}));

import { removeMachine } from '@/lib/actions/removeMachine.server';

const AUDIT_ACTOR = 'user:admin-uid';
const ACTOR = { type: 'user' as const, userId: 'admin-uid', role: 'admin' as const, siteRoles: { 'site-a': 'admin' as const } };

interface RecordedDelete {
  path: string;
}

interface BatchOp {
  op: 'delete';
  path: string;
}

interface AgentRefreshTokenDoc {
  id: string;
  siteId: string;
  machineId: string;
}

interface FakeDbResult {
  // Path of every individual `.delete()` (Phase 2).
  individualDeletes: RecordedDelete[];
  // Ordered batch ops + commits (Phase 1).
  batchOps: BatchOp[];
  batchCommitSizes: number[];
  batchCommitCount: number;
  // Force one path's delete to throw (fault isolation).
  setIndividualDeleteFailure: (path: string, err: Error) => void;
  // Force the batch commit to throw (main-cascade failure).
  setBatchCommitFailure: (err: Error) => void;
  // Force the agent_refresh_tokens query to throw (cleanup tolerance).
  setAgentRefreshTokenQueryFailure: (err: Error) => void;
  // Loosely typed — the action core casts to its own `Firestore` import.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(
  agentRefreshTokens: AgentRefreshTokenDoc[] = [],
): FakeDbResult {
  const individualDeletes: RecordedDelete[] = [];
  const batchOps: BatchOp[] = [];
  const batchCommitSizes: number[] = [];
  const remainingAgentRefreshTokens = [...agentRefreshTokens];
  let batchCommitCount = 0;
  const individualFailures = new Map<string, Error>();
  let batchFailure: Error | null = null;
  let agentRefreshTokenQueryFailure: Error | null = null;

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      delete: async () => {
        const failure = individualFailures.get(docPath);
        if (failure) throw failure;
        individualDeletes.push({ path: docPath });
      },
    };
  }

  function makeAgentRefreshTokensCollection(
    filters: Array<[string, unknown]> = [],
    rowLimit?: number,
  ): unknown {
    return {
      doc: (id: string) => makeDocRef(`agent_refresh_tokens/${id}`),
      where: (field: string, _op: string, value: unknown) =>
        makeAgentRefreshTokensCollection([...filters, [field, value]], rowLimit),
      limit: (limit: number) => makeAgentRefreshTokensCollection(filters, limit),
      get: async () => {
        if (agentRefreshTokenQueryFailure) {
          throw agentRefreshTokenQueryFailure;
        }
        const matchingDocs = remainingAgentRefreshTokens.filter((doc) =>
          filters.every(
            ([field, value]) =>
              (doc as Record<string, unknown>)[field] === value,
          ),
        );
        return {
          docs: matchingDocs
            .slice(0, rowLimit)
            .map((doc) => ({
              id: doc.id,
              ref: { path: `agent_refresh_tokens/${doc.id}` },
              data: () => doc,
            })),
        };
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    if (colPath === 'agent_refresh_tokens') {
      return makeAgentRefreshTokensCollection();
    }

    return {
      doc: (id: string) => makeDocRef(`${colPath}/${id}`),
    };
  }

  function makeBatch(): unknown {
    const localOps: BatchOp[] = [];
    return {
      delete: (ref: { path: string }) => {
        localOps.push({ op: 'delete', path: ref.path });
      },
      commit: async () => {
        if (batchFailure) throw batchFailure;
        batchOps.push(...localOps);
        batchCommitSizes.push(localOps.length);
        batchCommitCount += 1;
        for (const op of localOps) {
          const match = op.path.match(/^agent_refresh_tokens\/(.+)$/);
          if (!match) continue;
          const index = remainingAgentRefreshTokens.findIndex((doc) => doc.id === match[1]);
          if (index >= 0) remainingAgentRefreshTokens.splice(index, 1);
        }
      },
    };
  }

  const db = {
    collection: (name: string) => makeCollectionRef(name),
    batch: () => makeBatch(),
  };

  return {
    individualDeletes,
    batchOps,
    batchCommitSizes,
    get batchCommitCount() {
      return batchCommitCount;
    },
    setIndividualDeleteFailure: (path, err) => {
      individualFailures.set(path, err);
    },
    setBatchCommitFailure: (err) => {
      batchFailure = err;
    },
    setAgentRefreshTokenQueryFailure: (err) => {
      agentRefreshTokenQueryFailure = err;
    },
    db,
  };
}

beforeEach(() => {
  loggerWarnSpy.mockClear();
  loggerErrorSpy.mockClear();
  mockEmitMutation.mockClear();
  mockListSessions.mockResolvedValue([]);
});

describe('removeMachine — input validation', () => {
  it('throws when siteId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      removeMachine({ siteId: '', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db }),
    ).rejects.toThrow(/siteId/);
    expect(fake.batchCommitCount).toBe(0);
  });

  it('throws when machineId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      removeMachine({ siteId: 'site-a', machineId: '', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db }),
    ).rejects.toThrow(/machineId/);
    expect(fake.batchCommitCount).toBe(0);
  });
});

describe('removeMachine — cascade covers all 4 paths', () => {
  it('deletes machine + config in a batch and pending + completed individually', async () => {
    const fake = buildFakeDb();
    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'mach_alpha',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    // Phase 1 (atomic batch): main machine doc + config doc.
    expect(fake.batchCommitCount).toBe(1);
    expect(fake.batchOps).toEqual([
      { op: 'delete', path: 'sites/site-a/machines/mach_alpha' },
      { op: 'delete', path: 'config/site-a/machines/mach_alpha' },
    ]);

    // Phase 2 (best-effort): pending + completed command maps.
    const individualPaths = fake.individualDeletes.map((d) => d.path).sort();
    expect(individualPaths).toEqual([
      'sites/site-a/machines/mach_alpha/commands/completed',
      'sites/site-a/machines/mach_alpha/commands/pending',
    ]);

    // Result reports all 4 paths regardless of pre-existence.
    expect(result).toEqual({
      siteId: 'site-a',
      machineId: 'mach_alpha',
      deleted: {
        machine: 'sites/site-a/machines/mach_alpha',
        config: 'config/site-a/machines/mach_alpha',
        pendingCommands: 'sites/site-a/machines/mach_alpha/commands/pending',
        completedCommands: 'sites/site-a/machines/mach_alpha/commands/completed',
      },
    });
  });

  it('deletes agent refresh tokens matching the same siteId and machineId', async () => {
    const fake = buildFakeDb([
      { id: 'tok-match-1', siteId: 'site-a', machineId: 'm1' },
      { id: 'tok-other-machine', siteId: 'site-a', machineId: 'm2' },
      { id: 'tok-other-site', siteId: 'site-b', machineId: 'm1' },
      { id: 'tok-match-2', siteId: 'site-a', machineId: 'm1' },
    ]);

    await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    expect(fake.batchCommitCount).toBe(2);
    expect(fake.batchOps).toEqual([
      { op: 'delete', path: 'sites/site-a/machines/m1' },
      { op: 'delete', path: 'config/site-a/machines/m1' },
      { op: 'delete', path: 'agent_refresh_tokens/tok-match-1' },
      { op: 'delete', path: 'agent_refresh_tokens/tok-match-2' },
    ]);
    expect(fake.individualDeletes).toEqual([
      { path: 'sites/site-a/machines/m1/commands/pending' },
      { path: 'sites/site-a/machines/m1/commands/completed' },
    ]);
  });

  it('deletes agent refresh tokens in batches of at most 500', async () => {
    const fake = buildFakeDb(
      Array.from({ length: 1201 }, (_, i) => ({
        id: `tok-match-${i}`,
        siteId: 'site-a',
        machineId: 'm1',
      })),
    );

    await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    const tokenDeletes = fake.batchOps.filter((op) =>
      op.path.startsWith('agent_refresh_tokens/'),
    );
    expect(fake.batchCommitSizes).toEqual([2, 500, 500, 201]);
    expect(tokenDeletes).toHaveLength(1201);
  });

  it('phase 1 batch runs BEFORE phase 2 best-effort deletes', async () => {
    const fake = buildFakeDb();
    // A failed batch commit must short-circuit before any individual delete.
    fake.setBatchCommitFailure(new Error('batch_blew_up'));

    await expect(
      removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db }),
    ).rejects.toThrow('batch_blew_up');

    expect(fake.individualDeletes).toEqual([]);
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });
});

describe('removeMachine — best-effort tolerance', () => {
  it('treats pending commands delete failure as non-fatal and logs warning', async () => {
    const fake = buildFakeDb();
    fake.setIndividualDeleteFailure(
      'sites/site-a/machines/m1/commands/pending',
      new Error('pending_doc_gone'),
    );

    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    // The completed delete is still attempted and recorded.
    expect(fake.individualDeletes).toEqual([
      { path: 'sites/site-a/machines/m1/commands/completed' },
    ]);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy.mock.calls[0][0]).toMatch(/pending commands delete/);
    // All four paths still reported — the caller treats this as success.
    expect(result.deleted.pendingCommands).toBe(
      'sites/site-a/machines/m1/commands/pending',
    );
  });

  it('treats completed commands delete failure as non-fatal and logs warning', async () => {
    const fake = buildFakeDb();
    fake.setIndividualDeleteFailure(
      'sites/site-a/machines/m1/commands/completed',
      new Error('completed_doc_gone'),
    );

    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    expect(fake.individualDeletes).toEqual([
      { path: 'sites/site-a/machines/m1/commands/pending' },
    ]);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy.mock.calls[0][0]).toMatch(/completed commands delete/);
    expect(result.deleted.completedCommands).toBe(
      'sites/site-a/machines/m1/commands/completed',
    );
  });

  it('treats agent refresh token cleanup failure as non-fatal and logs warning', async () => {
    const fake = buildFakeDb([
      { id: 'tok-match', siteId: 'site-a', machineId: 'm1' },
    ]);
    fake.setAgentRefreshTokenQueryFailure(new Error('token_query_down'));

    const result = await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    expect(fake.batchCommitCount).toBe(1);
    expect(fake.batchOps).toEqual([
      { op: 'delete', path: 'sites/site-a/machines/m1' },
      { op: 'delete', path: 'config/site-a/machines/m1' },
    ]);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy.mock.calls[0][0]).toMatch(
      /agent refresh token delete/,
    );
    expect(result.deleted.machine).toBe('sites/site-a/machines/m1');
  });

  it('is idempotent: re-running on the same machineId is a no-op', async () => {
    const fake = buildFakeDb();
    await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });
    await removeMachine({
      siteId: 'site-a',
      machineId: 'm1',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });
    // Two batches committed; eight delete-records (4 per call).
    expect(fake.batchCommitCount).toBe(2);
    expect(fake.batchOps).toHaveLength(4);
    expect(fake.individualDeletes).toHaveLength(4);
  });
});

describe('removeMachine — audit emission', () => {
  it('emits one site_mutated audit with verb=machine.remove', async () => {
    const fake = buildFakeDb();
    await removeMachine({
      siteId: 'site-a',
      machineId: 'mach_alpha',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: 'site-a',
      actor: AUDIT_ACTOR,
      targetId: 'mach_alpha',
      attributes: {
        verb: 'machine.remove',
        endpoint: 'machines',
        method: 'DELETE',
        machineId: 'mach_alpha',
      },
    });
  });

  it('does not emit when the main cascade batch fails', async () => {
    const fake = buildFakeDb();
    fake.setBatchCommitFailure(new Error('batch_blew_up'));

    await expect(
      removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db }),
    ).rejects.toThrow('batch_blew_up');

    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('removeMachine — return shape', () => {
  it('returns the canonical 4 firestore paths in the deleted block', async () => {
    const fake = buildFakeDb();
    const result = await removeMachine({
      siteId: 'site-with_dashes-and_underscores',
      machineId: 'mach_42-x',
      auditActor: AUDIT_ACTOR,
      actor: ACTOR,
      db: fake.db,
    });
    expect(result.deleted).toEqual({
      machine: 'sites/site-with_dashes-and_underscores/machines/mach_42-x',
      config: 'config/site-with_dashes-and_underscores/machines/mach_42-x',
      pendingCommands:
        'sites/site-with_dashes-and_underscores/machines/mach_42-x/commands/pending',
      completedCommands:
        'sites/site-with_dashes-and_underscores/machines/mach_42-x/commands/completed',
    });
  });
});

/**
 * a machine that leaves the site takes its streamer with it, and its session
 * records, a subcollection of the deleted doc, outlive it. ended here, so every
 * viewer of the machine reads why instead of waiting on a machine that will
 * not come back.
 */
describe('removeMachine — the sessions swoop had on it', () => {
  const live = { sid: 'sid-live', siteId: 'site-a', machineId: 'm1', state: 'live', startedAt: Date.now() - 60_000, viewers: [] };

  it('ends every unended session on the machine as machine_removed, and records each one', async () => {
    const fake = buildFakeDb();
    mockListSessions.mockResolvedValue([live, { ...live, sid: 'sid-pending', state: 'pending' }]);

    await removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db });

    expect(mockListSessions).toHaveBeenCalledWith({ siteId: 'site-a', machineId: 'm1' });
    expect(mockEndSession.mock.calls.map(([args]) => args)).toEqual([
      { siteId: 'site-a', machineId: 'm1', sid: 'sid-live', endReason: 'machine_removed' },
      { siteId: 'site-a', machineId: 'm1', sid: 'sid-pending', endReason: 'machine_removed' },
    ]);
    expect(mockRecordEnded).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-a', machineId: 'm1', sid: 'sid-live', actor: ACTOR, endReason: 'machine_removed' }),
    );
    expect(mockRecordEnded).toHaveBeenCalledTimes(2);
  });

  it('ends them only once the machine itself is gone: a failed removal leaves them running', async () => {
    const fake = buildFakeDb();
    fake.setBatchCommitFailure(new Error('batch_blew_up'));
    mockListSessions.mockResolvedValue([live]);

    await expect(
      removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db }),
    ).rejects.toThrow('batch_blew_up');

    expect(mockEndSession).not.toHaveBeenCalled();
  });

  it('ends the rest when one cannot be ended', async () => {
    const fake = buildFakeDb();
    mockListSessions.mockResolvedValue([live, { ...live, sid: 'sid-other' }]);
    mockEndSession.mockRejectedValueOnce(new Error('write refused'));

    await removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db });

    expect(mockEndSession).toHaveBeenCalledWith(expect.objectContaining({ sid: 'sid-other' }));
    expect(mockRecordEnded).toHaveBeenCalledWith(expect.objectContaining({ sid: 'sid-other' }));
    expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('swoop'), expect.anything());
  });

  it('removes the machine all the same when its sessions cannot be ended', async () => {
    const fake = buildFakeDb([{ id: 'tok-1', siteId: 'site-a', machineId: 'm1' }]);
    mockListSessions.mockRejectedValue(new Error('store down'));

    const result = await removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db });

    expect(result.machineId).toBe('m1');
    expect(fake.batchOps).toContainEqual({ op: 'delete', path: 'agent_refresh_tokens/tok-1' });
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('swoop'),
      expect.objectContaining({ data: expect.objectContaining({ siteId: 'site-a', machineId: 'm1' }) }),
    );
  });
});

/**
 * machine ids start as hostnames and get reused, so a removed machine's id
 * leaves every member's machine scope: a machine that pairs back under it
 * starts with no member's grant.
 */
describe('removeMachine — machine scopes', () => {
  it('prunes the id from every machine scope on its site, through the same db', async () => {
    const fake = buildFakeDb();

    await removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db });

    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockPrune).toHaveBeenCalledWith({ siteId: 'site-a', machineId: 'm1', db: fake.db });
  });

  it('prunes nothing when the removal itself fails', async () => {
    const fake = buildFakeDb();
    fake.setBatchCommitFailure(new Error('batch_blew_up'));

    await expect(
      removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db }),
    ).rejects.toThrow('batch_blew_up');

    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('logs a failed prune and removes the machine all the same', async () => {
    const fake = buildFakeDb([{ id: 'tok-1', siteId: 'site-a', machineId: 'm1' }]);
    mockPrune.mockRejectedValueOnce(new Error('members query down'));

    const result = await removeMachine({ siteId: 'site-a', machineId: 'm1', auditActor: AUDIT_ACTOR, actor: ACTOR, db: fake.db });

    expect(result.machineId).toBe('m1');
    expect(fake.batchOps).toContainEqual({ op: 'delete', path: 'agent_refresh_tokens/tok-1' });
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('machine scope prune'),
      expect.objectContaining({ data: expect.objectContaining({ siteId: 'site-a', machineId: 'm1', err: 'members query down' }) }),
    );
  });
});
