/** @jest-environment node */

/** Tests for hoot-utils.server.ts — the tool execution relay: executeToolOnAgent,
 *  executeExistingCommand, buildExecutableTools. */

// Mocks

jest.mock('ai', () => ({
  tool: jest.fn((opts: unknown) => opts),
  jsonSchema: jest.fn((s: unknown) => s),
}));

jest.mock('@/lib/llm-encryption.server', () => ({
  decryptApiKey: jest.fn((v: string) => v),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: jest.fn(() => '__FIELD_DELETE__') },
}));

const mockCreateProcess = jest.fn();
const mockUpdateProcess = jest.fn();
const mockDeleteProcess = jest.fn();

jest.mock('@/lib/actions/createProcess.server', () => {
  class ActionInputError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ActionInputError,
    createProcess: (...args: unknown[]) => mockCreateProcess(...args),
  };
});

jest.mock('@/lib/actions/updateProcess.server', () => ({
  updateProcess: (...args: unknown[]) => mockUpdateProcess(...args),
}));

jest.mock('@/lib/actions/deleteProcess.server', () => ({
  deleteProcess: (...args: unknown[]) => mockDeleteProcess(...args),
}));

jest.mock('@/lib/processConfig.server', () => {
  class ProcessConfigError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { ProcessConfigError };
});

// The follow-up store has its own suite (and its own transaction semantics);
// here it is a boundary, so the tool layer's arithmetic and validation are what
// gets asserted.
const mockScheduleFollowup = jest.fn();
const mockCancelFollowup = jest.fn();

jest.mock('@/lib/hoot/followupStore.server', () => ({
  scheduleFollowup: (...args: unknown[]) => mockScheduleFollowup(...args),
  cancelFollowup: (...args: unknown[]) => mockCancelFollowup(...args),
}));

// Mock Firestore
// Path: sites/{s}/machines/{m}/commands/pending|completed

function createMockDb() {
  const completedDoc = {
    get: jest.fn(async () => ({ exists: false, data: () => ({}) })),
    update: jest.fn(async () => {}),
  };

  const pendingDoc = {
    set: jest.fn<Promise<void>, [data: Record<string, unknown>, options?: unknown]>(async () => {}),
    update: jest.fn<Promise<void>, [data: Record<string, unknown>]>(async () => {}),
  };

  function buildDoc(): Record<string, unknown> {
    return {
      get: jest.fn(),
      set: jest.fn(),
      update: jest.fn(),
      collection: jest.fn((name: string) => {
        if (name === 'commands') {
          return {
            doc: jest.fn((docId: string) => {
              if (docId === 'pending') return pendingDoc;
              if (docId === 'completed') return completedDoc;
              return buildDoc();
            }),
          };
        }
        return { doc: jest.fn(() => buildDoc()) };
      }),
    };
  }

  return {
    db: { collection: jest.fn(() => ({ doc: jest.fn(() => buildDoc()) })) } as unknown as FirebaseFirestore.Firestore,
    pendingDoc,
    completedDoc,
  };
}

/** Extract the first command ID written to pendingDoc.set */
function getCommandId(pendingDoc: { set: jest.Mock }): string {
  const firstCallArg = pendingDoc.set.mock.calls[0]?.[0] || {};
  return Object.keys(firstCallArg)[0] || '';
}

function createProcessConfigDb(processes: unknown[]) {
  const configDoc = {
    get: jest.fn(async () => ({
      exists: true,
      data: () => ({ processes }),
    })),
  };

  const db = {
    collection: jest.fn((collectionName: string) => {
      if (collectionName !== 'config') {
        return { doc: jest.fn(() => ({ collection: jest.fn() })) };
      }
      return {
        doc: jest.fn(() => ({
          collection: jest.fn(() => ({
            doc: jest.fn(() => configDoc),
          })),
        })),
      };
    }),
  } as unknown as FirebaseFirestore.Firestore;

  return { db, configDoc };
}

/** One machine document under `sites/{siteId}/machines`, as stored. */
type MachineFixture = {
  id: string;
  online?: unknown;
  cortexEnabled?: unknown;
  machine_timezone_iana?: unknown;
};

/**
 * A db whose only readable path is `sites/{siteId}/machines`, counting the
 * collection reads — resolving a set is specified to cost exactly one.
 */
function createSiteMachinesDb(machines: MachineFixture[]) {
  const machinesGet = jest.fn(async () => ({
    docs: machines.map(({ id, ...data }) => ({ id, data: () => data })),
  }));

  const db = {
    collection: jest.fn((name: string) => {
      if (name !== 'sites') throw new Error(`unexpected collection: ${name}`);
      return {
        doc: jest.fn(() => ({
          collection: jest.fn((child: string) => {
            if (child !== 'machines') throw new Error(`unexpected subcollection: ${child}`);
            return { get: machinesGet };
          }),
        })),
      };
    }),
  } as unknown as FirebaseFirestore.Firestore;

  return { db, machinesGet };
}

import {
  executeToolOnAgent,
  executeExistingCommand,
  executeServerSideTool,
  buildExecutableTools,
  listSiteMachines,
  resolveHootTargets,
  assertLlmKeyAvailable,
  resolveLlmConfig,
  resolveSiteKeyOwner,
  SiteAccessError,
  verifyUserSiteAccess,
  resolveHootMaxTier,
  getHootRequireTier3Approval,
  COMMAND_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_SECONDS,
  MAX_FOLLOWUP_DELAY_MINUTES,
  MAX_FOLLOWUP_NOTE_LENGTH,
  type BuildExecutableToolsOptions,
} from '@/lib/hoot-utils.server';

import { allTools } from '@/lib/mcp-tools';
import { decryptApiKey } from '@/lib/llm-encryption.server';
import { MAX_TARGET_MACHINES } from '@/lib/hoot/target';

beforeEach(() => {
  mockCreateProcess.mockReset();
  mockUpdateProcess.mockReset();
  mockDeleteProcess.mockReset();
  mockScheduleFollowup.mockReset();
  mockCancelFollowup.mockReset();
});

// only the server grants an active-hours override, from a typed option; model
// input can never carry one onto a command.
const OVERRIDE_NAMES = ['activeHoursOverride', 'active_hours_override', 'override_active_hours', 'override_reason'];
const overrideBag = () => ({
  activeHoursOverride: { reason: 'show is over', approvedBy: 'user:attacker' },
  active_hours_override: { reason: 'show is over' },
  override_active_hours: true,
  override_reason: 'show is over',
});

// executeToolOnAgent

