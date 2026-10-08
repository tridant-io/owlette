/** @jest-environment node */

/**
 * Unit tests for `web/lib/hoot/turnRunner.server.ts` (hoot-async-turns wave 2.2).
 * Drives `startTurn` end-to-end with a MockLanguageModelV3 over the real streamText /
 * createUIMessageStream plumbing against an in-memory firestore, pinning: turn-store
 * snapshots + final persist + categorize for new chats, no title/categorize overwrite for
 * existing ones, site-wide persist shape + fan-out, transient data-heartbeat chunks,
 * the toolCommand recovery index (Task 2.1 toolCallbacks), history repair from
 * `commands/completed`, error paths (finishTurn('error'), no persist), superseded
 * turns skipping the final persist, and the Claude 5 advisor tool reaching (or kept
 * from) the model.
 *
 * Plus the per-turn target contract: the caller hands over a resolved machine set
 * and the runner may only NARROW it against the live site listing, records what
 * survived before it dispatches, stamps it onto the assistant message, and writes
 * the chat's selection only for a turn that carries one.
 */

import {
  jsonSchema,
  tool,
  type InferUIMessageChunk,
  type UIMessage,
} from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import {
  LOST_RESULT_ERROR,
  STILL_RUNNING_ERROR,
} from '@/lib/hoot/repairMessages';

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

jest.mock('@/lib/hoot/turnStore.server', () => ({
  __esModule: true,
  writeSnapshot: jest.fn(),
  touch: jest.fn(),
  recordToolCommand: jest.fn(),
  recordResolvedMachines: jest.fn(),
  finishTurn: jest.fn(),
  // Real: `pendingApprovals` is this function's output by definition, and a
  // stand-in here would drift from what the resume binding actually checks.
  approvalRequestedIds: jest.requireActual('@/lib/hoot/turnStore.server').approvalRequestedIds,
}));

jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  resolveLlmConfig: jest.fn(),
  getHootRequireTier3Approval: jest.fn(),
  listSiteMachines: jest.fn(),
  resolveHootMaxTier: jest.fn(),
  buildExecutableTools: jest.fn(),
}));

jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: jest.fn(),
  createCheapModel: jest.fn(),
  buildHootSystemPrompt: jest.fn(),
}));

jest.mock('@/lib/mcp-tools', () => ({
  __esModule: true,
  getToolsByTier: jest.fn(),
}));

jest.mock('@/lib/hoot/categorizeChat.server', () => ({
  __esModule: true,
  categorizeNewChat: jest.fn(),
}));

// the plan gate reads the payer through the admin sdk; it lands on the same in-memory store.
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: () => fakeDb,
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  __esModule: true,
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

import * as turnStore from '@/lib/hoot/turnStore.server';
import * as hootUtils from '@/lib/hoot-utils.server';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';
import type { SiteMachineSummary } from '@/lib/hoot-utils.server';
import * as llm from '@/lib/llm';
import { getToolsByTier } from '@/lib/mcp-tools';
import { categorizeNewChat } from '@/lib/hoot/categorizeChat.server';
import type { PriorTurn, ResolvedTargets } from '@/lib/hoot/target';
import {
  startTurn,
  _setTurnTimingForTests,
  type StartTurnParams,
} from '@/lib/hoot/turnRunner.server';

type Store = Record<string, Record<string, unknown>>;
const store: Store = {};

function docRef(path: string) {
  return {
    get: async () => {
      const data = store[path];
      return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
    },
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      store[path] = opts?.merge ? { ...(store[path] ?? {}), ...data } : { ...data };
    },
    update: async (patch: Record<string, unknown>) => {
      if (!store[path]) throw new Error(`update on missing doc: ${path}`);
      store[path] = { ...store[path], ...patch };
    },
    collection: (name: string) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(path: string) {
  return { doc: (id: string) => docRef(`${path}/${id}`) };
}

const fakeDb = {
  collection: (name: string) => collectionRef(name),
} as unknown as FirebaseFirestore.Firestore;

const CHAT_ID = 'chat_1';
const TURN_ID = 'turn_1';
const SITE_ID = 'site-A';
const MACHINE_ID = 'machine-1';
const CHAT_PATH = `chats/${CHAT_ID}`;

/** The site as the runner sees it at turn start; tests override per case. */
function siteListing(
  overrides: Array<Partial<SiteMachineSummary> & { id: string }> = [],
): SiteMachineSummary[] {
  const base: SiteMachineSummary[] = [
    { id: 'machine-1', online: true, hootEnabled: true },
    { id: 'machine-2', online: true, hootEnabled: true },
    { id: 'machine-3', online: true, hootEnabled: true },
  ];
  return base.map((machine) => {
    const override = overrides.find((entry) => entry.id === machine.id);
    return override ? { ...machine, ...override } : machine;
  });
}

function resolvedOn(ids: string[], fanOut = ids.length !== 1): ResolvedTargets {
  return { ids, fanOut, skipped: { offline: [], disabled: [] } };
}

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

function assistantMsg(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage;
}

function baseParams(overrides: Partial<StartTurnParams> = {}): StartTurnParams {
  return {
    chatId: CHAT_ID,
    turnId: TURN_ID,
    siteId: SITE_ID,
    messages: [userMsg('u1', 'check the cpu')],
    userId: 'user-1',
    access: { role: 'admin', isSuperadmin: false, isSiteAdmin: true, isSiteOwner: true },
    resolved: resolvedOn([MACHINE_ID]),
    turnTarget: { machineIds: [MACHINE_ID], fanOut: false, source: 'chat' },
    chatTarget: { machineIds: [MACHINE_ID] },
    priorTurn: null,
    ...overrides,
  };
}

/** A site-wide turn: "all machines", dynamically, fanned out. */
function siteParams(overrides: Partial<StartTurnParams> = {}): StartTurnParams {
  return baseParams({
    resolved: resolvedOn(['machine-1', 'machine-2']),
    turnTarget: { machineIds: null, fanOut: true, source: 'chat' },
    chatTarget: { machineIds: null },
    ...overrides,
  });
}

/** The prior turn record, as `acquireTurnLock` returns it. */
function priorTurn(overrides: Partial<PriorTurn> = {}): PriorTurn {
  return {
    toolCommands: {},
    fanOut: false,
    resolvedMachineIds: [MACHINE_ID],
    messageId: null,
    pendingApprovals: [],
    ...overrides,
  };
}

const finishChunk = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function textChunks(text = 'all good') {
  return [
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: text },
    { type: 'text-end' as const, id: 't1' },
    finishChunk,
  ];
}

