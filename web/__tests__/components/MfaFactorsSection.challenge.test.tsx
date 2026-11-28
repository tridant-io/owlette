/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * account settings' "verify a factor you already have" callout offers only what
 * the account holds and this page can run, as every other second-factor screen
 * does: the passkey only with one, and only where a prompt can run, and the
 * code link names a backup code for an account with no authenticator app. where
 * none of its ways can run, it says how to use the passkey. removing the
 * authenticator app offers a backup code only while one is left.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MfaFactorsSection } from '@/components/MfaFactorsSection';

let snapshot = {
  totp: { enrolled: true, enrolledAt: null as string | null },
  passkeys: [] as Array<{ credentialId: string }>,
  totalFactors: 1,
  backupCodeCount: 10,
  mfaVerified: false,
};

jest.mock('@/hooks/useMfaFactors', () => ({
  useMfaFactors: () => ({
    factors: snapshot,
    loading: false,
    error: null,
    refresh: jest.fn(),
    removeTotp: jest.fn(),
    stepUpWithPasskey: jest.fn(),
  }),
}));

jest.mock('@/components/PasskeyManager', () => ({ PasskeyManager: () => null }));

jest.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: jest.fn(),
}));

let viewerApp = false;
jest.mock('@/hooks/useViewerAppPlatform', () => ({
  useViewerAppPlatform: () => (viewerApp ? 'windows' : null),
}));

jest.mock('@/hooks/useInAppBrowser', () => ({
  useInAppBrowser: () => ({ isInApp: false }),
}));

function withFactors(totp: boolean, passkeys: number, backupCodeCount = 10) {
  snapshot = {
    totp: { enrolled: totp, enrolledAt: null },
    passkeys: Array.from({ length: passkeys }, (_, i) => ({ credentialId: `cred-${i}` })),
    totalFactors: (totp ? 1 : 0) + passkeys,
    backupCodeCount,
    mfaVerified: false,
  };
}

beforeEach(() => {
  viewerApp = false;
});

it('an authenticator-only account is sent to a code, with no passkey', () => {
  withFactors(true, 0);
  render(<MfaFactorsSection userId="u1" />);

  expect(screen.queryByRole('button', { name: 'verify with passkey' })).toBeNull();
  expect(screen.getByRole('link', { name: 'use a code instead' })).toBeInTheDocument();
});

it('a passkey-only account verifies with its passkey, or a backup code', () => {
  withFactors(false, 1);
  render(<MfaFactorsSection userId="u1" />);

  expect(screen.getByRole('button', { name: 'verify with passkey' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'use a backup code instead' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'use a code instead' })).toBeNull();
});

it('inside owlette swoop a passkey-only account is offered no passkey prompt', () => {
  viewerApp = true;
  withFactors(false, 1);
  render(<MfaFactorsSection userId="u1" />);

  expect(screen.queryByRole('button', { name: 'verify with passkey' })).toBeNull();
  expect(screen.getByRole('link', { name: 'use a backup code instead' })).toBeInTheDocument();
});

it('a passkey-only account with no backup codes left is offered only its passkey', () => {
  withFactors(false, 1, 0);
  render(<MfaFactorsSection userId="u1" />);

  expect(screen.getByRole('button', { name: 'verify with passkey' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /use a (backup )?code instead/ })).toBeNull();
});

it('inside owlette swoop a passkey-only account with no backup codes left is told how to use its passkey', () => {
  viewerApp = true;
  withFactors(false, 1, 0);
  render(<MfaFactorsSection userId="u1" />);

  expect(screen.queryByRole('button', { name: 'verify with passkey' })).toBeNull();
  expect(screen.queryByRole('link', { name: /use a (backup )?code instead/ })).toBeNull();
  expect(
    screen.getByText('passkeys cannot be used inside owlette swoop — sign in with your browser to use yours.'),
  ).toBeInTheDocument();
});

describe('removing the authenticator app', () => {
  function openRemove() {
    render(<MfaFactorsSection userId="u1" />);
    fireEvent.click(screen.getByRole('button', { name: 'remove' }));
    return screen.getByRole('dialog');
  }

  it('offers a backup code while one is left', () => {
    withFactors(true, 0, 3);
    expect(within(openRemove()).getByLabelText('use a backup code instead')).toBeInTheDocument();
  });

  it('offers none when there are none left', () => {
    withFactors(true, 0, 0);
    expect(within(openRemove()).queryByLabelText('use a backup code instead')).toBeNull();
  });
});
