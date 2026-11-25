/**
 * @jest-environment node
 *
 * GET and PUT /api/admin/activity/settings — who gets the activity emails. GET is
 * superadmin plus a `user=*:read` key (as the feed beside it); PUT is a platform
 * mutation behind `authorizedPlatformHandler` (GLOBAL_SETTINGS_WRITE, `user=*:admin`
 * key), so it writes its allow row. The two fields are merged into the state doc
 * the cron keeps its own fields on.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
      lastUpdated: 0,
      expiresAt: 0,
    })),
  },
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
}));

jest.mock('@/lib/resendClient.server', () => ({ isProduction: false }));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));

type Data = Record<string, unknown>;
const docs = new Map<string, Data>();
const writes: Array<{ path: string; data: Data; opts?: { merge?: boolean } }> = [];

function snapOf(path: string) {
  const data = docs.get(path);
  return { id: path.split('/').pop(), exists: data !== undefined, data: () => data, get: (f: string) => data?.[f] };
}

const refOf = (path: string): unknown => ({
  path,
  get: async () => snapOf(path),
  set: async (data: Data, opts?: { merge?: boolean }) => {
    writes.push({ path, data, opts });
    if (!path.startsWith('global/audit_log/')) docs.set(path, opts?.merge ? { ...docs.get(path), ...data } : data);
  },
  collection: (name: string) => colOf(`${path}/${name}`),
});
const colOf = (path: string): unknown => ({ doc: (id = 'auto') => refOf(`${path}/${id}`) });

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => colOf(name),
    doc: (path: string) => refOf(path),
    getAll: (...refs: Array<{ path: string }>) => Promise.resolve(refs.map((r) => snapOf(r.path))),
  }),
}));

import { GET, PUT } from '@/app/api/admin/activity/settings/route';

const STATE = 'global/activity_watch';
const key = (resource: string, permission: string) => [{ resource, id: '*', permissions: [permission] }];

function signIn(role: string, scopes?: Array<{ resource: string; id: string; permissions: string[] }>) {
  docs.set('users/u1', { role });
  mockResolveAuth.mockResolvedValue({
    userId: 'u1',
    keyContext: scopes
      ? { keyId: 'key_test', environment: 'live', isLegacy: false, scopes, expiresAt: null }
      : null,
  });
}

const put = (body: Record<string, unknown>) =>
  PUT(createMockRequest('http://localhost/api/admin/activity/settings', { method: 'PUT', body }));
const get = () => GET(createMockRequest('http://localhost/api/admin/activity/settings'));
const stateWrites = () => writes.filter((w) => w.path === STATE);

const originalActivity = process.env.ACTIVITY_EMAIL;
const originalAdmin = process.env.ADMIN_EMAIL_DEV;

beforeEach(() => {
  docs.clear();
  writes.length = 0;
  mockResolveAuth.mockReset();
  delete process.env.ACTIVITY_EMAIL;
  delete process.env.ADMIN_EMAIL_DEV;
});

afterAll(() => {
  if (originalActivity !== undefined) process.env.ACTIVITY_EMAIL = originalActivity;
  if (originalAdmin !== undefined) process.env.ADMIN_EMAIL_DEV = originalAdmin;
});

describe('GET /api/admin/activity/settings', () => {
  it('reads on and no addresses from an empty state with no address configured', async () => {
    signIn('superadmin');
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, recipients: [] });
  });

  it('lists the configured address while nobody has saved a list', async () => {
    signIn('superadmin');
    process.env.ADMIN_EMAIL_DEV = 'admin@example.test';
    expect(await (await get()).json()).toEqual({ enabled: true, recipients: ['admin@example.test'] });
  });

  it('reads the stored fields, an emptied list included', async () => {
    signIn('superadmin');
    process.env.ADMIN_EMAIL_DEV = 'admin@example.test';
    docs.set(STATE, { emailEnabled: false, emailRecipients: ['a@example.test'], scannedThrough: 5 });
    expect(await (await get()).json()).toEqual({ enabled: false, recipients: ['a@example.test'] });

    docs.set(STATE, { emailEnabled: true, emailRecipients: [] });
    expect(await (await get()).json()).toEqual({ enabled: true, recipients: [] });
  });

  it('serves a key with user=*:read', async () => {
    signIn('superadmin', key('user', 'read'));
    expect((await get()).status).toBe(200);
  });

  it('403s a key of another resource', async () => {
    signIn('superadmin', key('issue', 'read'));
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
  });

  it.each(['admin', 'member'])('403s a global %s', async (role) => {
    signIn(role);
    expect((await get()).status).toBe(403);
  });
});

describe('PUT /api/admin/activity/settings', () => {
  it('merges both fields and leaves the cron own fields alone', async () => {
    signIn('superadmin');
    docs.set(STATE, { scannedThrough: 123, lastDigestDay: '2026-11-14' });

    const res = await put({ enabled: false, recipients: [' Ann@Example.test ', 'bob@example.test'] });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, recipients: ['ann@example.test', 'bob@example.test'] });
    expect(stateWrites()).toEqual([
      {
        path: STATE,
        data: { emailEnabled: false, emailRecipients: ['ann@example.test', 'bob@example.test'] },
        opts: { merge: true },
      },
    ]);
    expect(docs.get(STATE)).toEqual({
      scannedThrough: 123,
      lastDigestDay: '2026-11-14',
      emailEnabled: false,
      emailRecipients: ['ann@example.test', 'bob@example.test'],
    });
  });

  it('writes the wrapper allow row', async () => {
    signIn('superadmin');
    await put({ enabled: true, recipients: [] });
    const audit = writes.filter((w) => w.path.startsWith('global/audit_log/entries/'));
    expect(audit.some((w) => w.data.outcome === 'allow' && w.data.capability === 'GLOBAL_SETTINGS_WRITE')).toBe(true);
  });

  it('names the invalid addresses', async () => {
    signIn('superadmin');
    const res = await put({ enabled: true, recipients: ['ok@example.test', 'nope', 'a b@example.test'] });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(JSON.stringify(body.errors)).toContain('nope');
    expect(JSON.stringify(body.errors)).toContain('a b@example.test');
    expect(stateWrites()).toEqual([]);
  });

  it('400s eleven addresses', async () => {
    signIn('superadmin');
    const recipients = Array.from({ length: 11 }, (_, i) => `p${i}@example.test`);
    const res = await put({ enabled: true, recipients });
    expect(res.status).toBe(400);
    expect((await res.json()).errors.recipients).toBeDefined();
    expect(stateWrites()).toEqual([]);
  });

  it.each([['yes'], [1], [undefined]])('400s a non-boolean enabled %p', async (enabled) => {
    signIn('superadmin');
    const res = await put({ enabled, recipients: [] });
    expect(res.status).toBe(400);
    expect((await res.json()).errors.enabled).toBeDefined();
    expect(stateWrites()).toEqual([]);
  });

  it('400s recipients that are not a list', async () => {
    signIn('superadmin');
    expect((await put({ enabled: true, recipients: 'a@example.test' })).status).toBe(400);
  });

  it.each(['admin', 'member'])('403s a global %s and writes nothing', async (role) => {
    signIn(role);
    expect((await put({ enabled: true, recipients: [] })).status).toBe(403);
    expect(stateWrites()).toEqual([]);
  });

  it('403s a read-only key and takes a user=*:admin key', async () => {
    signIn('superadmin', key('user', 'read'));
    expect((await put({ enabled: true, recipients: [] })).status).toBe(403);
    expect(stateWrites()).toEqual([]);

    signIn('superadmin', key('user', 'admin'));
    expect((await put({ enabled: true, recipients: [] })).status).toBe(200);
  });
});