function textModel(text = 'all good') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: textChunks(text) }),
    }),
  });
}

/** The model createModel hands to the runner (swapped per test). */
let mockModel: MockLanguageModelV3 = textModel();

type Chunk = InferUIMessageChunk<UIMessage> & { errorText?: string; transient?: boolean };

async function collectChunks(stream: ReadableStream<InferUIMessageChunk<UIMessage>>) {
  const chunks: Chunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Chunk);
  }
  return chunks;
}

/** Let detached promise chains (snapshot pump tail, categorize) settle. */
async function flushAsync() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Real AI SDK tool reporting the queued command + poll ticks via the Task 2.1 toolCallbacks. */
function stubBuildTools(
  _db: unknown,
  _siteId: string,
  machineId: string,
  _chatId: string,
  _toolDefs: unknown,
  _siteMode?: boolean,
  _onlineMachines?: string[],
  options?: {
    toolCallbacks?: {
      onCommandQueued?: (toolCallId: string, commandId: string, machineId: string) => unknown;
      onPollTick?: () => void;
    };
  },
) {
  return {
    get_metrics: tool({
      description: 'read machine metrics',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
      execute: async (_input, { toolCallId }) => {
        options?.toolCallbacks?.onCommandQueued?.(toolCallId, 'cmd_test_1', machineId);
        // Inert no-ops: the runner no longer wires onPollTick — proves the hook isn't passed.
        options?.toolCallbacks?.onPollTick?.();
        options?.toolCallbacks?.onPollTick?.();
        return { cpu: 12 };
      },
    }),
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mockModel = textModel();
  _setTurnTimingForTests(); // defaults (20s heartbeat — inert in fast tests)

  (turnStore.writeSnapshot as jest.Mock).mockResolvedValue(true);
  // touch now returns a tri-state ownership signal ('owned' | 'lost' | 'error').
  (turnStore.touch as jest.Mock).mockResolvedValue('owned');
  (turnStore.recordToolCommand as jest.Mock).mockResolvedValue(true);
  (turnStore.recordResolvedMachines as jest.Mock).mockResolvedValue(true);
  (turnStore.finishTurn as jest.Mock).mockResolvedValue(true);

  (hootUtils.resolveLlmConfig as jest.Mock).mockResolvedValue({
    provider: 'anthropic',
    apiKey: 'k',
  });
  (hootUtils.getHootRequireTier3Approval as jest.Mock).mockResolvedValue(true);
  (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(siteListing());
  (hootUtils.resolveHootMaxTier as jest.Mock).mockReturnValue(3);
  (hootUtils.buildExecutableTools as jest.Mock).mockImplementation(stubBuildTools);

  (llm.createModel as jest.Mock).mockImplementation(() => mockModel);
  (llm.createCheapModel as jest.Mock).mockReturnValue('CHEAP_MODEL');
  (llm.buildHootSystemPrompt as jest.Mock).mockImplementation(
    ({ mode, machineIds }: { mode: string; machineIds: string[] }) =>
      `${mode.toUpperCase()} PROMPT ${machineIds.join(',')}`,
  );

  (getToolsByTier as jest.Mock).mockReturnValue([
    {
      name: 'get_metrics',
      description: 'read machine metrics',
      parameters: { type: 'object', properties: {} },
      tier: 1,
    },
  ]);

  (categorizeNewChat as jest.Mock).mockResolvedValue({ title: 't', category: 'General' });
});

afterEach(() => {
  _setTurnTimingForTests();
});

describe('startTurn — happy path', () => {
  it('streams text, writes snapshots, persists the final chat, and finishes the turn', async () => {
    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // Live HTTP branch got the text.
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);

    // Snapshots flowed into the turn store while streaming.
    expect(turnStore.writeSnapshot).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      expect.objectContaining({ role: 'assistant' }),
    );

    // Turn marked complete exactly once, recording that it ended waiting on
    // nothing — an approval resume binds to this list.
    expect(turnStore.finishTurn).toHaveBeenCalledTimes(1);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'complete',
      undefined,
      [],
    );

    // Final chat persist mirrors the useHoot client shape (new conversation),
    // with the selection written from the target — never a client-sent name.
    const chat = store[CHAT_PATH];
    expect(chat).toMatchObject({
      userId: 'user-1',
      siteId: SITE_ID,
      targetType: 'machine',
      targetMachineIds: [MACHINE_ID],
      targetMachineId: MACHINE_ID,
      machineName: MACHINE_ID,
      title: 'check the cpu',
      updatedAt: '__SERVER_TS__',
      createdAt: '__SERVER_TS__',
    });
    const messages = chat.messages as Array<{ id: string; role: string; parts: unknown[] }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: 'u1', role: 'user' });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'all good' })]),
    );

    // New conversation → categorization fired with the first user text.
    expect(categorizeNewChat).toHaveBeenCalledWith(
      fakeDb,
      'CHEAP_MODEL',
      CHAT_ID,
      'check the cpu',
    );

    // Single-machine prompt + process summaries path.
    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith({
      mode: 'single',
      machineIds: [MACHINE_ID],
      skipped: { offline: [], disabled: [] },
      processes: [],
      narrowedByMention: false,
    });
  });

  it('truncates long first-user-text titles to 100 chars', async () => {
    const longText = 'x'.repeat(150);
    await collectChunks(startTurn(fakeDb, baseParams({ messages: [userMsg('u1', longText)] })));
    await flushAsync();

    expect((store[CHAT_PATH].title as string).length).toBe(100);
  });

  it('does not overwrite title/createdAt or categorize on existing conversations', async () => {
    store[CHAT_PATH] = { title: 'llm generated title', createdAt: 'orig' };
    const params = baseParams({
      messages: [
        userMsg('u1', 'check the cpu'),
        assistantMsg('a1', [{ type: 'text', text: 'looks fine' }]),
        userMsg('u2', 'and the memory?'),
      ],
    });

    await collectChunks(startTurn(fakeDb, params));
    await flushAsync();

    expect(store[CHAT_PATH].title).toBe('llm generated title');
    expect(store[CHAT_PATH].createdAt).toBe('orig');
    expect(
      (store[CHAT_PATH].messages as unknown[]).length,
    ).toBe(4);
    expect(categorizeNewChat).not.toHaveBeenCalled();
  });

  it('site-wide mode: site prompt, fan-out over the resolved machines, and site persist shape', async () => {
    await collectChunks(startTurn(fakeDb, siteParams()));
    await flushAsync();

    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'site', machineIds: ['machine-1', 'machine-2'] }),
    );
    expect(hootUtils.buildExecutableTools).toHaveBeenCalledWith(
      fakeDb,
      SITE_ID,
      '__site__',
      CHAT_ID,
      expect.any(Array),
      true,
      ['machine-1', 'machine-2'],
      expect.objectContaining({
        userId: 'user-1',
        requireTier3Approval: true,
        // "all machines" stays DYNAMIC on anything this turn schedules (D-D).
        followupTarget: { machineIds: null },
      }),
    );
    expect(store[CHAT_PATH]).toMatchObject({
      targetType: 'site',
      targetMachineIds: null,
      targetMachineId: null,
      machineName: 'All Machines',
    });
  });

  it('a chosen subset fans out to exactly those machines and stores the set', async () => {
    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          resolved: resolvedOn(['machine-1', 'machine-2']),
          turnTarget: { machineIds: ['machine-1', 'machine-2'], fanOut: true, source: 'chat' },
          chatTarget: { machineIds: ['machine-1', 'machine-2'] },
        }),
      ),
    );
    await flushAsync();

    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'subset', machineIds: ['machine-1', 'machine-2'] }),
    );
    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][6]).toEqual([
      'machine-1',
      'machine-2',
    ]);
    // Never-widen: the legacy field narrows to the first id, never the sentinel.
    expect(store[CHAT_PATH]).toMatchObject({
      targetType: 'machines',
      targetMachineIds: ['machine-1', 'machine-2'],
      targetMachineId: 'machine-1',
      machineName: 'machine-1, machine-2',
    });
  });

  it('cuts the toolset to the caller cap and hands that ceiling to the tools', async () => {
    // A chat-scoped API key is held to tier 1 while its owner earns 3. The cap
    // has to reach the tool options as well as the toolset: that value is what
    // `schedule_followup` records on the follow-up doc, and without it a capped
    // turn could promise itself the owner's reach at fire time.
    await collectChunks(startTurn(fakeDb, baseParams({ maxToolTier: 1 })));
    await flushAsync();

    expect(getToolsByTier).toHaveBeenCalledWith(1);
    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][7]).toMatchObject({
      maxToolTier: 1,
    });
  });
});

