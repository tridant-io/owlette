/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn(), getAdminAuth: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));
jest.mock('@/lib/actions/deployRoost.server', () => ({
  ...jest.requireActual('@/lib/actions/deployRoost.server'),
  deployRoost: jest.fn(),
}));
jest.mock('@/lib/actions/rollbackRoost.server', () => ({
  ...jest.requireActual('@/lib/actions/rollbackRoost.server'),
  rollbackRoost: jest.fn(),
}));
jest.mock('@/lib/resolveVersion', () => ({
  ...jest.requireActual('@/lib/resolveVersion'),
  resolveVersion: jest.fn(),
}));
const mockRequireEntitlement = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: (...args: unknown[]) => mockRequireEntitlement(...args),
}));

import { deployRoost, RoostProblem } from '@/lib/actions/deployRoost.server';
import { rollbackRoost } from '@/lib/actions/rollbackRoost.server';
import { resolveVersion, VersionNotFoundError } from '@/lib/resolveVersion';
import type { FleetContext, FleetServerTool } from '@/lib/fleet/context';
import type { FleetGrant } from '@/lib/fleet/policy.server';
import { allTools } from '@/lib/mcp-tools';
import { roostTools } from '@/lib/fleet/tools/roost.server';

const SITE = 'site-a';
const SENDER = 'sender-1';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';
const M3 = 'kiosk-3';
const R1 = 'rst_000000000001';
const R2 = 'rst_000000000002';
const R3 = 'rst_000000000003';
const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

const mockDeploy = deployRoost as jest.Mock;
const mockRollback = rollbackRoost as jest.Mock;
const mockResolve = resolveVersion as jest.Mock;

let docs: Map<string, Record<string, unknown>>;

