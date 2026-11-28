/** @jest-environment node */

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockMachineGet = jest.fn();
const mockWebhookGet = jest.fn();
const mockSystemGet = jest.fn();

const mockMachineQuery = {
  orderBy: jest.fn(() => mockMachineQuery),
  limit: jest.fn(() => mockMachineQuery),
  get: mockMachineGet,
};

const mockWebhookQuery = {
  where: jest.fn(() => mockWebhookQuery),
  limit: jest.fn(() => mockWebhookQuery),
  get: mockWebhookGet,
};

const mockProcessAlertGet = jest.fn();
const mockProcessAlertQuery = {
  where: jest.fn(() => mockProcessAlertQuery),
  limit: jest.fn(() => mockProcessAlertQuery),
  get: mockProcessAlertGet,
};
const mockDisplayAlertGet = jest.fn();
const mockDisplayAlertQuery = {
  where: jest.fn(() => mockDisplayAlertQuery),
  limit: jest.fn(() => mockDisplayAlertQuery),
  get: mockDisplayAlertGet,
};

// global/alert_digest, the digest job's last run
const mockDigestStatusGet = jest.fn();
// alert_digests where pending == true, limit 1
const mockDigestPendingGet = jest.fn();
const mockDigestPendingQuery = {
  where: jest.fn(() => mockDigestPendingQuery),
  limit: jest.fn(() => mockDigestPendingQuery),
  get: mockDigestPendingGet,
};

const mockTalonGet = jest.fn();
const mockTalonQuery = {
  where: jest.fn(() => mockTalonQuery),
  limit: jest.fn(() => mockTalonQuery),
  get: mockTalonGet,
};

const mockDb = {
  collectionGroup: jest.fn((name: string) =>
    name === 'talons' ? mockTalonQuery : mockMachineQuery,
  ),
  collection: jest.fn((name: string) => {
    if (name === 'webhook_deliveries') return mockWebhookQuery;
    if (name === 'pending_process_alerts') return mockProcessAlertQuery;
    if (name === 'pending_display_alerts') return mockDisplayAlertQuery;
    if (name === 'alert_digests') return mockDigestPendingQuery;
    if (name === 'global') {
      return { doc: jest.fn(() => ({ get: mockDigestStatusGet })) };
    }
    if (name === 'system_status') {
      return {
        doc: jest.fn(() => ({ get: mockSystemGet })),
      };
    }
    return {
      doc: jest.fn(() => ({ get: jest.fn() })),
    };
  }),
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb,
}));

import {
  agentRegistryHealth,
  alertDeliveryHealth,
  apiHealth,
  hootChatHealth,
  dashboardHealth,
  firestoreHealth,
  r2UploadsHealth,
  runStatusHealthChecks,
  talonDispatchHealth,
  webhookDeliveryHealth,
} from '@/lib/healthChecks.server';

function response(status: number): Response {
  return new Response('', { status });
}

function querySnapshot(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return {
    docs: docs.map((doc) => ({
      id: doc.id,
      data: () => doc.data,
    })),
  };
}

