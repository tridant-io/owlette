/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn(), getAdminAuth: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/actions/createDeployment.server', () => ({ createDeployment: jest.fn() }));
jest.mock('@/lib/actions/cancelDeployment.server', () => ({ cancelDeployment: jest.fn() }));
jest.mock('@/lib/actions/executeMachineCommand.server', () => ({
  ...jest.requireActual('@/lib/actions/executeMachineCommand.server'),
  executeMachineCommand: jest.fn(),
}));
jest.mock('@/lib/hoot-utils.server', () => ({ executeServerSideTool: jest.fn() }));
jest.mock('@/lib/latestInstaller.server', () => ({ loadLatestInstaller: jest.fn() }));
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: jest.fn(),
}));

import { createDeployment } from '@/lib/actions/createDeployment.server';
import { cancelDeployment } from '@/lib/actions/cancelDeployment.server';
import { executeMachineCommand, ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';
import { executeServerSideTool } from '@/lib/hoot-utils.server';
import { loadLatestInstaller } from '@/lib/latestInstaller.server';
import { requireEntitlement } from '@/lib/plan.server';
import type { FleetContext, FleetServerTool } from '@/lib/fleet/context';
import type { FleetGrant } from '@/lib/fleet/policy.server';
import { allTools } from '@/lib/mcp-tools';
import { deploymentTools } from '@/lib/fleet/tools/deployments.server';

type Data = Record<string, unknown>;

const SITE = 'site-a';
const SENDER = 'sender-1';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';

const mockCreate = createDeployment as jest.Mock;
const mockCancel = cancelDeployment as jest.Mock;
const mockCommand = executeMachineCommand as jest.Mock;
const mockServerTool = executeServerSideTool as jest.Mock;
const mockLatest = loadLatestInstaller as jest.Mock;
const mockPlan = requireEntitlement as jest.Mock;

let docs: Map<string, Data>;
let queryLimits: number[];
let reads: string[];

// deployments are keyed `sites/<site>/deployments/<id>`, newest first by their `order`
function deploymentRef(id: string) {
  const path = `sites/${SITE}/deployments/${id}`;
  return {
    get: async () => {
      reads.push(path);
      const data = docs.get(path);
      return { exists: data !== undefined, id, data: () => data };
    },
  };
}

const db = {
  collection: (a: string) => ({
    doc: (siteId: string) => ({
      collection: (b: string) => ({
        doc: (id: string) => {
          if (b === 'deployments') return deploymentRef(id);
          return {
            get: async () => {
              const data = docs.get(`${a}/${siteId}/${b}/${id}`);
              return { exists: data !== undefined, data: () => data };
            },
          };
        },
        orderBy: () => ({
          limit: (n: number) => ({
            get: async () => {
              queryLimits.push(n);
              reads.push(`${a}/${siteId}/${b}`);
              const prefix = `${a}/${siteId}/${b}/`;
              const rows = [...docs.entries()]
                .filter(([path]) => path.startsWith(prefix))
                .sort(([, x], [, y]) => (y.order as number) - (x.order as number))
                .slice(0, n)
                .map(([path, data]) => ({ id: path.slice(prefix.length), data: () => data }));
              return { docs: rows };
            },
          }),
        }),
      }),
    }),
  }),
} as unknown as Firestore;

function ctxFor(machineIds: string[] | null): FleetContext {
  const grant: FleetGrant = { maxTier: 3, machineIds };
  return {
    actor: { type: 'machine', siteId: SITE, machineId: SENDER, maxTier: 3, machineIds },
    siteId: SITE,
    machineId: SENDER,
    grant,
    correlationId: 'corr-1',
    db,
  };
}

const wholeSite = ctxFor(null);
const oneMachine = ctxFor([M1]);
const nobody = ctxFor([]);

function deployment(id: string, order: number, machineIds: string[], extra: Data = {}) {
  docs.set(`sites/${SITE}/deployments/${id}`, {
    name: `deploy ${id}`,
    installer_name: 'app.exe',
    installer_url: 'https://example.com/app.exe',
    silent_flags: '/S',
    status: 'in_progress',
    order,
    targets: machineIds.map((machineId) => ({ machineId, status: 'pending' })),
    ...extra,
  });
}

function find<T extends FleetServerTool['target']>(name: string, target: T): Extract<FleetServerTool, { target: T }> {
  const found = deploymentTools.find((t) => t.definition.name === name);
  if (!found || found.target !== target) throw new Error(`no ${target} tool ${name}`);
  return found as Extract<FleetServerTool, { target: T }>;
}

const bodyOf = (answer: Awaited<ReturnType<FleetServerTool['run']>>) => {
  if (answer.status !== 'completed') throw new Error(`expected completed, got ${answer.error}`);
  return JSON.parse(answer.content[0].text);
};

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  queryLimits = [];
  reads = [];
  mockPlan.mockResolvedValue(null);
});

