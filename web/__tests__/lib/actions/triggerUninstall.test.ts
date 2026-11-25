/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/triggerUninstall.server.ts`: input parsing,
 * the action against a fake firestore, and command-shape parity with the
 * legacy `useUninstall.ts:createUninstall` write so the agent's
 * `uninstall_software` handler treats both identically.
 *
 * Authorization lives in the route shim (`authorizedHandler.test.ts`).
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

// The default db resolves at import time, even though every test injects one.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));

import {
  triggerUninstall,
  parseTriggerUninstallInput,
  TriggerUninstallError,
} from '@/lib/actions/triggerUninstall.server';

interface SetCall {
  path: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

interface FakeDbState {
  setCalls: SetCall[];
  // Optional override for the machine doc's existence + data.
  setMachine: (data: Record<string, unknown> | null) => void;
  // Optional override for installed_software.where().limit().get().
  setSoftware: (records: Array<Record<string, unknown>>) => void;
  // A deployment doc under `sites/{siteId}/deployments/{id}`, keyed by its full path.
  setDeployment: (path: string, data: Record<string, unknown>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(): FakeDbState {
  const setCalls: SetCall[] = [];
  let machineData: Record<string, unknown> | null = { online: true };
  let softwareRecords: Array<Record<string, unknown>> = [];
  const deployments = new Map<string, Record<string, unknown>>();

  function makeQuery(): unknown {
    let whereField = '';
    let whereValue: unknown;
    let limitN = Infinity;
    const q = {
      where: (field: string, op: string, value: unknown) => {
        if (op !== '==') throw new Error(`unsupported op: ${op}`);
        whereField = field;
        whereValue = value;
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      get: async () => {
        const matches = softwareRecords.filter((r) => r[whereField] === whereValue);
        const docs = matches.slice(0, limitN).map((data) => ({ data: () => data }));
        return { empty: docs.length === 0, docs };
      },
    };
    return q;
  }

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        if (deployments.has(docPath)) return { exists: true, data: () => deployments.get(docPath) };
        if (docPath.startsWith('sites/') && docPath.includes('/machines/') && !docPath.includes('/commands/')) {
          // The machine doc itself.
          if (machineData === null) return { exists: false, data: () => undefined };
          return { exists: true, data: () => machineData };
        }
        return { exists: false, data: () => undefined };
      },
      set: async (
        payload: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        setCalls.push({ path: docPath, payload, options });
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    return {
      doc: (id: string) => makeDocRef(`${colPath}/${id}`),
      // Used by the installed_software query path.
      where: (field: string, op: string, value: unknown) =>
        (makeQuery() as { where: (f: string, o: string, v: unknown) => unknown }).where(field, op, value),
    };
  }

  const db = {
    collection: (name: string) => makeCollectionRef(name),
  };

  return {
    setCalls,
    setMachine: (data) => {
      machineData = data;
    },
    setSoftware: (records) => {
      softwareRecords = records;
    },
    setDeployment: (path, data) => {
      deployments.set(path, data);
    },
    db,
  };
}

describe('parseTriggerUninstallInput', () => {
  it('accepts a minimal valid payload (software_name only)', () => {
    const out = parseTriggerUninstallInput({ software_name: 'TouchDesigner' });
    expect(out).toEqual({ software_name: 'TouchDesigner' });
  });

  it('trims surrounding whitespace from software_name', () => {
    const out = parseTriggerUninstallInput({ software_name: '  Resolume  ' });
    expect(out.software_name).toBe('Resolume');
  });

  it('rejects a non-object body', () => {
    expect(() => parseTriggerUninstallInput(null)).toThrow(TriggerUninstallError);
    expect(() => parseTriggerUninstallInput('foo')).toThrow(TriggerUninstallError);
    expect(() => parseTriggerUninstallInput([1, 2])).toThrow(TriggerUninstallError);
  });

  it('rejects missing software_name', () => {
    expect(() => parseTriggerUninstallInput({})).toThrow(/software_name/);
  });

  it('rejects empty software_name', () => {
    expect(() => parseTriggerUninstallInput({ software_name: '   ' })).toThrow(
      /software_name/,
    );
  });

  it('rejects software_name longer than 256 chars', () => {
    const longName = 'a'.repeat(257);
    expect(() => parseTriggerUninstallInput({ software_name: longName })).toThrow(
      /256/,
    );
  });

  it('accepts close_processes as an array of non-empty strings', () => {
    const out = parseTriggerUninstallInput({
      software_name: 'TD',
      close_processes: ['TouchDesigner.exe', '  Resolume.exe  '],
    });
    expect(out.close_processes).toEqual(['TouchDesigner.exe', 'Resolume.exe']);
  });

  it('rejects close_processes that is not an array', () => {
    expect(() =>
      parseTriggerUninstallInput({ software_name: 'TD', close_processes: 'not-array' }),
    ).toThrow(/close_processes/);
  });

  it('rejects close_processes entries that are not strings', () => {
    expect(() =>
      parseTriggerUninstallInput({
        software_name: 'TD',
        close_processes: ['ok.exe', 42 as unknown as string],
      }),
    ).toThrow(/close_processes/);
  });

  it('rejects close_processes with empty entries', () => {
    expect(() =>
      parseTriggerUninstallInput({
        software_name: 'TD',
        close_processes: ['ok.exe', '   '],
      }),
    ).toThrow(/close_processes/);
  });

  it('rejects close_processes longer than 32 entries', () => {
    const big = Array.from({ length: 33 }, (_, i) => `p${i}.exe`);
    expect(() =>
      parseTriggerUninstallInput({ software_name: 'TD', close_processes: big }),
    ).toThrow(/close_processes/);
  });

  it('clamps timeout_seconds to the [1, 86400] range', () => {
    expect(parseTriggerUninstallInput({ software_name: 'X', timeout_seconds: 0.5 })).toEqual({
      software_name: 'X',
      timeout_seconds: 1,
    });
    expect(
      parseTriggerUninstallInput({ software_name: 'X', timeout_seconds: 1_000_000 }),
    ).toEqual({ software_name: 'X', timeout_seconds: 86_400 });
  });

  it('rejects non-numeric or non-positive timeout_seconds', () => {
    expect(() =>
      parseTriggerUninstallInput({ software_name: 'X', timeout_seconds: -1 }),
    ).toThrow(/timeout_seconds/);
    expect(() =>
      parseTriggerUninstallInput({ software_name: 'X', timeout_seconds: 'soon' }),
    ).toThrow(/timeout_seconds/);
  });

  it('omits optional fields entirely when null/undefined', () => {
    const out = parseTriggerUninstallInput({
      software_name: 'X',
      close_processes: null,
      timeout_seconds: null,
    });
    expect(out).toEqual({ software_name: 'X' });
    expect(Object.prototype.hasOwnProperty.call(out, 'close_processes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'timeout_seconds')).toBe(false);
  });

  it('accepts a deployment_id and treats null as absent', () => {
    expect(
      parseTriggerUninstallInput({ software_name: 'X', deployment_id: 'deploy-1700000000000' }),
    ).toEqual({ software_name: 'X', deployment_id: 'deploy-1700000000000' });
    expect(parseTriggerUninstallInput({ software_name: 'X', deployment_id: null })).toEqual({
      software_name: 'X',
    });
  });

  it.each([
    ['a path', 'deploy-1/../../other'],
    ['empty', ''],
    ['not a string', 42],
  ])('rejects a deployment_id that is %s', (_label, deploymentId) => {
    expect(() =>
      parseTriggerUninstallInput({ software_name: 'X', deployment_id: deploymentId }),
    ).toThrow(/deployment_id/);
  });
});

describe('triggerUninstall — input guards', () => {
  it('throws when siteId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      triggerUninstall('', 'm1', { software_name: 'X' }, { db: fake.db }),
    ).rejects.toThrow(/siteId/);
    expect(fake.setCalls).toHaveLength(0);
  });

  it('throws when machineId is empty', async () => {
    const fake = buildFakeDb();
    await expect(
      triggerUninstall('site-a', '', { software_name: 'X' }, { db: fake.db }),
    ).rejects.toThrow(/machineId/);
    expect(fake.setCalls).toHaveLength(0);
  });
});

describe('triggerUninstall — machine + software lookup', () => {
  it('returns machine_not_found when the machine doc is absent', async () => {
    const fake = buildFakeDb();
    fake.setMachine(null);
    await expect(
      triggerUninstall(
        'site-a',
        'mach_alpha',
        { software_name: 'TD' },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({
      name: 'TriggerUninstallError',
      code: 'machine_not_found',
    });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('does NOT enforce online by default — even offline machines accept queued uninstall', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: false });
    fake.setSoftware([
      {
        name: 'TD',
        uninstall_command: '"C:/td/uninst.exe"',
        installer_type: 'inno',
        install_location: 'C:/td',
      },
    ]);
    const result = await triggerUninstall(
      'site-a',
      'm1',
      { software_name: 'TD' },
      { db: fake.db, now: () => 1_700_000_000_000 },
    );
    expect(result.status).toBe('pending');
    expect(fake.setCalls).toHaveLength(1);
  });

  it('returns machine_offline when requireOnline=true and machine is offline', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: false });
    await expect(
      triggerUninstall(
        'site-a',
        'm1',
        { software_name: 'TD' },
        { db: fake.db, requireOnline: true },
      ),
    ).rejects.toMatchObject({
      name: 'TriggerUninstallError',
      code: 'machine_offline',
    });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('returns software_not_found when no installed_software record matches', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    fake.setSoftware([]); // No matches.
    await expect(
      triggerUninstall(
        'site-a',
        'm1',
        { software_name: 'GhostApp' },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({
      name: 'TriggerUninstallError',
      code: 'software_not_found',
    });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('returns software_record_invalid when uninstall_command is missing', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    fake.setSoftware([{ name: 'TD', uninstall_command: '' }]);
    await expect(
      triggerUninstall(
        'site-a',
        'm1',
        { software_name: 'TD' },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({
      name: 'TriggerUninstallError',
      code: 'software_record_invalid',
    });
    expect(fake.setCalls).toHaveLength(0);
  });
});

describe('triggerUninstall — command write shape (parity with useUninstall.ts)', () => {
  it('writes the canonical uninstall_software payload with lifecycle stamps', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    fake.setSoftware([
      {
        name: 'TouchDesigner 2025',
        uninstall_command: '"C:/td/unins000.exe"',
        installer_type: 'inno',
        install_location: 'C:/Program Files/TouchDesigner',
      },
    ]);

    const result = await triggerUninstall(
      'site-alpha',
      'mach_pi',
      { software_name: 'TouchDesigner 2025' },
      {
        db: fake.db,
        now: () => 1_700_000_000_000,
        auditCorrelationId: 'corr_xyz',
      },
    );

    expect(fake.setCalls).toHaveLength(1);
    const call = fake.setCalls[0];
    // Path must be the exact pending-map address the agent listens to.
    expect(call.path).toBe('sites/site-alpha/machines/mach_pi/commands/pending');
    expect(call.options).toEqual({ merge: true });

    // Payload is `{ [commandId]: stamped }` with one key.
    const keys = Object.keys(call.payload);
    expect(keys).toHaveLength(1);
    const commandId = keys[0];
    expect(commandId).toBe('uninstall-1700000000000');
    expect(commandId).toBe(result.commandId);

    const entry = call.payload[commandId] as Record<string, unknown>;
    // Every legacy field from useUninstall.ts, identical.
    expect(entry.type).toBe('uninstall_software');
    expect(entry.software_name).toBe('TouchDesigner 2025');
    expect(entry.uninstall_command).toBe('"C:/td/unins000.exe"');
    expect(entry.installer_type).toBe('inno');
    expect(entry.verify_paths).toEqual(['C:/Program Files/TouchDesigner']);
    // Legacy serverTimestamp() sentinel, kept for back-compat.
    expect(entry.timestamp).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    // No deployment_id when not deployment-tied.
    expect(Object.prototype.hasOwnProperty.call(entry, 'deployment_id')).toBe(false);
    // Lifecycle stamps from stampCommand.
    expect(entry.createdAt).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    expect(entry.expiresAt).toBeInstanceOf(Timestamp);
    expect(entry.auditCorrelationId).toBe('corr_xyz');
  });

  it('forwards close_processes verbatim into the command body', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    fake.setSoftware([
      {
        name: 'TD',
        uninstall_command: 'unins.exe',
        installer_type: 'inno',
        install_location: 'C:/td',
      },
    ]);
    await triggerUninstall(
      'site-a',
      'm1',
      { software_name: 'TD', close_processes: ['TouchDesigner.exe'] },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.close_processes).toEqual(['TouchDesigner.exe']);
  });

  it('forwards timeout_seconds verbatim into the command body', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    fake.setSoftware([
      {
        name: 'TD',
        uninstall_command: 'unins.exe',
        installer_type: 'inno',
        install_location: 'C:/td',
      },
    ]);
    await triggerUninstall(
      'site-a',
      'm1',
      { software_name: 'TD', timeout_seconds: 600 },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.timeout_seconds).toBe(600);
  });

  it('defaults installer_type to "custom" when the record lacks one', async () => {
    const fake = buildFakeDb();
    fake.setMachine({ online: true });
    fake.setSoftware([
      {
        name: 'TD',
        uninstall_command: 'unins.exe',
        installer_type: '',
        install_location: '',
      },
    ]);
    await triggerUninstall(
      'site-a',
      'm1',
      { software_name: 'TD' },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.installer_type).toBe('custom');
    expect(entry.verify_paths).toEqual([]);
  });
});

describe('triggerUninstall — deployment_id', () => {
  function fakeWithTd() {
    const fake = buildFakeDb();
    fake.setSoftware([
      { name: 'TD', uninstall_command: 'unins.exe', installer_type: 'inno', install_location: 'C:/td' },
    ]);
    return fake;
  }

  it('carries the deployment_id onto the command when the machine is a finished target', async () => {
    const fake = fakeWithTd();
    fake.setDeployment('sites/site-a/deployments/deploy-1', {
      targets: [{ machineId: 'm0', status: 'completed' }, { machineId: 'm1', status: 'failed' }],
    });
    const result = await triggerUninstall(
      'site-a',
      'm1',
      { software_name: 'TD', deployment_id: 'deploy-1' },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.deployment_id).toBe('deploy-1');
    expect(result.deployment_id).toBe('deploy-1');
  });

  // a dashboard loaded before deployment_id was read sends it for every selected machine.
  it('queues the uninstall untied, as before, when the deployment does not target the machine', async () => {
    const fake = fakeWithTd();
    fake.setDeployment('sites/site-a/deployments/deploy-1', {
      targets: [{ machineId: 'm0', status: 'completed' }],
    });
    const result = await triggerUninstall(
      'site-a',
      'm1',
      { software_name: 'TD', deployment_id: 'deploy-1' },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(entry, 'deployment_id')).toBe(false);
    expect(result).not.toHaveProperty('deployment_id');
  });

  it.each([
    ['is not on this site', null, /not found on site/],
    [
      'is still installing on this machine',
      { targets: [{ machineId: 'm1', status: 'installing' }] },
      /still installing/,
    ],
  ])('refuses, and writes nothing, when the deployment %s', async (_label, deployment, message) => {
    const fake = fakeWithTd();
    if (deployment) fake.setDeployment('sites/site-a/deployments/deploy-1', deployment);
    await expect(
      triggerUninstall(
        'site-a',
        'm1',
        { software_name: 'TD', deployment_id: 'deploy-1' },
        { db: fake.db, now: () => 1 },
      ),
    ).rejects.toMatchObject({
      name: 'TriggerUninstallError',
      code: 'validation_failed',
      message: expect.stringMatching(message),
      fieldErrors: { 'body.deployment_id': expect.any(Array) },
    });
    expect(fake.setCalls).toHaveLength(0);
  });
});

describe('triggerUninstall — two versions under one name', () => {
  // unchanged on purpose: a person picked this program in a dialog. the deployment route refuses
  // the same case as software_ambiguous.
  it('queues the first record, as it always has', async () => {
    const fake = buildFakeDb();
    fake.setSoftware([
      { name: 'TD', version: '2023', uninstall_command: 'unins-2023.exe', installer_type: 'inno' },
      { name: 'TD', version: '2022', uninstall_command: 'unins-2022.exe', installer_type: 'inno' },
    ]);
    await triggerUninstall('site-a', 'm1', { software_name: 'TD' }, { db: fake.db, now: () => 1 });
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.uninstall_command).toBe('unins-2023.exe');
  });
});
