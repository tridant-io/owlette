/** @jest-environment node */

/**
 * POST and DELETE /api/sites/{siteId}/machines/{machineId}/move: asking for a
 * machine to move to another site, and cancelling that while it is pending.
 * the real `authorizedSiteHandler` and move store run over an in-memory
 * firestore, so the refusals, the stored move and its `site_move` command are
 * the route's own. the plan check is mocked: plans are off under jest.
 */

import { createMockRequest, parseResponse } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: jest.fn(),
  writeAuditEntryBlocking: jest.fn(async () => undefined),
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({ capability_enforcement: true, rate_limit_enforcement: true })),
  },
}));

jest.mock('@/lib/logger', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: logger, logger };
});

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
}));

const mockMachineLimitRefusal = jest.fn();
jest.mock('@/lib/pairingPlan.server', () => ({
  machineLimitRefusal: (...a: unknown[]) => mockMachineLimitRefusal(...a),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TS', delete: () => 'DELETE_FIELD' },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}));

type Data = Record<string, unknown>;
type Filter = [string, string, unknown];

let docs: Map<string, Data>;
let failBatches: boolean;
let beforeCommit: (() => void) | null;

function snapshot(path: string) {
  const data = docs.get(path);
  return { id: path.slice(path.lastIndexOf('/') + 1), exists: data !== undefined, ref: docRef(path), data: () => data };
}

function merged(current: Data | undefined, patch: Data): Data {
  const next = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === 'DELETE_FIELD') delete next[field];
    else next[field] = value;
  }
  return next;
}

function writeSet(path: string, data: Data, options?: { merge?: boolean }): void {
  docs.set(path, options?.merge ? merged(docs.get(path), data) : { ...data });
}

function writeUpdate(path: string, patch: Data): void {
  if (!docs.has(path)) throw new Error(`NOT_FOUND: ${path}`);
  docs.set(path, merged(docs.get(path), patch));
}

function docRef(path: string) {
  return {
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => snapshot(path),
    set: async (data: Data, options?: { merge?: boolean }) => writeSet(path, data, options),
    update: async (patch: Data) => writeUpdate(path, patch),
    delete: async () => {
      docs.delete(path);
    },
  };
}

function query(path: string, filters: Filter[]) {
  return {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==' && op !== 'in') throw new Error(`fake firestore answers == and in only, got ${op}`);
      return query(path, [...filters, [field, op, value]]);
    },
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .filter(([, data]) =>
          filters.every(([field, op, value]) =>
            op === 'in' ? (value as unknown[]).includes(data[field]) : data[field] === value,
          ),
        )
        .map(([p]) => snapshot(p)),
    }),
  };
}

function collectionRef(path: string) {
  const all = query(path, []);
  return { doc: (id: string) => docRef(`${path}/${id}`), where: all.where, get: all.get };
}

