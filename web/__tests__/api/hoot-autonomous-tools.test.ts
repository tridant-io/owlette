/** @jest-environment node */

/**
 * Tool-wiring coverage for POST /api/hoot/autonomous.
 *
 * The autonomous investigator builds its own tool set (`buildAutonomousTools`) rather
 * than sharing `buildExecutableTools`. Exercised through the real route, this pins:
 *   - SERVER_SIDE_TOOLS run on the web server via `executeServerSideTool` and are NEVER
 *     relayed to the agent (mcp_tools.py has no handler — a relay returns Unknown tool)
 *   - EXISTING_COMMAND_MAPPINGS tools still dispatch as legacy-typed commands
 *   - every other tool still dispatches as a generic mcp tool call
 *   - talon authoring / enable-toggle tools are excluded entirely (an unattended run
 *     must not author automations)
 *   - the Opus 5 advisor is offered with its per-reply cap, or not at all
 *   - a payer without hoot is skipped with a quiet 200, before anything starts
 *   - the internal secret is compared in constant time, and refused when unset
 */

import crypto from 'crypto';
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

/* ai sdk */

const mockGenerateText = jest.fn();

jest.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  stepCountIs: (n: number) => ({ __stopWhen: n }),
  // The real `tool()` / `jsonSchema()` helpers pass their argument through
  // (plus type branding), so identity keeps `execute` directly callable here.
  tool: (config: unknown) => config,
  jsonSchema: (schema: unknown) => schema,
}));

/* firestore primitives */

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: () => ({ __ts: 'now' }),
    fromMillis: (ms: number) => ({ __ts: ms }),
  },
  FieldValue: { serverTimestamp: () => ({ __op: 'serverTimestamp' }) },
}));

/* hoot collaborators */

const mockBuildAutonomousSystemPrompt = jest.fn((..._args: unknown[]) => 'system prompt');

jest.mock('@/lib/llm', () => ({
  createModel: jest.fn(() => ({ id: 'test-model' })),
  buildAutonomousSystemPrompt: (...args: unknown[]) => mockBuildAutonomousSystemPrompt(...args),
  buildAutonomousEventMessage: jest.requireActual('@/lib/llm').buildAutonomousEventMessage,
}));

const mockExecuteServerSideTool = jest.fn();
const mockResolveLlmConfig = jest.fn();
const mockResolveSiteKeyOwner = jest.fn();
const mockIsMachineOnline = jest.fn();
const mockIsHootEnabled = jest.fn();
const mockGetMachineSummary = jest.fn();

jest.mock('@/lib/hoot-utils.server', () => ({
  // Real membership: the branch under test keys off this exact set, so the
  // sibling tools a future wave adds to it are covered without editing here.
  SERVER_SIDE_TOOLS: jest.requireActual('@/lib/hoot-utils.server').SERVER_SIDE_TOOLS,
  executeServerSideTool: (...args: unknown[]) => mockExecuteServerSideTool(...args),
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
  resolveSiteKeyOwner: (...args: unknown[]) => mockResolveSiteKeyOwner(...args),
  isMachineOnline: (...args: unknown[]) => mockIsMachineOnline(...args),
  isHootEnabled: (...args: unknown[]) => mockIsHootEnabled(...args),
  getMachineSummary: (...args: unknown[]) => mockGetMachineSummary(...args),
  // the real refusal and wording, so the route is checked against what it actually returns.
  heldRestartRefusal: jest.requireActual('@/lib/hoot-utils.server').heldRestartRefusal,
  HELD_RESTART_AUTONOMOUS_DETAIL: jest.requireActual('@/lib/hoot-utils.server').HELD_RESTART_AUTONOMOUS_DETAIL,
}));

const mockDispatchToolCall = jest.fn();
const mockDispatchExistingCommand = jest.fn();

jest.mock('@/lib/hoot/dispatch.server', () => ({
  dispatchToolCallAsSystem: (...args: unknown[]) => mockDispatchToolCall(...args),
  dispatchExistingCommandAsSystem: (...args: unknown[]) => mockDispatchExistingCommand(...args),
}));

jest.mock('@/lib/hoot-escalation.server', () => ({ escalate: jest.fn() }));

jest.mock('@/lib/securityBoundaryMetrics.server', () => ({
  emitSecurityBoundaryMetric: jest.fn(),
}));

