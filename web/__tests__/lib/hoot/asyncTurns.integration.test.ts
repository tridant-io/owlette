/** @jest-environment node */

/**
 * Integration tests for the hoot async-turn architecture: real
 * turnRunner.server + turnStore.server + repairMessages + hoot-utils.server
 * (genuine dispatch + poll relay). Only three seams are faked — firestore
 * (in-memory: transactions, merge, dotted paths, delete sentinels,
 * serverTimestamp), the LLM (MockLanguageModelV3 through real streamText,
 * decryptApiKey stubbed), and the agent (results written straight into the
 * mock `commands/completed` doc).
 *
 * Scenarios: (1) stream death ≠ turn death; (2) supersede mid-tool, repair
 * splices the real agent output and A's late persist no-ops on the turnId
 * guard; (3) tier-3 approval round-trip; (4) model error still persists the
 * user message; (5) the heartbeat is the sole freshness driver during a
 * silent tool wait.
 */

import type { InferUIMessageChunk, UIMessage } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { Timestamp } from 'firebase-admin/firestore';
import {
  APPROVAL_ALREADY_CONSUMED_ERROR,
  LOST_RESULT_ERROR,
  STILL_RUNNING_ERROR,
} from '@/lib/hoot/repairMessages';

// mocks (only the three allowed seams)

jest.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    private readonly _ms: number;
    constructor(ms: number) {
      this._ms = ms;
    }
    toMillis() {
      return this._ms;
    }
    static fromMillis(ms: number) {
      return new FakeTimestamp(ms);
    }
    static now() {
      return new FakeTimestamp(Date.now());
    }
  }
  // Mirrors firebase-admin FieldPath: literal segments, never split on '.', so
  // `recordToolCommand`'s nested write survives hyphenated machineIds.
  class FakeFieldPath {
    readonly segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
  }
  return {
    __esModule: true,
    FieldValue: {
      serverTimestamp: () => '__SERVER_TS__',
      delete: () => '__FIELD_DELETE__',
    },
    Timestamp: FakeTimestamp,
    FieldPath: FakeFieldPath,
  };
});

// Re-import the mocked FieldPath so the fake update can detect the variadic form.
import { FieldPath as MockFieldPath } from 'firebase-admin/firestore';
type FieldPathLike = { segments: string[] };
function isFieldPath(value: unknown): value is FieldPathLike {
  return value instanceof (MockFieldPath as unknown as new (...s: string[]) => object);
}

// The LLM seam: real streamText drives a MockLanguageModelV3 per scenario.
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: jest.fn(),
  createCheapModel: jest.fn(),
  buildHootSystemPrompt: jest.fn(),
}));

// resolveLlmConfig (real) decrypts the seeded user key — stub the crypto only.
jest.mock('@/lib/llm-encryption.server', () => ({
  __esModule: true,
  decryptApiKey: jest.fn(() => 'test-api-key'),
}));

// LLM-adjacent fire-and-forget — not under test here.
jest.mock('@/lib/hoot/categorizeChat.server', () => ({
  __esModule: true,
  categorizeNewChat: jest.fn(),
}));

import * as llm from '@/lib/llm';
import { categorizeNewChat } from '@/lib/hoot/categorizeChat.server';
import {
  acquireTurnLock,
  ApprovalStaleError,
  readTurnRecord,
  TurnActiveError,
  _resetThrottleForTests,
  type TurnToolCommand,
} from '@/lib/hoot/turnStore.server';
import { neverWidenLegacyMachineId } from '@/lib/hoot/target';
import {
  startTurn,
  _setTurnTimingForTests,
  type StartTurnParams,
} from '@/lib/hoot/turnRunner.server';

// in-memory firestore (transactions + merge + dotted paths + delete)

type StoreShape = Record<string, Record<string, unknown>>;
const store: StoreShape = {};

const SERVER_TS = '__SERVER_TS__';
const FIELD_DELETE = '__FIELD_DELETE__';

/**
 * Sequencing gate for scenario 2: while parked, `commands/completed` reads block,
 * freezing turn A in its poll loop so turn B's repair reads the result first.
 */
let parkCompletedGets = false;
const parkedGets: Array<() => void> = [];
function releaseParkedGets(): void {
  parkCompletedGets = false;
  for (const release of parkedGets.splice(0)) release();
}

function materialize(value: unknown): unknown {
  return value === SERVER_TS ? Timestamp.now() : value;
}

function materializeTop(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = materialize(v);
  return out;
}

/** Descend (cloning) to the parent of `segments` and set/delete the leaf, keeping
 *  siblings — as firestore's nested-field updates do. */
function writeSegments(
  target: Record<string, unknown>,
  segments: string[],
  value: unknown,
  isDelete: boolean,
) {
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const existing = node[seg];
    node[seg] =
      existing && typeof existing === 'object'
        ? { ...(existing as Record<string, unknown>) }
        : {};
    node = node[seg] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (isDelete) delete node[last];
  else node[last] = value;
}

/** Object-form update: dotted-string keys + delete sentinels. */
function applyUpdate(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [key, raw] of Object.entries(patch)) {
    writeSegments(target, key.split('.'), materialize(raw), raw === FIELD_DELETE);
  }
}

/** update(ref, ...args) in either form: object patch, or the variadic
 *  `(fieldPathOrString, value, ...)` pairs `recordToolCommand` uses. */
function applyUpdateArgs(target: Record<string, unknown>, args: unknown[]) {
  if (
    args.length === 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !isFieldPath(args[0])
  ) {
    applyUpdate(target, args[0] as Record<string, unknown>);
    return;
  }
  for (let i = 0; i + 1 < args.length; i += 2) {
    const path = args[i];
    const segments = isFieldPath(path) ? path.segments : String(path).split('.');
    const raw = args[i + 1];
    writeSegments(target, segments, materialize(raw), raw === FIELD_DELETE);
  }
}

