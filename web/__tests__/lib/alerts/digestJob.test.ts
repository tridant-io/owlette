/** @jest-environment node */

/**
 * The alert digest queue and job, against an in-memory Firestore: a queued alert
 * collapses on its source key, a due period is claimed, sent once and closed, a
 * row that lands after the claim survives the send, nothing is sent when nothing
 * is left, and every Resend answer leaves the queue in the state it should.
 */

import type { Timestamp } from 'firebase-admin/firestore';
import { MemoryFirestore } from '../../api/helpers/memoryFirestore';
import type { SiteAlertAudience, SiteRecipient } from '@/lib/adminUtils.server';

const mem = new MemoryFirestore();
let audiences: Record<string, SiteAlertAudience> = {};
const audienceCalls: string[] = [];

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: () => mem }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertAudience: async (siteId: string, category: string) => {
    audienceCalls.push(`${siteId}|${category}`);
    return audiences[`${siteId}|${category}`] ?? { recipients: [], complete: true };
  },
  getSiteLabel: async (siteId: string) => siteId,
  recipientWantsMachine: jest.requireActual('@/lib/adminUtils.server').recipientWantsMachine,
}));
jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => null,
  trustedBaseUrl: () => 'https://owlette.test',
  FROM_EMAIL: 'owlette <alerts@owlette.test>',
  ENV_LABEL: 'TEST',
  isProduction: false,
}));
jest.mock('@/app/api/unsubscribe/route', () => ({ generateUnsubscribeToken: (uid: string) => `tok-${uid}` }));
jest.mock('@/lib/planPause.server', () => ({ createPlanMemo: () => ({ sites: new Map() }) }));

import { alertEmailDelivery, digestEventId, queueDigestEvents, type DigestEvent } from '@/lib/alerts/digest.server';
import { runAlertDigest, type DigestTransport } from '@/lib/alerts/digestJob.server';

const UID = 'u1';
const QUEUED = Date.parse('2026-11-26T10:00:00Z');
const DUE = Date.parse('2026-11-27T08:00:00Z');
const MIN = 60_000;

let clock = QUEUED;
const now = () => clock;

function event(over: Partial<DigestEvent> = {}): DigestEvent {
  return {
    sourceKey: 'offline|site-a|kiosk-1|1',
    siteId: 'site-a',
    machineId: 'kiosk-1',
    category: 'healthAlerts',
    kind: 'offline',
    severity: 'critical',
    title: 'offline',
    data: { staleSince: 1 },
    at: QUEUED,
    ...over,
  };
}

function me(over: Partial<SiteRecipient> = {}): SiteRecipient {
  return { userId: UID, email: 'u1@example.test', ccEmails: [], mutedMachines: [], machineIds: null, delivery: 'daily', ...over };
}

function seedUser(uid = UID, preferences: Record<string, unknown> = {}) {
  mem.docs.set(`users/${uid}`, { email: `${uid}@example.test`, preferences: { timezone: 'UTC', alertCcEmails: [], ...preferences } });
}

/** the digest job's last run, which decides whether a sender may queue */
const lastRun = (ms: number) => mem.docs.set('global/alert_digest', { lastRunAt: ms });

const rows = (uid = UID) => [...mem.docs.keys()].filter((p) => p.startsWith(`alert_digests/${uid}/digest_events/`));
const state = (uid = UID) => mem.read(`alert_digests/${uid}`) as Record<string, unknown> | undefined;

function transport(answer: Awaited<ReturnType<DigestTransport>> = { error: null }) {
  return jest.fn<ReturnType<DigestTransport>, Parameters<DigestTransport>>(async () => answer);
}

beforeEach(() => {
  mem.docs.clear();
  clock = QUEUED;
  mem.now = now;
  audiences = { 'site-a|healthAlerts': { recipients: [me()], complete: true } };
  audienceCalls.length = 0;
});

