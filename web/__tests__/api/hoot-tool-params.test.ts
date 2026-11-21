/** @jest-environment node */

/**
 * Hoot's tool calls on the real POST /api/hoot, turn runner and relay. Three seams are
 * faked: firestore in memory, the model (a mock that emits the call under test), and
 * the agent (results written straight into `commands/completed`).
 */

import type { UIMessage } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { NextRequest } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';

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

jest.mock('@/lib/llm', () => ({
  __esModule: true,
  createModel: jest.fn(),
  createCheapModel: jest.fn(),
  buildHootSystemPrompt: jest.fn(() => 'PROMPT'),
}));

jest.mock('@/lib/llm-encryption.server', () => ({
  __esModule: true,
  decryptApiKey: jest.fn(() => 'test-api-key'),
}));

jest.mock('@/lib/hoot/categorizeChat.server', () => ({
  __esModule: true,
  categorizeNewChat: jest.fn(async () => ({ title: 't', category: 'General' })),
}));

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: () => mockFakeDb,
}));

const mockAuth = { current: { userId: 'admin-a', keyContext: null as unknown } };
jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status = 401;
    code = 'x';
  }
  return {
    __esModule: true,
    ApiAuthError,
    resolveAuth: async () => mockAuth.current,
    requireScope: () => undefined,
  };
});

import * as llm from '@/lib/llm';
import { _resetThrottleForTests } from '@/lib/hoot/turnStore.server';
import { _setTurnTimingForTests } from '@/lib/hoot/turnRunner.server';
import { POST } from '@/app/api/hoot/route';

const SITE_ID = 'site-A';
const M1 = 'machine-1';
const M2 = 'machine-2';
const RQ = '\u201d';
const P = "Set-Content -LiteralPath 'c:/x/marker.txt' -Value x";

const store: Record<string, Record<string, unknown>> = {};
const SERVER_TS = '__SERVER_TS__';
const FIELD_DELETE = '__FIELD_DELETE__';

function materialize(value: unknown): unknown {
  return value === SERVER_TS ? Timestamp.now() : value;
}

function materializeTop(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, materialize(value)]));
}

function writeSegments(target: Record<string, unknown>, segments: string[], value: unknown, isDelete: boolean) {
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = node[segment];
    node[segment] = existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
    node = node[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (isDelete) delete node[last];
  else node[last] = value;
}

function isFieldPath(value: unknown): value is { segments: string[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { segments?: unknown }).segments);
}

function applyUpdate(target: Record<string, unknown>, args: unknown[]) {
  if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !isFieldPath(args[0])) {
    for (const [key, raw] of Object.entries(args[0] as Record<string, unknown>)) {
      writeSegments(target, key.split('.'), materialize(raw), raw === FIELD_DELETE);
    }
    return;
  }
  for (let i = 0; i + 1 < args.length; i += 2) {
    const path = args[i];
    const segments = isFieldPath(path) ? path.segments : String(path).split('.');
    writeSegments(target, segments, materialize(args[i + 1]), args[i + 1] === FIELD_DELETE);
  }
}

function snap(path: string) {
  const data = store[path];
  return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
}

interface FakeDocRef {
  _path: string;
  get: () => Promise<ReturnType<typeof snap>>;
  set: (data: Record<string, unknown>, opts?: { merge?: boolean }) => Promise<void>;
  create: (data: Record<string, unknown>) => Promise<void>;
  update: (...args: unknown[]) => Promise<void>;
  collection: (name: string) => ReturnType<typeof collectionRef>;
}

function docRef(path: string): FakeDocRef {
  return {
    _path: path,
    get: async () => snap(path),
    set: async (data, opts) => {
      const next = materializeTop(data);
      store[path] = opts?.merge ? { ...(store[path] ?? {}), ...next } : next;
    },
    create: async (data) => {
      if (store[path] !== undefined) throw Object.assign(new Error(`already exists: ${path}`), { code: 6 });
      store[path] = materializeTop(data);
    },
    update: async (...args) => {
      if (!store[path]) throw new Error(`update on missing doc: ${path}`);
      const next = { ...store[path] };
      applyUpdate(next, args);
      store[path] = next;
    },
    collection: (name) => collectionRef(`${path}/${name}`),
  };
}

