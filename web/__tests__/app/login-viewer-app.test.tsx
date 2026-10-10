/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /login inside owlette swoop (dev/active/swoop-viewer, task 2.8). google and passkey sign-in both
 * fail in the app's webview, so one button hands the sign-in to the system browser: a pending
 * app-link code opens there, this page polls every 3 s until a signed-in browser approves it, then
 * signs in with the custom token and goes to the redirect.
 *
 * the browser case matters as much: outside the app the page must be exactly what it was.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import type { InAppBrowserState } from '@/hooks/useInAppBrowser';
import { AppLinkError } from '@/lib/appLink';

let viewerApp = true;
jest.mock('@/lib/swoop/viewerApp', () => ({
  isViewerApp: () => viewerApp,
  viewerAppPlatform: () => (viewerApp ? 'windows' : null),
}));

const mockStartAppLink = jest.fn();
const mockExchangeAppLink = jest.fn();
const mockCompleteAppLinkSignIn = jest.fn();
jest.mock('@/lib/appLink', () => ({
  ...jest.requireActual('@/lib/appLink'),
  startAppLink: (...args: unknown[]) => mockStartAppLink(...args),
  exchangeAppLink: (...args: unknown[]) => mockExchangeAppLink(...args),
  completeAppLinkSignIn: (...args: unknown[]) => mockCompleteAppLinkSignIn(...args),
}));

const mockStartAuthentication = jest.fn();
jest.mock('@simplewebauthn/browser', () => ({
  WebAuthnAbortService: { cancelCeremony: jest.fn() },
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(true),
  startAuthentication: (...args: unknown[]) => mockStartAuthentication(...args),
}));

const inAppState: InAppBrowserState = { isInApp: false, escapeAttempted: false };
jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => inAppState,
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false, signIn: jest.fn(), signInWithGoogle: jest.fn() }),
}));

const replace = jest.fn();
let search = '';
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace, prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import LoginPage from '@/app/login/page';

const CODE = 'pendingcodependingcode';
const SECRET = 'pollsecretpollsecret';
const APPROVE_URL = `${location.origin}/app-link/approve?code=${CODE}`;

const fetchMock = jest.fn();
const realFetch = global.fetch;
let openSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  viewerApp = true;
  search = '';
  // the browser case's conditional passkey ceremony asks for options first; leave it pending.
  fetchMock.mockReset().mockReturnValue(new Promise(() => {}));
  global.fetch = fetchMock as unknown as typeof fetch;
  mockStartAppLink.mockResolvedValue({
    code: CODE,
    secret: SECRET,
    approveUrl: `/app-link/approve?code=${CODE}`,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  mockExchangeAppLink.mockResolvedValue({ status: 'pending' });
  mockCompleteAppLinkSignIn.mockResolvedValue(undefined);
  openSpy = jest.spyOn(window, 'open').mockReturnValue({ opener: window } as unknown as Window);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = realFetch;
});

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));

async function renderPage() {
  render(<LoginPage />);
  // the webauthn autofill probe resolves on a microtask.
  await act(async () => {});
}

async function startBrowserSignIn() {
  await renderPage();
  fireEvent.click(screen.getByRole('button', { name: /sign in with your browser/i }));
  await act(async () => {});
}

describe('/login inside owlette swoop', () => {
  it('offers one browser button and hides google and passkey', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: /sign in with your browser/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with google/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /continue with passkey/i })).not.toBeInTheDocument();
    expect(screen.getByText('or use your email and password')).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('autocomplete', 'username');
  });

  it('never starts the passkey autofill ceremony', async () => {
    await renderPage();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockStartAuthentication).not.toHaveBeenCalled();
  });

  it("carries the window's controls in a strip across the top, the app's window having no frame", async () => {
    await renderPage();

    const strip = screen.getByTestId('swoop-window-strip');
    expect(strip).toContainElement(screen.getByRole('button', { name: 'close' }));
    expect(strip).toContainElement(screen.getByRole('button', { name: 'minimize' }));
  });

  it('opens the approval in the browser and polls every 3 s until it lands on the redirect', async () => {
    search = 'redirect=%2Fswoop%2Fsite-1%2Fkiosk.lobby';
    mockExchangeAppLink
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ customToken: 'custom-token' });

    await startBrowserSignIn();

    expect(openSpy).toHaveBeenCalledWith(APPROVE_URL, '_blank');
    expect(screen.getByRole('status')).toHaveTextContent('waiting for your browser…');

    await advance(2999);
    expect(mockExchangeAppLink).not.toHaveBeenCalled();
    await advance(1);
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(1);
    expect(mockExchangeAppLink).toHaveBeenCalledWith(CODE, SECRET);

    await advance(2999);
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(2);

    expect(mockCompleteAppLinkSignIn).toHaveBeenCalledWith('custom-token');
    expect(replace).toHaveBeenCalledWith('/swoop/site-1/kiosk.lobby');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('lands on /swoop without a redirect', async () => {
    mockExchangeAppLink.mockResolvedValueOnce({ customToken: 'custom-token' });

    await startBrowserSignIn();
    await advance(3000);

    expect(replace).toHaveBeenCalledWith('/swoop');
  });

  it.each([404, 410])('a %i says the link expired and gives the button back', async (status) => {
    mockExchangeAppLink.mockRejectedValue(new AppLinkError(status, 'gone'));

    await startBrowserSignIn();
    await advance(3000);

    expect(screen.getByRole('alert')).toHaveTextContent('that link expired, try again');
    expect(screen.getByRole('button', { name: /sign in with your browser/i })).toBeInTheDocument();
    await advance(30_000);
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(1);
    expect(mockCompleteAppLinkSignIn).not.toHaveBeenCalled();
  });

  it('keeps polling through a transient failure', async () => {
    mockExchangeAppLink
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ customToken: 'custom-token' });

    await startBrowserSignIn();
    await advance(6000);

    expect(mockExchangeAppLink).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('/swoop');
  });

  it('gives up after ten minutes, polling no faster than every 3 s', async () => {
    await startBrowserSignIn();
    await advance(597_000);
    expect(screen.getByRole('status')).toHaveTextContent('waiting for your browser…');
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(199);

    await advance(3000);
    expect(screen.getByRole('alert')).toHaveTextContent('that link expired, try again');
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(199);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancel stops the poll', async () => {
    await startBrowserSignIn();
    await advance(3000);
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(jest.getTimerCount()).toBe(0);
    await advance(30_000);
    expect(mockExchangeAppLink).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('waiting for your browser…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with your browser/i })).toBeInTheDocument();
  });

  // the app hands the url to the system browser and denies the in-app window, so window.open
  // returns null there even when the browser opened; the fallback cannot depend on it.
  it.each([
    ['null', null],
    ['a window', { opener: window } as unknown as Window],
  ])('keeps the approval link under the wait whatever window.open returns (%s)', async (_what, opened) => {
    openSpy.mockReturnValue(opened);

    await startBrowserSignIn();

    expect(screen.getByText(/didn.t open\?/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'open the sign-in page' });
    expect(link).toHaveAttribute('href', APPROVE_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener');
  });
});

describe('/login in a browser', () => {
  beforeEach(() => {
    viewerApp = false;
  });

  it('keeps google and passkey and has no browser button', async () => {
    await renderPage();

    expect(screen.getByRole('button', { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue with passkey/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with your browser/i })).not.toBeInTheDocument();
    expect(screen.queryByText('or use your email and password')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('autocomplete', 'username webauthn');
    expect(screen.queryByTestId('swoop-window-strip')).not.toBeInTheDocument();
  });
});