// the real gate by default, which with PLAN_ENFORCEMENT unset answers before any read.
const mockRequireEntitlement = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  ...jest.requireActual('@/lib/plan.server'),
  requireEntitlement: (...args: unknown[]) => mockRequireEntitlement(...args),
}));

const mockGetToolsByTier = jest.fn();

jest.mock('@/lib/mcp-tools', () => {
  const actual = jest.requireActual('@/lib/mcp-tools');
  return {
    ...actual,
    getToolsByTier: (...args: unknown[]) => mockGetToolsByTier(...args),
  };
});

/* fake firestore */

const SITE = 'site-a';
const MACHINE = 'mach-1';

const docStore = new Map<string, Record<string, unknown>>();

interface FakeDocRef {
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (payload: Record<string, unknown>, options?: { merge?: boolean }) => Promise<void>;
  update: (payload: Record<string, unknown>) => Promise<void>;
}

function makeDocRef(path: string): FakeDocRef {
  return {
    get: async () => ({ exists: docStore.has(path), data: () => docStore.get(path) }),
    set: async (payload, options) => {
      docStore.set(path, options?.merge ? { ...(docStore.get(path) ?? {}), ...payload } : payload);
    },
    update: async (payload) => {
      docStore.set(path, { ...(docStore.get(path) ?? {}), ...payload });
    },
  };
}

interface FakeQuery {
  where: (...args: unknown[]) => FakeQuery;
  limit: (...args: unknown[]) => FakeQuery;
  get: () => Promise<{ empty: boolean; docs: unknown[] }>;
}

const hootEventsQuery: FakeQuery = {
  where: () => hootEventsQuery,
  limit: () => hootEventsQuery,
  get: async () => ({ empty: true, docs: [] }),
};

const mockDb = {
  doc: (path: string) => makeDocRef(path),
  collection: (path: string) => {
    if (path !== `sites/${SITE}/cortex-events`) throw new Error(`unexpected collection: ${path}`);
    return hootEventsQuery;
  },
  runTransaction: async (
    callback: (tx: {
      get: (ref: FakeDocRef) => ReturnType<FakeDocRef['get']>;
      set: (ref: FakeDocRef, payload: Record<string, unknown>, options?: { merge?: boolean }) => void;
    }) => Promise<unknown>,
  ) =>
    callback({
      get: (ref) => ref.get(),
      set: (ref, payload, options) => {
        void ref.set(payload, options);
      },
    }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import { POST } from '@/app/api/hoot/autonomous/route';
import { problemPlanRequired } from '@/lib/apiErrors';
import { SERVER_SIDE_TOOLS } from '@/lib/hoot-utils.server';
import type { McpToolDefinition } from '@/lib/mcp-tools';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';

const { requireEntitlement: realRequireEntitlement } = jest.requireActual('@/lib/plan.server');

const { getToolsByTier: realGetToolsByTier } = jest.requireActual('@/lib/mcp-tools') as {
  getToolsByTier: (maxTier: 1 | 2 | 3) => McpToolDefinition[];
};

/* helpers */

interface ExecutableTool {
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

function request(secret: string | null = 'test-secret'): NextRequest {
  return new NextRequest('http://localhost/api/hoot/autonomous', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-cortex-secret': secret }),
    },
    body: JSON.stringify({
      siteId: SITE,
      machineId: MACHINE,
      machineName: 'Lobby PC',
      eventType: 'process_crash',
      processName: 'TouchDesigner',
      errorMessage: 'exited with code 1',
    }),
  });
}

interface GenerateTextArgs {
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools: Record<string, ExecutableTool>;
  prepareStep?: unknown;
}

/**
 * Drive the route far enough for the background investigation to call
 * `generateText`, then return what it was called with.
 */
async function captureGenerateText(): Promise<GenerateTextArgs> {
  let resolveArgs: (args: GenerateTextArgs) => void = () => {};
  const argsPromise = new Promise<GenerateTextArgs>((resolve) => {
    resolveArgs = resolve;
  });

  mockGenerateText.mockImplementation(async (args: GenerateTextArgs) => {
    resolveArgs(args);
    return { text: 'OUTCOME: investigated', steps: [], response: { messages: [] } };
  });

  const res = await POST(request());
  expect(await res.json()).toMatchObject({ accepted: true });

  const args = await argsPromise;
  // Let the fire-and-forget investigation finish its writes before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  return args;
}

/** The tool set the investigation hands to `generateText`. */
async function buildTools(): Promise<Record<string, ExecutableTool>> {
  return (await captureGenerateText()).tools;
}

beforeEach(() => {
  jest.clearAllMocks();
  docStore.clear();
  process.env.CORTEX_INTERNAL_SECRET = 'test-secret';
  docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true });

  mockIsMachineOnline.mockResolvedValue(true);
  mockIsHootEnabled.mockResolvedValue(true);
  mockGetMachineSummary.mockResolvedValue({ id: MACHINE, online: true, hootEnabled: true, activeHoursGuard: false });
  // An unattended investigation has no author, so it spends the SITE OWNER's
  // key — there is no shared site key scope any more.
  mockResolveSiteKeyOwner.mockResolvedValue('owner-uid');
  mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', model: 'test' });
  mockGetToolsByTier.mockImplementation((maxTier: 1 | 2 | 3) => realGetToolsByTier(maxTier));
  mockExecuteServerSideTool.mockResolvedValue({ ok: true });
  mockDispatchToolCall.mockResolvedValue({ ok: true });
  mockDispatchExistingCommand.mockResolvedValue({ status: 'success' });
  mockRequireEntitlement.mockImplementation(realRequireEntitlement);
});

