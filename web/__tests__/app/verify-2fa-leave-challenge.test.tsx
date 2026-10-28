/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Leaving /verify-2fa must be a DOCUMENT LOAD, not `router.push`.
 *
 * Reported 2026-09-04 (Davor, production): passkey step-up completed but the screen
 * stayed on the challenge with the button still reading "waiting for passkey..."; a
 * manual refresh then landed on the dashboard — i.e. the cookie was flipped and only
 * the client-side navigation failed. `proxy.ts` redirects a gated destination here
 * while the session is `mfaVerified: false`, including the prefetch next/link fires
 * for "go to dashboard" in the landing header, and the App Router caches that redirect
 * against the destination segment. A push then resolves to the cached redirect and
 * returns to this page.
 *
 * These tests fail against the old behaviour (`router.push(returnUrl)`), which is what
 * makes them a regression guard rather than a restatement of the implementation.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const signOut = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1', email: 'davor@example.com' },
    loading: false,
    signOut,
  }),
}));

const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams('redirect=/dashboard'),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => ({ isInApp: false }),
}));

// jsdom has no WebAuthn: without this the passkey button never renders.
const startAuthentication = jest.fn();
jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
}));

// The page reads `users/{uid}` to confirm there is a live challenge to satisfy.
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({
    exists: () => true,
    data: () => ({ mfaEnrolled: true }),
  })),
}));

import Verify2FAPage from '@/app/verify-2fa/page';

const assign = jest.fn();

beforeAll(() => {
  // jsdom's own location would attempt a real navigation and warn; replacing the
  // object is the only way to observe assign().
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign, href: 'http://localhost/verify-2fa', origin: 'http://localhost' },
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

const renderPage = async () => {
  const user = userEvent.setup();
  render(<Verify2FAPage />);
  // Wait out the post-hydration WebAuthn check so clicks aren't racing it.
  await screen.findByRole('button', { name: /use a passkey/i });
  return user;
};

it('passkey step-up leaves with a document load, not a client-side push', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/passkeys/step-up/options')) {
      return {
        ok: true,
        json: async () => ({ options: { challenge: 'x' }, challengeId: 'c1' }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  startAuthentication.mockResolvedValue({ id: 'cred' });

  const user = await renderPage();
  await user.click(screen.getByRole('button', { name: /use a passkey/i }));

  await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'));
  expect(push).not.toHaveBeenCalled();
});

it('code verification leaves with a document load, not a client-side push', async () => {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, deviceTrusted: false }),
  })) as unknown as typeof fetch;

  const user = await renderPage();
  await user.type(screen.getByPlaceholderText('000000'), '123456');
  await user.click(screen.getByRole('button', { name: /^verify$/i }));

  await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'));
  expect(push).not.toHaveBeenCalled();
});

// the proxy also answers /login with a redirect here while the challenge is
// pending, so cancel needs a document load too. on next 16.4 a push no longer
// replays the redirect the e2e cancel spec prefetches, so this is the guard.
it('cancel leaves with a document load, not a client-side push', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  signOut.mockResolvedValue(undefined);

  const user = await renderPage();
  await user.click(screen.getByRole('button', { name: 'cancel and sign out' }));

  await waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  expect(signOut).toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
});
