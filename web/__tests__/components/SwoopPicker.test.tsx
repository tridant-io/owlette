/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * SwoopPicker — the `/swoop` page (dev/active/swoop-viewer, task 1.2).
 *
 * a card opens the viewer the way the dashboard does, or says why it can't;
 * who may turn swoop on for the site gets the way there, everyone else is told
 * who can; inside owlette swoop the page is home, so it has no way back. in a
 * browser a ready card's corner button opens the machine in owlette swoop
 * (2.7). the machines are a grid of up to four columns (2.10). inside owlette
 * swoop a card opens the session in the same window, and a right-click or
 * shift+enter in a new one (2.11b).
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopPicker } from '@/components/swoop/SwoopPicker';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Machine } from '@/hooks/useFirestore';

const SITE = 'site-1';
const APP_UA = 'Mozilla/5.0 Chrome/141.0.0.0 owlette-swoop-viewer/4.1.8';

// what the open says when it fails or finds no app is openViewerApp's own test
const mockOpenInViewerApp = jest.fn();
jest.mock('@/lib/swoop/openViewerApp', () => ({
  openInViewerApp: (...args: unknown[]) => mockOpenInViewerApp(...args),
}));

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), prefetch: jest.fn() }),
}));

// jsdom ships no ResizeObserver; the right-click menu's positioning constructs one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
window.HTMLElement.prototype.scrollIntoView = jest.fn();
window.HTMLElement.prototype.hasPointerCapture = jest.fn();
window.HTMLElement.prototype.releasePointerCapture = jest.fn();

// the root layout's provider, without its delay
const renderPicker = () =>
  render(<SwoopPicker />, {
    wrapper: ({ children }) => <TooltipProvider delayDuration={0}>{children}</TooltipProvider>,
  });

let siteAdmin = true;
let sites = [{ id: SITE, name: 'Site One' }];
let machines: Partial<Machine>[] = [];
let swoopOn = true;
let machinesSiteId = '';
const updateLastSite = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { uid: 'u1' },
    loading: false,
    isSuperadmin: false,
    isSiteAdmin: () => siteAdmin,
    userSites: [SITE],
    lastSiteId: null,
    updateLastSite,
  }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useSites: () => ({ sites, loading: false }),
  useMachines: (siteId: string) => {
    machinesSiteId = siteId;
    return { machines: siteId ? machines : [], loading: false };
  },
}));

jest.mock('@/hooks/useSwoopSettings', () => ({
  useSwoopSettings: () => ({ settings: { enabled: swoopOn }, loading: false }),
}));

const machine = (machineId: string, patch: Partial<Machine> = {}): Partial<Machine> => ({
  machineId,
  online: true,
  lastHeartbeat: 0,
  capabilities: { swoop: 1 },
  ...patch,
});

const card = (id: string) => screen.getByTestId(`swoop-picker-machine-${id}`);
const reason = (id: string) => screen.getByTestId(`swoop-picker-reason-${id}`);

