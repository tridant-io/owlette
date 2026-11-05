/** @jest-environment node */

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

import {
  createDeployment,
  type CreateDeploymentInput,
} from '@/lib/actions/createDeployment.server';
import { cancelDeployment } from '@/lib/actions/cancelDeployment.server';
import { deleteDeployment } from '@/lib/actions/deleteDeployment.server';
import { emitMutation } from '@/lib/auditLogClient';

type FakeDb = NonNullable<Parameters<typeof createDeployment>[1]['db']>;

interface RecordedSet {
  path: string[];
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

interface RecordedUpdate {
  path: string[];
  payload: Record<string, unknown>;
}

function buildFakeDb(initialDocs: Record<string, Record<string, unknown> | null> = {}) {
  const docs = new Map<string, Record<string, unknown> | null>(
    Object.entries(initialDocs),
  );
  const sets: RecordedSet[] = [];
  const updates: RecordedUpdate[] = [];
  const deletes: string[][] = [];

  function makeCollection(parentPath: string[]) {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        const key = docPath.join('/');
        return {
          set: jest.fn(
            async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
              sets.push({ path: docPath, payload, options });
              const existing = docs.get(key);
              docs.set(
                key,
                options?.merge && existing
                  ? { ...existing, ...payload }
                  : payload,
              );
            },
          ),
          update: jest.fn(async (payload: Record<string, unknown>) => {
            updates.push({ path: docPath, payload });
            docs.set(key, { ...(docs.get(key) ?? {}), ...payload });
          }),
          delete: jest.fn(async () => {
            deletes.push(docPath);
            docs.delete(key);
          }),
          get: jest.fn(async () => {
            const data = docs.get(key);
            return {
              exists: data !== undefined && data !== null,
              data: () => data ?? undefined,
            };
          }),
          collection: (name: string) => makeCollection([...docPath, name]),
        };
      },
    };
  }

  return {
    db: { collection: (name: string) => makeCollection([name]) } as unknown as FakeDb,
    sets,
    updates,
    deletes,
  };
}

const ctx = {
  siteId: 'site_a',
  createdBy: 'user_1',
  actorIdentifier: 'user:user_1',
  correlationId: 'corr_1',
  now: () => 1_700_000_000_000,
};

const validInput: CreateDeploymentInput = {
  name: 'vlc rollout',
  installer_name: 'vlc.exe',
  installer_url: 'https://cdn.example.com/vlc.exe',
  silent_flags: '/S',
  machines: ['m1', 'm2'],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createDeployment', () => {
  it('writes the deployment doc and install commands with legacy fields', async () => {
    const { db, sets, updates } = buildFakeDb({
      'sites/site_a': { deployQuota: 10 },
    });

    const result = await createDeployment(validInput, { ...ctx, db });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deploymentId).toBe('deploy-1700000000000');

    const deploymentSet = sets.find((set) => set.path.includes('deployments'));
    expect(deploymentSet).toBeDefined();
    if (!deploymentSet) return;
    expect(deploymentSet.payload.createdBy).toBe('user_1');
    expect(deploymentSet.payload.auditCorrelationId).toBe('corr_1');
    expect(deploymentSet.payload.status).toBe('pending');

    const commandSets = sets.filter((set) => set.path[set.path.length - 1] === 'pending');
    expect(commandSets).toHaveLength(2);
    const firstCommandPayload = Object.values(commandSets[0].payload)[0] as Record<string, unknown>;
    expect(firstCommandPayload.type).toBe('install_software');
    expect(firstCommandPayload.deployment_id).toBe('deploy-1700000000000');
    expect(firstCommandPayload.timestamp).toBeDefined();
    expect(firstCommandPayload.auditCorrelationId).toBe('corr_1');
    expect(firstCommandPayload.metadata).toEqual({ auditCorrelationId: 'corr_1' });

    expect(updates.find((update) => update.path.includes('deployments'))?.payload).toEqual({
      status: 'in_progress',
    });
    expect(emitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'deployment_mutated',
        attributes: expect.objectContaining({ verb: 'create', correlationId: 'corr_1' }),
      }),
    );
  });

  describe('active-hours override (active-hours-guard task 2.3)', () => {
    function installCommands(sets: RecordedSet[]): Record<string, unknown>[] {
      return sets
        .filter((set) => set.path[set.path.length - 1] === 'pending')
        .map((set) => Object.values(set.payload)[0] as Record<string, unknown>);
    }

    it('flows to every install_software command with approvedBy = the actor, and is audited', async () => {
      const { db, sets } = buildFakeDb({ 'sites/site_a': {} });
      const result = await createDeployment(
        { ...validInput, active_hours_override: { reason: '  venue closed today  ' } },
        { ...ctx, db },
      );
      expect(result.ok).toBe(true);
      const commands = installCommands(sets);
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command.activeHoursOverride).toEqual({
          reason: 'venue closed today',
          approvedBy: 'user:user_1',
        });
      }
      expect(emitMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            verb: 'create',
            activeHoursOverride: true,
            activeHoursOverrideReason: 'venue closed today',
          }),
        }),
      );
    });

    it('without one the commands carry none', async () => {
      const { db, sets } = buildFakeDb({ 'sites/site_a': {} });
      await createDeployment(validInput, { ...ctx, db });
      for (const command of installCommands(sets)) {
        expect(command).not.toHaveProperty('activeHoursOverride');
      }
    });

    it.each([
      ['an empty reason', { reason: '' }],
      ['an over-long reason', { reason: 'x'.repeat(501) }],
      ['an unknown key', { reason: 'ok', approvedBy: 'user:attacker' }],
    ])('rejects %s and writes nothing', async (_label, override) => {
      const { db, sets } = buildFakeDb({ 'sites/site_a': {} });
      const result = await createDeployment(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...validInput, active_hours_override: override as any },
        { ...ctx, db },
      );
      expect(result).toMatchObject({ ok: false, code: 'invalid_active_hours_override' });
      expect(sets).toHaveLength(0);
    });

    it('refuses an override from a system actor and writes nothing', async () => {
      const { db, sets } = buildFakeDb({ 'sites/site_a': {} });
      const result = await createDeployment(
        { ...validInput, active_hours_override: { reason: 'show is over' } },
        { ...ctx, actorIdentifier: 'system:hoot', db },
      );
      expect(result).toMatchObject({ ok: false, code: 'invalid_active_hours_override' });
      expect(sets).toHaveLength(0);
    });
  });

  it('enforces per-site deployQuota', async () => {
    const { db } = buildFakeDb({ 'sites/site_a': { deployQuota: 1 } });
    const result = await createDeployment(validInput, { ...ctx, db });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('over_quota');
    expect(result.details).toEqual({ max_targets: 1, requested: 2 });
  });
});