describe('startTurn — heartbeat', () => {
  it('emits transient data-heartbeat chunks on the HTTP branch during a slow turn', async () => {
    _setTurnTimingForTests({ heartbeatMs: 15 });
    mockModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({ chunkDelayInMs: 30, chunks: textChunks() }),
      }),
    });

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    const heartbeats = chunks.filter((c) => c.type === 'data-heartbeat');
    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[0]).toMatchObject({ transient: true, data: expect.any(Number) });

    // Heartbeat ticks also keep the stream doc fresh.
    expect(turnStore.touch).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID);

    // Transient parts never leak into the persisted message.
    const messages = store[CHAT_PATH].messages as Array<{ parts: Array<{ type: string }> }>;
    expect(messages[1].parts.some((p) => p.type === 'data-heartbeat')).toBe(false);
  });
});

describe('startTurn — tool command recording', () => {
  it('records queued commands and throttles poll-tick touches', async () => {
    let call = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks:
              call === 1
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'call_1',
                      toolName: 'get_metrics',
                      input: '{}',
                    },
                    { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
                  ]
                : textChunks('cpu is at 12%'),
          }),
        };
      },
    });

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // toolCallId → {commandId, machineId} recovery index recorded via callback.
    expect(turnStore.recordToolCommand).toHaveBeenCalledTimes(1);
    expect(turnStore.recordToolCommand).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'call_1',
      'cmd_test_1',
      MACHINE_ID,
    );

    // Per-poll touches were removed (~20s heartbeat covers staleness); the only touch is
    // the turn-start persist's ownership gate.
    expect(turnStore.touch).toHaveBeenCalledTimes(1);
    expect(turnStore.touch).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID);

    // The tool round-trip made it onto the stream and into the persisted chat.
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true);
    const messages = store[CHAT_PATH].messages as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(messages[1].parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-get_metrics',
          state: 'output-available',
          output: { cpu: 12 },
        }),
      ]),
    );
  });
});

