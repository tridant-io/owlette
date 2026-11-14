/**
 * @jest-environment node
 *
 * GET /api/admin/issues/{id}/files/{n} — superadmin only, through the real
 * platform gate (its role read is the stubbed Firestore below); an API key also
 * needs issue=*:read. One file of a dashboard issue by its 1-based index, with
 * a blocking global audit row before every redirect, and 404/410 for missing
 * or expired files.
 */

import { Timestamp } from 'firebase-admin/firestore';
import type { ApiKeyScope } from '@/lib/apiKeyTypes';
import { createMockRequest } from './helpers/utils';

const mockResolveAuth = jest.fn();
const mockAudit = jest.fn();
const mockHead = jest.fn();
const mockPresign = jest.fn();
const docs = new Map<string, Record<string, unknown>>();

function snapshot(name: string, id: string) {
  return { id, exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({ get: async () => snapshot(name, id) }),
      where: (field: string, _op: '==', value: unknown) => ({
        limit: () => ({
          get: async () => {
            const hits = [...docs.keys()]
              .filter((path) => path.startsWith(`${name}/`) && docs.get(path)?.[field] === value)
              .map((path) => snapshot(name, path.slice(name.length + 1)));
            return { empty: hits.length === 0, docs: hits };
          },
        }),
      }),
    }),
  }),
}));
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  resolveAuth: (...args: unknown[]) => mockResolveAuth(...args),
}));
jest.mock('@/lib/auditLog.server', () => ({
  ...jest.requireActual('@/lib/auditLog.server'),
  writeGlobalAuditEntryBlocking: (...args: unknown[]) => mockAudit(...args),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));
jest.mock('@/lib/issueLogsStorage.server', () => ({
  headIssueLogs: (...args: unknown[]) => mockHead(...args),
  presignIssueLogsDownload: (...args: unknown[]) => mockPresign(...args),
}));

import { GET } from '@/app/api/admin/issues/[id]/files/[n]/route';

const ISSUE = 'report-1';
const PNG = 'issues/web/u1/0b5c1f2e-8a6d-4c3e-9f1a-2b3c4d5e6f70.png';
const MP4 = 'issues/web/u1/1c6d2f3e-9b7e-4d4f-8a2b-3c4d5e6f7a81.mp4';
const DAY = 24 * 60 * 60 * 1000;

function signIn(uid: string, role: string) {
  docs.set(`users/${uid}`, { role });
  mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });
}

function signInWithKey(uid: string, scopes: ApiKeyScope[]) {
  docs.set(`users/${uid}`, { role: 'superadmin' });
  mockResolveAuth.mockResolvedValue({
    userId: uid,
    keyContext: { keyId: 'key-1', scopes, environment: 'live', expiresAt: null, isLegacy: false },
  });
}

function seedIssue(expiresInMs = 10 * DAY, extra: Record<string, unknown> = {}) {
  docs.set(`bug_reports/${ISSUE}`, {
    source: 'web',
    siteId: null,
    machineId: null,
    number: 42,
    files: [
      { key: PNG, ext: 'png', kind: 'screenshot', size: 2048 },
      { key: MP4, ext: 'mp4', kind: 'video', size: 4096 },
    ],
    filesExpireAt: Timestamp.fromMillis(Date.now() + expiresInMs),
    ...extra,
  });
}

function download(n = '1', id = ISSUE) {
  return GET(
    createMockRequest(`http://localhost/api/admin/issues/${id}/files/${n}`),
    { params: Promise.resolve({ id, n }) },
  );
}

beforeEach(() => {
  docs.clear();
  mockResolveAuth.mockReset();
  mockAudit.mockReset();
  mockHead.mockReset();
  mockPresign.mockReset();
  mockAudit.mockResolvedValue(undefined);
  mockHead.mockResolvedValue({ size: 2048 });
  mockPresign.mockImplementation(async (key: string, filename: string) => `https://r2.example/${key}?name=${filename}`);
});

