/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the ceremony dialog. two things it has to get right: telling the operator
 * that one check covers the machine for a while — the check is recorded against
 * (user, machine) AND against the session that ran it, so that session's
 * reloads no longer cost a prompt and the copy has to say so — and offering an
 * account with no second factor an enroll route rather than a code field it can
 * never satisfy.
 *
 * inside owlette swoop the passkey gives way to "verify in your browser": the
 * dialog opens the verify page in the system browser, polls the step-up route
 * and answers the hook once the window reads open.
 */

import React from 'react';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopStepUpDialog } from '@/components/swoop/SwoopStepUpDialog';
import { STEP_UP_WINDOW_OPEN } from '@/lib/swoop/stepUp';

jest.mock('next/navigation', () => ({
  useParams: () => ({ siteId: 'site-1', machineId: 'machine-1' }),
}));

const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 owlette-swoop-viewer/4.1.8';
const STEP_UP = '/api/sites/site-1/machines/machine-1/swoop/step-up';
const VERIFY = 'http://localhost/swoop/site-1/machine-1/verify';

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function renderDialog(over: { enrolled?: boolean; onProof?: jest.Mock; onCancel?: jest.Mock } = {}) {
  const onProof = over.onProof ?? jest.fn().mockResolvedValue(undefined);
  const onCancel = over.onCancel ?? jest.fn();
  render(
    <SwoopStepUpDialog
      open
      enrolled={over.enrolled ?? true}
      onProof={onProof}
      onCancel={onCancel}
    />,
  );
  return { onProof, onCancel };
}

describe('SwoopStepUpDialog', () => {
  it('says the check covers the machine for 7 days, reconnects included', () => {
    renderDialog();

    expect(
      screen.getByText(/one check covers this machine for 7 days, reconnects included/i),
    ).toBeInTheDocument();
  });

  it('hands the entered code over verbatim', async () => {
    const user = userEvent.setup();
    const { onProof } = renderDialog();

    await user.type(screen.getByLabelText(/authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: /confirm/i }));

    expect(onProof).toHaveBeenCalledWith({ code: '123456' });
  });

  it('offers an account with no factor an enroll route and no code field', () => {
    renderDialog({ enrolled: false });

    expect(screen.queryByLabelText(/authenticator code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /security settings/i })).toHaveAttribute(
      'href',
      '/setup-2fa',
    );
  });

  it('in a browser offers the passkey and no browser check', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'use a passkey' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'verify in your browser' })).not.toBeInTheDocument();
  });
});

describe('SwoopStepUpDialog inside owlette swoop', () => {
  let reply: { open: boolean; sessionPassedCeremony: boolean };
  let fetchMock: jest.Mock;
  let openSpy: jest.SpyInstance;

  const polls = () => fetchMock.mock.calls.filter(([url]) => url === STEP_UP).length;

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  async function verifyInBrowser(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'verify in your browser' }));
    await advance(0);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    reply = { open: false, sessionPassedCeremony: true };
    fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: reply }) }));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    openSpy = jest.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => jest.useRealTimers());

  it('hides the passkey and leads with verify in your browser, codes kept', () => {
    renderDialog();

    expect(screen.queryByRole('button', { name: 'use a passkey' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'verify in your browser' })).toBeEnabled();
    expect(screen.getByLabelText('authenticator code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirm' })).toBeInTheDocument();
  });

  it('opens the verify page in the browser and waits for it', async () => {
    renderDialog();

    await verifyInBrowser();

    expect(polls()).toBe(1);
    expect(openSpy).toHaveBeenCalledWith(VERIFY, '_blank');
    expect(screen.getByRole('status')).toHaveTextContent('waiting for your browser…');
    expect(screen.getByRole('link', { name: 'open the verification page' })).toHaveAttribute('href', VERIFY);
    expect(screen.getByLabelText('authenticator code')).toBeDisabled();
    // one cancel, the wait's own
    expect(screen.getAllByRole('button', { name: 'cancel' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'confirm' })).not.toBeInTheDocument();
  });

  it('polls every 3 s and answers the hook once the window reads open', async () => {
    const { onProof } = renderDialog();

    await verifyInBrowser();
    await advance(3000);
    expect(polls()).toBe(2);
    expect(onProof).not.toHaveBeenCalled();

    reply = { open: true, sessionPassedCeremony: true };
    await advance(3000);

    expect(polls()).toBe(3);
    expect(onProof).toHaveBeenCalledTimes(1);
    expect(onProof).toHaveBeenCalledWith(STEP_UP_WINDOW_OPEN);
    expect(openSpy).toHaveBeenCalledTimes(1);

    await advance(30_000);
    expect(polls()).toBe(3);
  });

  it('cancel stops the wait and leaves the step-up open', async () => {
    const { onProof, onCancel } = renderDialog();

    await verifyInBrowser();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await advance(30_000);

    expect(polls()).toBe(1);
    expect(onProof).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'verify in your browser' })).toBeEnabled();
  });

  it('gives up after 10 minutes', async () => {
    const { onProof } = renderDialog();

    await verifyInBrowser();
    await advance(10 * 60 * 1000 + 3000);

    expect(screen.getByRole('alert')).toHaveTextContent("that didn't go through, try again");
    expect(screen.getByRole('button', { name: 'verify in your browser' })).toBeEnabled();
    const settled = polls();
    await advance(30_000);
    expect(polls()).toBe(settled);
    expect(onProof).not.toHaveBeenCalled();
  });

  it('keeps polling through a failed read', async () => {
    const { onProof } = renderDialog();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });

    await verifyInBrowser();
    expect(openSpy).toHaveBeenCalledTimes(1);

    reply = { open: true, sessionPassedCeremony: true };
    await advance(3000);
    expect(onProof).toHaveBeenCalledWith(STEP_UP_WINDOW_OPEN);
  });

  it('sends a sign-in that skipped the second factor to a code, not to the browser', async () => {
    reply = { open: false, sessionPassedCeremony: false };
    const { onProof } = renderDialog();

    await verifyInBrowser();

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/skipped the second factor/);
    expect(screen.getByLabelText('authenticator code')).toBeEnabled();
    expect(onProof).not.toHaveBeenCalled();
  });

  it('still takes a code', async () => {
    const { onProof } = renderDialog();

    fireEvent.change(screen.getByLabelText('authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    await advance(0);

    expect(onProof).toHaveBeenCalledWith({ code: '123456' });
    expect(openSpy).not.toHaveBeenCalled();
  });
});
