/** @jest-environment node */

import { createMockRequest } from './helpers/utils';
import { FieldValue } from 'firebase-admin/firestore';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  seedSiteOwner,
  seedMember,
} from './helpers/firestore-mock';

const mockEmitMutation = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
const mockAssertSite = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
    assertUserHasSiteAccess: (...a: unknown[]) => mockAssertSite(...a),
  };
});

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

// Stub ssrf + dns resolution so url validation is deterministic.
jest.mock('@/lib/webhookUrl', () => ({
  validateWebhookUrl: jest.fn(async (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.startsWith('https://')) {
      return { ok: false, reason: 'bad_scheme', detail: 'must be https' };
    }
    return { ok: true, url: raw, hostname: new URL(raw).hostname };
  }),
}));

import { POST as createPOST, GET as listGET } from '@/app/api/webhooks/route';
import {
  GET as detailGET,
  PATCH as detailPATCH,
  DELETE as detailDELETE,
} from '@/app/api/webhooks/[webhookId]/route';
import { POST as rotatePOST } from '@/app/api/webhooks/[webhookId]/rotate-secret/route';
import { GET as deliveriesGET } from '@/app/api/webhooks/[webhookId]/deliveries/route';
import { GET as deliveryDetailGET } from '@/app/api/webhooks/[webhookId]/deliveries/[deliveryId]/route';
import { POST as retryPOST } from '@/app/api/webhooks/[webhookId]/deliveries/[deliveryId]/retry/route';
// Real class — the module mock above spreads `jest.requireActual`, so this is
// the same constructor `_shared.ts` branches on with `instanceof`.
import { ApiAuthError } from '@/lib/apiAuth.server';
import {
  enforcePlans,
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  stopEnforcingPlans,
} from './helpers/planEnforcement';

const SITE = 'site-alpha';
const WEBHOOK = 'wh_test_0000000001';
const DELIVERY = 'abcdef123__wh_test_0000000001';

/**
 * Default caller: `user-1`, who OWNS the site. The mutating routes gate on
 * WEBHOOK_MANAGE, and the owner short-circuits that gate — so these fixtures
 * keep every behavioural test below reading one `mocks.get` per route call, with
 * no `users/{uid}` read interleaved. Capability enforcement itself is covered by
 * the non-owner fixtures in "WEBHOOK_MANAGE enforcement".
 */
function authed() {
  mockResolveAuth.mockResolvedValue({ userId: 'user-1', keyContext: null });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
  seedSiteOwner(SITE, 'user-1');
}

/**
 * A caller who is NOT the site owner, so the capability matrix — not the owner
 * short-circuit — decides. `mocks.get` answers per path: the `users/{uid}` read
 * the gate makes, and the subscription read a route makes afterwards.
 */
function authedAsNonOwner(
  userId: string,
  role: 'member' | 'admin' | 'superadmin',
  sites: string[],
) {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  mockAssertSite.mockResolvedValue({ siteId: SITE, siteData: {} });
  seedSiteOwner(SITE, 'someone-else');
  // Standing is a member row now. Mirror the global role onto each site the
  // fixture claims, which is what that role used to confer there; superadmins
  // get none, matching production, where they reach every site by role.
  if (role !== 'superadmin') {
    for (const siteId of sites) {
      seedMember(siteId, userId, role === 'admin' ? 'admin' : 'member');
    }
  }
  mocks.get.mockImplementation((path?: unknown) =>
    Promise.resolve(
      typeof path === 'string' && path.startsWith('users/')
        ? docSnapshot(userId, { role, sites })
        : docSnapshot(WEBHOOK, {
            url: 'https://ex.com',
            events: ['version.published'],
            signingSecret: 'whsec_OLD',
          }),
    ),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.set.mockResolvedValue(undefined);
  mocks.update.mockResolvedValue(undefined);
  mocks.get.mockImplementation(() => Promise.resolve(docSnapshot('any', {})));
  mocks.collectionGet.mockResolvedValue(querySnapshot([]));
  authed();
});

// POST /api/webhooks

