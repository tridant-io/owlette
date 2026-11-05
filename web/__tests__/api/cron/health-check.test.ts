/** @jest-environment node */

import { NextRequest } from 'next/server';

// Mocks (declared before importing the route)

const machineRefSet = jest.fn().mockResolvedValue(undefined);
const siteRefSet = jest.fn().mockResolvedValue(undefined);
const emailSend = jest.fn().mockResolvedValue({ error: null });
const fireWebhooksMock = jest.fn().mockResolvedValue(undefined);
const tapTalonMatcherMock = jest.fn();
const getSiteAlertRecipientsMock = jest.fn();

const mockMachinesGet = jest.fn();
const mockSitesGet = jest.fn();
const mockSiteGet = jest.fn(async () => ({ data: () => ({ name: 'node-pa' }) }));
/** Site ids the scan is allowed to address this test. */
const knownSites = new Set<string>(['node-pa']);

const siteDocRef = {
  collection: jest.fn((name: string) => {
    if (name !== 'machines') throw new Error(`unexpected subcollection: ${name}`);
    return { get: mockMachinesGet };
  }),
  get: mockSiteGet,
};
const sitesCollection = {
  get: mockSitesGet,
  doc: jest.fn((id: string) => {
    if (!knownSites.has(id)) throw new Error(`unexpected site doc: ${id}`);
    return siteDocRef;
  }),
};
const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'sites') return sitesCollection;
    throw new Error(`unexpected collection: ${name}`);
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })),
    delete: jest.fn(() => ({ __op: 'delete' })),
  },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertRecipients: (...args: unknown[]) => getSiteAlertRecipientsMock(...args),
  getSiteLabel: async (siteId: string) => siteId,
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => ({ emails: { send: emailSend } }),
  FROM_EMAIL: 'noreply@mail.owlette.app',
}));

jest.mock('@/app/api/unsubscribe/route', () => ({
  generateUnsubscribeToken: () => 'unsub-token',
}));

jest.mock('@/lib/webhookSender.server', () => ({
  fireWebhooks: (...args: unknown[]) => fireWebhooksMock(...args),
}));

// The matcher has its own suite; only the tap's placement matters here, and mocking it
// keeps the run engine (and its `talons` query) out of this suite's firestore double.
jest.mock('@/lib/talons/matcher.server', () => ({
  tapTalonMatcher: (...args: unknown[]) => tapTalonMatcherMock(...args),
}));

import { GET, classifyMachineHealth, stalePlannedDowntime } from '@/app/api/cron/health-check/route';
import type { MachineHealthSnapshot } from '@/app/api/cron/health-check/route';

// Helpers

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000; // fixed reference for the pure-function tests

function snapshot(overrides: Partial<MachineHealthSnapshot> = {}): MachineHealthSnapshot {
  return {
    online: true,
    lastHeartbeatMs: NOW - 10 * MIN, // stale by default
    lastCronAlertAtMs: 0,
    staleSinceMs: 0,
    rebooting: false,
    shuttingDown: false,
    rebootScheduledAtSec: 0,
    shutdownScheduledAtSec: 0,
    ...overrides,
  };
}

const ts = (ms: number) => ({ toMillis: () => ms });

function machineDoc(id: string, data: Record<string, unknown>) {
  return { id, data: () => data, ref: { set: machineRefSet } };
}

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/health-check', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

// Pure decision logic (Fix A + B)

