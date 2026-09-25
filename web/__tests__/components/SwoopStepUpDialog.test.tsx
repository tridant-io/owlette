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
 */

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopStepUpDialog } from '@/components/swoop/SwoopStepUpDialog';

afterEach(cleanup);

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
  it('says the check covers the machine for 12 hours, reconnects included', () => {
    renderDialog();

    expect(
      screen.getByText(/one check covers this machine for 12 hours, reconnects included/i),
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
});
