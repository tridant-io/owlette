/** @jest-environment node */

/**
 * what a machine leaving its site takes with it (lib/fleet/cleanup.server.ts,
 * lib/fleet/calls.server.ts), over an in-memory admin-sdk fake. machine ids get
 * reused, so after a prune the id must be in no grant, hold no session and own
 * no call record, and nothing of any other machine or site may go with it.
 */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP' },
}));
jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { deleteFleetCalls } from '@/lib/fleet/calls.server';
import { pruneMachineFromFleet } from '@/lib/fleet/cleanup.server';
import { parseFleetSettings } from '@/lib/fleet/grant';

type Data = Record<string, unknown>;

let docs: Map<string, Data>;
let txWrites: Array<{ path: string; payload: Data; options: unknown }>;
let txError: Error | null;

function docRef(path: string) {
  return {
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function query(path: string, filters: Array<[string, unknown]>) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`fake firestore answers == only, got ${op}`);
      return query(path, [...filters, [field, value]]);
    },
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .map(([p, data]) => ({ id: p.slice(path.length + 1), ref: docRef(p), data: () => data })),
    }),
  };
}

function collectionRef(path: string) {
  return { doc: (id: string) => docRef(`${path}/${id}`), where: query(path, []).where };
}

const db = {
  collection: (name: string) => collectionRef(name),
  batch: () => {
    const deletes: string[] = [];
    return {
      delete: (ref: { path: string }) => deletes.push(ref.path),
      commit: async () => {
        for (const path of deletes) docs.delete(path);
      },
    };
  },
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    if (txError) throw txError;
    return fn({
      get: async (ref: { path: string }) => {
        const data = docs.get(ref.path);
        return { exists: data !== undefined, data: () => data };
      },
      set: (ref: { path: string }, payload: Data, options: { mergeFields: string[] }) => {
        txWrites.push({ path: ref.path, payload, options });
        const next = { ...docs.get(ref.path) };
        for (const field of options.mergeFields) next[field] = payload[field];
        docs.set(ref.path, next);
      },
    });
  },
} as unknown as Firestore;

const SITE = 'site-a';
const SETTINGS = `sites/${SITE}/settings/fleet`;
const session = (siteId: string, machineId: string) => ({ siteId, machineId, createdAt: 1, expiresAt: 2 });
const call = (siteId: string, callerMachineId: string, machineId: string) => ({
  siteId,
  callerMachineId,
  machineId,
  tool: 'get_system_info',
  createdAt: 1,
  expiresAt: 2,
});

const paths = (prefix: string) => [...docs.keys()].filter((p) => p.startsWith(prefix)).sort();

beforeEach(() => {
  docs = new Map();
  txWrites = [];
  txError = null;
});

describe('pruneMachineFromFleet: the grant', () => {
  it('drops the machine as a sender and from every list that names it, and widens nobody', async () => {
    docs.set(SETTINGS, {
      enabled: true,
      updatedAt: 'EARLIER',
      senders: {
        'kiosk-1': { maxTier: 3, wholeSite: true },
        'kiosk-2': { maxTier: 2, machineIds: ['kiosk-1', 'kiosk-3'] },
        'kiosk-3': { maxTier: 2, machineIds: ['kiosk-1'] },
        'kiosk-4': { maxTier: 1, wholeSite: true },
      },
    });

    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(docs.get(SETTINGS)).toEqual({
      enabled: true,
      updatedAt: 'SERVER_TIMESTAMP',
      senders: {
        'kiosk-2': { maxTier: 2, machineIds: ['kiosk-3'] },
        // its only machine went: it keeps its entry and reaches nothing
        'kiosk-3': { maxTier: 2 },
        'kiosk-4': { maxTier: 1, wholeSite: true },
      },
    });
    expect(txWrites).toHaveLength(1);
    expect(txWrites[0].options).toEqual({ mergeFields: ['senders', 'updatedAt'] });
    const after = parseFleetSettings(docs.get(SETTINGS));
    expect(after.senders['kiosk-1']).toBeUndefined();
    expect(after.senders['kiosk-3'].machineIds).toEqual([]);
  });

  it('writes nothing when the machine is in no grant', async () => {
    const stored = { enabled: true, senders: { 'kiosk-2': { maxTier: 2, machineIds: ['kiosk-3'] } } };
    docs.set(SETTINGS, stored);

    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(txWrites).toEqual([]);
    expect(docs.get(SETTINGS)).toBe(stored);
  });

  it('writes nothing on a site with no fleet settings', async () => {
    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(txWrites).toEqual([]);
    expect(docs.has(SETTINGS)).toBe(false);
  });

  it("leaves another site's grant alone", async () => {
    const other = { enabled: true, senders: { 'kiosk-1': { maxTier: 2, wholeSite: true } } };
    docs.set('sites/site-b/settings/fleet', other);

    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(docs.get('sites/site-b/settings/fleet')).toBe(other);
  });
});

