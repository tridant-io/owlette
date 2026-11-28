/** @jest-environment node */

/**
 * The digest branch of the senders not covered beside their own routes: the
 * threshold trigger, the process and display drains, and the hoot escalation.
 * A recipient on a digest gets a queued row and no email, with Resend not even
 * configured, and a drain's row is keyed on its queue doc so an overlapping
 * drain run queues it once. (health-check and /api/agent/alert are covered in
 * their own suites.)
 */

import { NextRequest } from 'next/server';

// rows a recipient on a digest gets, as `{ uid, id, data }`
const queuedRows: { uid: string; id: string; data: Record<string, unknown> }[] = [];
const deletedPending: string[] = [];
let pendingDocs: { collection: string; id: string; data: Record<string, unknown> }[] = [];
let mockRecipients: Record<string, unknown>[] = [];
// the digest job's last run: senders queue only while it is recent
let mockLastRunAt: number | null = Date.now();

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'alert_digests') {
      return { doc: (uid: string) => ({ uid, collection: () => ({ doc: (id?: string) => ({ uid, id: id ?? 'auto' }) }) }) };
    }
    if (name === 'pending_process_alerts' || name === 'pending_display_alerts') {
      const docs = () =>
        pendingDocs
          .filter((d) => d.collection === name)
          .map((d) => ({ id: d.id, data: () => d.data, ref: { path: `${name}/${d.id}` } }));
      return { where: () => ({ get: async () => ({ empty: docs().length === 0, docs: docs() }) }) };
    }
    if (name === 'global') {
      return { doc: () => ({ get: async () => ({ data: () => (mockLastRunAt === null ? undefined : { lastRunAt: mockLastRunAt }) }) }) };
    }
    if (name === 'sites') return { doc: () => ({ get: async () => ({ data: () => ({ name: 'site a' }) }) }) };
    throw new Error(`unexpected collection: ${name}`);
  }),
  batch: () => {
    const rows: { uid: string; id: string; data: Record<string, unknown> }[] = [];
    const deletes: string[] = [];
    return {
      create: (ref: { uid: string; id: string }, data: Record<string, unknown>) => rows.push({ ...ref, data }),
      set: jest.fn(),
      delete: (ref: { path: string }) => deletes.push(ref.path),
      commit: async () => {
        queuedRows.push(...rows);
        deletedPending.push(...deletes);
      },
    };
  },
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __op: 'serverTimestamp' }), delete: () => ({ __op: 'delete' }) },
  Timestamp: class {
    static fromMillis(ms: number) {
      return { __ts: ms };
    }
  },
}));
jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mockDb }));
jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertRecipients: jest.fn(async () => mockRecipients),
  getMachineTimezone: jest.fn(async () => 'UTC'),
  getSiteLabel: jest.fn(async (siteId: string) => siteId),
  recipientWantsMachine: jest.requireActual('@/lib/adminUtils.server').recipientWantsMachine,
}));
// no Resend at all: a digest recipient must not need it
jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => null,
  FROM_EMAIL: 'noreply@mail.owlette.app',
  ENV_LABEL: 'test',
  isProduction: false,
}));
jest.mock('@/app/api/unsubscribe/route', () => ({ generateUnsubscribeToken: () => 'unsub-token' }));
jest.mock('@/lib/webhookSender.server', () => ({ fireWebhooks: jest.fn(async () => 0) }));
jest.mock('@/lib/talons/matcher.server', () => ({ tapTalonMatcher: jest.fn() }));
jest.mock('@/lib/hootInternalSecret', () => ({ hootInternalSecretMatches: () => true }));
jest.mock('@/lib/secretMatches.server', () => ({ cronSecretMatches: () => true }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import { POST as triggerPOST } from '@/app/api/alerts/trigger/route';
import { GET as processGET } from '@/app/api/cron/process-alerts/route';
import { GET as displayGET } from '@/app/api/cron/display-alerts/route';
import { escalate } from '@/lib/hoot-escalation.server';
import { digestEventId } from '@/lib/alerts/digest.server';

const recipient = (userId: string, delivery: string, machineIds: string[] | null = null) => ({
  userId,
  email: `${userId}@example.test`,
  ccEmails: [],
  mutedMachines: [],
  machineIds,
  delivery,
});

beforeEach(() => {
  queuedRows.length = 0;
  deletedPending.length = 0;
  pendingDocs = [];
  mockLastRunAt = Date.now();
  mockRecipients = [recipient('daily', 'daily'), recipient('scoped', 'weekly', ['other-machine'])];
});

describe('POST /api/alerts/trigger', () => {
  const breach = (value: number) =>
    triggerPOST(
      new NextRequest('http://localhost/api/alerts/trigger', {
        method: 'POST',
        body: JSON.stringify({
          siteId: 'site-a',
          machineId: 'kiosk-1',
          ruleName: 'low disk',
          metric: 'disk_percent',
          value,
          threshold: 85,
          operator: '>',
          severity: 'critical',
          channels: ['email'],
        }),
      }),
    );

  it('queues each breach for a recipient on a digest, even a rule with no cooldown that fires again at once', async () => {
    const first = await (await breach(91)).json();
    await breach(93);

    expect(first).toMatchObject({ success: true, emailSent: false, digested: 1 });
    expect(queuedRows.map((r) => r.uid)).toEqual(['daily', 'daily']);
    expect(queuedRows[0].data).toMatchObject({
      siteId: 'site-a',
      machineId: 'kiosk-1',
      category: 'thresholdAlerts',
      kind: 'threshold',
      severity: 'critical',
      title: 'low disk',
      data: { metric: 'disk_percent', operator: '>', threshold: 85, value: 91 },
    });
  });
});

describe('the 3-minute drains', () => {
  const at = new Date('2026-11-26T10:00:00Z');

  it('queues a process alert keyed on its queue doc, then drains the queue', async () => {
    pendingDocs = [
      {
        collection: 'pending_process_alerts',
        id: 'p1',
        data: {
          siteId: 'site-a',
          machineId: 'kiosk-1',
          processName: 'TouchDesigner',
          errorMessage: 'exit code 3',
          agentVersion: '4.2.0',
          eventType: 'process_crash',
          timestamp: { toMillis: () => at.getTime() },
        },
      },
    ];

    const body = await (await processGET(new NextRequest('http://localhost/api/cron/process-alerts'))).json();

    expect(body).toMatchObject({ ok: true, emailsSent: 0, digested: 1 });
    expect(queuedRows).toEqual([
      {
        uid: 'daily',
        id: digestEventId('process|p1'),
        data: expect.objectContaining({
          category: 'processAlerts',
          kind: 'process_crash',
          title: 'TouchDesigner',
          detail: 'exit code 3',
          at: at.getTime(),
        }),
      },
    ]);
    expect(deletedPending).toEqual(['pending_process_alerts/p1']);
  });

  it('queues a display alert keyed on its queue doc, with its label and severity', async () => {
    pendingDocs = [
      {
        collection: 'pending_display_alerts',
        id: 'd1',
        data: {
          siteId: 'site-a',
          machineId: 'kiosk-1',
          eventType: 'display_apply_failed',
          data: { error: 'mode not supported' },
          agentVersion: '4.2.0',
          correlatedApplyId: '',
          timestamp: at,
        },
      },
    ];

    const body = await (await displayGET(new NextRequest('http://localhost/api/cron/display-alerts'))).json();

    expect(body).toMatchObject({ ok: true, emailsSent: 0, digested: 1 });
    expect(queuedRows).toEqual([
      {
        uid: 'daily',
        id: digestEventId('display|d1'),
        data: expect.objectContaining({
          category: 'displayAlerts',
          kind: 'display_apply_failed',
          severity: 'critical',
          title: 'display apply failed',
          detail: 'mode not supported',
        }),
      },
    ]);
    expect(deletedPending).toEqual(['pending_display_alerts/d1']);
  });
});

describe('escalate (hoot)', () => {
  it('queues the escalation keyed on its event, and counts it as handled', async () => {
    const handled = await escalate('site-a', 'evt-1', 'kiosk-1', 'TouchDesigner', 'restarted twice, still crashing');

    expect(handled).toBe(true);
    expect(queuedRows).toEqual([
      {
        uid: 'daily',
        id: digestEventId('hoot|site-a|evt-1'),
        data: expect.objectContaining({
          category: 'cortexAlerts',
          kind: 'hoot_escalation',
          title: 'TouchDesigner',
          detail: 'restarted twice, still crashing',
        }),
      },
    ]);
  });

  it('reports nothing handled when the only recipient is on immediate and Resend is not configured', async () => {
    mockRecipients = [recipient('now', 'immediate')];
    expect(await escalate('site-a', 'evt-2', 'kiosk-1', 'TouchDesigner', 'x')).toBe(false);
    expect(queuedRows).toEqual([]);
  });
});
