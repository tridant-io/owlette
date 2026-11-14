/** @jest-environment node */

/**
 * the three routes a granted machine's local script calls
 * (`/api/agent/fleet/tools`, `/call`, `/calls/{callId}`), through the real
 * request handler, dispatch, command path and idempotency cache over an
 * in-memory admin-sdk fake. the audit writers, the rate limiter and the plan
 * check are spies.
 */

import crypto from 'crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';

type Data = Record<string, unknown>;

let docs: Map<string, Data>;

function isDelete(value: unknown): boolean {
  return value instanceof FieldValue && value.isEqual(FieldValue.delete());
}

function docRef(path: string) {
  const id = path.slice(path.lastIndexOf('/') + 1);
  return {
    id,
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => {
      const data = docs.get(path);
      return { exists: data !== undefined, id, data: () => data };
    },
    set: async (payload: Data, options?: { merge?: boolean }) => {
      docs.set(path, options?.merge ? { ...docs.get(path), ...payload } : payload);
    },
    update: async (payload: Data) => {
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
      if (op !== '==' && op !== '<=') throw new Error(`fake firestore answers == and <= only, got ${op}`);
      return query(path, [...filters, [field, op, value]], max);
    },
    limit: (count: number) => query(path, filters, count),
    get: async () => {
      const found = children(path).filter((doc) =>
        filters.every(([f, op, v]) => (op === '==' ? doc.data()[f] === v : (doc.data()[f] as number) <= (v as number))),
      );
      const page = max === null ? found : found.slice(0, max);
      return { empty: page.length === 0, size: page.length, docs: page };
    },
  };
}

function collectionRef(path: string) {
  return {
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, op: string, value: unknown) => query(path, []).where(field, op, value),
    get: async () => ({ docs: children(path) }),
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

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => db, getAdminAuth: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const writeAuditEntrySpy = jest.fn();
const writeAuditEntryBlockingSpy = jest.fn();
jest.mock('@/lib/auditLog.server', () => ({
  ...jest.requireActual('@/lib/auditLog.server'),
  writeAuditEntry: (...args: unknown[]) => writeAuditEntrySpy(...args),
  writeAuditEntryBlocking: (...args: unknown[]) => writeAuditEntryBlockingSpy(...args),
}));

const checkRateLimitSpy = jest.fn();
jest.mock('@/lib/rateLimit.server', () => ({
  ...jest.requireActual('@/lib/rateLimit.server'),
  checkRateLimit: (...args: unknown[]) => checkRateLimitSpy(...args),
}));

const requireEntitlementSpy = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: (...args: unknown[]) => requireEntitlementSpy(...args),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: { read: jest.fn() },
}));
jest.mock('@/lib/screenshotStorage.server', () => ({
  issueScreenshotReadUrl: jest.fn(async () => null),
}));

import { GET as listTools } from '@/app/api/agent/fleet/tools/route';
import { POST as startCall } from '@/app/api/agent/fleet/call/route';
import { GET as readCall } from '@/app/api/agent/fleet/calls/[callId]/route';
import { Capability } from '@/lib/capabilities';
import { FLEET_CALLS_COLLECTION } from '@/lib/fleet/calls.server';

const SITE = 'site-a';
const SENDER = 'sender-1';
const OTHER_SENDER = 'sender-2';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';
const machinePath = (id: string) => `sites/${SITE}/machines/${id}`;
const pendingPath = (id: string) => `${machinePath(id)}/commands/pending`;
const completedPath = (id: string) => `${machinePath(id)}/commands/completed`;
const MACHINE_ACTOR_ROW = { type: 'machine', siteId: SITE, machineId: SENDER };

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

function seedSession(machineId = SENDER): string {
  const token = `owf_${crypto.randomBytes(32).toString('base64url')}`;
  docs.set(`fleet_sessions/${hashOf(token)}`, {
    siteId: SITE,
    machineId,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60_000,
  });
  return token;
}

function seedGrant(senders: Data): void {
  docs.set(`sites/${SITE}/settings/fleet`, { enabled: true, senders });
}

function getRequest(path: string, bearer?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
}