describe('definitions', () => {
  it('have the right targets and tiers, and names hoot does not already have', () => {
    expect(deploymentTools.map((t) => [t.definition.name, t.target, t.definition.tier])).toEqual([
      ['list_deployments', 'site', 1],
      ['get_deployment', 'site', 1],
      ['list_software_presets', 'site', 1],
      ['create_deployment', 'machines', 3],
      ['cancel_deployment', 'machines', 2],
      ['update_owlette_agent', 'machine', 3],
    ]);
    for (const t of deploymentTools) {
      expect(allTools.some((a) => a.name === t.definition.name)).toBe(false);
      expect(t.definition.parameters.properties).not.toHaveProperty('machine');
    }
  });

  it('say what the active-hours guard does in each tier 3 description', () => {
    for (const name of ['create_deployment', 'update_owlette_agent']) {
      const tool = deploymentTools.find((t) => t.definition.name === name);
      expect(tool?.definition.description).toMatch(/active-hours guard/);
    }
  });
});

describe('list_deployments', () => {
  const list = find('list_deployments', 'site');

  beforeEach(() => {
    deployment('d1', 1, [M1]);
    deployment('d2', 2, [M1, M2]);
    deployment('d3', 3, [M2]);
  });

  it('shows a whole-site grant every deployment, newest first, without the installer url', async () => {
    const body = bodyOf(await list.run(wholeSite, {}));
    expect(body.deployments.map((d: Data) => d.id)).toEqual(['d3', 'd2', 'd1']);
    expect(body).toMatchObject({ count: 3, leftOut: 0, more: false });
    expect(body.deployments[1]).toMatchObject({ installerName: 'app.exe', targets: [{ machineId: M1, status: 'pending' }, { machineId: M2, status: 'pending' }] });
    expect(JSON.stringify(body)).not.toContain('example.com');
  });

  it('shows a grant naming one machine only the deployments wholly inside it, and counts the rest', async () => {
    const body = bodyOf(await list.run(oneMachine, {}));
    expect(body.deployments.map((d: Data) => d.id)).toEqual(['d1']);
    expect(body).toMatchObject({ count: 1, leftOut: 2 });
  });

  it('reads nothing for an empty grant', async () => {
    const body = bodyOf(await list.run(nobody, {}));
    expect(body).toEqual({ deployments: [], count: 0, leftOut: 0, more: false });
    expect(reads).toEqual([]);
  });

  it('hides a deployment that names no machines from a narrowed grant', async () => {
    deployment('d0', 0, []);
    const body = bodyOf(await list.run(ctxFor([M1, M2]), {}));
    expect(body.deployments.map((d: Data) => d.id)).not.toContain('d0');
  });

  it('caps the page at limit, bounds a bad limit, and says there are more', async () => {
    const one = bodyOf(await list.run(wholeSite, { limit: 1 }));
    expect(one.deployments.map((d: Data) => d.id)).toEqual(['d3']);
    expect(one.more).toBe(true);
    for (const bad of [0, -3, Number.NaN, 'x']) {
      expect(bodyOf(await list.run(wholeSite, { limit: bad })).count).toBe(3);
    }
    expect(bodyOf(await list.run(wholeSite, { limit: 5000 })).count).toBe(3);
    expect(queryLimits.every((n) => n <= 200)).toBe(true);
  });

  it('returns an empty list for a site with no deployments', async () => {
    docs.clear();
    expect(bodyOf(await list.run(wholeSite, {}))).toEqual({ deployments: [], count: 0, leftOut: 0, more: false });
  });
});