describe('POST /api/webhooks', () => {
  it('400 when siteId missing', async () => {
    const req = createMockRequest('http://localhost/api/webhooks', {
      method: 'POST',
      body: { url: 'https://example.com', events: ['version.published'] },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(400);
  });

  it('400 when url is not https', async () => {
    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: { url: 'http://insecure.example.com', events: ['version.published'] },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('bad_scheme');
  });

  it('400 when events[] is empty', async () => {
    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: { url: 'https://example.com/hook', events: [] },
    });
    expect((await createPOST(req)).status).toBe(400);
  });

  it('400 when events[] contains an unknown event', async () => {
    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: { url: 'https://example.com/hook', events: ['not.a.real.event'] },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { 'body.events'?: string[] } };
    expect(body.errors?.['body.events']?.[0]).toMatch(/unknown:.*not\.a\.real\.event/);
  });

  it('201 returns signingSecret + keeps it OFF the client-readable webhook doc', async () => {
    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: {
        url: 'https://example.com/hook',
        events: ['version.published', 'deployment.failed'],
        description: 'ci pager',
      },
    });
    const res = await createPOST(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      siteId: string;
      signingSecret: string;
      events: string[];
      paused: boolean;
      description?: string;
    };
    expect(body.id).toMatch(/^wh_[0-9a-f]{18}$/);
    expect(body.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(body.events.sort()).toEqual(['deployment.failed', 'version.published']);
    expect(body.paused).toBe(false);
    expect(body.description).toBe('ci pager');
    // Two writes now: the secret to the server-only sibling
    // (sites/{siteId}/webhook_secrets/{id}), then the webhook document itself.
    expect(mocks.set).toHaveBeenCalledTimes(2);
    const secretDoc = mocks.set.mock.calls[0]![0] as { signingSecret: string };
    expect(secretDoc.signingSecret).toBe(body.signingSecret);
    // The leak this closes: the webhook document is readable by any site member,
    // so it must carry no secret material at all.
    const webhookDoc = mocks.set.mock.calls[1]![0] as Record<string, unknown>;
    expect(webhookDoc.signingSecret).toBeUndefined();
    expect(webhookDoc.secret).toBeUndefined();
    expect(webhookDoc.previousSigningSecret).toBeUndefined();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webhook_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: body.id,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/webhooks',
          method: 'POST',
          eventCount: 2,
          hasDescription: true,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(body.signingSecret);
  });
});

// GET /api/webhooks (list)

describe('GET /api/webhooks', () => {
  it('returns cursor-paginated list, filters tombstoned, scrubs signingSecret', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'wh_alive_0000000001',
          data: {
            url: 'https://example.com/a',
            events: ['version.published'],
            signingSecret: 'whsec_LEAK_THIS_WOULD_BE_BAD',
            paused: false,
          },
        },
        {
          id: 'wh_dead_00000000001',
          data: {
            url: 'https://example.com/b',
            events: ['version.published'],
            deletedAt: 1_700_000_000_000,
          },
        },
      ]),
    );
    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`);
    const res = await listGET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      webhooks: Array<{ id: string; signingSecret?: string }>;
      next_page_token: string;
      nextPageToken: string;
    };
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]!.id).toBe('wh_alive_0000000001');
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
    // signingSecret must NEVER appear in a list response.
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/whsec_/);
    expect(body.webhooks[0]!.signingSecret).toBeUndefined();
  });

  it('accepts page_size/page_token and emits next_page_token', async () => {
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'wh_alive_0000000001',
          data: {
            url: 'https://example.com/a',
            events: ['version.published'],
            paused: false,
          },
        },
        {
          id: 'wh_alive_0000000002',
          data: {
            url: 'https://example.com/b',
            events: ['deployment.failed'],
            paused: false,
          },
        },
      ]),
    );

    const req = createMockRequest(
      `http://localhost/api/webhooks?siteId=${SITE}&page_size=1&page_token=wh_before`,
    );
    const res = await listGET(req);
    const body = (await res.json()) as {
      webhooks: Array<{ id: string }>;
      next_page_token: string;
      nextPageToken: string;
    };

    expect(res.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledWith(2);
    expect(mocks.startAfter).toHaveBeenCalled();
    expect(body.webhooks).toHaveLength(1);
    expect(body.next_page_token).toBe('wh_alive_0000000001');
    expect(body.nextPageToken).toBe(body.next_page_token);
  });

  it('uses the last emitted webhook as page token when deleted docs are skipped', async () => {
    mocks.collectionGet
      .mockResolvedValueOnce(
        querySnapshot([
          {
            id: 'wh_alive_0000000001',
            data: {
              url: 'https://example.com/a',
              events: ['version.published'],
              paused: false,
            },
          },
          {
            id: 'wh_deleted0000001',
            data: {
              url: 'https://example.com/deleted',
              events: ['version.published'],
              deletedAt: 1_700_000_000_000,
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        querySnapshot([
          {
            id: 'wh_alive_0000000002',
            data: {
              url: 'https://example.com/b',
              events: ['deployment.failed'],
              paused: false,
            },
          },
        ]),
      );

    const req = createMockRequest(
      `http://localhost/api/webhooks?siteId=${SITE}&page_size=1`,
    );
    const res = await listGET(req);
    const body = (await res.json()) as {
      webhooks: Array<{ id: string }>;
      next_page_token: string;
    };

    expect(res.status).toBe(200);
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]!.id).toBe('wh_alive_0000000001');
    expect(body.next_page_token).toBe('wh_alive_0000000001');
  });
});