function callRequest(bearer: string, body: unknown, key: string | null = crypto.randomUUID()): NextRequest {
  return new NextRequest('http://localhost/api/agent/fleet/call', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** a poll, with the id percent-encoded the way the local script sends it. */
function poll(bearer: string, callId: string) {
  const encoded = encodeURIComponent(callId);
  return readCall(getRequest(`/api/agent/fleet/calls/${encoded}`, bearer), { params: Promise.resolve({ callId: encoded }) });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function expectProblem(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect((await json(res)).code).toBe(code);
}

function pendingEntries(machine: string): Array<[string, Data]> {
  return Object.entries(docs.get(pendingPath(machine)) ?? {}) as Array<[string, Data]>;
}

function callRecords(): Data[] {
  return [...docs.entries()].filter(([p]) => p.startsWith(`${FLEET_CALLS_COLLECTION}/`)).map(([, data]) => data);
}

/** starts restart_process on kiosk-1 as `bearer` and hands back its ids. */
async function startRestart(bearer: string) {
  const res = await startCall(callRequest(bearer, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }));
  expect(res.status).toBe(202);
  const { callId } = (await json(res)) as { callId: string };
  return { callId, commandId: callId.slice(callId.lastIndexOf(':') + 1) };
}

let token: string;

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  writeAuditEntryBlockingSpy.mockResolvedValue(undefined);
  checkRateLimitSpy.mockResolvedValue({ ok: true, limit: 300, remaining: 299, resetAtMs: Date.now() + 60_000, rateLimitReason: 'endpoint-rate' });
  requireEntitlementSpy.mockResolvedValue(null);
  for (const id of [SENDER, OTHER_SENDER, M1, M2]) docs.set(machinePath(id), { online: true });
  seedGrant({
    [SENDER]: { maxTier: 2, machineIds: [M1] },
    [OTHER_SENDER]: { maxTier: 2, machineIds: [M1] },
  });
  token = seedSession();
});

describe('GET /api/agent/fleet/tools', () => {
  it("lists the tools the grant's tier offers, with the site and the machine", async () => {
    const res = await listTools(getRequest('/api/agent/fleet/tools', token));

    expect(res.status).toBe(200);
    const body = (await json(res)) as { tools: Array<{ name: string; description: string; inputSchema: Data }> };
    const names = body.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['list_machines', 'get_system_info', 'restart_process']));
    expect(names).not.toContain('execute_script');
    for (const tool of body.tools) {
      expect(tool).toEqual({ name: expect.any(String), description: expect.any(String), inputSchema: expect.any(Object) });
    }
    expect(body).toMatchObject({ site: { id: SITE }, machine: { id: SENDER } });
  });

  it('offers a tier-1 sender no tool that changes a machine', async () => {
    seedGrant({ [SENDER]: { maxTier: 1, machineIds: [M1] } });

    const body = (await json(await listTools(getRequest('/api/agent/fleet/tools', token)))) as { tools: Array<{ name: string }> };

    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain('get_system_info');
    expect(names).not.toContain('restart_process');
  });

  it('writes no audit row', async () => {
    await listTools(getRequest('/api/agent/fleet/tools', token));

    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('401 without a fleet session', async () => {
    await expectProblem(await listTools(getRequest('/api/agent/fleet/tools')), 401, 'fleet_session_invalid');
  });
});