interface FakeDocRef {
  _path: string;
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
  create: (data: Record<string, unknown>) => Promise<void>;
  update: (...args: unknown[]) => Promise<void>;
  collection: (name: string) => { doc: (id: string) => FakeDocRef };
}

function freshSnap(path: string) {
  const data = store[path];
  return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
}

function docRef(path: string): FakeDocRef {
  return {
    _path: path,
    get: async () => {
      if (parkCompletedGets && path.endsWith('/commands/completed')) {
        await new Promise<void>((resolve) => parkedGets.push(resolve));
      }
      return freshSnap(path);
    },
    set: async (data, opts) => {
      const next = materializeTop(data);
      store[path] = opts?.merge ? { ...(store[path] ?? {}), ...next } : next;
    },
    // Real firestore create(): atomic, ALREADY_EXISTS (gRPC code 6) on conflict.
    create: async (data) => {
      if (store[path] !== undefined) {
        throw Object.assign(new Error(`already exists: ${path}`), { code: 6 });
      }
      store[path] = materializeTop(data);
    },
    update: async (...args: unknown[]) => {
      if (!store[path]) throw new Error(`update on missing doc: ${path}`);
      const next = { ...store[path] };
      applyUpdateArgs(next, args);
      store[path] = next;
    },
    collection: (name) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(prefix: string) {
  return {
    doc: (id: string) => docRef(`${prefix}/${id}`),
    // Collection read (`listSiteMachines`): the immediate children of `prefix`,
    // so a machine's own `commands/…` subtree is not mistaken for a machine.
    get: async () => ({
      docs: Object.keys(store)
        .filter(
          (path) =>
            path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/'),
        )
        .map((path) => ({
          id: path.slice(prefix.length + 1),
          data: () => ({ ...store[path] }),
        })),
    }),
  };
}

const fakeDb = {
  collection: (name: string) => collectionRef(name),
  runTransaction: async (fn: (txn: unknown) => Promise<unknown>) => {
    const txn = {
      get: async (ref: FakeDocRef) => freshSnap(ref._path),
      set: (ref: FakeDocRef, data: Record<string, unknown>) => {
        store[ref._path] = materializeTop(data);
      },
      update: (ref: FakeDocRef, ...args: unknown[]) => {
        if (!store[ref._path]) throw new Error(`txn update on missing: ${ref._path}`);
        const next = { ...store[ref._path] };
        applyUpdateArgs(next, args);
        store[ref._path] = next;
      },
    };
    return fn(txn);
  },
} as unknown as FirebaseFirestore.Firestore;

// fixtures + helpers

const SITE_ID = 'site-A';
const MACHINE_ID = 'machine-1';
const USER_ID = 'user-1';

const streamPath = (chatId: string) => `chats/${chatId}/stream/current`;
const chatPath = (chatId: string) => `chats/${chatId}`;
const pendingPath = (machineId: string) =>
  `sites/${SITE_ID}/machines/${machineId}/commands/pending`;
const completedPath = (machineId: string) =>
  `sites/${SITE_ID}/machines/${machineId}/commands/completed`;

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage;
}

function assistantMsg(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage;
}

/** A single-machine turn against `machineId`, as the route resolves one. */
function baseParams(overrides: Partial<StartTurnParams> & { machineId?: string }): StartTurnParams {
  const { machineId = MACHINE_ID, ...rest } = overrides;
  return {
    chatId: 'chat_default',
    turnId: 'turn_default',
    siteId: SITE_ID,
    messages: [userMsg('u1', 'check the machine')],
    userId: USER_ID,
    access: {
      role: 'admin',
      standing: { role: 'owner', swoopMode: null, machineIds: null },
      isSuperadmin: false,
      isSiteAdmin: true,
      isSiteOwner: true,
    },
    resolved: { ids: [machineId], fanOut: false, skipped: { offline: [], disabled: [] } },
    turnTarget: { machineIds: [machineId], fanOut: false, source: 'chat' },
    chatTarget: { machineIds: [machineId] },
    priorTurn: null,
    ...rest,
  };
}

/**
 * Mirror the route: claim the per-chat lock — recording the turn's target, or
 * re-verifying an approval binding — and start the detached turn on the prior
 * record the claim returned.
 */
async function beginTurn(
  params: StartTurnParams,
  opts?: { supersede?: boolean; resume?: { messageId: string; toolCallIds: string[] } },
) {
  const prior = await acquireTurnLock(fakeDb, params.chatId, {
    turnId: params.turnId,
    siteId: params.siteId,
    machineId: neverWidenLegacyMachineId({ machineIds: params.turnTarget.machineIds }),
    supersede: opts?.supersede,
    ...(opts?.resume
      ? // As the route does: the mode comes from THIS turn's resolution, the
        // machine list from the record the claim re-reads.
        { resume: { ...opts.resume, fanOut: params.resolved.fanOut } }
      : { target: params.turnTarget, resolvedMachineIds: params.resolved.ids }),
  });
  return startTurn(fakeDb, { ...params, priorTurn: prior });
}

const finishChunk = {
  type: 'finish' as const,
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};

function textChunks(text: string) {
  return [
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: text },
    { type: 'text-end' as const, id: 't1' },
    finishChunk,
  ];
}

/** The model createModel hands to the runner (swapped per turn). */
let currentModel: MockLanguageModelV3;

type Chunk = InferUIMessageChunk<UIMessage> & { errorText?: string; transient?: boolean };