describe('executeToolOnAgent', () => {
  beforeEach(() => jest.useRealTimers());

  it('writes mcp_tool_call to pending and returns result', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({
          [cmdId]: { status: 'success', result: { hostname: 'test-box' } },
        }),
      };
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'get_system_info', {}, 'chat1');

    expect(pendingDoc.set).toHaveBeenCalledTimes(1);
    const written = pendingDoc.set.mock.calls[0][0];
    const cmdId = Object.keys(written)[0];
    expect(cmdId).toMatch(/^mcp_/);
    expect(written[cmdId]).toMatchObject({
      type: 'mcp_tool_call',
      tool_name: 'get_system_info',
      tool_params: {},
      chat_id: 'chat1',
      status: 'pending',
    });

    expect(result).toMatchObject({ hostname: 'test-box' });
  });

  it('returns error when tool execution fails', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({
          [cmdId]: { status: 'failed', error: 'Process query timed out' },
        }),
      };
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'get_running_processes', { limit: 50 }, 'c1');
    expect(result).toEqual({ error: 'Process query timed out' });
  });

  it('returns timeout error when agent never responds', async () => {
    const { db, completedDoc } = createMockDb();

    completedDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });

    // Fast-forward through the poll loop by mocking Date.now
    const realNow = Date.now();
    let tick = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      // Each call advances past the timeout
      return realNow + (tick++ * COMMAND_TIMEOUT_MS);
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'get_system_info', {}, 'c1');

    expect(result).toMatchObject({ error: expect.stringContaining('timed out') });
    jest.restoreAllMocks();
  });

  it('passes tool_params through to the command', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    await executeToolOnAgent(db, 's1', 'm1', 'get_running_processes', { name_filter: 'chrome', limit: 10 }, 'c1');

    const written = pendingDoc.set.mock.calls[0][0] as Record<string, { tool_params: Record<string, unknown> }>;
    const cmdId = Object.keys(written)[0];
    expect(written[cmdId].tool_params).toEqual({ name_filter: 'chrome', limit: 10 });
  });

  it('strips every active-hours override name from tool_params', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    await executeToolOnAgent(
      db, 's1', 'm1', 'manage_windows_update',
      { ...overrideBag(), action: 'set_active_hours', start_hour: 9 }, 'c1',
    );

    const written = pendingDoc.set.mock.calls[0][0] as Record<string, Record<string, unknown>>;
    const entry = written[Object.keys(written)[0]];
    for (const name of OVERRIDE_NAMES) expect(entry).not.toHaveProperty(name);
    expect(entry.tool_params).toEqual({ action: 'set_active_hours', start_hour: 9 });
  }, 15000);

  it('fires onCommandQueued synchronously after the pending write with the written commandId', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    const observed: { commandId: string; pendingWrites: number; polls: number }[] = [];
    const onCommandQueued = jest.fn((commandId: string) => {
      observed.push({
        commandId,
        pendingWrites: pendingDoc.set.mock.calls.length,
        polls: completedDoc.get.mock.calls.length,
      });
    });

    await executeToolOnAgent(db, 's1', 'm1', 'get_system_info', {}, 'c1', { onCommandQueued });

    expect(onCommandQueued).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([
      // Fired with the id that was just written, after the write, before any poll.
      { commandId: getCommandId(pendingDoc), pendingWrites: 1, polls: 0 },
    ]);
  }, 15000);

  it('clamps timeout_seconds to MAX_TOOL_TIMEOUT_SECONDS in the pending command', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    await executeToolOnAgent(db, 's1', 'm1', 'execute_script', { script: 'x', timeout_seconds: 90000 }, 'c1');

    const written = pendingDoc.set.mock.calls[0][0] as Record<
      string,
      { timeout_seconds: number; tool_params: Record<string, unknown> }
    >;
    const cmdId = Object.keys(written)[0];
    expect(written[cmdId].timeout_seconds).toBe(MAX_TOOL_TIMEOUT_SECONDS);
    // tool_params pass through unmodified — the agent applies its own clamp
    // (agent/src/mcp_tools.py MAX_SCRIPT_TIMEOUT).
    expect(written[cmdId].tool_params).toEqual({ script: 'x', timeout_seconds: 90000 });
  }, 15000);

  it('passes timeout_seconds through unclamped when below the cap', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    await executeToolOnAgent(db, 's1', 'm1', 'execute_script', { script: 'x', timeout_seconds: 600 }, 'c1');

    const written = pendingDoc.set.mock.calls[0][0] as Record<string, { timeout_seconds: number }>;
    const cmdId = Object.keys(written)[0];
    expect(written[cmdId].timeout_seconds).toBe(600);
  }, 15000);

  it('surfaces a cancelled entry as an error instead of falling through to undefined', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    // A user cancel (cancel-tool → agent) writes a terminal `cancelled` entry.
    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({ [cmdId]: { status: 'cancelled', error: 'cancelled by user' } }),
      };
    });

    const result = await executeToolOnAgent(db, 's1', 'm1', 'execute_script', { script: 'x' }, 'c1');

    expect(result).toEqual({ error: 'cancelled by user' });
    // The terminal cancelled entry is consumed like any other terminal write.
    expect(completedDoc.update).toHaveBeenCalledTimes(1);
  }, 15000);

  it('unwinds promptly with a cancelled result when the abort signal fires', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();
    // Agent never answers — without the abort we would poll to timeout.
    completedDoc.get.mockResolvedValue({ exists: false, data: () => ({}) });

    const controller = new AbortController();
    controller.abort();

    const result = await executeToolOnAgent(
      db, 's1', 'm1', 'execute_script', { script: 'x' }, 'c1',
      { abortSignal: controller.signal },
    );

    expect(result).toEqual({ error: 'cancelled by user' });
    // The pending command is dropped best-effort so the agent can skip it.
    expect(pendingDoc.update).toHaveBeenCalledWith({ [getCommandId(pendingDoc)]: '__FIELD_DELETE__' });
  }, 15000);

  it('skips running-status entries (non-terminal, not deleted) and resolves on the terminal write', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    // Agent contract (agent/src/firebase_client.py _mark_command_running):
    // the completed doc holds {status:'running'} while the command executes,
    // then the terminal write overwrites it.
    let polls = 0;
    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      polls++;
      if (polls < 2) {
        return { exists: true, data: () => ({ [cmdId]: { status: 'running', startedAt: 123 } }) };
      }
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: { ok: true } } }) };
    });

    const onPollTick = jest.fn();
    const result = await executeToolOnAgent(db, 's1', 'm1', 'execute_script', { script: 'x' }, 'c1', { onPollTick });

    expect(result).toMatchObject({ ok: true });
    // The running marker was never deleted — only the terminal entry was.
    expect(completedDoc.update).toHaveBeenCalledTimes(1);
    expect(completedDoc.update).toHaveBeenCalledWith({ [getCommandId(pendingDoc)]: '__FIELD_DELETE__' });
    // One tick per poll iteration (running poll + terminal poll).
    expect(onPollTick).toHaveBeenCalledTimes(2);
  }, 15000);
});

// executeExistingCommand

describe('executeExistingCommand', () => {
  it('writes legacy command and returns result', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return {
        exists: true,
        data: () => ({ [cmdId]: { status: 'success', result: 'Process restarted' } }),
      };
    });

    const result = await executeExistingCommand(db, 's1', 'm1', 'restart_process', 'MyApp.exe');

    const written = pendingDoc.set.mock.calls[0][0];
    const cmdId = Object.keys(written)[0];
    expect(cmdId).toMatch(/^restart_process_/);
    expect(written[cmdId]).toMatchObject({
      type: 'restart_process',
      process_name: 'MyApp.exe',
      status: 'pending',
    });

    expect(result).toMatchObject({ status: 'success' });
  });

  it('fires onCommandQueued with the written commandId and skips running-status entries', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    let polls = 0;
    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      polls++;
      if (polls < 2) {
        return { exists: true, data: () => ({ [cmdId]: { status: 'running', startedAt: 123 } }) };
      }
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: 'Process restarted' } }) };
    });

    const onCommandQueued = jest.fn();
    const onPollTick = jest.fn();
    const result = await executeExistingCommand(
      db, 's1', 'm1', 'restart_process', 'MyApp.exe', {}, { onCommandQueued, onPollTick },
    );

    expect(onCommandQueued).toHaveBeenCalledTimes(1);
    expect(onCommandQueued).toHaveBeenCalledWith(getCommandId(pendingDoc));
    // Running marker skipped without deletion; only the terminal entry deleted.
    expect(completedDoc.update).toHaveBeenCalledTimes(1);
    expect(onPollTick).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'success' });
  }, 15000);

  it('strips every active-hours override name from the spread params', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: 'rebooting' } }) };
    });

    await executeExistingCommand(
      db, 's1', 'm1', 'reboot_machine', '',
      { ...overrideBag(), when: 'after_active_hours' },
    );

    const written = pendingDoc.set.mock.calls[0][0] as Record<string, Record<string, unknown>>;
    const entry = written[Object.keys(written)[0]];
    for (const name of OVERRIDE_NAMES) expect(entry).not.toHaveProperty(name);
    // deferral is not privileged, so it is not reserved.
    expect(entry).toMatchObject({ type: 'reboot_machine', when: 'after_active_hours' });
  }, 15000);
});

describe('deploy_software', () => {
  /** Records every doc write by path; the preset collection is empty. */
  function createDeployDb() {
    const writes: { path: string; data: Record<string, unknown> }[] = [];
    const doc = (path: string): unknown => ({
      set: jest.fn(async (data: Record<string, unknown>) => {
        writes.push({ path, data });
      }),
      collection: (name: string) => col(`${path}/${name}`),
    });
    const col = (path: string): unknown => ({
      doc: (id: string) => doc(`${path}/${id}`),
      get: jest.fn(async () => ({ docs: [] })),
    });
    return { db: { collection: (name: string) => col(name) } as unknown as FirebaseFirestore.Firestore, writes };
  }

  it('builds install_software from explicit fields, so no override name reaches the command', async () => {
    const { db, writes } = createDeployDb();

    const result = await executeServerSideTool(db, 's1', ['m1'], 'deploy_software', {
      ...overrideBag(),
      software_name: 'Player',
      installer_url: 'https://example.com/player.exe',
      silent_flags: '/S',
    }, {});

    expect(result).toMatchObject({ status: 'deployment_started' });
    const pending = writes.find((w) => w.path === 'sites/s1/machines/m1/commands/pending')!;
    const command = Object.values(pending.data)[0] as Record<string, unknown>;
    expect(command.type).toBe('install_software');
    for (const write of writes) {
      for (const name of OVERRIDE_NAMES) expect(write.data).not.toHaveProperty(name);
    }
    for (const name of OVERRIDE_NAMES) expect(command).not.toHaveProperty(name);
  });
});

// buildExecutableTools

// listSiteMachines / resolveHootTargets

describe('listSiteMachines', () => {
  it('reads the site once and reports both dispatch facts per machine', async () => {
    const { db, machinesGet } = createSiteMachinesDb([
      { id: 'kiosk-01', online: true, cortexEnabled: true },
      { id: 'kiosk-02', online: false, cortexEnabled: false },
      // Absent `cortexEnabled` is enabled — machines that predate the kill
      // switch must keep receiving tool calls (mirrors isHootEnabled).
      { id: 'kiosk-03', online: true },
      // Absent `online` is offline: a machine doc that has never reported in is
      // not a dispatch target.
      { id: 'kiosk-04' },
    ]);

    await expect(listSiteMachines(db, 's1')).resolves.toEqual([
      { id: 'kiosk-01', online: true, hootEnabled: true },
      { id: 'kiosk-02', online: false, hootEnabled: false },
      { id: 'kiosk-03', online: true, hootEnabled: true },
      { id: 'kiosk-04', online: false, hootEnabled: true },
    ]);
    expect(machinesGet).toHaveBeenCalledTimes(1);
  });

  it('reports an empty site as no machines', async () => {
    const { db } = createSiteMachinesDb([]);
    await expect(listSiteMachines(db, 's1')).resolves.toEqual([]);
  });

  it("carries each machine's reported timezone, so a turn's prompt costs no extra read", async () => {
    const { db } = createSiteMachinesDb([
      { id: 'kiosk-01', online: true, machine_timezone_iana: 'America/New_York' },
      // agents before 2.6.1 never wrote it; a non-string is not a zone.
      { id: 'kiosk-02', online: true },
      { id: 'kiosk-03', online: true, machine_timezone_iana: 5 },
    ]);

    const [withZone, withoutZone, badZone] = await listSiteMachines(db, 's1');
    expect(withZone.timezone).toBe('America/New_York');
    expect(withoutZone.timezone).toBeUndefined();
    expect(badZone.timezone).toBeUndefined();
  });
});

/**
 * The one place that decides which machines a turn dispatches to. What is pinned
 * here: it never widens (an id the site cannot name is a 400, never a fallback
 * to every machine), it skips offline and hoot-off machines rather than failing
 * (D-A/D-B) until nothing is left, it refuses a machine the user NAMED with `@`,
 * and fan-out follows what was REQUESTED so a one-machine site keeps the single
 * path.
 */
