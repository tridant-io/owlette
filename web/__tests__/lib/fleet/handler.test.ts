/** @jest-environment node */

/**
 * `fleetHandler`, `admitFleetCall` and `denyFleetCall`
 * (lib/fleet/handler.server.ts). the session store and the grant loader are
 * the real ones, over an in-memory admin-sdk fake keyed by document path, so
 * expiry and revocation are real; the audit writers, the rate limiter and the
 * plan check are spies.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from 'next/server';

type Data = Record<string, unknown>;

let store: Map<string, Data>;
let getCalls: string[];
let getError: Error | null;
let setError: Error | null;
let commitError: Error | null;

function docRef(path: string) {
  const id = path.slice(path.lastIndexOf('/') + 1);
  return {
    id,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => {
      if (getError) throw getError;
      getCalls.push(path);
      const data = store.get(path);
      return { exists: data !== undefined, id, data: () => data };
    },
    set: async (payload: Data) => {
      if (setError) throw setError;
      store.set(path, payload);
    },
    update: async (payload: Data) => {
      store.set(path, { ...store.get(path), ...payload });
    },
    delete: async () => {
      store.delete(path);
    },
  };
}

function query(collectionPath: string, filters: Array<[string, unknown]>) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`fake firestore answers == only, got ${op}`);
      return query(collectionPath, [...filters, [field, value]]);
    },
    get: async () => {
      const docs = [...store.entries()]
        .filter(([path]) => path.startsWith(`${collectionPath}/`) && !path.slice(collectionPath.length + 1).includes('/'))
        .filter(([, data]) => filters.every(([field, value]) => data[field] === value))
        .map(([path, data]) => ({ id: path.slice(collectionPath.length + 1), ref: docRef(path), data: () => data }));
      return { empty: docs.length === 0, size: docs.length, docs };
    },
  };
}

function collectionRef(path: string) {
  return { doc: (id?: string) => docRef(`${path}/${id ?? 'auto'}`), where: query(path, []).where };
}

const db = {
  collection: (name: string) => collectionRef(name),
  batch: () => {
    const pending: string[] = [];
    return {
      delete: (ref: { id: string }) => {
        pending.push(`fleet_sessions/${ref.id}`);
      },
      commit: async () => {
        if (commitError) throw commitError;
        for (const path of pending) store.delete(path);
      },
    };
  },
} as unknown as Firestore;

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => db }));

const writeAuditEntrySpy = jest.fn();
const writeAuditEntryBlockingSpy = jest.fn();
jest.mock('@/lib/auditLog.server', () => ({
  ...jest.requireActual('@/lib/auditLog.server'),
  writeAuditEntry: (...args: unknown[]) => writeAuditEntrySpy(...args),
  writeAuditEntryBlocking: (...args: unknown[]) => writeAuditEntryBlockingSpy(...args),
}));

// the real access core, which one test overrides
const hasCapabilitySpy = jest.fn();
jest.mock('@/lib/capabilities', () => ({
  ...jest.requireActual('@/lib/capabilities'),
  hasCapability: (...args: unknown[]) => hasCapabilitySpy(...args),
}));

const checkRateLimitSpy = jest.fn();
jest.mock('@/lib/rateLimit.server', () => ({
  ...jest.requireActual('@/lib/rateLimit.server'),
  checkRateLimit: (...args: unknown[]) => checkRateLimitSpy(...args),
}));

const requireEntitlementSpy = jest.fn();
jest.mock('@/lib/plan.server', () => ({
  requireEntitlement: (...args: unknown[]) => requireEntitlementSpy(...args),
}));

const securityConfigReadSpy = jest.fn();
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: { read: () => securityConfigReadSpy() },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import logger from '@/lib/logger';
import { problemPlanRequired } from '@/lib/apiErrors';
import { Capability } from '@/lib/capabilities';
import type { FleetCallAdmission, FleetContext } from '@/lib/fleet/context';
import { admitFleetCall, denyFleetCall, fleetHandler } from '@/lib/fleet/handler.server';

const SETTINGS_PATH = 'sites/site-a/settings/fleet';
const MACHINE_ACTOR_ROW = { type: 'machine', siteId: 'site-a', machineId: 'm-1' };
const TOOLS = '/api/agent/fleet/tools';
const CALL = '/api/agent/fleet/call';

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => `owf_${crypto.randomBytes(32).toString('base64url')}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function seedSession(machineId = 'm-1', expiresAt = Date.now() + 10 * 60_000): string {
  const token = newToken();
  store.set(`fleet_sessions/${hashOf(token)}`, { siteId: 'site-a', machineId, createdAt: Date.now(), expiresAt });
  return token;
}

function seedGrant(entry: Data = { maxTier: 2, machineIds: ['m-2'] }, enabled = true): void {
  store.set(SETTINGS_PATH, { enabled, senders: { 'm-1': entry } });
}

function makeRequest(authorization?: string, path = TOOLS, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method, headers: authorization ? { authorization } : {} });
}

const okHandler = () => jest.fn(async () => NextResponse.json({ ok: true }));

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function rateLimited(retryAfterSec: number) {
  return {
    ok: false,
    reason: 'rate_limited',
    retryAfterSec,
    limit: 60,
    remaining: 0,
    resetAtMs: Date.now() + retryAfterSec * 1000,
    rateLimitReason: 'endpoint-rate',
  };
}

/** one call request through the wrapper, admitting `admission` the way dispatch will. */
async function callThrough(admission: FleetCallAdmission) {
  const seen: { ctx: FleetContext | null; refusal: NextResponse | null } = { ctx: null, refusal: null };
  const handler = jest.fn(async (request: NextRequest, ctx: FleetContext) => {
    seen.ctx = ctx;
    seen.refusal = await admitFleetCall(request, ctx)(admission);
    return seen.refusal ?? NextResponse.json({ callId: 'cmd:m-2:abc' }, { status: 202 });
  });
  const res = await fleetHandler(handler)(
    makeRequest(`Bearer ${token}`, CALL, 'POST'),
  );
  return { res, ...seen };
}

