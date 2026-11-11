/** @jest-environment node */

/**
 * The conversations API surface must not expose the follow-up tools: its chatId
 * is a `chat_conversations` id, and the follow-up sweep resolves `chats/{chatId}`,
 * so a follow-up scheduled there could never fire (fails closed at fire time).
 *
 * The site-mode suite below mocks the module boundary only — Firestore reads,
 * the llm and the AI SDK — so the dispatch decision this file owns (which
 * machines a site-wide turn relays tools to) runs for real.
 */

const mockVerifyUserSiteAccess = jest.fn();
const mockListSiteMachines = jest.fn();
const mockBuildExecutableTools = jest.fn();
const mockResolveLlmConfig = jest.fn();
const mockGetHootRequireTier3Approval = jest.fn();
const mockIsMachineOnline = jest.fn();
const mockIsHootEnabled = jest.fn();
const mockGetMachineSummary = jest.fn();

jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
  resolveHootMaxTier: () => 3,
  listSiteMachines: (...args: unknown[]) => mockListSiteMachines(...args),
  isMachineOnline: (...args: unknown[]) => mockIsMachineOnline(...args),
  isHootEnabled: (...args: unknown[]) => mockIsHootEnabled(...args),
  getMachineSummary: (...args: unknown[]) => mockGetMachineSummary(...args),
  getHootRequireTier3Approval: (...args: unknown[]) => mockGetHootRequireTier3Approval(...args),
  buildExecutableTools: (...args: unknown[]) => mockBuildExecutableTools(...args),
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
}));

jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: jest.fn(() => ({ modelId: 'stub' })),
  buildSystemPrompt: jest.fn(() => 'system prompt'),
}));

jest.mock('@/lib/hoot/advisor', () => ({
  __esModule: true,
  withAdvisor: jest.fn(() => ({ tools: {} })),
}));

jest.mock('ai', () => ({
  __esModule: true,
  streamText: jest.fn(() => ({ toUIMessageStreamResponse: () => new Response('') })),
  stepCountIs: jest.fn((count: number) => count),
  // what the real tools builder wraps each tool in; identity keeps them readable.
  tool: jest.fn((definition: unknown) => definition),
  jsonSchema: jest.fn((schema: unknown) => schema),
}));

// the real tools builder pulls in the admin sdk; nothing here reaches Firestore.
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));

import type { Firestore } from 'firebase-admin/firestore';
import { streamText } from 'ai';
import {
  conversationsToolDefs,
  runHootStream,
  SITE_TARGET_ID as REEXPORTED_SITE_TARGET_ID,
} from '@/lib/hootStream.server';
import { withAdvisor } from '@/lib/hoot/advisor';
import { SITE_TARGET_ID } from '@/lib/hoot/target';
import { buildSystemPrompt } from '@/lib/llm';
import { getToolsByTier } from '@/lib/mcp-tools';

const FOLLOWUP_TOOLS = ['schedule_followup', 'cancel_followup'];

/** `verifyUserSiteAccess` for an admin of the whole site. */
const WHOLE_SITE_ADMIN = {
  role: 'admin',
  siteRole: 'admin',
  swoopMode: null,
  standing: { role: 'admin', swoopMode: null, machineIds: null },
  isSuperadmin: false,
  isSiteAdmin: true,
  isSiteOwner: false,
};