describe('startTurn — dangling-tool recovery via the prior turn record', () => {
  const danglingHistory = () => [
    userMsg('u1', 'check the metrics'),
    assistantMsg('a1', [
      {
        type: 'tool-get_metrics',
        toolCallId: 'toolu_lost_1',
        state: 'input-available',
        input: {},
      },
    ]),
    userMsg('u2', 'did it finish?'),
  ];
  /** The dead turn was a single-machine one, so its result comes back unwrapped. */
  const prior = priorTurn({
    toolCommands: { toolu_lost_1: { [MACHINE_ID]: { commandId: 'cmd_lost_1' } } },
    fanOut: false,
  });
  const COMPLETED_PATH = `sites/${SITE_ID}/machines/${MACHINE_ID}/commands/completed`;

  let capturedPrompt: unknown;

  beforeEach(() => {
    capturedPrompt = undefined;
    mockModel = new MockLanguageModelV3({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return { stream: simulateReadableStream({ chunks: textChunks() }) };
      },
    });
  });

  it('splices the real result in when the completed entry is terminal', async () => {
    store[COMPLETED_PATH] = {
      cmd_lost_1: { status: 'completed', result: '{"exit_code":0,"stdout":"done"}' },
    };

    await collectChunks(
      startTurn(fakeDb, baseParams({ messages: danglingHistory(), priorTurn: prior })),
    );
    await flushAsync();

    const prompt = JSON.stringify(capturedPrompt);
    expect(prompt).toContain('"exit_code":0');
    expect(prompt).not.toContain(LOST_RESULT_ERROR.slice(0, 20));
  });

  it('reports still-running when the completed entry has status running', async () => {
    store[COMPLETED_PATH] = { cmd_lost_1: { status: 'running' } };

    await collectChunks(
      startTurn(fakeDb, baseParams({ messages: danglingHistory(), priorTurn: prior })),
    );
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain(STILL_RUNNING_ERROR);
  });

  it('surfaces the recorded error for a failed entry', async () => {
    store[COMPLETED_PATH] = { cmd_lost_1: { status: 'failed', error: 'agent exploded' } };

    await collectChunks(
      startTurn(fakeDb, baseParams({ messages: danglingHistory(), priorTurn: prior })),
    );
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain('agent exploded');
  });

  it('falls back to the synthesized lost-result error when nothing is recorded', async () => {
    await collectChunks(startTurn(fakeDb, baseParams({ messages: danglingHistory() })));
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain(
      JSON.stringify(LOST_RESULT_ERROR).slice(1, -1),
    );
  });

  it('leaves a single-machine result unwrapped when a fan-out turn recovers it', async () => {
    // The mirror of the site-wide case: the shape follows the turn that
    // dispatched the call, so this one must NOT grow a `machines` array.
    store[COMPLETED_PATH] = {
      cmd_lost_1: { status: 'completed', result: '{"exit_code":0,"stdout":"done"}' },
    };

    await collectChunks(
      startTurn(
        fakeDb,
        siteParams({ messages: danglingHistory(), priorTurn: prior }),
      ),
    );
    await flushAsync();

    const prompt = JSON.stringify(capturedPrompt);
    expect(prompt).toContain('"exit_code":0');
    expect(prompt).not.toContain('"machines"');
  });
});

describe('startTurn — site-wide dangling-tool recovery aggregation', () => {
  const danglingHistory = () => [
    userMsg('u1', 'grab system info everywhere'),
    assistantMsg('a1', [
      {
        type: 'tool-get_system_info',
        toolCallId: 'toolu_site_1',
        state: 'input-available',
        input: {},
      },
    ]),
    userMsg('u2', 'how did it go?'),
  ];

  // One toolCallId fanned out to three machines (the nested recovery index).
  const prior = priorTurn({
    toolCommands: {
      toolu_site_1: {
        'machine-1': { commandId: 'cmd_m1' },
        'machine-2': { commandId: 'cmd_m2' },
        'machine-3': { commandId: 'cmd_m3' },
      },
    },
    fanOut: true,
    resolvedMachineIds: ['machine-1', 'machine-2', 'machine-3'],
  });
  const completedPath = (m: string) => `sites/${SITE_ID}/machines/${m}/commands/completed`;

  let capturedPrompt: unknown;

  beforeEach(() => {
    capturedPrompt = undefined;
    mockModel = new MockLanguageModelV3({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return { stream: simulateReadableStream({ chunks: textChunks() }) };
      },
    });
  });

  it('aggregates per-machine results into { machines: [...] } (success + running + failed)', async () => {
    store[completedPath('machine-1')] = {
      cmd_m1: { status: 'completed', result: '{"hostname":"HOST-1"}' },
    };
    store[completedPath('machine-2')] = { cmd_m2: { status: 'running' } };
    store[completedPath('machine-3')] = {
      cmd_m3: { status: 'failed', error: 'boom on 3' },
    };

    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          // The turn recovering it is a SINGLE-machine one: the shape must follow
          // the turn that dispatched the call, not the one picking it up.
          messages: danglingHistory(),
          priorTurn: prior,
        }),
      ),
    );
    await flushAsync();

    const prompt = JSON.stringify(capturedPrompt);
    // Live site path shape: { machines: [{ machine, ...result }, ...] }.
    expect(prompt).toContain('"machine":"machine-1"');
    expect(prompt).toContain('HOST-1');
    // A still-running machine surfaces the honest STILL_RUNNING note.
    expect(prompt).toContain('"machine":"machine-2"');
    expect(prompt).toContain(STILL_RUNNING_ERROR);
    // A failed machine surfaces its recorded error.
    expect(prompt).toContain('"machine":"machine-3"');
    expect(prompt).toContain('boom on 3');
    // Not the synthesized single-machine lost-result fallback.
    expect(prompt).not.toContain(LOST_RESULT_ERROR.slice(0, 20));
  });

  it('falls back to the synthesized lost-result error when no machine entry resolves', async () => {
    // All three completed docs absent (consumed/GC'd) → aggregation yields
    // nothing → repair uses the synthesized lost-result error.
    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          // The turn recovering it is a SINGLE-machine one: the shape must follow
          // the turn that dispatched the call, not the one picking it up.
          messages: danglingHistory(),
          priorTurn: prior,
        }),
      ),
    );
    await flushAsync();

    expect(JSON.stringify(capturedPrompt)).toContain(
      JSON.stringify(LOST_RESULT_ERROR).slice(1, -1),
    );
  });
});