describe('get_deployment', () => {
  const get = find('get_deployment', 'site');

  beforeEach(() => {
    deployment('d1', 1, [M1]);
    deployment('d2', 2, [M1, M2]);
  });

  it('returns a deployment inside the grant', async () => {
    expect(bodyOf(await get.run(oneMachine, { deployment_id: 'd1' }))).toMatchObject({ id: 'd1', status: 'in_progress' });
    expect(bodyOf(await get.run(wholeSite, { deployment_id: 'd2' })).id).toBe('d2');
  });

  it('answers a deployment partly outside the grant as not found', async () => {
    expect(await get.run(oneMachine, { deployment_id: 'd2' })).toEqual({ status: 'failed', error: 'deployment d2 not found' });
  });

  it('answers an unknown deployment as not found', async () => {
    expect(await get.run(wholeSite, { deployment_id: 'nope' })).toEqual({ status: 'failed', error: 'deployment nope not found' });
  });

  it('reads nothing for an empty grant', async () => {
    expect(await get.run(nobody, { deployment_id: 'd1' })).toEqual({ status: 'failed', error: 'deployment d1 not found' });
    expect(reads).toEqual([]);
  });

  it('refuses an id that is not a deployment id before reading', async () => {
    for (const bad of [undefined, '', 'a/b', 5]) {
      expect((await get.run(wholeSite, { deployment_id: bad })).status).toBe('failed');
    }
    expect(reads).toEqual([]);
  });
});

describe('list_software_presets', () => {
  const presets = find('list_software_presets', 'site');

  it('returns what hoot\'s reader returns, with the filters, for any grant', async () => {
    mockServerTool.mockResolvedValue({ presets: [{ id: 'p1' }], count: 1 });
    for (const ctx of [wholeSite, oneMachine, nobody]) {
      const body = bodyOf(await presets.run(ctx, { software_name: 'touch', category: 5 }));
      expect(body).toEqual({ presets: [{ id: 'p1' }], count: 1, truncated: false });
    }
    expect(mockServerTool).toHaveBeenCalledWith(db, SITE, [], 'get_system_presets', { software_name: 'touch' }, { machineActor: nobody.actor });
  });

  it('caps the list and says it was cut', async () => {
    mockServerTool.mockResolvedValue({ presets: Array.from({ length: 150 }, (_, i) => ({ id: `p${i}` })), count: 150 });
    const body = bodyOf(await presets.run(wholeSite, {}));
    expect(body.presets).toHaveLength(100);
    expect(body).toMatchObject({ count: 100, truncated: true });
  });

  it('returns an empty list when nothing matches', async () => {
    mockServerTool.mockResolvedValue({ presets: [], count: 0 });
    expect(bodyOf(await presets.run(wholeSite, {}))).toEqual({ presets: [], count: 0, truncated: false });
  });
});

