/** @jest-environment node */

/**
 * the move store (lib/machineMoves.server.ts), over an in-memory admin-sdk fake.
 * a pending move lapses after its ttl and takes its `site_move` command with it;
 * a switching move never lapses, since the agent already holds the target's
 * credentials. a machine is busy while an install, uninstall, update or roost
 * sync is queued for it, or a deployment naming it is in flight.
 */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => 'DELETE_FIELD' },
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  MOVE_PENDING_TTL_MS,
  cancelMove,
  cancelMovesForSite,
  dropRefusedMove,
  moveExpired,
  moveRef,
  moveRefusal,
  readMove,
  readMoveById,
  switchingMoveForSite,
  type MachineMove,
} from '@/lib/machineMoves.server';

type Data = Record<string, unknown>;
type Filter = [string, string, unknown];

let docs: Map<string, Data>;
let queries: Array<{ path: string; filters: Filter[] }>;
let failUpdates: Set<string>;
let failBatches: boolean;
let onTransaction: (() => void) | null;

function snapshot(path: string) {
  const data = docs.get(path);
  return { id: path.slice(path.lastIndexOf('/') + 1), exists: data !== undefined, ref: docRef(path), data: () => data };
}

function applyUpdate(path: string, patch: Data): void {
  if (failUpdates.has(path)) throw new Error(`update refused: ${path}`);
  const current = docs.get(path);
  if (!current) throw new Error(`NOT_FOUND: ${path}`);
  const next = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === 'DELETE_FIELD') delete next[field];
    else next[field] = value;
  }
  docs.set(path, next);
}

function docRef(path: string) {
  return {
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => snapshot(path),
    update: async (patch: Data) => applyUpdate(path, patch),
    delete: async () => {
      docs.delete(path);
    },
  };
}

function matches(data: Data, [field, op, value]: Filter): boolean {
  return op === 'in' ? (value as unknown[]).includes(data[field]) : data[field] === value;
}

function query(path: string, filters: Filter[]) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==' && op !== 'in') throw new Error(`fake firestore answers == and in only, got ${op}`);
      return query(path, [...filters, [field, op, value]]);
    },
    get: async () => {
      queries.push({ path, filters });
      return {
        docs: [...docs.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .filter(([, data]) => filters.every((filter) => matches(data, filter)))
          .map(([p]) => snapshot(p)),
      };
    },
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
        if (failBatches) throw new Error('batch refused');
        for (const path of deletes) docs.delete(path);
      },
    };
  },
  // writes land at commit, after every read, as firestore's do
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    onTransaction?.();
    const writes: Array<() => void> = [];
    const result = await fn({
      get: async (ref: { path: string }) => snapshot(ref.path),
      delete: (ref: { path: string }) => writes.push(() => docs.delete(ref.path)),
      update: (ref: { path: string }, patch: Data) => writes.push(() => applyUpdate(ref.path, patch)),
    });
    for (const write of writes) write();
    return result;
  },
} as unknown as Firestore;

const SOURCE = 'site-a';
const TARGET = 'site-b';
const OTHER = 'site-c';
const MACHINE = 'kiosk-1';
const DAY_MS = 24 * 60 * 60 * 1000;

const movePath = (sourceSiteId: string, machineId: string) => `machine_moves/${sourceSiteId}:${machineId}`;
const pendingPath = (siteId: string, machineId: string) => `sites/${siteId}/machines/${machineId}/commands/pending`;

function seedMove(fields: Partial<MachineMove> = {}): MachineMove {
  const sourceSiteId = fields.sourceSiteId ?? SOURCE;
  const machineId = fields.machineId ?? MACHINE;
  const move: MachineMove = {
    moveId: `${sourceSiteId}:${machineId}`,
    sourceSiteId,
    targetSiteId: TARGET,
    machineId,
    status: 'pending',
    requestedBy: 'user-1',
    requestedAt: Date.now() - DAY_MS,
    expiresAt: Date.now() + DAY_MS,
    ...fields,
  };
  docs.set(movePath(sourceSiteId, machineId), { ...move });
  return move;
}

