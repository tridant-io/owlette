/** @jest-environment node */

/**
 * POST /api/agent/auth/move: a moving machine trades the refresh token it holds
 * for the source site for the target's credentials. the token must be the move's
 * source and machine, a lapsed pending move answers 410, the target is checked
 * again at mint time, and a retry replaces the target token the last call minted.
 * a target that refuses for good drops a pending move with its command and says
 * why. the source token is left alone. google's sign-in is stubbed with global.fetch,
 * as the refresh tests stub it.
 */

import crypto from 'crypto';
import { createMockRequest } from '../helpers/utils';

type Data = Record<string, unknown>;

const mockDocs = new Map<string, Data>();
const mockCreateUser = jest.fn();
const mockSetCustomUserClaims = jest.fn();
const mockCreateCustomToken = jest.fn();
const mockMachineSlotAvailable = jest.fn();
const mockEmitMutation = jest.fn();
const mockPruneMembers = jest.fn();
const mockPruneFleet = jest.fn();

function snapshot(path: string) {
  const data = mockDocs.get(path);
  return { id: path.slice(path.lastIndexOf('/') + 1), exists: data !== undefined, data: () => data };
}

function docRef(path: string) {
  return {
    id: path.slice(path.lastIndexOf('/') + 1),
    path,
    collection: (name: string) => collectionRef(`${path}/${name}`),
    get: async () => snapshot(path),
  };
}

function collectionRef(path: string) {
  return { doc: (id: string) => docRef(`${path}/${id}`) };
}

const mockDb = {
  collection: (name: string) => collectionRef(name),
  // writes land at commit, after every read, as firestore's do
  runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const writes: Array<() => void> = [];
    const result = await fn({
      get: async (ref: { path: string }) => {
        if (writes.length > 0) throw new Error('firestore transactions read before they write');
        return snapshot(ref.path);
      },
      set: (ref: { path: string }, data: Data) => writes.push(() => mockDocs.set(ref.path, { ...data })),
      update: (ref: { path: string }, patch: Data) =>
        writes.push(() => {
          const current = mockDocs.get(ref.path);
          if (!current) throw new Error(`NOT_FOUND: ${ref.path}`);
          const next = { ...current, ...patch };
          for (const [field, value] of Object.entries(patch)) if (value === 'DELETE_FIELD') delete next[field];
          mockDocs.set(ref.path, next);
        }),
      delete: (ref: { path: string }) => writes.push(() => mockDocs.delete(ref.path)),
    });
    for (const write of writes) write();
    return result;
  },
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TIMESTAMP', delete: () => 'DELETE_FIELD' },
}));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
  getAdminAuth: () => ({
    createUser: (...a: unknown[]) => mockCreateUser(...a),
    setCustomUserClaims: (...a: unknown[]) => mockSetCustomUserClaims(...a),
    createCustomToken: (...a: unknown[]) => mockCreateCustomToken(...a),
  }),
}));
jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: <H,>(handler: H): H => handler,
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));
jest.mock('@/lib/plan.server', () => ({
  machineSlotAvailable: (...a: unknown[]) => mockMachineSlotAvailable(...a),
}));
jest.mock('@/lib/membership.server', () => ({
  pruneMachineFromMembers: (...a: unknown[]) => mockPruneMembers(...a),
}));
jest.mock('@/lib/fleet/cleanup.server', () => ({
  pruneMachineFromFleet: (...a: unknown[]) => mockPruneFleet(...a),
}));
jest.mock('@/lib/fleet/policy.server', () => ({ FLEET_SETTINGS_DOC: 'fleet', parseFleetSettings: jest.fn() }));
jest.mock('@/lib/fleet/session.server', () => ({ deleteRefsInBatches: jest.fn() }));

global.fetch = jest.fn(async () => ({
  ok: true,
  json: async () => ({ idToken: 'target-id-token' }),
})) as unknown as typeof fetch;

import { POST } from '@/app/api/agent/auth/move/route';
import logger from '@/lib/logger';
import { MOVE_EXISTS } from '@/lib/machineMove';
import { MACHINE_LIMIT_ERROR } from '@/lib/planResponse';

const SOURCE = 'site-a';
const TARGET = 'site-b';
const MACHINE = 'kiosk-1';
const REQUESTER = 'user-1';
const MOVE_ID = `${SOURCE}:${MACHINE}`;
const MOVE_PATH = `machine_moves/${MOVE_ID}`;
const PENDING_PATH = `sites/${SOURCE}/machines/${MACHINE}/commands/pending`;
const RESTART = { type: 'restart_process', status: 'pending' };
const SOURCE_TOKEN = 'source-refresh-token';
const TARGET_UID = 'agent_site_b_kiosk_1';
const DAY_MS = 24 * 60 * 60 * 1000;