describe('conversationsToolDefs', () => {
  it.each([1, 2, 3] as const)('withholds the follow-up tools at tier %d', (tier) => {
    const names = conversationsToolDefs(tier).map((def) => def.name);
    for (const tool of FOLLOWUP_TOOLS) {
      expect(names).not.toContain(tool);
    }
  });

  it('negative control: the unfiltered tier-1 list DOES carry both tools', () => {
    // If a rename ever empties the filter set, this fails before the filter
    // silently becomes a no-op.
    const names = getToolsByTier(1).map((def) => def.name);
    for (const tool of FOLLOWUP_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it('withholds ONLY the follow-up tools — everything else passes through', () => {
    const filtered = conversationsToolDefs(3).map((def) => def.name);
    const unfiltered = getToolsByTier(3).map((def) => def.name);
    expect(new Set([...filtered, ...FOLLOWUP_TOOLS])).toEqual(new Set(unfiltered));
    expect(unfiltered.length - filtered.length).toBe(FOLLOWUP_TOOLS.length);
  });
});

/**
 * The sentinel's VALUE is data at rest, not a free-floating constant: it is
 * already written into `chats/{id}.targetMachineId`, into `cortex-followups`
 * `machineId` and onto stream records. Editing the literal would strand every
 * document holding the old string, so the string itself is pinned here — every
 * other suite spells it `SITE_TARGET_ID` and stays green through a rename.
 */
describe('SITE_TARGET_ID', () => {
  it('is exactly the stored sentinel string', () => {
    expect(SITE_TARGET_ID).toBe('__site__');
  });

  it("hootStream.server's re-export is the same value, not a second copy", () => {
    // Both conversation routes import the sentinel from `hootStream.server`, so a
    // local redefinition there would split the site target in two.
    expect(REEXPORTED_SITE_TARGET_ID).toBe(SITE_TARGET_ID);
    expect(REEXPORTED_SITE_TARGET_ID).toBe('__site__');
  });
});

/**
 * The one carve-out from the public-API freeze (D-A, confirmed 2026-09-11): a
 * site-wide turn no longer relays tool calls to machines whose hoot kill switch
 * is off. The response shape is untouched — only which machines are dispatched
 * to — and `buildExecutableTools`' fan-out list is where that decision lands.
 */
describe('runHootStream site mode', () => {
  /** The tools builder's 7th positional argument: the fan-out machine list. */
  const FANOUT_ARG = 6;

  function machine(id: string, online: boolean, hootEnabled: boolean, activeHoursGuard = false) {
    return { id, online, hootEnabled, activeHoursGuard };
  }

  /**
   * `runSiteWideMode` reaches the tools builder a couple of awaits after
   * `runHootStream` resolves (the stream body is pumped lazily), so the
   * assertion has to let the microtask queue drain first.
   */
  async function settle(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function send() {
    return runHootStream({
      db: {} as unknown as Firestore,
      userId: 'u1',
      siteId: 'site-a',
      machineId: SITE_TARGET_ID,
      machineName: 'site',
      messages: [],
      chatId: 'conv-1',
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserSiteAccess.mockResolvedValue(WHOLE_SITE_ADMIN);
    mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    mockGetHootRequireTier3Approval.mockResolvedValue(true);
    mockBuildExecutableTools.mockReturnValue({});
  });

  it('fans out only to machines that are online AND have hoot enabled', async () => {
    mockListSiteMachines.mockResolvedValue([
      machine('m1', true, true),
      machine('m2', true, false),
      machine('m3', false, true),
      machine('m4', true, true),
    ]);

    const result = await send();
    await settle();

    expect(result.ok).toBe(true);
    expect(mockBuildExecutableTools).toHaveBeenCalledTimes(1);
    expect(mockBuildExecutableTools.mock.calls[0][FANOUT_ARG]).toEqual(['m1', 'm4']);
  });

  it('refuses with 423 when every online machine has hoot switched off', async () => {
    // Not the 503 "nothing is online" copy: these machines ARE online, and the
    // fix is to turn hoot back on — which that message would hide. 423 is
    // already this operation's documented hoot-disabled status.
    mockListSiteMachines.mockResolvedValue([
      machine('m1', true, false),
      machine('m2', false, true),
    ]);

    const result = await send();

    expect(result).toEqual({
      ok: false,
      status: 423,
      error:
        'hoot is disabled on every online machine in this site. re-enable it from the hoot header to deliver tool calls.',
    });
    expect(mockBuildExecutableTools).not.toHaveBeenCalled();
  });

  it('still refuses with the unchanged 503 when nothing in the site is online', async () => {
    // Offline is classified first, so a sleeping site keeps the exact message
    // (and status) the public API has always returned.
    mockListSiteMachines.mockResolvedValue([
      machine('m1', false, true),
      machine('m2', false, false),
    ]);

    const result = await send();

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: 'no machines are currently online in this site.',
    });
    expect(mockBuildExecutableTools).not.toHaveBeenCalled();
  });

  it('reads the site once, not twice per machine', async () => {
    // The kill switch comes off the same listing as `online`; a per-machine
    // `isHootEnabled` pass would cost a document read per machine on a path
    // that already fans out one command each.
    mockListSiteMachines.mockResolvedValue([machine('m1', true, true)]);

    await send();
    await settle();

    expect(mockListSiteMachines).toHaveBeenCalledTimes(1);
  });

  it("tells the model the site's local time", async () => {
    mockListSiteMachines.mockResolvedValue([machine('m1', true, true)]);
    const siteDb = {
      collection: () => ({
        doc: () => ({ get: async () => ({ data: () => ({ timezone: 'Asia/Tokyo' }) }) }),
      }),
    } as unknown as Firestore;

    await runHootStream({
      db: siteDb,
      userId: 'u1',
      siteId: 'site-a',
      machineId: SITE_TARGET_ID,
      machineName: 'site',
      messages: [],
      chatId: 'conv-1',
    });
    await settle();

    expect(buildSystemPrompt).toHaveBeenCalledWith(
      '',
      true,
      undefined,
      { scope: 'site', timeZone: 'Asia/Tokyo' },
      { machineIds: ['m1'], guardedIds: [] },
    );
  });

  it('tells the tools and the model which dispatched agents hold a restart for active hours', async () => {
    mockListSiteMachines.mockResolvedValue([
      machine('m1', true, true, true),
      // guarded, but hoot is off on it, so it is not a target
      machine('m2', true, false, true),
      machine('m3', true, true),
      machine('m4', false, true, true),
    ]);

    await send();
    await settle();

    expect(mockBuildExecutableTools.mock.calls[0][FANOUT_ARG]).toEqual(['m1', 'm3']);
    expect(mockBuildExecutableTools.mock.calls[0][7]).toMatchObject({ activeHoursGuardIds: ['m1'] });
    expect((buildSystemPrompt as jest.Mock).mock.calls[0][4]).toEqual({ machineIds: ['m1', 'm3'], guardedIds: ['m1'] });
  });
});

describe('runHootStream single-machine mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserSiteAccess.mockResolvedValue(WHOLE_SITE_ADMIN);
    mockIsMachineOnline.mockResolvedValue(true);
    mockIsHootEnabled.mockResolvedValue(true);
    // the gate on keeps this turn on the server-side llm path.
    mockGetHootRequireTier3Approval.mockResolvedValue(true);
    mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    mockBuildExecutableTools.mockReturnValue({});
  });

  const db = {} as unknown as Firestore;

  /** hoot-utils' real summary of one machine doc, so a stale capability is judged as in production. */
  function realMachineSummary(data: Record<string, unknown>) {
    const { getMachineSummary } = jest.requireActual('@/lib/hoot-utils.server');
    const machineDb = {
      collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({
        get: async () => ({ exists: true, data: () => data }),
      }) }) }) }),
    };
    return getMachineSummary(machineDb, 'site-a', 'kiosk-01');
  }

  function send() {
    return runHootStream({
      db,
      userId: 'u1',
      siteId: 'site-a',
      machineId: 'kiosk-01',
      machineName: 'Lobby',
      messages: [],
      chatId: 'conv-1',
    });
  }

  it("tells the model the machine's local time, and that its agent holds restarts, from one read", async () => {
    mockGetMachineSummary.mockResolvedValue({
      id: 'kiosk-01',
      online: true,
      hootEnabled: true,
      timezone: 'America/New_York',
      activeHoursGuard: true,
    });

    const result = await send();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.ok).toBe(true);
    expect(mockGetMachineSummary).toHaveBeenCalledTimes(1);
    expect(mockGetMachineSummary).toHaveBeenCalledWith(db, 'site-a', 'kiosk-01');
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      'Lobby',
      false,
      [],
      { scope: 'machine', timeZone: 'America/New_York' },
      { machineIds: ['kiosk-01'], guardedIds: ['kiosk-01'] },
    );
    expect(mockBuildExecutableTools.mock.calls[0][7]).toMatchObject({ activeHoursGuardIds: ['kiosk-01'] });
  });

  it.each([
    ['an agent that does not hold restarts', () => Promise.resolve({ id: 'kiosk-01', online: true, hootEnabled: true, activeHoursGuard: false })],
    ['a machine with no doc', () => Promise.resolve(null)],
    // the read failing is no reason to fail the turn: utc, and nothing held, as before.
    ['a machine read that fails', () => Promise.reject(new Error('unavailable'))],
    // the real summary: an older agent never clears the capability its newer self wrote
    ['a machine rolled back to 3.3.7 that still carries the capability', () =>
      realMachineSummary({ online: true, agent_version: '3.3.7', capabilities: { activeHoursGuard: 1 } })],
  ])('tells the tools and the model about %s', async (_label, summary) => {
    mockGetMachineSummary.mockImplementation(summary);

    await send();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(buildSystemPrompt).toHaveBeenCalledWith(
      'Lobby',
      false,
      [],
      { scope: 'machine', timeZone: undefined },
      { machineIds: ['kiosk-01'], guardedIds: [] },
    );
    expect(mockBuildExecutableTools.mock.calls[0][7]).toMatchObject({ activeHoursGuardIds: [] });
  });
});

