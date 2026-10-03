/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MachineContextMenu — names and keyboard reach.
 *
 * The ⋮ trigger was icon-only with its label in a tooltip, which names
 * nothing. The schedule-restarts gear beside "restart machine" was a plain
 * button inside the menu: a Radix menu moves focus by arrow key between its
 * items and never stops on a plain button, so keyboard users could not reach
 * restart scheduling on an online machine at all.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MachineContextMenu } from '@/components/MachineContextMenu';

// jsdom ships no ResizeObserver; Radix's dropdown positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix drives the trigger with pointer capture — absent in jsdom.
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.setPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: { mutedMachines: [] },
    updateUserPreferences: jest.fn(),
  }),
}));

// The real dialog subscribes to Firestore; this stand-in only says whether it opened.
jest.mock('@/components/RestartScheduleDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => (open ? <div>restart schedule dialog</div> : null),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderMenu(props: { swoopCapable?: boolean; swoopViewers?: number } = {}) {
  render(
    <TooltipProvider>
      <MachineContextMenu
        machineId="kiosk-1"
        machineName="kiosk-1"
        siteId="site-A"
        isOnline
        isSiteAdmin
        onRemoveMachine={jest.fn()}
        onRestart={jest.fn()}
        onShutdown={jest.fn()}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe('MachineContextMenu — accessible names and keyboard reach', () => {
  it('names the trigger after the machine', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: 'machine options for kiosk-1' })).toBeInTheDocument();
  });

  it('reaches schedule restarts by arrow key and opens its dialog with enter', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.tab();
    expect(screen.getByRole('button', { name: 'machine options for kiosk-1' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');

    const scheduleItem = screen.getByRole('menuitem', { name: 'schedule restarts' });
    for (let i = 0; i < 5 && document.activeElement !== scheduleItem; i++) {
      await user.keyboard('{ArrowDown}');
    }
    expect(scheduleItem).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByText('restart schedule dialog')).toBeInTheDocument();
  });

  // the trigger pill is decoration: the count is spoken once, on the swoop row.
  it('speaks the swoop count on the row and leaves the trigger name alone', async () => {
    const user = userEvent.setup();
    renderMenu({ swoopCapable: true, swoopViewers: 2 });

    const trigger = screen.getByRole('button', { name: 'machine options for kiosk-1' });
    expect(screen.getByTestId('machine-context-menu-swoop-pill')).toHaveAttribute('aria-hidden', 'true');

    await user.click(trigger);
    await screen.findByRole('menu');

    // the count is what shows; "watching" is read, not seen.
    expect(screen.getByTestId('machine-context-menu-swoop-count')).toHaveTextContent('2 watching');
  });
});
