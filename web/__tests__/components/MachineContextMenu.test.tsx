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
import { markThisMachine } from '@/lib/swoop/thisMachine';
import { activeHoursGuardOf, type ActiveHoursGuard, type PowerCommandOptions, type PowerCommandSent } from '@/lib/activeHours';

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

async function openMenu(props: {
  isOnline?: boolean;
  isSiteAdmin?: boolean;
  rebooting?: boolean;
  rebootDeferredUntil?: number;
  onCancelRestart?: () => Promise<void>;
  swoopCapable?: boolean;
  swoopViewers?: number;
  onSwoop?: () => void;
  onSwoopApp?: () => void;
  onLiveView?: () => void;
  onViewDisplays?: () => void;
  planLocked?: boolean;
  controlLocked?: boolean;
  swoopLocked?: boolean;
  swoopOff?: boolean;
  onSiteSettings?: () => void;
  activeHoursGuard?: ActiveHoursGuard | null;
  onRestart?: (options?: PowerCommandOptions) => Promise<PowerCommandSent | void>;
  onShutdown?: (options?: PowerCommandOptions) => Promise<PowerCommandSent | void>;
}) {
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

// the swoop row's second half opens the machine in the desktop app instead of
// this browser; inside the app the row itself already opens one of its windows.
describe('MachineContextMenu — the owlette swoop desktop app half', () => {
  const APP_UA = 'Mozilla/5.0 Chrome/141.0.0.0 owlette-swoop-viewer/4.1.8';

  afterEach(() => {
    jest.restoreAllMocks();
    localStorage.clear();
  });

  it('sits beside the swoop row as its own menu item', async () => {
    await openMenu({ swoopCapable: true, onSwoopApp: jest.fn() });

    const app = screen.getByRole('menuitem', { name: 'open in the owlette swoop desktop app' });
    expect(app).toHaveAttribute('data-testid', 'machine-context-menu-swoop-app');
    expect(app.parentElement).toContainElement(screen.getByTestId('machine-context-menu-swoop'));
    expect(app).not.toHaveAttribute('aria-disabled');
  });

  it('opens the app, not the browser viewer', async () => {
    const onSwoop = jest.fn();
    const onSwoopApp = jest.fn();
    const user = await openMenu({ swoopCapable: true, onSwoop, onSwoopApp });

    await user.click(screen.getByTestId('machine-context-menu-swoop-app'));

    expect(onSwoopApp).toHaveBeenCalledTimes(1);
    expect(onSwoop).not.toHaveBeenCalled();
  });

  it('is not there inside the app', async () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    await openMenu({ swoopCapable: true, onSwoopApp: jest.fn() });

    expect(screen.getByTestId('machine-context-menu-swoop')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-app')).not.toBeInTheDocument();
  });

  it('is not there on the machine this browser is on, so the hint keeps its room', async () => {
    markThisMachine('site-A', 'kiosk-1');
    await openMenu({ swoopCapable: true, onSwoopApp: jest.fn() });

    expect(screen.queryByTestId('machine-context-menu-swoop-app')).toBeNull();
    expect(screen.getByText("you're on this machine")).toBeInTheDocument();
  });

  it.each([
    ['no streamer', { swoopCapable: false }],
    ['swoop off for the site', { swoopCapable: true, swoopOff: true, isSiteAdmin: true }],
  ])('is not there with %s', async (_label, props) => {
    await openMenu({ ...props, onSwoopApp: jest.fn() });

    expect(screen.queryByTestId('machine-context-menu-swoop-app')).not.toBeInTheDocument();
  });
});

// with the site's swoop off the server refuses every session, so the menu takes
// an admin to the switch and tells a member who can flip it, with live view back.
describe('MachineContextMenu — swoop off for the site', () => {
  it('takes an admin to the switch', async () => {
    const onSiteSettings = jest.fn();
    const user = await openMenu({ swoopCapable: true, swoopOff: true, isSiteAdmin: true, onSiteSettings });

    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-live-view')).toBeInTheDocument();
    await user.click(screen.getByTestId('machine-context-menu-swoop-off'));

    expect(onSiteSettings).toHaveBeenCalledTimes(1);
  });

  it('tells a member who can turn it on', async () => {
    await openMenu({ swoopCapable: true, swoopOff: true });

    const item = screen.getByTestId('machine-context-menu-swoop-off');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('ask a site owner or admin to turn it on');
    expect(screen.getByTestId('machine-context-menu-live-view')).toBeInTheDocument();
  });

  it('says nothing on a machine without a streamer', async () => {
    await openMenu({ swoopCapable: false, swoopOff: true, isSiteAdmin: true });

    expect(screen.queryByTestId('machine-context-menu-swoop-off')).not.toBeInTheDocument();
  });
});

// a machine cannot be watched from itself: once its streamer has said this
// browser is on it, swoop is greyed out there and says why.
describe('MachineContextMenu — the machine this browser is on', () => {
  afterEach(() => localStorage.clear());

  it('greys swoop out and says why', async () => {
    markThisMachine('site-A', 'kiosk-1');
    const onSwoop = jest.fn();
    const user = await openMenu({ swoopCapable: true, onSwoop });

    const item = screen.getByTestId('machine-context-menu-swoop');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent("you're on this machine");
    await user.click(item);
    expect(onSwoop).not.toHaveBeenCalled();
  });

  it('leaves every other machine alone', async () => {
    markThisMachine('site-A', 'kiosk-2');
    await openMenu({ swoopCapable: true });

    const item = screen.getByTestId('machine-context-menu-swoop');
    expect(item).not.toHaveAttribute('aria-disabled');
    expect(item).not.toHaveTextContent("you're on this machine");
  });
});

// the count is the server's mirror of live viewers; it shows only where swoop
// itself shows, so a stale count never lands on live view or an offline machine.
describe('MachineContextMenu — swoop viewer count', () => {
  it('counts viewers on the swoop row and on the trigger', async () => {
    await openMenu({ swoopCapable: true, swoopViewers: 2 });

    const badge = screen.getByTestId('machine-context-menu-swoop-count');
    expect(screen.getByTestId('machine-context-menu-swoop')).toContainElement(badge);
    expect(badge).toHaveTextContent('2');

    const pill = screen.getByTestId('machine-context-menu-swoop-pill');
    expect(screen.getByTestId('machine-context-menu-trigger')).toContainElement(pill);
    expect(pill).toHaveTextContent('2');
  });

  it.each([0, undefined])('shows no count at %p viewers', async (swoopViewers) => {
    await openMenu({ swoopCapable: true, swoopViewers });

    expect(screen.getByTestId('machine-context-menu-swoop')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-pill')).not.toBeInTheDocument();
  });

  it('shows no count on the live-view branch', async () => {
    await openMenu({ swoopViewers: 2 });

    expect(screen.getByTestId('machine-context-menu-live-view')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-pill')).not.toBeInTheDocument();
  });

  it('shows no count when the machine is offline', async () => {
    await openMenu({ isOnline: false, swoopCapable: true, swoopViewers: 2 });

    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-pill')).not.toBeInTheDocument();
  });
});

// the viewer's own plan on a site they own (useSitePlan): server gates every
// action regardless, so these only keep the menu from offering what would fail.
describe('MachineContextMenu — plan', () => {
  it('links a locked swoop to the plan page instead of opening a session', async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true });

    const item = screen.getByTestId('machine-context-menu-swoop-upgrade');
    expect(item).toHaveTextContent('swooppart of pro');
    expect(item).toHaveAttribute('href', '/settings/plan');
    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
  });

  it('links a locked swoop to the plan page even with the site switch off, since turning it on would not help', async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true, swoopOff: true, isSiteAdmin: true, onSiteSettings: jest.fn() });

    expect(screen.getByTestId('machine-context-menu-swoop-upgrade')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-off')).not.toBeInTheDocument();
  });

  it('drops live view and screenshot when control is out of the plan', async () => {
    await openMenu({ controlLocked: true, onViewDisplays: jest.fn() });

    expect(screen.queryByTestId('machine-context-menu-live-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-screenshot')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-view-displays')).toBeInTheDocument();
  });

  it('keeps a locked swoop row when control is out of the plan too, as on free', async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true, controlLocked: true });

    expect(screen.getByTestId('machine-context-menu-swoop-upgrade')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-screenshot')).not.toBeInTheDocument();
  });

  it('keeps only alerts, the token and removal on a machine outside the plan', async () => {
    await openMenu({ planLocked: true, isSiteAdmin: true, swoopCapable: true, onViewDisplays: jest.fn() });

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'mute alerts',
      'revoke token',
      'remove machine',
    ]);
  });

  it('collapses restart and shutdown into one row linking to the plan page, keeping schedule restarts', async () => {
    await openMenu({ controlLocked: true, isSiteAdmin: true, swoopCapable: true, swoopLocked: true, onViewDisplays: jest.fn() });

    const row = screen.getByTestId('machine-context-menu-control-upgrade');
    expect(row).toHaveTextContent('remote controlpart of core');
    expect(row).toHaveAttribute('href', '/settings/plan');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'remote controlpart of core',
      'schedule restarts',
      'swooppart of pro',
      'view displays',
      'hoot',
      'mute alerts',
      'revoke token',
      'remove machine',
    ]);
  });

  it('still offers cancelling a restart without control, which every plan may', async () => {
    await openMenu({ controlLocked: true, isSiteAdmin: true, rebooting: true });

    expect(screen.getByTestId('machine-context-menu-cancel-reboot')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-control-upgrade')).not.toBeInTheDocument();
  });

  it('offers everything as before when the plan leaves it all in', async () => {
    await openMenu({ isSiteAdmin: true, onViewDisplays: jest.fn() });

    expect(screen.getByTestId('machine-context-menu-reboot')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-shutdown')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-control-upgrade')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-live-view')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-screenshot')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-view-displays')).toBeInTheDocument();
  });
});

