/** @jest-environment node */

/**
 * fleet dispatch against an in-memory admin-sdk fake passed in as `db`. the
 * real `executeMachineCommand` writes the pending entry, so these tests see the
 * command the agent would pick up and the audit row it emits.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';

// the module's imports (hoot-utils.server, executeMachineCommand.server) reach
// the admin sdk, which initialises on import.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
const mockRequireEntitlement = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: (...args: unknown[]) => mockRequireEntitlement(...args),
}));
jest.mock('@/lib/screenshotStorage.server', () => ({
  issueScreenshotReadUrl: jest.fn(async (path: string) => ({
    url: `https://signed.example/${path}`,
    expiresAt: '2026-11-10T13:00:00.000Z',
  })),
}));
// the process actions write through the admin sdk's own db, so the tools that
// reach them are followed to the action's door and no further.
const mockCreateProcess = jest.fn();
const mockUpdateProcess = jest.fn();
const mockDeleteProcess = jest.fn();
jest.mock('@/lib/actions/createProcess.server', () => ({
  ...jest.requireActual('@/lib/actions/createProcess.server'),
  createProcess: (...args: unknown[]) => mockCreateProcess(...args),
}));
jest.mock('@/lib/actions/updateProcess.server', () => ({
  updateProcess: (...args: unknown[]) => mockUpdateProcess(...args),
}));
jest.mock('@/lib/actions/deleteProcess.server', () => ({
  deleteProcess: (...args: unknown[]) => mockDeleteProcess(...args),
}));

import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { Capability } from '@/lib/capabilities';
import { MAX_TOOL_TIMEOUT_SECONDS } from '@/lib/hoot-utils.server';
import { problemPlanRequired, problemRateLimited } from '@/lib/apiErrors';
import type { AdmitFleetCall, FleetContext } from '@/lib/fleet/context';
import type { FleetGrant } from '@/lib/fleet/policy.server';
import { FLEET_CALLS_COLLECTION, type FleetCallRecord } from '@/lib/fleet/calls.server';
import {
  readFleetCall,
  startFleetCall,
  type FleetCallRead,
  type FleetCallStart,
} from '@/lib/fleet/dispatch.server';

type Data = Record<string, unknown>;

const SITE = 'site-a';
const SENDER = 'sender-1';
const OTHER_SENDER = 'sender-2';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';
const machinePath = (id: string) => `sites/${SITE}/machines/${id}`;
const pendingPath = (id: string) => `${machinePath(id)}/commands/pending`;
const completedPath = (id: string) => `${machinePath(id)}/commands/completed`;
const recordPath = (commandId: string) => `${FLEET_CALLS_COLLECTION}/${commandId}`;

let docs: Map<string, Data>;
let reads: string[];
let queries: Array<{ path: string; filters: unknown[]; max: number | null }>;
let updateError: Error | null;
let recordWriteError: Error | null;
let queryError: Error | null;

function isDelete(value: unknown): boolean {
  return value instanceof FieldValue && value.isEqual(FieldValue.delete());
}

function docRef(path: string) {
  return {
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => {
      reads.push(path);
      const data = docs.get(path);
      return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
    },
    set: async (payload: Data, options?: { merge?: boolean }) => {
      if (recordWriteError && path.startsWith(`${FLEET_CALLS_COLLECTION}/`)) throw recordWriteError;
      docs.set(path, options?.merge ? { ...docs.get(path), ...payload } : payload);
    },
    update: async (payload: Data) => {
      if (updateError) throw updateError;
      const next = { ...docs.get(path) };
      for (const [key, value] of Object.entries(payload)) {
        if (isDelete(value)) delete next[key];
        else next[key] = value;
      }
      docs.set(path, next);
    },
    delete: async () => {
      docs.delete(path);
    },
  };
}

function children(path: string) {
  const prefix = `${path}/`;
  return [...docs.entries()]
    .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .map(([p, data]) => ({ id: p.slice(prefix.length), ref: docRef(p), data: () => data }));
}

type Filter = [field: string, op: string, value: unknown];

function query(path: string, filters: Filter[], max: number | null = null) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==' && op !== '<=' && op !== '>=') throw new Error(`fake firestore answers ==, <= and >= only, got ${op}`);
      return query(path, [...filters, [field, op, value]], max);
    },
    // rows come back in the order a test stored them
    orderBy: () => query(path, filters, max),
    limit: (count: number) => query(path, filters, count),
    get: async () => {
      if (queryError) throw queryError;
      reads.push(path);
      queries.push({ path, filters, max });
      const found = children(path).filter((doc) =>
        filters.every(([f, op, v]) => {
          const stored = doc.data()[f];
          if (op === '==') return stored === v;
          return op === '<=' ? (stored as number) <= (v as number) : (stored as number) >= (v as number);
        }),
      );
      const page = max === null ? found : found.slice(0, max);
      return { empty: page.length === 0, docs: page };
    },
  };
}

function collectionRef(path: string) {
  return {
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, op: string, value: unknown) => query(path, []).where(field, op, value),
    get: async () => {
      reads.push(path);
      return { docs: children(path) };
    },
  };
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
} as unknown as Firestore;

function ctxFor(grant: FleetGrant): FleetContext {
  return {
    actor: { type: 'machine', siteId: SITE, machineId: SENDER, maxTier: grant.maxTier, machineIds: grant.machineIds },
    siteId: SITE,
    machineId: SENDER,
    grant,
    correlationId: 'corr-1',
    db,
  };
}

const TIER2_TO_M1 = ctxFor({ maxTier: 2, machineIds: [M1] });

const admit = jest.fn<ReturnType<AdmitFleetCall>, Parameters<AdmitFleetCall>>();

function pendingEntries(machine: string): Array<[string, Data]> {
  return Object.entries(docs.get(pendingPath(machine)) ?? {}) as Array<[string, Data]>;
}

function onlyPending(machine: string): Data {
  const entries = pendingEntries(machine);
  expect(entries).toHaveLength(1);
  return entries[0][1];
}

function hasRecords(): boolean {
  return [...docs.keys()].some((p) => p.startsWith(`${FLEET_CALLS_COLLECTION}/`));
}

async function refusedWith(promise: Promise<FleetCallStart | FleetCallRead>, status: number, code: string) {
  const result = await promise;
  if (result.ok) throw new Error(`expected a ${status} refusal, got ${JSON.stringify(result)}`);
  expect(result.response.status).toBe(status);
  expect((await result.response.json()).code).toBe(code);
  return result;
}

function started(result: FleetCallStart): { callId: string; timeoutSeconds: number } {
  if (!result.ok || result.kind !== 'started') throw new Error(`expected a started call, got ${JSON.stringify(result)}`);
  return result.body;
}

function answered(result: FleetCallStart) {
  if (!result.ok || result.kind !== 'answered') throw new Error(`expected an inline answer, got ${JSON.stringify(result)}`);
  return result.body;
}

/** the one text item of a call the server answered and completed. */
function completedText(result: FleetCallStart): string {
  const body = answered(result);
  if (body.status !== 'completed') throw new Error(`expected a completed answer, got ${JSON.stringify(body)}`);
  expect(body.content).toHaveLength(1);
  expect(body.content[0].type).toBe('text');
  return body.content[0].text;
}

