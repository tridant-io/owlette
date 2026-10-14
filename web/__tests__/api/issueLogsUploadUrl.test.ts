/**
 * @jest-environment node
 *
 * POST /api/sites/{siteId}/machines/{machineId}/issue-logs/upload-url — only the
 * machine's own agent gets a url, the size is bounded, and the budget is per
 * machine. The agent check runs the real `resolveAgentPrincipal` on a stubbed
 * `verifyIdToken`; `requireMachineAuthAndScope`, which the route consults only for
 * a caller that is not an agent, is stubbed to let through anyone with site
 * access, which is what it does for a member session. Storage runs on its
 * OWLETTE_E2E stub.
 */

import { createMockRequest } from './helpers/utils';

const mockVerifyIdToken = jest.fn();
const mockMachineAuth = jest.fn();
const limiterCalls = new Map<string, number>();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args) }),
}));
jest.mock('@/app/api/_shared', () => ({
  ...jest.requireActual('@/app/api/_shared'),
  requireMachineAuthAndScope: (...args: unknown[]) => mockMachineAuth(...args),
}));
jest.mock('@/lib/rateLimit', () => ({
  ...jest.requireActual('@/lib/rateLimit'),
  checkRateLimit: async (_limiter: unknown, key: string) => {
    const n = (limiterCalls.get(key) ?? 0) + 1;
    limiterCalls.set(key, n);
    const reset = Date.now() + 60_000;
    return n <= 5
      ? { success: true, limit: 5, remaining: 5 - n, reset }
      : { success: false, limit: 5, remaining: 0, reset, retryAfter: 60 };
  },
}));

import { POST } from '@/app/api/sites/[siteId]/machines/[machineId]/issue-logs/upload-url/route';
import { ISSUE_LOGS_MAX_BYTES } from '@/lib/issueLogsStorage.server';

const SITE = 'site-1';
const MACHINE = 'machine-a';

function asAgent(machineId = MACHINE, siteId = SITE) {
  mockVerifyIdToken.mockResolvedValue({ uid: `agent-${machineId}`, role: 'agent', site_id: siteId, machine_id: machineId });
}

function call(body: Record<string, unknown> | undefined, headers: Record<string, string> = { Authorization: 'Bearer agent-token' }) {
  return POST(
    createMockRequest(`http://localhost/api/sites/${SITE}/machines/${MACHINE}/issue-logs/upload-url`, {
      method: 'POST',
      headers,
      body,
    }),
    { params: Promise.resolve({ siteId: SITE, machineId: MACHINE }) },
  );
}

const savedE2E = process.env.OWLETTE_E2E;

beforeEach(() => {
  process.env.OWLETTE_E2E = '1';
  limiterCalls.clear();
  mockVerifyIdToken.mockReset();
  mockMachineAuth.mockReset();
  mockMachineAuth.mockImplementation(async () => ({
    ok: true,
    userId: 'caller',
    auth: { userId: 'caller', keyContext: null },
    scopeCheck: { isLegacy: false },
  }));
});

afterAll(() => {
  if (savedE2E === undefined) delete process.env.OWLETTE_E2E;
  else process.env.OWLETTE_E2E = savedE2E;
});

describe('POST issue-logs/upload-url', () => {
  it("gives the machine's own agent a url, a key under its prefix and the ttl", async () => {
    asAgent();
    const res = await call({ size: 4096 });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['expiresIn', 'key', 'uploadUrl']);
    expect(body.key).toMatch(new RegExp(`^issues/${SITE}/${MACHINE}/[0-9a-f-]{36}\\.zip$`));
    expect(body.uploadUrl).toContain(body.key);
    expect(body.uploadUrl).toContain('size=4096');
    expect(body.expiresIn).toBe(900);
    expect(res.headers.get('RateLimit-Remaining')).toBe('4');
  });

  it("verifies the machine's own agent token once, without machine auth", async () => {
    asAgent();
    expect((await call({ size: 4096 })).status).toBe(200);
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(1);
    expect(mockMachineAuth).not.toHaveBeenCalled();
  });

  it('refuses an api key', async () => {
    const res = await call({ size: 4096 }, { Authorization: 'Bearer owk_test' });
    expect(res.status).toBe(403);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it("refuses a site member's session, which machine auth lets through", async () => {
    const res = await call({ size: 4096 }, {});
    expect(res.status).toBe(403);
    expect(mockMachineAuth).toHaveBeenCalled();
  });

  it('refuses a non-agent id token', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'user-1' });
    expect((await call({ size: 4096 })).status).toBe(403);
  });

  it("refuses another machine's agent before machine auth runs", async () => {
    asAgent('machine-b');
    const res = await call({ size: 4096 });
    expect(res.status).toBe(403);
    expect(mockMachineAuth).not.toHaveBeenCalled();
  });

  it('passes through what machine auth refuses, such as no credential', async () => {
    mockMachineAuth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await call({ size: 4096 }, {})).status).toBe(401);
  });

  it("leaves an expired agent token to machine auth's 401, so the agent refreshes", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('id-token-expired'));
    mockMachineAuth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await call({ size: 4096 })).status).toBe(401);
  });

  it.each([
    ['zero', { size: 0 }],
    ['one byte over the cap', { size: ISSUE_LOGS_MAX_BYTES + 1 }],
    ['a fraction', { size: 10.5 }],
    ['a string', { size: '4096' }],
    ['missing', {}],
  ])('400s a size that is %s', async (_label, body) => {
    asAgent();
    expect((await call(body)).status).toBe(400);
  });

  it('accepts exactly the cap', async () => {
    asAgent();
    expect((await call({ size: ISSUE_LOGS_MAX_BYTES })).status).toBe(200);
  });

  it('429s the sixth url in the window, keyed on the machine', async () => {
    asAgent();
    for (let i = 0; i < 5; i++) expect((await call({ size: 1 })).status).toBe(200);
    const limited = await call({ size: 1 });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(Array.from(limiterCalls.keys())).toEqual([`issue_logs_upload:${SITE}:${MACHINE}`]);
  });
});