describe('startTurn — heartbeat abort decision', () => {
  /**
   * Model that dispatches a blocking tool, then emits text on the follow-up step. The tool
   * blocks on its abortSignal and records whether it saw an abort — the observable for
   * whether the heartbeat fired `abortController.abort()`.
   */
  function blockingToolSetup(observe: { aborted: boolean }) {
    (hootUtils.buildExecutableTools as jest.Mock).mockImplementation(() => ({
      get_metrics: tool({
        description: 'blocking metric read',
        inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async (_input, { abortSignal }: { abortSignal?: AbortSignal }) => {
          await new Promise<void>((resolve) => {
            if (abortSignal?.aborted) return resolve();
            const to = setTimeout(resolve, 300);
            abortSignal?.addEventListener('abort', () => {
              clearTimeout(to);
              resolve();
            });
          });
          observe.aborted = abortSignal?.aborted ?? false;
          return { cpu: 1 };
        },
      }),
    }));

    let call = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks:
              call === 1
                ? [
                    {
                      type: 'tool-call' as const,
                      toolCallId: 'call_block',
                      toolName: 'get_metrics',
                      input: '{}',
                    },
                    { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
                  ]
                : textChunks('done'),
          }),
        };
      },
    });
  }

  it("aborts the in-flight turn when the heartbeat reports genuine loss ('lost')", async () => {
    _setTurnTimingForTests({ heartbeatMs: 10 });
    (turnStore.touch as jest.Mock).mockResolvedValue('lost');
    const observe = { aborted: false };
    blockingToolSetup(observe);

    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(observe.aborted).toBe(true);
  });

  it("does NOT abort on a transient heartbeat failure ('error')", async () => {
    _setTurnTimingForTests({ heartbeatMs: 10 });
    (turnStore.touch as jest.Mock).mockResolvedValue('error');
    const observe = { aborted: false };
    blockingToolSetup(observe);

    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // A single (or repeated) transient Firestore blip must not kill a healthy,
    // still-owned turn — the tool ran to completion without an abort.
    expect(observe.aborted).toBe(false);
  });
});

describe('startTurn — error paths', () => {
  it('model failure: error chunk on the stream, finishTurn(error), no persist', async () => {
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('model exploded');
      },
    });

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error' && c.errorText === 'model exploded')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'model exploded',
      [],
    );
    // Errored turns persist the base history so a provider failure can't erase a brand-new
    // chat — only the user message lands, and categorization never fires.
    expect(store[CHAT_PATH]).toBeDefined();
    const messages = store[CHAT_PATH].messages as Array<{ id: string; role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'u1', role: 'user' });
    expect(categorizeNewChat).not.toHaveBeenCalled();
  });

  it('setup failure (llm config): stream still terminates with an error chunk', async () => {
    (hootUtils.resolveLlmConfig as jest.Mock).mockRejectedValue(
      new Error('No LLM API key configured.'),
    );

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(
      chunks.some((c) => c.type === 'error' && c.errorText === 'No LLM API key configured.'),
    ).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'No LLM API key configured.',
      [],
    );
    // The user message is still durably persisted (turn-start persist ran
    // before the setup failure).
    expect(store[CHAT_PATH]).toBeDefined();
    expect((store[CHAT_PATH].messages as unknown[]).length).toBe(1);
  });

  it('site-wide mode with no online machines errors instead of hanging', async () => {
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([
        { id: 'machine-1', online: false },
        { id: 'machine-2', online: false },
        { id: 'machine-3', online: false },
      ]),
    );

    const chunks = await collectChunks(startTurn(fakeDb, siteParams()));
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'No machines are currently online in this site.',
      [],
    );
  });

  it('a chosen set with nothing left says so, rather than claiming the site is asleep', async () => {
    // One offline, one hoot-off: "not online with hoot enabled" is the honest
    // summary of a mixed set, and it must not read as the site-wide copy.
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([
        { id: 'machine-1', hootEnabled: false },
        { id: 'machine-2', online: false },
      ]),
    );

    const chunks = await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          resolved: resolvedOn(['machine-1', 'machine-2']),
          turnTarget: { machineIds: ['machine-1', 'machine-2'], fanOut: true, source: 'chat' },
        }),
      ),
    );
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'None of the selected machines are online with hoot enabled.',
      [],
    );
    expect(hootUtils.buildExecutableTools).not.toHaveBeenCalled();
  });

  it('names the kill switch when every target is online but hoot-off', async () => {
    // Telling someone their machines are asleep when they are awake hides the
    // one fix there is. The site-wide path reaches this too: a talon site run
    // resolves to whatever is online, and the runner is where D-A drops them.
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([
        { id: 'machine-1', hootEnabled: false },
        { id: 'machine-2', hootEnabled: false },
      ]),
    );

    await collectChunks(
      startTurn(fakeDb, siteParams({ resolved: resolvedOn(['machine-1', 'machine-2']) })),
    );
    await flushAsync();

    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'error',
      'Hoot is disabled on every machine this turn targets.',
      [],
    );
  });
});