// the agent's guard refuses inside the window unless a person overrides, so the
// confirm asks first; a machine whose agent guards nothing keeps today's dialog.
describe('MachineContextMenu — restart and shutdown inside active hours', () => {
  const hour = new Date().getUTCHours();
  const INSIDE: ActiveHoursGuard = {
    window: { start: hour, end: (hour + 2) % 24, source: 'policy' },
    timezone: 'UTC',
  };

  it('asks for a choice on a guarded machine inside its window, and sends the reason with the restart', async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ isSiteAdmin: true, activeHoursGuard: INSIDE, onRestart });

    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    const dialog = await screen.findByRole('dialog', { name: 'restart kiosk-1?' });
    expect(screen.getByTestId('active-hours-notice')).toHaveTextContent('inside active hours');
    expect(dialog).toContainElement(screen.getByRole('button', { name: 'restart when active hours end' }));

    await user.type(screen.getByLabelText('reason'), 'venue closed');
    await user.click(screen.getByRole('button', { name: 'restart now' }));

    expect(onRestart).toHaveBeenCalledWith({ override: { reason: 'venue closed' } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('defers a restart when asked to', async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ isSiteAdmin: true, activeHoursGuard: INSIDE, onRestart });

    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    await user.click(await screen.findByRole('button', { name: 'restart when active hours end' }));

    expect(onRestart).toHaveBeenCalledWith({ when: 'after_active_hours' });
  });

  it('keeps today\'s confirm where the agent guards nothing', async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ isSiteAdmin: true, activeHoursGuard: null, onRestart });

    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    const dialog = await screen.findByRole('dialog', { name: 'restart kiosk-1?' });
    expect(dialog).toHaveTextContent('60 seconds');
    expect(screen.queryByTestId('active-hours-notice')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'restart' }));
    expect(onRestart).toHaveBeenCalledWith({});
  });

  it("keeps today's confirm on a machine rolled back below 4.1.21 that still carries the capability", async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const rolledBack = activeHoursGuardOf({
      osFamily: 'windows',
      capabilities: { activeHoursGuard: 1 },
      agent_version: '3.3.7',
      activeHours: INSIDE.window,
      machineTimezone: 'UTC',
    });
    const user = await openMenu({ isSiteAdmin: true, activeHoursGuard: rolledBack, onRestart });

    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    expect(await screen.findByRole('dialog', { name: 'restart kiosk-1?' })).toHaveTextContent('60 seconds');
    expect(screen.queryByRole('button', { name: 'restart when active hours end' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'restart' }));
    expect(onRestart).toHaveBeenCalledWith({});
  });

  it('offers a shutdown inside the window only with a reason, never deferred', async () => {
    const onShutdown = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ isSiteAdmin: true, activeHoursGuard: INSIDE, onShutdown });

    await user.click(screen.getByTestId('machine-context-menu-shutdown'));
    await screen.findByRole('dialog', { name: 'shutdown kiosk-1?' });
    expect(screen.queryByRole('button', { name: /when active hours end/ })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('reason'), 'power work');
    await user.click(screen.getByRole('button', { name: 'shut down now' }));
    expect(onShutdown).toHaveBeenCalledWith({ override: { reason: 'power work' } });
  });
});