afterEach(() => {
  delete process.env.CORTEX_INTERNAL_SECRET;
});

/* tests */

describe('autonomous and the internal secret', () => {
  it.each([
    ['a wrong secret', 'test-secreT'],
    ['a longer one', 'test-secret-and-more'],
    ['a prefix of it', 'test-'],
    ['an empty one', ''],
    ['none', null],
  ])('refuses %s with a 401, before anything starts', async (_label, secret) => {
    const res = await POST(request(secret));

    expect(res.status).toBe(401);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect([...docStore.keys()]).toEqual([`sites/${SITE}/settings/cortex`]);
  });

  it('refuses everyone when the secret is not configured', async () => {
    delete process.env.CORTEX_INTERNAL_SECRET;

    expect((await POST(request(''))).status).toBe(401);
    expect((await POST(request(null))).status).toBe(401);
  });

  it('compares the secret in constant time', async () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect((await POST(request('test-secreT'))).status).toBe(401);
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      compare.mockRestore();
    }
  });
});

describe('autonomous and the payer plan', () => {
  it('skips quietly with a 200 when the payer lacks hoot', async () => {
    mockRequireEntitlement.mockResolvedValue(
      problemPlanRequired(PLAN_REQUIRED_DETAIL['owlette.hoot'], 'owlette.hoot'),
    );

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: false, reason: 'plan_required' });
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
    expect(mockGenerateText).not.toHaveBeenCalled();
    // no event, no session slot: nothing was started that could need cleaning up.
    expect([...docStore.keys()]).toEqual([`sites/${SITE}/settings/cortex`]);
  });

  it('looks no plan up for a site with autonomous mode off', async () => {
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: false });

    const res = await POST(request());

    expect(await res.json()).toEqual({ accepted: false, reason: 'autonomous_disabled' });
    expect(mockRequireEntitlement).not.toHaveBeenCalled();
  });

  it('accepts as before with enforcement off', async () => {
    await buildTools();
    expect(mockRequireEntitlement).toHaveBeenCalledWith(SITE, 'owlette.hoot');
  });
});

describe('autonomous advisor', () => {
  it('offers the default Claude model the Opus 5 advisor, capped per reply', async () => {
    mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'k' });

    const { tools, prepareStep } = await captureGenerateText();

    expect(tools).toHaveProperty('advisor');
    expect(prepareStep).toEqual(expect.any(Function));
  });

  it('offers a model outside the pairing table neither the advisor nor a cap', async () => {
    const { tools, prepareStep } = await captureGenerateText();

    expect(tools).not.toHaveProperty('advisor');
    expect(prepareStep).toBeUndefined();
  });
});

