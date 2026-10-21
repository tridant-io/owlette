/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The status pill paints from the status tokens, so it reads in both themes:
 * the online dot is `success`, and every red pill (offline, restarting, the
 * cancel countdown) is the `danger-solid` fill with its own foreground. A raw
 * palette class here only ever looked right on navy.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MachineStatusPill } from '@/components/MachineStatusPill';

const RAW_PALETTE = /\b(?:bg|text)-(?:red|green|white)(?:-\d{2,3})?\b/;

function renderPill(props: React.ComponentProps<typeof MachineStatusPill>) {
  return render(
    <TooltipProvider>
      <MachineStatusPill {...props} />
    </TooltipProvider>,
  );
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
});