describe('create_deployment', () => {
  const create = find('create_deployment', 'machines');
  const params = {
    name: 'td',
    installer_name: 'td.exe',
    installer_url: 'https://example.com/td.exe',
    silent_flags: '/S',
    machines: [M1, M2],
  };

  it('names the machines the call lists', async () => {
    expect(await create.machines(oneMachine, params)).toEqual({ machines: [M1, M2] });
  });

  it('cannot tell the machines when the list is missing, empty or malformed', async () => {
    for (const machines of [undefined, [], 'kiosk-1', [M1, 5], ['']]) {
      expect(await create.machines(wholeSite, { ...params, machines })).toEqual({ error: 'machines must list at least one machine id' });
    }
  });

  it('reaches the core with the machine as the actor and only the machines it was given', async () => {
    mockCreate.mockResolvedValue({ ok: true, deploymentId: 'deploy-1', siteId: SITE, status: 'in_progress', targets: [{ machineId: M1, status: 'pending' }] });
    const body = bodyOf(await create.run(wholeSite, [M1], { ...params, verify_path: 'C:\\td', parallel_install: true }));
    expect(body).toEqual({ deploymentId: 'deploy-1', status: 'in_progress', machines: [M1] });
    const [input, ctx] = mockCreate.mock.calls[0];
    expect(input).toMatchObject({ name: 'td', installer_url: params.installer_url, verify_path: 'C:\\td', parallel_install: true, machines: [M1] });
    expect(input).not.toHaveProperty('active_hours_override');
    expect(ctx).toEqual({ siteId: SITE, createdBy: `machine:${SENDER}`, actorIdentifier: `machine:${SENDER}`, correlationId: 'corr-1' });
  });

  it('turns a core input error into a failed answer', async () => {
    mockCreate.mockResolvedValue({ ok: false, code: 'installer_url_not_https', message: 'installer_url must use HTTPS protocol' });
    expect(await create.run(wholeSite, [M1], params)).toEqual({ status: 'failed', error: 'installer_url must use HTTPS protocol' });
  });

  it('is refused without the deployments plan and writes nothing', async () => {
    mockPlan.mockResolvedValue({ status: 402 });
    const answer = await create.run(wholeSite, [M1], params);
    expect(answer.status).toBe('failed');
    expect(mockPlan).toHaveBeenCalledWith(SITE, 'owlette.deployments');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rethrows what it does not expect', async () => {
    mockCreate.mockRejectedValue(new Error('firestore down'));
    await expect(create.run(wholeSite, [M1], params)).rejects.toThrow('firestore down');
  });
});

describe('cancel_deployment', () => {
  const cancel = find('cancel_deployment', 'machines');

  it('names every machine whose install has not started, once', async () => {
    deployment('d1', 1, [M1, M2, M1]);
    expect(await cancel.machines(wholeSite, { deployment_id: 'd1' })).toEqual({ machines: [M1, M2] });
  });

  it('leaves out a machine that is installing or finished, which a cancel does not act on', async () => {
    deployment('d2', 1, [], {
      targets: [
        { machineId: M1, status: 'downloading' },
        { machineId: M2, status: 'installing' },
        { machineId: 'kiosk-gone', status: 'completed' },
      ],
    });
    expect(await cancel.machines(wholeSite, { deployment_id: 'd2' })).toEqual({ machines: [M1] });
  });

  it('cannot tell the machines of a deployment with no install left to cancel', async () => {
    deployment('d3', 1, [], { targets: [{ machineId: M1, status: 'completed' }, { machineId: M2, status: 'failed' }] });
    expect(await cancel.machines(wholeSite, { deployment_id: 'd3' })).toEqual({
      error: 'deployment d3 has no install left to cancel',
    });
  });

  it('cannot tell the machines of an unknown deployment', async () => {
    expect(await cancel.machines(wholeSite, { deployment_id: 'nope' })).toEqual({ error: 'deployment nope not found' });
  });

  it('answers a deployment that names a machine outside the grant as an unknown one', async () => {
    deployment('d4', 1, [M1, 'kiosk-9']);
    expect(await cancel.machines(oneMachine, { deployment_id: 'd4' })).toEqual({ error: 'deployment d4 not found' });
  });

  it('cannot tell the machines of a deployment that targets none, or of a bad id', async () => {
    deployment('d0', 0, []);
    expect(await cancel.machines(wholeSite, { deployment_id: 'd0' })).toEqual({ error: 'deployment d0 has no install left to cancel' });
    expect(await cancel.machines(wholeSite, { deployment_id: 'a/b' })).toEqual({ error: 'deployment_id must be a deployment id' });
  });

  it('reaches the core with the machine as the actor and only the machines it was given', async () => {
    mockCancel.mockResolvedValue({ ok: true, deploymentId: 'd1', siteId: SITE, status: 'cancelled', cancelled: 2, machine_ids: [M1, M2] });
    const body = bodyOf(await cancel.run(wholeSite, [M1, M2], { deployment_id: 'd1' }));
    expect(body).toEqual({ deploymentId: 'd1', status: 'cancelled', cancelled: [M1, M2] });
    expect(mockCancel).toHaveBeenCalledWith({
      siteId: SITE,
      deploymentId: 'd1',
      actorIdentifier: `machine:${SENDER}`,
      correlationId: 'corr-1',
      machines: [M1, M2],
    });
  });

  it('turns a core refusal into a failed answer', async () => {
    mockCancel.mockResolvedValue({ ok: false, code: 'no_cancellable_targets', message: 'every target is already past the queued phase or terminal' });
    expect(await cancel.run(wholeSite, [M1], { deployment_id: 'd1' })).toEqual({
      status: 'failed',
      error: 'every target is already past the queued phase or terminal',
    });
  });

  it('rethrows a failed write', async () => {
    mockCancel.mockResolvedValue({ ok: false, code: 'write_failed', cause: new Error('boom') });
    await expect(cancel.run(wholeSite, [M1], { deployment_id: 'd1' })).rejects.toThrow('boom');
  });
});