describe('status health checks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/api/whoami')) return Promise.resolve(response(401));
      return Promise.resolve(response(200));
    });
    mockMachineGet.mockResolvedValue(querySnapshot([
      { id: 'machine-1', data: { lastHeartbeat: { toMillis: () => 1_000_000 } } },
    ]));
    mockWebhookGet.mockResolvedValue(querySnapshot([]));
    mockProcessAlertGet.mockResolvedValue(querySnapshot([]));
    mockDisplayAlertGet.mockResolvedValue(querySnapshot([]));
    mockTalonGet.mockResolvedValue(querySnapshot([]));
    mockDigestStatusGet.mockResolvedValue({ data: () => ({ lastRunAt: 2_000_000 - 60_000 }) });
    mockDigestPendingGet.mockResolvedValue({ empty: true, docs: [] });
    mockSystemGet.mockResolvedValue({ exists: true });
  });

  it('marks the dashboard healthy on a 2xx response', async () => {
    mockFetch.mockResolvedValueOnce(response(200));

    const result = await dashboardHealth({ baseUrl: 'https://example.test' });

    expect(result.component).toBe('dashboard');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('marks the dashboard degraded on a server response', async () => {
    mockFetch.mockResolvedValueOnce(response(503));

    const result = await dashboardHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('503');
  });

  it('marks the dashboard degraded when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const result = await dashboardHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('network down');
  });

  it('checks version, auth, OpenAPI, and rendered docs for API liveness', async () => {
    mockFetch
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({
      version_status: 200,
      whoami_status: 401,
      openapi_status: 200,
      docs_status: 200,
    });
  });

  it('marks the API degraded when either probe returns 5xx', async () => {
    mockFetch
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(503));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('whoami=503');
  });

  it('marks the API degraded when OpenAPI or docs are unavailable', async () => {
    mockFetch
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(503));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('docs=503');
  });

  it('marks the API degraded when a probe throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('api unreachable'));

    const result = await apiHealth({ baseUrl: 'https://example.test' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('api unreachable');
  });

  it('uses the newest machine heartbeat for agent registry health', async () => {
    const result = await agentRegistryHealth({ now: () => 1_000_000 + 60_000 });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ latest_machine_id: 'machine-1' });
  });

  it('marks agent registry degraded when the latest heartbeat is stale', async () => {
    const result = await agentRegistryHealth({ now: () => 1_000_000 + 10 * 60_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stale');
  });

  it('marks agent registry degraded when Firestore throws', async () => {
    mockMachineGet.mockRejectedValueOnce(new Error('index unavailable'));

    const result = await agentRegistryHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('index unavailable');
  });

  it('passes webhook delivery when the recent success rate is high enough', async () => {
    mockWebhookGet.mockResolvedValueOnce(querySnapshot([
      { id: 'a', data: { state: 'succeeded', createdAt: 1 } },
      { id: 'b', data: { lastStatus: 204, createdAt: 2 } },
    ]));

    const result = await webhookDeliveryHealth({ now: () => 3_600_000 });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ sample_size: 2, success_count: 2 });
  });

  it('marks webhook delivery degraded when recent success rate is too low', async () => {
    mockWebhookGet.mockResolvedValueOnce(querySnapshot([
      { id: 'a', data: { state: 'succeeded', createdAt: 1 } },
      { id: 'b', data: { lastStatus: 500, createdAt: 2 } },
    ]));

    const result = await webhookDeliveryHealth({ now: () => 3_600_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('below');
  });

  it('marks webhook delivery degraded when Firestore throws', async () => {
    mockWebhookGet.mockRejectedValueOnce(new Error('delivery query failed'));

    const result = await webhookDeliveryHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('delivery query failed');
  });

  it('passes alert delivery when the digest queues are drained', async () => {
    const result = await alertDeliveryHealth({ now: () => 2_000_000 });

    expect(result.component).toBe('alert_delivery');
    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      stale_process_alerts: 0,
      stale_display_alerts: 0,
    });
  });

  it('marks alert delivery degraded when a digest queue is backed up', async () => {
    mockProcessAlertGet.mockResolvedValueOnce(querySnapshot([
      { id: 'a', data: { timestamp: { toMillis: () => 1 } } },
      { id: 'b', data: { timestamp: { toMillis: () => 2 } } },
    ]));

    const result = await alertDeliveryHealth({ now: () => 2_000_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('undelivered');
    expect(result.metadata).toMatchObject({ stale_process_alerts: 2, stale_display_alerts: 0 });
  });

  it('marks alert delivery degraded when only the display queue is backed up', async () => {
    mockDisplayAlertGet.mockResolvedValueOnce(querySnapshot([
      { id: 'd', data: { timestamp: { toMillis: () => 1 } } },
    ]));

    const result = await alertDeliveryHealth({ now: () => 2_000_000 });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({ stale_process_alerts: 0, stale_display_alerts: 1 });
  });

  it('queries each digest queue for docs older than the threshold', async () => {
    await alertDeliveryHealth({ now: () => 2_000_000 });

    expect(mockProcessAlertQuery.where).toHaveBeenCalledWith('timestamp', '<=', expect.any(Date));
    expect(mockDisplayAlertQuery.where).toHaveBeenCalledWith('timestamp', '<=', expect.any(Date));
  });

  const pending = { empty: false, docs: [{ id: 'u1' }] };

  it('marks alert delivery degraded when the digest job last ran over 45 minutes ago and a digest is waiting', async () => {
    const now = 10_000_000;
    mockDigestStatusGet.mockResolvedValueOnce({ data: () => ({ lastRunAt: now - 46 * 60_000 }) });
    mockDigestPendingGet.mockResolvedValueOnce(pending);

    const result = await alertDeliveryHealth({ now: () => now });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('alert digest job');
    expect(result.metadata).toMatchObject({ alert_digest_threshold_minutes: 45, alert_digests_pending: true });
    expect(mockDigestPendingQuery.where).toHaveBeenCalledWith('pending', '==', true);
  });

  it('marks alert delivery degraded when the digest job has never run and a digest is waiting', async () => {
    mockDigestStatusGet.mockResolvedValueOnce({ data: () => undefined });
    mockDigestPendingGet.mockResolvedValueOnce(pending);

    const result = await alertDeliveryHealth({ now: () => 2_000_000 });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({ alert_digest_last_run_at: null });
  });

  it.each([
    ['has never run', () => ({ data: () => undefined })],
    ['last ran over 45 minutes ago', () => ({ data: () => ({ lastRunAt: 1 }) })],
  ])('passes alert delivery when the digest job %s but nothing is waiting, since senders then email at once', async (_name, status) => {
    mockDigestStatusGet.mockResolvedValueOnce(status());

    const result = await alertDeliveryHealth({ now: () => 10_000_000 });

    expect(result.ok).toBe(true);
  });

  it('marks alert delivery degraded when Firestore throws', async () => {
    mockProcessAlertGet.mockRejectedValueOnce(new Error('queue query failed'));

    const result = await alertDeliveryHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('queue query failed');
  });

  it('passes talon dispatch when no talon is left unclaimed', async () => {
    const result = await talonDispatchHealth({ now: () => 2_000_000 });

    expect(result.component).toBe('talon_dispatch');
    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({ overdue_talons: 0, threshold_minutes: 15 });
  });

  it('marks talon dispatch degraded when a due talon was never claimed', async () => {
    mockTalonGet.mockResolvedValueOnce(querySnapshot([
      { id: 'talon-1', data: { enabled: true } },
      { id: 'talon-2', data: { enabled: true } },
    ]));

    const result = await talonDispatchHealth({ now: () => 2_000_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('unclaimed');
    expect(result.metadata).toMatchObject({ overdue_talons: 2 });
  });

  it('queries only enabled talons overdue past the threshold', async () => {
    await talonDispatchHealth({ now: () => 2_000_000 });

    expect(mockDb.collectionGroup).toHaveBeenCalledWith('talons');
    expect(mockTalonQuery.where).toHaveBeenCalledWith('enabled', '==', true);
    expect(mockTalonQuery.where).toHaveBeenCalledWith('nextRunAt', '<=', expect.any(Date));
  });

  it('marks talon dispatch degraded when Firestore throws', async () => {
    mockTalonGet.mockRejectedValueOnce(new Error('talon index unavailable'));

    const result = await talonDispatchHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('talon index unavailable');
  });

  it('checks Firestore with a small heartbeat read', async () => {
    const result = await firestoreHealth();

    expect(result.component).toBe('firestore');
    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual({ heartbeat_doc_exists: true });
  });

  it('marks Firestore degraded when the heartbeat read is slow', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_601);

    const result = await firestoreHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('601ms');
    nowSpy.mockRestore();
  });

  it('marks Firestore degraded when the heartbeat read throws', async () => {
    mockSystemGet.mockRejectedValueOnce(new Error('read failed'));

    const result = await firestoreHealth();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('read failed');
  });

  it('keeps uninstrumented R2 and Hoot checks explicitly marked as placeholders', async () => {
    await expect(r2UploadsHealth()).resolves.toMatchObject({
      component: 'r2_uploads',
      ok: true,
      metadata: { placeholder: true },
    });
    await expect(hootChatHealth()).resolves.toMatchObject({
      component: 'cortex_chat',
      ok: true,
      metadata: { placeholder: true },
    });
  });

  it('runs the planned status components', async () => {
    const results = await runStatusHealthChecks({ baseUrl: 'https://example.test' });

    expect(results.map((entry) => entry.component)).toEqual([
      'dashboard',
      'api',
      'agent_registry',
      'webhook_delivery',
      'alert_delivery',
      'talon_dispatch',
      'r2_uploads',
      'firestore',
      'cortex_chat',
    ]);
  });
});