// GET /api/webhooks/{id} (detail)

describe('GET /api/webhooks/{webhookId}', () => {
  it('404 when doc is absent', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(WEBHOOK, null));
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
    );
    const res = await detailGET(req, { params: Promise.resolve({ webhookId: WEBHOOK }) });
    expect(res.status).toBe(404);
  });

  it('404 when doc is soft-deleted', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com',
        events: ['version.published'],
        deletedAt: 1_700_000_000_000,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
    );
    const res = await detailGET(req, { params: Promise.resolve({ webhookId: WEBHOOK }) });
    expect(res.status).toBe(404);
  });

  it('200 with subscription shape, no signingSecret', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com/a',
        events: ['version.published'],
        signingSecret: 'whsec_LEAK',
        paused: false,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
    );
    const res = await detailGET(req, { params: Promise.resolve({ webhookId: WEBHOOK }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(WEBHOOK);
    expect(JSON.stringify(body)).not.toMatch(/whsec_/);
  });
});

// PATCH /api/webhooks/{id}

describe('PATCH /api/webhooks/{webhookId}', () => {
  it('400 when no updatable fields supplied', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, { url: 'https://ex.com', events: ['version.published'] }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'PATCH', body: {} },
    );
    const res = await detailPATCH(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(400);
  });

  it('400 with unknown event in events[]', async () => {
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'PATCH', body: { events: ['typo.event'] } },
    );
    const res = await detailPATCH(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(400);
  });

  it('patches paused + events, rewrites only supplied fields', async () => {
    mocks.get.mockResolvedValue(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com/orig',
        events: ['version.published'],
        paused: false,
        signingSecret: 'whsec_x',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'PATCH', body: { paused: true, events: ['deployment.failed'] } },
    );
    const res = await detailPATCH(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(200);
    const updatePayload = mocks.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(updatePayload.paused).toBe(true);
    expect(updatePayload.events).toEqual(['deployment.failed']);
    expect(updatePayload.url).toBeUndefined(); // not touched
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webhook_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: WEBHOOK,
        attributes: expect.objectContaining({
          verb: 'update',
          endpoint: `/api/webhooks/${WEBHOOK}`,
          method: 'PATCH',
          changedFields: expect.arrayContaining(['events', 'paused']),
        }),
      }),
    );
  });

  it('404 on patched doc that is soft-deleted', async () => {
    mocks.get.mockResolvedValue(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com',
        events: ['version.published'],
        deletedAt: 1_700_000_000_000,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'PATCH', body: { paused: true } },
    );
    const res = await detailPATCH(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(404);
  });
});

// DELETE /api/webhooks/{id}

