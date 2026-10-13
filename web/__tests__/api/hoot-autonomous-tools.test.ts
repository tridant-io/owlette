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
 */

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

jest.mock('@/lib/llm', () => ({
  createModel: jest.fn(() => ({ id: 'test-model' })),
  buildAutonomousSystemPrompt: jest.fn(() => 'system prompt'),
}));

const mockExecuteServerSideTool = jest.fn();
const mockResolveLlmConfig = jest.fn();
const mockResolveSiteKeyOwner = jest.fn();
const mockIsMachineOnline = jest.fn();
const mockIsHootEnabled = jest.fn();

jest.mock('@/lib/hoot-utils.server', () => ({
  // Real membership: the branch under test keys off this exact set, so the
  // sibling tools a future wave adds to it are covered without editing here.
  SERVER_SIDE_TOOLS: jest.requireActual('@/lib/hoot-utils.server').SERVER_SIDE_TOOLS,
  executeServerSideTool: (...args: unknown[]) => mockExecuteServerSideTool(...args),
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
  resolveSiteKeyOwner: (...args: unknown[]) => mockResolveSiteKeyOwner(...args),
  isMachineOnline: (...args: unknown[]) => mockIsMachineOnline(...args),
  isHootEnabled: (...args: unknown[]) => mockIsHootEnabled(...args),
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

function request(): NextRequest {
  return new NextRequest('http://localhost/api/hoot/autonomous', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cortex-secret': 'test-secret' },
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

    for (const name of serverSideNames) {
      await tools[name].execute({});
    }

    expect(mockExecuteServerSideTool).toHaveBeenCalledTimes(serverSideNames.length);
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

describe('whose key an autonomous investigation spends', () => {
  it("resolves the SITE OWNER's key — there is no shared site key any more", async () => {
    await buildTools();

    expect(mockResolveSiteKeyOwner).toHaveBeenCalledWith(mockDb, SITE);
    // The uid, never a site: an unattended run has to name whose key it spends.
    expect(mockResolveLlmConfig).toHaveBeenCalledWith(mockDb, 'owner-uid');
  });
});
