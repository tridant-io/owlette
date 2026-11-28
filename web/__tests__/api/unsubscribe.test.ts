/** @jest-environment node */

import crypto from 'crypto';
import { NextRequest } from 'next/server';
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

describe('POST /api/unsubscribe { token, delivery: weekly } (weekly digest instead)', () => {
  it('moves the person to the weekly digest and leaves every alert email on', async () => {
    const res = await post({ token: generateUnsubscribeToken('user-1'), delivery: 'weekly' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivery: 'weekly' });
    expect(mockDoc).toHaveBeenCalledWith('user-1');
    expect(mockSet).toHaveBeenCalledWith({ preferences: { alertDelivery: 'weekly' } }, { merge: true });
  });

  it('reads any other delivery as the turn-off button', async () => {
    await post({ token: generateUnsubscribeToken('user-1'), delivery: 'immediate' });
    expect(mockSet).toHaveBeenCalledWith({ preferences: expect.objectContaining({ healthAlerts: false }) }, { merge: true });
  });
});

describe('POST /api/unsubscribe?token= (RFC 8058 one-click, from the List-Unsubscribe header)', () => {
  const oneClick = (query: string, body = 'List-Unsubscribe=One-Click') =>
    POST(
      new NextRequest(`http://localhost/api/unsubscribe${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
    );

  it('turns every alert email off for the token in the link', async () => {
    const res = await oneClick(`?token=${generateUnsubscribeToken('user-1')}`);

    expect(res.status).toBe(200);
    expect(mockDoc).toHaveBeenCalledWith('user-1');
    expect(mockSet).toHaveBeenCalledWith(
      { preferences: expect.objectContaining({ healthAlerts: false, apiKeyAlerts: false }) },
      { merge: true },
    );
  });

  it('takes the multipart/form-data encoding RFC 8058 prefers', async () => {
    const form = new FormData();
    form.append('List-Unsubscribe', 'One-Click');
    const res = await POST(
      new NextRequest(`http://localhost/api/unsubscribe?token=${generateUnsubscribeToken('user-1')}`, { method: 'POST', body: form }),
    );

    expect(res.status).toBe(200);
    expect(mockDoc).toHaveBeenCalledWith('user-1');
    expect(mockSet).toHaveBeenCalledWith(
      { preferences: expect.objectContaining({ healthAlerts: false, apiKeyAlerts: false }) },
      { merge: true },
    );
  });

  it.each([
    ['a missing token', '', 'List-Unsubscribe=One-Click', 'Missing token'],
    ['a forged token', `?token=${tokenSignedWith('not-the-secret', 'user-1')}`, 'List-Unsubscribe=One-Click', 'Invalid or expired token'],
    ['another form body', '?token=x', 'unsubscribe=yes', 'Not a one-click unsubscribe'],
  ])('answers %s 400 and changes nothing', async (_kind, query, body, error) => {
    const res = await oneClick(query, body);

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