describe('DELETE /api/webhooks/{webhookId}', () => {
  it('stamps deletedAt + tombstoneExpiresAt + paused=true', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com',
        events: ['version.published'],
        paused: false,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { softDeleted: boolean; tombstoneExpiresAt: string };
    expect(body.softDeleted).toBe(true);
    expect(typeof body.tombstoneExpiresAt).toBe('string');
    const updatePayload = mocks.update.mock.calls[0]![0] as Record<string, unknown>;
    expect(updatePayload.deletedAt).toBeDefined();
    expect(updatePayload.tombstoneExpiresAt).toBeDefined();
    expect(updatePayload.paused).toBe(true);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webhook_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: WEBHOOK,
        attributes: expect.objectContaining({
          verb: 'delete',
          endpoint: `/api/webhooks/${WEBHOOK}`,
          method: 'DELETE',
        }),
      }),
    );
  });

  it('idempotent on repeat — re-returns the original tombstone, does not re-stamp', async () => {
    const originalTombstone = 1_800_000_000_000;
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com',
        events: ['version.published'],
        deletedAt: 1_700_000_000_000,
        tombstoneExpiresAt: originalTombstone,
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tombstoneExpiresAt: string };
    expect(body.tombstoneExpiresAt).toBe(new Date(originalTombstone).toISOString());
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('404 when doc absent', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(WEBHOOK, null));
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'DELETE' },
    );
    const res = await detailDELETE(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(404);
  });
});

// POST /api/webhooks/{id}/rotate-secret

describe('POST /api/webhooks/{webhookId}/rotate-secret', () => {
  it('returns new signingSecret + previousSecretValidUntil + gracePeriodHours', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, {
        url: 'https://ex.com',
        events: ['version.published'],
        signingSecret: 'whsec_OLD',
      }),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/rotate-secret?siteId=${SITE}`,
      { method: 'POST' },
    );
    const res = await rotatePOST(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signingSecret: string;
      previousSecretValidUntil: string;
      gracePeriodHours: number;
      rotatedAt: string;
    };
    expect(body.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(body.signingSecret).not.toBe('whsec_OLD');
    expect(body.gracePeriodHours).toBe(24);
    expect(typeof body.previousSecretValidUntil).toBe('string');
    expect(typeof body.rotatedAt).toBe('string');

    // Both writes are in ONE batch, so a partial rotation cannot leave the
    // subscription signing with a secret the caller was never handed.
    // batch.set/update take (ref, data) — the payload is the second argument.
    const secretDoc = mocks.batchSet.mock.calls[0]![1] as Record<string, unknown>;
    expect(secretDoc.signingSecret).toBe(body.signingSecret);
    expect(secretDoc.previousSigningSecret).toBe('whsec_OLD');
    // The rotation also HEALS the leak on this subscription: the legacy
    // in-document fields are deleted, not overwritten.
    const updatePayload = mocks.batchUpdate.mock.calls[0]![1] as Record<string, unknown>;
    // Real FieldValue.delete() sentinels (DeleteTransform), not plain objects.
    expect(updatePayload.signingSecret).toEqual(FieldValue.delete());
    expect(updatePayload.previousSigningSecret).toEqual(FieldValue.delete());
    expect(updatePayload.secret).toEqual(FieldValue.delete());
    expect(updatePayload.previousSecretValidUntil).toBeDefined();
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webhook_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: WEBHOOK,
        attributes: expect.objectContaining({
          verb: 'rotate_secret',
          endpoint: `/api/webhooks/${WEBHOOK}/rotate-secret`,
          method: 'POST',
          gracePeriodHours: 24,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(body.signingSecret);
  });

  it('404 when subscription missing', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(WEBHOOK, null));
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/rotate-secret?siteId=${SITE}`,
      { method: 'POST' },
    );
    const res = await rotatePOST(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(404);
  });
});

// GET /api/webhooks/{id}/deliveries