function readBody(result: FleetCallRead) {
  if (!result.ok) throw new Error('expected a read');
  return result.body;
}

async function notFound(promise: Promise<FleetCallRead>) {
  const result = await promise;
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(404);
    expect(result.deny).toBeUndefined();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  reads = [];
  queries = [];
  updateError = null;
  recordWriteError = null;
  queryError = null;
  admit.mockResolvedValue(null);
  mockRequireEntitlement.mockResolvedValue(null);
  docs.set(machinePath(M1), { online: true });
  docs.set(machinePath(M2), { online: true });
  docs.set(machinePath(SENDER), { online: true });
});

describe('startFleetCall: refusals, in order', () => {
  it.each([
    ['an unknown tool', 'format_disk', 'format_disk'],
    ['a tool above the grant', 'execute_script', 'execute_script'],
    ['a hoot tool that needs a person', 'create_talon', 'create_talon'],
    ['hoot\'s deploy', 'deploy_software', 'deploy_software'],
    ['a tool that is not a string', 42, null],
    ['an over-long name, bounded in the deny', 'x'.repeat(500), 'x'.repeat(128)],
  ])('403 tool_not_allowed for %s', async (_label, tool, deniedTool) => {
    const res = await refusedWith(startFleetCall(TIER2_TO_M1, { tool, params: { machine: M1 } }, admit), 403, 'tool_not_allowed');
    expect(res.deny).toEqual({ reason: 'tool_not_allowed', tool: deniedTool, machineId: null });
    expect(reads).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it.each([
    ['no params', undefined],
    ['no machine', { process_name: 'td.exe' }],
    ['an empty machine', { machine: '' }],
    ['a machine id that is a path', { machine: `${M1}/commands/pending` }],
  ])('400 validation_failed for %s', async (_label, params) => {
    const res = await refusedWith(startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params }, admit), 400, 'validation_failed');
    expect(res.deny).toEqual({ reason: 'validation_failed', tool: 'restart_process', machineId: null });
    expect(reads).toEqual([]);
  });

  it('403 machine_not_granted for a machine outside the grant, before any read', async () => {
    const res = await refusedWith(
      startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M2, process_name: 'td.exe' } }, admit),
      403,
      'machine_not_granted',
    );
    expect(res.deny).toEqual({ reason: 'machine_not_granted', tool: 'restart_process', machineId: M2 });
    expect(reads).toEqual([]);
    expect(pendingEntries(M2)).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it('403 machine_not_granted when the grant names no machine', async () => {
    await refusedWith(
      startFleetCall(ctxFor({ maxTier: 3, machineIds: [] }), { tool: 'get_system_info', params: { machine: M1 } }, admit),
      403,
      'machine_not_granted',
    );
  });

  it('404 for a machine the whole-site grant reaches but the site does not hold', async () => {
    const res = await refusedWith(
      startFleetCall(ctxFor({ maxTier: 2, machineIds: null }), { tool: 'get_system_info', params: { machine: 'ghost' } }, admit),
      404,
      'not_found',
    );
    expect(res.deny).toEqual({ reason: 'not_found', tool: 'get_system_info', machineId: 'ghost' });
  });

  it('409 hoot_disabled when hoot is off on the target', async () => {
    docs.set(machinePath(M1), { online: true, cortexEnabled: false });
    const res = await refusedWith(
      startFleetCall(TIER2_TO_M1, { tool: 'get_system_info', params: { machine: M1 } }, admit),
      409,
      'hoot_disabled',
    );
    expect(res.deny).toEqual({ reason: 'hoot_disabled', tool: 'get_system_info', machineId: M1 });
    expect(pendingEntries(M1)).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
  });

  it("admit's refusal comes back as it is, with no deny, and nothing is queued or recorded", async () => {
    const limited = problemRateLimited(30);
    admit.mockResolvedValue(limited);
    const res = await startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, admit);
    expect(res).toEqual({ ok: false, response: limited });
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: M1 });
    expect(pendingEntries(M1)).toEqual([]);
    expect(hasRecords()).toBe(false);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('409 machine_offline from the command path, after admit, queueing and recording nothing', async () => {
    docs.set(machinePath(M1), { online: false });
    const res = await refusedWith(
      startFleetCall(TIER2_TO_M1, { tool: 'get_system_info', params: { machine: M1 } }, admit),
      409,
      'machine_offline',
    );
    expect(res.deny).toEqual({ reason: 'machine_offline', tool: 'get_system_info', machineId: M1 });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(pendingEntries(M1)).toEqual([]);
    expect(hasRecords()).toBe(false);
    expect(emitMutation).not.toHaveBeenCalled();
  });

  it('402 plan_required from the command path', async () => {
    mockRequireEntitlement.mockResolvedValue(problemPlanRequired('needs hoot', 'owlette.hoot'));
    const res = await refusedWith(
      startFleetCall(TIER2_TO_M1, { tool: 'get_system_info', params: { machine: M1 } }, admit),
      402,
      'plan_required',
    );
    expect(res.deny).toEqual({ reason: 'plan_required', tool: 'get_system_info', machineId: M1 });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
  });
});