describe('POST /api/agent/fleet/call', () => {
  it('400 without an Idempotency-Key, and nothing runs', async () => {
    const res = await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M1 } }, null));

    await expectProblem(res, 400, 'idempotency_key_required');
    expect(pendingEntries(M1)).toEqual([]);
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('400 for a body that is not json', async () => {
    const res = await startCall(callRequest(token, '{not json'));

    expect(res.status).toBe(400);
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('answers list_machines itself, with the machines the grant covers, on one allow row', async () => {
    const res = await startCall(callRequest(token, { tool: 'list_machines', params: {} }));

    expect(res.status).toBe(200);
    const body = (await json(res)) as { status: string; content: Array<{ type: string; text: string }> };
    expect(body.status).toBe('completed');
    expect(body.content).toHaveLength(1);
    expect(body.content[0].type).toBe('text');
    expect((JSON.parse(body.content[0].text) as Array<{ id: string }>).map((m) => m.id)).toEqual([M1]);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({
        actor: MACHINE_ACTOR_ROW,
        capability: Capability.MACHINE_VIEW,
        target: { kind: 'site', id: SITE },
        outcome: 'allow',
        metadata: { route: '/api/agent/fleet/call', method: 'POST', tool: 'list_machines', machineId: null },
      }),
    );
    expect(callRecords()).toEqual([]);
  });

  it('answers a process tool itself: 200 with what the tool said, a failure included, on one allow row and no command', async () => {
    // deleting a process changes what the machine launches: tier 3
    seedGrant({ [SENDER]: { maxTier: 3, machineIds: [M1] } });
    // kiosk-1 has no process config here, so the tool fails before it writes
    const res = await startCall(callRequest(token, { tool: 'delete_process', params: { machine: M1, process_name: 'td.exe' } }));

    expect(res.status).toBe(200);
    await expect(json(res)).resolves.toEqual({
      status: 'failed',
      error: `config_not_found: Configuration not found for machine ${M1}.`,
    });
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({
        actor: MACHINE_ACTOR_ROW,
        capability: Capability.MACHINE_EXEC_COMMAND,
        target: { kind: 'machine', id: M1 },
        outcome: 'allow',
        metadata: { route: '/api/agent/fleet/call', method: 'POST', tool: 'delete_process', machineId: M1 },
      }),
    );
    expect(pendingEntries(M1)).toEqual([]);
    expect(callRecords()).toEqual([]);
  });

  it('starts a tier-2 tool on a covered machine: 202, one command, one allow row, the command limit charged once', async () => {
    const res = await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }));

    expect(res.status).toBe(202);
    const body = (await json(res)) as { callId: string; timeoutSeconds: number };
    expect(body.callId).toMatch(new RegExp(`^cmd:${M1}:cmd_`));
    expect(body.timeoutSeconds).toBeGreaterThan(0);

    const pending = pendingEntries(M1);
    expect(pending).toHaveLength(1);
    expect(body.callId.endsWith(`:${pending[0][0]}`)).toBe(true);
    expect(pending[0][1]).toMatchObject({ type: 'restart_process', queuedBy: `machine:${SENDER}` });

    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({
        actor: MACHINE_ACTOR_ROW,
        capability: Capability.MACHINE_EXEC_COMMAND,
        target: { kind: 'machine', id: M1 },
        outcome: 'allow',
        metadata: { route: '/api/agent/fleet/call', method: 'POST', tool: 'restart_process', machineId: M1 },
      }),
    );
    expect(checkRateLimitSpy.mock.calls.map((call) => call[1])).toEqual([
      Capability.MACHINE_VIEW,
      Capability.MACHINE_EXEC_COMMAND,
    ]);
    expect(callRecords()).toEqual([
      expect.objectContaining({ siteId: SITE, callerMachineId: SENDER, machineId: M1, tool: 'restart_process' }),
    ]);
  });

  it('replays the first answer for the same key and body, and queues nothing more', async () => {
    const key = crypto.randomUUID();
    const body = { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } };
    const first = await startCall(callRequest(token, body, key));
    const firstBody = await json(first);

    const replay = await startCall(callRequest(token, body, key));

    expect(replay.status).toBe(202);
    expect(replay.headers.get('Idempotent-Replayed')).toBe('true');
    await expect(json(replay)).resolves.toEqual(firstBody);
    expect(pendingEntries(M1)).toHaveLength(1);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledTimes(1);
  });

  it('422 for the same key with another body', async () => {
    const key = crypto.randomUUID();
    await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }, key));

    const res = await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M1, process_name: 'other.exe' } }, key));

    await expectProblem(res, 422, 'idempotency_key_mismatch');
    expect(pendingEntries(M1)).toHaveLength(1);
  });

  it("keeps one machine's key from replaying another's call", async () => {
    const key = crypto.randomUUID();
    const body = { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } };
    await startCall(callRequest(token, body, key));

    const res = await startCall(callRequest(seedSession(OTHER_SENDER), body, key));

    expect(res.status).toBe(202);
    expect(res.headers.get('Idempotent-Replayed')).toBeNull();
    expect(pendingEntries(M1)).toHaveLength(2);
  });

  describe('a tier-1 sender', () => {
    beforeEach(() => {
      seedGrant({ [SENDER]: { maxTier: 1, machineIds: [M1] } });
    });

    it('runs a tier-1 tool on the view limit alone', async () => {
      const res = await startCall(callRequest(token, { tool: 'get_system_info', params: { machine: M1 } }));

      expect(res.status).toBe(202);
      expect(pendingEntries(M1)[0][1]).toMatchObject({ type: 'mcp_tool_call', tool_name: 'get_system_info' });
      expect(checkRateLimitSpy).toHaveBeenCalledTimes(1);
      expect(checkRateLimitSpy).toHaveBeenCalledWith(expect.anything(), Capability.MACHINE_VIEW, SITE);
      expect(writeAuditEntryBlockingSpy).toHaveBeenCalledWith(
        SITE,
        expect.objectContaining({ capability: Capability.MACHINE_VIEW, target: { kind: 'machine', id: M1 } }),
      );
    });

    it('403 tool_not_allowed for a tool above its tier, on a deny row, with nothing queued', async () => {
      const res = await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }));

      await expectProblem(res, 403, 'tool_not_allowed');
      expect(pendingEntries(M1)).toEqual([]);
      expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
      expect(writeAuditEntrySpy).toHaveBeenCalledTimes(1);
      expect(writeAuditEntrySpy).toHaveBeenCalledWith(
        SITE,
        expect.objectContaining({
          actor: MACHINE_ACTOR_ROW,
          outcome: 'deny',
          denyReason: 'tool_not_allowed',
          metadata: { route: '/api/agent/fleet/call', method: 'POST', tool: 'restart_process', machineId: null },
        }),
      );
    });
  });

  it('403 machine_not_granted for a machine outside the grant, on a deny row naming it', async () => {
    const res = await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M2, process_name: 'td.exe' } }));

    await expectProblem(res, 403, 'machine_not_granted');
    expect(pendingEntries(M2)).toEqual([]);
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
    expect(writeAuditEntrySpy).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({
        outcome: 'deny',
        denyReason: 'machine_not_granted',
        target: { kind: 'machine', id: M2 },
        metadata: expect.objectContaining({ tool: 'restart_process', machineId: M2 }),
      }),
    );
  });

  it('503 when the allow row cannot be written: nothing is queued and no second row is written', async () => {
    writeAuditEntryBlockingSpy.mockRejectedValue(new Error('unavailable'));

    const res = await startCall(callRequest(token, { tool: 'restart_process', params: { machine: M1, process_name: 'td.exe' } }));

    expect(res.status).toBe(503);
    expect(pendingEntries(M1)).toEqual([]);
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
  });

  it('401 without a fleet session', async () => {
    const res = await startCall(
      new NextRequest('http://localhost/api/agent/fleet/call', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ tool: 'list_machines' }),
      }),
    );

    await expectProblem(res, 401, 'fleet_session_invalid');
  });
});

