/** @jest-environment node */

/**
 * Owner's ruling: hoot changing what a machine launches needs a person's approval,
 * always. These run the real builder and refusal over a fake store, so "nothing
 * reached the machine" means no pending command and no process action, whatever the
 * site's tier-3 setting says. The real SDK's half is in asyncTurns.integration.test.
 */

jest.mock('ai', () => ({
  tool: jest.fn((definition: unknown) => definition),
  jsonSchema: jest.fn((schema: unknown) => schema),
}));

jest.mock('@/lib/llm-encryption.server', () => ({ decryptApiKey: jest.fn() }));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: jest.fn(() => '__FIELD_DELETE__'), serverTimestamp: jest.fn(() => '__SERVER_TIMESTAMP__') },
}));

const mockCreateProcess = jest.fn();
const mockUpdateProcess = jest.fn();
const mockDeleteProcess = jest.fn();
const mockEmitMutation = jest.fn();
const mockAuditBlocking = jest.fn();

jest.mock('@/lib/actions/createProcess.server', () => ({
  ActionInputError: class extends Error {},
  createProcess: (...args: unknown[]) => mockCreateProcess(...args),
}));
jest.mock('@/lib/actions/updateProcess.server', () => ({
  updateProcess: (...args: unknown[]) => mockUpdateProcess(...args),
}));
jest.mock('@/lib/actions/deleteProcess.server', () => ({
  deleteProcess: (...args: unknown[]) => mockDeleteProcess(...args),
}));
// a deployment pins its installer's checksum before it queues, which would download it
jest.mock('@/lib/actions/computeInstallerChecksum.server', () => ({
  ...jest.requireActual('@/lib/actions/computeInstallerChecksum.server'),
  computeInstallerChecksum: async () => ({ sha256_checksum: 'c'.repeat(64), size_bytes: 1024 }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: () => 'corr-1',
  writeAuditEntryBlocking: (...args: unknown[]) => mockAuditBlocking(...args),
}));

const mockCreateTalon = jest.fn();
const mockSetTalonEnabled = jest.fn();
jest.mock('@/lib/talons/store.server', () => ({
  TalonStoreError: class extends Error {},
  createTalon: (...args: unknown[]) => mockCreateTalon(...args),
  setTalonEnabled: (...args: unknown[]) => mockSetTalonEnabled(...args),
}));

import { buildExecutableTools, type BuildExecutableToolsOptions } from '@/lib/hoot-utils.server';
import { toolCallHash } from '@/lib/hoot/launchAudit.server';
import { allTools } from '@/lib/mcp-tools';

const SITE = 's1';
const MACHINE = 'm1';
const TURN = 'turn-1';
const PENDING = `sites/${SITE}/machines/${MACHINE}/commands/pending`;
const CONFIG = `config/${SITE}/machines/${MACHINE}`;
const TD = { processes: [{ processId: 'p1', id: 'p1', name: 'TD', exe_path: 'C:\\old.exe', launch_mode: 'off' }] };

/** Path-keyed firestore; a pending write completes at once, as an agent would. */
function fakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const store: Record<string, Record<string, unknown>> = { ...seed };
  let failWrites = false;
  const docRef = (path: string): Record<string, unknown> => ({
    get: async () => ({ exists: path in store, data: () => store[path] }),
    set: async (data: Record<string, unknown>) => {
      if (failWrites) throw new Error('firestore down');
      store[path] = { ...store[path], ...data };
      if (path.endsWith('/commands/pending')) {
        const completed = path.replace('/pending', '/completed');
        store[completed] = {
          ...store[completed],
          ...Object.fromEntries(
            Object.keys(data).map((id) => [id, { status: 'completed', result: 'ok' }]),
          ),
        };
      }
    },
    update: async () => undefined,
    collection: (name: string) => colRef(`${path}/${name}`),
  });
  const colRef = (path: string) => ({
    doc: (id: string) => docRef(`${path}/${id}`),
    get: async () => ({ docs: [] }),
  });
  return {
    db: { collection: colRef } as unknown as FirebaseFirestore.Firestore,
    store,
    failNextWrites: () => {
      failWrites = true;
    },
  };
}

