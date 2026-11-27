/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the browser half of owlette swoop's step-up asks only for what the account
 * holds, as the dialog does: a passkey-only account gets its passkey and its
 * backup codes, never an authenticator code; an authenticator account gets its
 * code; and an inventory that reads empty offers every way in rather than none.
 */

import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';

let factors: { totp: boolean; passkeys: number; backupCodes?: number } = { totp: true, passkeys: 0 };
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'owner@example.com' },
    loading: false,
    signOut: jest.fn(),
    mfaFactors: factors,
  }),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

// the system browser, where a passkey prompt runs
jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: jest.fn(),
}));

jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => ({ isInApp: false }),
}));

import SwoopVerifyPage from '@/app/swoop/[siteId]/[machineId]/verify/page';

beforeEach(() => {
  factors = { totp: true, passkeys: 0 };
});

async function renderVerify() {
  const params = Promise.resolve({ siteId: 'site-1', machineId: 'machine-1' });
  await act(async () =>
    render(
      <Suspense fallback={null}>
        <SwoopVerifyPage params={params} />
      </Suspense>,
    ),
  );
}

it('a passkey-only account gets its passkey and a backup code, never an authenticator code', async () => {
  factors = { totp: false, passkeys: 1, backupCodes: 2 };
  await renderVerify();

  expect(screen.getByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'use a backup code instead' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'enter a code instead' })).toBeNull();
  expect(screen.queryByLabelText('authenticator code')).toBeNull();
});

it('a passkey-only account with no backup codes left gets its passkey alone', async () => {
  factors = { totp: false, passkeys: 1, backupCodes: 0 };
  await renderVerify();

  expect(screen.getByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'use a backup code instead' })).toBeNull();
  expect(screen.queryByText(/no second factor/)).toBeNull();
});

it('an authenticator-only account gets its code, and no passkey', async () => {
  await renderVerify();

  expect(screen.getByLabelText('authenticator code')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'use a passkey' })).toBeNull();
});

it('an inventory that reads empty offers every way in rather than none', async () => {
  factors = { totp: false, passkeys: 0 };
  await renderVerify();

  expect(screen.getByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'enter a code instead' })).toBeInTheDocument();
  expect(screen.queryByText(/no second factor/)).toBeNull();
});
