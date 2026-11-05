/** @jest-environment node */

import { NextRequest } from 'next/server';
import type { Capability } from '@/lib/capabilities';

type TokenDoc = Record<string, unknown> & { id: string };

type TestUserActor = {
  type: 'user';
  userId: string;
  role: 'member' | 'admin' | 'superadmin';
  siteRoles: Record<string, 'owner' | 'admin' | 'member'>;
};

const SUPERADMIN: TestUserActor = {
  type: 'user',
  userId: 'test-admin',
  role: 'superadmin',
  siteRoles: {},
};

let tokenDocs: TokenDoc[] = [];
const deletedIds: string[] = [];
// Every doc-level set, by path: the revoke route's `unpair` commands land in
// `sites/{siteId}/machines/{machineId}/commands/pending`.
const docWrites: Array<{ path: string; data: Record<string, unknown>; options?: unknown }> = [];
// Swapped per-test to exercise the capability each route declares.
let mockActor: TestUserActor = SUPERADMIN;

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

// Stands in for the real wrapper but keeps the authorization decision honest:
// the route's declared capability is evaluated against the real capability
// matrix, so a route that demands a capability site admins lack 403s here too.
jest.mock('@/lib/authorizedHandler.server', () => {
  const { NextResponse } = jest.requireActual<typeof import('next/server')>('next/server');
  const { hasCapability } = jest.requireActual<typeof import('@/lib/capabilities')>(
    '@/lib/capabilities',
  );
  return {
    authorizedSiteHandler:
      (options: { capability: Capability }) =>
      (handler: (...args: unknown[]) => unknown) =>
      async (request: NextRequest, routeContext: { params: Promise<{ siteId: string }> }) => {
        const params = await routeContext.params;
        if (!hasCapability(mockActor, options.capability, params.siteId)) {
          return NextResponse.json({ error: 'forbidden' }, { status: 403 });
        }
        return handler(
          request,
          {
            actor: mockActor,
            siteId: params.siteId,
            correlationId: 'corr-test',
            auth: { userId: mockActor.userId, keyContext: null },
            scopeCheck: { isLegacy: false },
          },
          routeContext,
        );
      },
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  adminDb: {
    value: {
      collection: (name: string) => tokenCollection([], name),
      batch: () => ({
        delete: (ref: { id: string }) => deletedIds.push(ref.id),
        commit: jest.fn(async () => undefined),
      }),
    },
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

// One fake for every collection: token docs answer every query (the route only
// queries `agent_refresh_tokens`), and `path` makes the nested command write
// addressable.
function tokenCollection(filters: Array<[string, unknown]> = [], path = 'agent_refresh_tokens') {
  return {
    where: (field: string, _op: string, value: unknown) =>
      tokenCollection([...filters, [field, value]], path),
    doc: (id: string) => ({
      get: async () => {
        const data = tokenDocs.find((doc) => doc.id === id);
        return { exists: !!data, data: () => data };
      },
      delete: async () => deletedIds.push(id),
      collection: (name: string) => tokenCollection([], `${path}/${id}/${name}`),
      set: async (data: Record<string, unknown>, options?: unknown) => {
        docWrites.push({ path: `${path}/${id}`, data, options });
      },
    }),
    get: async () => ({
      docs: tokenDocs
        .filter((doc) => filters.every(([field, value]) => doc[field] === value))
        .map((doc) => ({
          id: doc.id,
          ref: { id: doc.id },
          data: () => doc,
        })),
    }),
  };
}

const timestamp = (iso: string) => ({ toDate: () => new Date(iso) });
// Lifecycle timestamps (supersededAt/retiresAt/expiresAt) are read via
// tokenTimestampToMillis, which needs .toMillis() — Firestore Timestamps
// expose both; the display path uses .toDate(). Model that faithfully.
const lifecycleTs = (ms: number) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

import { GET } from '@/app/api/sites/[siteId]/agent-tokens/route';
import { POST } from '@/app/api/sites/[siteId]/agent-tokens/revoke/route';

beforeEach(() => {
  tokenDocs = [];
  deletedIds.length = 0;
  docWrites.length = 0;
  mockActor = SUPERADMIN;
  mockEmitMutation.mockClear();
});

/** The `unpair` commands a revoke queued, as [machineId, command] pairs. */
function unpairCommands(): Array<[string, Record<string, unknown>]> {
  return docWrites.flatMap(({ path, data }) => {
    const match = /^sites\/[^/]+\/machines\/([^/]+)\/commands\/pending$/.exec(path);
    if (!match) return [];
    return Object.values(data)
      .filter((cmd): cmd is Record<string, unknown> => typeof cmd === 'object' && cmd !== null)
      .filter((cmd) => cmd.type === 'unpair')
      .map((cmd): [string, Record<string, unknown>] => [match[1], cmd]);
  });
}

describe('/api/sites/{siteId}/agent-tokens', () => {
  it('lists site tokens sorted newest first', async () => {
    tokenDocs = [
      { id: 'old', siteId: 'site-a', machineId: 'm1', createdAt: timestamp('2026-01-01T00:00:00Z') },
      { id: 'new', siteId: 'site-a', machineId: 'm2', createdAt: timestamp('2026-02-01T00:00:00Z') },
      { id: 'other', siteId: 'site-b', machineId: 'm3', createdAt: timestamp('2026-03-01T00:00:00Z') },
    ];

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(2);
    expect(json.tokens.map((t: { id: string }) => t.id)).toEqual(['new', 'old']);
  });

  it('hides superseded and expired tokens; reports prunableCount', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'live', siteId: 'site-a', machineId: 'm1', createdAt: timestamp('2026-02-01T00:00:00Z') },
      // superseded past grace → dead → hidden + counted prunable
      { id: 'retired', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000), createdAt: timestamp('2026-01-01T00:00:00Z') },
      // superseded but in grace → hidden, NOT prunable
      { id: 'grace', siteId: 'site-a', machineId: 'm2', supersededAt: now, retiresAt: lifecycleTs(now + 60_000), createdAt: timestamp('2026-01-15T00:00:00Z') },
      // expired → dead → hidden + counted prunable
      { id: 'expired', siteId: 'site-a', machineId: 'm3', expiresAt: lifecycleTs(now - 1000), createdAt: timestamp('2026-01-10T00:00:00Z') },
    ];

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokens.map((t: { id: string }) => t.id)).toEqual(['live']);
    expect(json.count).toBe(1);
    expect(json.prunableCount).toBe(2);
  });

  // The list route used to demand GLOBAL_SETTINGS_WRITE while revoke already ran
  // on site-scoped AGENT_TOKEN_REVOKE, so a site admin could revoke a token they
  // could not list. These three cases fail if that split ever comes back.
  it('lets a site admin list tokens for a site they are assigned to', async () => {
    mockActor = { type: 'user', userId: 'u1', role: 'admin', siteRoles: { ['site-a']: 'admin' } };
    tokenDocs = [
      { id: 'live', siteId: 'site-a', machineId: 'm1', createdAt: timestamp('2026-02-01T00:00:00Z') },
    ];

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).tokens.map((t: { id: string }) => t.id)).toEqual(['live']);
  });

  it('denies a site admin listing tokens for a site they are NOT assigned to', async () => {
    mockActor = { type: 'user', userId: 'u1', role: 'admin', siteRoles: { ['site-a']: 'admin' } };

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-b/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-b' }) },
    );

    expect(res.status).toBe(403);
  });

  it('denies a member listing tokens on their own site', async () => {
    mockActor = { type: 'user', userId: 'u2', role: 'member', siteRoles: { ['site-a']: 'member' } };

    const res = await GET(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens'),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(403);
  });
});