describe('resolveHootTargets', () => {
  const FLEET: MachineFixture[] = [
    { id: 'kiosk-01', online: true, cortexEnabled: true },
    { id: 'kiosk-02', online: true, cortexEnabled: true },
    { id: 'kiosk-03', online: true, cortexEnabled: true },
  ];

  it('resolves "all machines" to every online, hoot-enabled machine', async () => {
    const { db, machinesGet } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', { requested: null });

    expect(result).toEqual({
      ok: true,
      resolved: {
        ids: ['kiosk-01', 'kiosk-02', 'kiosk-03'],
        fanOut: true,
        skipped: { offline: [], disabled: [] },
      },
    });
    // One collection read for the whole set — not two document reads each.
    expect(machinesGet).toHaveBeenCalledTimes(1);
  });

  it('resolves an explicit subset, in the order it was asked for', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', { requested: ['kiosk-03', 'kiosk-01'] });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-03', 'kiosk-01'], fanOut: true } });
  });

  it('keeps a single explicit machine off the fan-out path', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', { requested: ['kiosk-02'] });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-02'], fanOut: false } });
  });

  it('resolves "all machines" on a one-machine site to the single path', async () => {
    // Process context in the prompt, unwrapped tool output, the power toggle and
    // the exact offline copy e2e pins all hang off fanOut.
    const { db } = createSiteMachinesDb([{ id: 'only-01', online: true }]);

    const result = await resolveHootTargets(db, 's1', { requested: null });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['only-01'], fanOut: false } });
  });

  it('dedupes a repeated id instead of dispatching to it twice', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', {
      requested: ['kiosk-01', 'kiosk-01', 'kiosk-02'],
    });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-01', 'kiosk-02'] } });
  });

  it.each([
    ['an unknown machine', ['kiosk-01', 'kiosk-99'], ['kiosk-99']],
    // A foreign machine is simply absent from THIS site's listing.
    ['another site\'s machine', ['lobby-pa-01'], ['lobby-pa-01']],
  ])('refuses %s with 400 and never widens to the site', async (_label, requested, offenders) => {
    const { db } = createSiteMachinesDb(FLEET);

    await expect(resolveHootTargets(db, 's1', { requested })).resolves.toEqual({
      ok: false,
      status: 400,
      reason: 'unknown_machine',
      machineIds: offenders,
    });
  });

  it.each([
    ['a path separator in an id', ['../../sites/other/machines/x']],
    ['an id with a slash', ['kiosk-01/commands']],
    ['a non-string id', [42]],
    ['the site sentinel as an id', ['__site__']],
    ['an empty set', []],
    ['a set past the cap', Array.from({ length: MAX_TARGET_MACHINES + 1 }, (_, i) => `kiosk-${i}`)],
  ])('refuses %s with 400 before reading the site', async (_label, requested) => {
    const { db, machinesGet } = createSiteMachinesDb(FLEET);

    await expect(
      resolveHootTargets(db, 's1', { requested: requested as string[] }),
    ).resolves.toEqual({ ok: false, status: 400, reason: 'invalid_target', machineIds: [] });
    // A malformed id would be a path traversal against sites/{id}/machines.
    expect(machinesGet).not.toHaveBeenCalled();
  });

  it('accepts a set at exactly the cap', async () => {
    const fleet = Array.from({ length: MAX_TARGET_MACHINES }, (_, i) => ({
      id: `kiosk-${i}`,
      online: true,
    }));
    const { db } = createSiteMachinesDb(fleet);

    const result = await resolveHootTargets(db, 's1', { requested: fleet.map((m) => m.id) });

    expect(result).toMatchObject({ ok: true });
    expect((result as { resolved: { ids: string[] } }).resolved.ids).toHaveLength(
      MAX_TARGET_MACHINES,
    );
  });

  it('skips an offline machine and reports it, rather than failing the turn', async () => {
    const { db } = createSiteMachinesDb([
      { id: 'kiosk-01', online: true },
      { id: 'kiosk-02', online: false },
    ]);

    const result = await resolveHootTargets(db, 's1', { requested: ['kiosk-01', 'kiosk-02'] });

    expect(result).toEqual({
      ok: true,
      resolved: {
        ids: ['kiosk-01'],
        // Two machines were asked for, so the turn still reports per machine.
        fanOut: true,
        skipped: { offline: ['kiosk-02'], disabled: [] },
      },
    });
  });

  it('skips a hoot-off machine inside "all machines" (D-A)', async () => {
    // The kill switch used to be honoured only on single-machine turns, so a
    // site-wide chat queued commands on a machine whose owner had turned hoot off.
    const { db } = createSiteMachinesDb([
      { id: 'kiosk-01', online: true },
      { id: 'kiosk-02', online: true, cortexEnabled: false },
    ]);

    const result = await resolveHootTargets(db, 's1', { requested: null });

    expect(result).toEqual({
      ok: true,
      resolved: {
        ids: ['kiosk-01'],
        fanOut: true,
        skipped: { offline: [], disabled: ['kiosk-02'] },
      },
    });
  });

  it('refuses with 503 when every requested machine is offline', async () => {
    const { db } = createSiteMachinesDb([
      { id: 'kiosk-01', online: false },
      { id: 'kiosk-02', online: false },
    ]);

    await expect(resolveHootTargets(db, 's1', { requested: null })).resolves.toEqual({
      ok: false,
      status: 503,
      reason: 'machine_offline',
      machineIds: ['kiosk-01', 'kiosk-02'],
    });
  });

  it('refuses with 423 when the kill switch is the whole reason', async () => {
    const { db } = createSiteMachinesDb([{ id: 'kiosk-01', online: true, cortexEnabled: false }]);

    await expect(resolveHootTargets(db, 's1', { requested: ['kiosk-01'] })).resolves.toEqual({
      ok: false,
      status: 423,
      reason: 'hoot_disabled',
      machineIds: ['kiosk-01'],
    });
  });

  it('prefers 503 over 423 for a machine that is both offline and hoot-off', async () => {
    // `/api/hoot` has always checked offline before the kill switch, so the
    // single-machine status code must not move.
    const { db } = createSiteMachinesDb([{ id: 'kiosk-01', online: false, cortexEnabled: false }]);

    await expect(resolveHootTargets(db, 's1', { requested: ['kiosk-01'] })).resolves.toMatchObject({
      status: 503,
      reason: 'machine_offline',
    });
  });

  it('refuses with 503 when the site has no machines at all', async () => {
    const { db } = createSiteMachinesDb([]);

    await expect(resolveHootTargets(db, 's1', { requested: null })).resolves.toEqual({
      ok: false,
      status: 503,
      reason: 'no_machines',
      machineIds: [],
    });
  });

  it('narrows a site-wide turn to the mentioned machine', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', {
      requested: null,
      mentions: ['kiosk-02'],
    });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-02'], fanOut: false } });
  });

  it('narrows to a mentioned machine the selection had unticked', async () => {
    // A mention applies to this turn only (D-3); it replaces the selection
    // rather than intersecting with it.
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', {
      requested: ['kiosk-01'],
      mentions: ['kiosk-03'],
    });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-03'] } });
  });

  it('narrows to the union of several mentions', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', {
      requested: null,
      mentions: ['kiosk-03', 'kiosk-01'],
    });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-03', 'kiosk-01'], fanOut: true } });
  });

  it('ignores an empty mention list and keeps the selection', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    const result = await resolveHootTargets(db, 's1', { requested: ['kiosk-01'], mentions: [] });

    expect(result).toMatchObject({ ok: true, resolved: { ids: ['kiosk-01'] } });
  });

  it.each([
    ['offline', { id: 'kiosk-02', online: false }, 503, 'machine_offline'],
    ['hoot-off', { id: 'kiosk-02', online: true, cortexEnabled: false }, 423, 'hoot_disabled'],
  ])(
    'refuses a mentioned machine that is %s instead of silently skipping it',
    async (_label, machine, status, reason) => {
      // The user named this machine, so answering about a different one would be
      // worse than refusing (D-B).
      const { db } = createSiteMachinesDb([{ id: 'kiosk-01', online: true }, machine]);

      await expect(
        resolveHootTargets(db, 's1', { requested: null, mentions: ['kiosk-02'] }),
      ).resolves.toEqual({ ok: false, status, reason, machineIds: ['kiosk-02'] });
    },
  );

  it('refuses an unknown mentioned machine with 400', async () => {
    const { db } = createSiteMachinesDb(FLEET);

    await expect(
      resolveHootTargets(db, 's1', { requested: null, mentions: ['kiosk-99'] }),
    ).resolves.toMatchObject({ status: 400, reason: 'unknown_machine', machineIds: ['kiosk-99'] });
  });

  it('refuses a malformed mention with 400 before reading the site', async () => {
    const { db, machinesGet } = createSiteMachinesDb(FLEET);

    await expect(
      resolveHootTargets(db, 's1', { requested: null, mentions: ['kiosk-01/commands'] }),
    ).resolves.toMatchObject({ status: 400, reason: 'invalid_target' });
    expect(machinesGet).not.toHaveBeenCalled();
  });
});

