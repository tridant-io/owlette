/** @jest-environment node */

/**
 * Talon-tap placement for `POST /api/agent/alert`: the route taps the matcher for every authorized
 * event EXCEPT display events, which `functions/src/talonLogEvents.ts` already fires off the
 * agent's `sites/{siteId}/logs` write. Tapping both would double-run every display talon on a
 * 3.0.0+ agent. These tests pin the asymmetry — display in, no tap; process in, tap.
 *
 * The last block pins the connection-failure branch's webhook: sent whatever the email settings
 * are, and never for a reboot-pending notice.
 */

import { createMockRequest } from '../helpers/utils';

// Mocks — declared before importing the route.

const tapTalonMatcherMock = jest.fn();
const fireWebhooksMock = jest.fn().mockResolvedValue(undefined);
const mockVerifyIdToken = jest.fn();
const pendingDisplayAdd = jest.fn().mockResolvedValue(undefined);
const pendingProcessAdd = jest.fn().mockResolvedValue(undefined);
const siteLogsAdd = jest.fn().mockResolvedValue(undefined);
// The default is the route's two email exits: no Resend client and no recipients.
let mockResendClient: { emails: { send: jest.Mock } } | null = null;
let mockRecipients: Record<string, unknown>[] = [];

const siteDocRef = {
  get: async () => ({ data: () => ({ name: 'test site' }) }),
  collection: (name: string) => {
    if (name === 'logs') return { add: siteLogsAdd };
    // Read by the local-Hoot probe on the process branch.
    if (name === 'machines') {
      return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    }
    throw new Error(`unexpected subcollection: ${name}`);
  },
};

const mockDb = {
  collection: jest.fn((name: string) => {
    if (name === 'pending_display_alerts') return { add: pendingDisplayAdd };
    if (name === 'pending_process_alerts') return { add: pendingProcessAdd };
    if (name === 'sites') return { doc: () => siteDocRef };
    throw new Error(`unexpected collection: ${name}`);
  }),
};

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })) },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
  getAdminDb: () => mockDb,
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

// No Upstash in unit tests: both limiters resolve null, which the route reads as "let it
// through". Mirrored explicitly so the test doesn't depend on ambient env.
jest.mock('@/lib/rateLimit', () => ({
  checkRateLimit: jest.fn(async () => ({ success: true })),
  processAlertRateLimit: null,
  getDisplayAlertRateLimit: () => null,
}));

jest.mock('@/lib/webhookSender.server', () => ({
  fireWebhooks: (...args: unknown[]) => fireWebhooksMock(...args),
}));

jest.mock('@/lib/adminUtils.server', () => ({
  getSiteAlertRecipients: jest.fn(async () => mockRecipients),
  getMachineTimezone: jest.fn(async () => 'UTC'),
  getSiteLabel: jest.fn(async (siteId: string) => siteId),
  // the real mute and machine-scope filter.
  recipientWantsMachine: jest.requireActual('@/lib/adminUtils.server').recipientWantsMachine,
}));

jest.mock('@/lib/resendClient.server', () => ({
  getResend: () => mockResendClient,
  FROM_EMAIL: 'noreply@mail.owlette.app',
  ENV_LABEL: 'test',
}));

jest.mock('@/app/api/unsubscribe/route', () => ({
  generateUnsubscribeToken: () => 'unsub-token',
}));

