/** @jest-environment node */

/**
 * a 'machines' tool names several machines in one call. dispatch checks each
 * of them as it checks the one a 'machine' tool names, and refuses the call
 * whole when one fails. the tool here is a stand-in registered through a
 * mocked catalog; the checks are dispatch's own.
 */

import type { Firestore } from 'firebase-admin/firestore';

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

const mockMachines = jest.fn();
const mockRun = jest.fn();
jest.mock('@/lib/fleet/catalog.server', () => {
  const actual = jest.requireActual('@/lib/fleet/catalog.server');
  const definition = {
    name: 'act_on_many',
    description: 'a stand-in that acts on several machines',
    tier: 2,
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'the machines to act on' } },
    },
  };
  const tool = {
    target: 'machines',
    definition,
    machines: (...args: unknown[]) => mockMachines(...args),
    run: (...args: unknown[]) => mockRun(...args),
  };
  return {
    ...actual,
    findFleetTool: (name: string, maxTier: number) =>
      name === definition.name ? (maxTier >= definition.tier ? definition : null) : actual.findFleetTool(name, maxTier),
    findFleetServerTool: (name: string) => (name === definition.name ? tool : actual.findFleetServerTool(name)),
  };
});

import { Capability } from '@/lib/capabilities';
import { problemRateLimited } from '@/lib/apiErrors';
import type { AdmitFleetCall, FleetContext } from '@/lib/fleet/context';
import type { FleetGrant } from '@/lib/fleet/policy.server';
import { startFleetCall, type FleetCallStart } from '@/lib/fleet/dispatch.server';

const SITE = 'site-a';
const SENDER = 'sender-1';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';
const M3 = 'kiosk-3';
const TOOL = 'act_on_many';

let docs: Map<string, Record<string, unknown>>;

function docRef(path: string) {
  return {
    collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
    get: async () => {
      const data = docs.get(path);
      return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
    },
  };
}

const db = { collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }) } as unknown as Firestore;

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

const admit = jest.fn<ReturnType<AdmitFleetCall>, Parameters<AdmitFleetCall>>();
const ANSWER = { status: 'completed', content: [{ type: 'text', text: 'done' }] };

function call(grant: FleetGrant, params: Record<string, unknown> = { ids: [M1, M2] }) {
  return startFleetCall(ctxFor(grant), { tool: TOOL, params }, admit);
}

async function refusedWith(promise: Promise<FleetCallStart>, status: number, code: string) {
  const result = await promise;
  if (result.ok) throw new Error(`expected a ${status} refusal, got ${JSON.stringify(result)}`);
  expect(result.response.status).toBe(status);
  expect((await result.response.json()).code).toBe(code);
  expect(mockRun).not.toHaveBeenCalled();
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  for (const id of [M1, M2]) docs.set(`sites/${SITE}/machines/${id}`, { online: true });
  admit.mockResolvedValue(null);
  mockMachines.mockImplementation(async (_ctx: FleetContext, params: { ids?: string[] }) => ({ machines: params.ids ?? [] }));
  mockRun.mockResolvedValue(ANSWER);
});

describe('startFleetCall: a tool that names several machines', () => {
  it('runs once every machine is inside the grant, in the site and has hoot on, with an allow row each', async () => {
    const res = await call({ maxTier: 2, machineIds: [M1, M2] }, { ids: [M1, M2, M1], not_declared: 'x' });

    expect(res).toEqual({ ok: true, kind: 'answered', body: ANSWER });
    expect(admit.mock.calls.map(([admission]) => admission)).toEqual([
      { capability: Capability.MACHINE_EXEC_COMMAND, tool: TOOL, machineId: M1 },
      { capability: Capability.MACHINE_EXEC_COMMAND, tool: TOOL, machineId: M2 },
    ]);
    // each machine once, and only the parameters the tool declares
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ machineId: SENDER }), [M1, M2], { ids: [M1, M2, M1] });
    expect(mockMachines).toHaveBeenCalledWith(expect.anything(), { ids: [M1, M2, M1] });
  });

  it('is refused whole when one machine is outside the grant, before any allow row', async () => {
    const res = await refusedWith(call({ maxTier: 2, machineIds: [M1] }), 403, 'machine_not_granted');

    expect(res.deny).toEqual({ reason: 'machine_not_granted', tool: TOOL, machineId: M2 });
    expect(admit).not.toHaveBeenCalled();
  });

  it('is refused whole when one machine has hoot off', async () => {
    docs.set(`sites/${SITE}/machines/${M2}`, { online: true, cortexEnabled: false });

    const res = await refusedWith(call({ maxTier: 2, machineIds: null }), 409, 'hoot_disabled');

    expect(res.deny).toEqual({ reason: 'hoot_disabled', tool: TOOL, machineId: M2 });
    expect(admit).not.toHaveBeenCalled();
  });

  it('is refused whole when one machine is not in the site', async () => {
    const res = await call({ maxTier: 2, machineIds: null }, { ids: [M1, M3] });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(404);
      expect(res.deny).toEqual({ reason: 'not_found', tool: TOOL, machineId: M3 });
    }
    expect(admit).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it.each([
    ['names none', { machines: [] }],
    ['cannot tell its machines', { error: 'no deployment by that id' }],
    ['names more than fifty', { machines: Array.from({ length: 51 }, (_, i) => `kiosk-${i + 10}`) }],
    ['names something that is no machine id', { machines: ['a:b'] }],
  ])('is refused as invalid when the call %s', async (_case, named) => {
    mockMachines.mockResolvedValue(named);

    const res = await refusedWith(call({ maxTier: 2, machineIds: null }), 400, 'validation_failed');

    expect(res.deny).toMatchObject({ reason: 'validation_failed', tool: TOOL });
    expect(admit).not.toHaveBeenCalled();
  });

  it('stops when the rate limit refuses one of its machines', async () => {
    admit.mockResolvedValueOnce(null).mockResolvedValueOnce(problemRateLimited(5));

    const res = await call({ maxTier: 2, machineIds: [M1, M2] });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(429);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('is not offered below its tier', async () => {
    await refusedWith(call({ maxTier: 1, machineIds: null }), 403, 'tool_not_allowed');
  });
});
