/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockRunPlanDaily = jest.fn();
jest.mock('@/lib/planUsage.server', () => ({
  runPlanDaily: () => mockRunPlanDaily(),
}));

import { GET } from '@/app/api/cron/plan-daily/route';

function request(secret?: string) {
  return new NextRequest('http://localhost/api/cron/plan-daily', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });
}

const SUMMARY = {
  ok: true,
  day: '2026-10-07',
  sites: 2,
  payers: 1,
  machines: 3,
  snapshots: 1,
  pruned: 0,
  errors: 0,
};

describe('GET /api/cron/plan-daily', () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = 'cron-secret';
    mockRunPlanDaily.mockReset();
    mockRunPlanDaily.mockResolvedValue(SUMMARY);
  });

  afterAll(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it('refuses a request without the secret', async () => {
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockRunPlanDaily).not.toHaveBeenCalled();
  });

  it('refuses the wrong secret', async () => {
    const res = await GET(request('nope'));
    expect(res.status).toBe(401);
    expect(mockRunPlanDaily).not.toHaveBeenCalled();
  });

  it('refuses everything when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(401);
    expect(mockRunPlanDaily).not.toHaveBeenCalled();
  });

  it('runs the job and answers its summary', async () => {
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SUMMARY);
  });

  it('answers 500 when the run throws', async () => {
    mockRunPlanDaily.mockRejectedValue(new Error('sites query failed'));
    const res = await GET(request('cron-secret'));
    expect(res.status).toBe(500);
  });
});