describe('startTurn — the payer plan', () => {
  const PLAN_ENV = {
    PLAN_ENFORCEMENT: 'on',
    TRIDANT_API_URL: 'https://tridant.example.invalid',
    TRIDANT_LICENSE_KEY: 'test-license-key',
  };

  function payerControl(value: '0' | '1') {
    mockGetEntitlements.mockResolvedValue({
      ok: true,
      resolved: true,
      standing: 'active',
      inGoodStanding: true,
      ent: { 'owlette.control': value },
      epoch: 1,
    });
  }

  beforeEach(() => {
    mockGetEntitlements.mockReset();
    Object.assign(process.env, PLAN_ENV);
    store[`sites/${SITE_ID}`] = { owner: 'payer-1' };
  });

  afterEach(() => {
    for (const key of Object.keys(PLAN_ENV)) delete process.env[key];
  });

  it('ends the turn with the plan refusal before any model or machine work', async () => {
    payerControl('0');

    const chunks = await collectChunks(startTurn(fakeDb, baseParams({ source: 'followup' })));
    await flushAsync();

    const detail = PLAN_REQUIRED_DETAIL['owlette.control'];
    expect(chunks.some((c) => c.type === 'error' && c.errorText === detail)).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID, 'error', detail, []);
    expect(mockGetEntitlements).toHaveBeenCalledWith('payer-1');
    expect(llm.createModel).not.toHaveBeenCalled();
    expect(hootUtils.listSiteMachines).not.toHaveBeenCalled();
    expect(hootUtils.buildExecutableTools).not.toHaveBeenCalled();
  });

  it('runs the turn for a payer with remote control', async () => {
    payerControl('1');

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'error')).toBe(false);
  });

  it('looks nothing up with enforcement off', async () => {
    delete process.env.PLAN_ENFORCEMENT;

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });
});

describe('startTurn — narrowing the resolved set at turn start', () => {
  it('drops a machine that went offline between the request and the dispatch', async () => {
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([{ id: 'machine-2', online: false }]),
    );

    await collectChunks(
      startTurn(fakeDb, siteParams({ resolved: resolvedOn(['machine-1', 'machine-2']) })),
    );
    await flushAsync();

    // Dispatch reaches machine-1 only…
    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][6]).toEqual(['machine-1']);
    // …the record says so, before any command is queued…
    expect(turnStore.recordResolvedMachines).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID, [
      'machine-1',
    ]);
    // …and the model is told what it could not reach.
    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        machineIds: ['machine-1'],
        skipped: { offline: ['machine-2'], disabled: [] },
      }),
    );
  });

  it('queues nothing on an online machine with hoot switched off (D-A)', async () => {
    // The kill switch is enforced at DISPATCH, not only in the pre-checks: a
    // site-wide turn used to fan out to every online machine regardless.
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([{ id: 'machine-2', hootEnabled: false }]),
    );

    await collectChunks(
      startTurn(fakeDb, siteParams({ resolved: resolvedOn(['machine-1', 'machine-2']) })),
    );
    await flushAsync();

    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][6]).toEqual(['machine-1']);
    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ skipped: { offline: [], disabled: ['machine-2'] } }),
    );
  });

  it('never widens: a machine that came online since the request stays out', async () => {
    await collectChunks(
      startTurn(fakeDb, siteParams({ resolved: resolvedOn(['machine-1', 'machine-2']) })),
    );
    await flushAsync();

    // machine-3 is online and enabled in the listing, and still not dispatched to.
    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][6]).toEqual([
      'machine-1',
      'machine-2',
    ]);
    // Nothing changed, so nothing is rewritten.
    expect(turnStore.recordResolvedMachines).not.toHaveBeenCalled();
  });

  it('a resume records the set it REACHED, not the wider one it inherited', async () => {
    // The claim copies the requesting turn's list into the resumed turn's
    // record, so a resume whose caller already dropped a machine arrives with a
    // record naming machines it will never reach. Left alone, the NEXT approval
    // in this chat binds to that wider list and can run on a machine nobody
    // approved it for (D-C). The caller's list and the live one agree here —
    // only the resume source says the record still needs correcting.
    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          resolved: resolvedOn(['machine-1'], true),
          turnTarget: { machineIds: ['machine-1', 'machine-2'], fanOut: true, source: 'resume' },
          chatTarget: undefined,
          priorTurn: priorTurn({ resolvedMachineIds: ['machine-1', 'machine-2'], fanOut: true }),
        }),
      ),
    );
    await flushAsync();

    expect(turnStore.recordResolvedMachines).toHaveBeenCalledWith(fakeDb, CHAT_ID, TURN_ID, [
      'machine-1',
    ]);
    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][6]).toEqual(['machine-1']);
  });

  it('aborts a resume whose dispatched set cannot be recorded', async () => {
    // Same rule as the narrowing write: no record, no dispatch.
    (turnStore.recordResolvedMachines as jest.Mock).mockResolvedValue(false);

    const chunks = await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          turnTarget: { machineIds: [MACHINE_ID], fanOut: false, source: 'resume' },
          chatTarget: undefined,
        }),
      ),
    );
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(hootUtils.buildExecutableTools).not.toHaveBeenCalled();
  });

  it('aborts before dispatch when the narrowed set cannot be recorded', async () => {
    // A failed guarded write means this turn was superseded (or firestore blipped).
    // Dispatching anyway would queue commands the record does not name, and a
    // later approval resume would bind to the wrong set.
    (turnStore.recordResolvedMachines as jest.Mock).mockResolvedValue(false);
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([{ id: 'machine-2', online: false }]),
    );

    const chunks = await collectChunks(
      startTurn(fakeDb, siteParams({ resolved: resolvedOn(['machine-1', 'machine-2']) })),
    );
    await flushAsync();

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    expect(hootUtils.buildExecutableTools).not.toHaveBeenCalled();
  });

  it('keeps a one-machine target on the single path, with its process context', async () => {
    store[`config/${SITE_ID}/machines/${MACHINE_ID}`] = {
      processes: [{ name: 'TouchDesigner', launch_mode: 'always', exe_path: 'C:/td.exe' }],
    };

    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][5]).toBe(false);
    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'single',
        processes: [
          { name: 'TouchDesigner', launch_mode: 'always', exe_path: 'C:/td.exe' },
        ],
      }),
    );
  });

  it('tells the model when a mention narrowed the turn, and schedules follow-ups on it', async () => {
    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          resolved: resolvedOn(['machine-2']),
          turnTarget: { machineIds: ['machine-2'], fanOut: false, source: 'mention' },
          // The chat still targets everything: a mention narrows one turn only.
          chatTarget: { machineIds: null },
        }),
      ),
    );
    await flushAsync();

    expect(llm.buildHootSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ machineIds: ['machine-2'], narrowedByMention: true }),
    );
    expect((hootUtils.buildExecutableTools as jest.Mock).mock.calls[0][7]).toMatchObject({
      followupTarget: { machineIds: ['machine-2'] },
    });
    // The stored selection is untouched by the narrowing.
    expect(store[CHAT_PATH]).toMatchObject({ targetType: 'site', targetMachineIds: null });
  });
});

