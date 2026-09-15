/**
 * @jest-environment jsdom
 *
 * AuthContext publishes `userSites` only once access has RESOLVED — the user doc
 * and the membership listener have both delivered for the signed-in uid.
 *
 * Incident 2026-09-14: reloading the dashboard intermittently opened NODE NYC
 * instead of the last viewed TEC Prod. The two listeners race. When membership
 * rows landed first, `role` was still null, so a superadmin was published as a
 * member of just their membership sites; `useSites` settled on that handful and
 * the dashboard latched `sites[0]` before `lastSiteId` had even arrived.
 *
 * Mounts the real provider with Firebase mocked at the listener boundary, so the
 * ORDER of deliveries is under the test's control.
 */
import { useEffect } from 'react';
import { act, render } from '@testing-library/react';

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {}, storage: null }));

type AuthCallback = (user: unknown) => Promise<void>;
let authCallback: AuthCallback | null = null;

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: jest.fn((_auth: unknown, cb: AuthCallback) => {
    authCallback = cb;
    return () => {};
  }),
  GoogleAuthProvider: class {},
  EmailAuthProvider: { credential: jest.fn() },
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(),
  getAdditionalUserInfo: jest.fn(),
  signInWithPopup: jest.fn(),
  updateProfile: jest.fn(),
  updatePassword: jest.fn(),
  reauthenticateWithCredential: jest.fn(),
}));

type Listener = (snap: unknown) => void | Promise<void>;
const listeners = new Map<string, Listener>();

jest.mock('firebase/firestore', () => ({
  doc: jest.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  setDoc: jest.fn(async () => {}),
  collectionGroup: jest.fn((_db: unknown, id: string) => ({ __path: `group:${id}` })),
  where: jest.fn(() => ({})),
  query: jest.fn((ref: unknown) => ref),
  onSnapshot: jest.fn((ref: { __path: string }, next: Listener) => {
    listeners.set(ref.__path, next);
    return () => {};
  }),
}));

jest.mock('firebase/storage', () => ({
  ref: jest.fn(),
  uploadBytes: jest.fn(),
  getDownloadURL: jest.fn(),
  deleteObject: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  setUser: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const emitMembershipFallback = jest.fn();
jest.mock('@/lib/membershipMetrics', () => ({
  emitMembershipFallback: (...args: unknown[]) => emitMembershipFallback(...args),
  emitMembershipListenerError: jest.fn(),
}));

import { AuthProvider, useAuth } from '@/contexts/AuthContext';

const UID = 'dylan';
const USER = { uid: UID, email: 'dylan@example.com', displayName: 'Dylan', getIdToken: async () => 'id-token' };

/** Latest committed context value, captured by a probe inside the provider. */
let seen: ReturnType<typeof useAuth>;
function Probe() {
  const value = useAuth();
  useEffect(() => {
    seen = value;
  });
  return null;
}

async function signIn() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  if (!authCallback) throw new Error('onAuthStateChanged was never subscribed');
  await act(async () => {
    await authCallback!(USER);
  });
}

async function deliverMemberships(siteIds: string[]) {
  const next = listeners.get('group:members');
  if (!next) throw new Error('membership listener not subscribed');
  await act(async () => {
    await next({
      forEach: (cb: (d: unknown) => void) =>
        siteIds.forEach((siteId) =>
          cb({
            ref: { parent: { parent: { id: siteId } } },
            data: () => ({ uid: UID, status: 'active', role: 'owner' }),
          }),
        ),
    });
  });
}

async function deliverUserDoc(data: Record<string, unknown>) {
  const next = listeners.get(`users/${UID}`);
  if (!next) throw new Error('user doc listener not subscribed');
  await act(async () => {
    await next({ exists: () => true, data: () => data });
  });
}

beforeEach(() => {
  authCallback = null;
  listeners.clear();
  emitMembershipFallback.mockClear();
  global.fetch = jest.fn(async () => ({ ok: true, text: async () => '' })) as unknown as typeof fetch;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AuthContext — userSites waits for resolved access', () => {
  it('membership first: withholds userSites while role is still unread', async () => {
    await signIn();

    // The incident order. The old provider published ['node-nyc'] here with
    // isSuperadmin=false — a superadmin reading as a one-site member.
    await deliverMemberships(['node-nyc']);
    expect(seen.userSites).toBeUndefined();
    expect(seen.isSuperadmin).toBe(false);

    await deliverUserDoc({ role: 'superadmin', sites: [], lastSiteId: 'tec-prod' });
    expect(seen.userSites).toEqual(['node-nyc']);
    expect(seen.isSuperadmin).toBe(true);
    expect(seen.lastSiteId).toBe('tec-prod');
  });

  it('user doc first: withholds userSites until memberships land, and counts no fallback', async () => {
    await signIn();

    await deliverUserDoc({ role: 'member', sites: ['site-a', 'site-b'], lastSiteId: 'site-b' });
    expect(seen.userSites).toBeUndefined();
    // Unioned against an empty, not-yet-loaded role map, every legacy site
    // would read as a membership fallback and be reported to Sentry.
    expect(emitMembershipFallback).not.toHaveBeenCalled();

    await deliverMemberships(['site-a', 'site-b']);
    expect(seen.userSites).toEqual(['site-a', 'site-b']);
    expect(emitMembershipFallback).not.toHaveBeenCalled();
  });

  it('still counts a genuine fallback once access has resolved', async () => {
    await signIn();

    await deliverUserDoc({ role: 'member', sites: ['site-a', 'legacy-only'], lastSiteId: null });
    await deliverMemberships(['site-a']);

    expect(seen.userSites).toEqual(['legacy-only', 'site-a']);
    expect(emitMembershipFallback).toHaveBeenCalledWith(UID, ['legacy-only']);
  });
});
