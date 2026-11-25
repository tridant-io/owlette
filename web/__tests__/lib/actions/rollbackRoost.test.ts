/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));
jest.mock('@/lib/roostWebhooks.server', () => ({ emitRoostWebhook: jest.fn() }));
jest.mock('@/lib/resolveVersion', () => ({
  ...jest.requireActual('@/lib/resolveVersion'),
  resolveVersion: jest.fn(),
}));

import { RoostProblem } from '@/lib/actions/deployRoost.server';
import { rollbackRoost } from '@/lib/actions/rollbackRoost.server';
import { resolveVersion } from '@/lib/resolveVersion';

const ROOST = 'rst_000000000001';

function makeDb(roost: Record<string, unknown>) {
  const tx = { get: async () => ({ exists: true, data: () => roost }), update: jest.fn(), set: jest.fn() };
  const batch = { set: jest.fn(), delete: jest.fn(), commit: jest.fn() };
  const ref: Record<string, unknown> = {};
  ref.doc = () => ref;
  ref.collection = () => ref;
  const db = {
    collection: () => ref,
    runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    batch: () => batch,
  } as unknown as Firestore;
  return { db, tx, batch };
}

const ctx = { siteId: 'site-a', auditActor: 'machine:m0' };
const base = { roostId: ROOST, requestedBy: 'machine:m0', endpoint: `/api/roosts/${ROOST}/rollback`, method: 'POST' };

beforeEach(() => {
  (resolveVersion as jest.Mock).mockResolvedValue({
    versionId: 'v-old',
    versionNumber: 1,
    doc: { data: () => ({ versionUrl: 'https://r2/old' }) },
  });
});

describe('rollbackRoost approvedMachines', () => {
  const roost = { targets: ['m1', 'm2'], currentVersionId: 'v-new' };

  it('writes nothing when the roost targets are no longer the approved set', async () => {
    const { db, tx, batch } = makeDb(roost);
    await expect(rollbackRoost(ctx, { ...base, db, approvedMachines: ['m1'] })).rejects.toBeInstanceOf(RoostProblem);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.set).not.toHaveBeenCalled();
    expect(batch.commit).not.toHaveBeenCalled();
  });

  it('rolls back, queuing a pull on exactly the approved machines', async () => {
    const { db, batch } = makeDb(roost);
    const result = await rollbackRoost(ctx, { ...base, db, approvedMachines: ['m2', 'm1'] });
    expect(result).toMatchObject({ ok: true, currentVersionId: 'v-old', previousVersionId: 'v-new' });
    expect(batch.set).toHaveBeenCalledTimes(4);
  });
});
