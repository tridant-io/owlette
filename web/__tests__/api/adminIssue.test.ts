/**
 * @jest-environment node
 *
 * GET/PATCH /api/admin/issues/{id}: through the real platform gates (their role
 * read is the stubbed Firestore below). GET by number and by doc id, 404, each
 * triage status, body validation, the `issue=*:write` scope, and the blocking
 * global audit row a PATCH writes.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createMockRequest } from './helpers/utils';

const mockResolveAuth = jest.fn();
const docs = new Map<string, Record<string, unknown>>();
const auditRows: Array<Record<string, unknown>> = [];

function docRef(path: string): Record<string, unknown> {
  const id = path.split('/').pop() as string;
  const ref: Record<string, unknown> = {
    id,
    collection: (sub: string) => collectionRef(`${path}/${sub}`),
    get: async () => ({
      id,
      ref,
      exists: docs.has(path),
      data: () => docs.get(path),
    }),
    set: async (data: Record<string, unknown>) => {
      if (path.startsWith('global/audit_log/entries/')) auditRows.push(data);
      docs.set(path, data);
    },
    update: async (data: Record<string, unknown>) => {
      const resolved = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v instanceof FieldValue ? Timestamp.now() : v]),
      );
      docs.set(path, { ...docs.get(path), ...resolved });
    },
  };
  return ref;
}

let autoId = 0;
function collectionRef(path: string): Record<string, unknown> {
  return {
    doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++autoId}`}`),
    where: (field: string, _op: string, value: unknown) => ({
      limit: () => ({
        get: async () => {
          const matches = [...docs.entries()]
            .filter(([p, d]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1 && d[field] === value)
            .map(([p]) => p);
          const snaps = await Promise.all(matches.slice(0, 1).map((p) => (docRef(p).get as () => Promise<unknown>)()));
          return { empty: snaps.length === 0, docs: snaps };
        },
      }),
    }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: (name: string) => collectionRef(name) }),
}));
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...args: unknown[]) => mockResolveAuth(...args),
  auditApiKeyUse: () => {},
}));
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: async () => ({ capability_enforcement: true, rate_limit_enforcement: true, lastUpdated: 0, expiresAt: 0 }),
  },
}));
jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: async () => ({ ok: true }),
  rateLimitHeaders: () => ({}),
}));

import { GET, PATCH } from '@/app/api/admin/issues/[id]/route';

const ISSUE = 'report-1';

function signIn(uid: string, role: string, scopes?: string[]) {
  docs.set(`users/${uid}`, { role });
  mockResolveAuth.mockResolvedValue({
    userId: uid,
    keyContext: scopes
      ? {
          keyId: 'key-1',
          environment: 'live',
          expiresAt: Date.now() + 60_000,
          isLegacy: false,
          scopes: scopes.map((s) => {
            const [resource, rest] = s.split('=');
            const [id, permission] = rest.split(':');
            return { resource, id, permissions: [permission] };
          }),
        }
      : null,
  });
}

function seedIssue(extra: Record<string, unknown> = {}) {
  docs.set(`bug_reports/${ISSUE}`, {
    number: 42,
    source: 'agent',
    category: 'bug',
    title: 'it broke',
    description: 'it broke when i pressed go',
    userEmail: 'user@example.com',
    pageUrl: 'agent://KIOSK-01',
    createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 15)),
    ...extra,
  });
}

function read(id: string) {
  return GET(createMockRequest(`http://localhost/api/admin/issues/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function patch(id: string, body: Record<string, unknown>) {
  return PATCH(createMockRequest(`http://localhost/api/admin/issues/${id}`, { method: 'PATCH', body }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  docs.clear();
  auditRows.length = 0;
  mockResolveAuth.mockReset();
});

describe('GET /api/admin/issues/{id}', () => {
  it('reads an issue by its number', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await read('42');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: ISSUE,
      number: 42,
      status: 'new',
      title: 'it broke',
      from: 'user@example.com',
      host: 'KIOSK-01',
      description: { text: 'it broke when i pressed go' },
    });
  });

  it('reads an issue by its doc id', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await read(ISSUE);

    expect(res.status).toBe(200);
    expect((await res.json()).number).toBe(42);
  });

  it('404s an issue that does not exist', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    expect((await read('43')).status).toBe(404);
    expect((await read('missing')).status).toBe(404);
  });

  it('refuses a user who is not a superadmin', async () => {
    signIn('user-1', 'user');
    seedIssue();
    expect((await read('42')).status).toBe(403);
  });

  it('lets an API key with issue=*:read read', async () => {
    signIn('staff-1', 'superadmin', ['issue=*:read']);
    seedIssue();
    expect((await read('42')).status).toBe(200);
  });
});

describe('PATCH /api/admin/issues/{id}', () => {
  it.each(['new', 'triaged', 'fixed', 'wontfix'])('sets status %s and records who and when', async (status) => {
    signIn('staff-1', 'superadmin');
    seedIssue({ status: 'triaged' });
    const res = await patch('42', { status });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: ISSUE, number: 42, status, statusUpdatedBy: 'staff-1' });
    expect(typeof body.statusUpdatedAt).toBe('string');
    expect(docs.get(`bug_reports/${ISSUE}`)).toMatchObject({ status, statusUpdatedBy: 'staff-1' });
  });

  it('stores the note trimmed, by doc id', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await patch(ISSUE, { status: 'fixed', note: '  fixed in 4.1.14  ' });

    expect(res.status).toBe(200);
    expect((await res.json()).triageNote).toBe('fixed in 4.1.14');
  });

  it('leaves an existing note alone when no note is given', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue({ triageNote: 'see #12' });
    const res = await patch('42', { status: 'fixed' });

    expect((await res.json()).triageNote).toBe('see #12');
  });

  it('writes a blocking global audit row naming the issue', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    await patch('42', { status: 'triaged' });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor: { type: 'user', userId: 'staff-1', role: 'superadmin' },
      target: { kind: 'issue', id: '42' },
      outcome: 'allow',
    });
  });

  it('400s an unknown status', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await patch('42', { status: 'closed' });

    expect(res.status).toBe(400);
    expect(docs.get(`bug_reports/${ISSUE}`)?.status).toBeUndefined();
  });

  it('400s a note over 2000 characters', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    expect((await patch('42', { status: 'triaged', note: 'x'.repeat(2001) })).status).toBe(400);
    expect((await patch('42', { status: 'triaged', note: 7 })).status).toBe(400);
    expect((await patch('42', { status: 'triaged', note: 'x'.repeat(2000) })).status).toBe(200);
  });

  it('404s an issue that does not exist', async () => {
    signIn('staff-1', 'superadmin');
    expect((await patch('42', { status: 'fixed' })).status).toBe(404);
  });

  it('refuses an API key that holds only issue=*:read', async () => {
    signIn('staff-1', 'superadmin', ['issue=*:read']);
    seedIssue();
    const res = await patch('42', { status: 'fixed' });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
    expect(docs.get(`bug_reports/${ISSUE}`)?.status).toBeUndefined();
  });

  it('lets an API key with issue=*:write set a status', async () => {
    signIn('staff-1', 'superadmin', ['issue=*:write']);
    seedIssue();
    expect((await patch('42', { status: 'fixed' })).status).toBe(200);
  });

  it('refuses a user who is not a superadmin', async () => {
    signIn('user-1', 'user');
    seedIssue();
    expect((await patch('42', { status: 'fixed' })).status).toBe(403);
  });
});
