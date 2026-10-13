/** @jest-environment node */

const mockUpdate = jest.fn().mockResolvedValue(undefined);
const mockGet = jest.fn();
/**
 * Secrets now live at `sites/{id}/webhook_secrets/{webhookId}`, fetched with one
 * batched `getAll` over the fan-out. Default: the sibling is ABSENT, so these
 * tests exercise the legacy in-document `secret` fallback they were written for.
 * `mockSecretDocs` overrides it to assert the sibling takes precedence.
 */
let mockSecretDocs: Array<{ data: () => Record<string, unknown> | undefined }> = [];
const mockGetAll = jest.fn((...refs: unknown[]) =>
  Promise.resolve(refs.map((_, i) => mockSecretDocs[i] ?? { data: () => undefined })),
);
/** Plan lookups read `sites/{id}` and `users/{payer}` by path; nothing else reads a doc. */
let mockDocs: Record<string, Record<string, unknown>> = {};
const mockDocGet = jest.fn(async (path: string) => ({ data: () => mockDocs[path] }));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    // Subscription query path — `sites/{id}/webhooks`; also the secret-sibling
    // path, which only needs to be chainable since getAll does the reading.
    collection: (name: string) => ({
      where: jest.fn().mockReturnThis(),
      get: mockGet,
      doc: (id: string) => ({
        get: () => mockDocGet(`${name}/${id}`),
        collection: () => ({ doc: () => ({}) }),
      }),
    }),
    getAll: mockGetAll,
  }),
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { fireWebhooks, testWebhook } from '@/lib/webhookSender.server';
import { createPlanMemo } from '@/lib/planPause.server';
import crypto from 'crypto';

function makeWebhookDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-1',
    ref: { update: mockUpdate },
    data: () => ({
      url: 'https://hooks.example.com/abc',
      secret: 'test-secret-123',
      failCount: 0,
      ...overrides,
    }),
  };
}