function collectionRef(prefix: string) {
  return {
    doc: (id: string) => docRef(`${prefix}/${id}`),
    get: async () => ({
      docs: Object.keys(store)
        .filter((path) => path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/'))
        .map((path) => ({ id: path.slice(prefix.length + 1), data: () => ({ ...store[path] }) })),
    }),
  };
}

const mockFakeDb = {
  getAll: async (...refs: FakeDocRef[]) => Promise.all(refs.map((ref) => ref.get())),
  collection: (name: string) => collectionRef(name),
  runTransaction: async (fn: (txn: unknown) => Promise<unknown>) =>
    fn({
      get: async (ref: FakeDocRef) => snap(ref._path),
      set: (ref: FakeDocRef, data: Record<string, unknown>) => {
        store[ref._path] = materializeTop(data);
      },
      update: (ref: FakeDocRef, ...args: unknown[]) => {
        const next = { ...store[ref._path] };
        applyUpdate(next, args);
        store[ref._path] = next;
      },
    }),
};

const finish = (unified: 'stop' | 'tool-calls') => ({
  type: 'finish' as const,
  finishReason: { unified, raw: undefined },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});

/** A model that makes this one call, then answers in text. */
function modelCalling(name: string, input: unknown) {
  let step = 0;
  (llm.createModel as jest.Mock).mockImplementation(
    () =>
      new MockLanguageModelV3({
        doStream: async () => {
          step += 1;
          return {
            stream: simulateReadableStream({
              chunks:
                step === 1
                  ? [
                      { type: 'tool-call' as const, toolCallId: 'call-1', toolName: name, input: JSON.stringify(input) },
                      finish('tool-calls'),
                    ]
                  : [
                      { type: 'text-start' as const, id: 't1' },
                      { type: 'text-delta' as const, id: 't1', delta: 'done' },
                      { type: 'text-end' as const, id: 't1' },
                      finish('stop'),
                    ],
            }),
          };
        },
      }),
  );
}

const pendingPath = (machine: string) => `sites/${SITE_ID}/machines/${machine}/commands/pending`;
const completedPath = (machine: string) => `sites/${SITE_ID}/machines/${machine}/commands/completed`;

function queued(machine: string) {
  return Object.values((store[pendingPath(machine)] ?? {}) as Record<string, Record<string, unknown>>);
}

function toolParts(chatId: string) {
  const messages = (store[`chats/${chatId}`]?.messages ?? []) as Array<{ parts: Array<Record<string, unknown>> }>;
  return messages.flatMap((message) => message.parts).filter((part) => String(part.type).startsWith('tool-'));
}

async function waitFor(condition: () => boolean, what: string) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 8000) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const userMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'x' }] } as UIMessage;

async function send(
  chatId: string,
  who: { userId: string; keyContext?: unknown },
  machineIds = [M1],
  messages: UIMessage[] = [userMessage],
) {
  mockAuth.current = { userId: who.userId, keyContext: who.keyContext ?? null };
  const res = await POST(
    new NextRequest('http://x/api/hoot', {
      method: 'POST',
      body: JSON.stringify({ siteId: SITE_ID, chatId, messages, target: { machineIds } }),
    }),
  );
  expect(res.status).toBe(200);
  await res.text();
}

const realSetInterval = global.setInterval;
const intervals: Array<ReturnType<typeof setInterval>> = [];

beforeAll(() => {
  jest.spyOn(global, 'setInterval').mockImplementation(((handler: () => void, timeout?: number) => {
    const handle = realSetInterval(handler, timeout);
    intervals.push(handle);
    return handle;
  }) as typeof setInterval);
});

afterAll(() => {
  (global.setInterval as unknown as jest.Mock).mockRestore();
});

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  _resetThrottleForTests();
  _setTurnTimingForTests();
  (llm.createCheapModel as jest.Mock).mockReturnValue('CHEAP_MODEL');

  store[`sites/${SITE_ID}`] = { name: 's' };
  for (const machine of [M1, M2]) {
    store[`sites/${SITE_ID}/machines/${machine}`] = { online: true, cortexEnabled: true };
  }
  for (const [uid, role] of [['admin-a', 'admin'], ['member-c', 'member']]) {
    store[`users/${uid}`] = { role: 'user', sites: [SITE_ID] };
    store[`sites/${SITE_ID}/members/${uid}`] = { role, uid, status: 'active' };
    store[`users/${uid}/settings/llm`] = { provider: 'anthropic', apiKeyEncrypted: 'blob' };
  }
});

afterEach(() => {
  for (const handle of intervals.splice(0)) clearInterval(handle);
  _setTurnTimingForTests();
});

/** Answers every queued command, as an agent would. */
function agentAnswers(machines: string[]) {
  return realSetInterval(() => {
    for (const machine of machines) {
      const done = Object.fromEntries(
        Object.keys(store[pendingPath(machine)] ?? {}).map((id) => [id, { status: 'completed', result: 'ok' }]),
      );
      if (Object.keys(done).length) store[completedPath(machine)] = { ...(store[completedPath(machine)] ?? {}), ...done };
    }
  }, 50);
}

const MEMBER = { userId: 'member-c' };
const ADMIN = { userId: 'admin-a' };
const CHAT_KEY = { userId: 'admin-a', keyContext: { keyId: 'k1' } };

