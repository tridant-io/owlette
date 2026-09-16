/** @jest-environment node */

/**
 * Unit tests for `clearLogs` action core (security-boundary-migration
 * wave 3.11).
 */

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  ClearLogsValidationError,
  clearLogs,
} from '@/lib/actions/clearLogs.server';

const AUDIT_ACTOR = 'user:admin-uid';

const mockWhere = jest.fn();
const mockOrderBy = jest.fn();
const mockStartAfter = jest.fn();
const mockLimit = jest.fn();
const mockGet = jest.fn();
const mockQuery = {
  where: (...args: unknown[]) => {
    mockWhere(...args);
    return mockQuery;
  },
  orderBy: (...args: unknown[]) => {
    mockOrderBy(...args);
    return mockQuery;
  },
  startAfter: (...args: unknown[]) => {
    mockStartAfter(...args);
    return mockQuery;
  },
  limit: (n: number) => {
    mockLimit(n);
    return mockQuery;
  },
  get: () => mockGet(),
};
const mockSiteDoc = { collection: jest.fn(() => mockQuery) };
const mockSitesCollection = { doc: jest.fn(() => mockSiteDoc) };
const mockBatchInstances: Array<{
  delete: jest.Mock;
  commit: jest.Mock;
}> = [];
const mockDb = {
  collection: jest.fn(() => mockSitesCollection),
  batch: jest.fn(() => {
    const batch = {
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    mockBatchInstances.push(batch);
    return batch;
  }),
};

function snapFor(ids: string[]) {
  return {
    empty: ids.length === 0,
    size: ids.length,
    docs: ids.map((id) => ({ id, ref: { path: `sites/site-a/logs/${id}` } })),
  };
}

// Date-scoped path reads doc.data() to filter action/machine/level in memory.
function snapForData(
  rows: Array<{ id: string; action?: string; machineId?: string; level?: string }>,
) {
  return {
    empty: rows.length === 0,
    size: rows.length,
    docs: rows.map((r) => ({
      id: r.id,
      ref: { path: `sites/site-a/logs/${r.id}` },
      data: () => r,
    })),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBatchInstances.length = 0;
});

describe('clearLogs', () => {
  it('deletes matching log entries in batches', async () => {
    mockGet.mockResolvedValueOnce(snapFor(['log-1', 'log-2']));

    const result = await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      {},
    );

    expect(result).toEqual({ siteId: 'site-a', deletedCount: 2, filters: {} });
    expect(mockDb.collection).toHaveBeenCalledWith('sites');
    expect(mockSitesCollection.doc).toHaveBeenCalledWith('site-a');
    expect(mockSiteDoc.collection).toHaveBeenCalledWith('logs');
    expect(mockLimit).toHaveBeenCalledWith(500);
    expect(mockBatchInstances).toHaveLength(1);
    expect(mockBatchInstances[0].delete).toHaveBeenCalledTimes(2);
    expect(mockBatchInstances[0].commit).toHaveBeenCalledTimes(1);
  });

  it('applies action, machine, and level filters', async () => {
    mockGet.mockResolvedValueOnce(snapFor([]));

    const result = await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      { action: 'process_started', machineId: 'machine-a', level: 'warning' },
    );

    expect(result.deletedCount).toBe(0);
    expect(mockWhere).toHaveBeenCalledWith('action', '==', 'process_started');
    expect(mockWhere).toHaveBeenCalledWith('machineId', '==', 'machine-a');
    expect(mockWhere).toHaveBeenCalledWith('level', '==', 'warning');
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('matches any of several actions with a single `in`', async () => {
    mockGet.mockResolvedValueOnce(snapFor([]));

    await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      { actions: ['process_started', 'process_crash'] },
    );

    expect(mockWhere).toHaveBeenCalledWith('action', 'in', ['process_started', 'process_crash']);
  });

  it('uses equality for a one-entry actions list', async () => {
    mockGet.mockResolvedValueOnce(snapFor([]));

    await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      { actions: ['process_crash'] },
    );

    expect(mockWhere).toHaveBeenCalledWith('action', '==', 'process_crash');
  });

  it('narrows in memory past the `in` limit instead of deleting what it fetched', async () => {
    // The data-loss guard. The equality path deletes EVERY document it fetches,
    // which is safe only because the query proves they all match. Firestore
    // rejects an `in` over 30 values, so a selection that wide must take the
    // cursor path — sending it to the equality path would delete the whole site.
    const many = Array.from({ length: 31 }, (_, i) => `action_${i}`);
    mockGet.mockResolvedValueOnce(
      snapForData([
        { id: 'selected', action: 'action_0' },
        { id: 'not-selected', action: 'something_else' },
      ]),
    );

    const result = await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      { actions: many },
    );

    expect(result.deletedCount).toBe(1);
    expect(mockOrderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(mockWhere).not.toHaveBeenCalledWith('action', expect.anything(), expect.anything());
    expect(mockBatchInstances[0].delete).toHaveBeenCalledTimes(1);
  });

  it('rejects action and actions together', async () => {
    await expect(
      clearLogs(
        { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
        { action: 'process_crash', actions: ['agent_started'] },
      ),
    ).rejects.toBeInstanceOf(ClearLogsValidationError);
  });

  it('rejects an empty or malformed actions list', async () => {
    const ctx = {
      siteId: 'site-a',
      auditActor: AUDIT_ACTOR,
      db: mockDb as unknown as Firestore,
    };

    await expect(clearLogs(ctx, { actions: [] })).rejects.toBeInstanceOf(ClearLogsValidationError);
    await expect(clearLogs(ctx, { actions: [''] })).rejects.toBeInstanceOf(
      ClearLogsValidationError,
    );
    await expect(
      clearLogs(ctx, { actions: [1 as unknown as string] }),
    ).rejects.toBeInstanceOf(ClearLogsValidationError);
  });

  it('continues fetching while full batches are returned', async () => {
    mockGet
      .mockResolvedValueOnce(snapFor(Array.from({ length: 500 }, (_, i) => `log-${i}`)))
      .mockResolvedValueOnce(snapFor(['log-500']));

    const result = await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      {},
    );

    expect(result.deletedCount).toBe(501);
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockBatchInstances).toHaveLength(2);
  });

  it('rejects invalid site ids and levels', async () => {
    await expect(
      clearLogs({ siteId: 'bad site', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore }),
    ).rejects.toMatchObject({ field: 'siteId' });

    await expect(
      clearLogs(
        { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
        { level: 'verbose' },
      ),
    ).rejects.toBeInstanceOf(ClearLogsValidationError);
  });

  it('date-scoped clear orders by timestamp, ranges, and filters in memory', async () => {
    mockGet.mockResolvedValueOnce(
      snapForData([
        { id: 'a', action: 'process_crashed', level: 'error' },
        { id: 'b', action: 'agent_started', level: 'info' },
      ]),
    );

    const result = await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      { sinceMs: 1000, untilMs: 2000, level: 'error' },
    );

    // Only doc 'a' matches level=error; 'b' is filtered out in memory.
    expect(result.deletedCount).toBe(1);
    expect(mockOrderBy).toHaveBeenCalledWith('timestamp', 'desc');
    expect(mockWhere).toHaveBeenCalledWith('timestamp', '>=', expect.anything());
    expect(mockWhere).toHaveBeenCalledWith('timestamp', '<=', expect.anything());
    expect(mockBatchInstances).toHaveLength(1);
    expect(mockBatchInstances[0].delete).toHaveBeenCalledTimes(1);
  });

  it('emits a site_mutated audit with verb=logs.clear and the deleted count', async () => {
    mockGet.mockResolvedValueOnce(snapFor(['log-1', 'log-2']));

    await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      { level: 'error' },
    );

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: 'site-a',
      actor: AUDIT_ACTOR,
      targetId: 'site-a',
      attributes: {
        verb: 'logs.clear',
        endpoint: 'logs',
        method: 'DELETE',
        deletedCount: 2,
        filters: { level: 'error' },
      },
    });
  });

  it('emits the audit even when nothing matched the filters', async () => {
    mockGet.mockResolvedValueOnce(snapFor([]));

    await clearLogs(
      { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
      {},
    );

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'logs.clear', deletedCount: 0 }),
      }),
    );
  });

  it('rejects invalid since/until bounds', async () => {
    await expect(
      clearLogs(
        { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
        { sinceMs: 5000, untilMs: 1000 },
      ),
    ).rejects.toMatchObject({ field: 'sinceMs' });

    await expect(
      clearLogs(
        { siteId: 'site-a', auditActor: AUDIT_ACTOR, db: mockDb as unknown as Firestore },
        { sinceMs: -1 },
      ),
    ).rejects.toBeInstanceOf(ClearLogsValidationError);
  });
});
