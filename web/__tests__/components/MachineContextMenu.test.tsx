/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * MachineContextMenu — the swoop entry point (dev/active/swoop, wave 5 task 5.3).
 *
 * An online machine whose agent reports `capabilities.swoop === 1` offers swoop;
 * one that does not offers the screenshot alone, as live view is gone. The
 * heartbeat is the only gate here, with no version check and no site or
 * permission check: site enablement, membersMayWatch and step-up are decided
 * by the session-create route, not by this menu.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { markThisMachine } from '@/lib/swoop/thisMachine';
import { activeHoursGuardOf, type ActiveHoursGuard, type PowerCommandOptions, type PowerCommandSent } from '@/lib/activeHours';
import { computeSwoopMode, type UserRole } from '@/contexts/AuthContext';
import type { SiteRole } from '@/hooks/useFirestore';
import type { SwoopMode } from '@/lib/swoopMode';

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

// who is looking: a member of site-A unless a test says otherwise
let mockViewer: { isSuperadmin: boolean; isSiteMember: (siteId: string) => boolean; role?: string; userSites?: string[] } = {
  isSuperadmin: false,
  isSiteMember: () => true,
};
jest.mock('@/contexts/AuthContext', () => ({
  // the real one: the swoop mode cases below derive noSwoop as the dashboard does
  computeSwoopMode: jest.requireActual('@/contexts/AuthContext').computeSwoopMode,
  useAuth: () => ({
    userPreferences: { mutedMachines: [] },
    updateUserPreferences: jest.fn(),
    ...mockViewer,
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

/** a whole-site admin, who is admin on every machine of the site too. */
const ADMIN = { isSiteAdmin: true, isMachineAdmin: true };
const OWNER = { siteId: 'site-A', isOwner: true };
const MEMBER_OF_SITE = { siteId: 'site-A', isOwner: false };
const BILLING = '/admin/sites/site-A?section=billing';

async function openMenu(props: {
  isOnline?: boolean;
  isSiteAdmin?: boolean;
  isMachineAdmin?: boolean;
  rebooting?: boolean;
  rebootDeferredUntil?: number;
  onCancelRestart?: () => Promise<void>;
  swoopCapable?: boolean;
  swoopViewers?: number;
  onSwoop?: () => void;
  onSwoopApp?: () => void;
  onViewDisplays?: () => void;
  planLocked?: boolean;
  controlLocked?: boolean;
  swoopLocked?: boolean;
  hootLocked?: boolean;
  planSite?: { siteId: string; isOwner: boolean };
  swoopOff?: boolean;
  noSwoop?: boolean;
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
  it.each([
    ['reports no streamer', { swoopCapable: false }],
    ['reports no capabilities at all', {}],
  ])('offers the screenshot alone on a machine whose agent %s, and no live view', async (_label, props) => {
    await openMenu(props);

    expect(screen.getByTestId('machine-context-menu-screenshot')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
    expect(screen.queryByText('live view')).not.toBeInTheDocument();
  });

  it('shows swoop when capabilities.swoop === 1', async () => {
    await openMenu({ swoopCapable: true });

    expect(screen.getByTestId('machine-context-menu-swoop')).toHaveTextContent('swoop');
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
    ['swoop off for the site', { swoopCapable: true, swoopOff: true, ...ADMIN }],
  ])('is not there with %s', async (_label, props) => {
    await openMenu({ ...props, onSwoopApp: jest.fn() });

    expect(screen.queryByTestId('machine-context-menu-swoop-app')).not.toBeInTheDocument();
  });
});

// with the site's swoop off the server refuses every session, so the menu takes
// an admin to the switch and tells a member who can flip it.
describe('MachineContextMenu — swoop off for the site', () => {
  it('takes an admin to the switch', async () => {
    const onSiteSettings = jest.fn();
    const user = await openMenu({ swoopCapable: true, swoopOff: true, ...ADMIN, onSiteSettings });

    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('machine-context-menu-swoop-off'));

    expect(onSiteSettings).toHaveBeenCalledTimes(1);
  });

  it('tells a member who can turn it on', async () => {
    await openMenu({ swoopCapable: true, swoopOff: true });

    const item = screen.getByTestId('machine-context-menu-swoop-off');
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('ask a site owner or admin to turn it on');
  });

  it('says nothing on a machine without a streamer', async () => {
    await openMenu({ swoopCapable: false, swoopOff: true, ...ADMIN });

    expect(screen.queryByTestId('machine-context-menu-swoop-off')).not.toBeInTheDocument();
  });
});

// the dashboard hands the menu noSwoop when the viewer's effective swoop mode on
// the site is none (computeSwoopMode). the server still decides; this only stops
// the menu offering what it refuses. watch keeps the entry: the viewer asks for
// control and steps down to watching on capability_missing.
describe('MachineContextMenu — swoop mode', () => {
  const MEMBER = new Map<string, SiteRole>([['site-A', 'member']]);
  const NO_ROWS = new Map<string, SiteRole>();

  /** noSwoop as the dashboard derives it for the person on site-A. */
  function noSwoopFor(role: UserRole, roleMap: Map<string, SiteRole>, mode: SwoopMode | null, membersMayWatch: boolean) {
    const swoopMap = new Map<string, SwoopMode>(mode ? [['site-A', mode]] : []);
    return computeSwoopMode(role, roleMap, swoopMap, 'site-A', membersMayWatch) === 'none';
  }

  it.each<[string, UserRole, Map<string, SiteRole>, SwoopMode | null, boolean]>([
    ['a member set to watch', 'member', MEMBER, 'view', true],
    ['a member set to watch, where members may not watch by default', 'member', MEMBER, 'view', false],
    ['a member with no mode, where members may watch', 'member', MEMBER, null, true],
    ['a superadmin who is a member of the site', 'superadmin', MEMBER, null, false],
  ])('keeps swoop for %s', async (_label, role, roleMap, mode, membersMayWatch) => {
    await openMenu({ swoopCapable: true, swoopViewers: 2, noSwoop: noSwoopFor(role, roleMap, mode, membersMayWatch) });

    expect(screen.getByTestId('machine-context-menu-swoop')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-swoop-pill')).toHaveTextContent('2');
  });

  it.each<[string, UserRole, Map<string, SiteRole>, SwoopMode | null, boolean]>([
    ['a member set to none', 'member', MEMBER, 'none', true],
    ['a member with no mode, where members may not watch', 'member', MEMBER, null, false],
    // a site's screens are for its members, swoop's picture included (adr 0021)
    ['a superadmin on a site where they hold no row', 'superadmin', NO_ROWS, null, true],
  ])('offers %s no swoop', async (_label, role, roleMap, mode, membersMayWatch) => {
    await openMenu({
      swoopCapable: true,
      swoopViewers: 2,
      onSwoopApp: jest.fn(),
      noSwoop: noSwoopFor(role, roleMap, mode, membersMayWatch),
    });

    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-app')).not.toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-pill')).not.toBeInTheDocument();
  });

  it('drops the swoop-is-off row too, since turning the switch on would not help', async () => {
    await openMenu({ swoopCapable: true, noSwoop: true, swoopOff: true });

    expect(screen.queryByTestId('machine-context-menu-swoop-off')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-screenshot')).toBeInTheDocument();
  });

  it("drops the plan's swoop row too, since an upgrade would not help", async () => {
    await openMenu({ swoopCapable: true, noSwoop: true, swoopLocked: true });

    expect(screen.queryByTestId('machine-context-menu-swoop-upgrade')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-screenshot')).toBeInTheDocument();
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
// itself shows, so a stale count never lands on a machine without it or an offline one.
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

  it('shows no count on a machine without a streamer', async () => {
    await openMenu({ swoopViewers: 2 });

    expect(screen.getByTestId('machine-context-menu-screenshot')).toBeInTheDocument();
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

// the site's plan (useSitePlan): server gates every
// action regardless, so these only keep the menu from offering what would fail.
describe('MachineContextMenu — plan', () => {
  it("links a locked swoop to the site's billing section for its owner instead of opening a session", async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true, planSite: OWNER });

    const item = screen.getByTestId('machine-context-menu-swoop-upgrade');
    expect(item).toHaveTextContent('swooppart of core');
    expect(item).toHaveAttribute('href', BILLING);
    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
  });

  it('tells anyone else to ask the owner, with no link', async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true, planSite: MEMBER_OF_SITE });

    const item = screen.getByTestId('machine-context-menu-swoop-upgrade');
    expect(item).toHaveTextContent('swooppart of coreask the site owner to upgrade this site');
    expect(item).not.toHaveAttribute('href');
    expect(screen.queryByTestId('machine-context-menu-swoop')).not.toBeInTheDocument();
  });

  it("marks hoot part of pro, locked as swoop is: a link to the site's billing for its owner, ask the owner for anyone else", async () => {
    await openMenu({ hootLocked: true, planSite: OWNER });

    const item = screen.getByTestId('machine-context-menu-hoot-upgrade');
    expect(item).toHaveTextContent('hootpart of pro');
    expect(item).toHaveAttribute('href', BILLING);
    expect(screen.queryByTestId('machine-context-menu-hoot')).not.toBeInTheDocument();
    cleanup();

    await openMenu({ hootLocked: true, planSite: MEMBER_OF_SITE });
    const row = screen.getByTestId('machine-context-menu-hoot-upgrade');
    expect(row).toHaveTextContent('hootpart of proask the site owner to upgrade this site');
    expect(row).not.toHaveAttribute('href');
  });

  it('links a locked swoop to the plan page even with the site switch off, since turning it on would not help', async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true, swoopOff: true, ...ADMIN, onSiteSettings: jest.fn() });

    expect(screen.getByTestId('machine-context-menu-swoop-upgrade')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-swoop-off')).not.toBeInTheDocument();
  });

  it('drops the screenshot when control is out of the plan', async () => {
    await openMenu({ controlLocked: true, onViewDisplays: jest.fn() });

    expect(screen.queryByTestId('machine-context-menu-screenshot')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-view-displays')).toBeInTheDocument();
  });

  it('keeps a locked swoop row when control is out of the plan too, as on free', async () => {
    await openMenu({ swoopCapable: true, swoopLocked: true, controlLocked: true });

    expect(screen.getByTestId('machine-context-menu-swoop-upgrade')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-screenshot')).not.toBeInTheDocument();
  });

  it('keeps only alerts, the token and removal on a machine outside the plan', async () => {
    await openMenu({ planLocked: true, ...ADMIN, swoopCapable: true, onViewDisplays: jest.fn() });

    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'mute alerts',
      'revoke token',
      'remove machine',
    ]);
  });

  it("collapses restart and shutdown into one row linking to the site's billing section, keeping schedule restarts", async () => {
    await openMenu({ controlLocked: true, ...ADMIN, swoopCapable: true, swoopLocked: true, onViewDisplays: jest.fn(), planSite: OWNER });

    const row = screen.getByTestId('machine-context-menu-control-upgrade');
    expect(row).toHaveTextContent('remote controlpart of core');
    expect(row).toHaveAttribute('href', BILLING);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'remote controlpart of core',
      'schedule restarts',
      'swooppart of core',
      'view displays',
      'hoot',
      'mute alerts',
      'revoke token',
      'remove machine',
    ]);
  });

  it('shows a member the same control row with no link, asking the owner', async () => {
    await openMenu({ controlLocked: true, ...ADMIN, planSite: MEMBER_OF_SITE });

    const row = screen.getByTestId('machine-context-menu-control-upgrade');
    expect(row).toHaveTextContent('remote controlpart of coreask the site owner to upgrade this site');
    expect(row).not.toHaveAttribute('href');
  });

  it('still offers cancelling a restart without control, which every plan may', async () => {
    await openMenu({ controlLocked: true, ...ADMIN, rebooting: true });

    expect(screen.getByTestId('machine-context-menu-cancel-reboot')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-control-upgrade')).not.toBeInTheDocument();
  });

  it('offers everything as before when the plan leaves it all in', async () => {
    await openMenu({ ...ADMIN, onViewDisplays: jest.fn() });

    expect(screen.getByTestId('machine-context-menu-reboot')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-shutdown')).toBeInTheDocument();
    expect(screen.queryByTestId('machine-context-menu-control-upgrade')).not.toBeInTheDocument();
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
    const user = await openMenu({ ...ADMIN, activeHoursGuard: INSIDE, onRestart });

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
    const user = await openMenu({ ...ADMIN, activeHoursGuard: INSIDE, onRestart });

    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    await user.click(await screen.findByRole('button', { name: 'restart when active hours end' }));

    expect(onRestart).toHaveBeenCalledWith({ when: 'after_active_hours' });
  });

  it('keeps today\'s confirm where the agent guards nothing', async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ ...ADMIN, activeHoursGuard: null, onRestart });

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
    const user = await openMenu({ ...ADMIN, activeHoursGuard: rolledBack, onRestart });

    await user.click(screen.getByTestId('machine-context-menu-reboot'));
    expect(await screen.findByRole('dialog', { name: 'restart kiosk-1?' })).toHaveTextContent('60 seconds');
    expect(screen.queryByRole('button', { name: 'restart when active hours end' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'restart' }));
    expect(onRestart).toHaveBeenCalledWith({});
  });

  it('offers a shutdown inside the window only with a reason, never deferred', async () => {
    const onShutdown = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ ...ADMIN, activeHoursGuard: INSIDE, onShutdown });

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
    const user = await openMenu({ ...ADMIN, rebootDeferredUntil: HELD, onCancelRestart });

    await user.click(screen.getByTestId('machine-context-menu-cancel-reboot'));

    expect(onCancelRestart).toHaveBeenCalledTimes(1);
  });

  it('keeps restart and shutdown, and restart opens the usual confirm', async () => {
    const onRestart = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    const user = await openMenu({ ...ADMIN, rebootDeferredUntil: HELD, onRestart });

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
    await openMenu({ controlLocked: true, ...ADMIN, rebootDeferredUntil: HELD });

    expect(screen.getByTestId('machine-context-menu-cancel-reboot')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-control-upgrade')).toBeInTheDocument();
  });

  it('says nothing about it on an offline machine, as the pill', async () => {
    await openMenu({ isOnline: false, ...ADMIN, rebootDeferredUntil: HELD });

    expect(screen.queryByTestId('machine-context-menu-cancel-reboot')).not.toBeInTheDocument();
  });
});