describe('webhookSender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSecretDocs = [];
  });

  describe('fireWebhooks', () => {
    it('returns 0 when no webhooks match', async () => {
      mockGet.mockResolvedValue({ empty: true, docs: [] });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {
        machine: { id: 'm1', name: 'Machine 1' },
      });

      expect(result).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // Liveness is decided in memory, because the query cannot decide it: the
    // creator writes `paused`/`deletedAt` and no `enabled`, and a Firestore
    // equality filter requires the field to exist. These four pin both shapes.
    it('delivers to a webhook created since the control-plane change (paused:false, no `enabled`)', async () => {
      // The regression: every subscription created after that change carried no
      // `enabled` field, so `.where('enabled','==',true)` matched nothing and the
      // webhook delivered silently nothing while the dashboard showed it healthy.
      const doc = makeWebhookDoc({ paused: false, deletedAt: null });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {});

      expect(result).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not deliver to a PAUSED webhook', async () => {
      const doc = makeWebhookDoc({ paused: true, deletedAt: null });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not deliver to a SOFT-DELETED webhook', async () => {
      const doc = makeWebhookDoc({ paused: false, deletedAt: 1700000000000 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('honours the LEGACY `enabled: false` shape too', async () => {
      // The inverse of the regression: a document predating the change carries
      // `enabled` and neither `paused` nor `deletedAt`, and must still be obeyed.
      const doc = makeWebhookDoc({ enabled: false });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('delivers payload to matching webhooks and returns success count', async () => {
      const doc = makeWebhookDoc();
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {
        machine: { id: 'm1', name: 'Machine 1' },
      });

      expect(result).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/abc');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['X-owlette-Event']).toBe('process.crashed');
      expect(opts.headers['User-Agent']).toBe('owlette-Webhooks/1.0');
      expect(opts.headers['X-owlette-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify payload structure
      const body = JSON.parse(opts.body);
      expect(body.event).toBe('process.crashed');
      expect(body.site).toEqual({ id: 'site1', name: 'My Site' });
      expect(body.data.machine).toEqual({ id: 'm1', name: 'Machine 1' });
      expect(body.timestamp).toBeDefined();
    });

    it('signs with the server-only sibling secret in preference to the legacy field', async () => {
      // The whole point of the relocation: the webhook document's `secret` is the
      // leaked one, so once a sibling exists it must win.
      const doc = makeWebhookDoc({ secret: 'stale-leaked-secret' });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockSecretDocs = [{ data: () => ({ signingSecret: 'sibling-secret-999' }) }];
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await fireWebhooks('site1', 'My Site', 'process.crashed', {
        machine: { id: 'm1', name: 'Machine 1' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      const sent = (init as { headers: Record<string, string>; body: string });
      const expected = crypto
        .createHmac('sha256', 'sibling-secret-999')
        .update(sent.body)
        .digest('hex');
      expect(sent.headers['X-owlette-Signature']).toBe(`sha256=${expected}`);
    });

    it('skips delivery instead of throwing when no secret exists anywhere', async () => {
      // Without the guard, createHmac(undefined) throws inside the delivery, the
      // catch counts it as a failure, and ten of those auto-disable a
      // subscription whose only fault is a missing key.
      const doc = makeWebhookDoc({ secret: undefined });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await fireWebhooks('site1', 'My Site', 'process.crashed', {
        machine: { id: 'm1', name: 'Machine 1' },
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it('sends correct HMAC-SHA256 signature', async () => {
      const secret = 'my-secret-key';
      const doc = makeWebhookDoc({ secret });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await fireWebhooks('s1', 'Site', 'machine.offline', { machine: { id: 'm1' } });

      const [, opts] = mockFetch.mock.calls[0];
      const signatureHeader = opts.headers['X-owlette-Signature'];
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(opts.body)
        .digest('hex');

      expect(signatureHeader).toBe(`sha256=${expectedSig}`);
    });

    it('resets failCount on successful delivery', async () => {
      const doc = makeWebhookDoc({ failCount: 5 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 0, lastStatus: 200 })
      );
    });

    it('increments failCount on non-2xx response', async () => {
      const doc = makeWebhookDoc({ failCount: 3 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(result).toBe(0);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 4, lastStatus: 500 })
      );
    });

    it('increments failCount on network error', async () => {
      const doc = makeWebhookDoc({ failCount: 2 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(result).toBe(0);
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 3, lastStatus: 0 })
      );
    });

    it('auto-disables webhook after 10 consecutive failures', async () => {
      const doc = makeWebhookDoc({ failCount: 9 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: false, status: 502 });

      await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 10, enabled: false })
      );
    });

    it('auto-disables on network error at threshold', async () => {
      const doc = makeWebhookDoc({ failCount: 9 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockRejectedValue(new Error('timeout'));

      await fireWebhooks('s1', 'Site', 'machine.offline', {});

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 10, enabled: false })
      );
    });

    it('does not set enabled:false when failCount is below threshold', async () => {
      const doc = makeWebhookDoc({ failCount: 7 });
      mockGet.mockResolvedValue({ empty: false, docs: [doc] });
      mockFetch.mockResolvedValue({ ok: false, status: 404 });

      await fireWebhooks('s1', 'Site', 'process.crashed', {});

      const updateArg = mockUpdate.mock.calls[0][0];
      expect(updateArg.failCount).toBe(8);
      expect(updateArg.enabled).toBeUndefined();
    });

    it('delivers to multiple webhooks independently', async () => {
      const doc1 = makeWebhookDoc();
      const doc2 = {
        ...makeWebhookDoc({ url: 'https://other.example.com/hook' }),
        id: 'wh-2',
        ref: { update: jest.fn().mockResolvedValue(undefined) },
      };
      // Fix: doc2.data needs to return the overridden url
      doc2.data = () => ({
        url: 'https://other.example.com/hook',
        secret: 'test-secret-123',
        failCount: 0,
      });

      mockGet.mockResolvedValue({ empty: false, docs: [doc1, doc2] });
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await fireWebhooks('s1', 'Site', 'process.crashed', {});

      expect(result).toBe(1); // only first succeeded
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First webhook: success, failCount reset
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 0 })
      );
      // Second webhook: failure, failCount incremented
      expect(doc2.ref.update).toHaveBeenCalledWith(
        expect.objectContaining({ failCount: 1 })
      );
    });
  });

  /**
   * Plans (plan.md decision 8): delivery pauses when the site's payer has no
   * `owlette.webhooks`. Runs the real resolver; only tridant's answer is mocked.
   */
  describe('fireWebhooks — plan pause', () => {
    const ent = (webhooks: '0' | '1') => ({
      ok: true,
      resolved: webhooks === '1',
      standing: webhooks === '1' ? 'active' : 'expired',
      inGoodStanding: webhooks === '1',
      ent: { 'owlette.webhooks': webhooks },
      epoch: 0,
    });

    beforeEach(() => {
      process.env.PLAN_ENFORCEMENT = 'on';
      process.env.OWLETTE_E2E = '1';
      mockDocs = { 'sites/site1': { owner: 'payer' }, 'sites/site2': { owner: 'payer' }, 'users/payer': {} };
      mockGet.mockResolvedValue({ empty: false, docs: [makeWebhookDoc()] });
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
    });

    afterEach(() => {
      delete process.env.PLAN_ENFORCEMENT;
      delete process.env.OWLETTE_E2E;
    });

    it('pauses without delivering, reading secrets or touching delivery state', async () => {
      mockGetEntitlements.mockResolvedValue(ent('0'));

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(mockGetEntitlements).toHaveBeenCalledWith('payer');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockGetAll).not.toHaveBeenCalled();
      // a pause is not a failure: no failCount, so it never auto-disables.
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('delivers when the payer has webhooks', async () => {
      mockGetEntitlements.mockResolvedValue(ent('1'));

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('skips the lookup when nothing is subscribed', async () => {
      mockGet.mockResolvedValue({ empty: true, docs: [] });

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(0);
      expect(mockDocGet).not.toHaveBeenCalled();
      expect(mockGetEntitlements).not.toHaveBeenCalled();
    });

    it('makes no plan read when enforcement is off', async () => {
      delete process.env.PLAN_ENFORCEMENT;

      expect(await fireWebhooks('site1', 'My Site', 'process.crashed', {})).toBe(1);
      expect(mockDocGet).not.toHaveBeenCalled();
      expect(mockGetEntitlements).not.toHaveBeenCalled();
    });

    it('resolves each site and payer once across a batch sharing a memo', async () => {
      mockGetEntitlements.mockResolvedValue(ent('0'));
      const memo = createPlanMemo();

      await Promise.all([
        fireWebhooks('site1', 'My Site', 'machine.offline', {}, memo),
        fireWebhooks('site1', 'My Site', 'machine.offline', {}, memo),
        fireWebhooks('site2', 'Other Site', 'machine.offline', {}, memo),
      ]);

      expect(mockDocGet.mock.calls.map(([path]) => path).sort()).toEqual([
        'sites/site1',
        'sites/site2',
        'users/payer',
      ]);
      expect(mockGetEntitlements).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('testWebhook', () => {
    it('sends test payload and returns status', async () => {
      mockFetch.mockResolvedValue({ status: 200 });

      const result = await testWebhook('https://hooks.example.com/test', 'secret123');

      expect(result).toEqual({ status: 200 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://hooks.example.com/test');
      expect(opts.headers['X-owlette-Event']).toBe('test');

      const body = JSON.parse(opts.body);
      expect(body.event).toBe('process.crashed');
      expect(body.site).toEqual({ id: 'test', name: 'Test Site' });
    });

    it('returns status 0 and error message on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await testWebhook('https://hooks.example.com/test', 'secret123');

      expect(result).toEqual({ status: 0, error: 'ECONNREFUSED' });
    });

    it('includes correct HMAC signature', async () => {
      const secret = 'verify-me';
      mockFetch.mockResolvedValue({ status: 200 });

      await testWebhook('https://example.com', secret);

      const [, opts] = mockFetch.mock.calls[0];
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(opts.body)
        .digest('hex');

      expect(opts.headers['X-owlette-Signature']).toBe(`sha256=${expectedSig}`);
    });
  });
});
