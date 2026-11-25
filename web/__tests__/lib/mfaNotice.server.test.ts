/** @jest-environment node */

/**
 * the factor-change notice: it reaches the account's address, and a mail problem
 * never costs the request that already changed the factor.
 */

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const mockSendEmail = jest.fn();
let mockResendConfigured = true;
jest.mock('@/lib/resendClient.server', () => ({
  ...jest.requireActual('@/lib/resendClient.server'),
  getResend: () =>
    mockResendConfigured
      ? { emails: { send: (...a: unknown[]) => mockSendEmail(...a) } }
      : null,
}));

import { MFA_NOTICE_SEND_TIMEOUT_MS, sendMfaFactorNotice } from '@/lib/mfaNotice.server';

const notice = { change: 'added', factor: 'passkey' } as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockResendConfigured = true;
  mockSendEmail.mockResolvedValue({ error: null });
});

describe('sendMfaFactorNotice', () => {
  it('sends to the address it is given', async () => {
    await sendMfaFactorNotice('owner@example.test', notice);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
      to: 'owner@example.test',
      subject: 'passkey added to your owlette account',
    });
  });

  it.each([[undefined], [''], [42]])('sends nothing without an address: %p', async (email) => {
    await sendMfaFactorNotice(email, notice);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when mail is not configured', async () => {
    mockResendConfigured = false;
    await expect(sendMfaFactorNotice('owner@example.test', notice)).resolves.toBeUndefined();
  });

  it('does not throw on an error answer or a rejected send', async () => {
    mockSendEmail.mockResolvedValueOnce({ error: { message: 'refused' } });
    await expect(sendMfaFactorNotice('owner@example.test', notice)).resolves.toBeUndefined();

    mockSendEmail.mockRejectedValueOnce(new Error('resend down'));
    await expect(sendMfaFactorNotice('owner@example.test', notice)).resolves.toBeUndefined();
  });

  it('stops waiting on a send that never answers', async () => {
    jest.useFakeTimers();
    try {
      mockSendEmail.mockReturnValue(new Promise(() => {}));
      const sending = sendMfaFactorNotice('owner@example.test', notice);
      await jest.advanceTimersByTimeAsync(MFA_NOTICE_SEND_TIMEOUT_MS);
      await expect(sending).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
