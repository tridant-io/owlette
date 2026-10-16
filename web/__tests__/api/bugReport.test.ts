/**
 * @jest-environment node
 *
 * POST /api/bug-report — an agent is known by its token's claims, its issue
 * records the site and machine, and a logsKey is accepted only from that
 * machine's agent, under its own prefix, for an object that exists. Each issue
 * is numbered from `counters/bug_reports` in the transaction that writes it.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { createMockRequest } from './helpers/utils';

const mockVerifyIdToken = jest.fn();
const mockRequireSession = jest.fn();
const mockHead = jest.fn();
const mockSend = jest.fn();
const written: { id: string; data: Record<string, unknown> }[] = [];
const counter: { next?: number } = {};
let docSeq = 0;

type Ref = { id: string; path: string };
const COUNTER_PATH = 'counters/bug_reports';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
    getUser: async (uid: string) => ({ uid, email: `${uid}@example.test` }),
  }),
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id?: string): Ref => {
        const docId = id ?? `report-${++docSeq}`;
        return { id: docId, path: `${name}/${docId}` };
      },
    }),
    // writes apply only once the callback resolves, as a committed transaction's do
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const sets: { ref: Ref; data: Record<string, unknown> }[] = [];
      const result = await fn({
        get: async (ref: Ref) => ({
          data: () => (ref.path === COUNTER_PATH && counter.next !== undefined ? { ...counter } : undefined),
        }),
        set: (ref: Ref, data: Record<string, unknown>) => {
          sets.push({ ref, data });
        },
      });
      for (const { ref, data } of sets) {
        if (ref.path === COUNTER_PATH) Object.assign(counter, data);
        else written.push({ id: ref.id, data });
      }
      return result;
    },
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
  delete counter.next;
  docSeq = 0;
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
        browserUA: 'Owlette Agent v4.1.12 / Windows 11',
        pageUrl: 'agent://KIOSK-01',
        ...extra,
      },
    }),
  );
}

function sent(): { subject: string; html: string } {
  return mockSend.mock.calls[0][0] as { subject: string; html: string };
}

// the email's "attached" fact, as its value cell renders it
const attached = (summary: string) => `>${summary}</span>`;

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

  describe('numbering', () => {
    it('numbers the issue from the counter, in the write, the response and the email', async () => {
      counter.next = 41;
      asAgent();
      const res = await report();

      expect(await res.json()).toEqual({ success: true, id: 'report-1', number: 42 });
      expect(written[0].data).toMatchObject({ number: 42 });
      expect(counter.next).toBe(42);
      const { subject, html } = sent();
      expect(subject).toBe('[DEVELOPMENT] issue #42 · something broke — the service stopped');
      expect(html).toContain('/admin/issues/42"');
      expect(html).toContain('open issue #42');
    });

    it('starts at 1 when no counter exists', async () => {
      asAgent();
      const res = await report();

      expect((await res.json()).number).toBe(1);
      expect(written[0].data.number).toBe(1);
      expect(counter.next).toBe(1);
    });

    it('gives two sequential issues N and N+1', async () => {
      counter.next = 7;
      asAgent();
      const first = await (await report()).json();
      const second = await (await report()).json();

      expect([first.number, second.number]).toEqual([8, 9]);
      expect(written.map((w) => [w.id, w.data.number])).toEqual([['report-1', 8], ['report-2', 9]]);
      expect(counter.next).toBe(9);
    });

    it('writes nothing and sends no email when the request is refused', async () => {
      counter.next = 3;
      asAgent();
      expect((await report({ title: '' })).status).toBe(400);
      expect(written).toHaveLength(0);
      expect(counter.next).toBe(3);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('email', () => {
    const description = [
      'it stopped after the update',
      'screenshots attached: 2',
      '--- system info ---\n  hostname: KIOSK-01',
      '--- recent logs (last ~100 lines) ---\n2026-10-15 ERROR boom',
    ].join('\n\n');

    it("carries the user's words only, never the system info or log tail", async () => {
      asAgent();
      await report({ description });

      const { html } = sent();
      expect(html).toContain('it stopped after the update');
      expect(html).not.toContain('--- system info ---');
      expect(html).not.toContain('hostname: KIOSK-01');
      expect(html).not.toContain('recent logs');
      expect(html).not.toContain('ERROR boom');
      expect(html).not.toContain('screenshots attached');
      // the record keeps the description whole
      expect(written[0].data.description).toBe(description);
    });

    it('names an agent by its host and version, never its user agent', async () => {
      asAgent();
      await report();

      const { html } = sent();
      expect(html).toContain('>owlette agent on KIOSK-01</span>');
      expect(html).toContain('>KIOSK-01</span>');
      expect(html).toContain('>desktop app · 4.1.12</span>');
      expect(html).toContain(`>${SITE}</span>`);
      expect(html).not.toContain('Owlette Agent v');
    });

    it('names an agent without a host plainly', async () => {
      asAgent();
      await report({ pageUrl: '' });

      expect(sent().html).toContain('>owlette agent</span>');
    });

    it('stores the app version and user agent as before', async () => {
      asAgent();
      await report();
      expect(written[0].data.appVersion).toBe(process.env.NEXT_PUBLIC_APP_VERSION ?? null);
      expect(written[0].data.browserUA).toBe('Owlette Agent v4.1.12 / Windows 11');
    });

    it('names a web user by their email', async () => {
      mockRequireSession.mockResolvedValue('user-1');
      await report({ pageUrl: 'https://owlette.app/dashboard' }, {});

      const { html } = sent();
      expect(html).toContain('>user-1@example.test</span>');
      expect(html).not.toContain('>machine</td>');
    });

    it('answers success when the email fails to send', async () => {
      asAgent();
      mockSend.mockRejectedValue(new Error('resend down'));
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await report();
      await new Promise((resolve) => setImmediate(resolve));

      expect(res.status).toBe(200);
      expect(written).toHaveLength(1);
      quiet.mockRestore();
    });
  });

  it('stores a valid logsKey with its size and a 30 day expiry, and summarises it in the email', async () => {
    asAgent();
    const before = Date.now();
    const res = await report({ logsKey: KEY });

    expect(res.status).toBe(200);
    expect(mockHead).toHaveBeenCalledWith(KEY);
    const logs = written[0].data.logs as { key: string; size: number; expiresAt: Timestamp; hasLogs: boolean };
    expect(logs.key).toBe(KEY);
    expect(logs.size).toBe(2048);
    expect(logs.hasLogs).toBe(true);
    expect(logs.expiresAt).toBeInstanceOf(Timestamp);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(logs.expiresAt.toMillis()).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(logs.expiresAt.toMillis()).toBeLessThanOrEqual(Date.now() + thirtyDays);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const { html } = sent();
    expect(html).toContain(attached('logs'));
    // the issue page holds the download; the email links only to it
    expect(html).toContain('/admin/issues/1"');
    expect(html).not.toContain('/api/admin/issues/');
    expect(logs).not.toHaveProperty('screenshots');
  });

  it.each([
    [1, true, 'logs and 1 screenshot'],
    [5, true, 'logs and 5 screenshots'],
    [1, undefined, '1 screenshot'],
    [5, undefined, '5 screenshots'],
  ])('counts %i screenshots, logs %s, on the record and in the email', async (n, logs, summary) => {
    asAgent();
    const res = await report({ logsKey: KEY, screenshots: n, logs });

    expect(res.status).toBe(200);
    const record = written[0].data.logs as { screenshots?: number; hasLogs: boolean };
    expect(record.screenshots).toBe(n);
    expect(record.hasLogs).toBe(logs === true);
    expect(sent().html).toContain(attached(summary));
  });

  it('says logs are attached when the agent sends logs without screenshots', async () => {
    asAgent();
    await report({ logsKey: KEY, logs: true });

    expect((written[0].data.logs as { hasLogs: boolean }).hasLogs).toBe(true);
    expect(sent().html).toContain(attached('logs'));
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['an object', { logs: true }],
  ])('counts no logs beside screenshots for a logs field that is %s', async (_label, logs) => {
    asAgent();
    await report({ logsKey: KEY, screenshots: 2, logs });

    expect((written[0].data.logs as { hasLogs: boolean }).hasLogs).toBe(false);
    const { html } = sent();
    expect(html).toContain(attached('2 screenshots'));
    expect(html).not.toContain('logs and');
  });

  it.each([
    [1, undefined, undefined, '1 video'],
    [3, undefined, undefined, '3 videos'],
    [20, undefined, undefined, '20 videos'],
    [1, undefined, true, 'logs and 1 video'],
    [1, 1, undefined, '1 screenshot and 1 video'],
    [2, 10, undefined, '10 screenshots and 2 videos'],
    [1, 1, true, 'logs, 1 screenshot and 1 video'],
    [2, 2, true, 'logs, 2 screenshots and 2 videos'],
  ])('names %s videos, screenshots %s, logs %s, on the record and in the email', async (videos, n, logs, summary) => {
    asAgent();
    const res = await report({ logsKey: KEY, videos, screenshots: n, logs });

    expect(res.status).toBe(200);
    const record = written[0].data.logs as { screenshots?: number; videos?: number; hasLogs: boolean };
    expect(record.videos).toBe(videos);
    expect(record.screenshots).toBe(n);
    expect(record.hasLogs).toBe(logs === true);
    expect(sent().html).toContain(attached(summary));
  });

  it.each([
    ['zero', 0],
    ['over the limit', 21],
    ['negative', -1],
    ['not an integer', 1.5],
    ['a numeric string', '1'],
    ['a boolean', true],
    ['an array', [1]],
    ['null', null],
  ])('ignores a videos field that is %s', async (_label, value) => {
    asAgent();
    const res = await report({ logsKey: KEY, videos: value });

    expect(res.status).toBe(200);
    expect(written[0].data.logs).not.toHaveProperty('videos');
    const { html } = sent();
    expect(html).toContain(attached('logs'));
    expect(html).not.toContain('video');
  });

  it('counts no video without an attached zip', async () => {
    asAgent();
    const res = await report({ videos: 1, logs: true });

    expect(res.status).toBe(200);
    expect(written[0].data).not.toHaveProperty('logs');
    expect(written[0].data).not.toHaveProperty('videos');
    expect(sent().html).not.toContain('video');
  });

  it('ignores a video from a user session', async () => {
    mockRequireSession.mockResolvedValue('user-1');
    const res = await report({ videos: 1 }, {});

    expect(res.status).toBe(200);
    expect(written[0].data).not.toHaveProperty('logs');
    expect(written[0].data).not.toHaveProperty('videos');
    expect(sent().html).not.toContain('video');
  });

  it('mentions no logs without an attached zip, whatever the logs field says', async () => {
    asAgent();
    await report({ logs: true, screenshots: 2 });

    expect(written[0].data).not.toHaveProperty('logs');
    expect(sent().html).not.toContain('>attached</td>');
  });

  it.each([
    ['zero', 0],
    ['over the limit', 11],
    ['negative', -1],
    ['not an integer', 2.5],
    ['a numeric string', '3'],
    ['a boolean', true],
    ['null', null],
  ])('ignores a screenshots field that is %s', async (_label, value) => {
    asAgent();
    const res = await report({ logsKey: KEY, screenshots: value });

    expect(res.status).toBe(200);
    expect(written[0].data.logs).not.toHaveProperty('screenshots');
    expect(sent().html).toContain(attached('logs'));
  });

  it('no longer reads the count from a description line', async () => {
    asAgent();
    await report({ logsKey: KEY, description: 'it stopped\n\nscreenshots attached: 3\n' });

    expect(written[0].data.logs).not.toHaveProperty('screenshots');
    const { html } = sent();
    expect(html).toContain(attached('logs'));
    expect(html).not.toContain('screenshot');
  });

  it('counts no screenshots without an attached zip', async () => {
    asAgent();
    await report({ screenshots: 2 });

    expect(written[0].data).not.toHaveProperty('logs');
    expect(sent().html).not.toContain('screenshot');
  });

  it('ignores screenshots from a user session', async () => {
    mockRequireSession.mockResolvedValue('user-1');
    const res = await report({ screenshots: 2 }, {});

    expect(res.status).toBe(200);
    expect(written[0].data).not.toHaveProperty('logs');
    expect(written[0].data).not.toHaveProperty('screenshots');
    expect(sent().html).not.toContain('screenshot');
  });

  it('lists no attachments when nothing is attached', async () => {
    asAgent();
    await report();
    const { html } = sent();
    expect(html).not.toContain('>attached</td>');
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