const siteMoveCommand = (moveId: string) => ({ type: 'site_move', moveId, status: 'pending' });

beforeEach(() => {
  docs = new Map();
  queries = [];
  failUpdates = new Set();
  failBatches = false;
  onTransaction = null;
});

describe('the move record', () => {
  it('keeps a pending move for 7 days', () => {
    expect(MOVE_PENDING_TTL_MS).toBe(7 * DAY_MS);
  });

  it('lives at machine_moves/{sourceSiteId}:{machineId}', () => {
    const ref = moveRef(db, SOURCE, MACHINE);

    expect(ref.path).toBe('machine_moves/site-a:kiosk-1');
    expect(ref.id).toBe('site-a:kiosk-1');
  });
});

describe('moveExpired', () => {
  const now = 1_000_000;
  const move = (status: MachineMove['status'], expiresAt: number) =>
    ({ status, expiresAt }) as MachineMove;

  it('lapses a pending move at its expiry and after', () => {
    expect(moveExpired(move('pending', now), now)).toBe(true);
    expect(moveExpired(move('pending', now - 1), now)).toBe(true);
  });

  it('keeps a pending move before its expiry', () => {
    expect(moveExpired(move('pending', now + 1), now)).toBe(false);
  });

  it('never lapses a switching move', () => {
    expect(moveExpired(move('switching', now - 30 * DAY_MS), now)).toBe(false);
  });
});

describe('readMove', () => {
  it('answers null when the machine has no move', async () => {
    await expect(readMove(db, SOURCE, MACHINE)).resolves.toBeNull();
  });

  it('answers a pending move inside its ttl as stored', async () => {
    const move = seedMove({ mintedTokenHash: 'hash-1' });

    await expect(readMove(db, SOURCE, MACHINE)).resolves.toEqual(move);
  });

  it('reads a lapsed pending move as gone, and deletes it and its site_move command', async () => {
    const move = seedMove({ expiresAt: Date.now() - 1 });
    docs.set(pendingPath(SOURCE, MACHINE), {
      cmd_site_move_1: siteMoveCommand(move.moveId),
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });
    docs.set(pendingPath(SOURCE, 'kiosk-2'), { cmd_site_move_2: siteMoveCommand(`${SOURCE}:kiosk-2`) });
    docs.set(pendingPath(OTHER, MACHINE), { cmd_site_move_3: siteMoveCommand(`${OTHER}:${MACHINE}`) });

    await expect(readMove(db, SOURCE, MACHINE)).resolves.toBeNull();

    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(false);
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toEqual({
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });
    expect(docs.get(pendingPath(SOURCE, 'kiosk-2'))).toHaveProperty('cmd_site_move_2');
    expect(docs.get(pendingPath(OTHER, MACHINE))).toHaveProperty('cmd_site_move_3');
  });

  it('leaves a site_move command queued for a different move', async () => {
    seedMove({ expiresAt: Date.now() - 1 });
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_older: siteMoveCommand('another-move') });

    await readMove(db, SOURCE, MACHINE);

    expect(docs.get(pendingPath(SOURCE, MACHINE))).toEqual({ cmd_older: siteMoveCommand('another-move') });
  });

  it('deletes a lapsed move whose machine has no pending commands doc', async () => {
    seedMove({ expiresAt: Date.now() - 1 });

    await expect(readMove(db, SOURCE, MACHINE)).resolves.toBeNull();

    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(false);
    expect(docs.has(pendingPath(SOURCE, MACHINE))).toBe(false);
  });

  it('never lapses a switching move: past its expiry it is answered and kept', async () => {
    const move = seedMove({ status: 'switching', expiresAt: Date.now() - 30 * DAY_MS });
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_site_move_1: siteMoveCommand(move.moveId) });

    await expect(readMove(db, SOURCE, MACHINE)).resolves.toEqual(move);

    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(true);
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toHaveProperty('cmd_site_move_1');
  });

  it('keeps a lapsed move the credential fetch turned switching before the delete', async () => {
    const move = seedMove({ expiresAt: Date.now() - 1 });
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_site_move_1: siteMoveCommand(move.moveId) });
    onTransaction = () => docs.set(movePath(SOURCE, MACHINE), { ...move, status: 'switching' });

    await expect(readMove(db, SOURCE, MACHINE)).resolves.toEqual({ ...move, status: 'switching' });

    expect(docs.get(movePath(SOURCE, MACHINE))).toMatchObject({ status: 'switching' });
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toHaveProperty('cmd_site_move_1');
  });

  it('still reads a lapsed move as gone when its delete fails', async () => {
    const move = seedMove({ expiresAt: Date.now() - 1 });
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_site_move_1: siteMoveCommand(move.moveId) });
    failUpdates.add(pendingPath(SOURCE, MACHINE));

    await expect(readMove(db, SOURCE, MACHINE)).resolves.toBeNull();
  });
});