/**
 * Local hoot streams its own line frames from the agent's Firestore doc and saves
 * the reply itself once the agent marks it complete. An agent error is answered as
 * an error and never saved as hoot's reply.
 */
describe('runHootStream on local hoot', () => {
  let pushSnapshot: (data: Record<string, unknown>) => void;
  const unsubscribe = jest.fn();
  let setTimeoutSpy: jest.SpyInstance;
  let clearTimeoutSpy: jest.SpyInstance;

  /** the 60 s wait for the agent was cleared, not left to fire on a closed stream. */
  function expectAgentWaitCleared() {
    const index = setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 60_000);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[index].value);
  }

  /** the machine doc, with local hoot alive, and the agent's active-chat doc under it. */
  const doc: Record<string, unknown> = {
    collection: () => doc,
    doc: () => doc,
    get: async () => ({ exists: true, data: () => ({ cortexStatus: { online: true, lastHeartbeat: new Date() } }) }),
    set: async () => undefined,
    onSnapshot: (next: (snapshot: { data: () => unknown }) => void) => {
      pushSnapshot = (data) => next({ data: () => data });
      return unsubscribe;
    },
  };

  /** what the agent writes when its turn fails: `write_error_response` in `agent/src/cortex_firestore.py`. */
  const agentError = { status: 'error', response: { content: 'Error: invalid x-api-key', complete: true } };

  async function send() {
    const onAssistantText = jest.fn();
    const result = await runHootStream({
      db: doc as unknown as Firestore,
      userId: 'u1',
      siteId: 'site-a',
      machineId: 'kiosk-01',
      machineName: 'Lobby',
      messages: [{ role: 'user', content: 'how is the lobby?' }],
      chatId: 'conv-1',
      onAssistantText,
    });
    if (!result.ok) throw new Error(result.error);
    return { response: result.response, onAssistantText };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserSiteAccess.mockResolvedValue(WHOLE_SITE_ADMIN);
    mockIsMachineOnline.mockResolvedValue(true);
    mockIsHootEnabled.mockResolvedValue(true);
    // the gate off lets a site admin's turn run on the agent.
    mockGetHootRequireTier3Approval.mockResolvedValue(false);
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("saves the agent's finished reply once", async () => {
    const { response, onAssistantText } = await send();

    pushSnapshot({ status: 'streaming', response: { content: 'cpu is ', complete: false } });
    pushSnapshot({ status: 'complete', response: { content: 'cpu is at 12%', complete: true } });
    const body = await response.text();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(body).toBe('0:"cpu is "\n0:"at 12%"\nd:{"finishReason":"stop"}\n');
    expect(mockResolveLlmConfig).not.toHaveBeenCalled();
    expect(onAssistantText.mock.calls).toEqual([['cpu is at 12%']]);
  });

  it.each([
    ['before any text', [], '3:"Error: invalid x-api-key"\n'],
    [
      'part-way through a reply',
      [{ status: 'streaming', response: { content: 'cpu is ', complete: false } }],
      '0:"cpu is "\n3:"Error: invalid x-api-key"\n',
    ],
  ])("answers the agent's error %s as an error, and saves nothing", async (_label, before, expected) => {
    const { response, onAssistantText } = await send();

    for (const snapshot of before) pushSnapshot(snapshot);
    // firestore calls the listener with no try around it, so it must not throw
    expect(() => pushSnapshot(agentError)).not.toThrow();
    const body = await response.text();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(body).toBe(expected);
    expect(onAssistantText).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expectAgentWaitCleared();
  });
});