const mockDb = {
  collection: (name: string) => collectionRef(name),
  getAll: (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map((ref) => ref.get())),
  // all or nothing at commit, as firestore's batches are; create refuses a doc that exists
  batch: () => {
    const ops: Array<{ kind: 'create' | 'set' | 'update' | 'delete'; path: string; data?: Data; options?: { merge?: boolean } }> = [];
    return {
      create: (ref: { path: string }, data: Data) => ops.push({ kind: 'create', path: ref.path, data }),
      set: (ref: { path: string }, data: Data, options?: { merge?: boolean }) =>
        ops.push({ kind: 'set', path: ref.path, data, options }),
      update: (ref: { path: string }, data: Data) => ops.push({ kind: 'update', path: ref.path, data }),
      delete: (ref: { path: string }) => ops.push({ kind: 'delete', path: ref.path }),
      commit: async () => {
        beforeCommit?.();
        if (failBatches) throw new Error('batch refused');
        const exists = ops.find((op) => op.kind === 'create' && docs.has(op.path));
        if (exists) throw Object.assign(new Error(`ALREADY_EXISTS: ${exists.path}`), { code: 6 });
        for (const op of ops) {
          if (op.kind === 'delete') docs.delete(op.path);
          else if (op.kind === 'update') writeUpdate(op.path, op.data ?? {});
          else writeSet(op.path, op.data ?? {}, op.options);
        }
      },
    };
  },
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const writes: Array<() => void> = [];
    const result = await fn({
      get: async (ref: { path: string }) => snapshot(ref.path),
      delete: (ref: { path: string }) => writes.push(() => docs.delete(ref.path)),
      update: (ref: { path: string }, patch: Data) => writes.push(() => writeUpdate(ref.path, patch)),
    });
    for (const write of writes) write();
    return result;
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

import { DELETE, POST } from '@/app/api/sites/[siteId]/machines/[machineId]/move/route';
import { MOVE_BUSY, MOVE_EXISTS, MOVE_TOO_OLD } from '@/lib/machineMove';
import { MOVE_PENDING_TTL_MS } from '@/lib/machineMoves.server';
import { SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';

const SOURCE = 'site-alpha';
const TARGET = 'site-beta';
const OTHER = 'site-gamma';
const MACHINE = 'kiosk-1';
const NAME = 'Lobby Kiosk';
const MOVE_ID = `${SOURCE}:${MACHINE}`;
const SUPERADMIN = 'super-uid';
const DAY_MS = 24 * 60 * 60 * 1000;

const movePath = `machine_moves/${MOVE_ID}`;
const pendingPath = `sites/${SOURCE}/machines/${MACHINE}/commands/pending`;
const url = `http://localhost/api/sites/${SOURCE}/machines/${MACHINE}/move`;
const routeContext = () => ({ params: Promise.resolve({ siteId: SOURCE, machineId: MACHINE }) });

let keyCounter = 0;

function post(body: Data, key: string | null = `move-${++keyCounter}`) {
  return POST(
    createMockRequest(url, { method: 'POST', body, headers: key ? { 'Idempotency-Key': key } : {} }),
    routeContext(),
  );
}

function cancel(key: string | null = `cancel-${++keyCounter}`) {
  return DELETE(
    createMockRequest(url, { method: 'DELETE', headers: key ? { 'Idempotency-Key': key } : {} }),
    routeContext(),
  );
}

function seedSite(siteId: string, name: string): void {
  docs.set(`sites/${siteId}`, { name, owner: 'owner-uid' });
  docs.set(`sites/${siteId}/members/owner-uid`, { uid: 'owner-uid', role: 'owner', status: 'active' });
}

/** a user and, unless a superadmin, an active member row on each site at `role`. */
function signIn(uid: string, globalRole: 'superadmin' | 'member', siteRoles: Record<string, string> = {}): void {
  docs.set(`users/${uid}`, { email: `${uid}@example.com`, role: globalRole });
  for (const [siteId, role] of Object.entries(siteRoles)) {
    docs.set(`sites/${siteId}/members/${uid}`, { uid, role, status: 'active' });
  }
  mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });
}

function signInWithKey(uid: string): void {
  docs.set(`users/${uid}`, { email: `${uid}@example.com`, role: 'superadmin' });
  mockResolveAuth.mockResolvedValue({
    userId: uid,
    keyContext: {
      keyId: 'key-test',
      scopes: [{ resource: 'machine', id: MACHINE, permissions: ['write'] }],
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: false,
    },
  });
}

function seedMachine(data: Data = {}): void {
  docs.set(`sites/${SOURCE}/machines/${MACHINE}`, {
    name: NAME,
    online: true,
    agent_version: '4.2.3',
    capabilities: { siteMove: 1 },
    ...data,
  });
}

function seedMove(fields: Data = {}): Data {
  const move = {
    moveId: MOVE_ID,
    sourceSiteId: SOURCE,
    targetSiteId: TARGET,
    machineId: MACHINE,
    status: 'pending',
    requestedBy: 'someone-else',
    requestedAt: Date.now() - DAY_MS,
    expiresAt: Date.now() + DAY_MS,
    ...fields,
  };
  docs.set(movePath, move);
  return move;
}

const siteMoveEntries = () =>
  Object.entries(docs.get(pendingPath) ?? {}).filter(([, command]) => (command as Data).type === 'site_move');

/** a refusal leaves no move, no command and no audit row behind. */
function expectNothingWritten(): void {
  expect(docs.has(movePath)).toBe(false);
  expect(siteMoveEntries()).toEqual([]);
  expect(mockEmitMutation).not.toHaveBeenCalled();
}

async function expectRefused(response: Response, status: number, code: string, detail?: string): Promise<void> {
  const { status: actual, body } = await parseResponse(response);
  expect({ status: actual, code: body.code }).toEqual({ status, code });
  if (detail !== undefined) expect(body.detail).toBe(detail);
}

