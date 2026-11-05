/** @jest-environment node */

/**
 * the verified-network list against an in-memory firestore: the mode switch,
 * what a sign-in ceremony records, expiry on read, and the once-per-network notice.
 */

import { NextRequest } from 'next/server';

const mockStore = new Map<string, Record<string, unknown>>();

function mockDoc(path: string) {
  return {
    path,
    get: async () => ({ exists: mockStore.has(path), data: () => mockStore.get(path) }),
    collection: (name: string) => mockCollection(`${path}/${name}`),
  };
}

function mockCollection(path: string) {
  return { doc: (id: string) => mockDoc(`${path}/${id}`) };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => mockCollection(name),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: (ref: ReturnType<typeof mockDoc>) => ref.get(),
        set: (ref: ReturnType<typeof mockDoc>, data: Record<string, unknown>) => {
          mockStore.set(ref.path, { ...(mockStore.get(ref.path) ?? {}), ...data });
        },
      }),
  }),
}));

const mockSendEmail = jest.fn(async (..._a: unknown[]) => ({ error: null }));
jest.mock('@/lib/resendClient.server', () => ({
  ...jest.requireActual('@/lib/resendClient.server'),
  getResend: () => ({ emails: { send: (...a: unknown[]) => mockSendEmail(...a) } }),
}));

import {
  isVerifiedNetwork,
  networkBindingMode,
  signInCeremonyNetwork,
  VERIFIED_NETWORK_TTL_MS,
} from '@/lib/swoop/networks.server';

const EDGE = 'edge-secret-for-tests';
const USER = 'user-1';
const ENTRY = `users/${USER}/verified_networks/asn:64500`;

const fromEdge = (asn: string) =>
  new NextRequest('http://localhost/api/mfa/verify-login', {
    headers: { 'x-owlette-edge': EDGE, 'x-owlette-asn': asn },
  });

beforeEach(() => {
  mockStore.clear();
  mockSendEmail.mockClear();
  mockStore.set(`users/${USER}`, { email: 'someone@example.test' });
  process.env.EDGE_SHARED_SECRET = EDGE;
});

afterEach(() => {
  delete process.env.EDGE_SHARED_SECRET;
  delete process.env.SWOOP_NETWORK_BINDING;
});

describe('networkBindingMode', () => {
  it('logs unless told otherwise, and reads anything unrecognised as the default', () => {
    expect(networkBindingMode()).toBe('log');
    for (const [raw, mode] of [
      ['off', 'off'],
      [' Enforce ', 'enforce'],
      ['enforced', 'log'],
      ['', 'log'],
    ]) {
      process.env.SWOOP_NETWORK_BINDING = raw;
      expect([raw, networkBindingMode()]).toEqual([raw, mode]);
    }
  });
});

describe('signInCeremonyNetwork', () => {
  it('verifies the network in log mode and answers its key, sending no notice', async () => {
    expect(await signInCeremonyNetwork(fromEdge('64500'), USER)).toBe('asn:64500');

    expect(mockStore.get(ENTRY)).toEqual({
      firstSeenAt: expect.any(Number),
      lastVerifiedAt: expect.any(Number),
      asn: '64500',
      label: 'AS64500',
    });
    expect(await isVerifiedNetwork(USER, 'asn:64500')).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('answers unknown for a request the edge did not vouch for, and verifies nothing', async () => {
    const request = new NextRequest('http://localhost/x', { headers: { 'x-owlette-asn': '64500' } });

    expect(await signInCeremonyNetwork(request, USER)).toBe('unknown');
    expect(mockStore.has(ENTRY)).toBe(false);
  });

  it('records nothing and answers nothing when the binding is off', async () => {
    process.env.SWOOP_NETWORK_BINDING = 'off';

    expect(await signInCeremonyNetwork(fromEdge('64500'), USER)).toBeUndefined();
    expect(mockStore.has(ENTRY)).toBe(false);
  });

  it('enforced, emails the first ceremony on a network and never the next', async () => {
    process.env.SWOOP_NETWORK_BINDING = 'enforce';

    await signInCeremonyNetwork(fromEdge('64500'), USER);
    const firstSeenAt = mockStore.get(ENTRY)?.firstSeenAt;
    await signInCeremonyNetwork(fromEdge('64500'), USER);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'someone@example.test', subject: 'new network verified for swoop control' }),
    );
    expect(mockStore.get(ENTRY)?.firstSeenAt).toBe(firstSeenAt);
  });

  it('enforced, sends no notice for a network first verified while logging', async () => {
    await signInCeremonyNetwork(fromEdge('64500'), USER);
    process.env.SWOOP_NETWORK_BINDING = 'enforce';
    await signInCeremonyNetwork(fromEdge('64500'), USER);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('isVerifiedNetwork', () => {
  it('lapses 7 days after the last ceremony on the network, with no scheduler', async () => {
    const now = Date.now();
    mockStore.set(ENTRY, { lastVerifiedAt: now - VERIFIED_NETWORK_TTL_MS });
    expect(await isVerifiedNetwork(USER, 'asn:64500', now)).toBe(true);
    expect(await isVerifiedNetwork(USER, 'asn:64500', now + 1)).toBe(false);
  });

  it('never verifies unknown, whatever is stored under it', async () => {
    mockStore.set(`users/${USER}/verified_networks/unknown`, { lastVerifiedAt: Date.now() });
    expect(await isVerifiedNetwork(USER, 'unknown')).toBe(false);
  });
});