/**
 * Nobody approves a conversations API call in a dashboard chat, so it can never
 * carry an active-hours override: its tools are built without
 * `allowActiveHoursOverride`, and the schemas the model gets lack the flag.
 */
describe('runHootStream never offers an active-hours override', () => {
  /** The tools builder's 8th positional argument: its options. */
  const OPTIONS_ARG = 7;
  const OVERRIDE_TOOLS = ['reboot_machine', 'shutdown_machine', 'deploy_software', 'manage_windows_update'];

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserSiteAccess.mockResolvedValue(WHOLE_SITE_ADMIN);
    mockListSiteMachines.mockResolvedValue([{ id: 'm1', online: true, hootEnabled: true, activeHoursGuard: true }]);
    mockGetMachineSummary.mockResolvedValue({ id: 'kiosk-01', online: true, hootEnabled: true, activeHoursGuard: true });
    mockIsMachineOnline.mockResolvedValue(true);
    mockIsHootEnabled.mockResolvedValue(true);
    mockGetHootRequireTier3Approval.mockResolvedValue(true);
    mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    // the real builder, so the schemas checked are the ones the model is handed.
    mockBuildExecutableTools.mockImplementationOnce(
      jest.requireActual('@/lib/hoot-utils.server').buildExecutableTools,
    );
    (withAdvisor as jest.Mock).mockImplementationOnce((_config: unknown, tools: unknown) => ({ tools }));
  });

  it.each([
    ['a single-machine turn', 'kiosk-01'],
    ['a site-wide turn', SITE_TARGET_ID],
  ])('%s', async (_label, machineId) => {
    const result = await runHootStream({
      db: {} as unknown as Firestore,
      userId: 'u1',
      siteId: 'site-a',
      machineId,
      machineName: 'Lobby',
      messages: [],
      chatId: 'conv-1',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.ok).toBe(true);
    expect(mockBuildExecutableTools).toHaveBeenCalledTimes(1);
    expect(mockBuildExecutableTools.mock.calls[0][OPTIONS_ARG]).not.toHaveProperty('allowActiveHoursOverride');
    const { tools } = (streamText as jest.Mock).mock.calls[0][0];
    for (const toolName of OVERRIDE_TOOLS) {
      expect(tools[toolName].inputSchema.properties).not.toHaveProperty('override_active_hours');
      expect(tools[toolName].inputSchema.properties).not.toHaveProperty('reason');
    }
  });
});

