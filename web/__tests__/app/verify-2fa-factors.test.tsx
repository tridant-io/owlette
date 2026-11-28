/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * /verify-2fa asks only for the factors the account holds and this page can
 * run: no authenticator code for a passkey-only account, no passkey for one
 * without, and inside owlette swoop, where passkeys do not run (ADR 0012), a
 * passkey-only account is told how to use it and offered a backup code. an
 * inventory that reads empty is never a page with no way in.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let factors: { totp: boolean; passkeys: number; backupCodes?: number } = { totp: true, passkeys: 0 };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1', email: 'owner@example.com' },
    loading: false,
    signOut: jest.fn(),
    mfaFactors: factors,
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams('redirect=/dashboard'),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => ({ isInApp: false }),
}));

let viewerApp = false;
jest.mock('@/hooks/useViewerAppPlatform', () => ({
  useViewerAppPlatform: () => (viewerApp ? 'windows' : null),
}));

jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: jest.fn(),
}));

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(() => ({})),
  getDoc: jest.fn(async () => ({ exists: () => true, data: () => ({ mfaEnrolled: true }) })),
}));

import Verify2FAPage from '@/app/verify-2fa/page';

beforeEach(() => {
  factors = { totp: true, passkeys: 0 };
  viewerApp = false;
});

it('a passkey-only account is offered its passkey and a backup code, never an authenticator code', async () => {
  factors = { totp: false, passkeys: 1 };
  render(<Verify2FAPage />);

  expect(await screen.findByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('000000')).toBeNull();
  expect(screen.queryByText('enter the code from your authenticator app')).toBeNull();
  expect(screen.queryByRole('button', { name: 'use authenticator app instead' })).toBeNull();
  expect(screen.getByRole('button', { name: 'use a backup code instead' })).toBeInTheDocument();
});

it('an authenticator-only account is offered its code and a backup code, never a passkey', () => {
  render(<Verify2FAPage />);

  expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'use backup code instead' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'use a passkey' })).toBeNull();
});

it('an account with both is offered both', async () => {
  factors = { totp: true, passkeys: 2 };
  render(<Verify2FAPage />);

  expect(await screen.findByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
});

it('inside owlette swoop a passkey-only account gets a backup code and is told how to use its passkey', () => {
  viewerApp = true;
  factors = { totp: false, passkeys: 1 };
  render(<Verify2FAPage />);

  expect(screen.queryByRole('button', { name: 'use a passkey' })).toBeNull();
  expect(screen.queryByPlaceholderText('000000')).toBeNull();
  expect(screen.getByPlaceholderText('backup code')).toBeInTheDocument();
  expect(
    screen.getByText('passkeys cannot be used inside owlette swoop — sign in with your browser to use yours.'),
  ).toBeInTheDocument();
});

it('an inventory that reads empty offers every way in rather than none', async () => {
  factors = { totp: false, passkeys: 0 };
  render(<Verify2FAPage />);

  expect(await screen.findByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
});

describe('an account with no backup codes left', () => {
  it('a passkey-only account gets its passkey alone, with no backup link', async () => {
    factors = { totp: false, passkeys: 1, backupCodes: 0 };
    render(<Verify2FAPage />);

    expect(await screen.findByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'use a backup code instead' })).toBeNull();
    expect(screen.queryByPlaceholderText('backup code')).toBeNull();
  });

  it('an authenticator account gets its code with no backup switch', () => {
    factors = { totp: true, passkeys: 0, backupCodes: 0 };
    render(<Verify2FAPage />);

    expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'use backup code instead' })).toBeNull();
  });

  it('inside owlette swoop a passkey-only account is told how to use its passkey, with no code field', () => {
    viewerApp = true;
    factors = { totp: false, passkeys: 1, backupCodes: 0 };
    render(<Verify2FAPage />);

    expect(
      screen.getByText('passkeys cannot be used inside owlette swoop — sign in with your browser to use yours.'),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('backup code')).toBeNull();
    expect(screen.queryByRole('button', { name: 'verify' })).toBeNull();
    // no passkey button here, so nothing asks to confirm with one
    expect(screen.queryByText('confirm it with your passkey')).toBeNull();
  });
});