const WINLOGON = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';

/** Every tier-2 way to change what a machine launches, as an injected model would call it. */
const LAUNCH_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['update_process', { process_name: 'TD', exe_path: 'C:\\evil.exe' }],
  ['update_process', { process_name: 'TD', file_path: '--load evil.toe' }],
  ['update_process', { process_name: 'TD', cwd: 'C:\\evil' }],
  ['update_process', { process_name: 'TD', launch_mode: 'always' }],
  ['update_process', { process_name: 'TD', schedules: [] }],
  ['update_process', { process_name: 'TD', schedulePresetId: 'nightly' }],
  ['update_process', { process_name: 'TD', time_delay: '86400' }],
  ['update_process', { process_name: 'TD', time_to_init: '86400' }],
  ['update_process', { process_name: 'TD', relaunch_attempts: '1' }],
  ['update_process', { process_name: 'TD', name: 'TD', exe_path: 'C:\\evil.exe' }],
  ['add_process', { name: 'evil', exe_path: 'C:\\evil.exe' }],
  ['delete_process', { process_name: 'TD' }],
  ['set_launch_mode', { process_name: 'TD', mode: 'always' }],
  [
    'manage_scheduled_task',
    { action: 'create', task_name: 'x', task_action: { type: 'run_program', program: 'C:\\evil.exe' } },
  ],
  ['manage_scheduled_task', { action: 'enable', task_name: 'x' }],
  ['manage_scheduled_task', { action: 'run_now', task_name: 'x' }],
  ['manage_windows_service', { service_name: 'x', action: 'set_startup', startup_type: 'auto' }],
  [
    'manage_windows_service',
    { service_name: 'x', action: 'set_recovery', first_failure: 'run_program', run_program_path: 'C:\\evil.exe' },
  ],
  ['manage_windows_feature', { type: 'capability', action: 'install', name: 'OpenSSH.Server~~~~0.0.1.0' }],
  ['manage_windows_update', { action: 'set_scheduled_install', day_of_week: 3, hour: 3 }],
  ['registry_operation', { action: 'write', hive: 'HKLM', key_path: WINLOGON, value_name: 'AutoAdminLogon', value_data: '1' }],
  ['registry_operation', { action: 'delete', hive: 'HKLM', key_path: WINLOGON, value_name: 'AutoAdminLogon' }],
  [
    'create_talon',
    {
      name: 'x',
      trigger: { type: 'schedule', intervalMinutes: 60 },
      outputs: [{ type: 'command', commandType: 'start_process', processName: 'TD' }],
    },
  ],
  [
    'create_talon',
    {
      name: 'x',
      trigger: { type: 'schedule', intervalMinutes: 60 },
      outputs: [{ type: 'cortex', directive: 'x', allowActions: true }],
    },
  ],
  ['set_talon_enabled', { talon_id: 't1', enabled: true }],
  ['run_command', { command: 'sc create evil' }],
  ['run_powershell', { script: 'Start-Process calc' }],
  ['run_python', { code: 'import os' }],
  ['execute_script', { script: 'calc.exe' }],
  ['write_file', { path: 'C:\\x.bat', content: 'calc' }],
  ['deploy_software', { software_name: 'x', installer_url: 'https://x/x.exe', silent_flags: '/S' }],
];

/** Launch changes no tool takes as written: an unknown field, an action in the wrong case. */
const MALFORMED_LAUNCH_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['update_process', { process_name: 'TD', autolaunch: true }],
  ['manage_scheduled_task', { action: 'CREATE', task_name: 'x' }],
];