/** Drain a UI-message stream, tolerating an errored stream (returned, not thrown). */
async function collectChunks(stream: ReadableStream<InferUIMessageChunk<UIMessage>>) {
  const chunks: Chunk[] = [];
  let streamError: unknown = null;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as Chunk);
    }
  } catch (error) {
    streamError = error;
  }
  return { chunks, streamError };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Let detached promise chains (snapshot pump tail, persist) settle. */
async function flushAsync() {
  for (let i = 0; i < 4; i++) {
    await sleep(0);
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    }
    await sleep(10);
  }
}

function streamDoc(chatId: string) {
  return store[streamPath(chatId)] as
    | (Record<string, unknown> & {
        toolCommands?: Record<string, Record<string, TurnToolCommand>>;
      })
    | undefined;
}

function updatedAtMs(chatId: string): number {
  return (streamDoc(chatId)!.updatedAt as { toMillis: () => number }).toMillis();
}

function chatMessages(chatId: string) {
  return (store[chatPath(chatId)]?.messages ?? []) as Array<{
    id: string;
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
}

// The runner's heartbeat interval is only cleared on a clean finish (approval
// resume leaks it). Track every interval so a leak can't keep the worker alive
// or touch a later test's stream doc.
const trackedIntervals: Array<ReturnType<typeof setInterval>> = [];
const realSetInterval = global.setInterval;

beforeAll(() => {
  jest.spyOn(global, 'setInterval').mockImplementation(((
    handler: () => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    const handle = realSetInterval(handler, timeout, ...args);
    trackedIntervals.push(handle);
    return handle;
  }) as typeof setInterval);
});

afterAll(() => {
  (global.setInterval as unknown as jest.Mock).mockRestore();
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  parkCompletedGets = false;
  parkedGets.splice(0);
  _resetThrottleForTests();
  _setTurnTimingForTests(); // default: 20s heartbeat (inert in fast tests)

  currentModel = new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks('ok') }) }),
  });

  (llm.createModel as jest.Mock).mockImplementation(() => currentModel);
  (llm.createCheapModel as jest.Mock).mockReturnValue('CHEAP_MODEL');
  (llm.buildHootSystemPrompt as jest.Mock).mockImplementation(
    ({ mode, machineIds }: { mode: string; machineIds: string[] }) =>
      `${mode.toUpperCase()} PROMPT ${machineIds.join(',')}`,
  );
  (categorizeNewChat as jest.Mock).mockResolvedValue({ title: 't', category: 'General' });

  // The machines the runner re-checks its target against at turn start.
  for (const machineId of [MACHINE_ID, 'machine-appr', 'machine-fu']) {
    store[`sites/${SITE_ID}/machines/${machineId}`] = { online: true, cortexEnabled: true };
  }

  // resolveLlmConfig (real) reads the turn owner's own key — the only scope there is.
  store[`users/${USER_ID}/settings/llm`] = {
    provider: 'anthropic',
    apiKeyEncrypted: 'encrypted-blob',
  };
});

afterEach(() => {
  releaseParkedGets();
  for (const handle of trackedIntervals.splice(0)) clearInterval(handle);
  _setTurnTimingForTests();
});

// 1. stream death ≠ turn death

describe('stream death ≠ turn death', () => {
  it(
    'completes the turn and persists after the HTTP tee branch is cancelled mid-turn',
    async () => {
      const chatId = 'chat_streamdeath';
      const turnId = 'turn_sd_1';
      currentModel = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunkDelayInMs: 15,
            chunks: [
              { type: 'text-start' as const, id: 't1' },
              { type: 'text-delta' as const, id: 't1', delta: 'the ' },
              { type: 'text-delta' as const, id: 't1', delta: 'full ' },
              { type: 'text-delta' as const, id: 't1', delta: 'answer' },
              { type: 'text-end' as const, id: 't1' },
              finishChunk,
            ],
          }),
        }),
      });

      const stream = await beginTurn(
        baseParams({ chatId, turnId, messages: [userMsg('u1', 'check the cpu')] }),
      );

      // Client dies mid-turn: read one chunk, cancel the HTTP branch. The pump
      // owns the other tee branch so the source keeps flowing. Not awaited — a
      // tee cancel only settles when the shared source closes.
      const reader = stream.getReader();
      await reader.read();
      void reader.cancel();

      // The turn still runs to completion server-side.
      await waitFor(() => chatMessages(chatId).length === 2, 'final chat persist');
      await flushAsync();

      const doc = streamDoc(chatId)!;
      expect(doc).toMatchObject({ status: 'complete', turnId });

      const messages = chatMessages(chatId);
      expect(messages[0]).toMatchObject({ id: 'u1', role: 'user' });
      expect(messages[1].role).toBe('assistant');
      expect(messages[1].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'the full answer' }),
        ]),
      );
      expect(store[chatPath(chatId)]).toMatchObject({
        userId: USER_ID,
        siteId: SITE_ID,
        targetType: 'machine',
        targetMachineId: MACHINE_ID,
        title: 'check the cpu',
      });
    },
    10_000,
  );
});

// 2. supersede mid-tool → recovery