function refusedPart(chatId: string) {
  const part = toolParts(chatId)[0];
  expect(part.state).toBe('output-available');
  const output = part.output as { error?: string; detail?: string };
  expect(output.error).toBe('tool_params_invalid');
  expect(output.detail).not.toContain('Set-Content');
}

describe('refused with nothing queued', () => {
  it.each<[string, { userId: string; keyContext?: unknown }, string, Record<string, unknown>]>([
    ['a read-only member, log_name', MEMBER, 'get_event_logs', { log_name: `Application -Newest 1; ${P}; #` }],
    ['a read-only member, level', MEMBER, 'get_event_logs', { log_name: 'Application', level: `Error; ${P}; #` }],
    ['a chat-scoped api key, log_name', CHAT_KEY, 'get_event_logs', { log_name: `Application -Newest 1; ${P}; #` }],
    ['a read-only member, a service name read as an option', MEMBER, 'get_service_status', { service_name: '-Hroot@host.example' }],
    ['an admin, process_name', ADMIN, 'get_event_logs_filtered', { log_name: 'Application', process_name: `x'+(${P})+'` }],
    ['an admin, name_filter', ADMIN, 'manage_windows_feature', { type: 'appx_package', action: 'list', name_filter: `x${RQ}}; ${P}; #` }],
    ['an admin, a toast title', ADMIN, 'show_notification', { title: `x'; ${P}; $y='`, message: 'm' }],
    ['an admin, a task description', ADMIN, 'manage_scheduled_task', { action: 'create', task_name: 't', description: `x${RQ}; ${P}; #` }],
    ['an admin, an unknown parameter', ADMIN, 'restart_process', { process_name: 'x', evil: true }],
  ])('%s', async (label, who, tool, input) => {
    const chatId = `chat-${label.replace(/\W+/g, '-')}`;
    modelCalling(tool, input);
    await send(chatId, who);
    await waitFor(() => toolParts(chatId).length > 0, 'the tool part');
    expect(queued(M1)).toEqual([]);
    refusedPart(chatId);
  }, 20000);

  it('a tier 3 call with the site approval setting off', async () => {
    store[`sites/${SITE_ID}/settings/cortex`] = { requireTier3Approval: false };
    modelCalling('run_powershell', { script: 'Get-Date', timeout_seconds: 5 });
    await send('chat-open', ADMIN);
    await waitFor(() => toolParts('chat-open').length > 0, 'the tool part');
    expect(queued(M1)).toEqual([]);
    refusedPart('chat-open');
  }, 20000);

  it('a tier 3 call gets no card, since no answer could run it', async () => {
    modelCalling('run_powershell', { script: 'Get-Date', timeout_seconds: 5 });
    await send('chat-card', ADMIN);
    await waitFor(() => toolParts('chat-card')[0]?.state === 'output-available', 'the answer');
    expect(queued(M1)).toEqual([]);
    refusedPart('chat-card');
  }, 20000);

  it('a site-wide turn refuses for every machine', async () => {
    modelCalling('get_event_logs', { log_name: `Application -Newest 1; ${P}; #` });
    await send('chat-fan', MEMBER, [M1, M2]);
    await waitFor(() => toolParts('chat-fan').length > 0, 'the tool part');
    expect(queued(M1)).toEqual([]);
    expect(queued(M2)).toEqual([]);
    refusedPart('chat-fan');
  }, 20000);
});

describe('still queued', () => {
  it.each<[string, { userId: string }, string, Record<string, unknown>]>([
    ['a member reads a real log', MEMBER, 'get_event_logs', { log_name: 'System', level: 'Error', max_events: 5 }],
    ['a member reads a real service', MEMBER, 'get_service_status', { service_name: 'wuauserv' }],
    ['an admin filters on a provider with spaces', ADMIN, 'get_event_logs_filtered', { log_name: 'Application', process_name: 'Application Error' }],
    ['an admin lists a feature', ADMIN, 'manage_windows_feature', { type: 'appx_package', action: 'list', name_filter: 'Xbox' }],
    ['an admin shows a toast', ADMIN, 'show_notification', { title: 'owlette', message: 'back at 5pm' }],
  ])('%s', async (label, who, tool, input) => {
    const chatId = `chat-${label.replace(/\W+/g, '-')}`;
    modelCalling(tool, input);
    const agent = agentAnswers([M1]);
    await send(chatId, who);
    await waitFor(() => queued(M1).length > 0, 'the queued command');
    clearInterval(agent);
    expect(queued(M1)).toEqual([expect.objectContaining({ type: 'mcp_tool_call', tool_name: tool, tool_params: input })]);
  }, 20000);
});