describe('queueDigestEvents', () => {
  it('cuts a long title and detail, so a row stays small', async () => {
    await queueDigestEvents(UID, [event({ title: 't'.repeat(5_000), detail: 'd'.repeat(5_000) })]);
    const row = mem.read(rows()[0]) as { title: string; detail: string };
    expect(row.title.length).toBeLessThanOrEqual(200);
    expect(row.detail.length).toBeLessThanOrEqual(500);
  });

  it('collapses repeats of one source into one row and marks the queue pending', async () => {
    await queueDigestEvents(UID, [event()]);
    await queueDigestEvents(UID, [event()]);

    expect(rows()).toEqual([`alert_digests/${UID}/digest_events/${digestEventId('offline|site-a|kiosk-1|1')}`]);
    expect(state()).toMatchObject({ pending: true });
  });

  it('keeps every one of an alert posted once', async () => {
    await queueDigestEvents(UID, [event({ sourceKey: null }), event({ sourceKey: null })]);
    expect(rows()).toHaveLength(2);
  });
});

describe('alertEmailDelivery', () => {
  const deliver = (recipient: SiteRecipient, sendNow: () => Promise<boolean>) =>
    alertEmailDelivery(now).deliver(recipient, [event()], sendNow);

  it('sends now for someone on immediate, and queues nothing', async () => {
    lastRun(clock - MIN);
    const sendNow = jest.fn(async () => true);
    expect(await deliver(me({ delivery: 'immediate' }), sendNow)).toBe('sent');
    expect(sendNow).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it('queues for everyone else while the digest job is running, and sends nothing', async () => {
    lastRun(clock - 10 * MIN);
    const sendNow = jest.fn(async () => true);
    expect(await deliver(me({ delivery: 'hourly' }), sendNow)).toBe('queued');
    expect(sendNow).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('sends now, and queues nothing, when the digest job has never run', async () => {
    const sendNow = jest.fn(async () => true);
    expect(await deliver(me(), sendNow)).toBe('sent');
    expect(sendNow).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });

  it('sends now, and queues nothing, when the digest job last ran over 45 minutes ago', async () => {
    lastRun(clock - 46 * MIN);
    const sendNow = jest.fn(async () => true);
    expect(await deliver(me(), sendNow)).toBe('sent');
    expect(rows()).toEqual([]);
  });

  it('reads whether the job is running once per delivery, not once per recipient', async () => {
    lastRun(clock - MIN);
    const reads = jest.spyOn(mem, 'snapshot');
    const delivery = alertEmailDelivery(now);
    for (const uid of ['a', 'b', 'c']) await delivery.deliver(me({ userId: uid }), [event()], async () => true);
    expect(reads.mock.calls.filter(([path]) => path === 'global/alert_digest')).toHaveLength(1);
    reads.mockRestore();
  });

  it('reports a failed queue write instead of throwing it', async () => {
    lastRun(clock - MIN);
    const commit = jest.spyOn(mem, 'batch').mockReturnValueOnce({
      create: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
      commit: jest.fn(async () => {
        throw new Error('unavailable');
      }),
    } as unknown as ReturnType<MemoryFirestore['batch']>);
    await expect(deliver(me(), async () => true)).resolves.toBe('failed');
    commit.mockRestore();
  });
});

async function queueAt(ms: number, ev: DigestEvent = event(), uid = UID) {
  clock = ms;
  await queueDigestEvents(uid, [ev]);
}

async function run(send: ReturnType<typeof transport>, at: number) {
  clock = at;
  return runAlertDigest({ now, send });
}

describe('runAlertDigest', () => {
  beforeEach(() => seedUser());

  it('waits until the period is due', async () => {
    await queueAt(QUEUED);
    const send = transport();
    const report = await run(send, DUE - MIN);
    expect(send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ users: 1, due: 0, sent: 0 });
    expect(rows()).toHaveLength(1);
  });

  it('sends a due digest once, under its period key, then closes the period', async () => {
    await queueAt(QUEUED);
    const send = transport();
    const report = await run(send, DUE + 30_000);

    expect(report).toMatchObject({ users: 1, due: 1, sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [email, key] = send.mock.calls[0];
    expect(key).toBe(`alert-digest/${UID}/daily:2026-11-27T08:00:00.000Z`);
    expect(email).toMatchObject({ to: 'u1@example.test', cc: [] });
    expect(email.subject).toMatch(/^owlette daily digest · /);
    expect(email.html).toContain('kiosk-1');
    expect(email.html).toContain('new: your alerts now arrive as one daily digest');
    expect(email.headers).toEqual({
      'List-Unsubscribe': `<https://owlette.test/api/unsubscribe?token=tok-${UID}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });

    expect(rows()).toEqual([]);
    expect(state()).toMatchObject({ pending: false, lastSentPeriodKey: 'daily:2026-11-27T08:00:00.000Z' });
    expect(state()).not.toHaveProperty('claim');
    expect(state()?.introducedAt).toBeDefined();
    expect(mem.read('global/alert_digest')).toMatchObject({ lastRunAt: DUE + 30_000, lastRun: report });

    // the next one carries no introduction
    await queueAt(DUE + 60 * MIN, event({ sourceKey: 'offline|site-a|kiosk-1|2' }));
    await run(send, DUE + 24 * 60 * MIN + MIN);
    expect(send.mock.calls[1][1]).toBe(`alert-digest/${UID}/daily:2026-11-28T08:00:00.000Z`);
    expect(send.mock.calls[1][0].html).not.toContain('new: your alerts');
  });

  it('sends no one-click unsubscribe headers on a digest with cc', async () => {
    seedUser(UID, { alertCcEmails: ['colleague@example.test'] });
    await queueAt(QUEUED);
    const send = transport();
    await run(send, DUE + 30_000);
    expect(send.mock.calls[0][0].cc).toEqual(['colleague@example.test']);
    expect(send.mock.calls[0][0].headers).toEqual({});
    expect(send.mock.calls[0][0].html).toContain(`/api/unsubscribe?token=tok-${UID}`);
  });

  it('keeps a row queued after the claim, even one whose alert happened earlier', async () => {
    await queueAt(QUEUED);
    const late = event({ sourceKey: 'offline|site-a|kiosk-2|9', machineId: 'kiosk-2', at: QUEUED - 60 * MIN });
    const send = jest.fn<ReturnType<DigestTransport>, Parameters<DigestTransport>>(async () => {
      clock += 1000;
      await queueDigestEvents(UID, [late]);
      return { error: null };
    });
    clock = DUE + 30_000;
    await runAlertDigest({ now, send });

    expect(send.mock.calls[0][0].html).not.toContain('kiosk-2');
    expect(rows()).toEqual([`alert_digests/${UID}/digest_events/${digestEventId('offline|site-a|kiosk-2|9')}`]);
    expect(state()).toMatchObject({ pending: true });
  });

  it('sends nothing when every row was dropped, and closes the period without moving its anchor', async () => {
    await queueAt(QUEUED);
    audiences = { 'site-a|healthAlerts': { recipients: [me({ userId: 'someone-else' })], complete: true } };
    const send = transport();
    await run(send, DUE + 30_000);

    expect(send).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(state()).toMatchObject({ pending: false });
    expect(state()).not.toHaveProperty('lastClosedAt');
    expect(state()).not.toHaveProperty('claim');
  });

  it('drops a row the person muted since, and sends the rest', async () => {
    await queueAt(QUEUED);
    await queueAt(QUEUED + MIN, event({ sourceKey: 'offline|site-a|kiosk-2|1', machineId: 'kiosk-2' }));
    audiences = { 'site-a|healthAlerts': { recipients: [me({ mutedMachines: ['kiosk-2'] })], complete: true } };
    const send = transport();
    await run(send, DUE + 30_000);

    expect(send.mock.calls[0][0].html).toContain('kiosk-1');
    expect(send.mock.calls[0][0].html).not.toContain('kiosk-2');
    expect(rows()).toEqual([]);
  });

  it('retries rows whose recipients could not be read on the next run, when nothing else went out', async () => {
    await queueAt(QUEUED);
    audiences = { 'site-a|healthAlerts': { recipients: [], complete: false } };
    const send = transport();
    const report = await run(send, DUE + 30_000);

    expect(send).not.toHaveBeenCalled();
    expect(report.held).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(state()).toMatchObject({ pending: true });
    expect(state()).not.toHaveProperty('lastClosedAt');

    // nothing went out under the key, so the next run sends the same period
    audiences = { 'site-a|healthAlerts': { recipients: [me()], complete: true } };
    await run(send, DUE + 15 * MIN);
    expect(send.mock.calls[0][1]).toBe(`alert-digest/${UID}/daily:2026-11-27T08:00:00.000Z`);
    expect(rows()).toEqual([]);
  });

  it('holds rows to the next period when the rest of the period went out', async () => {
    await queueAt(QUEUED);
    await queueAt(QUEUED + MIN, event({ sourceKey: 'process|p1', category: 'processAlerts', kind: 'process_crash', title: 'touchdesigner' }));
    audiences = {
      'site-a|healthAlerts': { recipients: [], complete: false },
      'site-a|processAlerts': { recipients: [me()], complete: true },
    };
    const send = transport();
    await run(send, DUE + 30_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);

    audiences['site-a|healthAlerts'] = { recipients: [me()], complete: true };
    await run(send, DUE + 15 * MIN);
    expect(send).toHaveBeenCalledTimes(1);
    await run(send, DUE + 24 * 60 * MIN + MIN);
    expect(send.mock.calls[1][1]).toBe(`alert-digest/${UID}/daily:2026-11-28T08:00:00.000Z`);
  });

  it('reads a 409 for a body already sent under the key as sent', async () => {
    await queueAt(QUEUED);
    const report = await run(transport({ error: { name: 'invalid_idempotent_request', statusCode: 409 } }), DUE + 30_000);
    expect(report.sent).toBe(1);
    expect(rows()).toEqual([]);
  });

  it('leaves the claim to a request already sending the key', async () => {
    await queueAt(QUEUED);
    await run(transport({ error: { name: 'concurrent_idempotent_requests', statusCode: 409 } }), DUE + 30_000);
    expect(rows()).toHaveLength(1);

    const send = transport();
    await run(send, DUE + 60_000);
    expect(send).not.toHaveBeenCalled();
  });

  it('stops the run on a 429, keeps every row and does not count it as a dead attempt', async () => {
    seedUser('u2');
    await queueAt(QUEUED);
    await queueAt(QUEUED, event(), 'u2');
    audiences = { 'site-a|healthAlerts': { recipients: [me(), me({ userId: 'u2' })], complete: true } };
    const limited = transport({ error: { name: 'rate_limit_exceeded', statusCode: 429 } });
    const report = await run(limited, DUE + 30_000);

    expect(limited).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({ sent: 0, deferred: 2 });
    expect(rows(UID)).toHaveLength(1);
    expect(rows('u2')).toHaveLength(1);
    const claim = state(UID)?.claim as { leaseUntil: number; attempts: number; html: string };
    expect(claim).toMatchObject({ leaseUntil: 0, attempts: 0 });

    // the next run resends the stored body under the same key
    const send = transport();
    await run(send, DUE + 15 * MIN);
    expect(send).toHaveBeenCalledTimes(2);
    const mine = send.mock.calls.find(([, key]) => key.startsWith(`alert-digest/${UID}/`))!;
    expect(mine[1]).toBe(`alert-digest/${UID}/daily:2026-11-27T08:00:00.000Z`);
    expect(mine[0].html).toBe(claim.html);
  });

  it('keeps the rows on a server error without counting it', async () => {
    await queueAt(QUEUED);
    const report = await run(transport({ error: { name: 'application_error', statusCode: 500 } }), DUE + 30_000);
    expect(report.failed).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(state()?.claim).toMatchObject({ leaseUntil: 0, attempts: 0 });
  });

  it('holds everything when no email transport is configured', async () => {
    await queueAt(QUEUED);
    const report = await run(jest.fn(async () => null) as unknown as ReturnType<typeof transport>, DUE + 30_000);
    expect(report).toMatchObject({ sent: 0, deferred: 1 });
    expect(rows()).toHaveLength(1);
  });

  it('gives a period up at once on a message Resend will never take', async () => {
    await queueAt(QUEUED);
    const report = await run(transport({ error: { name: 'validation_error', statusCode: 422 } }), DUE + 30_000);
    expect(report.failed).toBe(1);
    expect(rows()).toEqual([]);
    expect(state()).not.toHaveProperty('claim');
  });

  it('gives a period up after three runs died holding it', async () => {
    await queueAt(QUEUED);
    const dies = jest.fn<ReturnType<DigestTransport>, Parameters<DigestTransport>>(async () => {
      throw new Error('killed mid-send');
    });
    for (let i = 0; i < 3; i++) await run(dies, DUE + 30_000 + i * 11 * MIN);
    expect(dies).toHaveBeenCalledTimes(3);
    expect(rows()).toHaveLength(1);

    const send = transport();
    await run(send, DUE + 30_000 + 3 * 11 * MIN);
    expect(send).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(state()).not.toHaveProperty('claim');
  });

  it('sends once when two runs overlap', async () => {
    await queueAt(QUEUED);
    const send = transport();
    clock = DUE + 30_000;
    const reports = await Promise.all([runAlertDigest({ now, send }), runAlertDigest({ now, send })]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(reports.map((r) => r.sent).sort()).toEqual([0, 1]);
  });

  it('flushes the queue at once for someone who switched to each alert as it happens', async () => {
    await queueAt(QUEUED);
    seedUser(UID, { alertDelivery: 'immediate' });
    const queuedAt = (mem.read(rows()[0]) as { queuedAt: Timestamp }).queuedAt.toMillis();
    const send = transport();
    await run(send, QUEUED + 5 * MIN);
    expect(send.mock.calls[0][1]).toBe(`alert-digest/${UID}/flush:${queuedAt}`);
    expect(send.mock.calls[0][0].subject).toMatch(/^owlette alert digest · /);
  });

  it('follows a cadence change at once', async () => {
    await queueAt(QUEUED);
    seedUser(UID, { alertDelivery: 'hourly' });
    const send = transport();
    await run(send, Date.parse('2026-11-26T11:00:10Z'));
    expect(send.mock.calls[0][1]).toBe(`alert-digest/${UID}/hourly:2026-11-26T11:00:00.000Z`);
  });

  it('sends at 08:00 in the person’s zone', async () => {
    await queueAt(QUEUED);
    seedUser(UID, { timezone: 'Asia/Kathmandu' });
    const send = transport();
    await run(send, Date.parse('2026-11-27T02:14:00Z'));
    expect(send).not.toHaveBeenCalled();
    await run(send, Date.parse('2026-11-27T02:15:05Z'));
    expect(send.mock.calls[0][1]).toBe(`alert-digest/${UID}/daily:2026-11-27T02:15:00.000Z`);
  });

  it('drops the queue of a deleted person', async () => {
    await queueAt(QUEUED);
    mem.docs.set(`users/${UID}`, { email: 'u1@example.test', deletedAt: 1 });
    const send = transport();
    await run(send, DUE + 30_000);
    expect(send).not.toHaveBeenCalled();
    expect(state()).toBeUndefined();
    expect(rows()).toEqual([]);
  });

  it('clears pending once the TTL has taken every row', async () => {
    mem.docs.set(`alert_digests/${UID}`, { pending: true });
    await run(transport(), DUE + 30_000);
    expect(state()).toMatchObject({ pending: false });
  });

  it('looks each site and category up once per run', async () => {
    seedUser('u2');
    await queueAt(QUEUED);
    await queueAt(QUEUED, event(), 'u2');
    audiences = { 'site-a|healthAlerts': { recipients: [me(), me({ userId: 'u2' })], complete: true } };
    await run(transport(), DUE + 30_000);
    expect(audienceCalls).toEqual(['site-a|healthAlerts']);
  });
});

describe('runAlertDigest on a large fleet', () => {
  beforeEach(() => seedUser());

  it('keeps the stored body well under 1 MiB for 300 machines on 60 sites, and still sends', async () => {
    audiences = {};
    clock = QUEUED;
    for (let site = 0; site < 60; site++) {
      const siteId = `site-${site}-${'x'.repeat(40)}`;
      audiences[`${siteId}|processAlerts`] = { recipients: [me()], complete: true };
      for (let machine = 0; machine < 5; machine++) {
        const machineId = `machine-${machine}-${'y'.repeat(40)}`;
        mem.docs.set(`sites/${siteId}/machines/${machineId}`, { online: false, lastHeartbeat: QUEUED });
        for (let p = 0; p < 40; p++) {
          await queueDigestEvents(UID, [
            event({
              sourceKey: `process|${siteId}|${machineId}|${p}`,
              siteId,
              machineId,
              category: 'processAlerts',
              kind: 'process_crash',
              title: `process-${p}-${'z'.repeat(60)}`,
              detail: 'e'.repeat(500),
            }),
          ]);
        }
      }
    }

    const send = transport();
    const report = await run(send, DUE + 30_000);

    expect(report.sent).toBe(1);
    const { html } = send.mock.calls[0][0];
    expect(Buffer.byteLength(html)).toBeLessThan(700_000);
    // the loosest caps (25 of the 60 sites) would not fit: it was rendered again, tighter
    expect(html).toMatch(/and (50|55) more sites/);
    expect(rows()).toEqual([]);
  }, 60_000);
});