/** Calls that leave what runs alone, and stay as they were. */
const NOT_LAUNCH_CHANGES: Array<[string, Record<string, unknown>]> = [
  ['update_process', { process_name: 'TD', name: 'renamed' }],
  ['update_process', { process_name: 'TD', priority: 'High', visibility: 'Hidden' }],
  ['restart_process', { process_name: 'TD' }],
  ['start_process', { process_name: 'TD' }],
  ['kill_process', { process_name: 'TD' }],
  ['manage_scheduled_task', { action: 'list' }],
  ['manage_scheduled_task', { action: 'get_details', task_name: 'x' }],
  ['manage_scheduled_task', { action: 'stop', task_name: 'x' }],
  ['manage_windows_service', { service_name: 'x', action: 'restart' }],
  ['manage_windows_service', { service_name: 'x', action: 'get_details' }],
  ['manage_windows_feature', { type: 'capability', action: 'list' }],
  ['manage_windows_update', { action: 'get_status' }],
  ['registry_operation', { action: 'read', hive: 'HKLM', key_path: 'SYSTEM\\CurrentControlSet\\Control\\Power' }],
  ['set_talon_enabled', { talon_id: 't1', enabled: false }],
  [
    'create_talon',
    {
      name: 'x',
      trigger: { type: 'schedule', intervalMinutes: 60 },
      outputs: [{ type: 'email' }, { type: 'cortex', directive: 'look' }],
    },
  ],
];

function toolsFor(
  db: FirebaseFirestore.Firestore,
  name: string,
  options: BuildExecutableToolsOptions,
  siteMode = false,
  machines: string[] = [MACHINE],
) {
  const def = allTools.find((tool) => tool.name === name)!;
  return buildExecutableTools(db, SITE, machines[0], 'chat-1', [def], siteMode, siteMode ? machines : [], {
    userId: 'uid_alice',
    userRole: 'admin',
    userStanding: { role: 'admin', swoopMode: null, machineIds: null },
    machineScope: null,
    turnId: TURN,
    ...options,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as Record<string, any>;
}

const asked = { toolCallId: 'call_1', messages: [] };
const approvable: BuildExecutableToolsOptions = { launchChangeApprovable: true };

/** What the runner does for a turn that answers a card: its one claim on the call. */
function claim(db: FirebaseFirestore.Firestore, turnId = TURN, toolCallId = asked.toolCallId) {
  return db.collection('chats').doc('chat-1').collection('approvals').doc(toolCallId).set({ turnId });
}

/** The card is raised, answered and claimed: what a person's approve leads to. */
async function approveAndRun(
  db: FirebaseFirestore.Firestore,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>,
  name: string,
  input: Record<string, unknown>,
) {
  expect(await tools[name].needsApproval(input, asked)).toBe(true);
  await claim(db);
  return tools[name].execute(input, { toolCallId: asked.toolCallId });
}

function expectNothingReachedTheMachine(store: Record<string, unknown>) {
  expect(store[PENDING]).toBeUndefined();
  expect(mockCreateProcess).not.toHaveBeenCalled();
  expect(mockUpdateProcess).not.toHaveBeenCalled();
  expect(mockDeleteProcess).not.toHaveBeenCalled();
  expect(mockCreateTalon).not.toHaveBeenCalled();
  expect(mockSetTalonEnabled).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateProcess.mockResolvedValue({ processId: 'p1' });
  mockCreateProcess.mockResolvedValue({ processId: 'p2' });
  mockDeleteProcess.mockResolvedValue({ processId: 'p1', alreadyDeleted: false });
  mockCreateTalon.mockResolvedValue({ id: 't1', name: 'x', enabled: true });
  mockSetTalonEnabled.mockResolvedValue({ id: 't1', name: 'x', enabled: false });
  process.env.CORTEX_INTERNAL_SECRET = 'test-secret';
  mockAuditBlocking.mockReset();
  mockAuditBlocking.mockResolvedValue(undefined);
});

describe('a launch change where a person can answer', () => {
  it.each(LAUNCH_CHANGES)('%s %j asks them, with the site gate off', async (name, input) => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, name, { requireTier3Approval: false, ...approvable });

    expect(await tools[name].needsApproval(input, asked)).toBe(true);
    expectNothingReachedTheMachine(store);
  });

  it.each(LAUNCH_CHANGES)('%s %j asks them, with the site gate on', async (name, input) => {
    const { db } = fakeDb();
    const tools = toolsFor(db, name, { requireTier3Approval: true, ...approvable });

    expect(await tools[name].needsApproval(input, asked)).toBe(true);
  });

  it('asks on a site-wide turn too', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'update_process', { requireTier3Approval: false, ...approvable }, true);

    expect(await tools.update_process.needsApproval({ process_name: 'TD', cwd: 'C:\\x' }, asked)).toBe(true);
  });

  it.each(NOT_LAUNCH_CHANGES)('%s %j does not ask', async (name, input) => {
    const { db } = fakeDb();
    const tools = toolsFor(db, name, { requireTier3Approval: true, ...approvable });

    expect(await tools[name].needsApproval(input, asked)).toBe(false);
  });

  it.each(MALFORMED_LAUNCH_CHANGES)('%s %j gets no card, and is refused as it stands', async (name, input) => {
    const { db, store } = fakeDb({ [CONFIG]: TD });
    const tools = toolsFor(db, name, { requireTier3Approval: false, ...approvable });

    expect(await tools[name].needsApproval(input, asked)).toBe(false);
    const result = await tools[name].execute(input, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'tool_params_invalid', status: 400 });
    expectNothingReachedTheMachine(store);
  });
});

