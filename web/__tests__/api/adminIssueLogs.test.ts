/**
 * @jest-environment node
 *
 * GET /api/admin/issues/{id}/logs — superadmin only, through the real platform
 * gate (its role read is the stubbed Firestore below), with a global audit row and
 * a customer-facing site audit row before every redirect, and 404/410 for
 * missing or expired logs.
 */

import { Timestamp } from 'firebase-admin/firestore';
import { createMockRequest } from './helpers/utils';

const mockResolveAuth = jest.fn();
const mockAudit = jest.fn();
const mockSiteAudit = jest.fn();
const mockHead = jest.fn();
const mockPresign = jest.fn();
const docs = new Map<string, Record<string, unknown>>();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: docs.has(`${name}/${id}`),
          data: () => docs.get(`${name}/${id}`),
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
  writeAuditEntryBlocking: (...args: unknown[]) => mockSiteAudit(...args),
}));
jest.mock('@/lib/issueLogsStorage.server', () => ({
  headIssueLogs: (...args: unknown[]) => mockHead(...args),
  presignIssueLogsDownload: (...args: unknown[]) => mockPresign(...args),
}));

import { GET } from '@/app/api/admin/issues/[id]/logs/route';

const ISSUE = 'report-1';
const KEY = 'issues/site-1/machine-a/0b5c1f2e-8a6d-4c3e-9f1a-2b3c4d5e6f70.zip';
const DAY = 24 * 60 * 60 * 1000;

function signIn(uid: string, role: string) {
  docs.set(`users/${uid}`, { role });
  mockResolveAuth.mockResolvedValue({ userId: uid, keyContext: null });
}

function seedIssue(expiresInMs = 10 * DAY, extra: Record<string, unknown> = {}) {
  docs.set(`bug_reports/${ISSUE}`, {
    source: 'agent',
    siteId: 'site-1',
    machineId: 'machine-a',
    pageUrl: 'agent://KIOSK-01',
    logs: { key: KEY, size: 2048, expiresAt: Timestamp.fromMillis(Date.now() + expiresInMs) },
    ...extra,
  });
}

function download(id = ISSUE) {
  return GET(
    createMockRequest(`http://localhost/api/admin/issues/${id}/logs`),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  docs.clear();
  mockResolveAuth.mockReset();
  mockAudit.mockReset();
  mockSiteAudit.mockReset();
  mockHead.mockReset();
  mockPresign.mockReset();
  mockAudit.mockResolvedValue(undefined);
  mockSiteAudit.mockResolvedValue(undefined);
  mockHead.mockResolvedValue({ size: 2048 });
  mockPresign.mockImplementation(async (key: string, filename: string) => `https://r2.example/${key}?name=${filename}`);
});

describe('GET /api/admin/issues/{id}/logs', () => {
  it('redirects a superadmin to the presigned download, named after the machine and the day', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    const res = await download();

    expect(res.status).toBe(302);
    const day = new Date().toISOString().slice(0, 10);
    expect(mockPresign).toHaveBeenCalledWith(KEY, `owlette-issue-KIOSK-01-${day}.zip`);
    expect(res.headers.get('location')).toBe(`https://r2.example/${KEY}?name=owlette-issue-KIOSK-01-${day}.zip`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('writes one allow audit row naming the actor and the issue, before minting the url', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockAudit.mockImplementation(async () => {
      expect(mockPresign).not.toHaveBeenCalled();
    });
    await download();

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor: { type: 'user', userId: 'staff-1', role: 'superadmin' },
      target: { kind: 'machine', id: 'machine-a' },
      outcome: 'allow',
      metadata: { issueId: ISSUE, siteId: 'site-1', action: 'issue_logs_download' },
    });
  });

  it('writes a site audit row the customer can read, naming owlette support and not the staff member', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockSiteAudit.mockImplementation(async () => {
      expect(mockPresign).not.toHaveBeenCalled();
    });
    await download();

    expect(mockSiteAudit).toHaveBeenCalledTimes(1);
    const [siteId, row] = mockSiteAudit.mock.calls[0];
    expect(siteId).toBe('site-1');
    expect(row).toMatchObject({
      correlationId: mockAudit.mock.calls[0][0].correlationId,
      actor: { type: 'system', name: 'owlette_support' },
      target: { kind: 'machine', id: 'machine-a', machineId: 'machine-a' },
      outcome: 'allow',
      metadata: { action: 'issue_logs_download', issueId: ISSUE, machineName: 'KIOSK-01' },
    });
    expect(JSON.stringify(row)).not.toContain('staff-1');
  });

  it('writes only the global row for an issue with no site', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(10 * DAY, { siteId: undefined });
    const res = await download();

    expect(res.status).toBe(302);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockSiteAudit).not.toHaveBeenCalled();
  });

  it('refuses to mint a url when the site audit row cannot be written', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockSiteAudit.mockRejectedValue(new Error('firestore down'));
    const res = await download();

    expect(res.status).toBe(503);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it('refuses to mint a url when the audit row cannot be written', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockAudit.mockRejectedValue(new Error('firestore down'));
    const res = await download();

    expect(res.status).toBe(503);
    expect(mockPresign).not.toHaveBeenCalled();
  });

  it.each(['admin', 'member'])('403s a global %s, before reading the issue', async (role) => {
    signIn(`user-${role}`, role);
    seedIssue();
    const res = await download();

    expect(res.status).toBe(403);
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockSiteAudit).not.toHaveBeenCalled();
  });

  it('403s a non-superadmin before validating the id', async () => {
    signIn('user-member', 'member');
    expect((await download('bad.id')).status).toBe(403);
  });

  it('400s a superadmin with a malformed id', async () => {
    signIn('staff-1', 'superadmin');
    expect((await download('bad.id')).status).toBe(400);
  });

  it('404s an issue that does not exist', async () => {
    signIn('staff-1', 'superadmin');
    expect((await download('no-such-issue')).status).toBe(404);
  });

  it('404s an issue with no logs attached', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(10 * DAY, { logs: undefined });
    expect((await download()).status).toBe(404);
  });

  it('410s logs past their expiry, without an audit row', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(-DAY);
    const res = await download();

    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe('issue_logs_expired');
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('410s logs the bucket no longer holds', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue();
    mockHead.mockResolvedValue(null);
    expect((await download()).status).toBe(410);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('names the file for an unknown machine when the issue has no agent url', async () => {
    signIn('staff-1', 'superadmin');
    seedIssue(10 * DAY, { pageUrl: '' });
    await download();
    expect(mockPresign.mock.calls[0][1]).toMatch(/^owlette-issue-machine-\d{4}-\d{2}-\d{2}\.zip$/);
  });
});
