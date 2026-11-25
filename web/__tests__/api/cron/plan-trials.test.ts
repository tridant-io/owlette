/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockListUsers = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ listUsers: (...args: unknown[]) => mockListUsers(...args) }),
}));

// plan.server is the real one: whether the route runs is decided by the env it reads.
const mockEnsureTrial = jest.fn();
jest.mock('@/lib/planTrial.server', () => ({
  ensureTrial: (...args: unknown[]) => mockEnsureTrial(...args),
  nameFor: (displayName: string | undefined, email: string) => `name of ${displayName ?? email}`,
}));

// the real module otherwise: plan.server reads tridantApiUrl from it.
const mockCheckKeys = jest.fn();
jest.mock('@/lib/tridant.server', () => ({
  ...jest.requireActual('@/lib/tridant.server'),
  checkTridantKeys: () => mockCheckKeys(),
}));

const mockPreviewTrial = jest.fn();
jest.mock('@/lib/tridantBilling.server', () => ({
  previewTrial: (...args: unknown[]) => mockPreviewTrial(...args),
}));

import logger from '@/lib/logger';
import { GET } from '@/app/api/cron/plan-trials/route';

function request(query = '', secret?: string) {
  return new NextRequest(`http://localhost/api/cron/plan-trials${query}`, {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const user = (uid: string, over: Record<string, unknown> = {}) => ({
  uid,
  email: `${uid}@example.com`,
  emailVerified: true,
  disabled: false,
  ...over,
});

const check = (keyName: string, over: Record<string, unknown> = {}) => ({
  keyName,
  ok: true,
  missing: [],
  expiresInDays: 40,
  ...over,
});

const LICENSE_OK = check('TRIDANT_LICENSE_KEY');
const RELEASE_OK = check('TRIDANT_RELEASE_KEY');
const KEYS_OK = [LICENSE_OK, RELEASE_OK];

const preview = (payer: string, trial: string | null) => ({ ok: true, payer, trial });

const ENV_KEYS = ['CRON_SECRET', 'PLAN_ENFORCEMENT', 'TRIDANT_API_URL', 'TRIDANT_LICENSE_KEY', 'OWLETTE_E2E'] as const;

describe('GET /api/cron/plan-trials', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = 'cron-secret';
    // tridant id configured and plans still switched off: the state the bulk start runs in.
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.OWLETTE_E2E;
    process.env.TRIDANT_API_URL = 'https://api.tridant.test';
    process.env.TRIDANT_LICENSE_KEY = 'tk_test';
    mockEnsureTrial.mockReset().mockResolvedValue({ status: 'started' });
    mockPreviewTrial.mockReset().mockResolvedValue(preview('would_create', 'would_start'));
    mockCheckKeys.mockReset().mockResolvedValue([LICENSE_OK, RELEASE_OK]);
    mockListUsers.mockReset().mockResolvedValue({
      users: [
        user('a', { displayName: 'Ann' }),
        user('b'),
        user('agent_m1'),
        user('unverified', { emailVerified: false }),
        user('disabled', { disabled: true }),
        user('noemail', { email: undefined }),
      ],
      pageToken: 'next-page',
    });
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('refuses a request without the secret, the wrong one, or an unset CRON_SECRET', async () => {
    expect((await GET(request('?apply=1'))).status).toBe(401);
    expect((await GET(request('?apply=1', 'nope'))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(request('?apply=1', 'cron-secret'))).status).toBe(401);
    expect(mockCheckKeys).not.toHaveBeenCalled();
    expect(mockListUsers).not.toHaveBeenCalled();
    expect(mockEnsureTrial).not.toHaveBeenCalled();
  });

  it.each(['TRIDANT_API_URL', 'TRIDANT_LICENSE_KEY'] as const)('answers 503 while %s is blank', async (key) => {
    process.env[key] = ' ';
    const res = await GET(request('?apply=1', 'cron-secret'));
    expect(res.status).toBe(503);
    expect(mockListUsers).not.toHaveBeenCalled();
  });

  it('starts trials before plans are switched on, telling each start it runs ahead of enforcement', async () => {
    const res = await GET(request('?apply=1', 'cron-secret'));
    expect(res.status).toBe(200);
    expect(mockEnsureTrial).toHaveBeenCalledWith('a', { beforeEnforcement: true });
    expect(mockEnsureTrial).toHaveBeenCalledWith('b', { beforeEnforcement: true });
    expect(mockPreviewTrial).not.toHaveBeenCalled();
  });

  it('still runs once plans are switched on', async () => {
    process.env.PLAN_ENFORCEMENT = 'on';
    expect((await GET(request('?apply=1', 'cron-secret'))).status).toBe(200);
    expect(mockEnsureTrial).toHaveBeenCalledTimes(2);
  });

  describe('dry run', () => {
    it('previews each eligible account, starts nothing, and answers its counts and the keys', async () => {
      const res = await GET(request('', 'cron-secret'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        apply: false,
        scanned: 6,
        eligible: 2,
        wouldStart: 2,
        already: 0,
        alreadySubscribed: 0,
        used: 0,
        linkRequired: 0,
        failed: 0,
        keys: KEYS_OK,
        nextPageToken: 'next-page',
      });
      expect(mockPreviewTrial).toHaveBeenCalledWith({ uid: 'a', email: 'a@example.com', name: 'name of Ann' });
      expect(mockPreviewTrial).toHaveBeenCalledWith({ uid: 'b', email: 'b@example.com', name: 'name of b@example.com' });
      expect(mockPreviewTrial).toHaveBeenCalledTimes(2);
      expect(mockEnsureTrial).not.toHaveBeenCalled();
    });

    it('files each preview under its count, a failure or an unnamed outcome under failed', async () => {
      const answers: Record<string, unknown> = {
        start: preview('would_create', 'would_start'),
        already: preview('linked', 'already'),
        subscribed: preview('linked', 'already_subscribed'),
        used: preview('would_create', 'used'),
        link: preview('link_required', null),
        unnamed: preview('linked', null),
        down: { ok: false, reason: 'unreachable' },
      };
      mockListUsers.mockResolvedValue({ users: Object.keys(answers).map((uid) => user(uid)) });
      mockPreviewTrial.mockImplementation(async ({ uid }: { uid: string }) => answers[uid]);

      const body = await (await GET(request('', 'cron-secret'))).json();

      expect(body).toMatchObject({
        apply: false,
        eligible: 7,
        wouldStart: 1,
        already: 1,
        alreadySubscribed: 1,
        used: 1,
        linkRequired: 1,
        failed: 2,
      });
      expect(body).not.toHaveProperty('started');
    });

    it('logs the uids that must link first or already used a trial, once for the page and with no email', async () => {
      mockListUsers.mockResolvedValue({ users: ['l1', 'u1', 'ok', 'l2'].map((uid) => user(uid)) });
      mockPreviewTrial.mockImplementation(async ({ uid }: { uid: string }) =>
        uid.startsWith('l')
          ? preview('link_required', null)
          : preview('would_create', uid === 'u1' ? 'used' : 'would_start'),
      );

      await GET(request('', 'cron-secret'));

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [message, meta] = (logger.info as jest.Mock).mock.calls[0];
      expect(message).toBe('[plan] trial preview');
      expect(meta.data.linkRequired.sort()).toEqual(['l1', 'l2']);
      expect(meta.data.used).toEqual(['u1']);
      expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('example.com');
    });

    it('still answers while the license key fails its check, and reports it', async () => {
      mockCheckKeys.mockResolvedValue([check('TRIDANT_LICENSE_KEY', { ok: false, reason: 'rejected' }), RELEASE_OK]);

      const res = await GET(request('', 'cron-secret'));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys[0]).toEqual({ keyName: 'TRIDANT_LICENSE_KEY', ok: false, reason: 'rejected', missing: [], expiresInDays: 40 });
      expect(mockPreviewTrial).toHaveBeenCalledTimes(2);
    });
  });

  describe('the key check before apply', () => {
    it.each([
      ['lacks a scope', { ok: false, missing: ['billing.write:prd_owlette_*'] }, 'it lacks billing.write:prd_owlette_*'],
      ['could not be read', { ok: false, reason: 'unreachable' }, 'its scopes could not be read: unreachable'],
    ])('answers 503 naming the license key when it %s, and starts nothing', async (_case, over, why) => {
      // picked by name, not by place.
      mockCheckKeys.mockResolvedValue([RELEASE_OK, check('TRIDANT_LICENSE_KEY', over)]);

      const res = await GET(request('?apply=1', 'cron-secret'));

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.detail).toBe(`TRIDANT_LICENSE_KEY failed its check (${why}), so no trial is started`);
      expect(body.keys.map((key: { keyName: string; ok: boolean }) => [key.keyName, key.ok])).toEqual([
        ['TRIDANT_RELEASE_KEY', true],
        ['TRIDANT_LICENSE_KEY', false],
      ]);
      expect(mockListUsers).not.toHaveBeenCalled();
      expect(mockEnsureTrial).not.toHaveBeenCalled();
    });

    it('answers 503 when no license key check came back', async () => {
      mockCheckKeys.mockResolvedValue([RELEASE_OK]);

      const res = await GET(request('?apply=1', 'cron-secret'));

      expect(res.status).toBe(503);
      expect(mockEnsureTrial).not.toHaveBeenCalled();
    });

    it('applies with a release key that fails its check, and reports it', async () => {
      mockCheckKeys.mockResolvedValue([
        LICENSE_OK,
        check('TRIDANT_RELEASE_KEY', { ok: false, missing: ['release.write:prd_owlette_*'] }),
      ]);

      const res = await GET(request('?apply=1', 'cron-secret'));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ apply: true, started: 2 });
      expect(body.keys[1]).toEqual({
        keyName: 'TRIDANT_RELEASE_KEY',
        ok: false,
        missing: ['release.write:prd_owlette_*'],
        expiresInDays: 40,
      });
      expect(mockEnsureTrial).toHaveBeenCalledTimes(2);
    });
  });

  it('starts a trial for the eligible accounts only, and answers the statuses and the keys', async () => {
    mockEnsureTrial.mockImplementation(async (uid: string) => ({ status: uid === 'a' ? 'started' : 'link_required' }));
    const body = await (await GET(request('?apply=1', 'cron-secret'))).json();
    expect(mockEnsureTrial.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    expect(body).toMatchObject({ apply: true, eligible: 2, started: 1, linkRequired: 1, failed: 0, keys: KEYS_OK });
    expect(body).not.toHaveProperty('wouldStart');
  });

  it('files every other status under its own count, errors under failed', async () => {
    const statuses = ['already_started', 'subscribed', 'trial_used', 'busy', 'error', 'unverified', 'off'];
    mockListUsers.mockResolvedValue({ users: statuses.map((s) => user(s)), pageToken: undefined });
    mockEnsureTrial.mockImplementation(async (uid: string) => ({ status: uid }));
    const body = await (await GET(request('?apply=1', 'cron-secret'))).json();
    expect(body).toMatchObject({ alreadyStarted: 1, subscribed: 1, trialUsed: 1, busy: 1, failed: 3, started: 0 });
  });

  it('pages 100 users at a time: passes pageToken on and answers null when done', async () => {
    mockListUsers.mockResolvedValue({ users: [user('c')], pageToken: undefined });
    const body = await (await GET(request('?pageToken=next-page', 'cron-secret'))).json();
    expect(mockListUsers).toHaveBeenCalledWith(100, 'next-page');
    expect(body.nextPageToken).toBeNull();
  });

  it.each([
    ['trials', '?apply=1'],
    ['previews', ''],
  ])('runs at most 10 %s at a time', async (_case, query) => {
    mockListUsers.mockResolvedValue({ users: Array.from({ length: 35 }, (_, i) => user(`u${i}`)) });
    let running = 0;
    let peak = 0;
    const slow = (answer: unknown) => async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return answer;
    };
    mockEnsureTrial.mockImplementation(slow({ status: 'started' }));
    mockPreviewTrial.mockImplementation(slow(preview('would_create', 'would_start')));
    const body = await (await GET(request(query, 'cron-secret'))).json();
    expect(body.started ?? body.wouldStart).toBe(35);
    expect(peak).toBe(10);
  });

  it.each(['?apply=1', ''])('answers no email or uid (%s)', async (query) => {
    const text = await (await GET(request(query, 'cron-secret'))).text();
    expect(text).not.toMatch(/example\.com|agent_|"a"/);
  });

  it('answers 500 when listing fails', async () => {
    mockListUsers.mockRejectedValue(new Error('auth down'));
    expect((await GET(request('', 'cron-secret'))).status).toBe(500);
  });
});
