/** @jest-environment node */

/**
 * a task a granted machine hands hoot (lib/fleet/task.server.ts), through
 * dispatch, over an in-memory admin-sdk fake. the turn itself is hoot's and has
 * its own suites: here the runner, the lock, the reader and the site lookups
 * are boundaries, and what is asserted is what the task hands them, what it
 * writes, and when it refuses.
 */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockStartTurn = jest.fn();
jest.mock('@/lib/hoot/turnRunner.server', () => ({
  startTurn: (...args: unknown[]) => mockStartTurn(...args),
}));
const mockAcquireTurnLock = jest.fn();
let turnIds = 0;
jest.mock('@/lib/hoot/turnStore.server', () => ({
  ...jest.requireActual('@/lib/hoot/turnStore.server'),
  acquireTurnLock: (...args: unknown[]) => mockAcquireTurnLock(...args),
  generateTurnId: () => `turn_test${++turnIds}`,
}));
const mockReadTurn = jest.fn();
jest.mock('@/lib/hoot/turnReader.server', () => ({
  readTurn: (...args: unknown[]) => mockReadTurn(...args),
}));
const mockResolveSiteKeyOwner = jest.fn();
const mockAssertLlmKeyAvailable = jest.fn();
const mockVerifyUserSiteAccess = jest.fn();
const mockResolveHootTargets = jest.fn();
jest.mock('@/lib/hoot-utils.server', () => ({
  ...jest.requireActual('@/lib/hoot-utils.server'),
  resolveSiteKeyOwner: (...args: unknown[]) => mockResolveSiteKeyOwner(...args),
  assertLlmKeyAvailable: (...args: unknown[]) => mockAssertLlmKeyAvailable(...args),
  verifyUserSiteAccess: (...args: unknown[]) => mockVerifyUserSiteAccess(...args),
  resolveHootTargets: (...args: unknown[]) => mockResolveHootTargets(...args),
}));

import { Capability } from '@/lib/capabilities';
import { problemRateLimited } from '@/lib/apiErrors';
import { TURN_STALE_MS } from '@/lib/hoot/turnStore.server';
import { FLEET_CALLS_COLLECTION } from '@/lib/fleet/calls.server';
import type { AdmitFleetCall, FleetCallRead, FleetCallStart, FleetContext } from '@/lib/fleet/context';
import { readFleetCall, startFleetCall } from '@/lib/fleet/dispatch.server';
import type { FleetGrant } from '@/lib/fleet/policy.server';
import { FLEET_TASKS_PER_HOUR } from '@/lib/fleet/task.server';

type Data = Record<string, unknown>;

const SITE = 'site-a';
const SENDER = 'sender-1';
const M1 = 'kiosk-1';
const M2 = 'kiosk-2';
const OWNER = 'uid-owner';
const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const TIMEOUT_SECONDS = 600 + TURN_STALE_MS / 1000;

let docs: Map<string, Data>;
let reads: string[];

function docRef(path: string) {
  return {
    path,
    get: async () => {
      reads.push(path);
      const data = docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    set: async (payload: Data) => {
      docs.set(path, payload);
    },
    update: async (patch: Data) => {
      docs.set(path, { ...docs.get(path), ...patch });
    },
    delete: async () => {
      docs.delete(path);
    },
  };
}

function query(path: string, filters: Array<[string, unknown]>) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`fake firestore answers == only, got ${op}`);
      return query(path, [...filters, [field, value]]);
    },
    get: async () => {
      reads.push(`${path}?${filters.map(([field]) => field).join('&')}`);
      return {
        docs: [...docs.entries()]
          .filter(([p]) => p.startsWith(`${path}/`))
          .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
          .map(([p, data]) => ({ id: p.slice(path.length + 1), data: () => data })),
      };
    },
  };
}