describe('startFleetCall: list_machines', () => {
  beforeEach(() => {
    const now = Date.now();
    // the os fields as an agent since 3.4 writes them; SENDER below is an older agent's doc
    docs.set(machinePath(M1), { online: true, lastHeartbeat: now - 12_000, osFamily: 'linux', osVersion: 'Ubuntu 24.04.5 LTS', agent_version: '4.1.28' });
    docs.set(machinePath(M2), { online: false, cortexEnabled: false, osFamily: 'macos', osVersion: 'macOS 26.6', presence: { lastHeartbeat: now - 600_000, agent_version: '4.1.27' } });
    docs.set(machinePath(SENDER), { online: 'yes' });
  });

  async function listed(grant: FleetGrant) {
    const res = await startFleetCall(ctxFor(grant), { tool: 'list_machines', params: {} }, admit);
    return JSON.parse(completedText(res));
  }

  it('answers inline with the machines the grant covers, each in the contract shape', async () => {
    expect(await listed({ maxTier: 1, machineIds: [M1, SENDER] })).toEqual([
      { id: M1, online: true, lastHeartbeatAgeSeconds: expect.any(Number), os: 'linux', osVersion: 'Ubuntu 24.04.5 LTS', agentVersion: '4.1.28', hootEnabled: true },
      { id: SENDER, online: false, lastHeartbeatAgeSeconds: null, os: 'windows', osVersion: null, agentVersion: null, hootEnabled: true },
    ]);
  });

  it('is admitted as a view of no machine, before anything is read', async () => {
    admit.mockResolvedValue(problemRateLimited(5));
    const res = await startFleetCall(ctxFor({ maxTier: 1, machineIds: null }), { tool: 'list_machines', params: {} }, admit);
    expect(res.ok).toBe(false);
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_VIEW, tool: 'list_machines', machineId: null });
    expect(reads).toEqual([]);
  });

  it('reads presence fields, a heartbeat age and the hoot switch', async () => {
    const [machine] = await listed({ maxTier: 1, machineIds: [M2] });
    expect(machine).toMatchObject({ id: M2, online: false, os: 'macos', osVersion: 'macOS 26.6', agentVersion: '4.1.27', hootEnabled: false });
    expect(machine.lastHeartbeatAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(machine.lastHeartbeatAgeSeconds).toBeLessThan(610);
  });

  it('lists every machine for a whole-site grant and none for an empty one', async () => {
    expect((await listed({ maxTier: 1, machineIds: null })).map((m: { id: string }) => m.id)).toEqual([M1, M2, SENDER]);
    expect(await listed({ maxTier: 3, machineIds: [] })).toEqual([]);
  });

  it('queues nothing and records no call', async () => {
    await listed({ maxTier: 3, machineIds: null });
    expect(docs.has(pendingPath(M1))).toBe(false);
    expect(hasRecords()).toBe(false);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('startFleetCall: the site log', () => {
  const logsPath = `sites/${SITE}/logs`;

  /** one entry per machine named, newest first, as the log's own order has them. */
  function storeLogs(machines: Array<string | undefined>) {
    machines.forEach((machineId, index) => {
      docs.set(`${logsPath}/log-${String(index).padStart(3, '0')}`, {
        timestamp: new Date(Date.now() - index * 60_000),
        ...(machineId === undefined ? {} : { machineId }),
        action: 'process_crash',
        level: 'error',
        processName: 'td.exe',
        details: `entry ${index}`,
      });
    });
  }

  async function siteLogs(grant: FleetGrant, params: Record<string, unknown> = {}) {
    const res = await startFleetCall(ctxFor(grant), { tool: 'get_site_logs', params }, admit);
    return JSON.parse(completedText(res)) as { logs: Array<{ machine: string; details: string }>; count: number };
  }

  function askedFor(): number | null {
    return queries.find((query) => query.path === logsPath)?.max ?? null;
  }

  it('is a tier 1 read, admitted as a view of no machine before anything is read', async () => {
    admit.mockResolvedValue(problemRateLimited(5));
    const res = await startFleetCall(ctxFor({ maxTier: 1, machineIds: [M1] }), { tool: 'get_site_logs', params: {} }, admit);
    expect(res.ok).toBe(false);
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_VIEW, tool: 'get_site_logs', machineId: null });
    expect(reads).toEqual([]);
  });

  it('gives a grant that names its machines only their entries', async () => {
    storeLogs([M1, M2, undefined, SENDER, M1]);
    const body = await siteLogs({ maxTier: 1, machineIds: [M1] });
    expect(body.logs.map((row) => [row.machine, row.details])).toEqual([[M1, 'entry 0'], [M1, 'entry 4']]);
    expect(body.count).toBe(2);
  });

  it('asks the log for the most it gives, then keeps as many as the caller asked for', async () => {
    storeLogs([M1, M2, M1, M1, M2, M1]);
    const body = await siteLogs({ maxTier: 1, machineIds: [M1] }, { limit: 2 });
    expect(askedFor()).toBe(200);
    expect(body.logs.map((row) => row.details)).toEqual(['entry 0', 'entry 2']);
    expect(body.count).toBe(2);
  });

  it('gives a grant that names no machine nothing, and reads nothing to find that out', async () => {
    storeLogs([M1, M2]);
    expect(await siteLogs({ maxTier: 3, machineIds: [] })).toEqual({ logs: [], count: 0 });
    expect(reads).toEqual([]);
  });

  it('says so when the read came back full, since older entries of its machines may lie beyond it', async () => {
    storeLogs([...Array<string>(199).fill(M2), M1]);
    expect(await siteLogs({ maxTier: 1, machineIds: [M1] })).toMatchObject({
      count: 1,
      incomplete: expect.stringContaining('narrow hours, level or action'),
    });
  });

  it('says nothing of the kind when the read held the whole window', async () => {
    storeLogs([M1, M2]);
    expect(await siteLogs({ maxTier: 1, machineIds: [M1] })).not.toHaveProperty('incomplete');
  });

  it('gives a whole-site grant the log as it is, asked for at the caller\'s limit', async () => {
    storeLogs([M1, M2, undefined]);
    const body = await siteLogs({ maxTier: 1, machineIds: null }, { limit: 10 });
    expect(askedFor()).toBe(10);
    expect(body.logs.map((row) => row.machine)).toEqual([M1, M2, 'unknown']);
    expect(body).not.toHaveProperty('incomplete');
  });

  it.each([
    ['a limit of zero', { limit: 0 }, 50],
    ['a negative limit', { limit: -5 }, 50],
    ['a limit that is not a number', { limit: '10' }, 50],
    ['a limit past the cap', { limit: 5000 }, 200],
    ['a fractional limit', { limit: 0.4 }, 1],
  ])('never hands the query %s', async (_label, params, asked) => {
    storeLogs([M1]);
    await siteLogs({ maxTier: 1, machineIds: null }, params);
    expect(askedFor()).toBe(asked);
  });

  it('drops a window that is no positive number, so the log falls back to its day', async () => {
    storeLogs([M1]);
    const body = (await siteLogs({ maxTier: 1, machineIds: null }, { hours: -3 })) as unknown as { hours: number };
    expect(body.hours).toBe(24);
  });

  it('queues nothing and records no call', async () => {
    storeLogs([M1]);
    await siteLogs({ maxTier: 1, machineIds: [M1] });
    expect(docs.has(pendingPath(M1))).toBe(false);
    expect(hasRecords()).toBe(false);
    expect(emitMutation).not.toHaveBeenCalled();
  });
});

describe('startFleetCall: the process tools', () => {
  const configPath = (machine: string) => `config/${SITE}/machines/${machine}`;

  beforeEach(() => {
    docs.set(configPath(M1), { processes: [{ processId: 'proc-1', name: 'TouchDesigner' }] });
    docs.set(configPath(M2), { processes: [{ processId: 'proc-9', name: 'TouchDesigner' }] });
    mockUpdateProcess.mockResolvedValue({ processId: 'proc-1' });
    mockCreateProcess.mockResolvedValue({ processId: 'proc-2' });
    mockDeleteProcess.mockResolvedValue({ processId: 'proc-1', alreadyDeleted: false });
  });

  const AS_SENDER = { siteId: SITE, actor: TIER2_TO_M1.actor, auditActor: `machine:${SENDER}` };

  it('update_process runs on the server as the calling machine and is answered in the response', async () => {
    const res = await startFleetCall(
      TIER2_TO_M1,
      { tool: 'update_process', params: { machine: M1, process_name: 'TouchDesigner', launch_mode: 'always' } },
      admit,
    );
    expect(JSON.parse(completedText(res))).toEqual({ ok: true, processId: 'proc-1', process_name: 'TouchDesigner' });
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'update_process', machineId: M1 });
    expect(mockUpdateProcess).toHaveBeenCalledWith(AS_SENDER, {
      machineId: M1,
      processId: 'proc-1',
      patch: { launch_mode: 'always' },
    });
    // no command to an agent: the config write is the whole call
    expect(pendingEntries(M1)).toEqual([]);
    expect(hasRecords()).toBe(false);
  });

  it('delete_process acts on the machine it names, as the calling machine', async () => {
    const res = await startFleetCall(TIER2_TO_M1, { tool: 'delete_process', params: { machine: M1, process_name: 'TouchDesigner' } }, admit);
    expect(JSON.parse(completedText(res))).toMatchObject({ ok: true, processId: 'proc-1' });
    expect(mockDeleteProcess).toHaveBeenCalledWith(AS_SENDER, { machineId: M1, processId: 'proc-1' });
  });

  it('add_process is handed only the parameters its definition declares', async () => {
    const res = await startFleetCall(
      TIER2_TO_M1,
      {
        tool: 'add_process',
        params: {
          machine: M1,
          name: 'Notepad',
          exe_path: 'C:/Windows/notepad.exe',
          not_a_field: 'x',
          override_active_hours: true,
        },
      },
      admit,
    );
    expect(JSON.parse(completedText(res))).toEqual({ ok: true, processId: 'proc-2', name: 'Notepad' });
    expect(mockCreateProcess).toHaveBeenCalledWith(AS_SENDER, {
      machineId: M1,
      name: 'Notepad',
      exe_path: 'C:/Windows/notepad.exe',
    });
  });

  it('a failure the tool reports is a failed answer, not a refusal', async () => {
    const res = await startFleetCall(TIER2_TO_M1, { tool: 'delete_process', params: { machine: M1, process_name: 'Resolume' } }, admit);
    expect(answered(res)).toEqual({
      status: 'failed',
      error: `process_not_found: Process "Resolume" was not found on machine ${M1}.`,
    });
    expect(mockDeleteProcess).not.toHaveBeenCalled();
  });

  it.each(['update_process', 'add_process', 'delete_process'])(
    '%s is refused on a machine outside the grant, before any read or admission',
    async (tool) => {
      const res = await refusedWith(
        startFleetCall(TIER2_TO_M1, { tool, params: { machine: M2, process_name: 'TouchDesigner', name: 'n', exe_path: 'x' } }, admit),
        403,
        'machine_not_granted',
      );
      expect(res.deny).toEqual({ reason: 'machine_not_granted', tool, machineId: M2 });
      expect(reads).toEqual([]);
      expect(admit).not.toHaveBeenCalled();
      for (const action of [mockUpdateProcess, mockCreateProcess, mockDeleteProcess]) expect(action).not.toHaveBeenCalled();
    },
  );

  it.each(['update_process', 'add_process', 'delete_process'])('%s is not offered to a tier 1 grant', async (tool) => {
    await refusedWith(
      startFleetCall(ctxFor({ maxTier: 1, machineIds: [M1] }), { tool, params: { machine: M1 } }, admit),
      403,
      'tool_not_allowed',
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it('is refused when hoot is off on the machine, with nothing written', async () => {
    docs.set(machinePath(M1), { online: true, cortexEnabled: false });
    await refusedWith(
      startFleetCall(TIER2_TO_M1, { tool: 'update_process', params: { machine: M1, process_name: 'TouchDesigner' } }, admit),
      409,
      'hoot_disabled',
    );
    expect(mockUpdateProcess).not.toHaveBeenCalled();
  });

  it('runs on a machine that is offline: a config write needs no agent to answer', async () => {
    docs.set(machinePath(M1), { online: false });
    const res = await startFleetCall(TIER2_TO_M1, { tool: 'update_process', params: { machine: M1, process_name: 'TouchDesigner' } }, admit);
    expect(answered(res).status).toBe('completed');
  });

  it("admit's refusal comes back as it is, and the action never runs", async () => {
    const limited = problemRateLimited(30);
    admit.mockResolvedValue(limited);
    const res = await startFleetCall(TIER2_TO_M1, { tool: 'update_process', params: { machine: M1, process_name: 'TouchDesigner' } }, admit);
    expect(res).toEqual({ ok: false, response: limited });
    expect(mockUpdateProcess).not.toHaveBeenCalled();
  });
});

describe('startFleetCall: the two mappings', () => {
  it('a tool in EXISTING_COMMAND_MAPPINGS queues that command type with its parameters', async () => {
    const body = started(
      await startFleetCall(TIER2_TO_M1, { tool: 'start_process', params: { machine: M1, process_name: 'td.exe' } }, admit),
    );
    const cmd = onlyPending(M1);
    expect(cmd).toMatchObject({ type: 'restart_process', process_name: 'td.exe', status: 'pending', machineId: M1 });
    expect(cmd).not.toHaveProperty('machine');
    expect(cmd).not.toHaveProperty('tool_name');
    expect(body.timeoutSeconds).toBe(30);
    expect(body.callId).toMatch(new RegExp(`^cmd:${M1}:cmd_[A-Za-z0-9_-]+$`));
    expect(body.callId.endsWith(`:${pendingEntries(M1)[0][0]}`)).toBe(true);
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'start_process', machineId: M1 });
  });

  it('any other tool queues mcp_tool_call with the tool, its parameters and the timeout', async () => {
    const body = started(
      await startFleetCall(ctxFor({ maxTier: 1, machineIds: [M1] }), { tool: 'get_system_info', params: { machine: M1 } }, admit),
    );
    expect(onlyPending(M1)).toMatchObject({
      type: 'mcp_tool_call',
      tool_name: 'get_system_info',
      tool_params: {},
      timeout_seconds: 30,
    });
    expect(body.timeoutSeconds).toBe(30);
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_VIEW, tool: 'get_system_info', machineId: M1 });
  });

  it('queues as the calling machine, with the correlation id, and the audit row names it and the tool', async () => {
    started(await startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, admit));
    const cmd = onlyPending(M1);
    expect(cmd.queuedBy).toBe(`machine:${SENDER}`);
    expect(cmd.auditCorrelationId).toBe('corr-1');
    expect(emitMutation).toHaveBeenCalledTimes(1);
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine_command_dispatched',
        siteId: SITE,
        actor: `machine:${SENDER}`,
        attributes: expect.objectContaining({ commandType: 'restart_process', machineId: M1, toolName: 'restart_process' }),
      }),
    );
  });

  it('a sender may act on itself when its grant covers it', async () => {
    const body = started(
      await startFleetCall(ctxFor({ maxTier: 1, machineIds: [SENDER] }), { tool: 'get_system_info', params: { machine: SENDER } }, admit),
    );
    expect(body.callId.startsWith(`cmd:${SENDER}:`)).toBe(true);
  });

  it('strips every active-hours override key and never sets an override', async () => {
    started(
      await startFleetCall(ctxFor({ maxTier: 3, machineIds: [M1] }), {
        tool: 'reboot_machine',
        params: {
          machine: M1,
          when: 'now',
          override_active_hours: true,
          override_reason: 'show is over',
          active_hours_override: { reason: 'show is over' },
          activeHoursOverride: { reason: 'show is over', approvedBy: 'user:someone' },
        },
      }, admit),
    );
    const cmd = onlyPending(M1);
    expect(cmd).toMatchObject({ type: 'reboot_machine', when: 'now' });
    for (const key of ['override_active_hours', 'override_reason', 'active_hours_override', 'activeHoursOverride']) {
      expect(cmd).not.toHaveProperty(key);
    }
  });

  it('strips override keys from an mcp tool call too', async () => {
    started(
      await startFleetCall(ctxFor({ maxTier: 2, machineIds: [M1] }), {
        tool: 'manage_windows_update',
        params: { machine: M1, action: 'get_status', override_active_hours: true, activeHoursOverride: { reason: 'x' } },
      }, admit),
    );
    const cmd = onlyPending(M1);
    expect(cmd.tool_params).toEqual({ action: 'get_status' });
    expect(cmd).not.toHaveProperty('activeHoursOverride');
  });
});