// an admin limited to some machines commands their machines, and reaches
// nothing site-wide: no revoke token, no remove machine, no site settings.
describe('MachineContextMenu — machine scope', () => {
  const SCOPED_ADMIN = { isSiteAdmin: false, isMachineAdmin: true };
  const items = () => screen.getAllByRole('menuitem').map((item) => item.textContent);

  it('gives a scoped admin restart, shutdown and schedule restarts, and nothing site-wide', async () => {
    await openMenu({ ...SCOPED_ADMIN, swoopCapable: true, swoopOff: true, onSiteSettings: jest.fn() });

    expect(items()).toEqual([
      'restart machine',
      '',
      'shutdown machine',
      'swoop is offask a site owner or admin to turn it on',
      'screenshot',
      'hoot',
      'mute alerts',
    ]);
    expect(screen.getByTestId('machine-context-menu-schedule-restarts-gear')).toHaveAccessibleName('schedule restarts');
    expect(screen.getByTestId('machine-context-menu-swoop-off')).toHaveAttribute('aria-disabled', 'true');
  });

  it('lets a scoped admin cancel a restart under way', async () => {
    const onCancelRestart = jest.fn().mockResolvedValue(undefined);
    const user = await openMenu({ ...SCOPED_ADMIN, rebooting: true, onCancelRestart });

    await user.click(screen.getByTestId('machine-context-menu-cancel-reboot'));

    expect(onCancelRestart).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('machine-context-menu-revoke-token')).not.toBeInTheDocument();
  });

  it('keeps schedule restarts for a scoped admin on an offline machine', async () => {
    await openMenu({ ...SCOPED_ADMIN, isOnline: false });

    expect(items()).toEqual(['schedule restarts', 'hoot', 'mute alerts']);
  });

  it.each([
    ['online', { swoopCapable: true, swoopOff: true }],
    ['restarting', { rebooting: true, onCancelRestart: jest.fn() }],
    ['offline', { isOnline: false }],
  ])('gives a member none of them while %s', async (_label, props) => {
    await openMenu(props);

    for (const testId of [
      'machine-context-menu-reboot',
      'machine-context-menu-shutdown',
      'machine-context-menu-cancel-reboot',
      'machine-context-menu-schedule-restarts',
      'machine-context-menu-schedule-restarts-gear',
      'machine-context-menu-revoke-token',
      'machine-context-menu-remove',
    ]) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
    expect(items()).not.toContain('turn on swoop…');
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

// a superadmin reaches every site, but a site's screenshots are for its members
describe('MachineContextMenu — screenshot', () => {
  afterEach(() => {
    mockViewer = { isSuperadmin: false, isSiteMember: () => true };
  });

  it('offers a screenshot to a member of the site', async () => {
    await openMenu({});

    expect(screen.getByTestId('machine-context-menu-screenshot')).toHaveTextContent('screenshot');
  });

  it('offers a superadmin who is a member of the site a screenshot', async () => {
    mockViewer = { isSuperadmin: true, isSiteMember: (siteId) => siteId === 'site-A' };
    await openMenu({});

    expect(screen.getByTestId('machine-context-menu-screenshot')).toBeInTheDocument();
  });

  it('offers a superadmin who is not a member of the site no screenshot, and keeps the rest', async () => {
    mockViewer = { isSuperadmin: true, isSiteMember: () => false };
    await openMenu({ ...ADMIN });

    expect(screen.queryByTestId('machine-context-menu-screenshot')).not.toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-hoot')).toBeInTheDocument();
  });
});

// a superadmin without a member row restarts a machine and revokes its token, and changes nothing else (adr 0021)
describe('MachineContextMenu — a superadmin who is not a member', () => {
  afterEach(() => {
    mockViewer = { isSuperadmin: false, isSiteMember: () => true };
  });

  it('keeps restart and revoke token, and drops shutdown, schedule restarts and remove machine', async () => {
    mockViewer = { isSuperadmin: true, role: 'superadmin', userSites: [], isSiteMember: () => false };
    await openMenu({ ...ADMIN });

    expect(screen.getByTestId('machine-context-menu-reboot')).toBeInTheDocument();
    expect(screen.getByTestId('machine-context-menu-revoke-token')).toBeInTheDocument();
    for (const testId of ['machine-context-menu-shutdown', 'machine-context-menu-schedule-restarts-gear', 'machine-context-menu-remove']) {
      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
    }
  });

  it('offers a superadmin who is a member all of them', async () => {
    mockViewer = { isSuperadmin: true, role: 'superadmin', userSites: ['site-A'], isSiteMember: () => true };
    await openMenu({ ...ADMIN });

    for (const testId of ['machine-context-menu-shutdown', 'machine-context-menu-schedule-restarts-gear', 'machine-context-menu-remove']) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });
});