describe('startTurn — per-turn metadata and the stored selection', () => {
  it('stamps the turn`s machines onto the assistant message and persists them', async () => {
    (hootUtils.listSiteMachines as jest.Mock).mockResolvedValue(
      siteListing([{ id: 'machine-2', online: false }]),
    );

    await collectChunks(
      startTurn(fakeDb, siteParams({ resolved: resolvedOn(['machine-1', 'machine-2']) })),
    );
    await flushAsync();

    const messages = store[CHAT_PATH].messages as Array<{ role: string; metadata?: unknown }>;
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      metadata: {
        hoot: {
          turnId: TURN_ID,
          machineIds: ['machine-1'],
          via: 'chat',
          skipped: { offline: ['machine-2'], disabled: [] },
          // `siteParams` asks for the dynamic "all machines". Asserted here
          // because `toMatchObject` ignores keys it is not given: without this
          // the stamp's only producer could be deleted outright and every suite
          // would stay green.
          dynamic: true,
        },
      },
    });
  });

  it('stamps dynamic:false for a turn that CHOSE its machines', async () => {
    // The counterpart, and the half that matters: a chosen set and the whole
    // site resolve to the same ids, so an inverted stamp would have a two-machine
    // chat telling the approval prompt it was about to run on the entire site.
    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          turnTarget: { machineIds: ['machine-1', 'machine-2'], fanOut: true, source: 'chat' },
          resolved: resolvedOn(['machine-1', 'machine-2']),
        }),
      ),
    );
    await flushAsync();

    const messages = store[CHAT_PATH].messages as Array<{ role: string; metadata?: unknown }>;
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      metadata: { hoot: { dynamic: false } },
    });
  });

  it('keeps an earlier turn`s metadata when a later turn re-persists the history', async () => {
    // The client re-sends the whole conversation, so a reloaded chat's older
    // turns keep the machines they actually ran on rather than losing their
    // label to the next persist.
    const earlier = {
      ...assistantMsg('a0', [{ type: 'text', text: 'checked.' }]),
      metadata: {
        hoot: {
          turnId: 'turn_0',
          machineIds: ['machine-3'],
          via: 'mention',
          skipped: { offline: [], disabled: [] },
        },
      },
    } as UIMessage;

    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({ messages: [userMsg('u1', 'check the cpu'), earlier, userMsg('u2', 'again?')] }),
      ),
    );
    await flushAsync();

    const messages = store[CHAT_PATH].messages as Array<{ id: string; metadata?: unknown }>;
    expect(messages.find((m) => m.id === 'a0')?.metadata).toEqual(earlier.metadata);
  });

  it('leaves the stored selection alone for a turn with no chatTarget', async () => {
    // A resume, follow-up or talon turn targets a set the user did not just
    // pick — writing it back would move the chat's selection behind their back.
    store[CHAT_PATH] = {
      targetType: 'site',
      targetMachineIds: null,
      machineName: 'All Machines',
    };

    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          chatTarget: undefined,
          turnTarget: { machineIds: [MACHINE_ID], fanOut: false, source: 'resume' },
        }),
      ),
    );
    await flushAsync();

    expect(store[CHAT_PATH]).toMatchObject({
      targetType: 'site',
      targetMachineIds: null,
      machineName: 'All Machines',
    });
  });
});

describe('startTurn — superseded turn', () => {
  it('skips both the turn-start and final chat persist when the turn lost the doc', async () => {
    // A superseded turn loses ownership: the guarded `touch` reports `lost`
    // (turn-start persist gate skips; heartbeat would abort) and `finishTurn`
    // reports `false`, so neither the start nor the final persist writes.
    (turnStore.touch as jest.Mock).mockResolvedValue('lost');
    (turnStore.finishTurn as jest.Mock).mockResolvedValue(false);

    const chunks = await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    // The stream itself still completed for whoever was watching it…
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true);
    expect(turnStore.finishTurn).toHaveBeenCalledWith(
      fakeDb,
      CHAT_ID,
      TURN_ID,
      'complete',
      undefined,
      [],
    );
    // …but the superseding turn owns the chat doc now.
    expect(store[CHAT_PATH]).toBeUndefined();
    expect(categorizeNewChat).not.toHaveBeenCalled();
  });
});