// a restart the agent holds until active hours end is neither under way nor
// gone: the menu cancels it the way the pill does, and still restarts now.
describe('MachineContextMenu — a restart held until active hours end', () => {
  const HELD = Math.floor(Date.now() / 1000) + 3 * 3600;

  it('offers cancel restart, through the same cancel as a countdown', async () => {
    const onCancelRestart = jest.fn().mockResolvedValue(undefined);
    const user = await openMenu({ isSiteAdmin: true, rebootDeferredUntil: HELD, onCancelRestart });

    await user.click(screen.getByTestId('machine-context-menu-cancel-reboot'));

    expect(onCancelRestart).toHaveBeenCalledTimes(1);
  });

  it('keeps restart and shutdown, and restart opens the usual confirm', async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ isSiteAdmin: true, rebootDeferredUntil: HELD, onRestart });

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent).slice(0, 4)).toEqual([
      'cancel restart',
      'restart machine',
      '',
      'shutdown machine',
    ]);
    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    await screen.findByRole('dialog', { name: 'restart kiosk-1?' });
  });

  it('still offers the cancel without control, which every plan may', async () => {
    await openMenu({ controlLocked: true, isSiteAdmin: true, rebootDeferredUntil: HELD });

    expect(screen.getByTestId('machine-context-menu-cancel-reboot')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-control-upgrade')).toBeInTheDocument();
  });

  it('says nothing about it on an offline machine, as the pill', async () => {
    await openMenu({ isOnline: false, isSiteAdmin: true, rebootDeferredUntil: HELD });

    expect(screen.queryByTestId('machine-context-menu-cancel-reboot')).not.toBeInTheDocument();
  });
});

describe('MachineContextMenu — hoot', () => {
  it('opens hoot aimed at this machine, for a member too', async () => {
    await openMenu({});

    expect(screen.getByTestId('machine-context-menu-hoot')).toHaveAttribute(
      'href',
      '/hoot?site=site-A&machine=kiosk-1',
    );
  });

  it('stays on an offline machine, where hoot says its tool calls will not arrive', async () => {
    await openMenu({ isOnline: false });

    expect(screen.getByTestId('machine-context-menu-hoot')).toHaveTextContent('hoot');
  });
});
