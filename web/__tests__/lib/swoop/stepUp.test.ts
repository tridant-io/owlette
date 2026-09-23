/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * swoop step-up ceremony (task 5.5).
 *
 * what these cases pin, in order of how much it matters:
 *
 * 1. the ceremony hands the session-create route a LIVE proof — a passkey
 *    assertion or a code — and never a freshness timestamp. a session born from
 *    the 30-day device-trust cookie carries `mfaCompletedAt = now` with no
 *    ceremony behind it, so a timestamp would be no proof at all.
 * 2. a successful ceremony is followed by EXACTLY ONE retry. `onProof` is the
 *    retry; it is called once and never in a loop.
 * 3. a failed proof does not retry at all.
 * 4. an account with zero enrolled factors gets an enrol hint and no code
 *    field: it cannot take control, so it is never offered the ceremony.
 *
 * the dialog is built with `createElement` rather than jsx so this file keeps
 * the `.ts` name the task specifies.
 */

import { createElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopStepUpDialog } from '@/components/swoop/SwoopStepUpDialog';
import type { SwoopStepUpProps } from '@/lib/swoop/stepUp';

const startAuthentication = jest.fn();
jest.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
}));

const ASSERTION = { id: 'cred-1', response: { signature: 'sig' } };

function mockOptionsResponse(body: unknown, ok = true) {
  global.fetch = jest.fn(async () => ({
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function renderDialog(overrides: Partial<SwoopStepUpProps> = {}) {
  const onProof = jest.fn(async () => {});
  const onCancel = jest.fn();
  render(
    createElement(SwoopStepUpDialog, {
      open: true,
      enrolled: true,
      onProof,
      onCancel,
      ...overrides,
    }),
  );
  return { onProof, onCancel };
}

beforeEach(() => {
  startAuthentication.mockReset();
  mockOptionsResponse({ options: { challenge: 'c' }, challengeId: 'challenge-1' });
});

describe('swoop step-up ceremony', () => {
  it('a passkey ceremony produces a proof and one retry', async () => {
    startAuthentication.mockResolvedValue(ASSERTION);
    const { onProof } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));

    await waitFor(() => expect(onProof).toHaveBeenCalledTimes(1));
    // the assertion crosses exactly as the authenticator produced it, with the
    // challenge id it was issued against — the route verifies it in-process.
    expect(onProof).toHaveBeenCalledWith({
      credential: ASSERTION,
      challengeId: 'challenge-1',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/passkeys/step-up/options',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('a TOTP code produces a proof and one retry', async () => {
    const { onProof } = renderDialog();

    await userEvent.type(screen.getByLabelText(/authenticator code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(onProof).toHaveBeenCalledTimes(1));
    expect(onProof).toHaveBeenCalledWith({ code: '123456' });
    // no passkey ceremony was started for a code proof.
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it('a backup code is marked as one so the route consumes it', async () => {
    const { onProof } = renderDialog();

    await userEvent.click(screen.getByLabelText(/use a backup code instead/i));
    await userEvent.type(screen.getByLabelText(/^backup code$/i), 'abcd-efgh');
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(onProof).toHaveBeenCalledTimes(1));
    expect(onProof).toHaveBeenCalledWith({ code: 'abcd-efgh', isBackupCode: true });
  });

  it('a failed proof shows an error and does not retry', async () => {
    startAuthentication.mockRejectedValue(
      Object.assign(new Error('The operation either timed out or was not allowed.'), {
        name: 'NotAllowedError',
      }),
    );
    const { onProof } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('the passkey prompt was cancelled.');
    expect(onProof).not.toHaveBeenCalled();
  });

  it('a short code is refused before a round trip and does not retry', async () => {
    const { onProof } = renderDialog();

    await userEvent.type(screen.getByLabelText(/authenticator code/i), '123');
    await userEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('an authenticator code is 6 digits.');
    expect(onProof).not.toHaveBeenCalled();
  });

  it('an account with no passkeys is pointed at its authenticator, not left guessing', async () => {
    mockOptionsResponse({ error: 'No passkeys registered for this user', code: 'no_passkeys' }, false);
    const { onProof } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: /use a passkey/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no passkeys are registered/i);
    expect(onProof).not.toHaveBeenCalled();
  });

  it('a zero-factor account renders the enrol hint and no code field', () => {
    renderDialog({ enrolled: false });

    expect(screen.getByRole('link', { name: /security settings/i })).toHaveAttribute(
      'href',
      '/setup-2fa',
    );
    expect(screen.queryByLabelText(/authenticator code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use a passkey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^confirm$/i })).not.toBeInTheDocument();
  });
});