describe('readMoveById', () => {
  it('answers the move by its id', async () => {
    const move = seedMove();

    await expect(readMoveById(db, move.moveId)).resolves.toEqual(move);
  });

  it('answers a lapsed pending move as stored, so its caller can tell lapsed from missing', async () => {
    const move = seedMove({ expiresAt: Date.now() - 1 });

    await expect(readMoveById(db, move.moveId)).resolves.toEqual(move);
    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(true);
  });

  it('answers null for a missing, empty or nested id', async () => {
    seedMove();

    await expect(readMoveById(db, `${SOURCE}:kiosk-9`)).resolves.toBeNull();
    await expect(readMoveById(db, '')).resolves.toBeNull();
    await expect(readMoveById(db, `${SOURCE}:${MACHINE}/x/y`)).resolves.toBeNull();
  });

  it('answers null for a record that is not a move', async () => {
    docs.set(movePath(SOURCE, MACHINE), { sourceSiteId: SOURCE, machineId: MACHINE, status: 'done' });

    await expect(readMoveById(db, `${SOURCE}:${MACHINE}`)).resolves.toBeNull();
  });
});

describe('moveRefusal', () => {
  const refusal = () => moveRefusal(db, { sourceSiteId: SOURCE, machineId: MACHINE });

  it('answers null for an idle machine', async () => {
    await expect(refusal()).resolves.toBeNull();
  });

  it.each(['install_software', 'uninstall_software', 'update_owlette', 'sync_pull'])(
    'is busy while %s is queued',
    async (type) => {
      docs.set(pendingPath(SOURCE, MACHINE), { cmd_1: { type } });

      await expect(refusal()).resolves.toBe('machine_busy');
    },
  );

  it('is not busy over other queued commands, its own site_move included', async () => {
    docs.set(pendingPath(SOURCE, MACHINE), {
      cmd_restart: { type: 'restart_process', status: 'pending' },
      cmd_move: siteMoveCommand(`${SOURCE}:${MACHINE}`),
    });

    await expect(refusal()).resolves.toBeNull();
  });

  it("is not busy over another machine's install", async () => {
    docs.set(pendingPath(SOURCE, 'kiosk-2'), { cmd_1: { type: 'install_software' } });

    await expect(refusal()).resolves.toBeNull();
  });

  it.each(['pending', 'in_progress'])('is busy while a %s deployment names it', async (status) => {
    docs.set(`sites/${SOURCE}/deployments/deploy-1`, {
      status,
      targets: [
        { machineId: 'kiosk-2', status: 'completed' },
        { machineId: MACHINE, status: 'installing' },
      ],
    });

    await expect(refusal()).resolves.toBe('machine_busy');
  });

  it.each(['completed', 'failed', 'partial', 'cancelled', 'uninstalled'])(
    'is not busy over a %s deployment that names it',
    async (status) => {
      docs.set(`sites/${SOURCE}/deployments/deploy-1`, { status, targets: [{ machineId: MACHINE, status: 'completed' }] });

      await expect(refusal()).resolves.toBeNull();
    },
  );

  it('is not busy over a deployment in flight that names other machines, or on another site', async () => {
    docs.set(`sites/${SOURCE}/deployments/deploy-1`, {
      status: 'in_progress',
      targets: [{ machineId: 'kiosk-2', status: 'installing' }],
    });
    docs.set(`sites/${OTHER}/deployments/deploy-2`, {
      status: 'in_progress',
      targets: [{ machineId: MACHINE, status: 'installing' }],
    });

    await expect(refusal()).resolves.toBeNull();
  });

  it('asks for deployments by status alone, which needs no composite index', async () => {
    await refusal();

    expect(queries.filter((q) => q.path === `sites/${SOURCE}/deployments`)).toEqual([
      { path: `sites/${SOURCE}/deployments`, filters: [['status', 'in', ['pending', 'in_progress']]] },
    ]);
  });
});

