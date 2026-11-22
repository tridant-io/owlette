/** @jest-environment node */

import { NextRequest } from 'next/server';
import type { ActivityRow, Finding } from '@/lib/activity/types';

// Mocks (declared before importing the route)

const NOW = Date.UTC(2026, 10, 15, 17, 0, 0); // 17:00 utc, past the digest hour
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const emailSend = jest.fn();
let resendConfigured = true;
let callOrder: string[] = [];

type Stored = Finding & { detectedAt: number; emailedAt: number | null; digestedAt: number | null };
let store: Map<string, Stored>;
let state: { scannedThrough: number | null; lastDigestDay: string | null };
let feedRows: ActivityRow[];
let email: { enabled: boolean; recipients: string[] };
const loadActivitySince = jest.fn();
const getAll = jest.fn();
const historyWheres: unknown[][] = [];
// each site's queued audit events, as the collection-group scan meets them; `drained` empties
// the queue between the scan and the read of its oldest event
let auditQueued: Array<{ siteId: string; enqueuedAt: number; drained?: boolean }>;

const queueScan = () => {
  let after = '';
  const q = {
    orderBy: () => q,
    limit: () => q,
    startAfter: (cursor: string) => ((after = cursor), q),
    get: async () => {
      const next = [...auditQueued]
        .sort((a, b) => a.siteId.localeCompare(b.siteId))
        .find((queued) => `sites/${queued.siteId}/audit_queue/x` > after);
      if (!next) return { docs: [] };
      const doc = { get: () => next.enqueuedAt };
      const queue = {
        path: `sites/${next.siteId}/audit_queue`,
        parent: { id: next.siteId },
        orderBy: () => ({ limit: () => ({ get: async () => ({ docs: next.drained ? [] : [doc] }) }) }),
      };
      return { docs: [{ ...doc, ref: { parent: queue } }] };
    },
  };
  return q;
};

const chain = (get: () => Promise<unknown>) => {
  const q: Record<string, unknown> = {};
  for (const m of ['where', 'orderBy', 'limit']) q[m] = () => q;
  q.get = get;
  return q;
};

const mockDb = {
  collection: (name: string) => {
    if (name === 'global') {
      return {
        doc: () => ({
          collection: () => {
            const q = chain(async () => ({ docs: [] }));
            q.where = (...args: unknown[]) => {
              historyWheres.push(args);
              return q;
            };
            return q;
          },
        }),
      };
    }
    return chain(async () => ({ docs: [...store.values()].map((f) => ({ id: f.id, data: () => f })) }));
  },
  collectionGroup: (name: string) =>
    name === 'audit_queue' ? queueScan() : chain(async () => ({ docs: [] })),
  doc: (path: string) => ({ path }),
  getAll: (...args: unknown[]) => getAll(...args),
};

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDb }));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => (resendConfigured ? { emails: { send: emailSend } } : null),
  FROM_EMAIL: 'noreply@mail.owlette.app',
  ENV_LABEL: 'DEVELOPMENT',
  isProduction: false,
  trustedBaseUrl: () => 'https://dev.owlette.app',
}));

jest.mock('@/lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

jest.mock('@/lib/activity/feed.server', () => ({
  loadActivitySince: (...args: unknown[]) => loadActivitySince(...args),
}));

jest.mock('@/lib/activity/findings.server', () => ({
  readState: async () => ({ ...state, email }),
  writeScannedThrough: async (_db: unknown, at: number) => {
    state.scannedThrough = at;
  },
  saveNewFindings: async (_db: unknown, found: Finding[], now: number) => {
    const created: Finding[] = [];
    for (const f of found) {
      if (store.has(f.id)) continue;
      store.set(f.id, { ...f, detectedAt: now, emailedAt: null, digestedAt: null });
      created.push(f);
    }
    return created;
  },
  claimForEmail: async (_db: unknown, id: string, now: number) => {
    callOrder.push(`claim:${id}`);
    const f = store.get(id);
    if (!f || f.emailedAt != null) return false;
    f.emailedAt = now;
    return true;
  },
  claimDigest: async (_db: unknown, day: string) => {
    callOrder.push('claim-digest');
    if (state.lastDigestDay === day) return false;
    state.lastDigestDay = day;
    return true;
  },
  markDigested: async (_db: unknown, ids: string[], now: number) => {
    for (const id of ids) store.get(id)!.digestedAt = now;
  },
}));

import { GET } from '@/app/api/cron/activity-watch/route';
import logger from '@/lib/logger';

// Helpers

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/activity-watch', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

function change(id: string, action: string, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: `change:${id}`,
    kind: 'change',
    at: NOW - 5 * MIN,
    actor: { type: 'user', id: 'u1' },
    siteId: null,
    action,
    outcome: null,
    target: { id: 'u9' },
    details: {},
    ...over,
  };
}