describe('GET /api/webhooks/{webhookId}/deliveries', () => {
  it('404 when subscription is missing', async () => {
    mocks.get.mockResolvedValueOnce(docSnapshot(WEBHOOK, null));
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries?siteId=${SITE}`,
    );
    const res = await deliveriesGET(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(404);
  });

  it('returns delivery summaries (state, attempt, lastStatus, nextAttemptAt only when pending)', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, { url: 'https://ex.com', events: ['version.published'] }),
    );
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: `aa__${WEBHOOK}`,
          data: {
            event: 'version.published',
            state: 'succeeded',
            attempt: 1,
            lastStatus: 200,
            createdAt: 1_700_000_000_000,
            completedAt: 1_700_000_001_000,
            nextAttemptAt: 1_700_000_000_000,
          },
        },
        {
          id: `bb__${WEBHOOK}`,
          data: {
            event: 'deployment.failed',
            state: 'pending',
            attempt: 3,
            lastStatus: 503,
            createdAt: 1_700_000_100_000,
            nextAttemptAt: 1_700_000_200_000,
          },
        },
      ]),
    );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries?siteId=${SITE}`,
    );
    const res = await deliveriesGET(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deliveries: Array<{
        id: string;
        state: string;
        attempt: number;
        nextAttemptAt: string | null;
      }>;
      next_page_token: string;
      nextPageToken: string;
    };
    expect(body.deliveries).toHaveLength(2);
    expect(body.next_page_token).toBe('');
    expect(body.nextPageToken).toBe('');
    const succeeded = body.deliveries.find((d) => d.state === 'succeeded')!;
    const pending = body.deliveries.find((d) => d.state === 'pending')!;
    expect(succeeded.nextAttemptAt).toBeNull();
    expect(pending.nextAttemptAt).not.toBeNull();
    expect(pending.attempt).toBe(3);
  });
});

// GET /api/webhooks/{id}/deliveries/{deliveryId}

describe('GET /api/webhooks/{webhookId}/deliveries/{deliveryId}', () => {
  it('404 when delivery belongs to a different subscription', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(WEBHOOK, { url: 'https://ex.com', events: ['version.published'] }),
      )
      .mockResolvedValueOnce(
        docSnapshot(DELIVERY, {
          subscriptionId: 'wh_OTHER_0000000001',
          siteId: SITE,
          canonicalBody: '{}',
          event: 'version.published',
        }),
      );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries/${DELIVERY}?siteId=${SITE}`,
    );
    const res = await deliveryDetailGET(req, {
      params: Promise.resolve({ webhookId: WEBHOOK, deliveryId: DELIVERY }),
    });
    expect(res.status).toBe(404);
  });

  it('returns request + response + attempt + nextAttemptAt', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(WEBHOOK, { url: 'https://ex.com', events: ['version.published'] }),
      )
      .mockResolvedValueOnce(
        docSnapshot(DELIVERY, {
          subscriptionId: WEBHOOK,
          siteId: SITE,
          url: 'https://ex.com/hook',
          headers: { 'Roost-Event': 'version.published' },
          canonicalBody: '{"event":"version.published"}',
          event: 'version.published',
          state: 'succeeded',
          attempt: 2,
          lastStatus: 200,
          createdAt: 1_700_000_000_000,
          completedAt: 1_700_000_001_000,
        }),
      );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries/${DELIVERY}?siteId=${SITE}`,
    );
    const res = await deliveryDetailGET(req, {
      params: Promise.resolve({ webhookId: WEBHOOK, deliveryId: DELIVERY }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      request: { method: string; url: string; body: string };
      response: { status: number } | null;
      attempt: number;
      nextAttemptAt: string | null;
    };
    expect(body.request.method).toBe('POST');
    expect(body.request.url).toBe('https://ex.com/hook');
    expect(body.response?.status).toBe(200);
    expect(body.attempt).toBe(2);
    expect(body.nextAttemptAt).toBeNull();
  });
});

// POST /api/webhooks/{id}/deliveries/{deliveryId}/retry

