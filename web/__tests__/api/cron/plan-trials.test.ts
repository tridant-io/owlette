/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockListUsers = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ listUsers: (...args: unknown[]) => mockListUsers(...args) }),
}));

// plan.server is the real one: whether the route runs is decided by the env it reads.
const mockEnsureTrial = jest.fn();
jest.mock('@/lib/planTrial.server', () => ({ ensureTrial: (...args: unknown[]) => mockEnsureTrial(...args) }));

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

const ENV_KEYS = ['CRON_SECRET', 'PLAN_ENFORCEMENT', 'TRIDANT_API_URL', 'TRIDANT_LICENSE_KEY', 'OWLETTE_E2E'] as const;

describe('GET /api/cron/plan-trials', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret';
    // tridant id configured and plans still switched off: the state the bulk start runs in.
    delete process.env.PLAN_ENFORCEMENT;
    delete process.env.OWLETTE_E2E;
    process.env.TRIDANT_API_URL = 'https://api.tridant.test';
    process.env.TRIDANT_LICENSE_KEY = 'tk_test';
    mockEnsureTrial.mockReset().mockResolvedValue({ status: 'started' });
    mockListUsers.mockReset().mockResolvedValue({
      users: [
        user('a'),
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
  });

  it('still runs once plans are switched on', async () => {
    process.env.PLAN_ENFORCEMENT = 'on';
    expect((await GET(request('?apply=1', 'cron-secret'))).status).toBe(200);
    expect(mockEnsureTrial).toHaveBeenCalledTimes(2);
  });

  it('counts the eligible accounts and calls nothing on a dry run', async () => {
    const res = await GET(request('', 'cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      apply: false,
      scanned: 6,
      eligible: 2,
      started: 0,
      alreadyStarted: 0,
      linkRequired: 0,
      subscribed: 0,
      busy: 0,
      failed: 0,
      nextPageToken: 'next-page',
    });
    expect(mockEnsureTrial).not.toHaveBeenCalled();
  });

  it('starts a trial for the eligible accounts only, and counts the statuses', async () => {
    mockEnsureTrial.mockImplementation(async (uid: string) => ({ status: uid === 'a' ? 'started' : 'link_required' }));
    const body = await (await GET(request('?apply=1', 'cron-secret'))).json();
    expect(mockEnsureTrial.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    expect(body).toMatchObject({ apply: true, eligible: 2, started: 1, linkRequired: 1, failed: 0 });
  });

  it('files every other status under its own count, errors under failed', async () => {
    const statuses = ['already_started', 'subscribed', 'busy', 'error', 'unverified', 'off'];
    mockListUsers.mockResolvedValue({ users: statuses.map((s) => user(s)), pageToken: undefined });
    mockEnsureTrial.mockImplementation(async (uid: string) => ({ status: uid }));
    const body = await (await GET(request('?apply=1', 'cron-secret'))).json();
    expect(body).toMatchObject({ alreadyStarted: 1, subscribed: 1, busy: 1, failed: 3, started: 0 });
  });

  it('pages 100 users at a time: passes pageToken on and answers null when done', async () => {
    mockListUsers.mockResolvedValue({ users: [user('c')], pageToken: undefined });
    const body = await (await GET(request('?pageToken=next-page', 'cron-secret'))).json();
    expect(mockListUsers).toHaveBeenCalledWith(100, 'next-page');
    expect(body.nextPageToken).toBeNull();
  });

  it('runs at most 10 trials at a time', async () => {
    mockListUsers.mockResolvedValue({ users: Array.from({ length: 35 }, (_, i) => user(`u${i}`)) });
    let running = 0;
    let peak = 0;
    mockEnsureTrial.mockImplementation(async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return { status: 'started' };
    });
    const body = await (await GET(request('?apply=1', 'cron-secret'))).json();
    expect(body.started).toBe(35);
    expect(peak).toBe(10);
  });

  it('answers no email or uid', async () => {
    const text = await (await GET(request('?apply=1', 'cron-secret'))).text();
    expect(text).not.toMatch(/example\.com|agent_|"a"/);
  });

  it('answers 500 when listing fails', async () => {
    mockListUsers.mockRejectedValue(new Error('auth down'));
    expect((await GET(request('', 'cron-secret'))).status).toBe(500);
  });
});