function docRef(path: string) {
  return {
    get: async () => {
      const data = docs.get(path);
      return { exists: data !== undefined, id: path.split('/').pop(), data: () => data };
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path: string) {
  const depth = path.split('/').length + 1;
  const rows = () =>
    [...docs.entries()]
      .filter(([key]) => key.startsWith(`${path}/`) && key.split('/').length === depth)
      .sort(([, a], [, b]) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
      .map(([key, data]) => ({ id: key.split('/').pop() as string, data: () => data }));
  const query = (max: number) => ({
    orderBy: () => query(max),
    limit: (n: number) => query(n),
    get: async () => ({ docs: rows().slice(0, max) }),
  });
  return { doc: (id: string) => docRef(`${path}/${id}`), ...query(Infinity) };
}

const db = { collection: (name: string) => collectionRef(name) } as unknown as Firestore;

function makeCtx(grant: FleetGrant): FleetContext {
  return {
    actor: { type: 'machine', siteId: SITE, machineId: SENDER, maxTier: 3, machineIds: grant.machineIds },
    siteId: SITE,
    machineId: SENDER,
    grant,
    correlationId: 'corr-1',
    db,
  };
}

const whole = makeCtx({ maxTier: 3, machineIds: null });
const oneMachine = makeCtx({ maxTier: 3, machineIds: [M1] });
const emptyGrant = makeCtx({ maxTier: 3, machineIds: [] });

const roostPath = (id: string) => `sites/${SITE}/roosts/${id}`;

function seed(id: string, data: Record<string, unknown>) {
  docs.set(roostPath(id), { name: id, createdAt: 1, ...data });
}

function site<K extends 'site' | 'machines'>(target: K): Extract<FleetServerTool, { target: K }>[] {
  return roostTools.filter((t) => t.target === target) as Extract<FleetServerTool, { target: K }>[];
}

function named(name: string): FleetServerTool {
  const found = roostTools.find((t) => t.definition.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function readTool(name: string): Extract<FleetServerTool, { target: 'site' }> {
  const found = named(name);
  if (found.target !== 'site') throw new Error('not a site tool');
  return found;
}

function writeTool(name: string): Extract<FleetServerTool, { target: 'machines' }> {
  const found = named(name);
  if (found.target !== 'machines') throw new Error('not a machines tool');
  return found;
}

const textOf = (answer: Awaited<ReturnType<FleetServerTool['run']>>) => {
  if (answer.status !== 'completed') throw new Error(`failed: ${answer.error}`);
  return JSON.parse(answer.content[0].text);
};

beforeEach(() => {
  docs = new Map();
  mockDeploy.mockReset();
  mockRollback.mockReset();
  mockResolve.mockReset();
  mockRequireEntitlement.mockReset();
  mockRequireEntitlement.mockResolvedValue(null);
  seed(R1, { targets: [M1], createdAt: 3, currentVersionId: V1, currentVersionNumber: 2 });
  seed(R2, { targets: [M1, M2], createdAt: 2 });
  seed(R3, { targets: [M3], createdAt: 1, deletedAt: 5 });
});

describe('roost tools', () => {
  it('has unique names that no catalogue tool already has, and the right shapes', () => {
    const names = roostTools.map((t) => t.definition.name);
    expect(new Set(names).size).toBe(4);
    for (const name of names) expect(allTools.some((t) => t.name === name)).toBe(false);
    expect(site('site').map((t) => t.definition.tier)).toEqual([1, 1]);
    expect(site('machines').map((t) => t.definition.tier)).toEqual([3, 3]);
  });
});

describe('list_roosts', () => {
  const tool = () => readTool('list_roosts');

  it('a whole-site grant sees every live roost, newest first', async () => {
    const result = textOf(await tool().run(whole, {}));
    expect(result.roosts.map((r: { roostId: string }) => r.roostId)).toEqual([R1, R2]);
    expect(result).toMatchObject({ count: 2, leftOut: 0, more: false });
  });

  it('a grant naming one machine sees only roosts wholly inside it and counts the rest', async () => {
    const result = textOf(await tool().run(oneMachine, {}));
    expect(result.roosts.map((r: { roostId: string }) => r.roostId)).toEqual([R1]);
    expect(result.leftOut).toBe(1);
  });

  it('an empty grant reads nothing', async () => {
    const spy = jest.spyOn(db, 'collection');
    const result = textOf(await tool().run(emptyGrant, {}));
    expect(result).toEqual({ roosts: [], count: 0, leftOut: 0, more: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('caps the page at limit and says there are more', async () => {
    const result = textOf(await tool().run(whole, { limit: 1 }));
    expect(result.count).toBe(1);
    expect(result.more).toBe(true);
  });

  it('answers an empty site', async () => {
    docs.clear();
    expect(textOf(await tool().run(whole, {}))).toEqual({ roosts: [], count: 0, leftOut: 0, more: false });
  });
});

describe('list_roost_versions', () => {
  const tool = () => readTool('list_roost_versions');

  beforeEach(() => {
    docs.set(`${roostPath(R1)}/versions/${V1}`, { versionNumber: 1, createdAt: 1, totalFiles: 3, totalSize: 10 });
    docs.set(`${roostPath(R1)}/versions/${V2}`, { versionNumber: 2, createdAt: 2, description: 'second' });
    docs.set(`${roostPath(R2)}/versions/${V1}`, { versionNumber: 1, createdAt: 1 });
  });

  it('a whole-site grant lists the versions newest first', async () => {
    const result = textOf(await tool().run(whole, { roost_id: R2 }));
    expect(result.versions).toHaveLength(1);
    const first = textOf(await tool().run(whole, { roost_id: R1 }));
    expect(first.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(first.more).toBe(false);
  });

  it('a grant naming one machine reads a roost inside it and not one partly outside', async () => {
    expect(textOf(await tool().run(oneMachine, { roost_id: R1 })).count).toBe(2);
    expect(await tool().run(oneMachine, { roost_id: R2 })).toEqual({ status: 'failed', error: `roost ${R2} not found` });
  });

  it('an empty grant reads nothing', async () => {
    expect(await tool().run(emptyGrant, { roost_id: R1 })).toEqual({ status: 'failed', error: `roost ${R1} not found` });
  });

  it('bounds the page and says there are more', async () => {
    const result = textOf(await tool().run(whole, { roost_id: R1, limit: 1 }));
    expect(result.count).toBe(1);
    expect(result.more).toBe(true);
  });

  it('refuses a malformed or deleted roost', async () => {
    expect((await tool().run(whole, { roost_id: '../x' })).status).toBe('failed');
    expect((await tool().run(whole, { roost_id: R3 })).status).toBe('failed');
  });
});

describe('deploy_roost_version', () => {
  const tool = () => writeTool('deploy_roost_version');

  beforeEach(() => {
    docs.set(`${roostPath(R1)}/versions/${V2}`, { versionUrl: 'https://r2/v2' });
    seed(R1, { targets: [M1, M2], createdAt: 3, currentVersionId: V1, versionUrl: 'https://r2/v1' });
  });

  it('machines() returns the named machines when the call names them', async () => {
    expect(await tool().machines(whole, { roost_id: R1, machines: [M3, M3] })).toEqual({ machines: [M3] });
  });

  it("machines() returns the roost's own when the call names none, for the current or a named version", async () => {
    expect(await tool().machines(whole, { roost_id: R1 })).toEqual({ machines: [M1, M2] });
    expect(await tool().machines(whole, { roost_id: R1, version_id: V2 })).toEqual({ machines: [M1, M2] });
  });

  it('machines() errors for an unknown roost or version, a deleted roost or no machines', async () => {
    expect(await tool().machines(whole, { roost_id: 'rst_missing0001' })).toEqual({
      error: 'roost rst_missing0001 not found on site site-a',
    });
    expect(await tool().machines(whole, { roost_id: R1, version_id: 'c'.repeat(64) })).toEqual({
      error: expect.stringContaining('is not in this roost'),
    });
    expect(await tool().machines(whole, { roost_id: R3 })).toEqual({ error: expect.stringContaining('soft-deleted') });
    seed(R2, { targets: [], currentVersionId: V1, versionUrl: 'https://r2/v1' });
    expect(await tool().machines(whole, { roost_id: R2 })).toEqual({ error: expect.stringContaining('no machines') });
  });

  it('machines() errors for malformed parameters', async () => {
    expect(await tool().machines(whole, { roost_id: 'x' })).toHaveProperty('error');
    expect(await tool().machines(whole, { roost_id: R1, machines: [] })).toHaveProperty('error');
    expect(await tool().machines(whole, { roost_id: R1, version_id: 5 })).toHaveProperty('error');
  });

  it('run() reaches the core as the machine, with exactly the approved machines', async () => {
    mockDeploy.mockResolvedValue({ outcome: 'queued', status: 202, body: { stage: 'canary', canary: [M1] } });
    const answer = await tool().run(whole, [M1, M2], { roost_id: R1, version_id: V2 });
    expect(textOf(answer)).toEqual({ stage: 'canary', canary: [M1], fleet: [] });
    expect(mockDeploy).toHaveBeenCalledWith(
      { siteId: SITE, auditActor: `machine:${SENDER}` },
      expect.objectContaining({
        roostId: R1,
        versionId: V2,
        requestedBy: `machine:${SENDER}`,
        approvedMachines: [M1, M2],
      }),
    );
  });

  it("run() passes a named list on and does not widen it", async () => {
    mockDeploy.mockResolvedValue({ outcome: 'queued', status: 202, body: {} });
    await tool().run(whole, [M2], { roost_id: R1, machines: [M2] });
    expect(mockDeploy.mock.calls[0][1]).toMatchObject({ machines: [M2], approvedMachines: [M2] });
  });

  it("run() turns the core's refusal into a failed answer", async () => {
    mockDeploy.mockRejectedValue(
      new RoostProblem({ type: 't', title: 'machines changed', status: 409, detail: 'the machines changed' }),
    );
    expect(await tool().run(whole, [M1], { roost_id: R1 })).toEqual({ status: 'failed', error: 'the machines changed' });
  });

  it('run() rethrows what it does not expect', async () => {
    mockDeploy.mockRejectedValue(new Error('boom'));
    await expect(tool().run(whole, [M1], { roost_id: R1 })).rejects.toThrow('boom');
  });

  it('run() does not reach the core while the roost kill switch is on', async () => {
    docs.set(`sites/${SITE}`, { roostEnabled: false });
    const answer = await tool().run(whole, [M1], { roost_id: R1 });
    expect(answer.status).toBe('failed');
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it('run() does not reach the core on a site whose plan has no roost, as the route refuses it', async () => {
    mockRequireEntitlement.mockResolvedValue({ status: 402 });
    expect(await tool().run(whole, [M1], { roost_id: R1 })).toEqual({
      status: 'failed',
      error: "your plan doesn't include roost. upgrade to continue.",
    });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.roost');
    expect(mockDeploy).not.toHaveBeenCalled();
  });

  it('machines() answers a roost with a machine outside the grant as an unknown roost, even narrowed to one inside', async () => {
    const unknown = await tool().machines(oneMachine, { roost_id: 'rst_missing0001' });
    expect(await tool().machines(oneMachine, { roost_id: R1 })).toEqual({ error: `roost ${R1} not found on site site-a` });
    expect(await tool().machines(oneMachine, { roost_id: R1, machines: [M1] })).toEqual({
      error: `roost ${R1} not found on site site-a`,
    });
    expect(unknown).toEqual({ error: 'roost rst_missing0001 not found on site site-a' });
  });

  it('machines() lets a grant that names its machines deploy a roost wholly inside it', async () => {
    seed(R1, { targets: [M1], createdAt: 3, currentVersionId: V1, versionUrl: 'https://r2/v1' });
    expect(await tool().machines(oneMachine, { roost_id: R1 })).toEqual({ machines: [M1] });
  });

  it('run() answers a rollout already running without its manifest url or machines the call was not checked for', async () => {
    mockDeploy.mockResolvedValue({
      outcome: 'already_running',
      status: 200,
      body: { stage: 'canary', canary: [M3], fleet: [M1, M2], versionUrl: 'https://r2/v1', alreadyRunning: true },
    });
    const answer = await tool().run(whole, [M1], { roost_id: R1 });
    expect(textOf(answer)).toEqual({ stage: 'canary', canary: [], fleet: [M1], alreadyRunning: true });
  });
});

describe('rollback_roost', () => {
  const tool = () => writeTool('rollback_roost');

  beforeEach(() => {
    seed(R1, { targets: [M1, M2, M1, ''], createdAt: 3, currentVersionId: V2 });
    mockResolve.mockResolvedValue({ versionId: V1, versionNumber: 1, doc: { data: () => ({}) } });
  });

  it("machines() returns every target of the roost, once, whatever the call says", async () => {
    expect(await tool().machines(whole, { roost_id: R1 })).toEqual({ machines: [M1, M2] });
    expect(mockResolve).toHaveBeenCalledWith({ roostId: R1, siteId: SITE, ref: 'previous' });
    await tool().machines(whole, { roost_id: R1, target_version: '3' });
    expect(mockResolve).toHaveBeenLastCalledWith({ roostId: R1, siteId: SITE, ref: '3' });
  });

  it('machines() errors for an unknown roost, a deleted one or an unknown version', async () => {
    expect(await tool().machines(whole, { roost_id: 'rst_missing0001' })).toEqual({
      error: 'roost rst_missing0001 not found on site site-a',
    });
    expect(await tool().machines(whole, { roost_id: R3 })).toHaveProperty('error');
    mockResolve.mockRejectedValue(new VersionNotFoundError('version 9 not found'));
    expect(await tool().machines(whole, { roost_id: R1, target_version: '9' })).toEqual({ error: 'version 9 not found' });
  });

  it('machines() errors for a roost with no machines and for malformed parameters', async () => {
    seed(R2, { targets: [] });
    expect(await tool().machines(whole, { roost_id: R2 })).toHaveProperty('error');
    expect(await tool().machines(whole, { roost_id: 'x' })).toHaveProperty('error');
    expect(await tool().machines(whole, { roost_id: R1, target_version: { a: 1 } })).toHaveProperty('error');
  });

  it('run() reaches the core as the machine, with exactly the approved machines', async () => {
    mockRollback.mockResolvedValue({ ok: true, roostId: R1, currentVersionId: V1 });
    const answer = await tool().run(whole, [M1, M2], { roost_id: R1, target_version: '1' });
    expect(textOf(answer)).toMatchObject({ ok: true, currentVersionId: V1 });
    expect(mockRollback).toHaveBeenCalledWith(
      { siteId: SITE, auditActor: `machine:${SENDER}` },
      expect.objectContaining({
        roostId: R1,
        targetVersion: '1',
        requestedBy: `machine:${SENDER}`,
        approvedMachines: [M1, M2],
      }),
    );
  });

  it("run() turns the core's refusal into a failed answer", async () => {
    mockRollback.mockRejectedValue(
      new RoostProblem({ type: 't', title: 'rollback no-op', status: 400, detail: 'targetVersion is already the current version' }),
    );
    expect(await tool().run(whole, [M1], { roost_id: R1 })).toEqual({
      status: 'failed',
      error: 'targetVersion is already the current version',
    });
  });

  it('run() does not reach the core while the roost kill switch is on', async () => {
    docs.set(`sites/${SITE}`, { roostEnabled: false });
    expect((await tool().run(whole, [M1], { roost_id: R1 })).status).toBe('failed');
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('run() does not reach the core on a site whose plan has no roost', async () => {
    mockRequireEntitlement.mockResolvedValue({ status: 402 });
    expect(await tool().run(whole, [M1], { roost_id: R1 })).toEqual({
      status: 'failed',
      error: "your plan doesn't include roost. upgrade to continue.",
    });
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('machines() answers a roost with a machine outside the grant as an unknown roost', async () => {
    expect(await tool().machines(oneMachine, { roost_id: R1 })).toEqual({ error: `roost ${R1} not found on site site-a` });
  });
});