describe('cancelMove', () => {
  const cancel = () => cancelMove(db, SOURCE, MACHINE);

  it('deletes a pending move and its site_move command, and answers the move', async () => {
    const move = seedMove();
    docs.set(pendingPath(SOURCE, MACHINE), {
      cmd_site_move_1: siteMoveCommand(move.moveId),
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });

    await expect(cancel()).resolves.toEqual({ outcome: 'cancelled', move });

    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(false);
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toEqual({
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });
  });

  it('cancels a pending move past its expiry too', async () => {
    const move = seedMove({ expiresAt: Date.now() - 1 });

    await expect(cancel()).resolves.toEqual({ outcome: 'cancelled', move });
    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(false);
  });

  it('keeps a switching move and its command: the agent already holds the new credentials', async () => {
    const move = seedMove({ status: 'switching' });
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_site_move_1: siteMoveCommand(move.moveId) });

    await expect(cancel()).resolves.toEqual({ outcome: 'switching', move });

    expect(docs.get(movePath(SOURCE, MACHINE))).toMatchObject({ status: 'switching' });
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toHaveProperty('cmd_site_move_1');
  });

  it('keeps a move the credential fetch turned switching after it was last read', async () => {
    const move = seedMove();
    onTransaction = () => docs.set(movePath(SOURCE, MACHINE), { ...move, status: 'switching' });

    await expect(cancel()).resolves.toEqual({ outcome: 'switching', move: { ...move, status: 'switching' } });
    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(true);
  });

  it('answers missing when the machine has no move', async () => {
    seedMove({ machineId: 'kiosk-2' });

    await expect(cancel()).resolves.toEqual({ outcome: 'missing' });
    expect(docs.has(movePath(SOURCE, 'kiosk-2'))).toBe(true);
  });
});

describe('dropRefusedMove', () => {
  const drop = (targetSiteId = TARGET) => dropRefusedMove(db, SOURCE, MACHINE, targetSiteId);

  it('drops a pending move to the refusing site with its site_move command, and answers it', async () => {
    const move = seedMove();
    docs.set(pendingPath(SOURCE, MACHINE), {
      cmd_site_move_1: siteMoveCommand(move.moveId),
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });

    await expect(drop()).resolves.toEqual(move);

    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(false);
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toEqual({
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });
  });

  it('keeps a switching move and its command: its confirm still needs it', async () => {
    const move = seedMove({ status: 'switching' });
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_site_move_1: siteMoveCommand(move.moveId) });

    await expect(drop()).resolves.toBeNull();

    expect(docs.get(movePath(SOURCE, MACHINE))).toMatchObject({ status: 'switching' });
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toHaveProperty('cmd_site_move_1');
  });

  it('keeps a move asked for since to another site', async () => {
    seedMove({ targetSiteId: OTHER });

    await expect(drop()).resolves.toBeNull();
    expect(docs.get(movePath(SOURCE, MACHINE))).toMatchObject({ targetSiteId: OTHER, status: 'pending' });
  });

  it('answers null when the machine has no move', async () => {
    await expect(drop()).resolves.toBeNull();
  });
});

