/**
 * @jest-environment node
 *
 * GET /api/admin/activity — superadmin only through the real platform gate (its
 * role read is the stubbed Firestore below), a `user=*:read` scope for api keys.
 * The feed itself is mocked: this asserts what the route validates and passes
 * through, and that actor labels are filled.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));

const mockLoadActivityPage = jest.fn();
jest.mock('@/lib/activity/feed.server', () => ({
  loadActivityPage: (...args: unknown[]) => mockLoadActivityPage(...args),
  InvalidPageTokenError: class InvalidPageTokenError extends Error {},
}));

type Data = Record<string, unknown>;
const docs = new Map<string, Data>();
const mockGetAll = jest.fn();

function snapOf(path: string) {
  const data = docs.get(path);
  return { id: path.split('/').pop(), exists: data !== undefined, data: () => data, get: (f: string) => data?.[f] };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `${name}/${id}`, get: async () => snapOf(`${name}/${id}`) }),
    }),
    doc: (path: string) => ({ path }),
    getAll: (...refs: Array<{ path: string }>) => {
      mockGetAll(...refs);
      return Promise.resolve(refs.map((r) => snapOf(r.path)));
    },
  }),
}));

import { GET } from '@/app/api/admin/activity/route';
import { InvalidPageTokenError } from '@/lib/activity/feed.server';

function signIn(uid: string, role: string) {
  docs.set(`users/${uid}`, { role });
  mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });
}

function signInWithKey(uid: string, role: string, scopes: Array<{ resource: string; id: string; permissions: string[] }>) {
  docs.set(`users/${uid}`, { role });
  mockResolveAuth.mockResolvedValue({
    userId: uid,
    keyContext: { keyId: 'key_test', environment: 'live', isLegacy: false, scopes, expiresAt: null },
  });
}

function row(id: string, actor: Data, extra: Data = {}) {
  return {
    id,
    kind: 'change',
    at: 1,
    actor,
    siteId: 'site-a',
    action: 'user_mutated:promoted',
    outcome: null,
    details: {},
    ...extra,
  };
}

async function list(query = '') {
  const res = await GET(createMockRequest(`http://localhost/api/admin/activity${query}`));
  return { res, body: await res.json() };
}

beforeEach(() => {
  docs.clear();
  mockResolveAuth.mockReset();
  mockGetAll.mockReset();
  mockLoadActivityPage.mockReset();
  mockLoadActivityPage.mockResolvedValue({ rows: [], nextPageToken: '' });
});

describe('GET /api/admin/activity', () => {
  it('serves a superadmin session, with the default view and page size', async () => {
    signIn('staff-1', 'superadmin');

    const { res, body } = await list();

    expect(res.status).toBe(200);
    expect(body).toEqual({ rows: [], next_page_token: '', nextPageToken: '' });
    expect(mockLoadActivityPage).toHaveBeenCalledWith(expect.anything(), {
      view: 'all',
      userId: undefined,
      siteId: undefined,
      pageSize: 50,
      pageToken: null,
    });
  });

  it('accepts an api key with user=*:read', async () => {
    signInWithKey('staff-1', 'superadmin', [{ resource: 'user', id: '*', permissions: ['read'] }]);
    expect((await list()).res.status).toBe(200);
  });

  it('403s scope_insufficient for a superadmin key of another resource', async () => {
    signInWithKey('staff-1', 'superadmin', [{ resource: 'issue', id: '*', permissions: ['read'] }]);

    const { res, body } = await list();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
    expect(mockLoadActivityPage).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member'])('403s a global %s, even with the user scope', async (role) => {
    signInWithKey(`user-${role}`, role, [{ resource: 'user', id: '*', permissions: ['read'] }]);
    expect((await list()).res.status).toBe(403);

    signIn(`user-${role}`, role);
    expect((await list()).res.status).toBe(403);
    expect(mockLoadActivityPage).not.toHaveBeenCalled();
  });

  it('403s a deleted superadmin', async () => {
    signIn('staff-1', 'superadmin');
    docs.set('users/staff-1', { role: 'superadmin', deletedAt: 1 });
    expect((await list()).res.status).toBe(403);
  });

  it.each(['all', 'flagged', 'changes', 'refused', 'sign-ins'])('passes view %s to the feed', async (view) => {
    signIn('staff-1', 'superadmin');
    await list(`?view=${view}`);
    expect(mockLoadActivityPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ view }));
  });

  it.each(['everything', 'ALL', ''])('400s an unknown view %p', async (view) => {
    signIn('staff-1', 'superadmin');
    const { res, body } = await list(`?view=${view}`);

    expect(res.status).toBe(400);
    expect(body.errors['query.view']).toBeDefined();
    expect(mockLoadActivityPage).not.toHaveBeenCalled();
  });

  it('passes the user and site filters to the feed', async () => {
    signIn('staff-1', 'superadmin');
    await list('?user=uid_1&site=site-a');
    expect(mockLoadActivityPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'uid_1', siteId: 'site-a' }),
    );
  });

  it.each([
    ['user', 'a%2Fb'],
    ['user', ''],
    ['site', 'a%2Fb'],
    ['site', 'x'.repeat(129)],
  ])('400s a bad %s id %p', async (param, value) => {
    signIn('staff-1', 'superadmin');
    const { res, body } = await list(`?${param}=${value}`);

    expect(res.status).toBe(400);
    expect(body.errors[`query.${param}`]).toBeDefined();
  });

  it('400s a page_size over 100', async () => {
    signIn('staff-1', 'superadmin');
    expect((await list('?page_size=101')).res.status).toBe(400);
  });

  it('400s a page token the feed rejects', async () => {
    signIn('staff-1', 'superadmin');
    mockLoadActivityPage.mockRejectedValue(new InvalidPageTokenError());

    const { res, body } = await list('?page_token=junk');

    expect(res.status).toBe(400);
    expect(body.errors['query.page_token']).toBeDefined();
  });

  it('round-trips the page token and passes an empty page through', async () => {
    signIn('staff-1', 'superadmin');
    mockLoadActivityPage
      .mockResolvedValueOnce({ rows: [row('change:a', { type: 'machine', id: 'm1' })], nextPageToken: 'tok1' })
      .mockResolvedValueOnce({ rows: [], nextPageToken: 'tok2' });

    const first = await list('?page_size=2');
    expect(first.body.rows).toHaveLength(1);
    expect(first.body.nextPageToken).toBe('tok1');
    expect(first.body.next_page_token).toBe('tok1');

    const second = await list('?page_size=2&page_token=tok1');
    expect(mockLoadActivityPage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ pageSize: 2, pageToken: 'tok1' }),
    );
    expect(second.body.rows).toEqual([]);
    expect(second.body.nextPageToken).toBe('tok2');
  });

  it('labels user actors with email, else display name, in one getAll', async () => {
    signIn('staff-1', 'superadmin');
    docs.set('users/u1', { email: 'one@example.com', displayName: 'One' });
    docs.set('users/u2', { displayName: 'Two' });
    mockLoadActivityPage.mockResolvedValue({
      rows: [
        row('change:a', { type: 'user', id: 'u1' }),
        row('change:b', { type: 'user', id: 'u2' }),
        row('change:c', { type: 'user', id: 'u1' }),
        row('change:d', { type: 'user', id: 'gone' }),
        row('change:e', { type: 'machine', id: 'm1' }),
      ],
      nextPageToken: '',
    });

    const { body } = await list();

    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'users/u1' }),
      expect.objectContaining({ path: 'users/u2' }),
      expect.objectContaining({ path: 'users/gone' }),
    );
    const labels = body.rows.map((r: { actor: { label?: string } }) => r.actor.label);
    expect(labels).toEqual(['one@example.com', 'Two', 'one@example.com', undefined, undefined]);
  });

  it('labels a subject in the same getAll as the actors', async () => {
    signIn('staff-1', 'superadmin');
    docs.set('users/u1', { email: 'one@example.com' });
    docs.set('users/v1', { email: 'viewer@example.com' });
    mockLoadActivityPage.mockResolvedValue({
      rows: [
        row('decision:a', { type: 'system', id: 'swoop_host' }, { subject: { type: 'user', id: 'v1' } }),
        row('change:b', { type: 'user', id: 'u1' }),
      ],
      nextPageToken: '',
    });

    const { body } = await list();

    expect(mockGetAll).toHaveBeenCalledTimes(1);
    expect(mockGetAll).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'users/v1' }),
      expect.objectContaining({ path: 'users/u1' }),
    );
    expect(body.rows[0].subject.label).toBe('viewer@example.com');
    expect(body.rows[0].actor.label).toBeUndefined();
  });

  it('skips getAll when the page has no user actors', async () => {
    signIn('staff-1', 'superadmin');
    mockLoadActivityPage.mockResolvedValue({
      rows: [row('change:a', { type: 'machine', id: 'm1' })],
      nextPageToken: '',
    });

    await list();

    expect(mockGetAll).not.toHaveBeenCalled();
  });
});