beforeEach(() => {
  siteAdmin = true;
  sites = [{ id: SITE, name: 'Site One' }];
  machines = [];
  swoopOn = true;
  localStorage.clear();
  mockPush.mockClear();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('SwoopPicker', () => {
  it('opens a ready machine the way the dashboard does', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    machines = [machine('kiosk.lobby', { osFamily: 'linux', swoopViewers: 2 })];
    renderPicker();

    const ready = await screen.findByTestId('swoop-picker-machine-kiosk.lobby');
    expect(ready).toBeEnabled();
    expect(ready).toHaveTextContent('linux');
    expect(within(ready).getByText('2')).toBeInTheDocument();
    expect(screen.queryByTestId('swoop-picker-reason-kiosk.lobby')).toBeNull();

    await user.click(ready);
    expect(open).toHaveBeenCalledWith('/swoop/site-1/kiosk.lobby', '_blank', 'noopener');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows the machines as a grid of at most four columns', async () => {
    machines = [machine('m1'), machine('m2')];
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-m1');
    const grid = screen.getByTestId('swoop-picker-grid');
    expect(grid).toHaveClass('grid', 'grid-cols-1', 'sm:grid-cols-2', 'md:grid-cols-3', 'xl:grid-cols-4');
    expect(grid.className).not.toMatch(/grid-cols-([5-9]|1\d)/);
    // each machine is a bordered card whose button fills it
    const frame = card('m1').parentElement!;
    expect(frame.tagName).toBe('LI');
    expect(frame).toHaveClass('rounded-lg', 'border', 'border-border', 'bg-card');
    expect(card('m1')).toHaveClass('flex-1', 'cursor-pointer');
  });

  it('opens a ready card from the keyboard with enter or space', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    machines = [machine('m1')];
    renderPicker();

    const ready = await screen.findByRole('button', { name: /m1/ });
    expect(ready).toBe(card('m1'));
    ready.focus();
    await user.keyboard('{Enter}');
    expect(open).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenLastCalledWith('/swoop/site-1/m1', '_blank', 'noopener');
  });

  it('says why each other machine is disabled', async () => {
    machines = [
      machine('m-offline', { online: false }),
      machine('m-old', { capabilities: {} }),
      machine('m-self'),
      machine('m-ready'),
    ];
    // what the viewer page records when the streamer answers `same_machine`
    localStorage.setItem('owlette.swoop.thisMachine', `${SITE}/m-self`);
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-m-ready');
    expect(card('m-offline')).toBeDisabled();
    expect(reason('m-offline')).toHaveTextContent(/^offline$/);
    expect(card('m-old')).toBeDisabled();
    expect(reason('m-old')).toHaveTextContent("agent can't stream yet");
    expect(card('m-self')).toBeDisabled();
    expect(reason('m-self')).toHaveTextContent("you're on this machine");
    expect(card('m-ready')).toBeEnabled();
    // the reason is the disabled card's description, and its last line
    expect(card('m-old')).toHaveAccessibleDescription("agent can't stream yet");
    const frame = card('m-old').parentElement!;
    expect(frame.lastElementChild).toBe(reason('m-old'));
    expect(reason('m-old')).toHaveClass('text-muted-foreground');
    expect(card('m-old')).not.toHaveClass('cursor-pointer');
  });

  it('lists online machines first, then by name', async () => {
    machines = [
      machine('zeta'),
      machine('alpha', { online: false }),
      machine('Beta'),
    ];
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-zeta');
    const ids = screen
      .getAllByTestId(/^swoop-picker-machine-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual([
      'swoop-picker-machine-Beta',
      'swoop-picker-machine-zeta',
      'swoop-picker-machine-alpha',
    ]);
  });

  it('gives a site admin the way to site settings when swoop is off', async () => {
    swoopOn = false;
    machines = [machine('m1')];
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-m1');
    expect(card('m1')).toBeDisabled();
    expect(reason('m1')).toHaveTextContent('swoop is off for this site');
    const link = within(reason('m1')).getByRole('link', { name: 'open site settings' });
    expect(link).toHaveAttribute('href', '/dashboard?settings=site-1');
    expect(reason('m1')).not.toHaveTextContent('ask a site owner');
  });

  it('tells a member who can turn swoop on', async () => {
    swoopOn = false;
    siteAdmin = false;
    machines = [machine('m1')];
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-m1');
    expect(reason('m1')).toHaveTextContent(
      'swoop is off for this site · ask a site owner or admin to turn it on',
    );
    expect(within(reason('m1')).queryByRole('link')).toBeNull();
  });

  it('links back to the dashboard in a browser, not inside owlette swoop', async () => {
    machines = [machine('m1')];
    const { unmount } = renderPicker();
    expect(screen.getByTestId('swoop-picker-dashboard-link')).toHaveAttribute('href', '/dashboard');
    unmount();

    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    renderPicker();
    await screen.findByTestId('swoop-picker-machine-m1');
    expect(screen.queryByTestId('swoop-picker-dashboard-link')).toBeNull();
  });

  it("in a browser, a ready card's corner button opens the machine in owlette swoop", async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    machines = [
      machine('kiosk.lobby'),
      machine('m-offline', { online: false }),
      machine('m-old', { capabilities: {} }),
    ];
    renderPicker();

    const app = await screen.findByTestId('swoop-picker-app-kiosk.lobby');
    expect(app).toHaveAccessibleName('open in the owlette swoop desktop app');
    expect(screen.queryByTestId('swoop-picker-app-m-offline')).toBeNull();
    expect(screen.queryByTestId('swoop-picker-app-m-old')).toBeNull();
    // in the card's top-right corner, beside the card's button rather than inside it
    const ready = card('kiosk.lobby');
    expect(ready).not.toContainElement(app);
    expect(app.parentElement).toBe(ready.parentElement);
    expect(app).toHaveClass('absolute', 'top-1.5', 'right-1.5');

    await user.click(app);
    expect(mockOpenInViewerApp).toHaveBeenCalledTimes(1);
    expect(mockOpenInViewerApp).toHaveBeenCalledWith('site-1', 'kiosk.lobby');
    // a target of its own: the card's viewer window does not open as well
    expect(open).not.toHaveBeenCalled();
  });

  it('reaches the corner button from the keyboard, with its tooltip', async () => {
    const user = userEvent.setup();
    machines = [machine('m1')];
    renderPicker();

    card('m1').focus();
    await user.tab();
    const app = screen.getByTestId('swoop-picker-app-m1');
    expect(app).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('open in the owlette swoop desktop app');
    await user.keyboard('{Enter}');
    expect(mockOpenInViewerApp).toHaveBeenCalledWith('site-1', 'm1');
  });

  it('has no corner button inside owlette swoop', async () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    machines = [machine('m1')];
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-m1');
    expect(screen.queryByTestId('swoop-picker-app-m1')).toBeNull();
  });

  it('inside owlette swoop a ready card opens the session in this window', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    machines = [machine('kiosk.lobby'), machine('m-offline', { online: false })];
    renderPicker();

    const ready = await screen.findByTestId('swoop-picker-machine-kiosk.lobby');
    expect(ready).toHaveAttribute('title', 'right-click or shift+enter for a new window');
    expect(card('m-offline')).not.toHaveAttribute('title');
    await user.click(ready);
    expect(mockPush).toHaveBeenCalledWith('/swoop/site-1/kiosk.lobby');
    ready.focus();
    await user.keyboard('{Enter}');
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it('inside owlette swoop a right-click on a ready card offers a new window, at the pointer', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    machines = [machine('m1')];
    renderPicker();

    const ready = await screen.findByTestId('swoop-picker-machine-m1');
    // false: the webview's own menu is held back
    expect(fireEvent.contextMenu(ready, { clientX: 120, clientY: 80 })).toBe(false);
    const item = await screen.findByRole('menuitem', { name: 'open in new window' });
    expect(ready.parentElement!.querySelector('[aria-haspopup="menu"]')).toHaveStyle({ left: '120px', top: '80px' });
    await user.click(item);
    expect(open).toHaveBeenCalledWith('/swoop/site-1/m1', '_blank', 'noopener');
    expect(mockPush).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(ready).toHaveFocus();
  });

  it('inside owlette swoop escape closes the right-click menu without opening anything', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    machines = [machine('m1')];
    renderPicker();

    const ready = await screen.findByTestId('swoop-picker-machine-m1');
    fireEvent.contextMenu(ready, { clientX: 10, clientY: 10 });
    await screen.findByRole('menuitem', { name: 'open in new window' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(ready).toHaveFocus();
    expect(open).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('inside owlette swoop a card that goes offline drops its menu, which stays shut when it is back', async () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    machines = [machine('m1')];
    const { rerender } = renderPicker();

    fireEvent.contextMenu(await screen.findByTestId('swoop-picker-machine-m1'), { clientX: 10, clientY: 10 });
    await screen.findByRole('menuitem', { name: 'open in new window' });
    machines = [machine('m1', { online: false })];
    rerender(<SwoopPicker />);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    machines = [machine('m1')];
    rerender(<SwoopPicker />);
    expect(card('m1')).toBeEnabled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('inside owlette swoop shift+enter on a ready card opens a new window', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    machines = [machine('m1')];
    renderPicker();

    (await screen.findByTestId('swoop-picker-machine-m1')).focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/swoop/site-1/m1', '_blank', 'noopener');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('in a browser a card has no right-click menu, and shift+enter opens it as enter does', async () => {
    const user = userEvent.setup();
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    machines = [machine('m1')];
    renderPicker();

    const ready = await screen.findByTestId('swoop-picker-machine-m1');
    expect(ready).not.toHaveAttribute('title');
    expect(fireEvent.contextMenu(ready)).toBe(true);
    expect(screen.queryByRole('menuitem', { name: 'open in new window' })).toBeNull();
    ready.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('/swoop/site-1/m1', '_blank', 'noopener');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("is the window's title bar inside owlette swoop, and only there", async () => {
    machines = [machine('m1')];
    const { unmount } = renderPicker();
    await screen.findByTestId('swoop-picker-machine-m1');
    const browserHeader = screen.getByRole('banner');
    expect(browserHeader).not.toHaveAttribute('data-tauri-drag-region');
    expect(within(browserHeader).getByTestId('swoop-picker-header-row')).toHaveClass('mx-auto');
    expect(within(browserHeader).queryByTestId('window-controls')).toBeNull();
    unmount();

    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    renderPicker();
    await screen.findByTestId('swoop-picker-machine-m1');
    const header = screen.getByRole('banner');
    expect(header).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(header).toHaveClass('sticky');
    expect(header).toHaveClass('bg-card');
    expect(screen.getByRole('main')).toHaveClass('fade-in-0');
    // the mark sits in the corner, as in the desktop app, not centred like the web page
    expect(within(header).getByTestId('swoop-picker-header-row')).not.toHaveClass('mx-auto');
    expect(within(header).getByTestId('window-controls')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'close' })).toBeInTheDocument();
  });

  it('grows a filter past eight machines', async () => {
    const user = userEvent.setup();
    machines = Array.from({ length: 8 }, (_, i) => machine(`m${i}`));
    const { unmount } = renderPicker();
    await screen.findByTestId('swoop-picker-machine-m0');
    expect(screen.queryByLabelText('filter machines')).toBeNull();
    unmount();

    machines = [...machines, machine('lobby-wall')];
    renderPicker();
    await user.type(await screen.findByLabelText('filter machines'), 'lobby');
    expect(within(screen.getByTestId('swoop-picker-grid')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByTestId(/^swoop-picker-machine-/)).toHaveLength(1);
    expect(card('lobby-wall')).toBeInTheDocument();
  });

  it('opens on the site this browser last used, like the dashboard', async () => {
    sites = [
      { id: SITE, name: 'Site One' },
      { id: 'site-2', name: 'Site Two' },
    ];
    machines = [machine('m1')];
    localStorage.setItem('owlette_current_site', 'site-2');
    renderPicker();

    await screen.findByTestId('swoop-picker-machine-m1');
    expect(screen.getByTestId('swoop-picker-site')).toHaveTextContent('Site Two');
    expect(machinesSiteId).toBe('site-2');
  });

  it('says so when there is no site, or no machine', () => {
    sites = [];
    const { unmount } = renderPicker();
    expect(screen.getByText("you're not a member of any site yet")).toBeInTheDocument();
    unmount();

    sites = [{ id: SITE, name: 'Site One' }];
    renderPicker();
    expect(screen.getByText('no machines in this site yet')).toBeInTheDocument();
  });
});