describe('switchingMoveForSite', () => {
  it('answers a switching move into the site, or out of it', async () => {
    const into = seedMove({ sourceSiteId: OTHER, targetSiteId: SOURCE, status: 'switching' });
    await expect(switchingMoveForSite(db, SOURCE)).resolves.toEqual(into);

    docs.clear();
    const out = seedMove({ sourceSiteId: SOURCE, targetSiteId: OTHER, status: 'switching' });
    await expect(switchingMoveForSite(db, SOURCE)).resolves.toEqual(out);
  });

  it('answers null for pending moves, and for a switching move between other sites', async () => {
    seedMove({ sourceSiteId: SOURCE, machineId: 'kiosk-1', targetSiteId: OTHER });
    seedMove({ sourceSiteId: OTHER, machineId: 'kiosk-2', targetSiteId: SOURCE });
    seedMove({ sourceSiteId: TARGET, machineId: 'kiosk-3', targetSiteId: OTHER, status: 'switching' });

    await expect(switchingMoveForSite(db, SOURCE)).resolves.toBeNull();
  });
});

describe('cancelMovesForSite', () => {
  it('deletes every move into or out of the site, of any status, with its site_move command', async () => {
    const out = seedMove({ sourceSiteId: SOURCE, machineId: 'kiosk-1', targetSiteId: OTHER });
    const into = seedMove({ sourceSiteId: OTHER, machineId: 'kiosk-2', targetSiteId: SOURCE, status: 'switching' });
    const unrelated = seedMove({ sourceSiteId: TARGET, machineId: 'kiosk-3', targetSiteId: OTHER });
    docs.set(pendingPath(SOURCE, 'kiosk-1'), { cmd_a: siteMoveCommand(out.moveId), cmd_keep: { type: 'restart_process' } });
    docs.set(pendingPath(OTHER, 'kiosk-2'), { cmd_b: siteMoveCommand(into.moveId) });
    docs.set(pendingPath(TARGET, 'kiosk-3'), { cmd_c: siteMoveCommand(unrelated.moveId) });

    await expect(cancelMovesForSite(db, SOURCE)).resolves.toBe(2);

    expect([...docs.keys()].filter((p) => p.startsWith('machine_moves/'))).toEqual([movePath(TARGET, 'kiosk-3')]);
    expect(docs.get(pendingPath(SOURCE, 'kiosk-1'))).toEqual({ cmd_keep: { type: 'restart_process' } });
    expect(docs.get(pendingPath(OTHER, 'kiosk-2'))).toEqual({});
    expect(docs.get(pendingPath(TARGET, 'kiosk-3'))).toHaveProperty('cmd_c');
  });

  it('answers 0 for a site with no moves', async () => {
    seedMove({ sourceSiteId: TARGET, targetSiteId: OTHER });

    await expect(cancelMovesForSite(db, SOURCE)).resolves.toBe(0);
    expect(docs.has(movePath(TARGET, MACHINE))).toBe(true);
  });

  it("still deletes the moves when a machine's command cannot be cleared", async () => {
    const first = seedMove({ machineId: 'kiosk-1' });
    const second = seedMove({ machineId: 'kiosk-2' });
    docs.set(pendingPath(SOURCE, 'kiosk-1'), { cmd_a: siteMoveCommand(first.moveId) });
    docs.set(pendingPath(SOURCE, 'kiosk-2'), { cmd_b: siteMoveCommand(second.moveId) });
    failUpdates.add(pendingPath(SOURCE, 'kiosk-1'));

    await expect(cancelMovesForSite(db, SOURCE)).resolves.toBe(2);

    expect([...docs.keys()].filter((p) => p.startsWith('machine_moves/'))).toEqual([]);
    expect(docs.get(pendingPath(SOURCE, 'kiosk-2'))).toEqual({});
  });

  it('throws when the moves cannot be deleted, leaving their commands for a retry', async () => {
    const move = seedMove();
    docs.set(pendingPath(SOURCE, MACHINE), { cmd_a: siteMoveCommand(move.moveId) });
    failBatches = true;

    await expect(cancelMovesForSite(db, SOURCE)).rejects.toThrow('batch refused');

    expect(docs.has(movePath(SOURCE, MACHINE))).toBe(true);
    expect(docs.get(pendingPath(SOURCE, MACHINE))).toHaveProperty('cmd_a');
  });
});