let token: string;

beforeEach(() => {
  jest.clearAllMocks();
  store = new Map();
  getCalls = [];
  getError = null;
  setError = null;
  commitError = null;
  hasCapabilitySpy.mockImplementation(jest.requireActual('@/lib/capabilities').hasCapability);
  writeAuditEntryBlockingSpy.mockResolvedValue(undefined);
  checkRateLimitSpy.mockResolvedValue({ ok: true, limit: 300, remaining: 299, resetAtMs: Date.now() + 60_000, rateLimitReason: 'endpoint-rate' });
  requireEntitlementSpy.mockResolvedValue(null);
  token = seedSession();
  seedGrant();
});

describe('fleetHandler: a granted machine', () => {
  it('reaches the handler with the machine actor, its grant, one correlation id and the db', async () => {
    const handler = jest.fn(async (_req: NextRequest, _ctx: FleetContext, rc: { params: Promise<{ callId: string }> }) =>
      NextResponse.json({ callId: (await rc.params).callId }),
    );
    const wrapped = fleetHandler<{ callId: string }>(handler);

    const res = await wrapped(makeRequest(`Bearer ${token}`), { params: Promise.resolve({ callId: 'cmd:m-2:abc' }) });

    expect(res.status).toBe(200);
    await expect(body(res)).resolves.toEqual({ callId: 'cmd:m-2:abc' });
    const ctx = handler.mock.calls[0][1];
    expect(ctx).toEqual({
      actor: { type: 'machine', siteId: 'site-a', machineId: 'm-1', maxTier: 2, machineIds: ['m-2'] },
      siteId: 'site-a',
      machineId: 'm-1',
      grant: { maxTier: 2, machineIds: ['m-2'] },
      correlationId: expect.stringMatching(/^[0-9a-f]{22}$/),
      db,
    });
    expect(ctx.db).toBe(db);
    expect(checkRateLimitSpy).toHaveBeenCalledWith(ctx.actor, Capability.MACHINE_VIEW, 'site-a');
    expect(requireEntitlementSpy).toHaveBeenCalledWith('site-a', 'owlette.hoot');
    expect(res.headers.get('RateLimit-Limit')).toBe('300');
  });

  it('reads the session and the grant with one document get each', async () => {
    await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`));
    expect(getCalls).toEqual([`fleet_sessions/${hashOf(token)}`, SETTINGS_PATH]);
  });

  it('carries a whole-site grant to the actor as null', async () => {
    seedGrant({ maxTier: 3, wholeSite: true });
    const handler = okHandler();
    await fleetHandler(handler)(makeRequest(`Bearer ${token}`));
    expect((handler.mock.calls[0] as unknown[])[1]).toMatchObject({ actor: { maxTier: 3, machineIds: null } });
  });

  it('writes no audit row for a request that only reads', async () => {
    const res = await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`));

    expect(res.status).toBe(200);
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('lets a handler throw propagate, writing no row', async () => {
    const handler = jest.fn(async () => {
      throw new TypeError('boom');
    });
    await expect(
      fleetHandler(handler)(makeRequest(`Bearer ${token}`)),
    ).rejects.toThrow('boom');
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('never reads the capability-enforcement switch', async () => {
    await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`));
    expect(securityConfigReadSpy).not.toHaveBeenCalled();
  });
});

describe('fleetHandler: refusals, in order', () => {
  async function expectProblem(res: Response, status: number, code: string): Promise<Record<string, unknown>> {
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = await body(res);
    expect(problem.code).toBe(code);
    return problem;
  }

  function deniedWith(denyReason: string, extra: Data = {}) {
    expect(writeAuditEntrySpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntrySpy).toHaveBeenCalledWith('site-a', {
      correlationId: expect.stringMatching(/^[0-9a-f]{22}$/),
      actor: MACHINE_ACTOR_ROW,
      capability: Capability.MACHINE_VIEW,
      target: { kind: 'site', id: 'site-a' },
      outcome: 'deny',
      denyReason,
      metadata: { route: TOOLS, method: 'GET', ...extra },
    });
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  }

  it.each([
    ['no Authorization header', undefined],
    ['a header that is not a bearer', `Basic ${newToken()}`],
    ['an empty bearer', 'Bearer '],
  ])('answers 401 fleet_session_invalid to %s, reading nothing', async (_label, header) => {
    const handler = okHandler();
    const res = await fleetHandler(handler)(makeRequest(header));

    await expectProblem(res, 401, 'fleet_session_invalid');
    expect(getCalls).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
  });

  it('answers 401 fleet_session_invalid to a session it never minted, before the grant', async () => {
    const res = await fleetHandler(okHandler())(makeRequest(`Bearer ${newToken()}`));

    await expectProblem(res, 401, 'fleet_session_invalid');
    expect(getCalls).not.toContain(SETTINGS_PATH);
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
  });

  it('answers 401 fleet_session_invalid to an expired session, and deletes it', async () => {
    const expired = seedSession('m-1', Date.now() - 1);
    const res = await fleetHandler(okHandler())(makeRequest(`Bearer ${expired}`));

    await expectProblem(res, 401, 'fleet_session_invalid');
    expect(store.has(`fleet_sessions/${hashOf(expired)}`)).toBe(false);
    expect(getCalls).not.toContain(SETTINGS_PATH);
  });

  it.each([
    ['the feature is off', () => seedGrant(undefined, false)],
    ['the site has no fleet settings', () => store.delete(SETTINGS_PATH)],
  ])('answers 403 fleet_not_granted when %s, and revokes the machine’s sessions', async (_label, arrange) => {
    arrange();
    const handler = okHandler();
    const res = await fleetHandler(handler)(makeRequest(`Bearer ${token}`));

    await expectProblem(res, 403, 'fleet_not_granted');
    expect(store.has(`fleet_sessions/${hashOf(token)}`)).toBe(false);
    deniedWith('fleet_not_granted');
    expect(checkRateLimitSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 403 fleet_not_granted to a machine that is not a sender, revoking its sessions and no other’s', async () => {
    store.set(SETTINGS_PATH, { enabled: true, senders: { 'm-2': { maxTier: 3, wholeSite: true } } });
    const other = seedSession('m-2');

    const res = await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`));

    await expectProblem(res, 403, 'fleet_not_granted');
    expect(store.has(`fleet_sessions/${hashOf(token)}`)).toBe(false);
    expect(store.has(`fleet_sessions/${hashOf(other)}`)).toBe(true);
    deniedWith('fleet_not_granted');
  });

  it('still answers 403 fleet_not_granted when the revoke fails', async () => {
    seedGrant(undefined, false);
    commitError = new Error('unavailable');

    const res = await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`));

    await expectProblem(res, 403, 'fleet_not_granted');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('answers 403 capability_missing when the access core refuses the machine at site level', async () => {
    hasCapabilitySpy.mockReturnValueOnce(false);
    const handler = okHandler();
    const res = await fleetHandler(handler)(makeRequest(`Bearer ${token}`));

    await expectProblem(res, 403, 'capability_missing');
    expect(hasCapabilitySpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'machine' }), Capability.MACHINE_VIEW, 'site-a');
    deniedWith('capability_missing');
    expect(checkRateLimitSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 429 when the machine bucket is spent, before the plan', async () => {
    checkRateLimitSpy.mockResolvedValue(rateLimited(12));
    const handler = okHandler();
    const res = await fleetHandler(handler)(makeRequest(`Bearer ${token}`));

    await expectProblem(res, 429, 'rate_limited');
    expect(res.headers.get('Retry-After')).toBe('12');
    deniedWith('rate_limited', { retryAfterSec: 12 });
    expect(requireEntitlementSpy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 402 plan_required when the payer lacks hoot', async () => {
    requireEntitlementSpy.mockResolvedValue(problemPlanRequired('no hoot', 'owlette.hoot'));
    const handler = okHandler();
    const res = await fleetHandler(handler)(makeRequest(`Bearer ${token}`));

    const problem = await expectProblem(res, 402, 'plan_required');
    expect(problem.entitlement).toBe('owlette.hoot');
    deniedWith('plan_locked', { entitlement: 'owlette.hoot' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 503 when the session cannot be read, and logs neither the session nor its hash', async () => {
    getError = new Error(`unavailable: fleet_sessions/${hashOf(token)}`);
    const res = await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`));

    expect(res.status).toBe(503);
    const logged = JSON.stringify(Object.values(logger).flatMap((fn) => (fn as jest.Mock).mock.calls));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logged).not.toContain(token.slice(4));
    expect(logged).not.toContain(hashOf(token));
  });
});