describe('startFleetCall: the call record', () => {
  it('binds the call to its caller and target, alive for its timeout plus an hour', async () => {
    const before = Date.now();
    const { callId, timeoutSeconds } = started(
      await startFleetCall(ctxFor({ maxTier: 3, machineIds: [M1] }), { tool: 'execute_script', params: { machine: M1, script: 'x' } }, admit),
    );
    const commandId = callId.split(':').pop()!;
    const record = docs.get(recordPath(commandId)) as unknown as FleetCallRecord;
    expect(record).toEqual({
      siteId: SITE,
      callerMachineId: SENDER,
      machineId: M1,
      tool: 'execute_script',
      createdAt: expect.any(Number),
      expiresAt: record.createdAt + (timeoutSeconds + 3600) * 1000,
    });
    expect(record.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('a record that cannot be written still starts the call, which then cannot be read back', async () => {
    recordWriteError = new Error('unavailable');
    const { callId } = started(
      await startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, admit),
    );
    expect(pendingEntries(M1)).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has no record'), expect.anything());
    await notFound(readFleetCall(TIER2_TO_M1, callId));
  });

  it('prunes expired records, whoever started them, asking for no live one', async () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 60_000;
    const record = { siteId: SITE, callerMachineId: SENDER, machineId: M1, tool: 't', createdAt: 0 };
    docs.set(recordPath('cmd_old_mine'), { ...record, expiresAt: past });
    docs.set(recordPath('cmd_live_mine'), { ...record, expiresAt: future });
    docs.set(recordPath('cmd_old_theirs'), { ...record, callerMachineId: OTHER_SENDER, expiresAt: past });
    docs.set(recordPath('cmd_old_elsewhere'), { ...record, siteId: 'site-b', expiresAt: past });
    started(await startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, admit));
    expect(docs.has(recordPath('cmd_old_mine'))).toBe(false);
    expect(docs.has(recordPath('cmd_old_theirs'))).toBe(false);
    expect(docs.has(recordPath('cmd_old_elsewhere'))).toBe(false);
    expect(docs.has(recordPath('cmd_live_mine'))).toBe(true);
    // one bounded query for expired records, so a caller's live ones are never read
    expect(queries.filter((q) => q.path === FLEET_CALLS_COLLECTION)).toEqual([
      { path: FLEET_CALLS_COLLECTION, filters: [['expiresAt', '<=', expect.any(Number)]], max: 500 },
    ]);
  });

  it('a prune that fails does not fail the call', async () => {
    queryError = new Error('unavailable');
    started(await startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, admit));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not prune'), expect.anything());
  });
});

