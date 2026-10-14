/**
 * @jest-environment node
 *
 * POST /api/bug-report — an agent is known by its token's claims, its issue
 * records the site and machine, and a logsKey is accepted only from that
 * machine's agent, under its own prefix, for an object that exists.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { createMockRequest } from './helpers/utils';

const mockVerifyIdToken = jest.fn();
const mockRequireSession = jest.fn();
const mockHead = jest.fn();
const mockSend = jest.fn();
const written: { id: string; data: Record<string, unknown> }[] = [];

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
    getUser: async (uid: string) => ({ uid, email: `${uid}@example.test` }),
  }),
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        id: 'report-1',
        set: async (data: Record<string, unknown>) => {
          written.push({ id: 'report-1', data });
        },
      }),
    }),
  }),
}));
jest.mock('@/lib/apiAuth.server', () => ({
  ...jest.requireActual('@/lib/apiAuth.server'),
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));
jest.mock('@/lib/withRateLimit', () => ({ withRateLimit: (h: unknown) => h }));
jest.mock('@/lib/resendClient.server', () => ({
  ...jest.requireActual('@/lib/resendClient.server'),
  getResend: () => ({ emails: { send: (...args: unknown[]) => mockSend(...args) } }),
}));
jest.mock('@/lib/issueLogsStorage.server', () => ({
  ...jest.requireActual('@/lib/issueLogsStorage.server'),
  headIssueLogs: (...args: unknown[]) => mockHead(...args),
}));

const SITE = 'site-1';
const MACHINE = 'machine-a';
const KEY = `issues/${SITE}/${MACHINE}/0b5c1f2e-8a6d-4c3e-9f1a-2b3c4d5e6f70.zip`;

let POST: (req: NextRequest) => Promise<NextResponse>;

beforeAll(async () => {
  // read once at module load, so set before the route is imported
  process.env.ADMIN_EMAIL_DEV = 'support@example.test';
  ({ POST } = await import('@/app/api/bug-report/route'));
});

beforeEach(() => {
  written.length = 0;
  mockVerifyIdToken.mockReset();
  mockRequireSession.mockReset();
  mockHead.mockReset();
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  mockRequireSession.mockRejectedValue(new Error('no session'));
  mockHead.mockResolvedValue({ size: 2048 });
});

function asAgent(machineId = MACHINE, siteId = SITE) {
  mockVerifyIdToken.mockResolvedValue({ uid: `agent-${machineId}`, role: 'agent', site_id: siteId, machine_id: machineId });
}

function report(extra: Record<string, unknown> = {}, headers: Record<string, string> = { Authorization: 'Bearer agent-token' }) {
  return POST(
    createMockRequest('http://localhost/api/bug-report', {
      method: 'POST',
      headers,
      body: {
        title: 'the service stopped',
        category: 'bug',
        description: 'it stopped after the update',
        browserUA: 'Owlette Agent 4.1.12',
        pageUrl: 'agent://KIOSK-01',
        ...extra,
      },
    }),
  );
}

describe('POST /api/bug-report', () => {
  it("records an agent's site and machine from its claims, as source agent", async () => {
    asAgent();
    const res = await report();

    expect(res.status).toBe(200);
    expect(written).toHaveLength(1);
    expect(written[0].data).toMatchObject({ source: 'agent', siteId: SITE, machineId: MACHINE });
    expect(written[0].data).not.toHaveProperty('logs');
    expect(mockHead).not.toHaveBeenCalled();
  });

  it('calls a session user web whatever browserUA claims, with no site or machine', async () => {
    mockRequireSession.mockResolvedValue('user-1');
    const res = await report({}, {});

    expect(res.status).toBe(200);
    expect(written[0].data).toMatchObject({ source: 'web', siteId: null, machineId: null, userEmail: 'user-1@example.test' });
  });

  it('stores a valid logsKey with its size and a 30 day expiry, and links it in the email', async () => {
    asAgent();
    const before = Date.now();
    const res = await report({ logsKey: KEY });

    expect(res.status).toBe(200);
    expect(mockHead).toHaveBeenCalledWith(KEY);
    const logs = written[0].data.logs as { key: string; size: number; expiresAt: Timestamp };
    expect(logs.key).toBe(KEY);
    expect(logs.size).toBe(2048);
    expect(logs.expiresAt).toBeInstanceOf(Timestamp);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(logs.expiresAt.toMillis()).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(logs.expiresAt.toMillis()).toBeLessThanOrEqual(Date.now() + thirtyDays);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const { html } = mockSend.mock.calls[0][0] as { html: string };
    expect(html).toContain('/api/admin/issues/report-1/logs');
    expect(html).toContain('download logs');
  });

  it('sends no logs link when nothing is attached', async () => {
    asAgent();
    await report();
    const { html } = mockSend.mock.calls[0][0] as { html: string };
    expect(html).not.toContain('/api/admin/issues/');
  });

  describe('recipient', () => {
    afterEach(() => {
      delete process.env.ISSUE_EMAIL;
    });

    it('mails ISSUE_EMAIL when it is set', async () => {
      process.env.ISSUE_EMAIL = 'issues@example.test';
      asAgent();
      await report();
      expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'issues@example.test' });
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])('falls back to ADMIN_EMAIL_* when ISSUE_EMAIL is %s', async (_label, value) => {
      if (value !== undefined) process.env.ISSUE_EMAIL = value;
      asAgent();
      await report();
      expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'support@example.test' });
    });
  });

  it.each([
    ['another machine', `issues/${SITE}/machine-b/0b5c1f2e-8a6d-4c3e-9f1a-2b3c4d5e6f70.zip`],
    ['another site', `issues/site-2/${MACHINE}/0b5c1f2e-8a6d-4c3e-9f1a-2b3c4d5e6f70.zip`],
    ['a nested path', `issues/${SITE}/${MACHINE}/x/../y.zip`],
    ['not a zip', `issues/${SITE}/${MACHINE}/0b5c1f2e.txt`],
    ['not a string', 42],
  ])('400s a logsKey for %s, before any lookup', async (_label, logsKey) => {
    asAgent();
    const res = await report({ logsKey });
    expect(res.status).toBe(400);
    expect(mockHead).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it('400s a logsKey from a user session, even one under a real prefix', async () => {
    mockRequireSession.mockResolvedValue('user-1');
    const res = await report({ logsKey: KEY }, {});
    expect(res.status).toBe(400);
    expect(mockHead).not.toHaveBeenCalled();
    expect(written).toHaveLength(0);
  });

  it('400s a logsKey from a non-agent id token', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'user-1', site_id: SITE, machine_id: MACHINE });
    expect((await report({ logsKey: KEY })).status).toBe(400);
  });

  it('400s a logsKey nothing was uploaded under', async () => {
    asAgent();
    mockHead.mockResolvedValue(null);
    expect((await report({ logsKey: KEY })).status).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('400s when storage cannot be checked, so the agent resends without logs', async () => {
    asAgent();
    mockHead.mockRejectedValue(new Error('r2 down'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await report({ logsKey: KEY })).status).toBe(400);
    expect(written).toHaveLength(0);
    quiet.mockRestore();
  });
});
