/** @jest-environment node */

import crypto from 'crypto';
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockGetAdminDb = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockGetAdminDb(),
}));

import { POST } from '@/app/api/alerts/trigger/route';

function request(secret: string | null): NextRequest {
  return new NextRequest('http://localhost/api/alerts/trigger', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-internal-secret': secret }),
    },
    body: JSON.stringify({ siteId: 'site-a', machineId: 'mach-1' }),
  });
}

describe('POST /api/alerts/trigger and the internal secret', () => {
  beforeEach(() => {
    process.env.CORTEX_INTERNAL_SECRET = 'test-secret';
    mockGetAdminDb.mockReset();
  });

  afterEach(() => {
    delete process.env.CORTEX_INTERNAL_SECRET;
  });

  it.each([
    ['a wrong secret', 'test-secreT'],
    ['a prefix of it', 'test-'],
    ['an empty one', ''],
    ['none', null],
  ])('refuses %s with a 401, before reading anything', async (_label, secret) => {
    expect((await POST(request(secret))).status).toBe(401);
    expect(mockGetAdminDb).not.toHaveBeenCalled();
  });

  it('refuses everyone when the secret is not configured', async () => {
    delete process.env.CORTEX_INTERNAL_SECRET;
    expect((await POST(request(''))).status).toBe(401);
    expect(mockGetAdminDb).not.toHaveBeenCalled();
  });

  it('compares the secret in constant time', async () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      expect((await POST(request('test-secreT'))).status).toBe(401);
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      compare.mockRestore();
    }
  });
});