/** the three rows a request or cancel writes: source site, target site, and the platform. */
function expectMoveRows(verb: string, actor: string): void {
  expect(mockEmitMutation).toHaveBeenCalledTimes(3);
  expect(mockEmitMutation.mock.calls.map(([event]) => event.siteId)).toEqual([SOURCE, TARGET, '']);
  for (const [event] of mockEmitMutation.mock.calls) {
    expect(event).toMatchObject({
      kind: 'site_mutated',
      actor,
      targetId: MACHINE,
      attributes: { verb, machineId: MACHINE, moveId: MOVE_ID, sourceSiteId: SOURCE, targetSiteId: TARGET },
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  failBatches = false;
  beforeCommit = null;
  mockMachineLimitRefusal.mockResolvedValue(null);
  seedSite(SOURCE, 'Main Hall');
  seedSite(TARGET, 'Gallery');
  seedSite(OTHER, 'Annex');
  seedMachine();
});

describe('POST /api/sites/{siteId}/machines/{machineId}/move', () => {
  it('stores a pending move and queues site_move on the machine, in one write', async () => {
    signIn(SUPERADMIN, 'superadmin');
    docs.set(pendingPath, { cmd_restart_1: { type: 'restart_process', status: 'pending' } });
    const before = Date.now();

    const { status, body } = await parseResponse(await post({ targetSiteId: TARGET }));

    expect(status).toBe(202);
    const data = body.data as Data;
    expect(data).toEqual({ moveId: MOVE_ID, status: 'pending', targetSiteId: TARGET, expiresAt: expect.any(Number) });
    expect(data.expiresAt).toBeGreaterThanOrEqual(before + MOVE_PENDING_TTL_MS);
    expect(data.expiresAt).toBeLessThanOrEqual(Date.now() + MOVE_PENDING_TTL_MS);

    const move = docs.get(movePath) as Data;
    expect(move).toEqual({
      moveId: MOVE_ID,
      sourceSiteId: SOURCE,
      targetSiteId: TARGET,
      machineId: MACHINE,
      status: 'pending',
      requestedBy: SUPERADMIN,
      requestedAt: expect.any(Number),
      expiresAt: data.expiresAt,
    });
    expect(move.expiresAt).toBe((move.requestedAt as number) + MOVE_PENDING_TTL_MS);

    const entries = siteMoveEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0][1]).toMatchObject({
      type: 'site_move',
      moveId: MOVE_ID,
      status: 'pending',
      queuedBy: `user:${SUPERADMIN}`,
      timestamp: 'SERVER_TS',
      auditCorrelationId: 'corr-test',
    });
    // only the move id travels: the agent fetches the credentials itself
    expect(entries[0][1]).not.toHaveProperty('targetSiteId');
    expect(docs.get(pendingPath)).toHaveProperty('cmd_restart_1');

    expectMoveRows('machine.move_request', `user:${SUPERADMIN}`);
  });

  it('lets an admin of both sites move the machine', async () => {
    signIn('admin-both', 'member', { [SOURCE]: 'admin', [TARGET]: 'admin' });

    const res = await post({ targetSiteId: TARGET });

    expect(res.status).toBe(202);
    expect(docs.get(movePath)).toMatchObject({ requestedBy: 'admin-both', targetSiteId: TARGET });
  });

  it.each([
    ['is only a member there', { [SOURCE]: 'admin', [TARGET]: 'member' }],
    ['is not on it', { [SOURCE]: 'admin' }],
  ])('refuses an admin of the source who %s with 403', async (_, roles) => {
    signIn('admin-source', 'member', roles);

    await expectRefused(await post({ targetSiteId: TARGET }), 403, 'forbidden');
    expectNothingWritten();
  });

  it('refuses a member of the source at the wrapper', async () => {
    signIn('member-source', 'member', { [SOURCE]: 'member', [TARGET]: 'admin' });

    await expectRefused(await post({ targetSiteId: TARGET }), 403, 'forbidden');
    expectNothingWritten();
  });

  it('refuses an api key with 403 api_key_not_permitted, even one scoped to the machine', async () => {
    signInWithKey(SUPERADMIN);

    await expectRefused(await post({ targetSiteId: TARGET }), 403, 'api_key_not_permitted');
    expectNothingWritten();
  });

  it('requires an Idempotency-Key', async () => {
    signIn(SUPERADMIN, 'superadmin');

    await expectRefused(await post({ targetSiteId: TARGET }, null), 400, 'idempotency_key_required');
    expectNothingWritten();
  });

  it.each([[{}], [{ targetSiteId: 42 }], [{ targetSiteId: 'not/a/site' }]])(
    'refuses a missing or malformed targetSiteId (%j) with 400',
    async (body) => {
      signIn(SUPERADMIN, 'superadmin');

      await expectRefused(await post(body), 400, 'validation_failed');
      expectNothingWritten();
    },
  );

  it('refuses the site the machine is already on with 400 same_site', async () => {
    signIn(SUPERADMIN, 'superadmin');

    await expectRefused(await post({ targetSiteId: SOURCE }), 400, 'same_site');
    expectNothingWritten();
  });

  it('answers 404 for a machine that is not on the site', async () => {
    signIn(SUPERADMIN, 'superadmin');
    docs.delete(`sites/${SOURCE}/machines/${MACHINE}`);

    await expectRefused(await post({ targetSiteId: TARGET }), 404, 'machine_not_found');
    expectNothingWritten();
  });

  it('answers 404 for a target site that does not exist', async () => {
    signIn(SUPERADMIN, 'superadmin');

    await expectRefused(await post({ targetSiteId: 'site-missing' }), 404, 'not_found');
    expectNothingWritten();
  });

  it('refuses with 409 machine_exists when the target has a machine with this id', async () => {
    signIn(SUPERADMIN, 'superadmin');
    docs.set(`sites/${TARGET}/machines/${MACHINE}`, { name: 'someone else' });

    await expectRefused(await post({ targetSiteId: TARGET }), 409, 'machine_exists', MOVE_EXISTS('Gallery', MACHINE));
    expectNothingWritten();
  });

  it.each([
    ['pending', `${NAME} is already moving to another site. cancel that move first.`],
    ['switching', `${NAME} is switching to another site now.`],
  ])('refuses with 409 move_pending while a move to another site is %s', async (status, detail) => {
    signIn(SUPERADMIN, 'superadmin');
    const existing = seedMove({ targetSiteId: OTHER, status });

    await expectRefused(await post({ targetSiteId: TARGET }), 409, 'move_pending', detail);
    expect(docs.get(movePath)).toEqual(existing);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('answers 200 with the move already pending to the same site, and writes nothing', async () => {
    signIn(SUPERADMIN, 'superadmin');
    const existing = seedMove();
    // a busy machine does not turn a repeat into a refusal
    docs.set(pendingPath, { cmd_install: { type: 'install_software' } });

    const { status, body } = await parseResponse(await post({ targetSiteId: TARGET }));

    expect(status).toBe(200);
    expect(body.data).toEqual({
      moveId: MOVE_ID,
      status: 'pending',
      targetSiteId: TARGET,
      expiresAt: existing.expiresAt,
    });
    expect(docs.get(movePath)).toEqual(existing);
    expect(siteMoveEntries()).toEqual([]);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('starts a new move over a pending one that lapsed', async () => {
    signIn(SUPERADMIN, 'superadmin');
    seedMove({ targetSiteId: OTHER, expiresAt: Date.now() - 1 });

    const res = await post({ targetSiteId: TARGET });

    expect(res.status).toBe(202);
    expect(docs.get(movePath)).toMatchObject({ targetSiteId: TARGET, requestedBy: SUPERADMIN });
  });

  it('replays a retried request with the same key instead of queueing it twice', async () => {
    signIn(SUPERADMIN, 'superadmin');

    const first = await post({ targetSiteId: TARGET }, 'same-key');
    const second = await post({ targetSiteId: TARGET }, 'same-key');

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(siteMoveEntries()).toHaveLength(1);
    expect(mockEmitMutation).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['an install is queued', () => docs.set(pendingPath, { cmd_install: { type: 'install_software' } })],
    [
      'a deployment naming it is in flight',
      () =>
        docs.set(`sites/${SOURCE}/deployments/deploy-1`, {
          status: 'in_progress',
          targets: [{ machineId: MACHINE, status: 'installing' }],
        }),
    ],
  ])('refuses with 409 machine_busy while %s', async (_, seedBusy) => {
    signIn(SUPERADMIN, 'superadmin');
    seedBusy();

    await expectRefused(await post({ targetSiteId: TARGET }), 409, 'machine_busy', MOVE_BUSY(NAME));
    expectNothingWritten();
  });

  it('refuses with 409 agent_too_old for an agent below the minimum', async () => {
    signIn(SUPERADMIN, 'superadmin');
    seedMachine({ agent_version: '4.2.2' });

    await expectRefused(
      await post({ targetSiteId: TARGET }),
      409,
      'agent_too_old',
      MOVE_TOO_OLD(NAME, '4.2.2', SITE_MOVE_MIN_AGENT_VERSION),
    );
    expectNothingWritten();
  });

  it('refuses with 409 agent_too_old for an agent that does not report it can follow', async () => {
    signIn(SUPERADMIN, 'superadmin');
    seedMachine({ agent_version: '4.3.0', capabilities: { keepAwake: 1 } });

    await expectRefused(await post({ targetSiteId: TARGET }), 409, 'agent_too_old');
    expectNothingWritten();
  });

  it("refuses with 402 when the target's plan has no room for the machine", async () => {
    signIn(SUPERADMIN, 'superadmin');
    mockMachineLimitRefusal.mockResolvedValue('owlette free covers one machine.');

    const { status, body } = await parseResponse(await post({ targetSiteId: TARGET }));

    expect(status).toBe(402);
    expect(body).toMatchObject({
      code: 'plan_required',
      detail: 'owlette free covers one machine.',
      entitlement: 'owlette.machines',
    });
    expect(mockMachineLimitRefusal).toHaveBeenCalledWith(TARGET, MACHINE, expect.objectContaining({ name: 'Gallery' }));
    expectNothingWritten();
  });

  it('writes neither the move nor its command when the write fails', async () => {
    signIn(SUPERADMIN, 'superadmin');
    failBatches = true;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post({ targetSiteId: TARGET });

    expect(res.status).toBe(500);
    expectNothingWritten();
    consoleError.mockRestore();
  });

  it.each([
    [TARGET, 200, undefined],
    [OTHER, 409, 'move_pending'],
  ])('answers a request that loses a race to one for %s as a repeat would', async (racedTarget, status, code) => {
    signIn(SUPERADMIN, 'superadmin');
    beforeCommit = () => {
      beforeCommit = null;
      seedMove({ targetSiteId: racedTarget });
    };

    const { status: actual, body } = await parseResponse(await post({ targetSiteId: TARGET }));

    expect(actual).toBe(status);
    if (code) expect(body.code).toBe(code);
    expect(docs.get(movePath)).toMatchObject({ targetSiteId: racedTarget, requestedBy: 'someone-else' });
    expect(siteMoveEntries()).toEqual([]);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/sites/{siteId}/machines/{machineId}/move', () => {
  it('cancels a pending move and its site_move command', async () => {
    signIn(SUPERADMIN, 'superadmin');
    seedMove();
    docs.set(pendingPath, {
      cmd_site_move_1: { type: 'site_move', moveId: MOVE_ID, status: 'pending' },
      cmd_restart_1: { type: 'restart_process', status: 'pending' },
    });

    const { status, body } = await parseResponse(await cancel());

    expect(status).toBe(200);
    expect(body.data).toEqual({ moveId: MOVE_ID, status: 'cancelled', targetSiteId: TARGET });
    expect(docs.has(movePath)).toBe(false);
    expect(docs.get(pendingPath)).toEqual({ cmd_restart_1: { type: 'restart_process', status: 'pending' } });
    expectMoveRows('machine.move_cancel', `user:${SUPERADMIN}`);
  });

  it('refuses with 409 move_switching once the agent is switching, and keeps the move', async () => {
    signIn(SUPERADMIN, 'superadmin');
    const existing = seedMove({ status: 'switching' });

    await expectRefused(await cancel(), 409, 'move_switching');
    expect(docs.get(movePath)).toEqual(existing);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('answers 404 when the machine has no move', async () => {
    signIn(SUPERADMIN, 'superadmin');

    await expectRefused(await cancel(), 404, 'not_found');
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('refuses an api key with 403 api_key_not_permitted', async () => {
    signInWithKey(SUPERADMIN);
    const existing = seedMove();

    await expectRefused(await cancel(), 403, 'api_key_not_permitted');
    expect(docs.get(movePath)).toEqual(existing);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('requires an Idempotency-Key', async () => {
    signIn(SUPERADMIN, 'superadmin');
    seedMove();

    await expectRefused(await cancel(null), 400, 'idempotency_key_required');
    expect(docs.has(movePath)).toBe(true);
  });
});