describe('GET /api/agent/fleet/calls/{callId}', () => {
  it('reads a call at each status, and the terminal read is the last', async () => {
    const { callId, commandId } = await startRestart(token);
    jest.clearAllMocks();

    const pending = await poll(token, callId);
    expect(pending.status).toBe(200);
    await expect(json(pending)).resolves.toEqual({ status: 'pending' });

    docs.set(completedPath(M1), { [commandId]: { status: 'running' } });
    await expect(json(await poll(token, callId))).resolves.toEqual({ status: 'in_progress' });

    docs.delete(pendingPath(M1));
    docs.set(completedPath(M1), { [commandId]: { status: 'completed', result: '{"restarted":true}' } });
    await expect(json(await poll(token, callId))).resolves.toEqual({
      status: 'completed',
      content: [{ type: 'text', text: '{\n  "restarted": true\n}' }],
    });
    expect(docs.get(completedPath(M1))).toEqual({});
    expect(callRecords()).toEqual([]);

    expect((await poll(token, callId)).status).toBe(404);
    // polls only read
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('reads a failed call with its error', async () => {
    const { callId, commandId } = await startRestart(token);
    docs.delete(pendingPath(M1));
    docs.set(completedPath(M1), { [commandId]: { status: 'failed', error: 'no such process' } });

    await expect(json(await poll(token, callId))).resolves.toEqual({ status: 'failed', error: 'no such process' });
  });

  it('takes the id decoded too', async () => {
    const { callId } = await startRestart(token);

    const res = await readCall(getRequest('/api/agent/fleet/calls/x', token), { params: Promise.resolve({ callId }) });

    await expect(json(res)).resolves.toEqual({ status: 'pending' });
  });

  it("404 for another machine's call, which stays for its starter to read", async () => {
    const { callId, commandId } = await startRestart(token);
    docs.delete(pendingPath(M1));
    docs.set(completedPath(M1), { [commandId]: { status: 'completed', result: 'restarted td.exe' } });

    const other = await poll(seedSession(OTHER_SENDER), callId);

    expect(other.status).toBe(404);
    expect(docs.get(completedPath(M1))).toHaveProperty(commandId);
    await expect(json(await poll(token, callId))).resolves.toEqual({
      status: 'completed',
      content: [{ type: 'text', text: 'restarted td.exe' }],
    });
  });

  it('404 for a command a person queued, which is left alone', async () => {
    docs.set(completedPath(M1), { cmd_by_a_person: { status: 'completed', result: 'theirs' } });

    const res = await poll(token, `cmd:${M1}:cmd_by_a_person`);

    expect(res.status).toBe(404);
    expect(docs.get(completedPath(M1))).toHaveProperty('cmd_by_a_person');
  });

  it('404 for an id that will not decode', async () => {
    const res = await readCall(getRequest('/api/agent/fleet/calls/x', token), {
      params: Promise.resolve({ callId: 'cmd%3Akiosk-1%3A%E0%A4%A' }),
    });

    expect(res.status).toBe(404);
  });

  it('401 without a fleet session', async () => {
    const res = await readCall(getRequest(`/api/agent/fleet/calls/cmd%3A${M1}%3Acmd_x`), {
      params: Promise.resolve({ callId: `cmd%3A${M1}%3Acmd_x` }),
    });

    await expectProblem(res, 401, 'fleet_session_invalid');
  });
});
