/**
 * @jest-environment jsdom
 *
 * `useSendVerification` — the one resend behind VerifyEmailBanner, the plan
 * banner and the plan page's trial card. pins the request, the toast naming
 * the address (or none, for a user without one), a refusal's detail shown as
 * it comes, and `sending` holding only while the request is out.
 */

import { act, renderHook } from '@testing-library/react';

let mockUser: { email?: string | null } | null = null;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

import { useSendVerification } from '@/hooks/useSendVerification';
import { toast } from '@/lib/toast';

const fetchMock = jest.fn();

beforeEach(() => {
  mockUser = { email: 'new@example.com' };
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function send() {
  const { result } = renderHook(() => useSendVerification());
  await act(() => result.current.send());
  return result;
}

describe('useSendVerification', () => {
  it('posts the resend and says which address to check', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    const result = await send();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/verify-email', { method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('verification email sent', { description: 'check new@example.com' });
    expect(result.current.sending).toBe(false);
  });

  it('names no address for a user without one', async () => {
    mockUser = { email: null };
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await send();

    expect(toast.success).toHaveBeenCalledWith('verification email sent', undefined);
  });

  it("shows a refusal's detail, or a plain line when it has none", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ detail: 'try again in 600 seconds.' }),
    });
    await send();
    expect(toast.error).toHaveBeenLastCalledWith('could not send the email', {
      description: 'try again in 600 seconds.',
    });

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });
    await send();
    expect(toast.error).toHaveBeenLastCalledWith('could not send the email', {
      description: 'please try again later.',
    });
  });

  it('says so when the request never got an answer', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    const result = await send();

    expect(toast.error).toHaveBeenCalledWith('could not send the email', { description: 'please try again later.' });
    expect(result.current.sending).toBe(false);
  });

  it('is sending only while the request is out', async () => {
    let answer: (response: { ok: boolean }) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { result } = renderHook(() => useSendVerification());

    let sent: Promise<void> = Promise.resolve();
    act(() => {
      sent = result.current.send();
    });
    expect(result.current.sending).toBe(true);

    await act(async () => {
      answer({ ok: true });
      await sent;
    });
    expect(result.current.sending).toBe(false);
  });
});