describe('classifyMachineHealth', () => {
  it('ignores machines the agent reports offline', () => {
    expect(classifyMachineHealth(snapshot({ online: false }), NOW)).toEqual({
      action: 'ignore',
      reason: 'offline-flag',
    });
  });

  it('treats a fresh heartbeat as ok', () => {
    expect(classifyMachineHealth(snapshot({ lastHeartbeatMs: NOW - 60 * 1000 }), NOW)).toEqual({
      action: 'ok',
    });
  });

  it('treats a heartbeat exactly at the threshold as ok (boundary)', () => {
    expect(classifyMachineHealth(snapshot({ lastHeartbeatMs: NOW - 5 * MIN }), NOW)).toEqual({
      action: 'ok',
    });
  });

  it('keeps two consecutive missed idle heartbeats inside the threshold', () => {
    // Idle cadence is 120s; two missed beats (~4 min of silence) must not mark a
    // healthy machine stale — that headroom is why the threshold is 5 minutes.
    expect(classifyMachineHealth(snapshot({ lastHeartbeatMs: NOW - 4 * MIN }), NOW)).toEqual({
      action: 'ok',
    });
  });

  it('suppresses a stale machine inside its announced reboot window', () => {
    const m = snapshot({
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'ignore', reason: 'planned-downtime' });
  });

  it('suppresses a stale machine inside its announced shutdown window', () => {
    const m = snapshot({
      shuttingDown: true,
      shutdownScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'ignore', reason: 'planned-downtime' });
  });

  it('alerts once a reboot window has elapsed (machine never came back)', () => {
    // Flag still set but scheduled 20 min ago — past the 15 min upper bound. Confirmed stale.
    const m = snapshot({
      lastHeartbeatMs: NOW - 20 * MIN,
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
      staleSinceMs: NOW - 16 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 20 });
  });

  it('does NOT suppress when the in-progress flag is unset even if the anchor lingers', () => {
    // shutdown-cancel clears `shuttingDown` but can leave `shutdownScheduledAt` behind.
    const m = snapshot({
      shuttingDown: false,
      shutdownScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
      staleSinceMs: NOW - 6 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 10 });
  });

  it('does NOT suppress a far-future scheduled instant (clock skew) even with the flag set', () => {
    const m = snapshot({
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW + 60 * MIN) / 1000), // below the lower bound
      staleSinceMs: NOW - 6 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 10 });
  });

  it('ignores a machine still within the alert cooldown', () => {
    const m = snapshot({ lastCronAlertAtMs: NOW - 30 * MIN, staleSinceMs: NOW - 30 * MIN });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'ignore', reason: 'cooldown' });
  });

  it('debounces the first stale observation instead of alerting', () => {
    expect(classifyMachineHealth(snapshot({ staleSinceMs: 0 }), NOW)).toEqual({ action: 'debounce' });
  });

  it('keeps debouncing until stale is confirmed for long enough', () => {
    const m = snapshot({ lastHeartbeatMs: NOW - 6 * MIN, staleSinceMs: NOW - 3 * MIN });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'debounce' });
  });

  it('alerts once staleness is confirmed across scans', () => {
    const m = snapshot({ lastHeartbeatMs: NOW - 10 * MIN, staleSinceMs: NOW - 6 * MIN });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 10 });
  });

  it('re-alerts after the cooldown lapses for a persistently down machine', () => {
    const m = snapshot({
      lastHeartbeatMs: NOW - 70 * MIN,
      lastCronAlertAtMs: NOW - 70 * MIN,
      staleSinceMs: NOW - 70 * MIN,
    });
    expect(classifyMachineHealth(m, NOW)).toEqual({ action: 'alert', heartbeatAgeMinutes: 70 });
  });
});

// Stale-latch clearing (Fix A, server-side authoritative clear)

describe('stalePlannedDowntime', () => {
  it('clears a shutdown latch once the window has elapsed past grace', () => {
    const m = snapshot({
      shuttingDown: true,
      shutdownScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
    });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: true, clearReboot: false });
  });

  it('clears a reboot latch once the window has elapsed past grace', () => {
    const m = snapshot({
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
    });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: false, clearReboot: true });
  });

  it('does NOT clear while still inside the grace window (in-progress)', () => {
    const m = snapshot({
      shuttingDown: true,
      shutdownScheduledAtSec: Math.floor((NOW - 2 * MIN) / 1000),
    });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: false, clearReboot: false });
  });

  it('does NOT clear a latch with no scheduled anchor (avoids racing a just-set flag)', () => {
    const m = snapshot({ shuttingDown: true, shutdownScheduledAtSec: 0 });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: false, clearReboot: false });
  });

  it('does NOT clear when the latch is unset even if the anchor lingers', () => {
    const m = snapshot({
      shuttingDown: false,
      shutdownScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
    });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: false, clearReboot: false });
  });

  it('does NOT clear a far-future (clock-skewed) scheduled instant', () => {
    const m = snapshot({
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW + 60 * MIN) / 1000),
    });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: false, clearReboot: false });
  });

  it('clears both latches when both windows have elapsed', () => {
    const m = snapshot({
      shuttingDown: true,
      shutdownScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
      rebooting: true,
      rebootScheduledAtSec: Math.floor((NOW - 20 * MIN) / 1000),
    });
    expect(stalePlannedDowntime(m, NOW)).toEqual({ clearShutdown: true, clearReboot: true });
  });
});