describe('admitFleetCall', () => {
  it('writes exactly one allow row, naming the tool and the machine', async () => {
    const { res, ctx } = await callThrough({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: 'm-2' });

    expect(res.status).toBe(202);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledWith('site-a', {
      correlationId: ctx?.correlationId,
      actor: MACHINE_ACTOR_ROW,
      capability: Capability.MACHINE_EXEC_COMMAND,
      target: { kind: 'machine', id: 'm-2' },
      outcome: 'allow',
      metadata: { route: CALL, method: 'POST', tool: 'restart_process', machineId: 'm-2' },
      enforcementBypassed: false,
    });
    expect(writeAuditEntrySpy).not.toHaveBeenCalled();
  });

  it('names the site as target for a tool that names no machine', async () => {
    await callThrough({ capability: Capability.MACHINE_VIEW, tool: 'list_machines', machineId: null });

    expect(writeAuditEntryBlockingSpy).toHaveBeenCalledWith(
      'site-a',
      expect.objectContaining({
        target: { kind: 'site', id: 'site-a' },
        metadata: { route: CALL, method: 'POST', tool: 'list_machines', machineId: null },
      }),
    );
  });

  it('charges a tier-1 call once in total, at entry', async () => {
    await callThrough({ capability: Capability.MACHINE_VIEW, tool: 'get_system_info', machineId: 'm-2' });

    expect(checkRateLimitSpy).toHaveBeenCalledTimes(1);
    expect(checkRateLimitSpy).toHaveBeenCalledWith(expect.anything(), Capability.MACHINE_VIEW, 'site-a');
  });

  it('charges a tier-2 call the view limit once and the exec limit once', async () => {
    await callThrough({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: 'm-2' });

    expect(checkRateLimitSpy.mock.calls.map((call) => call[1])).toEqual([
      Capability.MACHINE_VIEW,
      Capability.MACHINE_EXEC_COMMAND,
    ]);
    expect(checkRateLimitSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'machine', machineId: 'm-1' }),
      Capability.MACHINE_EXEC_COMMAND,
      'site-a',
    );
  });

  it('answers 429 when the call’s bucket is spent, with a deny row and no allow row', async () => {
    checkRateLimitSpy.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(rateLimited(30));

    const { res } = await callThrough({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: 'm-2' });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(writeAuditEntrySpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntrySpy).toHaveBeenCalledWith('site-a', expect.objectContaining({
      actor: MACHINE_ACTOR_ROW,
      capability: Capability.MACHINE_EXEC_COMMAND,
      target: { kind: 'machine', id: 'm-2' },
      outcome: 'deny',
      denyReason: 'rate_limited',
      metadata: { route: CALL, method: 'POST', tool: 'restart_process', machineId: 'm-2', retryAfterSec: 30 },
    }));
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('answers 503 when the allow row cannot be written', async () => {
    writeAuditEntryBlockingSpy.mockRejectedValue(new Error('unavailable'));

    const { res, refusal } = await callThrough({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: 'm-2' });

    expect(refusal?.status).toBe(503);
    expect(res.status).toBe(503);
  });
});