/**
 * a scoped caller reaches only their machines through both conversation routes:
 * site mode is the machines in their scope, a machine outside it is a 404 before
 * anything about it is read, and the model never sees a tool that spans the site.
 */
describe('runHootStream for someone limited to some machines', () => {
  const FANOUT_ARG = 6;
  const OPTIONS_ARG = 7;
  const SITE_WIDE_TOOLS = ['get_site_logs', 'deploy_software', 'create_talon', 'list_talons', 'set_talon_enabled'];

  const machineDocs = [
    { id: 'm1', data: () => ({ online: true }) },
    { id: 'm2', data: () => ({ online: true }) },
    { id: 'm3', data: () => ({ online: false }) },
  ];
  /** `sites/site-a` and its machines, for the real listing. */
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({ data: () => ({}) }),
        collection: () => ({ get: async () => ({ docs: machineDocs }) }),
      }),
    }),
  } as unknown as Firestore;

  function send(machineId: string) {
    return runHootStream({ db, userId: 'u1', siteId: 'site-a', machineId, machineName: 'Lobby', messages: [], chatId: 'conv-1' });
  }

  const actual = jest.requireActual('@/lib/hoot-utils.server');

  /** the real tools builder, whose tools reach the model as built. */
  function realTools() {
    mockBuildExecutableTools.mockImplementationOnce(actual.buildExecutableTools);
    (withAdvisor as jest.Mock).mockImplementationOnce((_config: unknown, tools: unknown) => ({ tools }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserSiteAccess.mockResolvedValue({
      ...WHOLE_SITE_ADMIN,
      standing: { role: 'admin', swoopMode: null, machineIds: ['m1', 'm3'] },
    });
    mockIsMachineOnline.mockResolvedValue(true);
    mockIsHootEnabled.mockResolvedValue(true);
    mockGetMachineSummary.mockResolvedValue(null);
    mockGetHootRequireTier3Approval.mockResolvedValue(true);
    mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    // the real listing, so the scope is applied as in production
    mockListSiteMachines.mockImplementation(actual.listSiteMachines);
  });

  it('dispatches a site-wide turn only to the online machines in scope, with no site-wide tool', async () => {
    realTools();

    const result = await send(SITE_TARGET_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.ok).toBe(true);
    expect(mockListSiteMachines).toHaveBeenCalledWith(db, 'site-a', ['m1', 'm3']);
    // m2 is online but outside the scope; m3 is in it but offline
    expect(mockBuildExecutableTools.mock.calls[0][FANOUT_ARG]).toEqual(['m1']);
    // the conversations API builds no site standing, as before, but still passes the scope
    const options = mockBuildExecutableTools.mock.calls[0][OPTIONS_ARG];
    expect(options).toMatchObject({ machineScope: ['m1', 'm3'] });
    expect(options).not.toHaveProperty('userStanding');
    const { tools } = (streamText as jest.Mock).mock.calls[0][0];
    for (const toolName of SITE_WIDE_TOOLS) expect(tools).not.toHaveProperty(toolName);
    expect(tools).toHaveProperty('get_system_info');
    expect((buildSystemPrompt as jest.Mock).mock.calls[0][4]).toEqual({ machineIds: ['m1'], guardedIds: [] });
  });

  it('answers a site with nothing online in scope as a sleeping site', async () => {
    mockVerifyUserSiteAccess.mockResolvedValue({
      ...WHOLE_SITE_ADMIN,
      standing: { role: 'admin', swoopMode: null, machineIds: ['m3'] },
    });

    await expect(send(SITE_TARGET_ID)).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'no machines are currently online in this site.',
    });
    expect(mockBuildExecutableTools).not.toHaveBeenCalled();
  });

  it('refuses a machine outside the scope with 404, before any machine read', async () => {
    await expect(send('m2')).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'machine not found or no access',
    });
    expect(mockIsMachineOnline).not.toHaveBeenCalled();
    expect(mockIsHootEnabled).not.toHaveBeenCalled();
    expect(mockGetMachineSummary).not.toHaveBeenCalled();
    expect(mockBuildExecutableTools).not.toHaveBeenCalled();
  });

  it('serves a machine in scope as before, still with no site-wide tool', async () => {
    realTools();

    const result = await send('m1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.ok).toBe(true);
    expect(mockIsMachineOnline).toHaveBeenCalledWith(db, 'site-a', 'm1');
    expect(mockBuildExecutableTools.mock.calls[0][OPTIONS_ARG]).toMatchObject({ machineScope: ['m1', 'm3'] });
    const { tools } = (streamText as jest.Mock).mock.calls[0][0];
    for (const toolName of SITE_WIDE_TOOLS) expect(tools).not.toHaveProperty(toolName);
  });

  it('leaves the whole site unchanged', async () => {
    mockVerifyUserSiteAccess.mockResolvedValue(WHOLE_SITE_ADMIN);
    realTools();

    await send(SITE_TARGET_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mockListSiteMachines).toHaveBeenCalledWith(db, 'site-a', null);
    expect(mockBuildExecutableTools.mock.calls[0][FANOUT_ARG]).toEqual(['m1', 'm2']);
    const { tools } = (streamText as jest.Mock).mock.calls[0][0];
    for (const toolName of SITE_WIDE_TOOLS) expect(tools).toHaveProperty(toolName);
  });
});
