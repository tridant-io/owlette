/**
 * @jest-environment node
 *
 * GET /api/admin/issues — superadmin only through the real platform gate (its
 * role read is the stubbed Firestore below), an `issue=*:read` scope for api
 * keys, newest first, an optional status filter, and cursor pagination.
 */

import { Timestamp } from 'firebase-admin/firestore';
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

type Data = Record<string, unknown>;
const docs = new Map<string, Data>();

function snapOf(name: string, id: string) {
  const data = docs.get(`${name}/${id}`);
  return { id, exists: data !== undefined, data: () => data };
}

function makeQuery(name: string, filters: Array<[string, unknown]>, order?: string, limit = 1000, after?: string): unknown {
  return {
    where: (field: string, _op: string, value: unknown) => makeQuery(name, [...filters, [field, value]], order, limit, after),
    orderBy: (field: string) => makeQuery(name, filters, field, limit, after),
    limit: (n: number) => makeQuery(name, filters, order, n, after),
    startAfter: (snap: { id: string }) => makeQuery(name, filters, order, limit, snap.id),
    get: async () => {
      let rows = [...docs.entries()]
        .filter(([path]) => path.startsWith(`${name}/`))
        .map(([path]) => snapOf(name, path.slice(name.length + 1)))
        .filter((s) => filters.every(([f, v]) => s.data()?.[f] === v));
      if (order) {
        const ms = (s: { data: () => Data | undefined }) => (s.data()?.[order] as Timestamp).toMillis();
        rows.sort((a, b) => ms(b) - ms(a));
      }
      if (after) rows = rows.slice(rows.findIndex((s) => s.id === after) + 1);
      return { docs: rows.slice(0, limit) };
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      ...(makeQuery(name, []) as object),
      doc: (id: string) => ({ get: async () => snapOf(name, id) }),
    }),
  }),
}));

import { GET } from '@/app/api/admin/issues/route';

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

function seedIssue(id: string, minutesAgo: number, extra: Data = {}) {
  docs.set(`bug_reports/${id}`, {
    title: `issue ${id}`,
    category: 'bug',
    source: 'web',
    description: `text of ${id}`,
    userEmail: 'user@example.com',
    status: 'new',
    createdAt: Timestamp.fromMillis(Date.now() - minutesAgo * 60_000),
    ...extra,
  });
}

async function list(query = '') {
  const res = await GET(createMockRequest(`http://localhost/api/admin/issues${query}`));
  return { res, body: await res.json() };
}

beforeEach(() => {
  docs.clear();
  mockResolveAuth.mockReset();
});

describe('GET /api/admin/issues', () => {
  it('lists issues newest first for a superadmin session, serialized', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue('old', 30, { number: 1 });
    seedIssue('new', 5, { number: 2, status: 'triaged' });

    const { res, body } = await list();

    expect(res.status).toBe(200);
    expect(body.issues.map((i: { id: string }) => i.id)).toEqual(['new', 'old']);
    expect(body.issues[0]).toMatchObject({
      id: 'new',
      number: 2,
      status: 'triaged',
      title: 'issue new',
      from: 'user@example.com',
      description: { text: 'text of new', systemInfo: '', logTail: '', notes: [] },
    });
    expect(body.nextPageToken).toBe('');
    expect(body.next_page_token).toBe('');
  });

  it('accepts an api key with issue=*:read', async () => {
    signInWithKey('staff-1', 'superadmin', [{ resource: 'issue', id: '*', permissions: ['read'] }]);
    seedIssue('a', 1);

    const { res, body } = await list();

    expect(res.status).toBe(200);
    expect(body.issues).toHaveLength(1);
  });

  it('403s scope_insufficient for a superadmin key without the issue scope', async () => {
    signInWithKey('staff-1', 'superadmin', [{ resource: 'user', id: '*', permissions: ['admin'] }]);
    seedIssue('a', 1);

    const { res, body } = await list();

    expect(res.status).toBe(403);
    expect(body.code).toBe('scope_insufficient');
  });

  it.each(['admin', 'member'])('403s a global %s, even with the issue scope', async (role) => {
    signInWithKey(`user-${role}`, role, [{ resource: 'issue', id: '*', permissions: ['read'] }]);
    seedIssue('a', 1);
    expect((await list()).res.status).toBe(403);

    signIn(`user-${role}`, role);
    expect((await list()).res.status).toBe(403);
  });

  it('403s a deleted superadmin', async () => {
    signIn('staff-1', 'superadmin');
    docs.set('users/staff-1', { role: 'superadmin', deletedAt: 1 });
    expect((await list()).res.status).toBe(403);
  });

  it('filters by status', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue('a', 3, { status: 'new' });
    seedIssue('b', 2, { status: 'fixed' });
    seedIssue('c', 1, { status: 'new' });

    const { res, body } = await list('?status=new');

    expect(res.status).toBe(200);
    expect(body.issues.map((i: { id: string }) => i.id)).toEqual(['c', 'a']);
  });

  it.each(['open', 'NEW', ''])('400s an unknown status %p', async (status) => {
    signIn('staff-1', 'superadmin');
    const { res, body } = await list(`?status=${status}`);

    expect(res.status).toBe(400);
    expect(body.errors['query.status']).toBeDefined();
  });

  it('400s a page_size over 100', async () => {
    signIn('staff-1', 'superadmin');
    expect((await list('?page_size=101')).res.status).toBe(400);
  });

  it('pages through every issue with page_token, newest first', async () => {
    signIn('staff-1', 'superadmin');
    for (let i = 1; i <= 5; i++) seedIssue(`i${i}`, i);

    const first = await list('?page_size=2');
    expect(first.body.issues.map((i: { id: string }) => i.id)).toEqual(['i1', 'i2']);
    expect(first.body.nextPageToken).toBe('i2');

    const second = await list(`?page_size=2&page_token=${first.body.nextPageToken}`);
    expect(second.body.issues.map((i: { id: string }) => i.id)).toEqual(['i3', 'i4']);
    expect(second.body.nextPageToken).toBe('i4');

    const third = await list(`?page_size=2&page_token=${second.body.nextPageToken}`);
    expect(third.body.issues.map((i: { id: string }) => i.id)).toEqual(['i5']);
    expect(third.body.nextPageToken).toBe('');
  });

  it('pages within a status filter', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue('a', 4, { status: 'new' });
    seedIssue('b', 3, { status: 'fixed' });
    seedIssue('c', 2, { status: 'new' });
    seedIssue('d', 1, { status: 'new' });

    const first = await list('?status=new&page_size=2');
    expect(first.body.issues.map((i: { id: string }) => i.id)).toEqual(['d', 'c']);

    const second = await list(`?status=new&page_size=2&page_token=${first.body.nextPageToken}`);
    expect(second.body.issues.map((i: { id: string }) => i.id)).toEqual(['a']);
    expect(second.body.nextPageToken).toBe('');
  });
});