// GET handler wiring (seconds->ms extraction + side effects)

describe('GET /api/cron/health-check', () => {
  const originalSecret = process.env.CRON_SECRET;
  const now = Date.now();
  const sec = (ms: number) => Math.floor(ms / 1000);

  // Seed the (single) site doc the scan reads. `data` carries the site-level
  // offline-alert state (health.offlineAlert), and `ref.set` is the merge-write
  // target for pending-set updates.
  function setSite(data: Record<string, unknown>) {
    mockSitesGet.mockResolvedValue({
      size: 1,
      docs: [{ id: 'node-pa', data: () => data, ref: { set: siteRefSet } }],
    });
  }

  // Machine doc helpers for the multi-run settling tests.
  const alertDoc = (id: string) =>
    machineDoc(id, {
      online: true,
      lastHeartbeat: ts(now - 10 * MIN),
      health: { staleSince: ts(now - 6 * MIN) },
    });
  const freshDoc = (id: string) =>
    machineDoc(id, { online: true, lastHeartbeat: ts(now - 30 * 1000) });
  const gracefulDoc = (id: string) =>
    machineDoc(id, { online: false, lastHeartbeat: ts(now - 2 * MIN) });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    knownSites.clear();
    knownSites.add('node-pa');
    setSite({ name: 'node-pa' });
    getSiteAlertRecipientsMock.mockResolvedValue([
      { userId: 'u1', email: 'admin@node-pa.test', ccEmails: [], mutedMachines: [] },
    ]);
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('rejects a request without the cron secret', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockSitesGet).not.toHaveBeenCalled();
  });

  it('emails for a confirmed-stale machine once its pending set has settled', async () => {
    // Prior state: this machine has been pending long enough to have settled.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: ['INF-RENDER-SPARE'], pendingUpdatedAt: ts(now - 8 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          machine_timezone: 'America/New_York',
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    // dedup stamp written on the pending machine at send time (not before)
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { lastCronAlertAt: { __op: 'serverTimestamp' } } },
      { merge: true }
    );
    // pending set cleared + lastAlertAt recorded on the site doc
    expect(siteRefSet).toHaveBeenCalledWith(
      {
        health: {
          offlineAlert: {
            pendingIds: [],
            pendingUpdatedAt: { __op: 'delete' },
            lastAlertAt: { __op: 'serverTimestamp' },
          },
        },
      },
      { merge: true }
    );
  });

  it('taps the talon matcher once per not-responding machine (talons 2.3)', async () => {
    // This cron is the ONLY dispatcher of `machine_offline` — an offline machine cannot
    // report that it is — so a subscribed talon can only ever fire from here, and only
    // for the machines that actually triggered.
    setSite({
      name: 'node-pa',
      health: {
        offlineAlert: { pendingIds: ['SILENT-1', 'SILENT-2'], pendingUpdatedAt: ts(now - 8 * MIN) },
      },
    });
    mockMachinesGet.mockResolvedValue({
      size: 3,
      docs: [alertDoc('SILENT-1'), alertDoc('SILENT-2'), gracefulDoc('GRACEFUL-1')],
    });

    await GET(request('cron-secret'));

    expect(tapTalonMatcherMock).toHaveBeenCalledTimes(2);
    for (const machineId of ['SILENT-1', 'SILENT-2']) {
      expect(tapTalonMatcherMock).toHaveBeenCalledWith(
        expect.anything(),
        'node-pa',
        { kind: 'event', eventType: 'machine_offline', machineId },
        expect.anything(),
      );
    }
    // one plan memo for the whole run, so each payer is resolved once
    const [first, second] = tapTalonMatcherMock.mock.calls.map((call: unknown[]) => call[3]);
    expect(first).toBe(second);
  });

  it('does NOT email while the pending set is still settling (records pending, no email)', async () => {
    // Brand-new pending machine, no prior site state → the settle timer starts now.
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    // pending recorded + timer started, but the machine is NOT yet stamped/alerted
    expect(siteRefSet).toHaveBeenCalledWith(
      {
        health: {
          offlineAlert: { pendingIds: ['INF-RENDER-SPARE'], pendingUpdatedAt: { __op: 'serverTimestamp' } },
        },
      },
      { merge: true }
    );
    expect(machineRefSet).not.toHaveBeenCalled();
  });

  it('resets the settle timer when a new machine joins the pending set', async () => {
    // 'A' alone would have settled, but 'B' just joined — the growing outage must
    // keep settling, so still no email and the timer is bumped with the new set.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: ['A'], pendingUpdatedAt: ts(now - 8 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 2,
      docs: [
        machineDoc('A', { online: true, lastHeartbeat: ts(now - 12 * MIN), health: { staleSince: ts(now - 8 * MIN) } }),
        machineDoc('B', { online: true, lastHeartbeat: ts(now - 10 * MIN), health: { staleSince: ts(now - 6 * MIN) } }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(siteRefSet).toHaveBeenCalledWith(
      { health: { offlineAlert: { pendingIds: ['A', 'B'], pendingUpdatedAt: { __op: 'serverTimestamp' } } } },
      { merge: true }
    );
  });

  it('drops a recovering machine from pending and never alerts it', async () => {
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: ['recover-me', 'still-down'], pendingUpdatedAt: ts(now - 8 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 2,
      docs: [
        // fresh heartbeat again — recovered
        machineDoc('recover-me', { online: true, lastHeartbeat: ts(now - 30 * 1000), health: { staleSince: ts(now - 6 * MIN) } }),
        // still not responding
        machineDoc('still-down', { online: true, lastHeartbeat: ts(now - 10 * MIN), health: { staleSince: ts(now - 6 * MIN) } }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(body.alertsSent).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
    const { subject, html } = emailSend.mock.calls[0][0];
    expect(subject).toContain('1 machine(s) offline');
    expect(html).toContain('still-down');
    expect(html).not.toContain('recover-me');
    // recovered machine's stale marker is cleared
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { staleSince: { __op: 'delete' } } },
      { merge: true }
    );
  });

  it('waits out a stable pending set inside the settle window — no email, no redundant site write', async () => {
    // The set is unchanged (no id added, none removed) and the timer has not
    // elapsed: the route must do nothing at all this run — the skip-write guard
    // and the >= SETTLE_MS comparison are both load-bearing here.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: ['A', 'B'], pendingUpdatedAt: ts(now - 3 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 2,
      docs: [alertDoc('A'), alertDoc('B')],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(siteRefSet).not.toHaveBeenCalled();
    expect(machineRefSet).not.toHaveBeenCalled();
  });

  it('persists a shrink while settling without bumping the settle timer', async () => {
    // 'B' recovered mid-settle; the set shrinks but the timer must keep running
    // (only GROWTH resets it), so the write carries pendingIds without a new
    // pendingUpdatedAt.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: ['A', 'B'], pendingUpdatedAt: ts(now - 3 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 2,
      docs: [alertDoc('A'), freshDoc('B')],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(siteRefSet).toHaveBeenCalledTimes(1);
    expect(siteRefSet).toHaveBeenCalledWith(
      { health: { offlineAlert: { pendingIds: ['A'] } } },
      { merge: true }
    );
  });

  it('coalesces a staggered 10-machine shutdown into ONE complete email', async () => {
    const silent = ['silent-1', 'silent-2', 'silent-3', 'silent-4', 'silent-5', 'silent-6'];
    const graceful = ['graceful-1', 'graceful-2', 'graceful-3', 'graceful-4'];

    // Run 1: only silent-1..3 have crossed to confirmed-stale; the other three are
    // still fresh; the four graceful machines already flushed online:false. New
    // pending set → settling, no email.
    setSite({ name: 'node-pa' });
    mockMachinesGet.mockResolvedValue({
      size: 10,
      docs: [
        ...silent.slice(0, 3).map(alertDoc),
        ...silent.slice(3).map(freshDoc),
        ...graceful.map(gracefulDoc),
      ],
    });
    await GET(request('cron-secret'));
    expect(emailSend).not.toHaveBeenCalled();

    // Run 2: all six silent machines are now stale (three more joined). Growth
    // bumps the settle timer → still no email.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: silent.slice(0, 3), pendingUpdatedAt: ts(now - 5 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 10,
      docs: [...silent.map(alertDoc), ...graceful.map(gracefulDoc)],
    });
    await GET(request('cron-secret'));
    expect(emailSend).not.toHaveBeenCalled();

    // Run 3: the set is stable and has settled → send ONE consolidated email.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: silent, pendingUpdatedAt: ts(now - 8 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 10,
      docs: [...silent.map(alertDoc), ...graceful.map(gracefulDoc)],
    });
    await GET(request('cron-secret'));

    expect(emailSend).toHaveBeenCalledTimes(1);
    const { subject, html } = emailSend.mock.calls[0][0];
    // subject count reconciles with the full total (6 not-responding + 4 graceful)
    expect(subject).toContain('10 machine(s) offline in node-pa');
    for (const id of [...silent, ...graceful]) {
      expect(html).toContain(id);
    }
    // categorized: silent -> not responding, graceful -> reported shutting down
    expect(html).toContain('not responding');
    expect(html).toContain('reported shutting down');
    // all six pending machines stamped into cooldown at send time
    const cooldownStamps = machineRefSet.mock.calls.filter(
      ([payload]) =>
        payload &&
        (payload as { health?: { lastCronAlertAt?: unknown } }).health?.lastCronAlertAt !== undefined
    );
    expect(cooldownStamps).toHaveLength(6);
  });

  it('never lets a reboot-window machine enter the pending set', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          rebootScheduledAt: sec(now - 2 * MIN), // Unix seconds, inside grace
          rebooting: true,
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    // never added to pending → no site-level pending write at all
    expect(siteRefSet).not.toHaveBeenCalled();
  });

  it('does NOT email a stale machine inside its scheduled reboot window', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          rebootScheduledAt: sec(now - 2 * MIN), // Unix seconds, inside grace
          rebooting: true,
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(machineRefSet).not.toHaveBeenCalled();
  });

  it('debounces a first-seen stale machine (records staleSince, no email)', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-FLEX-3', {
          online: true,
          lastHeartbeat: ts(now - 7 * MIN),
          // no health.staleSince yet
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { staleSince: { __op: 'serverTimestamp' } } },
      { merge: true }
    );
  });

  it('does NOT email a stale machine inside its scheduled shutdown window', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          shutdownScheduledAt: sec(now - 2 * MIN), // Unix seconds, inside grace
          shuttingDown: true,
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it('DOES email when the scheduled instant is far-future (clock skew) despite the flag', async () => {
    // Prior settled pending state so the (correctly unsuppressed) machine sends.
    setSite({
      name: 'node-pa',
      health: { offlineAlert: { pendingIds: ['INF-RENDER-SPARE'], pendingUpdatedAt: ts(now - 8 * MIN) } },
    });
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true,
          lastHeartbeat: ts(now - 10 * MIN),
          rebootScheduledAt: sec(now + 60 * MIN), // far future -> below the lower bound
          rebooting: true,
          health: { staleSince: ts(now - 6 * MIN) },
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it('clears health.staleSince when a previously-stale machine recovers', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-FLEX-3', {
          online: true,
          lastHeartbeat: ts(now - 30 * 1000), // fresh again
          health: { staleSince: ts(now - 6 * MIN) }, // had a stale marker
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.alertsSent).toBe(0);
    expect(emailSend).not.toHaveBeenCalled();
    expect(machineRefSet).toHaveBeenCalledWith(
      { health: { staleSince: { __op: 'delete' } } },
      { merge: true }
    );
  });

  it('clears a stale shutdown latch at the source once the window has elapsed', async () => {
    mockMachinesGet.mockResolvedValue({
      size: 1,
      docs: [
        machineDoc('INF-RENDER-SPARE', {
          online: true, // agent never wrote online:false — the box is simply powered off
          lastHeartbeat: ts(now - 20 * MIN),
          shuttingDown: true,
          shutdownScheduledAt: sec(now - 20 * MIN), // 20 min past — beyond the 15 min grace
        }),
      ],
    });

    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(200);
    expect(machineRefSet).toHaveBeenCalledWith(
      { shuttingDown: false, shutdownScheduledAt: { __op: 'delete' } },
      { merge: true }
    );
  });
});
