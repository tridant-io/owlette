/** @jest-environment node */

/**
 * POST /api/webhooks/test — send a test payload to an existing subscription.
 *
 * Authorization is site membership + the site-scoped `WEBHOOK_MANAGE`
 * capability (it was superadmin-only, which locked site admins out of testing
 * their own subscriptions). `assertUserHasSiteAccess` runs for real against the
 * doc store here, so the membership and capability layers are exercised
 * together; only `resolveAuth` is mocked, to inject the caller.
 */

import { NextRequest } from 'next/server';

import {
  mocks,
  mockDbFactory,
  docSnapshot,
  seedSiteOwner,
  seedMember,
} from './helpers/firestore-mock';

jest.mock('@/lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  __esModule: true,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'serverTimestamp' }) },
}));

const mockTestWebhook = jest.fn();
jest.mock('@/lib/webhookSender.server', () => ({
  testWebhook: (...args: unknown[]) => mockTestWebhook(...args),
}));

import { POST } from '@/app/api/webhooks/test/route';
import { ApiAuthError } from '@/lib/apiAuth.server';

const SITE = 's1';
const WEBHOOK = 'wh-1';

const mockDocUpdate = jest.fn().mockResolvedValue(undefined);

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/webhooks/test', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * `mocks.get` is called with the document path for regular collections and with
 * no path for the slash-form `sites/{siteId}/webhooks` collection the route
 * uses — which is how the caller's `users/{uid}` read is told apart from the
 * subscription read.
 */
function seedCaller(
  userId: string,
  role: 'member' | 'admin' | 'superadmin',
  sites: string[],
  options: { webhook?: Record<string, unknown> | null } = {},
) {
  const webhook =
    options.webhook === undefined
      ? { url: 'https://hooks.example.com', signingSecret: 'abc' }
      : options.webhook;
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  seedSiteOwner(SITE, 'owner-someone-else');
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
        : { ...docSnapshot(WEBHOOK, webhook), ref: { update: mockDocUpdate } },
    ),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDocUpdate.mockResolvedValue(undefined);
  seedCaller('admin-uid', 'admin', [SITE]);
});

describe('POST /api/webhooks/test', () => {
  it('returns 400 when webhookId is missing', async () => {
    const res = await POST(makeRequest({ siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/webhookId/i);
  });

  it('returns 400 when siteId is missing', async () => {
    const res = await POST(makeRequest({ webhookId: WEBHOOK }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/siteId/i);
  });

  it('returns 404 when webhook does not exist', async () => {
    seedCaller('admin-uid', 'admin', [SITE], { webhook: null });

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });

  it('sends test and returns success for 2xx response', async () => {
    mockTestWebhook.mockResolvedValue({ status: 200 });

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe(200);
    expect(mockTestWebhook).toHaveBeenCalledWith('https://hooks.example.com', 'abc');
  });

  it('returns success:false for non-2xx response', async () => {
    mockTestWebhook.mockResolvedValue({ status: 500 });

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.status).toBe(500);
  });

  it('returns error message on network failure', async () => {
    mockTestWebhook.mockResolvedValue({ status: 0, error: 'ECONNREFUSED' });

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(false);
    expect(json.error).toBe('ECONNREFUSED');
  });

  it('returns 401 when unauthenticated', async () => {
    mockResolveAuth.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));

    expect(res.status).toBe(401);
    expect(mockTestWebhook).not.toHaveBeenCalled();
  });

  it('403s a member of the site — WEBHOOK_MANAGE is site-admin only', async () => {
    seedCaller('member-uid', 'member', [SITE]);

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.detail).toBe('capability not granted');
    expect(mockTestWebhook).not.toHaveBeenCalled();
  });

  it('403s a superadmin who is not a member of the site (adr 0021)', async () => {
    seedCaller('root-uid', 'superadmin', []);

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('members_only');
    expect(mockTestWebhook).not.toHaveBeenCalled();
  });

  it('404s an admin of another site before reaching the webhook', async () => {
    seedCaller('admin-uid', 'admin', ['site-other-org']);

    const res = await POST(makeRequest({ webhookId: WEBHOOK, siteId: SITE }));

    // Access failure masks site existence; a 403 here would leak it.
    expect(res.status).toBe(404);
    expect(mockTestWebhook).not.toHaveBeenCalled();
  });
});