describe('cancelDeployment', () => {
  it('purges queued installs, fans out cancel commands, and marks targets cancelled', async () => {
    const { db, sets, updates } = buildFakeDb({
      'sites/site_a/deployments/deploy_1': {
        installer_name: 'vlc.exe',
        status: 'in_progress',
        targets: [
          { machineId: 'm1', status: 'installing' },
          { machineId: 'm2', status: 'pending' },
        ],
      },
      'sites/site_a/machines/m2/commands/pending': {
        install_1: { type: 'install_software', deployment_id: 'deploy_1' },
        reboot_1: { type: 'reboot_machine' },
      },
    });

    const result = await cancelDeployment({
      siteId: 'site_a',
      deploymentId: 'deploy_1',
      actorIdentifier: 'user:user_1',
      correlationId: 'corr_1',
      db,
      now: ctx.now,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cancelled).toBe(1);
    expect(result.machine_ids).toEqual(['m2']);

    const pendingUpdate = updates.find((update) =>
      update.path.join('/').endsWith('machines/m2/commands/pending'),
    );
    expect(pendingUpdate?.payload.install_1).toBeDefined();

    const cancelCommandSet = sets.find((set) =>
      set.path.join('/').endsWith('machines/m2/commands/pending'),
    );
    expect(cancelCommandSet).toBeDefined();
    if (!cancelCommandSet) return;
    const cancelCommand = Object.values(cancelCommandSet.payload)[0] as Record<string, unknown>;
    expect(cancelCommand.type).toBe('cancel_installation');
    expect(cancelCommand.installer_name).toBe('vlc.exe');
    expect(cancelCommand.timestamp).toBeDefined();

    const deploymentUpdate = updates.find((update) => update.path.includes('deployments'));
    const updatedTargets = deploymentUpdate?.payload.targets as Array<{
      machineId: string;
      status: string;
    }>;
    expect(updatedTargets.find((target) => target.machineId === 'm2')?.status).toBe('cancelled');
    expect(updatedTargets.find((target) => target.machineId === 'm1')?.status).toBe('installing');
  });
});

describe('deleteDeployment', () => {
  it('deletes terminal deployments', async () => {
    const { db, deletes } = buildFakeDb({
      'sites/site_a/deployments/deploy_1': {
        status: 'completed',
        targets: [{ machineId: 'm1', status: 'completed' }],
      },
    });

    const result = await deleteDeployment({
      siteId: 'site_a',
      deploymentId: 'deploy_1',
      actorIdentifier: 'user:user_1',
      correlationId: 'corr_1',
      db,
    });

    expect(result.ok).toBe(true);
    expect(deletes).toEqual([['sites', 'site_a', 'deployments', 'deploy_1']]);
  });

  it('rejects deployments with in-flight parent status', async () => {
    const { db } = buildFakeDb({
      'sites/site_a/deployments/deploy_1': {
        status: 'in_progress',
        targets: [{ machineId: 'm1', status: 'installing' }],
      },
    });

    const result = await deleteDeployment({
      siteId: 'site_a',
      deploymentId: 'deploy_1',
      actorIdentifier: 'user:user_1',
      correlationId: 'corr_1',
      db,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('deployment_in_flight');
    expect(result.details?.status).toBe('in_progress');
  });
});