describe('a launch change where nobody can answer', () => {
  it.each([...LAUNCH_CHANGES, ...MALFORMED_LAUNCH_CHANGES])('%s %j is refused and never reaches the machine', async (name, input) => {
    const { db, store } = fakeDb({ [CONFIG]: TD });
    // no launchChangeApprovable: the default is the safe side.
    const tools = toolsFor(db, name, { requireTier3Approval: false });

    expect(await tools[name].needsApproval(input, asked)).toBe(false);
    const result = await tools[name].execute(input, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'launch_change_needs_approval', status: 403 });
    expect((result as { detail: string }).detail).toMatch(/nothing was changed/);
    expectNothingReachedTheMachine(store);
  });

  it('refuses a fan-out before any machine sees it', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', {}, true);

    const result = await tools.set_launch_mode.execute({ process_name: 'TD', mode: 'always' }, { toolCallId: 'c' });

    expect(result).toMatchObject({ error: 'launch_change_needs_approval' });
    expect(store[PENDING]).toBeUndefined();
  });

  it.each([
    ['update_process', { process_name: 'TD', name: 'renamed' }],
    ['set_talon_enabled', { talon_id: 't1', enabled: false }],
  ] as Array<[string, Record<string, unknown>]>)('%s %j still runs', async (name, input) => {
    const { db } = fakeDb({ [CONFIG]: TD });
    const tools = toolsFor(db, name, {});

    const result = await tools[name].execute(input, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ['read_file', { path: 'x' }],
    ['list_directory', { path: 'x' }],
    ['reboot_machine', {}],
    ['shutdown_machine', {}],
  ] as Array<[string, Record<string, unknown>]>)("%s is still the site setting's to decide", async (name, input) => {
    const { db } = fakeDb();
    const on = toolsFor(db, name, { requireTier3Approval: true, ...approvable });
    const off = toolsFor(db, name, { requireTier3Approval: false, ...approvable });

    expect(await on[name].needsApproval(input, asked)).toBe(true);
    expect(await off[name].needsApproval(input, asked)).toBe(false);
  });
});

