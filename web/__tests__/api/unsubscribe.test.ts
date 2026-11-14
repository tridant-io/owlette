/** @jest-environment node */

import crypto from 'crypto';
import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockSet = jest.fn();
const mockDoc = jest.fn((_uid: string) => ({ set: mockSet }));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: mockDoc }) }),
}));

import { GET, POST, generateUnsubscribeToken } from '@/app/api/unsubscribe/route';

const SECRET = 'test-cron-secret';

function tokenSignedWith(secret: string, userId: string): string {
  const signature = crypto.createHmac('sha256', secret).update(userId).digest('hex');
  return Buffer.from(`${userId}:${signature}`).toString('base64url');
}

const get = (query = '') => GET(createMockRequest(`http://localhost/api/unsubscribe${query}`));
const post = (body: Record<string, unknown>) =>
  POST(createMockRequest('http://localhost/api/unsubscribe', { method: 'POST', body }));

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  mockSet.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

describe('GET /api/unsubscribe (the link in alert emails)', () => {
  it('sends a valid link to the confirm page and changes nothing', async () => {
    const token = generateUnsubscribeToken('user-1');

    const res = await get(`?token=${token}`);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(`http://localhost/unsubscribe?token=${token}`);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('answers a missing token 400', async () => {
    const res = await get();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing token' });
  });

  it('answers a forged token 400', async () => {
    const res = await get(`?token=${tokenSignedWith('not-the-secret', 'user-1')}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' });
  });
});

describe('POST /api/unsubscribe (the confirm page)', () => {
  it('turns every alert email off for the token holder', async () => {
    const res = await post({ token: generateUnsubscribeToken('user-1') });

    expect(res.status).toBe(200);
    expect(mockDoc).toHaveBeenCalledWith('user-1');
    expect(mockSet).toHaveBeenCalledWith(
      {
        preferences: {
          healthAlerts: false,
          processAlerts: false,
          thresholdAlerts: false,
          cortexAlerts: false,
          displayAlerts: false,
          talonAlerts: false,
          apiKeyAlerts: false,
        },
      },
      { merge: true },
    );
  });

  it.each([
    ['missing', {}, 'Missing token'],
    ['forged', { token: tokenSignedWith('not-the-secret', 'user-1') }, 'Invalid or expired token'],
  ])('answers a %s token 400 and changes nothing', async (_kind, body, error) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('with no signing secret configured', () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('mints no token', () => {
    expect(() => generateUnsubscribeToken('user-1')).toThrow();
  });

  it('accepts no token, an empty key included', async () => {
    const token = tokenSignedWith('', 'user-1');

    expect((await get(`?token=${token}`)).status).toBe(400);
    expect((await post({ token })).status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
