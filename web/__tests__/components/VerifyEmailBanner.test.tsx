/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * VerifyEmailBanner: shown only to an unverified password account, resends
 * through POST /api/auth/verify-email, and hides once a reload of the auth user
 * (on the tab coming back into focus) reports the email verified.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner';
import { toast } from '@/lib/toast';

interface FakeUser {
  email: string;
  emailVerified: boolean;
  providerData: { providerId: string }[];
  reload?: () => Promise<void>;
}

let mockUser: FakeUser | null = null;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const mockFirebaseAuth: { currentUser: FakeUser | null } = { currentUser: null };
jest.mock('@/lib/firebase', () => ({
  get auth() {
    return mockFirebaseAuth;
  },
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const fetchMock = jest.fn();

function passwordUser(over: Partial<FakeUser> = {}): FakeUser {
  return {
    email: 'new@example.com',
    emailVerified: false,
    providerData: [{ providerId: 'password' }],
    ...over,
  };
}

beforeEach(() => {
  mockUser = passwordUser();
  mockFirebaseAuth.currentUser = null;
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('VerifyEmailBanner', () => {
  it('asks an unverified password account to verify', () => {
    render(<VerifyEmailBanner />);

    expect(screen.getByTestId('verify-email-banner')).toHaveTextContent(
      'please verify your email address.',
    );
    expect(screen.getByRole('button', { name: 'send verification email' })).toBeEnabled();
  });

  it('renders nothing for a google sign-up', () => {
    mockUser = passwordUser({ emailVerified: true, providerData: [{ providerId: 'google.com' }] });
    const { container } = render(<VerifyEmailBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing once the email is verified', () => {
    mockUser = passwordUser({ emailVerified: true });
    const { container } = render(<VerifyEmailBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when signed out', () => {
    mockUser = null;
    const { container } = render(<VerifyEmailBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('resends through the api and confirms', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    render(<VerifyEmailBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'send verification email' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('verification email sent', {
        description: 'check new@example.com',
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/verify-email', { method: 'POST' });
  });

  it('shows the problem detail when the resend is rate limited', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ detail: 'Too many requests. Please try again in 600 seconds.' }),
    });
    render(<VerifyEmailBanner />);

    fireEvent.click(screen.getByRole('button', { name: 'send verification email' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('could not send the email', {
        description: 'Too many requests. Please try again in 600 seconds.',
      }),
    );
    expect(screen.getByRole('button', { name: 'send verification email' })).toBeEnabled();
  });

  it('hides when the tab regains focus and a reload reports the email verified', async () => {
    const current = passwordUser();
    current.reload = jest.fn(async () => {
      current.emailVerified = true;
    });
    mockFirebaseAuth.currentUser = current;
    render(<VerifyEmailBanner />);

    await act(async () => {
      fireEvent.focus(window);
    });

    expect(current.reload).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('verify-email-banner')).not.toBeInTheDocument());
  });

  it('stays up when the reload still reports unverified', async () => {
    const current = passwordUser();
    current.reload = jest.fn(async () => undefined);
    mockFirebaseAuth.currentUser = current;
    render(<VerifyEmailBanner />);

    await act(async () => {
      fireEvent.focus(window);
    });

    expect(current.reload).toHaveBeenCalled();
    expect(screen.getByTestId('verify-email-banner')).toBeInTheDocument();
  });
});