describe('POST /api/webhooks/{webhookId}/deliveries/{deliveryId}/retry', () => {
  it('creates a new pending delivery with retryOf pointer + fresh stripe signature', async () => {
    // get 1: subscription doc (no secret on it any more). get 2: the server-only
    // secret sibling, which is now where the signing key comes from. get 3: the
    // original delivery (canonicalBody + headers).
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(WEBHOOK, {
          url: 'https://ex.com/hook',
          events: ['version.published'],
        }),
      )
      .mockResolvedValueOnce(
        docSnapshot(WEBHOOK, { signingSecret: 'whsec_CURRENT' }),
      )
      .mockResolvedValueOnce(
        docSnapshot(DELIVERY, {
          subscriptionId: WEBHOOK,
          siteId: SITE,
          url: 'https://ex.com/hook',
          event: 'version.published',
          canonicalBody: '{"event":"version.published","data":{}}',
          headers: { 'Roost-Delivery': 'public_delivery_id_here' },
        }),
      );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries/${DELIVERY}/retry?siteId=${SITE}`,
      { method: 'POST' },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ webhookId: WEBHOOK, deliveryId: DELIVERY }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      id: string;
      retryOf: string;
      state: string;
      nextAttemptAt: string;
    };
    expect(body.id).toMatch(new RegExp(`^${DELIVERY}__retry_[0-9a-f]{8}$`));
    expect(body.retryOf).toBe(DELIVERY);
    expect(body.state).toBe('pending');
    expect(typeof body.nextAttemptAt).toBe('string');

    // Stripe-style t=<unix>,v1=<hex>; the public delivery-id header is kept
    // for receiver dedup.
    const writePayload = mocks.set.mock.calls[0]![0] as {
      secret: string;
      retryOf: string;
      state: string;
      attempt: number;
      headers: Record<string, string>;
    };
    expect(writePayload.secret).toBe('whsec_CURRENT');
    expect(writePayload.retryOf).toBe(DELIVERY);
    expect(writePayload.state).toBe('pending');
    expect(writePayload.attempt).toBe(0);
    expect(writePayload.headers['Roost-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(writePayload.headers['Roost-Delivery']).toBe('public_delivery_id_here');
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'webhook_mutated',
        siteId: SITE,
        actor: 'user:user-1',
        targetId: WEBHOOK,
        attributes: expect.objectContaining({
          verb: 'retry_delivery',
          endpoint: `/api/webhooks/${WEBHOOK}/deliveries/${DELIVERY}/retry`,
          method: 'POST',
          deliveryId: DELIVERY,
          retryDeliveryId: body.id,
          event: 'version.published',
        }),
      }),
    );
  });

  it('404 when original delivery belongs to a different subscription', async () => {
    mocks.get
      .mockResolvedValueOnce(
        docSnapshot(WEBHOOK, {
          url: 'https://ex.com',
          events: ['version.published'],
          signingSecret: 'whsec_x',
        }),
      )
      .mockResolvedValueOnce(
        docSnapshot(DELIVERY, {
          subscriptionId: 'wh_OTHER_0000000001',
          siteId: SITE,
          canonicalBody: '{}',
          event: 'version.published',
        }),
      );
    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries/${DELIVERY}/retry?siteId=${SITE}`,
      { method: 'POST' },
    );
    const res = await retryPOST(req, {
      params: Promise.resolve({ webhookId: WEBHOOK, deliveryId: DELIVERY }),
    });
    expect(res.status).toBe(404);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});

// WEBHOOK_MANAGE enforcement (site-scoped capability, mutations only)