const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const tokenPath = (token: string) => `agent_refresh_tokens/${hashOf(token)}`;
const tokenPaths = () => [...mockDocs.keys()].filter((path) => path.startsWith('agent_refresh_tokens/'));

function seedToken(token: string, fields: Data = {}): Data {
  const data = {
    siteId: SOURCE,
    machineId: MACHINE,
    version: '4.2.3',
    createdBy: 'user-0',
    agentUid: `agent_${SOURCE}_${MACHINE}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    ...fields,
  };
  mockDocs.set(tokenPath(token), data);
  return data;
}

function seedMove(fields: Data = {}): void {
  mockDocs.set(MOVE_PATH, {
    moveId: MOVE_ID,
    sourceSiteId: SOURCE,
    targetSiteId: TARGET,
    machineId: MACHINE,
    status: 'pending',
    requestedBy: REQUESTER,
    requestedAt: Date.now() - DAY_MS,
    expiresAt: Date.now() + DAY_MS,
    ...fields,
  });
}

function moveReq(body: Data = { refreshToken: SOURCE_TOKEN, machineId: MACHINE, moveId: MOVE_ID }) {
  return createMockRequest('http://localhost/api/agent/auth/move', { method: 'POST', body });
}

async function call(body?: Data) {
  const res = await POST(moveReq(body));
  return { status: res.status, body: (await res.json()) as Data };
}

/** a refusal: no scope pruned, nothing minted, no token stored, the move as it was. */
function expectNothingMinted(moveBefore: Data | undefined) {
  expect(mockPruneMembers).not.toHaveBeenCalled();
  expect(mockPruneFleet).not.toHaveBeenCalled();
  expect(mockCreateCustomToken).not.toHaveBeenCalled();
  expect(tokenPaths()).toEqual([tokenPath(SOURCE_TOKEN)]);
  expect(mockDocs.get(MOVE_PATH)).toEqual(moveBefore);
  expect(mockEmitMutation).not.toHaveBeenCalled();
}

/** the move's `site_move` command beside another command, in the source machine's pending map. */
function seedPendingCommands(): void {
  mockDocs.set(PENDING_PATH, {
    cmd_site_move_kiosk_1_1: { type: 'site_move', moveId: MOVE_ID, status: 'pending' },
    cmd_restart: RESTART,
  });
}

/** a refusal for good: no token stored, the move and its command gone, and why on the source and the platform. */
function expectMoveRefused(reason: 'machine_exists' | 'plan_required') {
  expect(tokenPaths()).toEqual([tokenPath(SOURCE_TOKEN)]);
  expect(mockDocs.has(MOVE_PATH)).toBe(false);
  expect(mockDocs.get(PENDING_PATH)).toEqual({ cmd_restart: RESTART });
  expect(mockEmitMutation).toHaveBeenCalledTimes(2);
  for (const siteId of [SOURCE, '']) {
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId,
      actor: `user:${REQUESTER}`,
      targetId: MACHINE,
      attributes: {
        verb: 'machine.move_refused',
        endpoint: '/api/agent/auth/move',
        method: 'POST',
        moveId: MOVE_ID,
        sourceSiteId: SOURCE,
        targetSiteId: TARGET,
        machineId: MACHINE,
        reason,
      },
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDocs.clear();
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = 'test-firebase-key';
  mockCreateUser.mockResolvedValue(undefined);
  mockSetCustomUserClaims.mockResolvedValue(undefined);
  mockCreateCustomToken.mockResolvedValue('custom-token');
  mockMachineSlotAvailable.mockResolvedValue(true);
  mockPruneMembers.mockResolvedValue(0);
  mockPruneFleet.mockResolvedValue(undefined);
  mockDocs.set(`sites/${TARGET}`, { name: 'gallery' });
  seedToken(SOURCE_TOKEN);
  seedMove();
});

describe('POST /api/agent/auth/move', () => {
  it('mints the target credentials and turns the move switching', async () => {
    const sourceToken = { ...mockDocs.get(tokenPath(SOURCE_TOKEN)) };

    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body).toEqual({
      accessToken: 'target-id-token',
      refreshToken: expect.any(String),
      expiresIn: 3600,
      siteId: TARGET,
    });
    const refreshToken = body.refreshToken as string;
    expect(mockDocs.get(tokenPath(refreshToken))).toEqual({
      siteId: TARGET,
      machineId: MACHINE,
      version: '4.2.3',
      createdBy: REQUESTER,
      createdAt: 'SERVER_TIMESTAMP',
      lastUsed: 'SERVER_TIMESTAMP',
      agentUid: TARGET_UID,
    });
    expect(mockDocs.get(MOVE_PATH)).toEqual(
      expect.objectContaining({ status: 'switching', mintedTokenHash: hashOf(refreshToken) }),
    );
    expect(mockDocs.get(tokenPath(SOURCE_TOKEN))).toEqual(sourceToken);

    const claims = { role: 'agent', site_id: TARGET, machine_id: MACHINE, version: '4.2.3' };
    expect(mockCreateUser).toHaveBeenCalledWith({ uid: TARGET_UID });
    expect(mockSetCustomUserClaims).toHaveBeenCalledWith(TARGET_UID, claims);
    expect(mockCreateCustomToken).toHaveBeenCalledWith(TARGET_UID, claims);
    expect(mockMachineSlotAvailable).toHaveBeenCalledWith(TARGET, MACHINE, { name: 'gallery' });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: TARGET,
      actor: `user:${REQUESTER}`,
      targetId: MACHINE,
      attributes: expect.objectContaining({
        verb: 'machine.move_mint',
        siteId: TARGET,
        sourceSiteId: SOURCE,
        machineId: MACHINE,
        moveId: MOVE_ID,
      }),
    });

    const logged = JSON.stringify(Object.values(jest.mocked(logger)).map((fn) => (fn as jest.Mock).mock.calls));
    for (const secret of [SOURCE_TOKEN, refreshToken, 'target-id-token']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('mints again on a retry and deletes the target token it minted before', async () => {
    const first = await call();
    expect(first.status).toBe(200);
    // a switching move never lapses, so a retry long after still mints
    mockDocs.set(MOVE_PATH, { ...mockDocs.get(MOVE_PATH), expiresAt: Date.now() - DAY_MS });

    const second = await call();

    expect(second.status).toBe(200);
    const firstToken = first.body.refreshToken as string;
    const secondToken = second.body.refreshToken as string;
    expect(secondToken).not.toBe(firstToken);
    expect(mockDocs.has(tokenPath(firstToken))).toBe(false);
    expect(tokenPaths().sort()).toEqual([tokenPath(SOURCE_TOKEN), tokenPath(secondToken)].sort());
    expect(mockDocs.get(MOVE_PATH)).toEqual(
      expect.objectContaining({ status: 'switching', mintedTokenHash: hashOf(secondToken) }),
    );
    expect(mockEmitMutation).toHaveBeenCalledTimes(2);
  });

  it('clears the target\'s scopes and fleet grant naming the id before it mints', async () => {
    const { status } = await call();

    expect(status).toBe(200);
    expect(mockPruneMembers).toHaveBeenCalledWith({ siteId: TARGET, machineId: MACHINE });
    expect(mockPruneFleet).toHaveBeenCalledWith({ siteId: TARGET, machineId: MACHINE });
    const minted = mockCreateCustomToken.mock.invocationCallOrder[0];
    expect(mockPruneMembers.mock.invocationCallOrder[0]).toBeLessThan(minted);
    expect(mockPruneFleet.mock.invocationCallOrder[0]).toBeLessThan(minted);
  });

  it('mints nothing when clearing the target\'s scopes fails', async () => {
    mockPruneFleet.mockRejectedValue(new Error('grant not written'));
    const before = mockDocs.get(MOVE_PATH);

    const { status } = await call();

    expect(status).toBe(500);
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(tokenPaths()).toEqual([tokenPath(SOURCE_TOKEN)]);
    expect(mockDocs.get(MOVE_PATH)).toEqual(before);
  });

  it('answers 404 to a token of another site and mints nothing', async () => {
    seedToken(SOURCE_TOKEN, { siteId: 'site-c', agentUid: 'agent_site_c_kiosk_1' });
    const before = mockDocs.get(MOVE_PATH);

    const { status } = await call();

    expect(status).toBe(404);
    expectNothingMinted(before);
  });

  it('answers 403 to a machine id that is not the token\'s, as refresh does', async () => {
    const before = mockDocs.get(MOVE_PATH);

    const { status } = await call({ refreshToken: SOURCE_TOKEN, machineId: 'kiosk-2', moveId: MOVE_ID });

    expect(status).toBe(403);
    expectNothingMinted(before);
  });

  it('answers 404 to another machine\'s move and mints nothing', async () => {
    seedToken(SOURCE_TOKEN, { machineId: 'kiosk-2', agentUid: 'agent_site_a_kiosk_2' });
    const before = mockDocs.get(MOVE_PATH);

    const { status } = await call({ refreshToken: SOURCE_TOKEN, machineId: 'kiosk-2', moveId: MOVE_ID });

    expect(status).toBe(404);
    expectNothingMinted(before);
  });

  it('answers 404 with no move', async () => {
    mockDocs.delete(MOVE_PATH);

    expect((await call()).status).toBe(404);
    expect((await call({ refreshToken: SOURCE_TOKEN, machineId: MACHINE, moveId: `${SOURCE}/x` })).status).toBe(404);
    expectNothingMinted(undefined);
  });

  it('answers 404 when the target site is gone', async () => {
    mockDocs.delete(`sites/${TARGET}`);
    const before = mockDocs.get(MOVE_PATH);

    expect((await call()).status).toBe(404);
    expectNothingMinted(before);
  });

  it('answers 410 to a pending move past its expiry and leaves it', async () => {
    seedMove({ expiresAt: Date.now() - 1 });
    const before = mockDocs.get(MOVE_PATH);

    const { status } = await call();

    expect(status).toBe(410);
    expectNothingMinted(before);
  });

  it('answers 402 when the target\'s plan has no room, and drops the move', async () => {
    mockMachineSlotAvailable.mockResolvedValue(false);
    seedPendingCommands();

    const { status, body } = await call();

    expect(status).toBe(402);
    expect(body.error).toBe(MACHINE_LIMIT_ERROR);
    expect(mockPruneMembers).not.toHaveBeenCalled();
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expectMoveRefused('plan_required');
  });

  it('answers 409 when the target already has a machine with this id, and drops the move', async () => {
    mockDocs.set(`sites/${TARGET}/machines/${MACHINE}`, { online: true });
    seedPendingCommands();

    const { status, body } = await call();

    expect(status).toBe(409);
    expect(body.error).toBe(MOVE_EXISTS('gallery', MACHINE));
    expect(mockPruneMembers).not.toHaveBeenCalled();
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expectMoveRefused('machine_exists');
  });

  it('keeps a switching move the target refuses on a retry: its confirm still needs it', async () => {
    seedMove({ status: 'switching', mintedTokenHash: 'minted-before' });
    mockDocs.set(`sites/${TARGET}/machines/${MACHINE}`, { online: true });
    seedPendingCommands();
    const before = mockDocs.get(MOVE_PATH);

    const { status } = await call();

    expect(status).toBe(409);
    expectNothingMinted(before);
    expect(mockDocs.get(PENDING_PATH)).toHaveProperty('cmd_site_move_kiosk_1_1');
  });

  it('keeps a move asked for since to another site while the refusal ran', async () => {
    mockMachineSlotAvailable.mockImplementation(async () => {
      seedMove({ targetSiteId: 'site-c', requestedAt: Date.now() });
      return false;
    });

    const { status } = await call();

    expect(status).toBe(402);
    expect(mockDocs.get(MOVE_PATH)).toEqual(expect.objectContaining({ targetSiteId: 'site-c', status: 'pending' }));
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('still answers the refusal when the move cannot be dropped', async () => {
    mockMachineSlotAvailable.mockResolvedValue(false);
    const before = mockDocs.get(MOVE_PATH);
    const runTransaction = jest.spyOn(mockDb, 'runTransaction').mockRejectedValueOnce(new Error('aborted'));

    const { status, body } = await call();

    runTransaction.mockRestore();
    expect(status).toBe(402);
    expect(body.error).toBe(MACHINE_LIMIT_ERROR);
    expectNothingMinted(before);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('stores no token when the move is cancelled while it mints', async () => {
    mockCreateCustomToken.mockImplementation(async () => {
      mockDocs.delete(MOVE_PATH);
      return 'custom-token';
    });

    const { status } = await call();

    expect(status).toBe(404);
    expect(tokenPaths()).toEqual([tokenPath(SOURCE_TOKEN)]);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('stores no token and drops the move when the target gains a machine with this id while it mints', async () => {
    mockCreateCustomToken.mockImplementation(async () => {
      mockDocs.set(`sites/${TARGET}/machines/${MACHINE}`, { online: true });
      return 'custom-token';
    });
    seedPendingCommands();

    const { status, body } = await call();

    expect(status).toBe(409);
    expect(body.error).toBe(MOVE_EXISTS('gallery', MACHINE));
    expectMoveRefused('machine_exists');
  });

  it('answers 401 to an unknown, expired or retired refresh token', async () => {
    const before = mockDocs.get(MOVE_PATH);
    expect((await call({ refreshToken: 'unknown', machineId: MACHINE, moveId: MOVE_ID })).status).toBe(401);

    seedToken(SOURCE_TOKEN, { expiresAt: Date.now() - 1 });
    expect((await call()).status).toBe(401);

    seedToken(SOURCE_TOKEN, { supersededAt: Date.now() - DAY_MS, retiresAt: Date.now() - 1 });
    expect((await call()).status).toBe(401);

    expectNothingMinted(before);
  });

  it('answers 400 to a body missing a field', async () => {
    expect((await call({ refreshToken: SOURCE_TOKEN, machineId: MACHINE })).status).toBe(400);
    expect((await call({ machineId: MACHINE, moveId: MOVE_ID })).status).toBe(400);
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
  });
});