describe('startFleetCall: timeoutSeconds', () => {
  const TIER3 = ctxFor({ maxTier: 3, machineIds: [M1] });

  async function timeoutFor(tool: string, params: Data) {
    docs.delete(pendingPath(M1));
    const body = started(await startFleetCall(TIER3, { tool, params: { machine: M1, ...params } }, admit));
    return { timeoutSeconds: body.timeoutSeconds, queued: onlyPending(M1).timeout_seconds };
  }

  it('clamps a tool timeout to MAX_TOOL_TIMEOUT_SECONDS', async () => {
    expect(await timeoutFor('execute_script', { script: 'x', timeout_seconds: 99_999 })).toEqual({
      timeoutSeconds: MAX_TOOL_TIMEOUT_SECONDS,
      queued: MAX_TOOL_TIMEOUT_SECONDS,
    });
  });

  it("takes the caller's timeout within the cap, and the tool's declared default without one", async () => {
    expect(await timeoutFor('execute_script', { script: 'x', timeout_seconds: 600 })).toEqual({ timeoutSeconds: 600, queued: 600 });
    expect(await timeoutFor('execute_script', { script: 'x' })).toEqual({ timeoutSeconds: 120, queued: 120 });
  });

  it('never goes under the default, and ignores a timeout that is not a positive number', async () => {
    expect(await timeoutFor('configure_gpu_tdr', { timeout_seconds: 10 })).toEqual({ timeoutSeconds: 30, queued: 30 });
    expect(await timeoutFor('execute_script', { script: 'x', timeout_seconds: -5 })).toEqual({ timeoutSeconds: 30, queued: 30 });
  });

  it('does not invent a timeout for a tool that defines none', async () => {
    expect(await timeoutFor('get_system_info', { timeout_seconds: 900 })).toEqual({ timeoutSeconds: 30, queued: 30 });
  });

  it('a mapped command takes the command default', async () => {
    const body = started(await startFleetCall(TIER3, { tool: 'reboot_machine', params: { machine: M1, timeout_seconds: 900 } }, admit));
    expect(body.timeoutSeconds).toBe(30);
  });
});