describe('WEBHOOK_MANAGE enforcement', () => {
  it('403s a member of the site on create', async () => {
    authedAsNonOwner('member-uid', 'member', [SITE]);

    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: { url: 'https://example.com/hook', events: ['version.published'] },
    });
    const res = await createPOST(req);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBe('capability not granted');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('403s a member of the site on rotate-secret', async () => {
    authedAsNonOwner('member-uid', 'member', [SITE]);

    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/rotate-secret?siteId=${SITE}`,
      { method: 'POST' },
    );
    const res = await rotatePOST(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });

    expect(res.status).toBe(403);
    // The secret is never minted, let alone written.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('403s a member of the site on update and delete', async () => {
    authedAsNonOwner('member-uid', 'member', [SITE]);

    const patchReq = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'PATCH', body: { paused: true } },
    );
    const patchRes = await detailPATCH(patchReq, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(patchRes.status).toBe(403);

    const deleteReq = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
      { method: 'DELETE' },
    );
    const deleteRes = await detailDELETE(deleteReq, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(deleteRes.status).toBe(403);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('lets an admin of the site create', async () => {
    authedAsNonOwner('admin-uid', 'admin', [SITE]);

    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: { url: 'https://example.com/hook', events: ['version.published'] },
    });
    const res = await createPOST(req);

    expect(res.status).toBe(201);
    // Secret document + webhook document.
    expect(mocks.set).toHaveBeenCalledTimes(2);
  });

  it('lets an admin of the site rotate a secret', async () => {
    authedAsNonOwner('admin-uid', 'admin', [SITE]);

    const req = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/rotate-secret?siteId=${SITE}`,
      { method: 'POST' },
    );
    const res = await rotatePOST(req, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { signingSecret: string };
    expect(body.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it('masks an admin of ANOTHER site as 404, before the capability check', async () => {
    authedAsNonOwner('admin-uid', 'admin', ['site-other-org']);
    // Site access is what fails first; it collapses 403 to "not found or no
    // access" so site existence never leaks.
    mockAssertSite.mockRejectedValue(
      new ApiAuthError(403, 'Forbidden: You do not have access to this site'),
    );

    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
      method: 'POST',
      body: { url: 'https://example.com/hook', events: ['version.published'] },
    });
    const res = await createPOST(req);

    expect(res.status).toBe(404);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('still lets a member list subscriptions (read paths are unchanged)', async () => {
    authedAsNonOwner('member-uid', 'member', [SITE]);
    mocks.collectionGet.mockResolvedValueOnce(
      querySnapshot([
        {
          id: 'wh_alive_0000000001',
          data: {
            url: 'https://example.com/a',
            events: ['version.published'],
            paused: false,
          },
        },
      ]),
    );

    const req = createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`);
    const res = await listGET(req);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { webhooks: Array<{ id: string }> };
    expect(body.webhooks).toHaveLength(1);
  });

  it('still lets a member read a subscription and its deliveries', async () => {
    authedAsNonOwner('member-uid', 'member', [SITE]);

    const detailReq = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`,
    );
    const detailRes = await detailGET(detailReq, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(detailRes.status).toBe(200);

    const deliveriesReq = createMockRequest(
      `http://localhost/api/webhooks/${WEBHOOK}/deliveries?siteId=${SITE}`,
    );
    const deliveriesRes = await deliveriesGET(deliveriesReq, {
      params: Promise.resolve({ webhookId: WEBHOOK }),
    });
    expect(deliveriesRes.status).toBe(200);
  });
});

// plan gate — creating needs the payer's owlette.webhooks; the rest stay open (plan.md decision 8)

describe('owlette.webhooks plan gate', () => {
  const create = () =>
    createPOST(
      createMockRequest(`http://localhost/api/webhooks?siteId=${SITE}`, {
        method: 'POST',
        body: { url: 'https://example.com/hook', events: ['version.published'] },
      }),
    );

  beforeEach(() => {
    enforcePlans();
    mockGetEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);
  });
  afterEach(stopEnforcingPlans);

  it('402s a create on the site payer’s free plan, and writes nothing', async () => {
    const res = await create();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.webhooks',
    });
    expect(mockGetEntitlements).toHaveBeenCalledWith('user-1');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('creates on pro', async () => {
    mockGetEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);

    expect((await create()).status).toBe(201);
  });

  it('keeps delete open on free', async () => {
    mocks.get.mockResolvedValueOnce(
      docSnapshot(WEBHOOK, { url: 'https://ex.com', events: ['version.published'], paused: false }),
    );

    const res = await detailDELETE(
      createMockRequest(`http://localhost/api/webhooks/${WEBHOOK}?siteId=${SITE}`, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ webhookId: WEBHOOK }) },
    );

    expect(res.status).toBe(200);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });
});