describe('an approval is bound to what the card showed', () => {
  const input = { process_name: 'TD', mode: 'always' };

  it('records the tool, the machines and a hash of the input when it asks', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);

    await tools.set_launch_mode.needsApproval(input, asked);

    expect(store['chats/chat-1/approvalRequests/call_1']).toMatchObject({
      toolName: 'set_launch_mode',
      machineIds: [MACHINE],
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('runs the call the card showed', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);

    await approveAndRun(db, tools, 'set_launch_mode', input);

    expect(Object.values(store[PENDING])[0]).toMatchObject({ type: 'set_launch_mode', mode: 'always' });
  }, 10_000);

  it('refuses altered input', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);
    await tools.set_launch_mode.needsApproval(input, asked);
    await claim(db);

    const result = await tools.set_launch_mode.execute({ ...input, mode: 'scheduled' }, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'approval_does_not_match', status: 403 });
    expect(store[PENDING]).toBeUndefined();
  });

  it('refuses a card asked for another tool', async () => {
    const { db, store } = fakeDb();
    await toolsFor(db, 'set_launch_mode', approvable).set_launch_mode.needsApproval(input, asked);
    await claim(db);

    const result = await toolsFor(db, 'delete_process', approvable).delete_process.execute(
      { process_name: 'TD' },
      { toolCallId: 'call_1' },
    );

    expect(result).toMatchObject({ error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
    expect(mockDeleteProcess).not.toHaveBeenCalled();
  });

  it('refuses a machine the card did not name, and allows one that dropped off', async () => {
    const { db, store } = fakeDb();
    const both = { ...input, machines: ['m1', 'm2'] };
    await toolsFor(db, 'set_launch_mode', approvable, true, ['m1', 'm2']).set_launch_mode.needsApproval(both, asked);
    await claim(db);
    // the resumed turn: m2 went offline while the card waited, and m3 came online
    const resumed = toolsFor(db, 'set_launch_mode', { ...approvable, incomingToolCallIds: ['call_1'] }, true, ['m1', 'm3']);

    const elsewhere = await resumed.set_launch_mode.execute({ ...input, machines: ['m3'] }, { toolCallId: 'call_1' });
    expect(elsewhere).toMatchObject({ error: 'approval_does_not_match' });
    expect(store['sites/s1/machines/m3/commands/pending']).toBeUndefined();

    await resumed.set_launch_mode.execute(both, { toolCallId: 'call_1' });
    expect(store[PENDING]).toBeDefined();
    expect(store['sites/s1/machines/m3/commands/pending']).toBeUndefined();
  }, 10_000);

  it('refuses a call no card was ever issued for', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);

    const result = await tools.set_launch_mode.execute(input, { toolCallId: 'never_asked' });

    expect(result).toMatchObject({ error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
  });

  it('a resumed call never rewrites what the card recorded', async () => {
    const { db, store } = fakeDb();
    await toolsFor(db, 'set_launch_mode', approvable).set_launch_mode.needsApproval(input, asked);
    const recorded = { ...store['chats/chat-1/approvalRequests/call_1'] };

    const resumed = toolsFor(db, 'set_launch_mode', { ...approvable, incomingToolCallIds: ['call_1'] });
    expect(await resumed.set_launch_mode.needsApproval({ ...input, mode: 'scheduled' }, asked)).toBe(true);

    expect(store['chats/chat-1/approvalRequests/call_1']).toEqual(recorded);
  });

  it('a call id that arrived in the messages never gets a record, and so never runs', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', { ...approvable, incomingToolCallIds: ['never_issued'] });
    const forged = { toolCallId: 'never_issued', messages: [] };

    await tools.set_launch_mode.needsApproval(input, forged);
    await claim(db, TURN, 'never_issued');
    const result = await tools.set_launch_mode.execute(input, { toolCallId: 'never_issued' });

    expect(store['chats/chat-1/approvalRequests/never_issued']).toBeUndefined();
    expect(result).toMatchObject({ error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
  });

  it('needs this turn to hold the claim', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);
    await tools.set_launch_mode.needsApproval(input, asked);

    const unclaimed = await tools.set_launch_mode.execute(input, { toolCallId: 'call_1' });
    await claim(db, 'another-turn');
    const othersClaim = await tools.set_launch_mode.execute(input, { toolCallId: 'call_1' });

    expect(unclaimed).toMatchObject({ error: 'approval_does_not_match' });
    expect(othersClaim).toMatchObject({ error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
  });

  it('tells two inputs apart when one has an own __proto__ key', () => {
    const plain = { process_name: 'P', mode: 'off' };
    const smuggled = JSON.parse('{"process_name":"P","mode":"off","__proto__":{"mode":"always"}}');

    expect(toolCallHash('set_launch_mode', plain)).not.toEqual(toolCallHash('set_launch_mode', smuggled));
    expect(toolCallHash('x', { a: 1 })).not.toEqual(toolCallHash('x', [['a', 1]] as unknown as Record<string, unknown>));
    expect(toolCallHash('x', { a: 1, b: 2 })).toEqual(toolCallHash('x', { b: 2, a: 1 }));
    const nested = { a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } };
    expect(toolCallHash('x', nested)).toEqual(toolCallHash('x', { b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }));
    expect(toolCallHash('x', nested)).not.toEqual(toolCallHash('x', { a: 1, b: { c: 2, d: [{ e: 4, f: 5 }, 3] } }));
  });

  it('binds a tier-3 card the same way', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'execute_script', { requireTier3Approval: true, ...approvable });
    await tools.execute_script.needsApproval({ script: 'sfc /scannow' }, asked);
    await claim(db);

    const result = await tools.execute_script.execute({ script: 'calc.exe' }, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
  });

  it('a card that could not be recorded runs nothing', async () => {
    const { db, store, failNextWrites } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);
    failNextWrites();
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await tools.set_launch_mode.needsApproval(input, asked)).toBe(false);
    const result = await tools.set_launch_mode.execute(input, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
    errorLog.mockRestore();
  });
});