describe('autonomous tool dispatch routing', () => {
  it('executes get_site_logs server-side instead of relaying it to the agent', async () => {
    mockExecuteServerSideTool.mockResolvedValue({ logs: [{ message: 'crash' }] });

    const tools = await buildTools();
    const result = await tools.get_site_logs.execute({ limit: 10 });

    expect(mockExecuteServerSideTool).toHaveBeenCalledWith(
      mockDb,
      SITE,
      [MACHINE],
      'get_site_logs',
      { limit: 10 },
      { systemActor: 'cortex_autonomous' },
    );
    expect(result).toEqual({ logs: [{ message: 'crash' }] });
    expect(mockDispatchToolCall).not.toHaveBeenCalled();
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
  });

  it('routes every server-side tool in the built set through executeServerSideTool', async () => {
    const tools = await buildTools();
    const serverSideNames = Object.keys(tools).filter((name) => SERVER_SIDE_TOOLS.has(name));

    // The default tier ceiling (2) must still expose the process-CRUD tools
    // that regressed when they were relayed to the agent.
    expect(serverSideNames).toEqual(
      expect.arrayContaining(['get_site_logs', 'update_process', 'add_process', 'delete_process']),
    );

    // add and delete always change what the machine launches, so they stop at the gate.
    const runnable = serverSideNames.filter((name) => name !== 'add_process' && name !== 'delete_process');
    for (const name of runnable) {
      await tools[name].execute({});
    }

    expect(mockExecuteServerSideTool).toHaveBeenCalledTimes(runnable.length);
    expect(mockDispatchToolCall).not.toHaveBeenCalled();
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
  });

  it('routes an existing-command tool through dispatchExistingCommandAsSystem', async () => {
    const tools = await buildTools();
    await tools.restart_process.execute({ process_name: 'TouchDesigner' });

    expect(mockDispatchExistingCommand).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, machineId: MACHINE }),
      'restart_process',
      { process_name: 'TouchDesigner' },
    );
    expect(mockDispatchToolCall).not.toHaveBeenCalled();
    expect(mockExecuteServerSideTool).not.toHaveBeenCalled();
  });

  it('refuses a value out of its tool schema before any dispatch', async () => {
    const tools = await buildTools();

    await expect(tools.get_event_logs.execute({ log_name: 'Application; Get-Date' })).resolves.toMatchObject({
      ok: false,
      error: 'tool_params_invalid',
      detail: expect.stringContaining('log_name'),
    });
    await expect(tools.restart_process.execute({ process_name: 'x', evil: true })).resolves.toMatchObject({
      ok: false,
      error: 'tool_params_invalid',
      detail: expect.stringContaining('evil'),
    });

    expect(mockDispatchToolCall).not.toHaveBeenCalled();
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
  });

  it('routes a plain agent tool through dispatchToolCallAsSystem', async () => {
    const tools = await buildTools();
    await tools.get_system_info.execute({});

    expect(mockDispatchToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, machineId: MACHINE }),
      'get_system_info',
      {},
    );
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
    expect(mockExecuteServerSideTool).not.toHaveBeenCalled();
  });
});

describe('autonomous tool set exclusions', () => {
  /** Minimal stand-ins so the policy is testable independent of the registry. */
  function fakeTalonTool(name: string): McpToolDefinition {
    return {
      name,
      description: `fake ${name}`,
      tier: 2,
      parameters: { type: 'object', properties: {} },
    };
  }

  it('omits talon authoring + enable-toggle tools even when the registry offers them', async () => {
    mockGetToolsByTier.mockImplementation((maxTier: 1 | 2 | 3) => [
      ...realGetToolsByTier(maxTier),
      fakeTalonTool('create_talon'),
      fakeTalonTool('list_talons'),
      fakeTalonTool('set_talon_enabled'),
    ]);

    const tools = await buildTools();
    const names = Object.keys(tools);

    expect(names).not.toContain('create_talon');
    expect(names).not.toContain('set_talon_enabled');
    // Read-only talon inspection stays available to the investigator.
    expect(names).toContain('list_talons');
  });

  it('builds cleanly when the talon tools are absent from the registry', async () => {
    const tools = await buildTools();

    expect(Object.keys(tools)).not.toContain('create_talon');
    expect(Object.keys(tools).length).toBeGreaterThan(0);
  });
});