describe('supersede mid-tool → commandId recovery', () => {
  it(
    "turn B splices the real agent output into the prompt; turn A's persist no-ops",
    async () => {
      const chatId = 'chat_supersede';

      // turn A: dispatches get_system_info, then parks in executeToolOnAgent's
      // poll loop (parked completed-doc reads).
      parkCompletedGets = true;

      let aCalls = 0;
      const aPrompts: unknown[] = [];
      currentModel = new MockLanguageModelV3({
        doStream: async (options) => {
          aCalls += 1;
          aPrompts.push(options.prompt);
          return {
            stream: simulateReadableStream({
              chunks:
                aCalls === 1
                  ? [
                      {
                        type: 'tool-call' as const,
                        toolCallId: 'call_A1',
                        toolName: 'get_system_info',
                        input: '{}',
                      },
                      { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
                    ]
                  : textChunks('turn A final summary'),
            }),
          };
        },
      });

      const streamA = await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_A',
          messages: [userMsg('u1', 'grab the system info')],
        }),
      );
      // A's HTTP stream is already dead. Not awaited: the tee cancel only settles
      // when the shared source closes, and A is about to park — awaiting deadlocks.
      void streamA.cancel();

      // Real relay: pending-command write + recovery index recorded.
      await waitFor(() => store[pendingPath(MACHINE_ID)] !== undefined, 'pending write (A)');
      const commandId = Object.keys(store[pendingPath(MACHINE_ID)])[0];
      expect(store[pendingPath(MACHINE_ID)][commandId]).toMatchObject({
        type: 'mcp_tool_call',
        tool_name: 'get_system_info',
        chat_id: chatId,
        status: 'pending',
      });
      await waitFor(
        () => streamDoc(chatId)?.toolCommands?.call_A1 !== undefined,
        'toolCommands recovery index (A)',
      );
      // A is now frozen inside its first completed-doc poll.
      await waitFor(() => parkedGets.length >= 1, 'turn A parked mid-poll', 4000);

      // The agent finishes while no live web turn is listening.
      store[completedPath(MACHINE_ID)] = {
        [commandId]: {
          status: 'completed',
          result: JSON.stringify({ hostname: 'INF-WALL', os: 'Windows 11' }),
        },
      };

      // The recovery index A recorded; turn B's own claim hands it back.
      expect(streamDoc(chatId)!.toolCommands).toEqual({
        call_A1: { [MACHINE_ID]: { commandId } },
      });

      // A fresh running turn refuses a non-supersede claim (contention pin).
      await expect(
        acquireTurnLock(fakeDb, chatId, {
          turnId: 'turn_B',
          siteId: SITE_ID,
          machineId: MACHINE_ID,
          target: { machineIds: [MACHINE_ID], fanOut: false, source: 'chat' },
          resolvedMachineIds: [MACHINE_ID],
        }),
      ).rejects.toThrow(TurnActiveError);

      // turn B: supersedes with A's dangling tool part in history
      parkCompletedGets = false; // new reads flow; A stays parked

      const bPrompts: unknown[] = [];
      currentModel = new MockLanguageModelV3({
        doStream: async (options) => {
          bPrompts.push(options.prompt);
          return { stream: simulateReadableStream({ chunks: textChunks('it completed fine') }) };
        },
      });

      const streamB = await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_B',
          messages: [
            userMsg('u1', 'grab the system info'),
            assistantMsg('a1', [
              {
                type: 'tool-get_system_info',
                toolCallId: 'call_A1',
                state: 'input-available',
                input: {},
              },
            ]),
            userMsg('u2', 'how did it go?'),
          ],
        }),
        { supersede: true },
      );

      const { chunks: bChunks, streamError } = await collectChunks(streamB);
      expect(streamError).toBeNull();
      expect(bChunks.some((c) => c.type === 'error')).toBe(false);

      await waitFor(() => chatMessages(chatId).length === 4, "turn B's final persist");

      // B's repair spliced the REAL agent output into the model prompt.
      const bPrompt = JSON.stringify(bPrompts[0]);
      expect(bPrompt).toContain('INF-WALL');
      expect(bPrompt).not.toContain(LOST_RESULT_ERROR.slice(0, 25));
      expect(bPrompt).not.toContain(STILL_RUNNING_ERROR.slice(0, 25));

      // ...and into the persisted (repaired) history.
      const messages = chatMessages(chatId);
      expect(messages[1].parts[0]).toMatchObject({
        type: 'tool-get_system_info',
        toolCallId: 'call_A1',
        state: 'output-available',
        output: { hostname: 'INF-WALL', os: 'Windows 11' },
      });
      expect(messages[3].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'it completed fine' }),
        ]),
      );
      expect(streamDoc(chatId)).toMatchObject({ status: 'complete', turnId: 'turn_B' });

      // release A: it consumes the entry and finishes, but owns nothing
      releaseParkedGets();
      await waitFor(
        () => store[completedPath(MACHINE_ID)][commandId] === undefined,
        'turn A consumed the completed entry',
      );
      await waitFor(() => aCalls === 2, "turn A's second model step");
      await sleep(250); // let A's onFinish (turnId-guarded) run to the end
      await flushAsync();

      // A finished after B — turnId guard makes its writes no-ops.
      expect(chatMessages(chatId)).toHaveLength(4);
      expect(JSON.stringify(store[chatPath(chatId)])).not.toContain('turn A final summary');
      expect(streamDoc(chatId)).toMatchObject({ status: 'complete', turnId: 'turn_B' });
    },
    20_000,
  );
});

// 3. tier-3 approval round-trip through the runner

