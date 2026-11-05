/** @jest-environment node */

/**
 * GET/PATCH /api/sites/{siteId}/display-settings. the real `authorizedSiteHandler`
 * runs, so the membership and capability answers are the wrapper's own.
 */

import { createMockRequest, parseResponse } from './helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  querySnapshot,
  apiKeyAuth,
  seedMember,
  seedSiteOwner,
} from './helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const writeAuditEntry = jest.fn();
jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: (...a: unknown[]) => writeAuditEntry(...a),
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

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

import { GET, PATCH } from '@/app/api/sites/[siteId]/display-settings/route';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const OTHER_MACHINE = 'machine-2';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';
const SETTINGS_PATH = `sites/${SITE}/settings/display`;

/** documents the routes read, keyed by their full firestore path. */
const staged = new Map<string, Record<string, unknown> | null>();

const url = `http://localhost/api/sites/${SITE}/display-settings`;
const siteContext = () => ({ params: Promise.resolve({ siteId: SITE }) });

function patch(body: unknown) {
  return PATCH(createMockRequest(url, { method: 'PATCH', body }), siteContext());
}

function signIn(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

/** every `commands/pending` write: one map entry per command, keyed by command id. */
function commandWrites(): Array<{ id: string; command: Record<string, unknown> }> {
  return mocks.set.mock.calls
    .map(([payload]) => payload as Record<string, Record<string, unknown>>)
    .filter((payload) => Object.keys(payload).every((k) => k.startsWith('site_settings_refresh_')))
    .flatMap((payload) => Object.entries(payload).map(([id, command]) => ({ id, command })));
}

/** the settings document write, i.e. the one carrying `keepAwake` at the top level. */
function settingsWrites(): Array<[Record<string, unknown>, unknown]> {
  return mocks.set.mock.calls
    .filter(([payload]) => 'keepAwake' in (payload as object))
    .map(([payload, options]) => [payload as Record<string, unknown>, options]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mocks.set.mockResolvedValue(undefined);

  staged.clear();
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );
  // the query answers with the online machines only; the filter it asks for is
  // asserted separately.
  mocks.collectionGet.mockResolvedValue(querySnapshot([{ id: MACHINE, data: { online: true } }]));

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('GET display-settings', () => {
  it('reads keepAwake as true when the site never set it', async () => {
    const { status, body } = await parseResponse(
      await GET(createMockRequest(url), siteContext()),
    );

    expect(status).toBe(200);
    expect(body.data).toEqual({ keepAwake: true });
  });

  it('reads keepAwake as false only when stored false', async () => {
    staged.set(SETTINGS_PATH, { keepAwake: false });

    const { body } = await parseResponse(await GET(createMockRequest(url), siteContext()));

    expect(body.data).toEqual({ keepAwake: false });
  });

  it('refuses an api key, even an admin key', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(ADMIN));

    const res = await GET(createMockRequest(url), siteContext());

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('api_key_not_permitted');
  });

  it('refuses a member', async () => {
    signIn(MEMBER);

    const res = await GET(createMockRequest(url), siteContext());

    expect(res.status).toBe(403);
  });
});

describe('PATCH display-settings', () => {
  it('refuses an api key, even an admin key, and writes nothing', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(ADMIN));

    const res = await patch({ keepAwake: false });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('api_key_not_permitted');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('refuses a member and writes nothing', async () => {
    signIn(MEMBER);

    const res = await patch({ keepAwake: false });

    expect(res.status).toBe(403);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ outcome: 'deny', denyReason: 'capability_missing' }),
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('an admin turning it off merge-writes the document and nudges the online machines', async () => {
    const { status, body } = await parseResponse(await patch({ keepAwake: false }));

    expect(status).toBe(200);
    expect(body.data).toEqual({ settings: { keepAwake: false }, refreshed: 1 });
    expect(settingsWrites()).toEqual([
      [{ keepAwake: false, updatedAt: '__SERVER_TS__' }, { merge: true }],
    ]);
    expect(mocks.where).toHaveBeenCalledWith('online', '==', true);

    const commands = commandWrites();
    expect(commands).toHaveLength(1);
    expect(commands[0].id).toMatch(/^site_settings_refresh_machine_1_\d+$/);
    // payload `{}`: the envelope and nothing else.
    expect(commands[0].command).toEqual({
      type: 'site_settings_refresh',
      siteId: SITE,
      timestamp: '__SERVER_TS__',
      status: 'pending',
      queuedBy: `user:${ADMIN}`,
      createdAt: '__SERVER_TS__',
      expiresAt: expect.anything(),
      auditCorrelationId: 'corr-test',
    });

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'site_mutated',
        siteId: SITE,
        attributes: expect.objectContaining({
          verb: 'set_display_settings',
          keepAwake: false,
          refreshedCount: 1,
        }),
      }),
    );
  });

  it('turning it back on nudges too', async () => {
    staged.set(SETTINGS_PATH, { keepAwake: false });

    const { body } = await parseResponse(await patch({ keepAwake: true }));

    expect(body.data).toEqual({ settings: { keepAwake: true }, refreshed: 1 });
    expect(commandWrites()).toHaveLength(1);
  });

  it('does not nudge when the value did not change', async () => {
    // absent reads as on, so writing on is no change.
    const { status, body } = await parseResponse(await patch({ keepAwake: true }));

    expect(status).toBe(200);
    expect(body.data).toEqual({ settings: { keepAwake: true }, refreshed: 0 });
    expect(settingsWrites()).toHaveLength(1);
    expect(mocks.collectionGet).not.toHaveBeenCalled();
    expect(commandWrites()).toHaveLength(0);
  });

  it('one machine failing to take the command does not fail the rest', async () => {
    mocks.collectionGet.mockResolvedValue(
      querySnapshot([
        { id: MACHINE, data: { online: true } },
        { id: OTHER_MACHINE, data: { online: true } },
      ]),
    );
    mocks.set
      .mockResolvedValueOnce(undefined) // the settings document
      .mockResolvedValueOnce(undefined) // machine-1
      .mockRejectedValueOnce(new Error('firestore down')); // machine-2

    const { status, body } = await parseResponse(await patch({ keepAwake: false }));

    expect(status).toBe(200);
    expect((body.data as { refreshed: number }).refreshed).toBe(1);
  });

  it.each([
    ['a missing field', {}],
    ['a string', { keepAwake: 'false' }],
    ['null', { keepAwake: null }],
  ])('refuses %s', async (_label, body) => {
    const res = await patch(body);
    const parsed = await parseResponse(res);

    expect(parsed.status).toBe(400);
    expect(parsed.body.code).toBe('validation_failed');
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