describe('pruneMachineFromFleet: sessions and call records', () => {
  beforeEach(() => {
    docs.set('fleet_sessions/mine', session(SITE, 'kiosk-1'));
    docs.set('fleet_sessions/sibling', session(SITE, 'kiosk-2'));
    docs.set('fleet_sessions/elsewhere', session('site-b', 'kiosk-1'));
    docs.set('fleet_calls/cmd_started', call(SITE, 'kiosk-1', 'kiosk-2'));
    docs.set('fleet_calls/cmd_acted_on', call(SITE, 'kiosk-2', 'kiosk-1'));
    docs.set('fleet_calls/cmd_on_itself', call(SITE, 'kiosk-1', 'kiosk-1'));
    docs.set('fleet_calls/cmd_unrelated', call(SITE, 'kiosk-2', 'kiosk-3'));
    docs.set('fleet_calls/cmd_elsewhere', call('site-b', 'kiosk-1', 'kiosk-1'));
  });

  it("deletes the machine's sessions on its site, and no other's", async () => {
    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(paths('fleet_sessions/')).toEqual(['fleet_sessions/elsewhere', 'fleet_sessions/sibling']);
  });

  it('deletes the calls it started and the calls made on it, and no other', async () => {
    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(paths('fleet_calls/')).toEqual(['fleet_calls/cmd_elsewhere', 'fleet_calls/cmd_unrelated']);
  });

  it('still does both when the grant cannot be written, and throws that failure', async () => {
    docs.set(SETTINGS, { enabled: true, senders: { 'kiosk-1': { maxTier: 2, wholeSite: true } } });
    txError = new Error('settings transaction down');

    await expect(pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db })).rejects.toThrow(
      'settings transaction down',
    );

    expect(paths('fleet_sessions/')).toEqual(['fleet_sessions/elsewhere', 'fleet_sessions/sibling']);
    expect(paths('fleet_calls/')).toEqual(['fleet_calls/cmd_elsewhere', 'fleet_calls/cmd_unrelated']);
  });

  it('does both for a machine that is in no grant', async () => {
    docs.set(SETTINGS, { enabled: false, senders: {} });

    await pruneMachineFromFleet({ siteId: SITE, machineId: 'kiosk-1', db });

    expect(paths('fleet_sessions/')).not.toContain('fleet_sessions/mine');
    expect(paths('fleet_calls/')).not.toContain('fleet_calls/cmd_started');
  });
});

describe('deleteFleetCalls', () => {
  beforeEach(() => {
    docs.set('fleet_calls/cmd_1', call(SITE, 'kiosk-1', 'kiosk-2'));
    docs.set('fleet_calls/cmd_2', call(SITE, 'kiosk-2', 'kiosk-3'));
    docs.set('fleet_calls/cmd_elsewhere', call('site-b', 'kiosk-1', 'kiosk-2'));
  });

  it("deletes every record of the site, and no other site's, when no machine is named", async () => {
    await expect(deleteFleetCalls(db, { siteId: SITE })).resolves.toBe(2);

    expect(paths('fleet_calls/')).toEqual(['fleet_calls/cmd_elsewhere']);
  });

  it('counts a call a machine made on itself once', async () => {
    docs.set('fleet_calls/cmd_self', call(SITE, 'kiosk-1', 'kiosk-1'));

    await expect(deleteFleetCalls(db, { siteId: SITE, machineId: 'kiosk-1' })).resolves.toBe(2);
  });

  it('matches nothing for an empty machine id: it never widens to the site', async () => {
    await expect(deleteFleetCalls(db, { siteId: SITE, machineId: '' })).resolves.toBe(0);

    expect(paths('fleet_calls/')).toHaveLength(3);
  });
});