describe('buildExecutableTools', () => {
  it('creates an executable tool for each definition', () => {
    const tools = buildExecutableTools({} as unknown as FirebaseFirestore.Firestore, 's1', 'm1', 'c1', allTools);

    expect(Object.keys(tools)).toHaveLength(allTools.length);
    for (const def of allTools) {
      expect(tools[def.name]).toBeDefined();
      expect(tools[def.name].description).toBe(def.description);
    }
  });

  it('site mode creates tools for fan-out execution', () => {
    const tools = buildExecutableTools({} as unknown as FirebaseFirestore.Firestore, 's1', '', 'c1', allTools, true, ['m1', 'm2']);
    expect(Object.keys(tools)).toHaveLength(allTools.length);
  });

  it('asks for approval on tier-3 calls and lets tier-1/2 calls run', async () => {
    const tools = buildExecutableTools({} as unknown as FirebaseFirestore.Firestore, 's1', 'm1', 'c1', allTools);
    for (const def of allTools) {
      // A call without an override: the tier alone decides.
      expect(await tools[def.name].needsApproval({}, { toolCallId: 'call_1', messages: [] })).toBe(def.tier >= 3);
    }
    // Sanity: the fixture actually exercises both sides of the gate.
    expect(allTools.some((t) => t.tier >= 3)).toBe(true);
    expect(allTools.some((t) => t.tier < 3)).toBe(true);
  });

  it('disables tier-3 needsApproval when requireTier3Approval is false', async () => {
    // The per-site approval toggle, when off, must drop the gate on this path
    // too (not just local-Hoot routing) — otherwise the toggle lies.
    const tools = buildExecutableTools(
      {} as unknown as FirebaseFirestore.Firestore,
      's1', 'm1', 'c1', allTools, false, [],
      { requireTier3Approval: false },
    );
    for (const def of allTools) {
      expect(await tools[def.name].needsApproval({}, { toolCallId: 'call_1', messages: [] })).toBe(false);
    }
  });

  it('executes update_process server-side and resolves process_name to processId', async () => {
    mockUpdateProcess.mockResolvedValue({ processId: 'proc-1' });
    const { db } = createProcessConfigDb([
      { id: 'proc-1', processId: 'proc-1', name: 'TouchDesigner' },
    ]);
    const toolDef = allTools.find((tool) => tool.name === 'update_process')!;
    const tools = buildExecutableTools(
      db,
      's1',
      'm1',
      'c1',
      [toolDef],
      false,
      [],
      { userId: 'uid_alice', userRole: 'admin' },
    );

    const result = await tools.update_process.execute({
      process_name: 'TouchDesigner',
      launch_mode: 'always',
    });

    expect(result).toEqual({
      ok: true,
      processId: 'proc-1',
      process_name: 'TouchDesigner',
    });
    expect(mockUpdateProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: 's1',
        auditActor: 'cortex:user_uid_alice',
      }),
      {
        machineId: 'm1',
        processId: 'proc-1',
        patch: { launch_mode: 'always' },
      },
    );
  });

  it('returns structured update_process error when process_name is not found', async () => {
    const { db } = createProcessConfigDb([
      { id: 'proc-1', processId: 'proc-1', name: 'TouchDesigner' },
    ]);
    const toolDef = allTools.find((tool) => tool.name === 'update_process')!;
    const tools = buildExecutableTools(db, 's1', 'm1', 'c1', [toolDef]);

    const result = await tools.update_process.execute({
      process_name: 'Missing',
      name: 'Renamed',
    });

    expect(result).toEqual({
      ok: false,
      error: 'process_not_found',
      detail: 'Process "Missing" was not found on machine m1.',
      status: 404,
    });
    expect(mockUpdateProcess).not.toHaveBeenCalled();
  });

  it('bridges toolCallbacks: onCommandQueued receives (toolCallId, commandId, machineId)', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    completedDoc.get.mockImplementation(async () => {
      const cmdId = getCommandId(pendingDoc);
      return { exists: true, data: () => ({ [cmdId]: { status: 'success', result: {} } }) };
    });

    const onCommandQueued = jest.fn();
    const onPollTick = jest.fn();
    const toolDef = allTools.find((tool) => tool.name === 'get_system_info')!;
    const tools = buildExecutableTools(
      db, 's1', 'm1', 'c1', [toolDef], false, [],
      { toolCallbacks: { onCommandQueued, onPollTick } },
    );

    await tools.get_system_info.execute({}, { toolCallId: 'call_abc' });

    expect(onCommandQueued).toHaveBeenCalledTimes(1);
    expect(onCommandQueued).toHaveBeenCalledWith('call_abc', getCommandId(pendingDoc), 'm1');
    expect(onPollTick).toHaveBeenCalled();
  }, 15000);

  it('site-wide fan-out fires onCommandQueued once per machine with that machine id', async () => {
    const { db, pendingDoc, completedDoc } = createMockDb();

    // Resolve every command that has been queued so far (both machines share
    // the mocked completed doc).
    completedDoc.get.mockImplementation(async () => {
      const data: Record<string, unknown> = {};
      for (const call of pendingDoc.set.mock.calls) {
        for (const cmdId of Object.keys(call[0] as Record<string, unknown>)) {
          data[cmdId] = { status: 'success', result: {} };
        }
      }
      return { exists: true, data: () => data };
    });

    const onCommandQueued = jest.fn();
    const toolDef = allTools.find((tool) => tool.name === 'get_system_info')!;
    const tools = buildExecutableTools(
      db, 's1', '', 'c1', [toolDef], true, ['m1', 'm2'],
      { toolCallbacks: { onCommandQueued } },
    );

    await tools.get_system_info.execute({}, { toolCallId: 'call_fan' });

    expect(onCommandQueued).toHaveBeenCalledTimes(2);
    const machineArgs = onCommandQueued.mock.calls.map((call) => call[2]).sort();
    expect(machineArgs).toEqual(['m1', 'm2']);
    const queuedIds = pendingDoc.set.mock.calls.map((call) => Object.keys(call[0] as Record<string, unknown>)[0]);
    for (const call of onCommandQueued.mock.calls) {
      expect(call[0]).toBe('call_fan');
      expect(queuedIds).toContain(call[1]);
    }
  }, 15000);
});

// active-hours override

/**
 * An override reaches a command one way only: a dashboard turn's call sets
 * `override_active_hours` with a reason, `needsApproval` records that exact call
 * and asks the person, and the turn that resumes it finds the record for the
 * same toolCallId and the same input. Everything else is refused before
 * anything is queued, so the agent refuses inside active hours.
 */