describe('denyFleetCall', () => {
  async function denyThrough(machineId: string | null) {
    const seen: { ctx: FleetContext | null } = { ctx: null };
    const handler = jest.fn(async (request: NextRequest, ctx: FleetContext) => {
      seen.ctx = ctx;
      denyFleetCall(request, ctx, { reason: 'machine_not_granted', tool: 'restart_process', machineId });
      return NextResponse.json({}, { status: 403 });
    });
    const res = await fleetHandler(handler)(
      makeRequest(`Bearer ${token}`, CALL, 'POST'),
    );
    return { res, ...seen };
  }

  it('writes a deny row with the reason, under the entry capability, and no allow row', async () => {
    const { ctx } = await denyThrough('m-3');

    expect(writeAuditEntrySpy).toHaveBeenCalledTimes(1);
    expect(writeAuditEntrySpy).toHaveBeenCalledWith('site-a', {
      correlationId: ctx?.correlationId,
      actor: MACHINE_ACTOR_ROW,
      capability: Capability.MACHINE_VIEW,
      target: { kind: 'machine', id: 'm-3' },
      outcome: 'deny',
      denyReason: 'machine_not_granted',
      metadata: { route: CALL, method: 'POST', tool: 'restart_process', machineId: 'm-3' },
    });
    expect(writeAuditEntryBlockingSpy).not.toHaveBeenCalled();
  });

  it('survives a failing audit writer without holding the response', async () => {
    const { writeAuditEntry } = jest.requireActual('@/lib/auditLog.server');
    writeAuditEntrySpy.mockImplementation(writeAuditEntry);
    setError = new Error('unavailable');

    const { res } = await denyThrough(null);
    await flush();

    expect(res.status).toBe(403);
    expect(logger.error).toHaveBeenCalledWith('audit log write failed (fire-and-forget)', expect.anything());
  });
});

describe('the bearer', () => {
  it('reaches no audit row, log line or response', async () => {
    const responses: string[] = [];
    const record = async (res: Response) => {
      responses.push(JSON.stringify([...res.headers.entries()]), await res.text());
    };

    await record(await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`)));
    await record((await callThrough({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: 'm-2' })).res);
    checkRateLimitSpy.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(rateLimited(5));
    await record((await callThrough({ capability: Capability.MACHINE_EXEC_COMMAND, tool: 'restart_process', machineId: 'm-2' })).res);
    seedGrant(undefined, false);
    await record(await fleetHandler(okHandler())(makeRequest(`Bearer ${token}`)));

    const everything = JSON.stringify([
      writeAuditEntrySpy.mock.calls,
      writeAuditEntryBlockingSpy.mock.calls,
      Object.values(logger).flatMap((fn) => (fn as jest.Mock).mock.calls),
      responses,
    ]);
    expect(writeAuditEntrySpy).toHaveBeenCalled();
    expect(writeAuditEntryBlockingSpy).toHaveBeenCalled();
    expect(everything).not.toContain(token.slice(4));
    expect(everything).not.toContain(hashOf(token));
  });
});
