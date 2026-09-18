/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MachineContextMenu — the swoop entry point (dev/active/swoop, wave 5 task 5.3).
 *
 * The contract is exclusivity: an online machine shows swoop OR live view, never
 * both and never neither. `capabilities.swoop === 1` from the heartbeat is the
 * only gate — no version check, and no site/permission check, because site
 * enablement, membersMayWatch and step-up are decided by the session-create
 * route, not by this menu.
 *
 * Today every fielded agent reports 0 (no streamer is installed anywhere yet),
 * so the live-view branch is the one that actually renders — it is asserted
 * first, and for a missing `capabilities` map as well as an explicit 0.
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

// The schedule dialog subscribes to Firestore on mount; the menu renders it
// closed and none of these assertions touch it.
jest.mock('@/components/RestartScheduleDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

async function openMenu(props: { swoopCapable?: boolean; onSwoop?: () => void; onLiveView?: () => void }) {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <MachineContextMenu
        machineId="kiosk-1"
        machineName="kiosk-1"
        siteId="site-A"
        isOnline
        onRemoveMachine={jest.fn()}
        onScreenshot={jest.fn()}
        {...props}
      />
    </TooltipProvider>,
  );
  await user.click(screen.getByTestId('machine-context-menu-trigger'));
  await screen.findByRole('menu');
  return user;
}

describe('MachineContextMenu — swoop entry', () => {
  it('shows live view and no swoop item when the agent reports no streamer', async () => {
    await openMenu({ swoopCapable: false });

    expect(screen.getByTestId('machine-context-menu-live-view')).toHaveTextContent('live view');
    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
  });

  it('shows live view when the capability is absent entirely', async () => {
    await openMenu({});

    expect(screen.getByTestId('machine-context-menu-live-view')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
  });

  it('shows swoop and no live-view item when capabilities.swoop === 1', async () => {
    await openMenu({ swoopCapable: true });

    expect(screen.getByTestId('machine-context-menu-swoop')).toHaveTextContent('swoop');
    expect(screen.queryByTestId('machine-context-menu-live-view')).not.toBeInTheDocument();
  });

  it('invokes onSwoop when the swoop item is clicked', async () => {
    const onSwoop = jest.fn();
    const user = await openMenu({ swoopCapable: true, onSwoop });

    await user.click(screen.getByTestId('machine-context-menu-swoop'));

    expect(onSwoop).toHaveBeenCalledTimes(1);
  });
});
