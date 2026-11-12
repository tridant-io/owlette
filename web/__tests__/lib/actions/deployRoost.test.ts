/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));

import { deployRoost, RoostProblem, sameMachineSet } from '@/lib/actions/deployRoost.server';

const ROOST = 'rst_000000000001';
const VERSION = 'a'.repeat(64);

function makeDb(roost: Record<string, unknown>) {
  const batch = { set: jest.fn(), commit: jest.fn() };
  const missing = { exists: false, data: () => undefined };
  const roostRef = {
    get: async () => ({ exists: true, data: () => roost }),
    collection: () => ({ doc: () => ({ get: async () => missing }) }),
  };
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => roostRef }) }) }),
    batch: () => batch,
  } as unknown as Firestore;
  return { db, batch };
}

const ctx = { siteId: 'site-a', auditActor: 'machine:m0' };
const base = {
  roostId: ROOST,
  requestedBy: 'machine:m0',
  endpoint: `/api/roosts/${ROOST}/deploy`,
  method: 'POST',
};

describe('deployRoost approvedMachines', () => {
  const roost = { targets: ['m1', 'm2'], currentVersionId: VERSION, versionUrl: 'https://r2/v' };

  it('refuses before writing when the machines are no longer the approved set', async () => {
    const { db, batch } = makeDb(roost);
    await expect(deployRoost(ctx, { ...base, db, approvedMachines: ['m1'] })).rejects.toBeInstanceOf(RoostProblem);
    expect(batch.commit).not.toHaveBeenCalled();
  });

  it('deploys when the machines are exactly the approved set, in any order', async () => {
    const { db, batch } = makeDb(roost);
    const result = await deployRoost(ctx, { ...base, db, approvedMachines: ['m2', 'm1'] });
    expect(result.outcome).toBe('queued');
    expect(batch.commit).toHaveBeenCalledTimes(1);
  });
});

describe('sameMachineSet', () => {
  it('compares as sets', () => {
    expect(sameMachineSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameMachineSet(['a'], ['a', 'b'])).toBe(false);
  });
});