describe('an approval has 24 hours', () => {
  const input = { process_name: 'TD', mode: 'always' };
  const HOUR = 60 * 60 * 1000;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function answeredAfter(hours: number) {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);
    await tools.set_launch_mode.needsApproval(input, asked);
    await claim(db);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + hours * HOUR);
    return { result: await tools.set_launch_mode.execute(input, { toolCallId: 'call_1' }), store };
  }

  it('runs a day-old card just inside it', async () => {
    const { store } = await answeredAfter(23);

    expect(store[PENDING]).toBeDefined();
  }, 10_000);

  it.each([25, 400 * 24])('refuses a card answered %d hours late', async (hours) => {
    const { result, store } = await answeredAfter(hours);

    expect(result).toMatchObject({ ok: false, error: 'approval_does_not_match' });
    expect(store[PENDING]).toBeUndefined();
  });

  it('refuses a record with no expiry', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);
    await tools.set_launch_mode.needsApproval(input, asked);
    await claim(db);
    delete store['chats/chat-1/approvalRequests/call_1'].expiresAt;

    expect(await tools.set_launch_mode.execute(input, { toolCallId: 'call_1' })).toMatchObject({
      error: 'approval_does_not_match',
    });
  });

  it('reads the Timestamp firestore hands back', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', approvable);
    await tools.set_launch_mode.needsApproval(input, asked);
    await claim(db);
    store['chats/chat-1/approvalRequests/call_1'].expiresAt = { toMillis: () => Date.now() - 1 };

    expect(await tools.set_launch_mode.execute(input, { toolCallId: 'call_1' })).toMatchObject({
      error: 'approval_does_not_match',
    });
  });
});

describe('what no approval opens in the registry', () => {
  it.each([
    ['read', WINLOGON, undefined],
    ['read', WINLOGON, 'DefaultPassword'],
    ['read', ` ${WINLOGON}`, 'DefaultPassword'],
    ['read', `${WINLOGON}\\`, 'defaultpassword'],
    ['write', WINLOGON, 'Shell'],
    ['write', WINLOGON, 'Userinit'],
    ['write', `${WINLOGON}\\Notify`, 'DllName'],
    ['write', 'SYSTEM\\CurrentControlSet\\Services\\Spooler', 'ImagePath'],
    ['write', 'SYSTEM\\CurrentControlSet\\Services\\Spooler\\Parameters', 'ServiceDll'],
    ['delete', 'system\\currentcontrolset\\services\\spooler', 'FailureCommand'],
  ])('%s %s %s is refused before a fielded agent can see it, card or no card', async (action, key_path, value_name) => {
    const { db, store } = fakeDb();
    const input = { action, hive: 'HKLM', key_path, value_name };
    const tools = toolsFor(db, 'registry_operation', approvable);
    await tools.registry_operation.needsApproval(input, asked);

    const result = await tools.registry_operation.execute(input, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'registry_value_refused', status: 403 });
    expect(store[PENDING]).toBeUndefined();
  });

  it('auto-login still reaches the agent, once approved', async () => {
    const { db, store } = fakeDb();
    const tools = toolsFor(db, 'registry_operation', approvable);

    await approveAndRun(db, tools, 'registry_operation', {
      action: 'write',
      hive: 'HKLM',
      key_path: WINLOGON,
      value_name: 'AutoAdminLogon',
      value_data: '1',
    });

    expect(Object.keys(store[PENDING])).toHaveLength(1);
  }, 10_000);
});