describe('readFleetCall', () => {
  const CID = 'cmd_abc123_xyz';
  const CALL = `cmd:${M1}:${CID}`;

  function seedRecord(overrides: Partial<FleetCallRecord> = {}) {
    docs.set(recordPath(CID), {
      siteId: SITE,
      callerMachineId: SENDER,
      machineId: M1,
      tool: 'get_system_info',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...overrides,
    });
  }

  function seedCompleted(entry: Data) {
    seedRecord();
    docs.set(completedPath(M1), { [CID]: entry, cmd_other: { status: 'completed', result: 'theirs' } });
  }

  it.each([
    ['empty', ''],
    ['another kind', `task:${M1}:${CID}`],
    ['the prefix alone', 'cmd:'],
    ['no command id', `cmd:${M1}`],
    ['a malformed command id', `cmd:${M1}:not_a_cmd`],
    ['an empty machine', `cmd::${CID}`],
    ['a colon inside the machine id', `cmd:${M1}:extra:${CID}`],
    ['a path for a machine id', `cmd:${M1}/commands/pending:${CID}`],
  ])('404 for %s, before any read', async (_label, callId) => {
    await notFound(readFleetCall(TIER2_TO_M1, callId));
    expect(reads).toEqual([]);
  });

  it('403 machine_not_granted for a callId on a machine outside the grant, before any read', async () => {
    docs.set(completedPath(M2), { [CID]: { status: 'completed', result: 'secret' } });
    const res = await refusedWith(readFleetCall(TIER2_TO_M1, `cmd:${M2}:${CID}`), 403, 'machine_not_granted');
    expect(res.deny).toBeUndefined();
    expect(reads).toEqual([]);
    expect(docs.get(completedPath(M2))).toHaveProperty(CID);
  });

  it('404 for a command someone else queued on a covered machine, which is neither read nor collected', async () => {
    docs.set(completedPath(M1), {
      [CID]: { type: 'capture_screenshot', status: 'completed', result: { storage_path: 'screenshots/a.jpg' } },
    });
    await notFound(readFleetCall(TIER2_TO_M1, CALL));
    expect(reads).toEqual([recordPath(CID)]);
    expect(docs.get(completedPath(M1))).toHaveProperty(CID);
  });

  it.each([
    ['another granted machine', { callerMachineId: OTHER_SENDER }],
    ['another site', { siteId: 'site-b' }],
    ['another target', { machineId: M2 }],
  ])('404 for a call that belongs to %s, and nothing is collected', async (_label, overrides) => {
    seedCompleted({ status: 'completed', result: 'theirs to collect' });
    seedRecord(overrides);
    await notFound(readFleetCall(TIER2_TO_M1, CALL));
    expect(reads).toEqual([recordPath(CID)]);
    expect(docs.get(completedPath(M1))).toHaveProperty(CID);
    expect(docs.has(recordPath(CID))).toBe(true);
  });

  it('404 for an expired record, which is deleted while the result stays', async () => {
    seedCompleted({ status: 'completed', result: 'late' });
    seedRecord({ expiresAt: Date.now() - 1 });
    await notFound(readFleetCall(TIER2_TO_M1, CALL));
    expect(reads).toEqual([recordPath(CID)]);
    expect(docs.has(recordPath(CID))).toBe(false);
    expect(docs.get(completedPath(M1))).toHaveProperty(CID);
  });

  it('404 for a recorded call in neither queue', async () => {
    seedRecord();
    await notFound(readFleetCall(TIER2_TO_M1, CALL));
  });

  it('pending, and the entry and record stay', async () => {
    seedRecord();
    docs.set(pendingPath(M1), { [CID]: { type: 'mcp_tool_call', status: 'pending' } });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL))).toEqual({ status: 'pending' });
    expect(docs.get(pendingPath(M1))).toHaveProperty(CID);
    expect(docs.has(recordPath(CID))).toBe(true);
  });

  it.each(['running', 'downloading'])('in_progress for a %s marker, and the entry and record stay', async (status) => {
    seedCompleted({ type: 'mcp_tool_call', status });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL))).toEqual({ status: 'in_progress' });
    expect(docs.get(completedPath(M1))).toHaveProperty(CID);
    expect(docs.has(recordPath(CID))).toBe(true);
  });

  it('completed with a json result: one text item, pretty-printed, then the entry and record are gone', async () => {
    seedCompleted({ type: 'mcp_tool_call', status: 'completed', result: '{"hostname":"kiosk-1","cpu":12}' });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL))).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: JSON.stringify({ hostname: 'kiosk-1', cpu: 12 }, null, 2) }],
    });
    expect(docs.get(completedPath(M1))).not.toHaveProperty(CID);
    expect(docs.get(completedPath(M1))).toHaveProperty('cmd_other');
    expect(docs.has(recordPath(CID))).toBe(false);
  });

  it('the starter reads its own result once; a repeat answers 404', async () => {
    const { callId } = started(
      await startFleetCall(TIER2_TO_M1, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, admit),
    );
    const commandId = callId.split(':').pop()!;
    expect(readBody(await readFleetCall(TIER2_TO_M1, callId))).toEqual({ status: 'pending' });
    docs.set(completedPath(M1), { [commandId]: { status: 'completed', result: 'Restarted td.exe' } });
    expect(readBody(await readFleetCall(TIER2_TO_M1, callId))).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: 'Restarted td.exe' }],
    });
    expect(docs.has(recordPath(commandId))).toBe(false);
    await notFound(readFleetCall(TIER2_TO_M1, callId));
  });

  it('completed with an object result: indented json', async () => {
    seedCompleted({ status: 'completed', result: { restarted: true } });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL)).content).toEqual([
      { type: 'text', text: JSON.stringify({ restarted: true }, null, 2) },
    ]);
  });

  it('completed with no result still says so', async () => {
    seedCompleted({ status: 'completed' });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL)).content).toEqual([
      { type: 'text', text: 'completed with no output' },
    ]);
  });

  it('a screenshot becomes an image_url item on the signed read url, with text', async () => {
    seedCompleted({ type: 'capture_screenshot', status: 'completed', result: { storage_path: 'screenshots/a.jpg', size_kb: 80 } });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL)).content).toEqual([
      {
        type: 'image_url',
        url: 'https://signed.example/screenshots/a.jpg',
        text: 'screenshot: https://signed.example/screenshots/a.jpg',
      },
    ]);
  });

  it.each([
    ['failed', 'reboot blocked: kiosk lock'],
    ['cancelled', 'cancelled by user'],
  ])('%s: the error, and the entry and record are gone', async (status, error) => {
    seedCompleted({ status, error });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL))).toEqual({ status: 'failed', error });
    expect(docs.get(completedPath(M1))).not.toHaveProperty(CID);
    expect(docs.has(recordPath(CID))).toBe(false);
  });

  it('failed with no error still carries one', async () => {
    seedCompleted({ status: 'error' });
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL)).error).toEqual(expect.any(String));
  });

  it('a delete that fails does not fail the read', async () => {
    seedCompleted({ status: 'completed', result: 'ok' });
    updateError = new Error('unavailable');
    expect(readBody(await readFleetCall(TIER2_TO_M1, CALL))).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: 'ok' }],
    });
  });

  it('writes no audit row: a poll is a read', async () => {
    seedCompleted({ status: 'completed', result: 'ok' });
    readBody(await readFleetCall(TIER2_TO_M1, CALL));
    expect(emitMutation).not.toHaveBeenCalled();
  });
});