describe('active-hours override', () => {
  const PERSON: BuildExecutableToolsOptions = {
    userId: 'uid_alice',
    userRole: 'admin',
    userSiteRole: 'admin',
    allowActiveHoursOverride: true,
  };
  const REBOOT_NOW = { override_active_hours: true, reason: 'the show ended early' };
  const PENDING_M1 = 'sites/s1/machines/m1/commands/pending';

  /** Path-keyed docs; every queued command completes on its first poll. */
  function createStoreDb() {
    const docs = new Map<string, Record<string, unknown>>();
    const doc = (path: string): unknown => ({
      get: async () => {
        if (path.endsWith('/commands/completed')) {
          const pending = docs.get(path.replace(/completed$/, 'pending')) ?? {};
          const done = Object.fromEntries(
            Object.keys(pending).map((id) => [id, { status: 'completed', result: 'ok' }]),
          );
          return { exists: true, data: () => done };
        }
        return { exists: docs.has(path), data: () => docs.get(path) };
      },
      set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
        docs.set(path, opts?.merge ? { ...(docs.get(path) ?? {}), ...data } : data);
      },
      update: async () => {},
      collection: (name: string) => col(`${path}/${name}`),
    });
    const col = (path: string): unknown => ({
      doc: (id: string) => doc(`${path}/${id}`),
      get: async () => ({ docs: [] }),
    });
    return { db: { collection: (name: string) => col(name) } as unknown as FirebaseFirestore.Firestore, docs };
  }

  /** Every command queued at `path`, in write order. */
  function queuedAt(docs: Map<string, Record<string, unknown>>, path = PENDING_M1): Record<string, unknown>[] {
    return Object.values(docs.get(path) ?? {}) as Record<string, unknown>[];
  }

  function toolFor(
    db: FirebaseFirestore.Firestore,
    toolName: string,
    options: BuildExecutableToolsOptions = PERSON,
    siteMode = false,
  ) {
    const def = allTools.find((t) => t.name === toolName)!;
    return buildExecutableTools(
      db, 's1', siteMode ? '__site__' : 'm1', 'c1', [def], siteMode, siteMode ? ['m1', 'm2'] : [], options,
    )[toolName];
  }

  /** The asking turn: the SDK evaluates needsApproval and, when true, shows the card. */
  function ask(
    db: FirebaseFirestore.Firestore,
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
    options: BuildExecutableToolsOptions = PERSON,
  ): Promise<boolean> {
    return Promise.resolve(toolFor(db, toolName, options).needsApproval(input, { toolCallId, messages: [] }));
  }

  /**
   * The turn after the person approved, as ai 7 runs it: needsApproval again on
   * the input the request carries back, then execute on that same input.
   */
  async function resume(
    db: FirebaseFirestore.Firestore,
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<unknown> {
    const tool = toolFor(db, toolName, { ...PERSON, resumedToolCallIds: [toolCallId] });
    await tool.needsApproval(input, { toolCallId, messages: [] });
    return tool.execute(input, { toolCallId });
  }

  it('asks a person for an override even with tier-3 approval off, tier-2 tools included', async () => {
    const { db, docs } = createStoreDb();
    const toggleOff = { ...PERSON, requireTier3Approval: false };

    expect(await ask(db, 'reboot_machine', REBOOT_NOW, 'call_reboot', toggleOff)).toBe(true);
    expect(
      await ask(
        db,
        'manage_windows_update',
        { action: 'set_active_hours', start_hour: 6, end_hour: 9, ...REBOOT_NOW },
        'call_wu',
        toggleOff,
      ),
    ).toBe(true);
    // The same calls without the override run straight away.
    expect(await ask(db, 'reboot_machine', {}, 'call_plain', toggleOff)).toBe(false);
    expect(docs.get('chats/c1/activeHoursOverrides/call_reboot')).toMatchObject({ toolName: 'reboot_machine' });
    expect(docs.get('chats/c1/activeHoursOverrides/call_wu')).toMatchObject({ toolName: 'manage_windows_update' });
    expect(docs.has('chats/c1/activeHoursOverrides/call_plain')).toBe(false);
    expect(queuedAt(docs)).toEqual([]);
  });

  it('an approved single-machine reboot carries the override and who approved it', async () => {
    const { db, docs } = createStoreDb();

    expect(await ask(db, 'reboot_machine', REBOOT_NOW, 'call_1')).toBe(true);
    const result = await resume(db, 'reboot_machine', REBOOT_NOW, 'call_1');

    expect(result).toMatchObject({ status: 'completed' });
    const [command] = queuedAt(docs);
    expect(command).toMatchObject({
      type: 'reboot_machine',
      activeHoursOverride: { reason: 'the show ended early', approvedBy: 'user:uid_alice' },
    });
    // The pair is consumed, not forwarded as stray fields.
    expect(command).not.toHaveProperty('override_active_hours');
    expect(command).not.toHaveProperty('reason');
  }, 15000);

  it('a model-set override never reaches a command without that approval, toggle off included', async () => {
    const { db, docs } = createStoreDb();
    // Even if execute ran with no approval behind it, there is no record of one.
    const tool = toolFor(db, 'reboot_machine', { ...PERSON, requireTier3Approval: false });

    const result = await tool.execute(REBOOT_NOW, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_not_approved' });
    expect(queuedAt(docs)).toEqual([]);
  });

  it('a resumed call whose input gained an override without a fresh approval does not carry it', async () => {
    const { db, docs } = createStoreDb();

    // The card the person answered showed a plain reboot (tier 3 asks anyway).
    expect(await ask(db, 'reboot_machine', {}, 'call_1')).toBe(true);
    // The resume comes back carrying an override nobody was shown.
    const result = await resume(db, 'reboot_machine', REBOOT_NOW, 'call_1');

    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_not_approved' });
    expect(docs.has('chats/c1/activeHoursOverrides/call_1')).toBe(false);
    expect(queuedAt(docs)).toEqual([]);
  });

  it('a resumed override whose input changed after the card was shown does not run', async () => {
    const { db, docs } = createStoreDb();

    expect(await ask(db, 'reboot_machine', REBOOT_NOW, 'call_1')).toBe(true);
    const result = await resume(db, 'reboot_machine', { ...REBOOT_NOW, reason: 'something else' }, 'call_1');

    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_not_approved' });
    expect(queuedAt(docs)).toEqual([]);
  });

  const NO_PERSON_TURNS: Array<[string, BuildExecutableToolsOptions]> = [
    ['a follow-up or talon turn', { userId: 'uid_alice', userRole: 'admin', userSiteRole: 'admin' }],
    ['the conversations API', { userId: 'uid_alice', userRole: 'admin', requireTier3Approval: true }],
    ['an unattended system actor', { systemActor: 'cortex_autonomous', allowActiveHoursOverride: true }],
  ];
  const OVERRIDE_TOOLS = ['reboot_machine', 'shutdown_machine', 'deploy_software', 'manage_windows_update'];

  it.each(NO_PERSON_TURNS)('%s is never offered the override params', (_label, options) => {
    const { db } = createStoreDb();
    for (const toolName of OVERRIDE_TOOLS) {
      const { properties } = toolFor(db, toolName, options).inputSchema;
      expect(properties).not.toHaveProperty('override_active_hours');
      expect(properties).not.toHaveProperty('reason');
    }
    // a deferral is not an override, so it stays on offer.
    expect(toolFor(db, 'reboot_machine', options).inputSchema.properties).toHaveProperty('when');
  });

  it('a dashboard turn is offered them on every tool that takes them', () => {
    const { db } = createStoreDb();
    for (const toolName of OVERRIDE_TOOLS) {
      const { properties } = toolFor(db, toolName).inputSchema;
      expect(properties).toHaveProperty('override_active_hours');
      expect(properties).toHaveProperty('reason');
    }
  });

  it.each(NO_PERSON_TURNS)('%s is refused before anything is asked or queued', async (_label, options) => {
    const { db, docs } = createStoreDb();
    const tool = toolFor(db, 'reboot_machine', options);

    // The schema no longer offers it; a model that sends it anyway gets no card,
    // and the refusal is immediate.
    expect(await tool.needsApproval(REBOOT_NOW, { toolCallId: 'call_1', messages: [] })).toBe(false);
    const result = await tool.execute(REBOOT_NOW, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_needs_person' });
    expect(docs.size).toBe(0);
  });

  it('a fan-out turn is refused: overrides go one machine at a time', async () => {
    const { db, docs } = createStoreDb();
    const tool = toolFor(db, 'reboot_machine', PERSON, true);

    expect(await tool.needsApproval(REBOOT_NOW, { toolCallId: 'call_1', messages: [] })).toBe(false);
    const result = await tool.execute(REBOOT_NOW, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_needs_single_machine' });
    expect(docs.size).toBe(0);
  });

  it.each([
    ['no reason', { override_active_hours: true }],
    ['a blank reason', { override_active_hours: true, reason: '   ' }],
    ['a reason over 500 characters', { override_active_hours: true, reason: 'x'.repeat(501) }],
  ])('%s is refused with a request for one', async (_label, input) => {
    const { db, docs } = createStoreDb();
    const tool = toolFor(db, 'reboot_machine');

    expect(await tool.needsApproval(input, { toolCallId: 'call_1', messages: [] })).toBe(false);
    const result = await tool.execute(input, { toolCallId: 'call_1' });

    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_needs_reason' });
    expect(docs.size).toBe(0);
  });

  it('asks nobody when the request cannot be recorded, and the call is refused', async () => {
    const { db, docs } = createStoreDb();
    const failing = {
      collection: (name: string) =>
        name === 'chats'
          ? { doc: () => ({ collection: () => ({ doc: () => ({ set: async () => { throw new Error('unavailable'); } }) }) }) }
          : db.collection(name),
    } as unknown as FirebaseFirestore.Firestore;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(await ask(failing, 'reboot_machine', REBOOT_NOW, 'call_1')).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
    // No card was shown, so the SDK runs execute at once, which finds no record.
    const result = await toolFor(db, 'reboot_machine').execute(REBOOT_NOW, { toolCallId: 'call_1' });
    expect(result).toMatchObject({ ok: false, error: 'active_hours_override_not_approved' });
    expect(queuedAt(docs)).toEqual([]);
  });

  it('an approved set_active_hours override rides the mcp_tool_call envelope, not tool_params', async () => {
    const { db, docs } = createStoreDb();
    const input = { action: 'set_active_hours', start_hour: 6, end_hour: 9, ...REBOOT_NOW };

    expect(await ask(db, 'manage_windows_update', input, 'call_wu')).toBe(true);
    await resume(db, 'manage_windows_update', input, 'call_wu');

    const [command] = queuedAt(docs);
    expect(command).toMatchObject({
      type: 'mcp_tool_call',
      tool_name: 'manage_windows_update',
      activeHoursOverride: { reason: 'the show ended early', approvedBy: 'user:uid_alice' },
    });
    expect(command.tool_params).toEqual({ action: 'set_active_hours', start_hour: 6, end_hour: 9 });
  }, 15000);

  it('an approved deployment writes the override onto its install_software command', async () => {
    const { db, docs } = createStoreDb();
    const input = {
      software_name: 'Player',
      installer_url: 'https://example.com/player.exe',
      silent_flags: '/S',
      ...REBOOT_NOW,
    };

    expect(await ask(db, 'deploy_software', input, 'call_deploy')).toBe(true);
    const result = await resume(db, 'deploy_software', input, 'call_deploy');

    expect(result).toMatchObject({ status: 'deployment_started' });
    const [command] = queuedAt(docs);
    expect(command).toMatchObject({
      type: 'install_software',
      activeHoursOverride: { reason: 'the show ended early', approvedBy: 'user:uid_alice' },
    });
  });

  it('without an override, deferral and a stray reason are handled as plain params', async () => {
    const { db, docs } = createStoreDb();

    // `when` is not privileged, so it needs no card beyond the tier's own.
    await toolFor(db, 'reboot_machine', { ...PERSON, requireTier3Approval: false }).execute(
      { when: 'after_active_hours', reason: 'not an override' },
      { toolCallId: 'call_1' },
    );

    const [command] = queuedAt(docs);
    expect(command).toMatchObject({ type: 'reboot_machine', when: 'after_active_hours' });
    expect(command).not.toHaveProperty('activeHoursOverride');
    expect(command).not.toHaveProperty('reason');
  }, 15000);
});

// schedule_followup / cancel_followup (server-side, never relayed)

/**
 * The tool layer owns: the delay/at arithmetic and its bounds, the exactly-one-of
 * gate, the target a follow-up is filed against (the turn's own when it has one,
 * else the one-machine-or-whole-site fallback), the refusal when there is no
 * chat identity to own the future turn, and the mapping of every
 * `cancelFollowup` outcome to something the model can read. The store owns
 * everything past that — the never-widen legacy field included — so it is mocked.
 */
describe('follow-up tools', () => {
  const NOW = Date.parse('2026-08-20T09:00:00.000Z');
  const CHAT_OPTIONS: BuildExecutableToolsOptions = { userId: 'uid_alice', userRole: 'admin' };

  /** Sentinel — the executors hand `db` straight to the mocked store. */
  const storeDb = { __db: 'sentinel' } as unknown as FirebaseFirestore.Firestore;

  function followupTools(
    options: BuildExecutableToolsOptions = CHAT_OPTIONS,
    { siteMode = false, db = storeDb }: { siteMode?: boolean; db?: FirebaseFirestore.Firestore } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Record<string, any> {
    const defs = ['schedule_followup', 'cancel_followup'].map(
      (name) => allTools.find((tool) => tool.name === name)!,
    );
    return buildExecutableTools(
      db,
      's1',
      siteMode ? '__site__' : 'm1',
      'chat-1',
      defs,
      siteMode,
      siteMode ? ['m1', 'm2'] : [],
      options,
    );
  }

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    // Echo the computed runAt so `fires_at` provably comes from the store write.
    mockScheduleFollowup.mockImplementation(async (_db: unknown, input: { runAt: Date }) => ({
      id: 'fu_1',
      runAt: input.runAt,
    }));
    mockCancelFollowup.mockResolvedValue('cancelled');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('schedules from delay_minutes and returns followup_id + fires_at', async () => {
    const result = await followupTools().schedule_followup.execute({
      note: 'check whether the TD install finished',
      delay_minutes: 30,
    });

    expect(mockScheduleFollowup).toHaveBeenCalledWith(storeDb, {
      chatId: 'chat-1',
      siteId: 's1',
      target: { machineIds: ['m1'] },
      userId: 'uid_alice',
      note: 'check whether the TD install finished',
      runAt: new Date('2026-08-20T09:30:00.000Z'),
    });
    expect(result).toEqual({
      ok: true,
      followup_id: 'fu_1',
      fires_at: '2026-08-20T09:30:00.000Z',
      message: 'scheduled a follow-up for 2026-08-20T09:30:00.000Z.',
    });
  });

  it('schedules from an absolute ISO `at`', async () => {
    const result = await followupTools().schedule_followup.execute({
      note: 'confirm the wall came back up',
      at: '2026-08-20T17:45:00.000Z',
    });

    expect(mockScheduleFollowup.mock.calls[0][1].runAt).toEqual(
      new Date('2026-08-20T17:45:00.000Z'),
    );
    expect(result).toMatchObject({ ok: true, fires_at: '2026-08-20T17:45:00.000Z' });
  });

  it('threads watch_command_id through to the store and echoes it back', async () => {
    const result = await followupTools().schedule_followup.execute({
      note: 'report the install result',
      delay_minutes: 45,
      watch_command_id: '  mcp_123_execute_script  ',
    });

    expect(mockScheduleFollowup.mock.calls[0][1]).toMatchObject({
      watchCommandId: 'mcp_123_execute_script',
    });
    expect(result).toMatchObject({ watch_command_id: 'mcp_123_execute_script' });
  });

  it('omits watchCommandId entirely when it is blank (Firestore rejects undefined)', async () => {
    await followupTools().schedule_followup.execute({
      note: 'check back',
      delay_minutes: 5,
      watch_command_id: '   ',
    });

    expect(mockScheduleFollowup.mock.calls[0][1]).not.toHaveProperty('watchCommandId');
  });

  it('records a site-wide chat as the dynamic "all machines" target, not a fanned-out machine', async () => {
    // site mode hands executeServerSideTool the online machine list, so the
    // target has to arrive by its own route or every site chat's follow-up
    // would be filed against whichever machine happened to be first.
    await followupTools(CHAT_OPTIONS, { siteMode: true }).schedule_followup.execute({
      note: 'sweep the fleet again',
      delay_minutes: 60,
    });

    expect(mockScheduleFollowup.mock.calls[0][1]).toMatchObject({
      target: { machineIds: null },
    });
  });

  it('files the follow-up against the turn\'s own target, not the site sentinel', async () => {
    // A subset turn runs in fan-out mode, where the legacy `chatMachineId` can
    // only say `__site__`. Without the turn's target the promise would come back
    // across the WHOLE site — including machines the user never ticked.
    await followupTools(
      { ...CHAT_OPTIONS, followupTarget: { machineIds: ['m2', 'm3'] } },
      { siteMode: true },
    ).schedule_followup.execute({ note: 'check both walls again', delay_minutes: 20 });

    expect(mockScheduleFollowup.mock.calls[0][1]).toMatchObject({
      target: { machineIds: ['m2', 'm3'] },
    });
  });

  it('lets the turn\'s target narrow a single-machine chat too', async () => {
    await followupTools({
      ...CHAT_OPTIONS,
      followupTarget: { machineIds: ['m9'] },
    }).schedule_followup.execute({ note: 'check back', delay_minutes: 5 });

    expect(mockScheduleFollowup.mock.calls[0][1]).toMatchObject({
      target: { machineIds: ['m9'] },
    });
  });

  it('refuses an empty target rather than filing a follow-up with no machines', async () => {
    // An empty selection is allowed transiently in the picker with send
    // disabled; reaching a write path with one is a bug, and the store's legacy
    // field would have to widen it to the site.
    const result = await followupTools({
      ...CHAT_OPTIONS,
      followupTarget: { machineIds: [] },
    }).schedule_followup.execute({ note: 'check back', delay_minutes: 5 });

    expect(result).toMatchObject({ ok: false, error: 'followup_unavailable' });
    expect(mockScheduleFollowup).not.toHaveBeenCalled();
  });

  it('records the turn\'s tier ceiling so the fired turn cannot out-reach it', async () => {
    // A chat-scoped API key is capped at tier 1 but may still schedule, and the
    // sweep re-resolves the OWNER's access at fire time. Without the ceiling on
    // the doc the promise would come back at the owner's tier — tier 2 runs with
    // no approval gate, `manage_scheduled_task` included.
    await followupTools({ ...CHAT_OPTIONS, maxToolTier: 1 }).schedule_followup.execute({
      note: 'check whether the deploy landed',
      delay_minutes: 15,
    });

    expect(mockScheduleFollowup.mock.calls[0][1]).toMatchObject({ maxToolTier: 1 });
  });

  it('omits the ceiling when the turn declared none (Firestore rejects undefined)', async () => {
    // Absent is the legacy shape: the sweep fires those on re-resolved access
    // alone, exactly as it did before the ceiling existed.
    await followupTools().schedule_followup.execute({ note: 'check back', delay_minutes: 5 });

    expect(mockScheduleFollowup.mock.calls[0][1]).not.toHaveProperty('maxToolTier');
  });

  it('never dispatches a command to an agent', async () => {
    const { db, pendingDoc } = createMockDb();

    await followupTools(CHAT_OPTIONS, { db }).schedule_followup.execute({
      note: 'check back',
      delay_minutes: 10,
    });
    await followupTools(CHAT_OPTIONS, { db }).cancel_followup.execute({ followup_id: 'fu_1' });

    expect(pendingDoc.set).not.toHaveBeenCalled();
  });

  it.each([
    [
      'both delay_minutes and at',
      { note: 'n', delay_minutes: 30, at: '2026-08-20T17:45:00.000Z' },
      'invalid_schedule',
    ],
    ['neither delay_minutes nor at', { note: 'n' }, 'invalid_schedule'],
    ['a blank at with no delay', { note: 'n', at: '   ' }, 'invalid_schedule'],
    ['a delay below the floor', { note: 'n', delay_minutes: 0 }, 'invalid_delay_minutes'],
    [
      'a delay past seven days',
      { note: 'n', delay_minutes: MAX_FOLLOWUP_DELAY_MINUTES + 1 },
      'invalid_delay_minutes',
    ],
    ['a non-numeric delay', { note: 'n', delay_minutes: '30' }, 'invalid_delay_minutes'],
    ['an unparseable at', { note: 'n', at: 'in about two hours' }, 'invalid_at'],
    ['an at in the past', { note: 'n', at: '2026-08-20T08:59:00.000Z' }, 'at_in_the_past'],
    ['an at beyond seven days', { note: 'n', at: '2026-09-20T09:00:00.000Z' }, 'at_too_far_out'],
    ['no note', { delay_minutes: 30 }, 'missing_note'],
    ['a whitespace-only note', { note: '   ', delay_minutes: 30 }, 'missing_note'],
    [
      'an oversized note',
      { note: 'x'.repeat(MAX_FOLLOWUP_NOTE_LENGTH + 1), delay_minutes: 30 },
      'note_too_long',
    ],
  ])('refuses %s with a readable error and writes nothing', async (_label, params, code) => {
    const result = await followupTools().schedule_followup.execute(params);

    // A result, never a throw: a throw takes the whole turn down, a result lets
    // the model correct itself on the next step.
    expect(result).toMatchObject({ ok: false, error: code, status: 400 });
    expect((result as { detail: string }).detail.length).toBeGreaterThan(0);
    expect(mockScheduleFollowup).not.toHaveBeenCalled();
  });

  it('accepts the exact boundaries of the delay range', async () => {
    await followupTools().schedule_followup.execute({ note: 'floor', delay_minutes: 1 });
    await followupTools().schedule_followup.execute({
      note: 'ceiling',
      delay_minutes: MAX_FOLLOWUP_DELAY_MINUTES,
    });

    expect(mockScheduleFollowup).toHaveBeenCalledTimes(2);
    expect(mockScheduleFollowup.mock.calls[0][1].runAt).toEqual(new Date(NOW + 60_000));
    expect(mockScheduleFollowup.mock.calls[1][1].runAt).toEqual(
      new Date(NOW + MAX_FOLLOWUP_DELAY_MINUTES * 60_000),
    );
  });

  it('accepts a note at exactly the length cap', async () => {
    const note = 'x'.repeat(MAX_FOLLOWUP_NOTE_LENGTH);
    const result = await followupTools().schedule_followup.execute({ note, delay_minutes: 5 });

    expect(result).toMatchObject({ ok: true });
    expect(mockScheduleFollowup.mock.calls[0][1].note).toBe(note);
  });

  it('reports a store failure as a tool error instead of rejecting', async () => {
    mockScheduleFollowup.mockRejectedValue(new Error('firestore down'));

    const result = await followupTools().schedule_followup.execute({
      note: 'check back',
      delay_minutes: 10,
    });

    expect(result).toEqual({ ok: false, error: 'internal_error', detail: 'firestore down' });
  });

  it('refuses to schedule for an unattended caller with no chat identity', async () => {
    // Autonomous hoot has no chat to re-open and no user whose access could be
    // re-resolved at fire time, so the follow-up could never legitimately run.
    const result = await followupTools({ systemActor: 'cortex_autonomous' }).schedule_followup.execute(
      { note: 'check back', delay_minutes: 10 },
    );

    expect(result).toMatchObject({ ok: false, error: 'followup_unavailable', status: 400 });
    expect(mockScheduleFollowup).not.toHaveBeenCalled();
  });

  it('cancels on the caller\'s behalf and confirms', async () => {
    const result = await followupTools().cancel_followup.execute({ followup_id: '  fu_1  ' });

    // Ownership lives in the store; the tool must hand it the caller's uid.
    expect(mockCancelFollowup).toHaveBeenCalledWith(storeDb, 'fu_1', { userId: 'uid_alice' });
    expect(result).toEqual({
      ok: true,
      followup_id: 'fu_1',
      message: 'cancelled follow-up fu_1.',
    });
  });

  it.each([
    ['not_found', 'followup_not_found', 404],
    ['forbidden', 'followup_forbidden', 403],
    ['not_scheduled', 'followup_not_scheduled', 409],
  ])('maps the %s outcome to a readable error', async (outcome, code, status) => {
    mockCancelFollowup.mockResolvedValue(outcome);

    const result = await followupTools().cancel_followup.execute({ followup_id: 'fu_1' });

    expect(result).toMatchObject({ ok: false, followup_id: 'fu_1', error: code, status });
    expect((result as { detail: string }).detail.length).toBeGreaterThan(0);
  });

  it.each([
    ['a missing followup_id', {}],
    ['a whitespace-only followup_id', { followup_id: '   ' }],
    ['a non-string followup_id', { followup_id: 42 }],
  ])('refuses a cancel with %s', async (_label, params) => {
    const result = await followupTools().cancel_followup.execute(params);

    expect(result).toMatchObject({ ok: false, error: 'missing_followup_id', status: 400 });
    expect(mockCancelFollowup).not.toHaveBeenCalled();
  });

  it('refuses to cancel for an unattended caller with no user identity', async () => {
    const result = await followupTools({ systemActor: 'cortex_autonomous' }).cancel_followup.execute({
      followup_id: 'fu_1',
    });

    expect(result).toMatchObject({ ok: false, error: 'followup_unavailable' });
    expect(mockCancelFollowup).not.toHaveBeenCalled();
  });

  it('reports a store failure on cancel as a tool error instead of rejecting', async () => {
    mockCancelFollowup.mockRejectedValue(new Error('transaction aborted'));

    const result = await followupTools().cancel_followup.execute({ followup_id: 'fu_1' });

    expect(result).toEqual({ ok: false, error: 'internal_error', detail: 'transaction aborted' });
  });
});

// resolveLlmConfig

/**
 * A db whose `users/{uid}/settings/llm` and `sites/{siteId}` docs are seeded from
 * `store`, recording every path asked for — the site-key assertions below are about
 * a read that must no longer happen at all.
 */
function makeKeyDb(store: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const docRef = (path: string) => ({
    get: async () => {
      reads.push(path);
      const data = store[path];
      return { exists: data !== undefined, data: () => data };
    },
    collection: (child: string) => collectionRef(`${path}/${child}`),
  });
  // Real Firestore subcollections support `.where()`; this double did not, so a
  // correct implementation looked broken. `resolveSiteKeyOwner` needs it to find
  // the owner MEMBER ROW rather than the legacy `sites/{id}.owner` field.
  const collectionRef = (prefix: string) => ({
    doc: (id: string) => docRef(`${prefix}/${id}`),
    where: (field: string, _op: string, value: unknown) => ({
      limit: () => ({
        get: async () => {
          reads.push(`${prefix} where ${field}==${String(value)}`);
          const docs = Object.entries(store)
            .filter(
              ([path, data]) =>
                path.startsWith(`${prefix}/`) &&
                path.slice(prefix.length + 1).indexOf('/') === -1 &&
                (data as Record<string, unknown>)[field] === value,
            )
            .map(([path, data]) => ({ id: path.split('/').pop() as string, data: () => data }));
          return { docs, empty: docs.length === 0 };
        },
      }),
    }),
  });
  const db = {
    collection: (name: string) => collectionRef(name),
  } as unknown as FirebaseFirestore.Firestore;
  return { db, reads };
}

describe('resolveLlmConfig', () => {
  it("returns the named user's key, decrypted", async () => {
    const { db } = makeKeyDb({
      'users/u1/settings/llm': {
        provider: 'anthropic',
        apiKeyEncrypted: 'sk-user',
        model: 'claude-x',
      },
    });

    await expect(resolveLlmConfig(db, 'u1')).resolves.toEqual({
      provider: 'anthropic',
      apiKey: 'sk-user',
      model: 'claude-x',
    });
  });

  it('never consults a site-level key, even when one exists', async () => {
    // The old `sites/{siteId}/settings/llm` scope is gone. A document left over
    // from the removed admin endpoint must be inert, not a silent fallback.
    const { db, reads } = makeKeyDb({
      'sites/s1/settings/llm': { provider: 'anthropic', apiKeyEncrypted: 'sk-site' },
    });

    await expect(resolveLlmConfig(db, 'u1')).rejects.toThrow(/No LLM API key configured/);
    expect(reads).toEqual(['users/u1/settings/llm']);
  });

  it('points a keyless caller at the one screen that fixes it', async () => {
    const { db } = makeKeyDb({});

    await expect(resolveLlmConfig(db, 'u1')).rejects.toThrow('Account Settings → hoot');
  });

  it('reports an undecryptable key without echoing any of it', async () => {
    const { db } = makeKeyDb({
      'users/u1/settings/llm': { provider: 'anthropic', apiKeyEncrypted: 'sk-corrupt' },
    });
    (decryptApiKey as jest.Mock).mockImplementationOnce(() => {
      throw new Error('bad key');
    });

    const error = await resolveLlmConfig(db, 'u1').catch((err: Error) => err);
    expect((error as Error).message).toMatch(/Failed to decrypt/);
    expect((error as Error).message).not.toContain('sk-corrupt');
  });

  it('asserts a key without handing it back', async () => {
    const { db } = makeKeyDb({
      'users/u1/settings/llm': { provider: 'anthropic', apiKeyEncrypted: 'sk-user' },
    });

    await expect(assertLlmKeyAvailable(db, 'u1')).resolves.toBeUndefined();
    await expect(assertLlmKeyAvailable(db, 'u-nokey')).rejects.toThrow(/No LLM API key/);
  });
});

describe('resolveSiteKeyOwner', () => {
  it('names the site owner as the uid an unattended site-wide run spends', async () => {
    const { db } = makeKeyDb({ 'sites/s1': { owner: 'owner-uid' } });

    await expect(resolveSiteKeyOwner(db, 's1')).resolves.toBe('owner-uid');
  });

  it.each([
    ['a site with no owner recorded', { 'sites/s1': {} }],
    ['a site that is gone', {}],
  ])('refuses %s', async (_label, store) => {
    const { db } = makeKeyDb(store as Record<string, Record<string, unknown>>);

    await expect(resolveSiteKeyOwner(db, 's1')).rejects.toThrow(/has no owner/);
  });

  // Wave 6.1 deletes `sites/{siteId}.owner`. Without these, every unattended run
  // would start throwing "has no owner" the moment that migration ran.
  it('resolves from the owner member row with no legacy owner field present', async () => {
    const { db } = makeKeyDb({
      'sites/s1': {},
      'sites/s1/members/owner-uid': { uid: 'owner-uid', role: 'owner', status: 'active' },
    });

    await expect(resolveSiteKeyOwner(db, 's1')).resolves.toBe('owner-uid');
  });

  it('prefers the member row over a stale legacy owner field', async () => {
    const { db } = makeKeyDb({
      'sites/s1': { owner: 'stale-uid' },
      'sites/s1/members/real-owner': { uid: 'real-owner', role: 'owner', status: 'active' },
    });

    await expect(resolveSiteKeyOwner(db, 's1')).resolves.toBe('real-owner');
  });

  it('ignores a non-active owner row and falls back during the transition', async () => {
    const { db } = makeKeyDb({
      'sites/s1': { owner: 'legacy-uid' },
      'sites/s1/members/old-owner': { uid: 'old-owner', role: 'owner', status: 'revoked' },
    });

    await expect(resolveSiteKeyOwner(db, 's1')).resolves.toBe('legacy-uid');
  });

  it('ignores an admin row — only the owner funds an unattended run', async () => {
    const { db } = makeKeyDb({
      'sites/s1': {},
      'sites/s1/members/admin-uid': { uid: 'admin-uid', role: 'admin', status: 'active' },
    });

    await expect(resolveSiteKeyOwner(db, 's1')).rejects.toThrow(/has no owner/);
  });
});

// verifyUserSiteAccess

/**
 * Build a db stub for `resolveSiteAccess`, which reads three documents:
 * `users/{uid}`, `sites/{siteId}`, and `sites/{siteId}/members/{uid}`.
 *
 * `member` is the one that grants. `sites` is still accepted because the site
 * document must exist for the site to be found at all, but its `owner` field is
 * no longer consulted for access — passing an owner without a member row is now
 * a refusal, and there are tests below that say so.
 */
function makeAccessDb(docs: {
  users?: Record<string, unknown> | null;
  sites?: Record<string, unknown> | null;
  member?: Record<string, unknown> | null;
  siteExists?: boolean;
}) {
  const siteDoc = () =>
    docs.siteExists === false
      ? { exists: false, data: () => undefined }
      : { exists: true, data: () => docs.sites ?? {} };
  const userDoc = () =>
    docs.users
      ? { exists: true, data: () => docs.users }
      : { exists: false, data: () => undefined };
  const memberDoc = () =>
    docs.member
      ? { exists: true, data: () => docs.member }
      : { exists: false, data: () => undefined };

  return {
    collection: (name: string) => ({
      doc: (_id: string) => ({
        get: async () => (name === 'users' ? userDoc() : name === 'sites' ? siteDoc() : { exists: false }),
        collection: (sub: string) => ({
          doc: (_innerId: string) => ({
            get: async () => (sub === 'members' ? memberDoc() : { exists: false, data: () => undefined }),
          }),
        }),
      }),
    }),
    // verifyUserSiteAccess reads through resolveSiteAccess since task 1.5, and
    // the core uses ONE batched read rather than two independent gets. Real
    // getAll preserves argument order and yields a non-existent snapshot for a
    // missing document, so delegating to each ref's own get() matches it.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
  } as unknown as FirebaseFirestore.Firestore;
}

describe('verifyUserSiteAccess', () => {
  /** An active membership row at the given per-site role. */
  const member = (role: 'owner' | 'admin' | 'member') => ({
    uid: 'u1',
    role,
    status: 'active',
    addedAt: new Date(0),
    addedBy: 'system:test',
  });

  it('throws when the user doc does not exist', async () => {
    const db = makeAccessDb({ users: null, sites: {} });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow('User not found');
  });

  it('throws when the site doc does not exist', async () => {
    const db = makeAccessDb({ users: { role: 'member' }, siteExists: false });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow('Site not found');
  });

  it('reports the RAW global role, unnormalised', async () => {
    // SiteAccessLevel.role is `string | null` and callers re-narrow it
    // themselves. The core normalises unknown values to 'member', so returning
    // its globalRole here would rewrite 'viewer' to 'member' and an absent role
    // to 'member' — a quiet contract change.
    const viewer = makeAccessDb({
      users: { role: 'viewer' },
      sites: {},
      member: member('member'),
    });
    await expect(verifyUserSiteAccess(viewer, 'u1', 's1')).resolves.toMatchObject({
      role: 'viewer',
      isSiteAdmin: false,
    });

    const roleless = makeAccessDb({ users: {}, sites: {}, member: member('member') });
    await expect(verifyUserSiteAccess(roleless, 'u1', 's1')).resolves.toMatchObject({
      role: null,
    });
  });

  it('rejects a soft-deleted user even if their role would otherwise grant access', async () => {
    // Regression: a soft-deleted superadmin holding a stale iron-session cookie
    // must not retain Hoot access (incl. tier-3 tools) until the cookie lapses.
    const db = makeAccessDb({
      users: { role: 'superadmin', deletedAt: 1700000000000 },
      sites: {},
    });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow(
      /deleted or inactive/
    );
  });

  it('grants superadmin full access holding NO membership row', async () => {
    // Superadmins reach every site by global role and deliberately hold no
    // member rows, so this is the shape production actually produces.
    const db = makeAccessDb({ users: { role: 'superadmin' }, sites: {} });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSuperadmin).toBe(true);
    expect(access.isSiteAdmin).toBe(true);
    expect(access.siteRole).toBeNull();
  });

  it('an owner membership grants ownership and site-admin', async () => {
    const db = makeAccessDb({
      users: { role: 'member' },
      sites: {},
      member: member('owner'),
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.siteRole).toBe('owner');
    expect(access.isSiteOwner).toBe(true);
    expect(access.isSiteAdmin).toBe(true);
  });

  it('an admin membership grants site-admin but not ownership', async () => {
    const db = makeAccessDb({
      users: { role: 'member' },
      sites: {},
      member: member('admin'),
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSiteAdmin).toBe(true);
    expect(access.isSiteOwner).toBe(false);
  });

  it('a member membership grants access but NOT admin', async () => {
    const db = makeAccessDb({
      users: { role: 'member' },
      sites: {},
      member: member('member'),
    });
    const access = await verifyUserSiteAccess(db, 'u1', 's1');
    expect(access.isSiteAdmin).toBe(false);
    expect(access.siteRole).toBe('member');
  });

  it('a GLOBAL admin with no membership is refused outright', async () => {
    // The headline change. This user previously reached the site through
    // `sites[]` and held tier-3 Hoot on it; the global role now grants nothing.
    const db = makeAccessDb({ users: { role: 'admin', sites: ['s1'] }, sites: {} });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow(
      /do not have access/
    );
  });

  it('the legacy owner field alone does not grant access', async () => {
    // `sites/{siteId}.owner` is no longer read. A site pointing at this user with
    // no member row is a repair job, not a grant.
    const db = makeAccessDb({ users: { role: 'member' }, sites: { owner: 'u1' } });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow(
      /do not have access/
    );
  });

  it('a non-active membership grants nothing', async () => {
    const db = makeAccessDb({
      users: { role: 'member' },
      sites: {},
      member: { ...member('admin'), status: 'invited' },
    });
    await expect(verifyUserSiteAccess(db, 'u1', 's1')).rejects.toThrow(
      /do not have access/
    );
  });

  /**
   * The codes exist for one caller: an unattended talon run, which disables the talon
   * on a DETERMINISTIC refusal only. A codeless refusal is indistinguishable from a
   * Firestore outage, so every branch that says no has to say which no it is.
   */
  it.each([
    ['user_not_found', { users: null, sites: {} }],
    ['site_not_found', { users: { role: 'member' }, siteExists: false }],
    [
      'user_deleted',
      { users: { role: 'admin', deletedAt: 1700000000000 }, sites: {} },
    ],
    ['no_site_access', { users: { role: 'member' }, sites: { owner: 'x' } }],
  ])('refuses with code %s', async (code, docs) => {
    const db = makeAccessDb(docs as Parameters<typeof makeAccessDb>[0]);

    const error = await verifyUserSiteAccess(db, 'u1', 's1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SiteAccessError);
    expect((error as SiteAccessError).code).toBe(code);
  });
});

// resolveHootMaxTier

describe('resolveHootMaxTier', () => {
  it('returns 3 for site admins', () => {
    expect(
      resolveHootMaxTier({ role: 'superadmin', isSuperadmin: true, isSiteAdmin: true, isSiteOwner: false })
    ).toBe(3);
    expect(
      resolveHootMaxTier({ role: 'admin', isSuperadmin: false, isSiteAdmin: true, isSiteOwner: true })
    ).toBe(3);
  });

  it('caps non-admins (members) at tier 1 — read-only', () => {
    // Regression: members with site access must not receive tier 2/3 tools,
    // which include registry writes, execute_script, run_powershell, etc.
    expect(
      resolveHootMaxTier({ role: 'member', isSuperadmin: false, isSiteAdmin: false, isSiteOwner: true })
    ).toBe(1);
    expect(
      resolveHootMaxTier({ role: 'member', isSuperadmin: false, isSiteAdmin: false, isSiteOwner: false })
    ).toBe(1);
  });
});

// getHootRequireTier3Approval

/** db stub for sites/{siteId}/settings/cortex.get(). Pass 'throw' to simulate a read error. */
function makeHootSettingsDb(
  hootDoc: { exists: boolean; data?: () => unknown } | 'throw',
) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => {
              if (hootDoc === 'throw') throw new Error('firestore down');
              return hootDoc;
            },
          }),
        }),
      }),
    }),
  } as unknown as FirebaseFirestore.Firestore;
}