describe('tier-3 approval round-trip through the runner', () => {
  const chatId = 'chat_approval';
  const MACHINE_APPR = 'machine-appr';

  /** Turn 1: model calls execute_script (tier 3, requireTier3Approval on). */
  async function runTurn1() {
    // sites/{siteId}/settings/cortex absent → real getHootRequireTier3Approval
    // resolves true (default-on gate).
    currentModel = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call' as const,
              toolCallId: 'toolu_appr_1',
              toolName: 'execute_script',
              input: JSON.stringify({ script: 'sfc /scannow', timeout_seconds: 5 }),
            },
            { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
          ],
        }),
      }),
    });

    const stream = await beginTurn(
      baseParams({
        chatId,
        turnId: 'turn_appr_1',
        machineId: MACHINE_APPR,
        messages: [userMsg('u1', 'run sfc /scannow')],
      }),
    );
    const collected = await collectChunks(stream);
    await waitFor(() => chatMessages(chatId).length === 2, 'turn 1 final persist');
    await flushAsync();
    return collected;
  }

  /** Approve the persisted request the way the client does, then start turn 2. */
  async function runTurn2(capturePrompts: unknown[]) {
    const history = JSON.parse(JSON.stringify(chatMessages(chatId))) as UIMessage[];
    const toolPart = (history[1].parts as Array<Record<string, unknown>>).find(
      (p) => p.type === 'tool-execute_script',
    )!;
    toolPart.state = 'approval-responded';
    toolPart.approval = { ...(toolPart.approval as Record<string, unknown>), approved: true };

    currentModel = new MockLanguageModelV3({
      doStream: async (options) => {
        capturePrompts.push(options.prompt);
        return {
          stream: simulateReadableStream({ chunks: textChunks('scan finished clean') }),
        };
      },
    });

    const stream = await beginTurn(
      baseParams({
        chatId,
        turnId: 'turn_appr_2',
        machineId: MACHINE_APPR,
        messages: history,
      }),
    );

    // The approved tool dispatches for real — answer it like the agent would.
    await waitFor(
      () => store[pendingPath(MACHINE_APPR)] !== undefined,
      'pending write (approved tool)',
    );
    const commandId = Object.keys(store[pendingPath(MACHINE_APPR)])[0];
    store[completedPath(MACHINE_APPR)] = {
      [commandId]: {
        status: 'completed',
        result: JSON.stringify({ exit_code: 0, stdout: 'scan came back with no violations' }),
      },
    };

    const collected = await collectChunks(stream);
    return { ...collected, commandId };
  }

  it('turn 1: ends at approval-requested with NO tool dispatch', async () => {
    const { chunks, streamError } = await runTurn1();

    expect(streamError).toBeNull();
    expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(true);

    // The tool never executed — nothing was written to the machine's queue.
    expect(store[pendingPath(MACHINE_APPR)]).toBeUndefined();

    expect(streamDoc(chatId)).toMatchObject({ status: 'complete', turnId: 'turn_appr_1' });

    // The persisted assistant message carries the approval request.
    const messages = chatMessages(chatId);
    const toolPart = messages[1].parts.find((p) => p.type === 'tool-execute_script');
    expect(toolPart).toMatchObject({
      state: 'approval-requested',
      toolCallId: 'toolu_appr_1',
      input: { script: 'sfc /scannow', timeout_seconds: 5 },
    });
    expect((toolPart!.approval as { id: string }).id).toEqual(expect.any(String));
  });

  it('turn 2: executes the approved tool on the agent and feeds the model the real result', async () => {
    await runTurn1();

    const prompts: unknown[] = [];
    const { commandId } = await runTurn2(prompts);

    // Real dispatch through executeToolOnAgent, with the clamped timeout.
    expect(store[pendingPath(MACHINE_APPR)][commandId]).toMatchObject({
      type: 'mcp_tool_call',
      tool_name: 'execute_script',
      tool_params: { script: 'sfc /scannow', timeout_seconds: 5 },
      chat_id: chatId,
      timeout_seconds: 5,
    });

    // The model was called with the genuine agent output in its prompt.
    await waitFor(() => prompts.length >= 1, 'turn 2 model call');
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain('scan came back with no violations');
    expect(prompt).toContain('sfc /scannow');

    // The recovery index tracked the approved dispatch under turn 2.
    expect(streamDoc(chatId)?.toolCommands).toMatchObject({
      toolu_appr_1: { [MACHINE_APPR]: { commandId } },
    });
  });

  /**
   * Regression pin: an approval-resume turn emits `tool-output-available` for a
   * toolCallId that only exists in the PREVIOUS assistant message, so without
   * seeded prior-message state the SDK throws `UIMessageStreamError: No tool
   * invocation found…`, both tee branches die, and the result is never persisted.
   * The runner must keep seeding `originalMessages` + the pump's resume message.
   */
  it(
    'turn 2 delivery contract: stream survives, turn completes, and the result persists',
    async () => {
      await runTurn1();

      const prompts: unknown[] = [];
      const { streamError } = await runTurn2(prompts);

      // The live stream must not die on an approval resume.
      expect(streamError).toBeNull();

      // The turn must reach a terminal state and persist the tool output.
      await waitFor(
        () => (streamDoc(chatId)?.status ?? 'running') !== 'running',
        'turn 2 terminal status',
        8000,
      );
      expect(streamDoc(chatId)).toMatchObject({ status: 'complete', turnId: 'turn_appr_2' });

      const serialized = JSON.stringify(chatMessages(chatId));
      expect(serialized).toContain('scan came back with no violations');
      expect(serialized).toContain('scan finished clean');
    },
    15_000,
  );

  /**
   * OWL-47 pin: a DUPLICATE resume of the same approval (reload / second tab
   * re-posting the approval-responded history) must not dispatch the tool a
   * second time. The approval ledger's create() is the gate; the duplicate
   * turn recovers the real result via the prior record instead of executing.
   * Negative control: pre-ledger, this exact flow dispatched a second command
   * (pending doc would hold 2 command ids).
   */
  it(
    'duplicate approval resume: exactly one dispatch, duplicate turn recovers the result',
    async () => {
      await runTurn1();

      const prompts: unknown[] = [];
      const { commandId, streamError } = await runTurn2(prompts);
      expect(streamError).toBeNull();
      await waitFor(
        () => (streamDoc(chatId)?.status ?? 'running') !== 'running',
        'turn 2 terminal status',
        8000,
      );

      // The duplicate: same approved history, fresh turn — as a reloaded tab
      // whose approval buttons were still armed would send it.
      const history = JSON.parse(JSON.stringify(chatMessages(chatId))) as UIMessage[];
      // Re-arm the persisted part back to approval-responded, as the stale
      // client's in-memory copy would carry it.
      const toolPart = (history[1].parts as Array<Record<string, unknown>>).find(
        (p) => p.type === 'tool-execute_script',
      )!;
      toolPart.state = 'approval-responded';
      toolPart.approval = { ...(toolPart.approval as Record<string, unknown>), approved: true };
      delete toolPart.output;

      currentModel = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: textChunks('already handled') }),
        }),
      });

      const stream = await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_appr_dup',
          machineId: MACHINE_APPR,
          messages: history,
        }),
        { supersede: true },
      );
      const dup = await collectChunks(stream);
      expect(dup.streamError).toBeNull();
      await waitFor(
        () => (streamDoc(chatId)?.status ?? 'running') !== 'running',
        'duplicate turn terminal status',
        8000,
      );

      // THE pin: still exactly one command ever dispatched to the machine.
      expect(Object.keys(store[pendingPath(MACHINE_APPR)])).toEqual([commandId]);

      // The duplicate turn's persisted part is terminal — never a re-armed
      // approval. The raw output is NOT recoverable here (turn 2's poll loop
      // consumed and deleted the commands/completed entry), so the honest
      // outcome is the consumed-approval error; turn 2's assistant narrative
      // of the result survives in the same message.
      const parts = chatMessages(chatId)[1].parts as Array<Record<string, unknown>>;
      const persisted = parts.find((p) => p.type === 'tool-execute_script')!;
      expect(persisted).toMatchObject({
        state: 'output-error',
        errorText: APPROVAL_ALREADY_CONSUMED_ERROR,
      });
      expect(JSON.stringify(chatMessages(chatId))).toContain('scan finished clean');
    },
    20_000,
  );

  it('records what the turn ended waiting on, so a resume has something to bind to', async () => {
    await runTurn1();

    expect(streamDoc(chatId)).toMatchObject({
      status: 'complete',
      pendingApprovals: ['toolu_appr_1'],
    });
  });

  /**
   * D-C: the approved call runs on the machines resolved when the approval was
   * REQUESTED. Here the chat has since been widened to every machine, and the
   * resumed turn still reaches only the machine that was asked about.
   */
  it(
    'runs a resumed approval on the bound machine alone, not the chat`s current selection',
    async () => {
      await runTurn1();

      const history = JSON.parse(JSON.stringify(chatMessages(chatId))) as UIMessage[];
      const toolPart = (history[1].parts as Array<Record<string, unknown>>).find(
        (p) => p.type === 'tool-execute_script',
      )!;
      toolPart.state = 'approval-responded';
      toolPart.approval = { ...(toolPart.approval as Record<string, unknown>), approved: true };

      currentModel = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: textChunks('scan finished clean') }),
        }),
      });

      // The route's mapping: the bound set comes from the record, never the body.
      const prior = await readTurnRecord(fakeDb, chatId);
      expect(prior).toMatchObject({ resolvedMachineIds: [MACHINE_APPR], fanOut: false });
      const boundIds = prior!.resolvedMachineIds!;

      const stream = await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_appr_bound',
          messages: history,
          resolved: { ids: boundIds, fanOut: prior!.fanOut, skipped: { offline: [], disabled: [] } },
          turnTarget: { machineIds: boundIds, fanOut: prior!.fanOut, source: 'resume' },
          // A resume never rewrites the chat's selection.
          chatTarget: undefined,
        }),
        { resume: { messageId: prior!.messageId!, toolCallIds: ['toolu_appr_1'] } },
      );

      await waitFor(
        () => store[pendingPath(MACHINE_APPR)] !== undefined,
        'pending write (bound resume)',
      );
      const commandId = Object.keys(store[pendingPath(MACHINE_APPR)])[0];
      store[completedPath(MACHINE_APPR)] = {
        [commandId]: { status: 'completed', result: JSON.stringify({ exit_code: 0 }) },
      };
      const { streamError } = await collectChunks(stream);
      expect(streamError).toBeNull();

      // Nothing reached the other machine, and the record says which one it was.
      expect(store[pendingPath(MACHINE_ID)]).toBeUndefined();
      expect(streamDoc(chatId)).toMatchObject({
        resolvedMachineIds: [MACHINE_APPR],
        target: { machineIds: [MACHINE_APPR], fanOut: false, source: 'resume' },
      });
    },
    20_000,
  );

  /**
   * D-C, one turn later: the record a resume leaves behind must name the
   * machines that resume REACHED. The claim can only copy the list of the turn
   * that asked (it re-reads it inside the transaction, which is what makes the
   * binding safe), so when a bound machine has dropped off in the meantime the
   * runner is the only thing that can correct it — and it must, or the next
   * approval this chat parks on binds to the wider list and can run on a machine
   * that received nothing in the turn that requested it.
   */
  it(
    'a resume records the machines it reached, not the wider set it inherited',
    async () => {
      // Turn 1: both machines ticked, one tier-3 call, parked on approval.
      currentModel = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call' as const,
                toolCallId: 'toolu_appr_1',
                toolName: 'execute_script',
                input: JSON.stringify({ script: 'sfc /scannow', timeout_seconds: 5 }),
              },
              { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
            ],
          }),
        }),
      });
      const both = [MACHINE_APPR, MACHINE_ID];
      await collectChunks(
        await beginTurn(
          baseParams({
            chatId,
            turnId: 'turn_appr_wide',
            messages: [userMsg('u1', 'run sfc /scannow')],
            resolved: { ids: both, fanOut: true, skipped: { offline: [], disabled: [] } },
            turnTarget: { machineIds: both, fanOut: true, source: 'chat' },
            chatTarget: { machineIds: both },
          }),
        ),
      );
      await waitFor(() => chatMessages(chatId).length === 2, 'wide turn 1 final persist');
      await flushAsync();
      expect(streamDoc(chatId)).toMatchObject({ resolvedMachineIds: both });

      // One of the two goes offline before anyone answers the approval.
      store[`sites/${SITE_ID}/machines/${MACHINE_ID}`] = { online: false, cortexEnabled: true };

      const history = JSON.parse(JSON.stringify(chatMessages(chatId))) as UIMessage[];
      const toolPart = (history[1].parts as Array<Record<string, unknown>>).find(
        (p) => p.type === 'tool-execute_script',
      )!;
      toolPart.state = 'approval-responded';
      toolPart.approval = { ...(toolPart.approval as Record<string, unknown>), approved: true };

      currentModel = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: textChunks('scan finished clean') }),
        }),
      });

      // The route's own resolution already drops the offline machine, so the
      // runner narrows nothing further — only the resume itself tells it the
      // record is still the asking turn's.
      const prior = await readTurnRecord(fakeDb, chatId);
      const stream = await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_appr_wide_resume',
          messages: history,
          resolved: {
            ids: [MACHINE_APPR],
            fanOut: true,
            skipped: { offline: [MACHINE_ID], disabled: [] },
          },
          turnTarget: { machineIds: both, fanOut: true, source: 'resume' },
          chatTarget: undefined,
        }),
        { resume: { messageId: prior!.messageId!, toolCallIds: ['toolu_appr_1'] } },
      );

      await waitFor(
        () => store[pendingPath(MACHINE_APPR)] !== undefined,
        'pending write (narrowed resume)',
      );
      const commandId = Object.keys(store[pendingPath(MACHINE_APPR)])[0];
      store[completedPath(MACHINE_APPR)] = {
        [commandId]: { status: 'completed', result: JSON.stringify({ exit_code: 0 }) },
      };
      await collectChunks(stream);
      await waitFor(
        () => (streamDoc(chatId)?.status ?? 'running') !== 'running',
        'narrowed resume terminal',
        8000,
      );

      // The offline machine got nothing, and the record no longer names it —
      // so the next approval in this chat cannot be aimed at it.
      expect(store[pendingPath(MACHINE_ID)]).toBeUndefined();
      expect(streamDoc(chatId)).toMatchObject({ resolvedMachineIds: [MACHINE_APPR] });
    },
    20_000,
  );

  it('refuses a resume that an intervening turn made stale, queuing nothing and consuming nothing', async () => {
    await runTurn1();
    const asked = await readTurnRecord(fakeDb, chatId);
    const askedMessageId = asked!.messageId!;

    // Someone (another device, a follow-up) sends in this chat in the meantime.
    currentModel = new MockLanguageModelV3({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: textChunks('sure') }) }),
    });
    const intervening = await beginTurn(
      baseParams({
        chatId,
        turnId: 'turn_intervening',
        machineId: MACHINE_APPR,
        messages: [...(chatMessages(chatId) as UIMessage[]), userMsg('u2', 'never mind')],
      }),
      { supersede: true },
    );
    await collectChunks(intervening);
    await waitFor(
      () => (streamDoc(chatId)?.status ?? 'running') !== 'running',
      'intervening turn terminal',
    );

    // The approval can no longer bind to the record it was requested on.
    await expect(
      acquireTurnLock(fakeDb, chatId, {
        turnId: 'turn_appr_stale',
        siteId: SITE_ID,
        machineId: MACHINE_APPR,
        resume: { messageId: askedMessageId, toolCallIds: ['toolu_appr_1'], fanOut: false },
      }),
    ).rejects.toThrow(ApprovalStaleError);

    // Zero commands queued, and the one-shot ledger was never claimed — the
    // approval is still answerable on a fresh turn.
    expect(store[pendingPath(MACHINE_APPR)]).toBeUndefined();
    expect(store[`chats/${chatId}/approvals/toolu_appr_1`]).toBeUndefined();
  });
});