// The matcher itself is covered by `__tests__/lib/talons/matcher.test.ts`.
jest.mock('@/lib/talons/matcher.server', () => ({
  tapTalonMatcher: (...args: unknown[]) => tapTalonMatcherMock(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { POST as alertPOST } from '@/app/api/agent/alert/route';

const SITE = 'site-a';
const MACHINE = 'machine-1';

function post(body: Record<string, unknown>) {
  return alertPOST(
    createMockRequest('http://localhost/api/agent/alert', {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-token' },
      body: { siteId: SITE, machineId: MACHINE, agentVersion: '3.0.0', ...body },
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResendClient = null;
  mockRecipients = [];
  mockVerifyIdToken.mockResolvedValue({
    role: 'agent',
    site_id: SITE,
    machine_id: MACHINE,
  });
  delete process.env.CORTEX_INTERNAL_SECRET;
});

describe('POST /api/agent/alert — talon tap', () => {
  it.each([
    ['display_monitor_removed'],
    ['display_drift'],
    ['display_apply_succeeded'],
  ])('does not tap the matcher for %s (logs trigger is the single source)', async (eventType) => {
    const res = await post({
      eventType,
      data: { monitor: { edidHash: 'abc', friendlyName: 'DELL P2415Q', port: 'DP' } },
    });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).not.toHaveBeenCalled();
  });

  it('still routes the display event it declined to tap', async () => {
    const res = await post({ eventType: 'display_drift', data: { changes: ['refreshHz'] } });

    expect(await res.json()).toMatchObject({ success: true, webhookFired: true });
    expect(fireWebhooksMock).toHaveBeenCalledWith(
      SITE,
      'test site',
      'display.drift',
      expect.objectContaining({ machine: { id: MACHINE, name: MACHINE } }),
    );
  });

  it('taps the matcher for a process event', async () => {
    const res = await post({
      eventType: 'process_crash',
      processName: 'TouchDesigner.exe',
      errorMessage: 'exited unexpectedly',
    });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).toHaveBeenCalledTimes(1);
    expect(tapTalonMatcherMock).toHaveBeenCalledWith(mockDb, SITE, {
      kind: 'event',
      eventType: 'process_crash',
      machineId: MACHINE,
    });
  });

  it('taps the matcher for a connection failure', async () => {
    const res = await post({ errorCode: 'CONN_FAIL', errorMessage: 'no route to host' });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).toHaveBeenCalledTimes(1);
    expect(tapTalonMatcherMock).toHaveBeenCalledWith(mockDb, SITE, {
      kind: 'event',
      eventType: 'connection_failure',
      machineId: MACHINE,
    });
  });

  it('taps the matcher for an unregistered display_* event (generic branch)', async () => {
    // `display_apply_acked` has no `DISPLAY_EVENT_ROUTING` entry, so it isn't a display event by
    // the route's definition and nothing can subscribe to it. Asserted so the skip stays scoped to
    // the ten routed types rather than the `display_` prefix.
    const res = await post({ eventType: 'display_apply_acked', data: { applyId: 'a1' } });

    expect(res.status).toBe(200);
    expect(tapTalonMatcherMock).toHaveBeenCalledWith(mockDb, SITE, {
      kind: 'event',
      eventType: 'display_apply_acked',
      machineId: MACHINE,
    });
  });
});

describe('POST /api/agent/alert — connection failure webhook', () => {
  it('fires machine.offline when nobody takes the email', async () => {
    // Resend is unconfigured and the site has no recipients here: both are email
    // exits, and a site that routes this alert to a webhook must still get it.
    const res = await post({ errorCode: 'CONN_FAIL', errorMessage: 'no route to host' });

    expect(await res.json()).toMatchObject({ success: true, emailSent: false });
    expect(fireWebhooksMock).toHaveBeenCalledWith(
      SITE,
      'test site',
      'machine.offline',
      { machine: { id: MACHINE, name: MACHINE } },
    );
  });

  it('sends no machine.offline for a reboot-pending notice', async () => {
    // the agent posts it on this branch with no eventType. the machine is online.
    const res = await post({
      errorCode: 'reboot_pending',
      errorMessage: 'Reboot pending on LOBBY-01 (reasons: os update)',
    });

    expect(res.status).toBe(200);
    expect(fireWebhooksMock).not.toHaveBeenCalled();
  });

  describe('on a site that takes the email', () => {
    const send = jest.fn(async () => ({ error: null }));

    beforeEach(() => {
      mockResendClient = { emails: { send } };
      mockRecipients = [
        { userId: 'user-1', email: 'ops@example.com', ccEmails: [], mutedMachines: [], machineIds: null },
      ];
    });

    it('sends the email and machine.offline for a connection failure', async () => {
      const res = await post({ errorCode: 'CONN_FAIL', errorMessage: 'no route to host' });

      expect(await res.json()).toMatchObject({ success: true, emailSent: true, recipients: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(fireWebhooksMock).toHaveBeenCalledWith(
        SITE,
        'test site',
        'machine.offline',
        { machine: { id: MACHINE, name: MACHINE } },
      );
    });

    it('sends the email and no machine.offline for a reboot-pending notice', async () => {
      // this is where the notice used to read as the machine going offline
      const res = await post({
        errorCode: 'reboot_pending',
        errorMessage: 'Reboot pending on LOBBY-01 (reasons: os update)',
      });

      expect(await res.json()).toMatchObject({ success: true, emailSent: true, recipients: 1 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(fireWebhooksMock).not.toHaveBeenCalled();
    });
  });
});