describe('autonomous and what a machine launches', () => {
  const expectNothingSent = () => {
    expect(mockExecuteServerSideTool).not.toHaveBeenCalled();
    expect(mockDispatchToolCall).not.toHaveBeenCalled();
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
  };

  it.each([
    ['update_process', { process_name: 'TouchDesigner', exe_path: 'C:\\evil.exe' }],
    ['update_process', { process_name: 'TouchDesigner', file_path: '--load evil.toe' }],
    ['update_process', { process_name: 'TouchDesigner', cwd: 'C:\\evil' }],
    ['add_process', { name: 'evil', exe_path: 'C:\\evil.exe' }],
    ['delete_process', { process_name: 'TouchDesigner' }],
    ['set_launch_mode', { process_name: 'TouchDesigner', mode: 'always' }],
  ] as Array<[string, Record<string, unknown>]>)(
    'refuses a prompt-injected %s %j, and sends nothing',
    async (name, input) => {
      const tools = await buildTools();

      const result = await tools[name].execute(input);

      expect(result).toMatchObject({ ok: false, error: 'launch_change_needs_approval', status: 403 });
      expectNothingSent();
    },
  );

  it('is not offered the tools whose job is what runs, at any maxTier', async () => {
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });

    const names = Object.keys(await buildTools());

    for (const name of ['manage_scheduled_task', 'manage_windows_service', 'registry_operation', 'create_talon', 'set_talon_enabled']) {
      expect(names).not.toContain(name);
    }
  });

  it.each(['run_command', 'run_powershell', 'run_python', 'execute_script', 'write_file', 'deploy_software'])(
    'refuses %s on a site that raised maxTier to 3, and sends nothing',
    async (name) => {
      docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });
      const tools = await buildTools();

      const result = await tools[name].execute({ command: 'calc.exe', script: 'calc', code: 'x', path: 'x', software_name: 'x' });

      expect(result).toMatchObject({ ok: false, error: 'launch_change_needs_approval' });
      expectNothingSent();
    },
  );

  it('still reboots on a site that raised maxTier to 3', async () => {
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });
    const tools = await buildTools();

    await tools.reboot_machine.execute({});

    expect(mockDispatchExistingCommand).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: MACHINE }),
      'reboot_machine',
      {},
    );
  });

  it('a rename and a restart still run', async () => {
    const tools = await buildTools();

    await tools.update_process.execute({ process_name: 'TouchDesigner', name: 'TD' });
    await tools.restart_process.execute({ process_name: 'TouchDesigner' });

    expect(mockExecuteServerSideTool).toHaveBeenCalledTimes(1);
    expect(mockDispatchExistingCommand).toHaveBeenCalledTimes(1);
  });
});