describe('one audit row per command a chat tool queues', () => {
  it('names the tool and hashes the call, and carries no value', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'manage_process', {});

    await tools.manage_process.execute(
      { name_pattern: 'notepad-secret-pattern.exe', action: 'kill' },
      { toolCallId: 'c' },
    );

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const row = mockEmitMutation.mock.calls[0][0];
    expect(row).toMatchObject({
      kind: 'machine_command_dispatched',
      siteId: SITE,
      actor: 'cortex:user_uid_alice',
      targetId: expect.stringContaining('manage_process'),
      attributes: {
        commandType: 'manage_process',
        machineId: MACHINE,
        paramNames: ['name_pattern', 'action'],
        paramsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(row)).not.toContain('notepad-secret-pattern');
  }, 10_000);

  it('writes one per machine on a fan-out', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'restart_process', {}, true, ['m1', 'm2']);

    await tools.restart_process.execute({ process_name: 'TD', machines: ['m1', 'm2'] }, { toolCallId: 'c' });

    expect(mockEmitMutation.mock.calls.map(([row]) => row.attributes.machineId).sort()).toEqual(['m1', 'm2']);
  }, 10_000);

  it('writes none when the queue write fails, because nothing was dispatched', async () => {
    const { db, failNextWrites } = fakeDb();
    const tools = toolsFor(db, 'restart_process', {});
    failNextWrites();

    await expect(tools.restart_process.execute({ process_name: 'TD' }, { toolCallId: 'c' })).rejects.toThrow();

    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('writes none for a deployment that was refused before anything was queued', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'deploy_software', approvable);

    const result = await approveAndRun(db, tools, 'deploy_software', { software_name: 'Nothing' });

    expect(result).toMatchObject({ error: expect.stringContaining('No installer URL') });
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('writes one per machine for a deployment that started', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'deploy_software', approvable, true, ['m1', 'm2']);

    await approveAndRun(db, tools, 'deploy_software', {
      software_name: 'Player',
      installer_url: 'https://x/p.exe',
      silent_flags: '/S',
      machines: ['m1', 'm2'],
    });

    expect(mockEmitMutation.mock.calls.map(([row]) => row.attributes.machineId).sort()).toEqual(['m1', 'm2']);
  });

  it('a read on the web server queues nothing, so it writes none', async () => {
    const { db } = fakeDb({ [CONFIG]: TD });
    const tools = toolsFor(db, 'update_process', {});

    await tools.update_process.execute({ process_name: 'missing', name: 'x' }, { toolCallId: 'c' });

    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('the hash on an audit row', () => {
  it('is keyed, so a low-entropy value can not be tried against it', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'manage_process', {});
    const params = { name_pattern: '4821', action: 'kill' };

    await tools.manage_process.execute(params, { toolCallId: 'c' });

    const { paramsHash } = mockEmitMutation.mock.calls[0][0].attributes;
    expect(paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsHash).not.toEqual(toolCallHash('manage_process', params));
  }, 10_000);

  it('is left out with no key, and the rest of the row stands', async () => {
    delete process.env.CORTEX_INTERNAL_SECRET;
    const { db } = fakeDb();
    const tools = toolsFor(db, 'manage_process', {});

    await tools.manage_process.execute({ name_pattern: '4821', action: 'kill' }, { toolCallId: 'c' });

    const { attributes } = mockEmitMutation.mock.calls[0][0];
    expect(attributes.paramsHash).toBeNull();
    expect(attributes.commandType).toBe('manage_process');
    expect(JSON.stringify(attributes)).not.toContain('4821');
  }, 10_000);

  it('the blocking row is keyed the same way', async () => {
    const { db } = fakeDb({ [CONFIG]: TD });
    const params = { process_name: 'TD', exe_path: 'C:\\new.exe' };
    const tools = toolsFor(db, 'update_process', approvable);

    await approveAndRun(db, tools, 'update_process', params);

    const { paramsHash } = mockAuditBlocking.mock.calls[0][1].metadata;
    expect(paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsHash).not.toEqual(toolCallHash('update_process', params));
  });
});

