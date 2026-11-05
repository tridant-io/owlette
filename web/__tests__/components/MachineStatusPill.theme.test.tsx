/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The status pill paints from the status tokens, so it reads in both themes:
 * the online dot is `success`, and every red pill (offline, restarting, the
 * cancel countdown) is the `danger-solid` fill with its own foreground. A raw
 * palette class here only ever looked right on navy.
 *
 * A restart the agent holds until active hours end (`rebootDeferredUntil`) is
 * the amber `warning-solid` fill instead: a clock time on the machine's clock,
 * still, never the countdown.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MachineStatusPill } from '@/components/MachineStatusPill';

const RAW_PALETTE = /\b(?:bg|text)-(?:red|green|white|amber|yellow|orange)(?:-\d{2,3})?\b/;

function renderPill(props: React.ComponentProps<typeof MachineStatusPill>) {
  return render(<MachineStatusPill {...props} />, { wrapper: TooltipProvider });
}

describe('MachineStatusPill theme tokens', () => {
  it('draws the online dot in the success token', () => {
    renderPill({ online: true });
    const dot = screen.getByTestId('machine-status-online');
    expect(dot).toHaveClass('bg-success');
    expect(dot.className).not.toMatch(RAW_PALETTE);
  });

  it('draws the offline pill as the danger solid with its foreground', () => {
    renderPill({ online: false });
    const pill = screen.getByText('offline');
    expect(pill).toHaveClass('bg-danger-solid', 'text-danger-solid-foreground');
    expect(pill.className).not.toMatch(RAW_PALETTE);
  });

  it('draws the cancellable countdown as the danger solid too', () => {
    const inTwoMinutes = Math.floor(Date.now() / 1000) + 120;
    renderPill({
      online: true,
      rebooting: true,
      rebootScheduledAt: inTwoMinutes,
      isSiteAdmin: true,
      onCancel: jest.fn().mockResolvedValue(undefined),
    });
    const pill = screen.getByTestId('machine-status-cancel-pill');
    expect(pill).toHaveClass('bg-danger-solid', 'text-danger-solid-foreground');
    expect(pill.className).not.toMatch(RAW_PALETTE);
  });

  it('opens a later countdown cancellable, not on the spinner of one already cancelled', async () => {
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const nowSec = Math.floor(Date.now() / 1000);
    const admin = { online: true, isSiteAdmin: true, onCancel };
    const { rerender } = renderPill({ ...admin, rebooting: true, rebootScheduledAt: nowSec + 120 });

    fireEvent.click(screen.getByTestId('machine-status-cancel-pill'));
    expect(await screen.findByRole('img', { name: 'cancelling' })).toBeInTheDocument();

    // the agent cleared that countdown, and later a person restarts again
    rerender(<MachineStatusPill {...admin} />);
    rerender(<MachineStatusPill {...admin} rebooting rebootScheduledAt={nowSec + 300} />);
    expect(screen.getByTestId('machine-status-cancel-pill')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'cancelling' })).toBeNull();
  });
});

describe('MachineStatusPill held restart', () => {
  // 2027-01-15T22:30:00Z: 17:30 in New York (EST)
  const AT = Date.UTC(2027, 0, 15, 22, 30) / 1000;
  const held = { online: true, rebootDeferredUntil: AT, machineTimezone: 'America/New_York' };

  it('names the time on the machine clock, in the warning token, without the pulse', () => {
    renderPill({ ...held, isSiteAdmin: true, onCancel: jest.fn().mockResolvedValue(undefined) });
    const pill = screen.getByTestId('machine-status-deferred-pill');
    expect(pill).toHaveTextContent('restart at 17:30');
    expect(pill).toHaveAccessibleName('restart at 17:30 (machine time) — click to cancel');
    expect(pill).toHaveClass('bg-warning-solid', 'text-warning-solid-foreground');
    expect(pill).not.toHaveClass('animate-pulse');
    expect(pill.className).not.toMatch(RAW_PALETTE);
  });

  it('reads as a clock time however far off it is, never the countdown', () => {
    // as MM:SS six hours would read 360:00 and overflow the list cell
    const inSixHours = Math.floor(Date.now() / 1000) + 6 * 3600;
    renderPill({ online: true, rebootDeferredUntil: inSixHours, machineTimezone: 'UTC' });
    const pill = screen.getByTestId('machine-status-deferred-pill');
    expect(pill).toHaveTextContent(new RegExp(`^restart at ${new Date(inSixHours * 1000).toISOString().slice(11, 16)}$`));
    expect(screen.queryByTestId('machine-status-cancel-pill')).toBeNull();
  });

  it('shows only the time in the list cell, with the words in its name', () => {
    renderPill({ ...held, compact: true });
    const pill = screen.getByRole('img', { name: 'restart at 17:30 (machine time)' });
    expect(pill).toHaveTextContent(/^17:30$/);
  });

  it('is no button for someone who cannot cancel', () => {
    renderPill({ ...held, isSiteAdmin: false, onCancel: jest.fn() });
    const pill = screen.getByRole('img', { name: 'restart at 17:30 (machine time)' });
    expect(pill).toHaveAttribute('data-testid', 'machine-status-deferred-pill');
  });

  it('reads in UTC, and says so, when the agent names no zone', () => {
    renderPill({ online: true, rebootDeferredUntil: AT });
    expect(screen.getByRole('img', { name: 'restart at 22:30 (UTC)' })).toBeInTheDocument();
  });

  it('cancels through onCancel, and a later hold opens cancellable again', async () => {
    const onCancel = jest.fn().mockResolvedValue(undefined);
    const admin = { online: true, isSiteAdmin: true, onCancel, machineTimezone: 'America/New_York' };
    const { rerender } = renderPill({ ...admin, rebootDeferredUntil: AT });

    fireEvent.click(screen.getByTestId('machine-status-deferred-pill'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('img', { name: 'cancelling' })).toHaveClass('bg-warning-solid');

    // the agent dropped the hold; the next one is another day's
    rerender(<MachineStatusPill {...admin} />);
    expect(screen.getByTestId('machine-status-online')).toBeInTheDocument();
    rerender(<MachineStatusPill {...admin} rebootDeferredUntil={AT + 86_400} />);
    expect(screen.getByTestId('machine-status-deferred-pill')).toHaveAttribute('type', 'button');
  });

  it('gives way to a countdown under way, and to offline', () => {
    const inTwoMinutes = Math.floor(Date.now() / 1000) + 120;
    const { rerender } = renderPill({
      ...held,
      rebooting: true,
      rebootScheduledAt: inTwoMinutes,
      isSiteAdmin: true,
      onCancel: jest.fn().mockResolvedValue(undefined),
    });
    expect(screen.getByTestId('machine-status-cancel-pill')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-status-deferred-pill')).toBeNull();

    rerender(<MachineStatusPill {...held} online={false} />);
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-status-deferred-pill')).toBeNull();
  });
});