describe('getHootRequireTier3Approval', () => {
  it('defaults to true (gate on) when the settings doc is absent', async () => {
    const db = makeHootSettingsDb({ exists: false });
    expect(await getHootRequireTier3Approval(db, 's1')).toBe(true);
  });

  it('defaults to true when the field is absent', async () => {
    const db = makeHootSettingsDb({ exists: true, data: () => ({}) });
    expect(await getHootRequireTier3Approval(db, 's1')).toBe(true);
  });

  it('returns false only when explicitly disabled', async () => {
    const db = makeHootSettingsDb({ exists: true, data: () => ({ requireTier3Approval: false }) });
    expect(await getHootRequireTier3Approval(db, 's1')).toBe(false);
  });

  it('returns true when explicitly enabled', async () => {
    const db = makeHootSettingsDb({ exists: true, data: () => ({ requireTier3Approval: true }) });
    expect(await getHootRequireTier3Approval(db, 's1')).toBe(true);
  });

  it('fails safe (true) when the read throws', async () => {
    const db = makeHootSettingsDb('throw');
    expect(await getHootRequireTier3Approval(db, 's1')).toBe(true);
  });
});

// capture_screenshot toModelOutput (image projection)

describe('capture_screenshot toModelOutput', () => {
  function screenshotToModelOutput(siteMode: boolean) {
    const def = allTools.find((t) => t.name === 'capture_screenshot')!;
    const tools = buildExecutableTools(
      {} as unknown as FirebaseFirestore.Firestore,
      's1', siteMode ? '' : 'm1', 'c1', [def], siteMode, siteMode ? ['m1', 'm2'] : [],
    );
    return tools.capture_screenshot.toModelOutput as (a: { output: unknown }) => {
      type: string;
      value: unknown;
    };
  }

  it('projects a single-machine screenshot url as an image-url block', () => {
    const out = screenshotToModelOutput(false)({ output: { url: 'https://x/s.jpg', message: 'shot' } });
    expect(out).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'shot' },
        { type: 'image-url', url: 'https://x/s.jpg' },
      ],
    });
  });

  it('projects each machine url in site-wide aggregated output', () => {
    const out = screenshotToModelOutput(true)({
      output: { machines: [
        { machine: 'm1', url: 'https://x/m1.jpg' },
        { machine: 'm2', error: 'offline' },
      ] },
    });
    expect(out).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'm1:' },
        { type: 'image-url', url: 'https://x/m1.jpg' },
        { type: 'text', text: 'm2: offline' },
      ],
    });
  });

  it('falls back to text when there is no url', () => {
    const out = screenshotToModelOutput(false)({ output: { error: 'capture failed' } });
    expect(out).toEqual({ type: 'text', value: 'capture failed' });
  });
});