describe('GET /api/admin/issues/{id}/files/{n}', () => {
  it('redirects a superadmin to the presigned download, named after the issue number and the index', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await download('2');

    expect(res.status).toBe(302);
    expect(mockHead).toHaveBeenCalledWith(MP4);
    expect(mockPresign).toHaveBeenCalledWith(MP4, 'owlette-issue-42-2.mp4');
    expect(res.headers.get('location')).toBe(`https://r2.example/${MP4}?name=owlette-issue-42-2.mp4`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('names the file after the doc id when the issue has no number', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(10 * DAY, { number: undefined });
    await download('1');
    expect(mockPresign).toHaveBeenCalledWith(PNG, `owlette-issue-${ISSUE}-1.png`);
  });

  it('writes one global allow row naming the actor, the issue and the file, before minting the url', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockAudit.mockImplementation(async () => {
      expect(mockPresign).not.toHaveBeenCalled();
    });
    await download('1');

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor: { type: 'user', userId: 'staff-1', role: 'superadmin' },
      target: { kind: 'issue', id: ISSUE },
      outcome: 'allow',
      metadata: { action: 'issue_file_download', issueId: ISSUE, file: 1, kind: 'screenshot' },
    });
  });

  it('refuses to mint a url when the audit row cannot be written', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockAudit.mockRejectedValue(new Error('firestore down'));
    const res = await download();

    expect(res.status).toBe(503);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('resolves an issue by its number, auditing it under its doc id', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await download('1', '42');

    expect(res.status).toBe(302);
    expect(mockPresign).toHaveBeenCalledWith(PNG, 'owlette-issue-42-1.png');
    expect(mockAudit.mock.calls[0][0].metadata.issueId).toBe(ISSUE);
  });

  it('lets a superadmin API key with issue=*:read download, auditing the key', async () => {
    signInWithKey('staff-1', [{ resource: 'issue', id: '*', permissions: ['read'] }]);
    seedIssue();
    const res = await download();

    expect(res.status).toBe(302);
    expect(mockAudit.mock.calls[0][0].actor).toMatchObject({ userId: 'staff-1', apiKeyId: 'key-1' });
  });

  it('403s a superadmin API key with only user=*:admin, before reading the issue', async () => {
    signInWithKey('staff-1', [{ resource: 'user', id: '*', permissions: ['admin'] }]);
    seedIssue();
    const res = await download();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('scope_insufficient');
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member'])('403s a global %s, before reading the issue', async (role) => {
    signIn(`user-${role}`, role);
    seedIssue();
    const res = await download();

    expect(res.status).toBe(403);
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('400s a superadmin with a malformed id', async () => {
    signIn('staff-1', 'superadmin');
    expect((await download('1', 'bad.id')).status).toBe(400);
  });

  it.each(['0', '3', '-1', '1.5', 'x', '01', '9999999999'])('404s file index %p', async (n) => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    expect((await download(n)).status).toBe(404);
    expect(mockHead).not.toHaveBeenCalled();
  });

  it('404s an issue that does not exist', async () => {
    signIn('staff-1', 'superadmin');
    expect((await download('1', 'no-such-issue')).status).toBe(404);
  });

  it('404s an agent issue, whose attachments are one zip', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(10 * DAY, { files: undefined, logs: { key: 'issues/s/m/x.zip' } });
    expect((await download('1')).status).toBe(404);
  });

  it('404s a malformed stored entry but still serves the one after it at its own index', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(10 * DAY, {
      files: [{ key: PNG, ext: 'gif', kind: 'screenshot', size: 1 }, { key: MP4, ext: 'mp4', kind: 'video', size: 4096 }],
    });
    expect((await download('1')).status).toBe(404);
    expect((await download('2')).status).toBe(302);
    expect(mockPresign).toHaveBeenCalledWith(MP4, 'owlette-issue-42-2.mp4');
  });

  it('410s files past their expiry, without an audit row', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(-DAY);
    const res = await download();

    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('issue_attachment_expired');
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('410s a file the bucket no longer holds', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockHead.mockResolvedValue(null);
    const res = await download();

    expect(res.status).toBe(410);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockPresign).not.toHaveBeenCalled();
  });
});
