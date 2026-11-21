/** @jest-environment node */

/**
 * Email verification send path: the Admin SDK link is rebuilt as an in-app
 * /verify-email link on the trusted base url, Resend being unconfigured is a
 * quiet skip, and only unverified password accounts qualify.
 */

import type { UserRecord } from 'firebase-admin/auth';

const mockGenerateLink = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    generateEmailVerificationLink: (...a: unknown[]) => mockGenerateLink(...a),
  }),
}));

const mockSend = jest.fn();
const mockGetResend = jest.fn();
jest.mock('@/lib/resendClient.server', () => ({
  ...jest.requireActual('@/lib/resendClient.server'),
  getResend: () => mockGetResend(),
}));

import { needsEmailVerification, sendVerificationEmail } from '@/lib/emailVerification.server';

const FIREBASE_LINK =
  'https://demo.firebaseapp.com/__/auth/action?mode=verifyEmail&oobCode=CODE-123&apiKey=k&lang=en';

describe('sendVerificationEmail', () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://owlette.test';
    mockGenerateLink.mockResolvedValue(FIREBASE_LINK);
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });
    mockGetResend.mockReturnValue({ emails: { send: mockSend } });
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
  });

  it('sends the branded email with an in-app link carrying the oobCode', async () => {
    await sendVerificationEmail('new@example.com');

    expect(mockGenerateLink).toHaveBeenCalledWith('new@example.com');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const message = mockSend.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(message.to).toBe('new@example.com');
    expect(message.subject).toBe('verify your owlette email');
    expect(message.html).toContain('https://owlette.test/verify-email?oobCode=CODE-123');
    // the firebase-hosted action page is never what the user gets
    expect(message.html).not.toContain('firebaseapp.com');
  });

  it('skips quietly when Resend is not configured, but still mints the code', async () => {
    mockGetResend.mockReturnValue(null);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(sendVerificationEmail('new@example.com')).resolves.toBeUndefined();

    expect(mockGenerateLink).toHaveBeenCalledTimes(1);
    expect(mockSend).not.toHaveBeenCalled();
    // the link carries a live oobCode, so it must never reach the logs
    expect(JSON.stringify(warn.mock.calls)).not.toContain('CODE-123');
    warn.mockRestore();
  });

  it('throws when Resend rejects the send', async () => {
    mockSend.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad from' } });

    await expect(sendVerificationEmail('new@example.com')).rejects.toEqual(
      expect.objectContaining({ message: 'bad from' }),
    );
  });

  it('throws when the generated link has no oobCode', async () => {
    mockGenerateLink.mockResolvedValue('https://demo.firebaseapp.com/__/auth/action?mode=verifyEmail');

    await expect(sendVerificationEmail('new@example.com')).rejects.toThrow(/no oobCode/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('needsEmailVerification', () => {
  const record = (over: Partial<UserRecord>) =>
    ({
      uid: 'u',
      email: 'a@example.com',
      emailVerified: false,
      providerData: [{ providerId: 'password' }],
      ...over,
    }) as unknown as UserRecord;

  it('is true for an unverified password account', () => {
    expect(needsEmailVerification(record({}))).toBe(true);
  });

  it('is false for a google-only account', () => {
    expect(
      needsEmailVerification(record({ providerData: [{ providerId: 'google.com' }] as UserRecord['providerData'] })),
    ).toBe(false);
  });

  it('is false once the email is verified', () => {
    expect(needsEmailVerification(record({ emailVerified: true }))).toBe(false);
  });

  it('is false without an email or provider data', () => {
    expect(needsEmailVerification(record({ email: undefined }))).toBe(false);
    expect(
      needsEmailVerification(record({ providerData: undefined as unknown as UserRecord['providerData'] })),
    ).toBe(false);
  });
});