// 3b. scheduled follow-ups force the tier-3 gate on (plan decision 9)

describe('scheduled follow-up turns never auto-execute tier 3', () => {
  const MACHINE_FU = 'machine-fu';

  /** The site setting that lets an ATTENDED turn auto-run tier-3 tools. */
  function seedApprovalGateOff() {
    store[`sites/${SITE_ID}/settings/cortex`] = { requireTier3Approval: false };
  }

  /**
   * One tier-3 call (`execute_script`), then narrate. The second step has to be
   * text or the unforced control re-dispatches on every loop iteration.
   */
  function modelCallsTier3() {
    let step = 0;
    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        step += 1;
        if (step > 1) {
          return { stream: simulateReadableStream({ chunks: textChunks('scan finished clean') }) };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call' as const,
                toolCallId: 'toolu_fu_1',
                toolName: 'execute_script',
                input: JSON.stringify({ script: 'sfc /scannow', timeout_seconds: 5 }),
              },
              { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
            ],
          }),
        };
      },
    });
  }

  it('parks at approval-requested even where the site allows tier-3 auto-run', async () => {
    const chatId = 'chat_fu_appr';
    seedApprovalGateOff();
    modelCallsTier3();

    const { chunks, streamError } = await collectChunks(
      await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_fu_1',
          machineId: MACHINE_FU,
          messages: [userMsg('u1', '[scheduled follow-up] did the scan finish?')],
          source: 'followup',
          forceTier3Approval: true,
        }),
      ),
    );

    expect(streamError).toBeNull();
    expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(true);
    // Nothing was queued for the agent — the tool never ran.
    expect(store[pendingPath(MACHINE_FU)]).toBeUndefined();

    await waitFor(() => chatMessages(chatId).length === 2, 'follow-up turn persist');
    const toolPart = chatMessages(chatId)[1].parts.find((p) => p.type === 'tool-execute_script');
    expect(toolPart).toMatchObject({ state: 'approval-requested', toolCallId: 'toolu_fu_1' });
  });

  it(
    'negative control: the same turn WITHOUT the flag dispatches on that site',
    async () => {
      // Proves the gate comes from `forceTier3Approval` and not from the site
      // setting, the access level, or the tool tier.
      const chatId = 'chat_fu_noflag';
      seedApprovalGateOff();
      modelCallsTier3();

      const stream = await beginTurn(
        baseParams({
          chatId,
          turnId: 'turn_fu_2',
          machineId: MACHINE_FU,
          messages: [userMsg('u1', 'run the scan')],
        }),
      );

      // The tool dispatches for real — answer it like the agent would.
      await waitFor(
        () => store[pendingPath(MACHINE_FU)] !== undefined,
        'pending write (unforced tier-3)',
      );
      const commandId = Object.keys(store[pendingPath(MACHINE_FU)])[0];
      store[completedPath(MACHINE_FU)] = {
        [commandId]: { status: 'completed', result: JSON.stringify({ exit_code: 0 }) },
      };

      const { chunks } = await collectChunks(stream);
      expect(chunks.some((c) => c.type === 'tool-approval-request')).toBe(false);
    },
    20_000,
  );
});

