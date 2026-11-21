/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockRunPlanSettle = jest.fn();
jest.mock('@/lib/planSettle.server', () => ({
  runPlanSettle: () => mockRunPlanSettle(),
}));

import { GET } from '@/app/api/cron/plan-settle/route';

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/plan-settle', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const SUMMARY = { ok: true, candidates: 2, sent: 2, settled: 2, errors: 0 };

describe('GET /api/cron/plan-settle', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret';
    mockRunPlanSettle.mockReset();
    mockRunPlanSettle.mockResolvedValue(SUMMARY);
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('refuses a request without the secret', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockRunPlanSettle).not.toHaveBeenCalled();
  });

  it('refuses the wrong secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(mockRunPlanSettle).not.toHaveBeenCalled();
  });

  it('refuses everything when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(401);
    expect(mockRunPlanSettle).not.toHaveBeenCalled();
  });

  it('runs the pass and answers its summary', async () => {
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);
  });

  it('answers 500 when the run throws', async () => {
    mockRunPlanSettle.mockRejectedValue(new Error('usage query failed'));
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(500);
  });
});