describe('the blocking audit row of an approved launch change', () => {
  it('records old and new values before anything changes', async () => {
    const { db } = fakeDb({ [CONFIG]: TD });
    const tools = toolsFor(db, 'update_process', approvable);
    mockAuditBlocking.mockImplementation(async () => {
      expect(mockUpdateProcess).not.toHaveBeenCalled();
    });

    await approveAndRun(db, tools, 'update_process', { process_name: 'TD', exe_path: 'C:\\new.exe' });

    expect(mockAuditBlocking).toHaveBeenCalledTimes(1);
    const [siteId, entry] = mockAuditBlocking.mock.calls[0];
    expect(siteId).toBe(SITE);
    expect(entry).toMatchObject({
      actor: { type: 'user', userId: 'uid_alice' },
      outcome: 'allow',
      target: { kind: 'machine', id: MACHINE, machineId: MACHINE },
      metadata: {
        toolName: 'update_process',
        toolCallId: 'call_1',
        chatId: 'chat-1',
        paramsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        launchChanges: { exe_path: { from: 'C:\\old.exe', to: 'C:\\new.exe' } },
      },
    });
    expect(mockUpdateProcess).toHaveBeenCalled();
  });

  it.each([
    ['update_process', { process_name: 'TD', exe_path: 'C:\\new.exe' }],
    ['set_launch_mode', { process_name: 'TD', mode: 'always' }],
    ['add_process', { name: 'x', exe_path: 'C:\\x.exe' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'a launch change that cannot be recorded does not run: %s',
    async (name, input) => {
      const { db, store } = fakeDb({ [CONFIG]: TD });
      mockAuditBlocking.mockRejectedValue(new Error('firestore down'));
      const tools = toolsFor(db, name, approvable);

      const result = await approveAndRun(db, tools, name, input);

      expect(result).toMatchObject({ ok: false, error: 'audit_unavailable', status: 503 });
      expectNothingReachedTheMachine(store);
    },
  );

  it('records old and new launch mode, one row per machine', async () => {
    const { db } = fakeDb({ [CONFIG]: TD, 'config/s1/machines/m2': TD });
    const tools = toolsFor(db, 'set_launch_mode', approvable, true, [MACHINE, 'm2']);

    await approveAndRun(db, tools, 'set_launch_mode', { process_name: 'TD', mode: 'always', machines: [MACHINE, 'm2'] });

    expect(mockAuditBlocking).toHaveBeenCalledTimes(2);
    expect(mockAuditBlocking.mock.calls[0][1].metadata.launchChanges).toEqual({
      launch_mode: { from: 'off', to: 'always' },
    });
  }, 10_000);

  it('files a talon against the site', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'set_talon_enabled', approvable);

    await approveAndRun(db, tools, 'set_talon_enabled', { talon_id: 't1', enabled: true });

    expect(mockAuditBlocking.mock.calls[0][1].target).toEqual({ kind: 'site', id: SITE });
  });

  it('writes no row for a refused call', async () => {
    const { db } = fakeDb();
    const tools = toolsFor(db, 'set_launch_mode', {});

    await tools.set_launch_mode.execute({ process_name: 'TD', mode: 'always' }, { toolCallId: 'c' });

    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mockAuditBlocking).not.toHaveBeenCalled();
  });
});