// 4. error path

describe('error path', () => {
  it('model stream error → stream doc error; brand-new chat still persists the user message', async () => {
    // Brand-new chat: a provider failure must not erase the conversation — the
    // user message is persisted at turn start and survives the errored turn.
    const chatId = 'chat_error';

    currentModel = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error('model exploded');
      },
    });

    const stream = await beginTurn(
      baseParams({ chatId, turnId: 'turn_err_1', messages: [userMsg('u1', 'hello?')] }),
    );
    const { chunks, streamError } = await collectChunks(stream);

    expect(streamError).toBeNull(); // errors surface as chunks, not stream death
    expect(chunks.some((c) => c.type === 'error' && c.errorText === 'model exploded')).toBe(true);

    await waitFor(() => streamDoc(chatId)?.status === 'error', 'stream doc error status');
    expect(streamDoc(chatId)).toMatchObject({
      status: 'error',
      turnId: 'turn_err_1',
      error: 'model exploded',
    });

    // The user message is durable even though the model failed — but no
    // assistant response was persisted.
    await waitFor(() => chatMessages(chatId).length >= 1, 'user message persisted');
    await flushAsync();
    const messages = chatMessages(chatId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'u1', role: 'user' });
    expect(store[chatPath(chatId)]).toMatchObject({ userId: USER_ID, siteId: SITE_ID });
  });
});

