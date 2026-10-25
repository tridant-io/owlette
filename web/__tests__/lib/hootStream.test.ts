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
const mockGetMachineTimezone = jest.fn();

jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
  resolveHootMaxTier: () => 3,
  listSiteMachines: (...args: unknown[]) => mockListSiteMachines(...args),
  isMachineOnline: (...args: unknown[]) => mockIsMachineOnline(...args),
  isHootEnabled: (...args: unknown[]) => mockIsHootEnabled(...args),
  getHootRequireTier3Approval: (...args: unknown[]) => mockGetHootRequireTier3Approval(...args),
  buildExecutableTools: (...args: unknown[]) => mockBuildExecutableTools(...args),
  resolveLlmConfig: (...args: unknown[]) => mockResolveLlmConfig(...args),
}));

jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: jest.fn(() => ({ modelId: 'stub' })),
  buildSystemPrompt: jest.fn(() => 'system prompt'),
}));

jest.mock('@/lib/adminUtils.server', () => ({
  __esModule: true,
  getMachineTimezone: (...args: unknown[]) => mockGetMachineTimezone(...args),
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

  function machine(id: string, online: boolean, hootEnabled: boolean) {
    return { id, online, hootEnabled };
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
    mockVerifyUserSiteAccess.mockResolvedValue({
      role: 'admin',
      siteRole: 'admin',
      isSuperadmin: false,
      isSiteAdmin: true,
      isSiteOwner: false,
    });
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

    expect(buildSystemPrompt).toHaveBeenCalledWith('', true, undefined, {
      scope: 'site',
      timeZone: 'Asia/Tokyo',
    });
  });
});

describe('runHootStream single-machine mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyUserSiteAccess.mockResolvedValue({
      role: 'admin',
      siteRole: 'admin',
      isSuperadmin: false,
      isSiteAdmin: true,
      isSiteOwner: false,
    });
    mockIsMachineOnline.mockResolvedValue(true);
    mockIsHootEnabled.mockResolvedValue(true);
    // the gate on keeps this turn on the server-side llm path.
    mockGetHootRequireTier3Approval.mockResolvedValue(true);
    mockResolveLlmConfig.mockResolvedValue({ provider: 'anthropic', apiKey: 'k', model: 'm' });
    mockBuildExecutableTools.mockReturnValue({});
  });

  it("tells the model the machine's local time", async () => {
    mockGetMachineTimezone.mockResolvedValue('America/New_York');

    const result = await runHootStream({
      db: {} as unknown as Firestore,
      userId: 'u1',
      siteId: 'site-a',
      machineId: 'kiosk-01',
      machineName: 'Lobby',
      messages: [],
      chatId: 'conv-1',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result.ok).toBe(true);
    expect(mockGetMachineTimezone).toHaveBeenCalledWith('site-a', 'kiosk-01');
    expect(buildSystemPrompt).toHaveBeenCalledWith('Lobby', false, [], {
      scope: 'machine',
      timeZone: 'America/New_York',
    });
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
    mockVerifyUserSiteAccess.mockResolvedValue({
      role: 'admin',
      siteRole: 'admin',
      isSuperadmin: false,
      isSiteAdmin: true,
      isSiteOwner: false,
    });
    mockListSiteMachines.mockResolvedValue([{ id: 'm1', online: true, hootEnabled: true }]);
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