const db = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`), where: query(name, []).where }),
} as unknown as Firestore;

function ctxFor(grant: FleetGrant, machineId = SENDER): FleetContext {
  return {
    actor: { type: 'machine', siteId: SITE, machineId, maxTier: grant.maxTier, machineIds: grant.machineIds },
    siteId: SITE,
    machineId,
    grant,
    correlationId: 'corr-1',
    db,
  };
}

const TIER2 = ctxFor({ maxTier: 2, machineIds: [M1, M2] });
const OWNER_ACCESS = {
  role: 'member',
  standing: { role: 'owner', swoopMode: null, machineIds: null },
  isSuperadmin: false,
  isSiteAdmin: true,
  isSiteOwner: true,
};

const admit = jest.fn<ReturnType<AdmitFleetCall>, Parameters<AdmitFleetCall>>();
const cancelStream = jest.fn();

function ask(ctx: FleetContext, params: unknown) {
  return startFleetCall(ctx, { tool: 'ask_hoot', params }, admit);
}

function started(result: FleetCallStart) {
  if (!result.ok || result.kind !== 'started') throw new Error(`expected a started task, got ${JSON.stringify(result)}`);
  return result.body;
}

async function refusedWith(promise: Promise<FleetCallStart | FleetCallRead>, status: number, code?: string) {
  const result = await promise;
  if (result.ok) throw new Error(`expected a ${status} refusal, got ${JSON.stringify(result)}`);
  expect(result.response.status).toBe(status);
  if (code) expect((await result.response.json()).code).toBe(code);
  return result;
}

function records(): Array<[string, Data]> {
  return [...docs.entries()].filter(([path]) => path.startsWith(`${FLEET_CALLS_COLLECTION}/`));
}

function chats(): Array<[string, Data]> {
  return [...docs.entries()].filter(([path]) => path.startsWith('chats/'));
}

/** a task record of this sender's, as an earlier start left it. */
function seedTask(turnId: string, record: Data = {}) {
  docs.set(`${FLEET_CALLS_COLLECTION}/${turnId}`, {
    siteId: SITE,
    callerMachineId: SENDER,
    tool: 'ask_hoot',
    chatId: `machine_${turnId}`,
    createdAt: NOW - 10 * 60_000,
    expiresAt: NOW + HOUR,
    ...record,
  });
}

function nothingStarted() {
  expect(mockStartTurn).not.toHaveBeenCalled();
  expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  expect(chats()).toEqual([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  reads = [];
  turnIds = 0;
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  admit.mockResolvedValue(null);
  cancelStream.mockResolvedValue(undefined);
  mockStartTurn.mockReturnValue({ cancel: cancelStream });
  mockAcquireTurnLock.mockResolvedValue(null);
  mockReadTurn.mockResolvedValue({ status: 'running' });
  mockResolveSiteKeyOwner.mockResolvedValue(OWNER);
  mockAssertLlmKeyAvailable.mockResolvedValue(undefined);
  mockVerifyUserSiteAccess.mockResolvedValue(OWNER_ACCESS);
  mockResolveHootTargets.mockResolvedValue({
    ok: true,
    resolved: { ids: [M1], fanOut: false, skipped: { offline: [M2], disabled: [] } },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('starting a task for hoot', () => {
  it('starts one hoot turn as the machine, on the site owner\'s key, and says how long to wait', async () => {
    const body = started(await ask(TIER2, { prompt: '  why is the lobby wall dark?  ', machines: [M1] }));

    const [[recordPath, record]] = records();
    const turnId = recordPath.slice(FLEET_CALLS_COLLECTION.length + 1);
    const [[chatPath, chat]] = chats();
    const chatId = chatPath.slice('chats/'.length);
    expect(body).toEqual({ callId: `task:${chatId}:${turnId}`, timeoutSeconds: TIMEOUT_SECONDS });
    expect(chatId).toMatch(/^machine_[A-Za-z0-9_-]+$/);

    expect(record).toEqual({
      siteId: SITE,
      callerMachineId: SENDER,
      tool: 'ask_hoot',
      chatId,
      createdAt: NOW,
      expiresAt: NOW + TIMEOUT_SECONDS * 1000 + HOUR,
    });
    expect(chat).toMatchObject({
      source: 'machine',
      siteId: SITE,
      userId: OWNER,
      title: `task from ${SENDER}`,
      callerMachineId: SENDER,
      targetMachineIds: [M1],
      messages: [],
    });

    expect(mockAcquireTurnLock).toHaveBeenCalledWith(db, chatId, {
      turnId,
      siteId: SITE,
      machineId: M1,
      target: { machineIds: [M1], fanOut: false, source: 'machine' },
      resolvedMachineIds: [M1],
    });
    expect(mockStartTurn).toHaveBeenCalledTimes(1);
    const params = mockStartTurn.mock.calls[0][1];
    expect(params).toMatchObject({
      chatId,
      turnId,
      siteId: SITE,
      userId: OWNER,
      // the site owner's standing, held to the machines the grant covers
      access: { ...OWNER_ACCESS, standing: { role: 'owner', swoopMode: null, machineIds: [M1, M2] } },
      resolved: { ids: [M1], fanOut: false, skipped: { offline: [M2], disabled: [] } },
      turnTarget: { machineIds: [M1], fanOut: false, source: 'machine' },
      maxToolTier: 2,
      priorTurn: null,
      machineActor: TIER2.actor,
    });
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]).toMatchObject({ id: `task_msg_${turnId}`, role: 'user' });
    const text: string = params.messages[0].parts[0].text;
    expect(text).toContain(`the machine ${SENDER}`);
    expect(text.endsWith('why is the lobby wall dark?')).toBe(true);
    // nobody reads the response branch
    expect(cancelStream).toHaveBeenCalledTimes(1);
  });

  it('is admitted as a command on no one machine, after every check and before anything is written', async () => {
    admit.mockResolvedValue(problemRateLimited(30));
    const res = await ask(TIER2, { prompt: 'check the wall', machines: [M1] });

    expect(res.ok).toBe(false);
    expect(admit).toHaveBeenCalledWith({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'ask_hoot', machineId: null });
    expect(mockResolveHootTargets).toHaveBeenCalled();
    expect(records()).toEqual([]);
    nothingStarted();
  });

  it('resolves the machines it names inside the grant', async () => {
    await ask(TIER2, { prompt: 'check the wall', machines: [M2, M1, M2] });

    expect(mockResolveHootTargets).toHaveBeenCalledWith(db, SITE, { requested: [M2, M1], machineScope: [M1, M2] });
  });

  it('with no machine named, works on those the grant covers and records the ones it reached', async () => {
    started(await ask(TIER2, { prompt: 'check everything' }));

    expect(mockResolveHootTargets).toHaveBeenCalledWith(db, SITE, { requested: null, machineScope: [M1, M2] });
    expect(mockStartTurn.mock.calls[0][1].turnTarget).toEqual({ machineIds: [M1], fanOut: false, source: 'machine' });
  });

  it('with no machine named on a whole-site grant, works on the whole site', async () => {
    mockResolveHootTargets.mockResolvedValue({
      ok: true,
      resolved: { ids: [M1, M2], fanOut: true, skipped: { offline: [], disabled: [] } },
    });
    started(await ask(ctxFor({ maxTier: 2, machineIds: null }), { prompt: 'check everything' }));

    expect(mockResolveHootTargets).toHaveBeenCalledWith(db, SITE, { requested: null, machineScope: null });
    const params = mockStartTurn.mock.calls[0][1];
    expect(params.turnTarget).toEqual({ machineIds: null, fanOut: true, source: 'machine' });
    expect(params.access.standing.machineIds).toBeNull();
    expect(chats()[0][1]).toMatchObject({ targetType: 'site' });
  });

  it.each([
    [2, 2],
    [3, 2],
  ] as const)('a tier %i sender\'s task runs at tier %i: nobody is there to approve more', async (maxTier, turnTier) => {
    started(await ask(ctxFor({ maxTier, machineIds: [M1] }), { prompt: 'check the wall' }));

    expect(mockStartTurn.mock.calls[0][1].maxToolTier).toBe(turnTier);
  });

  it('is not offered to a tier 1 sender', async () => {
    const res = await refusedWith(ask(ctxFor({ maxTier: 1, machineIds: [M1] }), { prompt: 'check the wall' }), 403, 'tool_not_allowed');

    expect(res.deny).toEqual({ reason: 'tool_not_allowed', tool: 'ask_hoot', machineId: null });
    expect(reads).toEqual([]);
  });
});

describe('a task that is refused', () => {
  it.each([
    ['no prompt', {}],
    ['an empty prompt', { prompt: '   ' }],
    ['a prompt that is not text', { prompt: 7 }],
    ['a prompt past the limit', { prompt: 'x'.repeat(8001) }],
    ['machines that are not a list', { prompt: 'p', machines: M1 }],
    ['an empty list of machines', { prompt: 'p', machines: [] }],
    ['a machine id that is a path', { prompt: 'p', machines: [`${M1}/commands/pending`] }],
    ['more machines than a turn takes', { prompt: 'p', machines: Array.from({ length: 65 }, (_, i) => `m-${i}`) }],
  ])('400 for %s, before anything is read', async (_label, params) => {
    const res = await refusedWith(ask(TIER2, params), 400, 'validation_failed');

    expect(res.deny).toEqual({ reason: 'validation_failed', tool: 'ask_hoot', machineId: null });
    expect(reads).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
    nothingStarted();
  });

  it('403 for a machine outside the grant, naming it, with nothing read', async () => {
    const res = await refusedWith(ask(TIER2, { prompt: 'p', machines: [M1, 'kiosk-9'] }), 403, 'machine_not_granted');

    expect(res.deny).toEqual({ reason: 'machine_not_granted', tool: 'ask_hoot', machineId: 'kiosk-9' });
    expect(reads).toEqual([]);
    expect(mockResolveHootTargets).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    nothingStarted();
  });

  it('403 when the grant names no machine and the task names none', async () => {
    await refusedWith(ask(ctxFor({ maxTier: 3, machineIds: [] }), { prompt: 'p' }), 403, 'machine_not_granted');

    expect(reads).toEqual([]);
    nothingStarted();
  });

  it.each([
    ['the site has no owner', () => mockResolveSiteKeyOwner.mockRejectedValue(new Error('no owner'))],
    ['the site owner has no llm key', () => mockAssertLlmKeyAvailable.mockRejectedValue(new Error('No LLM API key configured.'))],
    ['the site owner has lost the site', () => mockVerifyUserSiteAccess.mockRejectedValue(new Error('no access'))],
  ])('409 hoot_unavailable when %s, saying where the key goes and nothing of why', async (_label, arrange) => {
    arrange();
    const res = await refusedWith(ask(TIER2, { prompt: 'p' }), 409, 'hoot_unavailable');

    expect(res.deny).toEqual({ reason: 'hoot_unavailable', tool: 'ask_hoot', machineId: null });
    expect(records()).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
    nothingStarted();
  });

  it.each([
    ['machine_offline', 503, 'machine_offline'],
    ['no_machines', 503, 'machine_offline'],
    ['hoot_disabled', 423, 'hoot_disabled'],
  ])('409 when no machine can take it (%s)', async (reason, status, code) => {
    mockResolveHootTargets.mockResolvedValue({ ok: false, status, reason, machineIds: [M1] });
    const res = await refusedWith(ask(TIER2, { prompt: 'p', machines: [M1] }), 409, code);

    expect(res.deny).toEqual({ reason: code, tool: 'ask_hoot', machineId: null });
    expect(records()).toEqual([]);
    nothingStarted();
  });

  it('400 when a named machine is not in the site', async () => {
    mockResolveHootTargets.mockResolvedValue({ ok: false, status: 400, reason: 'unknown_machine', machineIds: [M2] });

    await refusedWith(ask(TIER2, { prompt: 'p', machines: [M2] }), 400, 'validation_failed');
    nothingStarted();
  });

  it('409 when the turn cannot be claimed, and the record is taken back', async () => {
    mockAcquireTurnLock.mockRejectedValue(new Error('firestore unavailable'));

    await refusedWith(ask(TIER2, { prompt: 'p' }), 409, 'hoot_unavailable');
    expect(records()).toEqual([]);
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe('the task budget', () => {
  it(`refuses the task after ${FLEET_TASKS_PER_HOUR} in an hour, until the oldest of them is an hour old`, async () => {
    for (let i = 0; i < FLEET_TASKS_PER_HOUR; i++) {
      seedTask(`turn_old${i}`, { createdAt: NOW - (50 - i) * 60_000, collectedAt: NOW - 60_000 });
    }

    const res = await refusedWith(ask(TIER2, { prompt: 'p' }), 429);
    expect(res.response.headers.get('Retry-After')).toBe(String(10 * 60));
    expect(res.deny).toEqual({ reason: 'task_budget_spent', tool: 'ask_hoot', machineId: null });
    expect(admit).not.toHaveBeenCalled();
    nothingStarted();
  });

  it('counts only this sender\'s tasks of the last hour', async () => {
    for (let i = 0; i < FLEET_TASKS_PER_HOUR - 1; i++) seedTask(`turn_old${i}`, { collectedAt: NOW - 60_000 });
    seedTask('turn_stale', { createdAt: NOW - HOUR - 1, collectedAt: NOW - HOUR });
    seedTask('turn_other', { callerMachineId: 'sender-2', collectedAt: NOW - 60_000 });
    seedTask('turn_othersite', { siteId: 'site-b', collectedAt: NOW - 60_000 });
    docs.set(`${FLEET_CALLS_COLLECTION}/cmd_1`, { siteId: SITE, callerMachineId: SENDER, machineId: M1, tool: 'restart_process', createdAt: NOW, expiresAt: NOW + HOUR });

    started(await ask(TIER2, { prompt: 'p' }));
  });

  it('refuses a second task while one is running', async () => {
    seedTask('turn_running');
    mockReadTurn.mockResolvedValue({ status: 'running' });

    const res = await refusedWith(ask(TIER2, { prompt: 'p' }), 429);
    expect(res.deny).toEqual({ reason: 'task_running', tool: 'ask_hoot', machineId: null });
    expect(mockReadTurn).toHaveBeenCalledWith(db, 'machine_turn_running', 'turn_running');
    nothingStarted();
  });

  it.each([
    ['its turn has finished unread', () => mockReadTurn.mockResolvedValue({ status: 'complete', text: 'done' })],
    ['its turn failed', () => mockReadTurn.mockResolvedValue({ status: 'failed', error: 'x' })],
  ])('starts a task when the earlier one is over: %s', async (_label, arrange) => {
    seedTask('turn_earlier');
    arrange();

    started(await ask(TIER2, { prompt: 'p' }));
  });

  it('does not read the turn of a task already collected or expired', async () => {
    seedTask('turn_collected', { collectedAt: NOW - 1000 });
    seedTask('turn_expired', { expiresAt: NOW - 1 });

    started(await ask(TIER2, { prompt: 'p' }));
    expect(mockReadTurn).not.toHaveBeenCalled();
  });
});

describe('reading a task back', () => {
  async function startOne(ctx = TIER2) {
    const { callId } = started(await ask(ctx, { prompt: 'check the wall' }));
    const [, chatId, turnId] = callId.split(':');
    return { callId, chatId, turnId, recordPath: `${FLEET_CALLS_COLLECTION}/${turnId}` };
  }

  function body(result: FleetCallRead) {
    if (!result.ok) throw new Error('expected a read');
    return result.body;
  }

  async function notFound(promise: Promise<FleetCallRead>) {
    const result = await refusedWith(promise, 404);
    expect(result.deny).toBeUndefined();
  }

  it('is in progress while the turn runs, and the record is left as it is', async () => {
    const task = await startOne();
    mockReadTurn.mockResolvedValue({ status: 'running' });

    expect(body(await readFleetCall(TIER2, task.callId))).toEqual({ status: 'in_progress' });
    expect(mockReadTurn).toHaveBeenLastCalledWith(db, task.chatId, task.turnId);
    expect(docs.get(task.recordPath)).not.toHaveProperty('collectedAt');
  });

  it('hands over the answer once: the record stays, marked, and a repeat is 404', async () => {
    const task = await startOne();
    mockReadTurn.mockResolvedValue({ status: 'complete', text: 'the wall is on input 2.' });

    expect(body(await readFleetCall(TIER2, task.callId))).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: 'the wall is on input 2.' }],
    });
    expect(docs.get(task.recordPath)).toMatchObject({ collectedAt: NOW, createdAt: NOW });
    await notFound(readFleetCall(TIER2, task.callId));
  });

  it('says so when hoot wrote no answer', async () => {
    const task = await startOne();
    mockReadTurn.mockResolvedValue({ status: 'complete', text: '' });

    expect(body(await readFleetCall(TIER2, task.callId))).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: 'hoot finished the task without a written answer' }],
    });
  });

  it('a failed turn is a failed call with its reason, handed over once', async () => {
    const task = await startOne();
    mockReadTurn.mockResolvedValue({ status: 'failed', error: 'the turn stopped without finishing' });

    expect(body(await readFleetCall(TIER2, task.callId))).toEqual({
      status: 'failed',
      error: 'the turn stopped without finishing',
    });
    await notFound(readFleetCall(TIER2, task.callId));
  });

  it('404 for another machine\'s task, whose turn is not read', async () => {
    const task = await startOne();
    mockReadTurn.mockClear();

    await notFound(readFleetCall(ctxFor({ maxTier: 3, machineIds: null }, 'sender-2'), task.callId));
    expect(mockReadTurn).not.toHaveBeenCalled();
    expect(docs.get(task.recordPath)).not.toHaveProperty('collectedAt');
  });

  it('404 for the right turn under another chat', async () => {
    const task = await startOne();
    mockReadTurn.mockClear();

    await notFound(readFleetCall(TIER2, `task:machine_other:${task.turnId}`));
    expect(mockReadTurn).not.toHaveBeenCalled();
  });

  it('404 once the record has expired', async () => {
    const task = await startOne();
    (Date.now as jest.Mock).mockReturnValue(NOW + TIMEOUT_SECONDS * 1000 + HOUR);
    mockReadTurn.mockClear();

    await notFound(readFleetCall(TIER2, task.callId));
    expect(mockReadTurn).not.toHaveBeenCalled();
  });

  it.each([
    'task:',
    'task:machine_1',
    'task:machine_1:cmd_abc',
    'task:chats/x:turn_abc',
    'task:machine_1:turn_abc:extra',
  ])('404 for the malformed id %s, with nothing read', async (callId) => {
    await notFound(readFleetCall(TIER2, callId));
    expect(reads).toEqual([]);
  });

  it('404 for a queued command read as a task', async () => {
    docs.set(`${FLEET_CALLS_COLLECTION}/turn_cmd`, { siteId: SITE, callerMachineId: SENDER, machineId: M1, tool: 'restart_process', createdAt: NOW, expiresAt: NOW + HOUR });

    await notFound(readFleetCall(TIER2, 'task:machine_1:turn_cmd'));
    expect(mockReadTurn).not.toHaveBeenCalled();
  });

  it('lets a failed read of the turn through, so the script polls again', async () => {
    const task = await startOne();
    mockReadTurn.mockRejectedValue(new Error('firestore unavailable'));

    await expect(readFleetCall(TIER2, task.callId)).rejects.toThrow('firestore unavailable');
    expect(docs.get(task.recordPath)).not.toHaveProperty('collectedAt');
  });
});