// 5. heartbeat + touch during a long tool poll

describe('heartbeat keeps the stream doc fresh during a long tool poll', () => {
  it(
    "bumps the stream doc's updatedAt via the heartbeat while the agent is silent",
    async () => {
      const chatId = 'chat_touch';
      // The heartbeat is the sole freshness driver during a silent tool wait;
      // shrink it so its touch()es land inside the test window.
      _setTurnTimingForTests({ heartbeatMs: 60 });

      let calls = 0;
      currentModel = new MockLanguageModelV3({
        doStream: async () => {
          calls += 1;
          return {
            stream: simulateReadableStream({
              chunks:
                calls === 1
                  ? [
                      {
                        type: 'tool-call' as const,
                        toolCallId: 'call_T1',
                        toolName: 'get_system_info',
                        input: '{}',
                      },
                      { ...finishChunk, finishReason: { unified: 'tool-calls' as const, raw: undefined } },
                    ]
                  : textChunks('cpu is fine'),
            }),
          };
        },
      });

      const stream = await beginTurn(
        baseParams({ chatId, turnId: 'turn_touch_1', messages: [userMsg('u1', 'system info?')] }),
      );
      const consumed = collectChunks(stream); // drain in the background

      await waitFor(() => store[pendingPath(MACHINE_ID)] !== undefined, 'pending write');
      const commandId = Object.keys(store[pendingPath(MACHINE_ID)])[0];
      await waitFor(
        () => streamDoc(chatId)?.toolCommands?.call_T1 !== undefined,
        'toolCommands recorded',
      );
      expect(streamDoc(chatId)!.toolCommands!.call_T1).toEqual({
        [MACHINE_ID]: { commandId },
      });

      // After dispatch-time writes settle the stream is silent, so any bump can
      // only come from the heartbeat's touch().
      await sleep(400);
      const t0 = updatedAtMs(chatId);
      await waitFor(() => updatedAtMs(chatId) > t0, 'first heartbeat touch', 2500);
      const t1 = updatedAtMs(chatId);
      await waitFor(() => updatedAtMs(chatId) > t1, 'second heartbeat touch', 2500);

      // The agent answers; the turn wraps up normally.
      store[completedPath(MACHINE_ID)] = {
        [commandId]: {
          status: 'completed',
          result: JSON.stringify({ hostname: 'HOST-1' }),
        },
      };

      await consumed;
      await waitFor(() => chatMessages(chatId).length === 2, 'final persist');
      expect(streamDoc(chatId)).toMatchObject({ status: 'complete', turnId: 'turn_touch_1' });

      const messages = chatMessages(chatId);
      expect(messages[1].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-get_system_info',
            state: 'output-available',
            output: { hostname: 'HOST-1' },
          }),
          expect.objectContaining({ type: 'text', text: 'cpu is fine' }),
        ]),
      );
    },
    15_000,
  );
});