describe('startTurn — Claude 5 advisor', () => {
  const ADVISOR_PART = {
    type: 'tool-advisor',
    toolCallId: 'srvtoolu_adv1',
    state: 'output-available',
    input: {},
    output: { type: 'advisor_redacted_result', encryptedContent: 'opaque-advice' },
    providerExecuted: true,
  };

  const historyWithAdvice = () => [
    userMsg('u0', 'why is the render node slow?'),
    assistantMsg('a0', [ADVISOR_PART, { type: 'text', text: 'the gpu is pinned.' }]),
    userMsg('u1', 'check the cpu'),
  ];

  it('offers the default Claude model the Opus 5 advisor alongside the machine tools', async () => {
    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(mockModel.doStreamCalls[0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'anthropic.advisor_20260301', name: 'advisor' }),
        expect.objectContaining({ name: 'get_metrics' }),
      ]),
    );
  });

  it('replays earlier advice to a model that has the advisor', async () => {
    await collectChunks(startTurn(fakeDb, baseParams({ messages: historyWithAdvice() })));
    await flushAsync();

    expect(JSON.stringify(mockModel.doStreamCalls[0].prompt)).toContain('opaque-advice');
  });

  it('keeps advisor history and the tool away from a model without the advisor', async () => {
    (hootUtils.resolveLlmConfig as jest.Mock).mockResolvedValue({ provider: 'openai', apiKey: 'k' });

    await collectChunks(startTurn(fakeDb, baseParams({ messages: historyWithAdvice() })));
    await flushAsync();

    const call = mockModel.doStreamCalls[0];
    expect(call.tools?.map((t) => t.name)).toEqual(['get_metrics']);
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).not.toContain('advisor');
    expect(prompt).toContain('the gpu is pinned.');
    // The stored history keeps the advice for a later switch back to Claude.
    const persisted = JSON.stringify(store[CHAT_PATH].messages);
    expect(persisted).toContain('opaque-advice');
  });

  it('leaves a failed consultation out of the next request, and keeps the advice', async () => {
    const failed = {
      type: 'tool-advisor',
      toolCallId: 'srvtoolu_failed0',
      state: 'output-error',
      input: {},
      errorText: JSON.stringify({ type: 'advisor_tool_result_error', errorCode: 'overloaded' }),
      providerExecuted: true,
    };

    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          messages: [
            userMsg('u0', 'why is the render node slow?'),
            assistantMsg('a0', [failed, ADVISOR_PART, { type: 'text', text: 'the gpu is pinned.' }]),
            userMsg('u1', 'check the cpu'),
          ],
        }),
      ),
    );
    await flushAsync();

    const prompt = JSON.stringify(mockModel.doStreamCalls[0].prompt);
    expect(prompt).not.toContain('srvtoolu_failed0');
    expect(prompt).toContain('opaque-advice');
  });

  it('counts the consultations a resumed reply already made', async () => {
    // A tier-3 approval resume continues the stored assistant message.
    const secondConsult = { ...ADVISOR_PART, toolCallId: 'srvtoolu_adv2' };

    await collectChunks(
      startTurn(
        fakeDb,
        baseParams({
          messages: [
            userMsg('u0', 'why is the render node slow?'),
            assistantMsg('a0', [ADVISOR_PART, secondConsult, { type: 'text', text: 'checking.' }]),
          ],
        }),
      ),
    );
    await flushAsync();

    const call = mockModel.doStreamCalls[0];
    expect(call.tools?.map((t) => t.name)).toEqual(['get_metrics']);
    expect(JSON.stringify(call.prompt)).not.toContain('opaque-advice');
  });

  it('stops offering the advisor once a turn has consulted it twice', async () => {
    const consultThenCallTool = (n: number) => [
      {
        type: 'tool-call' as const,
        toolCallId: `srvtoolu_a${n}`,
        toolName: 'advisor',
        input: '{}',
        providerExecuted: true,
      },
      {
        type: 'tool-result' as const,
        toolCallId: `srvtoolu_a${n}`,
        toolName: 'advisor',
        result: { type: 'advisor_redacted_result', encryptedContent: `advice-${n}` },
      },
      { type: 'tool-call' as const, toolCallId: `call_${n}`, toolName: 'get_metrics', input: '{}' },
      { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
    ];
    let call = 0;
    mockModel = new MockLanguageModelV3({
      doStream: async () => {
        call += 1;
        return {
          stream: simulateReadableStream({
            chunks: call <= 2 ? consultThenCallTool(call) : textChunks('cpu is at 12%'),
          }),
        };
      },
    });

    await collectChunks(startTurn(fakeDb, baseParams()));
    await flushAsync();

    expect(mockModel.doStreamCalls.map((c) => c.tools?.map((t) => t.name))).toEqual([
      ['get_metrics', 'advisor'],
      ['get_metrics', 'advisor'],
      ['get_metrics'],
    ]);
    // The third call carries none of this turn's advice: the API rejects it without the tool.
    expect(JSON.stringify(mockModel.doStreamCalls[2].prompt)).not.toContain('advice-');
    // The chat still records both consultations.
    const persisted = JSON.stringify(store[CHAT_PATH].messages);
    expect(persisted).toContain('advice-1');
    expect(persisted).toContain('advice-2');
  });
});