describe('autonomous and active hours', () => {
  const OVERRIDE_TOOLS = ['reboot_machine', 'shutdown_machine', 'deploy_software', 'manage_windows_update'];

  it("builds the prompt with the machine's timezone and whether its agent holds restarts, from one read", async () => {
    mockGetMachineSummary.mockResolvedValue({
      id: MACHINE,
      online: true,
      hootEnabled: true,
      timezone: 'America/New_York',
      activeHoursGuard: true,
    });
    await buildTools();

    expect(mockGetMachineSummary).toHaveBeenCalledTimes(1);
    expect(mockGetMachineSummary).toHaveBeenCalledWith(mockDb, SITE, MACHINE);
    expect(mockBuildAutonomousSystemPrompt).toHaveBeenCalledWith('', 'America/New_York', true);
  });

  it("hands the model the agent's report only as fenced data in the first message", async () => {
    const { system, messages } = await captureGenerateText();

    // nothing the agent sent is an argument to the system prompt.
    expect(JSON.stringify(mockBuildAutonomousSystemPrompt.mock.calls)).not.toMatch(/TouchDesigner|Lobby PC|exited/);
    expect(system).toBe('system prompt');
    expect(messages).toEqual([
      {
        role: 'user',
        content:
          'A process crashed. The agent\'s report:\n<untrusted-data source="agent event">\n' +
          '{"event":"crashed","process":"TouchDesigner","machine":"Lobby PC","error":"exited with code 1"}\n' +
          '</untrusted-data>',
      },
    ]);
  });

  it.each([
    ['a machine with no doc', () => Promise.resolve(null)],
    // the read failing is no reason to drop the investigation: utc, and nothing held, as before.
    ['a machine read that fails', () => Promise.reject(new Error('unavailable'))],
  ])('tells the prompt that %s holds nothing, and investigates anyway', async (_label, summary) => {
    mockGetMachineSummary.mockImplementation(summary);
    await buildTools();

    expect(mockBuildAutonomousSystemPrompt).toHaveBeenCalledWith('', undefined, false);
  });

  it('refuses a held restart its agent cannot hold, and sends nothing', async () => {
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });
    const tools = await buildTools();

    const result = await tools.reboot_machine.execute({ when: 'after_active_hours' });

    expect(result).toMatchObject({ ok: false, error: 'held_restart_unsupported' });
    const { detail } = result as { detail: string };
    expect(detail).toMatch(/older than owlette 4\.1\.21/);
    // nobody is there to ask, so it never reads as licence to restart now.
    expect(detail).toMatch(/nothing was sent\. don't restart it; report it in your summary\.$/);
    expect(detail).not.toMatch(/ask them/);
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
  });

  it('refuses a held restart on a machine rolled back below 4.1.21 that still carries the capability', async () => {
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });
    // the real summary over the machine doc, so the stale capability is judged as in production
    const { getMachineSummary } = jest.requireActual('@/lib/hoot-utils.server');
    const machineDoc = { online: true, agent_version: '3.3.7', capabilities: { activeHoursGuard: 1 } };
    const machineDb = {
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true, data: () => machineDoc }),
      }) }) }) }),
    };
    mockGetMachineSummary.mockImplementation((_db: unknown, siteId: string, machineId: string) =>
      getMachineSummary(machineDb, siteId, machineId),
    );
    const tools = await buildTools();

    const result = await tools.reboot_machine.execute({ when: 'after_active_hours' });

    expect(result).toMatchObject({ ok: false, error: 'held_restart_unsupported' });
    expect(mockDispatchExistingCommand).not.toHaveBeenCalled();
  });

  it('sends a held restart to an agent that holds it', async () => {
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });
    mockGetMachineSummary.mockResolvedValue({ id: MACHINE, online: true, hootEnabled: true, activeHoursGuard: true });
    const tools = await buildTools();

    await tools.reboot_machine.execute({ when: 'after_active_hours' });

    expect(mockDispatchExistingCommand).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: SITE, machineId: MACHINE }),
      'reboot_machine',
      { when: 'after_active_hours' },
    );
  });

  /** Each tool's schema as the investigator's model is offered it. */
  async function offeredProperties(): Promise<Record<string, Record<string, unknown>>> {
    // Tier 3, so the reboot, shutdown and deploy tools are on offer at all.
    docStore.set(`sites/${SITE}/settings/cortex`, { autonomousEnabled: true, maxTier: 3 });
    const tools = (await buildTools()) as unknown as Record<
      string,
      { inputSchema: { properties: Record<string, unknown> } }
    >;
    return Object.fromEntries(
      OVERRIDE_TOOLS.map((name) => [name, tools[name].inputSchema.properties]),
    );
  }

  it('offers no active-hours override: nobody is there to approve one', async () => {
    const offered = await offeredProperties();

    for (const name of OVERRIDE_TOOLS) {
      expect(offered[name]).not.toHaveProperty('override_active_hours');
      expect(offered[name]).not.toHaveProperty('reason');
    }
  });

  it('still offers a reboot that waits for active hours to end', async () => {
    const offered = await offeredProperties();

    expect(offered.reboot_machine).toHaveProperty('when');
  });

  it('refuses override names on a tool that never takes one, before it runs', async () => {
    const tools = await buildTools();

    const result = await tools.get_site_logs.execute({ override_active_hours: true, reason: 'now' });

    expect(result).toMatchObject({ ok: false, error: 'tool_params_invalid', detail: expect.stringContaining('override_active_hours') });
    expect(mockExecuteServerSideTool).not.toHaveBeenCalled();
  });

  it('hands a server-side tool no envelope option, so it can never carry an override', async () => {
    const tools = await buildTools();

    await tools.get_site_logs.execute({ limit: 10 });

    // The system actor and nothing else: no command envelope argument at all.
    expect(mockExecuteServerSideTool).toHaveBeenCalledWith(
      mockDb,
      SITE,
      [MACHINE],
      'get_site_logs',
      expect.any(Object),
      { systemActor: 'cortex_autonomous' },
    );
  });
});

describe('whose key an autonomous investigation spends', () => {
  it("resolves the SITE OWNER's key — there is no shared site key any more", async () => {
    await buildTools();

    expect(mockResolveSiteKeyOwner).toHaveBeenCalledWith(mockDb, SITE);
    // The uid, never a site: an unattended run has to name whose key it spends.
    expect(mockResolveLlmConfig).toHaveBeenCalledWith(mockDb, 'owner-uid');
  });
});