describe('update_owlette_agent', () => {
  const update = find('update_owlette_agent', 'machine');
  const files = {
    windows_x64: { download_url: 'https://dl/win.exe', checksum_sha256: 'a'.repeat(64) },
    macos_arm64: { download_url: 'https://dl/mac.pkg', checksum_sha256: 'b'.repeat(64) },
    linux_x64: { download_url: 'https://dl/linux.deb', checksum_sha256: null },
  };

  beforeEach(() => {
    mockLatest.mockResolvedValue({ version: '4.2.0', files });
    mockCommand.mockResolvedValue({ commandId: 'cmd_1' });
  });

  it('sends the machine the installer for its own platform, as the machine actor', async () => {
    docs.set(`sites/${SITE}/machines/${M1}`, { osFamily: 'macos', arch: 'arm64' });
    const body = bodyOf(await update.run(wholeSite, M1, {}));
    expect(body).toEqual({ machine: M1, commandId: 'cmd_1', version: '4.2.0', status: 'queued' });
    expect(mockCommand).toHaveBeenCalledTimes(1);
    expect(mockCommand).toHaveBeenCalledWith(
      { siteId: SITE, machineId: M1, actor: wholeSite.actor, auditActor: `machine:${SENDER}`, correlationId: 'corr-1' },
      {
        type: 'update_owlette',
        payload: { installer_url: 'https://dl/mac.pkg', target_version: '4.2.0', checksum_sha256: 'b'.repeat(64) },
        auditAttributes: { toolName: 'update_owlette_agent' },
      },
      { db },
    );
  });

  it('treats a machine that reports no platform as windows x64', async () => {
    docs.set(`sites/${SITE}/machines/${M1}`, {});
    await update.run(wholeSite, M1, {});
    expect(mockCommand.mock.calls[0][1].payload.installer_url).toBe('https://dl/win.exe');
  });

  it('fails when no installer is uploaded, the platform has no build or the build has no checksum', async () => {
    docs.set(`sites/${SITE}/machines/${M1}`, {});
    mockLatest.mockResolvedValue(null);
    expect(await update.run(wholeSite, M1, {})).toEqual({ status: 'failed', error: 'no owlette installer has been uploaded yet' });

    mockLatest.mockResolvedValue({ version: '4.2.0', files: { macos_arm64: files.macos_arm64 } });
    expect((await update.run(wholeSite, M1, {})).status).toBe('failed');

    docs.set(`sites/${SITE}/machines/${M2}`, { osFamily: 'linux', arch: 'x64' });
    mockLatest.mockResolvedValue({ version: '4.2.0', files });
    expect(await update.run(wholeSite, M2, {})).toMatchObject({ status: 'failed', error: expect.stringContaining('no checksum') });
    expect(mockCommand).not.toHaveBeenCalled();
  });

  it('turns a core refusal into a failed answer and rethrows the unexpected', async () => {
    docs.set(`sites/${SITE}/machines/${M1}`, {});
    mockCommand.mockRejectedValueOnce(new ExecuteMachineCommandError(409, 'machine_offline', 'machine kiosk-1 is currently offline'));
    expect(await update.run(wholeSite, M1, {})).toEqual({ status: 'failed', error: 'machine kiosk-1 is currently offline' });
    mockCommand.mockRejectedValueOnce(new Error('boom'));
    await expect(update.run(wholeSite, M1, {})).rejects.toThrow('boom');
  });
});

