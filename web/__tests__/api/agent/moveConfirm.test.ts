/** @jest-environment node */

/**
 * POST /api/agent/auth/move/confirm: the agent, holding its new site's ID token,
 * says it arrived. only then is the source cleaned, the way remove machine
 * cleans it, so #326 removal detection never sees its old doc vanish early.
 * a missing move is the agent's "already done".
 */

import { createMockRequest } from '../helpers/utils';

const mockAgentClaims = jest.fn();
jest.mock('@/lib/agentAuth.server', () => ({
  agentClaims: (...a: unknown[]) => mockAgentClaims(...a),
}));

const mockDb = { __db: true };
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockReadMoveById = jest.fn();
jest.mock('@/lib/machineMoves.server', () => ({
  readMoveById: (...a: unknown[]) => mockReadMoveById(...a),
}));

const mockRemoveMachineData = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock('@/lib/actions/removeMachine.server', () => ({
  removeMachineData: (...a: unknown[]) => mockRemoveMachineData(...a),
}));

const mockRecordPairing = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/lib/pairingPlan.server', () => ({
  recordPairing: (...a: unknown[]) => mockRecordPairing(...a),
}));

const mockResolveSiteAccess = jest.fn();
jest.mock('@/lib/sitePolicy.server', () => ({
  ...jest.requireActual('@/lib/sitePolicy.server'),
  resolveSiteAccess: (...a: unknown[]) => mockResolveSiteAccess(...a),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

import { POST } from '@/app/api/agent/auth/move/confirm/route';

const MOVE_ID = 'site-src:TEC-A4D';
const SWITCHING = {
  moveId: MOVE_ID,
  sourceSiteId: 'site-src',
  targetSiteId: 'site-dst',
  machineId: 'TEC-A4D',
  status: 'switching',
  requestedBy: 'admin-uid',
  requestedAt: 1,
  expiresAt: 2,
};

function confirm(body: Record<string, unknown> = { machineId: 'TEC-A4D', moveId: MOVE_ID }) {
  return POST(
    createMockRequest('http://localhost/api/agent/auth/move/confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer target-id-token' },
      body,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAgentClaims.mockResolvedValue({ siteId: 'site-dst', machineId: 'TEC-A4D', userId: 'agent_site-dst_TEC-A4D' });
  mockReadMoveById.mockResolvedValue(SWITCHING);
  mockResolveSiteAccess.mockResolvedValue({
    ok: true,
    facts: { globalRole: 'admin', membershipRole: 'admin', swoopMode: null, machineIds: null },
  });
});

function expectNothingChanged() {
  expect(mockRemoveMachineData).not.toHaveBeenCalled();
  expect(mockRecordPairing).not.toHaveBeenCalled();
  expect(mockEmitMutation).not.toHaveBeenCalled();
}

describe('POST /api/agent/auth/move/confirm — refusals', () => {
  it('401s a bearer that is not an agent ID token', async () => {
    mockAgentClaims.mockResolvedValueOnce(null);

    const res = await confirm();

    expect(res.status).toBe(401);
    expect(mockReadMoveById).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it('400s a body without a machine id and a move id', async () => {
    const res = await confirm({ machineId: 'TEC-A4D' });

    expect(res.status).toBe(400);
    expect(mockReadMoveById).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it('403s a body naming another machine than the token', async () => {
    const res = await confirm({ machineId: 'OTHER', moveId: MOVE_ID });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('machine_mismatch');
    expectNothingChanged();
  });

  it('404s when there is no move, which the agent reads as done', async () => {
    mockReadMoveById.mockResolvedValueOnce(null);

    const res = await confirm();

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('move_not_found');
    expect(mockReadMoveById).toHaveBeenCalledWith(mockDb, MOVE_ID);
    expectNothingChanged();
  });

  it('403s a move of another machine', async () => {
    mockReadMoveById.mockResolvedValueOnce({ ...SWITCHING, machineId: 'OTHER' });

    const res = await confirm();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('machine_mismatch');
    expectNothingChanged();
  });

  // the source's own token still verifies: it must never confirm its own departure
  it('403s a token of another site than the move target', async () => {
    mockAgentClaims.mockResolvedValueOnce({ siteId: 'site-src', machineId: 'TEC-A4D', userId: 'agent_site-src_TEC-A4D' });

    const res = await confirm();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('wrong_site');
    expectNothingChanged();
  });

  it('409s a move that is still pending: the agent has no target credentials yet', async () => {
    mockReadMoveById.mockResolvedValueOnce({ ...SWITCHING, status: 'pending' });

    const res = await confirm();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('move_not_switching');
    expectNothingChanged();
  });

  it('500s and changes nothing when the requester cannot be read, so the agent retries', async () => {
    mockResolveSiteAccess.mockRejectedValueOnce(new Error('backend unavailable'));

    const res = await confirm();

    expect(res.status).toBe(500);
    expectNothingChanged();
  });
});

describe('POST /api/agent/auth/move/confirm — success', () => {
  it('cleans the source as remove does, records the pairing on the target, and audits both sites and the platform', async () => {
    const res = await confirm();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      moveId: MOVE_ID,
      sourceSiteId: 'site-src',
      targetSiteId: 'site-dst',
      machineId: 'TEC-A4D',
    });

    expect(mockResolveSiteAccess).toHaveBeenCalledWith('admin-uid', 'site-src', mockDb);
    expect(mockRemoveMachineData).toHaveBeenCalledTimes(1);
    expect(mockRemoveMachineData).toHaveBeenCalledWith({
      siteId: 'site-src',
      machineId: 'TEC-A4D',
      db: mockDb,
      actor: {
        type: 'user',
        userId: 'admin-uid',
        role: 'admin',
        siteRoles: { 'site-src': 'admin' },
        swoopModes: {},
        machineScopes: { 'site-src': null },
      },
    });
    expect(mockRecordPairing).toHaveBeenCalledWith('site-dst', 'TEC-A4D');

    const attributes = {
      endpoint: 'agent/auth/move/confirm',
      method: 'POST',
      machineId: 'TEC-A4D',
      moveId: MOVE_ID,
      sourceSiteId: 'site-src',
      targetSiteId: 'site-dst',
    };
    expect(mockEmitMutation.mock.calls.map(([event]) => event)).toEqual([
      {
        kind: 'site_mutated',
        siteId: 'site-src',
        actor: 'user:admin-uid',
        targetId: 'TEC-A4D',
        attributes: { verb: 'machine.move_out', ...attributes },
      },
      {
        kind: 'site_mutated',
        siteId: 'site-dst',
        actor: 'user:admin-uid',
        targetId: 'TEC-A4D',
        attributes: { verb: 'machine.move_in', ...attributes },
      },
      {
        kind: 'site_mutated',
        siteId: '',
        actor: 'user:admin-uid',
        targetId: 'TEC-A4D',
        attributes: { verb: 'machine.move', ...attributes },
      },
    ]);
  });

  it('cleans the source before it records the target', async () => {
    const order: string[] = [];
    mockRemoveMachineData.mockImplementationOnce(async () => {
      order.push('source-cleaned');
      return {};
    });
    mockRecordPairing.mockImplementationOnce(async () => {
      order.push('pairing-recorded');
    });

    await confirm();

    expect(order).toEqual(['source-cleaned', 'pairing-recorded']);
  });

  // the actor only labels the swoop sessions the cleanup ends; a requester who
  // has since left the source, or been deleted, still names who moved it
  it('still confirms when the requester no longer has access to the source', async () => {
    mockResolveSiteAccess.mockResolvedValueOnce({
      ok: false,
      reason: 'user_inactive',
      facts: { globalRole: 'member', membershipRole: null, swoopMode: null, machineIds: null },
    });

    const res = await confirm();

    expect(res.status).toBe(200);
    expect(mockRemoveMachineData).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: 'user', userId: 'admin-uid', role: 'member', siteRoles: {}, swoopModes: {}, machineScopes: {} },
      }),
    );
  });

  it('500s without recording the target or auditing when the source cleanup fails, so the agent retries', async () => {
    mockRemoveMachineData.mockRejectedValueOnce(new Error('batch_blew_up'));

    const res = await confirm();

    expect(res.status).toBe(500);
    expect(mockRecordPairing).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