describe('/api/sites/{siteId}/agent-tokens/revoke', () => {
  it('revokes all tokens for a machine within the path site', async () => {
    tokenDocs = [
      { id: 'delete-me', siteId: 'site-a', machineId: 'm1' },
      { id: 'keep-other-site', siteId: 'site-b', machineId: 'm1' },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(1);
    expect(deletedIds).toEqual(['delete-me']);
  });

  // #327: deleting the token doc alone left the agent syncing on its one-hour
  // access token, online with live metrics. Every revoke that removed a live
  // credential now also queues `unpair` on that machine, merged into the
  // pending map the agent already polls.
  it('queues an unpair command on the machine whose tokens it revoked', async () => {
    tokenDocs = [{ id: 'delete-me', siteId: 'site-a', machineId: 'm1' }];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const [write] = docWrites;
    expect(write.path).toBe('sites/site-a/machines/m1/commands/pending');
    expect(write.options).toEqual({ merge: true });
    expect(unpairCommands()).toEqual([
      ['m1', expect.objectContaining({
        type: 'unpair',
        siteId: 'site-a',
        status: 'pending',
        queuedBy: 'user:test-admin',
        auditCorrelationId: 'corr-test',
      })],
    ]);
    // the agent's stale-command sweep reads `timestamp`, not `createdAt`
    expect(unpairCommands()[0][1]).toHaveProperty('timestamp');
  });

  it('latestOnly queues unpair for the machine whose current token went', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'fresh', siteId: 'site-a', machineId: 'm1', lastUsed: lifecycleTs(now) },
      { id: 'other-machine', siteId: 'site-a', machineId: 'm2', lastUsed: lifecycleTs(now) },
    ];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(unpairCommands().map(([machineId]) => machineId)).toEqual(['m1']);
  });

  it('queues nothing when no live token was revoked', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'dead', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
    ];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(docWrites).toEqual([]);
  });

  it('machineId mode queues nothing when every deleted token was already dead', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'retired', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'expired', siteId: 'site-a', machineId: 'm1', expiresAt: lifecycleTs(now - 1000) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect((await res.json()).revokedCount).toBe(2);
    expect(docWrites).toEqual([]);
  });

  it('tokenId queues unpair on the machine the token belonged to', async () => {
    tokenDocs = [{ id: 'delete-me', siteId: 'site-a', machineId: 'm7' }];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: 'delete-me' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(unpairCommands().map(([machineId]) => machineId)).toEqual(['m7']);
  });

  it('revoke all queues one unpair per distinct machine on the site', async () => {
    tokenDocs = [
      { id: 't1', siteId: 'site-a', machineId: 'm1' },
      { id: 't2', siteId: 'site-a', machineId: 'm1' },
      { id: 't3', siteId: 'site-a', machineId: 'm2' },
      { id: 'elsewhere', siteId: 'site-b', machineId: 'm3' },
    ];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(unpairCommands().map(([machineId]) => machineId).sort()).toEqual(['m1', 'm2']);
  });

  it('prune queues nothing: dead tokens have no agent behind them', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'expired', siteId: 'site-a', machineId: 'm1', expiresAt: lifecycleTs(now - 1000) },
    ];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(docWrites).toEqual([]);
  });

  it('machineId + latestOnly revokes ONLY the most-recently-used live token (preserves siblings)', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'stale', siteId: 'site-a', machineId: 'm1', lastUsed: lifecycleTs(now - 3_600_000), createdAt: lifecycleTs(now - 7_200_000) },
      { id: 'fresh', siteId: 'site-a', machineId: 'm1', lastUsed: lifecycleTs(now - 60_000), createdAt: lifecycleTs(now - 120_000) },
      { id: 'dead', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'other-machine', siteId: 'site-a', machineId: 'm2', lastUsed: lifecycleTs(now) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(1);
    expect(deletedIds).toEqual(['fresh']); // only the freshest live token; siblings kept
  });

  it('machineId + latestOnly with only dead tokens revokes nothing', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'dead1', siteId: 'site-a', machineId: 'm1', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'dead2', siteId: 'site-a', machineId: 'm1', expiresAt: lifecycleTs(now - 1000) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(0);
    expect(deletedIds).toEqual([]);
  });

  it('prune deletes only dead tokens (superseded-retired / expired), never live', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'live', siteId: 'site-a', machineId: 'm1' },
      { id: 'retired', siteId: 'site-a', supersededAt: now - 600_000, retiresAt: lifecycleTs(now - 300_000) },
      { id: 'grace', siteId: 'site-a', supersededAt: now, retiresAt: lifecycleTs(now + 60_000) },
      { id: 'expired', siteId: 'site-a', expiresAt: lifecycleTs(now - 1000) },
      { id: 'other-site-dead', siteId: 'site-b', expiresAt: lifecycleTs(now - 1000) },
    ];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.revokedCount).toBe(2);
    expect([...deletedIds].sort()).toEqual(['expired', 'retired']);
  });

  it('rejects a request with no revoke target', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(400);
  });

  it('rejects conflicting revoke modes so latestOnly can never fall through to all', async () => {
    tokenDocs = [{ id: 'x', siteId: 'site-a', machineId: 'm1' }];
    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1', latestOnly: true, all: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    expect(res.status).toBe(400);
    expect(deletedIds).toEqual([]); // nothing deleted
  });

  it('rejects latestOnly without machineId', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latestOnly: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );
    expect(res.status).toBe(400);
  });

  it('emits a site_mutated audit with verb=agent_token.revoke and no token material', async () => {
    tokenDocs = [{ id: 'delete-me', siteId: 'site-a', machineId: 'm1' }];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'm1' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'site_mutated',
      siteId: 'site-a',
      actor: 'user:test-admin',
      targetId: 'm1',
      attributes: {
        verb: 'agent_token.revoke',
        endpoint: 'agent-tokens/revoke',
        method: 'POST',
        mode: 'machine',
        revokedCount: 1,
        machineId: 'm1',
      },
    });
    // The `agent_refresh_tokens` doc id IS the token hash — it must never
    // reach the audit attributes.
    expect(JSON.stringify(mockEmitMutation.mock.calls[0][0])).not.toContain('delete-me');
  });

  it('emits mode=prune for a prune request', async () => {
    const now = Date.now();
    tokenDocs = [
      { id: 'expired', siteId: 'site-a', expiresAt: lifecycleTs(now - 1000) },
    ];

    await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: true }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_mutated',
        targetId: 'site-a',
        attributes: expect.objectContaining({
          verb: 'agent_token.revoke',
          mode: 'prune',
          revokedCount: 1,
        }),
      }),
    );
  });

  it('does not emit when the token id is unknown', async () => {
    tokenDocs = [];

    const res = await POST(
      new NextRequest('http://localhost/api/sites/site-a/agent-tokens/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: 'nope' }),
      }),
      { params: Promise.resolve({ siteId: 'site-a' }) },
    );

    expect(res.status).toBe(200);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
