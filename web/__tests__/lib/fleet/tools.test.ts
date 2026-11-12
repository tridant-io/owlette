/** @jest-environment node */

/**
 * the process tools a granted machine calls, from dispatch through the real
 * process actions to the write, over an in-memory admin-sdk fake. dispatch's own
 * suite stops at the actions' door; this one proves what lies behind it: the
 * config that changed is the named machine's, and the audit row names the
 * machine that asked.
 */

import type { Firestore } from 'firebase-admin/firestore';

type Data = Record<string, unknown>;

const SITE = 'site-a';
const SENDER = 'sender-1';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';

let docs: Map<string, Data>;

function docRef(path: string) {
  return {
    path,
    collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
    get: async () => {
      const data = docs.get(path);
      return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
    },
    update: async (patch: Data) => {
      docs.set(path, { ...docs.get(path), ...patch });
    },
  };
}

const db = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
    fn({
      get: (ref: ReturnType<typeof docRef>) => ref.get(),
      update: (ref: ReturnType<typeof docRef>, patch: Data) => {
        docs.set(ref.path, { ...docs.get(ref.path), ...patch });
      },
    }),
} as unknown as Firestore;

// the process actions write through the admin sdk's own db
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => db,
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { emitMutation } from '@/lib/auditLogClient';
import type { FleetContext } from '@/lib/fleet/context';
import { startFleetCall, type FleetCallStart } from '@/lib/fleet/dispatch.server';

const configPath = (machine: string) => `config/${SITE}/machines/${machine}`;

// these calls change what a machine launches, which takes tier 3
const ctx: FleetContext = {
  actor: { type: 'machine', siteId: SITE, machineId: SENDER, maxTier: 3, machineIds: [M1] },
  siteId: SITE,
  machineId: SENDER,
  grant: { maxTier: 3, machineIds: [M1] },
  correlationId: 'corr-1',
  db,
};

function processes(machine: string): Array<Record<string, unknown>> {
  return (docs.get(configPath(machine))?.processes ?? []) as Array<Record<string, unknown>>;
}

async function call(tool: string, params: Record<string, unknown>) {
  const result: FleetCallStart = await startFleetCall(ctx, { tool, params: { machine: M1, ...params } }, async () => null);
  if (!result.ok || result.kind !== 'answered') throw new Error(`expected an inline answer, got ${JSON.stringify(result)}`);
  return result.body;
}

/** the one mutation row the call emitted. */
function mutationRow() {
  expect(emitMutation).toHaveBeenCalledTimes(1);
  return (emitMutation as jest.Mock).mock.calls[0][0];
}

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  for (const machine of [M1, M2]) {
    docs.set(`sites/${SITE}/machines/${machine}`, { online: true });
    docs.set(configPath(machine), {
      processes: [{ id: 'proc-1', processId: 'proc-1', name: 'TouchDesigner', exe_path: 'C:/td.exe', launch_mode: 'off' }],
    });
  }
});

describe('the process tools, through the real actions', () => {
  it('add_process adds to the named machine alone, on a row that names the caller', async () => {
    const body = await call('add_process', { name: 'Notepad', exe_path: 'C:/Windows/notepad.exe' });

    expect(body.status).toBe('completed');
    expect(processes(M1).map((process) => process.name)).toEqual(['TouchDesigner', 'Notepad']);
    expect(processes(M2).map((process) => process.name)).toEqual(['TouchDesigner']);
    expect(mutationRow()).toMatchObject({
      kind: 'process_mutated',
      siteId: SITE,
      actor: `machine:${SENDER}`,
      attributes: { verb: 'create', machineId: M1 },
    });
  });

  it('update_process changes the named process, on a row that names the caller', async () => {
    const body = await call('update_process', { process_name: 'TouchDesigner', launch_mode: 'always' });

    expect(body.status).toBe('completed');
    expect(processes(M1)[0]).toMatchObject({ name: 'TouchDesigner', launch_mode: 'always' });
    expect(processes(M2)[0]).toMatchObject({ launch_mode: 'off' });
    expect(mutationRow()).toMatchObject({
      kind: 'process_mutated',
      actor: `machine:${SENDER}`,
      targetId: 'proc-1',
      attributes: { machineId: M1 },
    });
  });

  it('delete_process removes it from the named machine alone, on a row that names the caller', async () => {
    const body = await call('delete_process', { process_name: 'TouchDesigner' });

    expect(body.status).toBe('completed');
    expect(processes(M1)).toEqual([]);
    expect(processes(M2)).toHaveLength(1);
    expect(mutationRow()).toMatchObject({
      kind: 'process_mutated',
      actor: `machine:${SENDER}`,
      targetId: 'proc-1',
      attributes: { machineId: M1 },
    });
  });

  it('tells the agent its config changed', async () => {
    await call('update_process', { process_name: 'TouchDesigner', launch_mode: 'always' });

    expect(docs.get(`sites/${SITE}/machines/${M1}`)).toMatchObject({ configChangeFlag: true });
    expect(docs.get(`sites/${SITE}/machines/${M2}`)).not.toHaveProperty('configChangeFlag');
  });

  it('a field the action refuses is a failed answer, with nothing written and no row', async () => {
    const body = await call('add_process', { name: 'Notepad' });

    expect(body.status).toBe('failed');
    expect(processes(M1)).toHaveLength(1);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});