const highRow = () => change('h1', 'user_mutated:mfa_disabled');
const digestRow = () => change('d1', 'user_mutated:soft_deleted');

describe('GET /api/cron/activity-watch', () => {
  const originalSecret = process.env.CRON_SECRET;
  const originalActivity = process.env.ACTIVITY_EMAIL;
  const originalAdmin = process.env.ADMIN_EMAIL_DEV;
  let dateNow: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    process.env.ACTIVITY_EMAIL = 'watch@example.test';
    delete process.env.ADMIN_EMAIL_DEV;
    dateNow = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    resendConfigured = true;
    callOrder = [];
    store = new Map();
    state = { scannedThrough: null, lastDigestDay: null };
    feedRows = [];
    email = { enabled: true, recipients: ['watch@example.test'] };
    loadActivitySince.mockImplementation(async () => feedRows);
    getAll.mockResolvedValue([]);
    historyWheres.length = 0;
    auditQueued = [];
    emailSend.mockImplementation(async () => {
      callOrder.push('send');
      return { error: null };
    });
  });

  afterEach(() => {
    dateNow.mockRestore();
    process.env.CRON_SECRET = originalSecret;
    if (originalActivity === undefined) delete process.env.ACTIVITY_EMAIL;
    else process.env.ACTIVITY_EMAIL = originalActivity;
    if (originalAdmin !== undefined) process.env.ADMIN_EMAIL_DEV = originalAdmin;
  });

  it('answers 401 without the cron secret and reads nothing', async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request('wrong'))).status).toBe(401);
    expect(loadActivitySince).not.toHaveBeenCalled();
  });

  it('reads a sign-in history of sign-in rows only, so other platform rows cannot crowd it out', async () => {
    feedRows = [
      {
        id: 'platform:s1',
        kind: 'sign_in',
        at: NOW - 5 * MIN,
        actor: { type: 'user', id: 'u1' },
        siteId: null,
        action: 'sign_in',
        outcome: 'allow',
        network: { key: 'asn:1', prefix: null },
        details: {},
      },
    ];

    await GET(request('cron-secret'));

    expect(historyWheres).toContainEqual(['capability', '==', 'AUTH_SIGN_IN']);
  });

  it('does not read a sign-in history for a passed second factor', async () => {
    feedRows = [
      {
        id: 'platform:s2',
        kind: 'sign_in',
        at: NOW - 5 * MIN,
        actor: { type: 'user', id: 'u1' },
        siteId: null,
        action: 'second_factor',
        outcome: 'allow',
        network: { key: 'asn:1', prefix: null },
        details: {},
      },
    ];

    await GET(request('cron-secret'));

    expect(historyWheres).toEqual([]);
  });

  it('creates one high finding and sends one email, naming the person', async () => {
    feedRows = [highRow()];
    getAll.mockResolvedValue([
      { id: 'u1', exists: true, get: (f: string) => (f === 'email' ? 'ann@example.test' : undefined) },
      { id: 'u9', exists: true, get: (f: string) => (f === 'email' ? 'bob@example.test' : undefined) },
    ]);

    const res = await GET(request('cron-secret'));

    expect(await res.json()).toEqual({ ok: true, rowsScanned: 1, findingsCreated: 1, emailsSent: 1 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    const sent = emailSend.mock.calls[0][0];
    expect(sent.to).toEqual(['watch@example.test']);
    expect(sent.subject).toContain('2fa removed');
    expect(sent.html).toContain('ann@example.test');
    expect(sent.html).toContain('bob@example.test');
    expect(sent.html).toContain('https://dev.owlette.app/admin/activity?view=flagged');
    expect(state.scannedThrough).toBe(NOW - 30 * 1000);
  });

  it('sends nothing on a second identical run', async () => {
    feedRows = [highRow()];
    await GET(request('cron-secret'));
    emailSend.mockClear();

    const res = await GET(request('cron-secret'));

    expect(await res.json()).toEqual({ ok: true, rowsScanned: 1, findingsCreated: 0, emailsSent: 0 });
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('claims the finding before it sends', async () => {
    feedRows = [highRow()];
    await GET(request('cron-secret'));
    expect(callOrder.slice(0, 2)).toEqual([expect.stringMatching(/^claim:mfa_removed:/), 'send']);
  });

  it('emails a high finding stored by an earlier run, once', async () => {
    store.set('mfa_removed:old', {
      id: 'mfa_removed:old', rule: 'mfa_removed', severity: 'high', title: '2fa removed', summary: 'x', subject: { userId: 'u1' },
      at: NOW - 10 * MIN, facts: [], rowIds: [], detectedAt: NOW - 10 * MIN, emailedAt: null, digestedAt: null,
    });

    const first = await (await GET(request('cron-secret'))).json();
    const second = await (await GET(request('cron-secret'))).json();

    expect(first).toMatchObject({ findingsCreated: 0, emailsSent: 1 });
    expect(second.emailsSent).toBe(0);
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it('emails on the next run when Resend was missing on the run that found it', async () => {
    resendConfigured = false;
    feedRows = [highRow()];
    await GET(request('cron-secret'));
    expect(emailSend).not.toHaveBeenCalled();

    resendConfigured = true;
    const res = await (await GET(request('cron-secret'))).json();

    expect(res).toMatchObject({ findingsCreated: 0, emailsSent: 1 });
  });

  it('does not email a high finding older than a day', async () => {
    store.set('mfa_removed:stale', {
      id: 'mfa_removed:stale', rule: 'mfa_removed', severity: 'high', title: '2fa removed', summary: 'x', subject: { userId: 'u1' },
      at: NOW - 30 * 60 * MIN, facts: [], rowIds: [], detectedAt: NOW - 30 * 60 * MIN, emailedAt: null, digestedAt: null,
    });

    await GET(request('cron-secret'));

    expect(emailSend).not.toHaveBeenCalled();
  });

  it('ignores rows newer than the scan end, and carries on when a send fails', async () => {
    feedRows = [change('late', 'user_mutated:mfa_disabled', { at: NOW - 10 * 1000 }), highRow()];
    emailSend.mockRejectedValueOnce(new Error('resend down'));

    const res = await GET(request('cron-secret'));

    expect(await res.json()).toEqual({ ok: true, rowsScanned: 1, findingsCreated: 1, emailsSent: 0 });
    expect(state.scannedThrough).toBe(NOW - 30 * 1000);
  });

  it('sends the digest once a day, listing the high findings already emailed', async () => {
    feedRows = [highRow(), digestRow()];

    await GET(request('cron-secret'));

    expect(emailSend).toHaveBeenCalledTimes(2); // the finding email, then the digest
    const digest = emailSend.mock.calls[1][0];
    expect(digest.subject).toContain('daily digest — 1 to review');
    expect(digest.html).toContain('2fa removed');
    expect(state.lastDigestDay).toBe('2026-11-15');
    expect([...store.values()].filter((f) => f.severity === 'digest').every((f) => f.digestedAt === NOW)).toBe(true);

    feedRows = [];
    emailSend.mockClear();
    await GET(request('cron-secret'));
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('sends no digest when nothing is waiting for review', async () => {
    feedRows = [highRow()];
    await GET(request('cron-secret'));
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(callOrder).toContain('claim-digest');
  });

  it('sends no digest before 16:00 utc', async () => {
    dateNow.mockReturnValue(Date.UTC(2026, 10, 15, 9, 0, 0));
    feedRows = [change('d2', 'user_mutated:soft_deleted', { at: Date.UTC(2026, 10, 15, 8, 55, 0) })];
    await GET(request('cron-secret'));
    expect(emailSend).not.toHaveBeenCalled();
    expect(callOrder).not.toContain('claim-digest');
  });

  it('warns and carries on when Resend is not configured', async () => {
    resendConfigured = false;
    feedRows = [highRow()];

    const res = await GET(request('cron-secret'));

    expect(await res.json()).toEqual({ ok: true, rowsScanned: 1, findingsCreated: 1, emailsSent: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([]);
    expect(state.scannedThrough).toBe(NOW - 30 * 1000);
  });

  describe('the email setting on admin → alerts', () => {
    it('sends one email to every stored address', async () => {
      email = { enabled: true, recipients: ['a@example.test', 'b@example.test'] };
      feedRows = [highRow()];

      await GET(request('cron-secret'));

      expect(emailSend).toHaveBeenCalledTimes(1);
      expect(emailSend.mock.calls[0][0].to).toEqual(['a@example.test', 'b@example.test']);
    });

    // the list is who gets mail: an environment address no longer stands in for an emptied one
    it('sends nothing and claims nothing to an empty list, and ignores ACTIVITY_EMAIL', async () => {
      email = { enabled: true, recipients: [] };
      feedRows = [highRow()];

      const res = await GET(request('cron-secret'));

      expect(await res.json()).toEqual({ ok: true, rowsScanned: 1, findingsCreated: 1, emailsSent: 0 });
      expect(emailSend).not.toHaveBeenCalled();
      expect(callOrder).toEqual([]);
    });

    it('sends nothing and claims nothing while off, but still stores the finding', async () => {
      email = { enabled: false, recipients: ['a@example.test'] };
      feedRows = [highRow(), digestRow()];

      const res = await GET(request('cron-secret'));

      expect(await res.json()).toEqual({ ok: true, rowsScanned: 2, findingsCreated: 2, emailsSent: 0 });
      expect(emailSend).not.toHaveBeenCalled();
      expect(callOrder).toEqual([]);
      expect([...store.values()].every((f) => f.emailedAt === null && f.digestedAt === null)).toBe(true);
      expect(state.lastDigestDay).toBeNull();
      expect(state.scannedThrough).toBe(NOW - 30 * 1000);
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    it('mails the pending high finding once when it is turned back on', async () => {
      email = { enabled: false, recipients: [] };
      feedRows = [highRow()];
      await GET(request('cron-secret'));
      expect(emailSend).not.toHaveBeenCalled();

      email = { enabled: true, recipients: ['a@example.test'] };
      const first = await (await GET(request('cron-secret'))).json();
      const second = await (await GET(request('cron-secret'))).json();

      expect(first.emailsSent).toBe(1);
      expect(second.emailsSent).toBe(0);
      expect(emailSend.mock.calls.filter((c) => c[0].subject.includes('2fa removed'))).toHaveLength(1);
    });
  });

  describe('audit queues that stop draining', () => {
    it('mails every queue stuck past 5 minutes in one email an hour, and leaves a fresh one alone', async () => {
      auditQueued = [
        { siteId: 'site-b', enqueuedAt: NOW - 6 * MIN },
        { siteId: 'site-c', enqueuedAt: NOW - MIN },
        { siteId: 'site-e', enqueuedAt: NOW - 30 * MIN },
      ];
      const hour = Math.floor(NOW / (60 * MIN));

      const first = await (await GET(request('cron-secret'))).json();
      const again = await (await GET(request('cron-secret'))).json();
      dateNow.mockReturnValue(NOW + 60 * MIN);
      const nextHour = await (await GET(request('cron-secret'))).json();

      expect(first).toMatchObject({ findingsCreated: 1, emailsSent: 1 });
      expect(again).toMatchObject({ findingsCreated: 0, emailsSent: 0 });
      expect(nextHour).toMatchObject({ findingsCreated: 1, emailsSent: 1 });
      expect([...store.keys()]).toEqual([`audit_queue_stuck:${hour}`, `audit_queue_stuck:${hour + 1}`]);
      expect(store.get(`audit_queue_stuck:${hour}`)?.facts).toEqual([
        { label: 'sites', value: 'site-b, site-e' },
        { label: 'stuck sites', value: '2' },
        { label: 'oldest queued', value: new Date(NOW - 30 * MIN).toISOString() },
      ]);
      const mail = emailSend.mock.calls[0][0];
      expect(mail.subject).toContain('audit queue stuck — platform');
      expect(mail.html).toContain('2 sites have audit events that have waited more than 5 minutes to join an audit log.');
      expect(mail.html).toContain('site-b, site-e');
    });

    it('does not flag a queue the drainer emptied between the scan and the read of its oldest event', async () => {
      auditQueued = [{ siteId: 'site-d', enqueuedAt: NOW - MIN, drained: true }];

      const res = await (await GET(request('cron-secret'))).json();

      expect(res).toMatchObject({ findingsCreated: 0, emailsSent: 0 });
    });
  });

  describe('scan start', () => {
    it('is 20 minutes back with no scannedThrough yet', async () => {
      await GET(request('cron-secret'));
      expect(loadActivitySince).toHaveBeenCalledWith(mockDb, NOW - 20 * MIN);
    });

    it('is the older of scannedThrough and 20 minutes back', async () => {
      state.scannedThrough = NOW - 3 * MIN;
      await GET(request('cron-secret'));
      expect(loadActivitySince).toHaveBeenLastCalledWith(mockDb, NOW - 20 * MIN);

      state.scannedThrough = NOW - 2 * 60 * MIN;
      await GET(request('cron-secret'));
      expect(loadActivitySince).toHaveBeenLastCalledWith(mockDb, NOW - 2 * 60 * MIN);
    });

    it('is never older than 24 hours after a long gap', async () => {
      state.scannedThrough = NOW - 5 * DAY;
      await GET(request('cron-secret'));
      expect(loadActivitySince).toHaveBeenCalledWith(mockDb, NOW - DAY);
    });
  });
});
