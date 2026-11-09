/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * A machine outside the viewer's machine limit, on both machine views (plan.md
 * decision 9): the name and status stay, an upgrade notice stands in for the
 * metrics, displays and processes, a lock replaces the display button, and the
 * menu learns the machine is locked. Without control, the live machine keeps
 * process configuration but trades restart, kill and restart approval for a
 * "part of core" link. Every machine with no plan passed renders as before.
 *
 * Who may act is per machine too (machine scope, ADR 0016): an admin limited
 * to some machines gets commands and process editing on those, and the menu
 * learns they are not a whole-site admin; a member gets neither.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { MachineRow } from '@/app/dashboard/components/MachineListView';
import type { Machine } from '@/hooks/useFirestore';
import type { SitePlan } from '@/hooks/useSitePlan';

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// the viewer's row on the site: a whole-site admin unless a case says otherwise
let mockAccess: { role: 'admin' | 'member'; machineScope: string[] | null } = { role: 'admin', machineScope: null };
const mockIsSiteAdmin = () => mockAccess.role === 'admin' && mockAccess.machineScope === null;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: { temperatureUnit: 'C', timeDisplayMode: 'machine', timezone: undefined, mutedMachines: [] },
    isSiteAdmin: mockIsSiteAdmin,
    isMachineAdmin: (_siteId: string, machineId: string) =>
      mockAccess.role === 'admin' && (mockAccess.machineScope === null || mockAccess.machineScope.includes(machineId)),
    machineScope: () => mockAccess.machineScope,
    siteRole: () => mockAccess.role,
  }),
}));

jest.mock('@/contexts/DemoContext', () => ({ useDemoContext: () => null }));
jest.mock('@/hooks/useMinuteTick', () => ({ useMinuteTick: () => undefined }));
jest.mock('@/hooks/useDevicePrefs', () => ({
  useDevicePrefs: () => ({ prefs: { cardView: {}, listView: {} }, setCardPref: jest.fn() }),
}));

const mockSparkline = jest.fn();
jest.mock('@/hooks/useSparklineData', () => ({
  useAllSparklineData: (siteId: string, machineId: string | null) => {
    mockSparkline(siteId, machineId);
    return { cpu: [], memory: [], disk: [], gpu: [], loading: false };
  },
}));
jest.mock('@/hooks/useDisplayState', () => ({ useDisplayState: () => ({ profile: null }) }));
jest.mock('@/components/charts', () => ({ SparklineChart: () => null }));
jest.mock('@/components/charts/DisplayCanvas', () => ({ DisplayCanvas: () => null }));

const mockMenuProps = jest.fn();
jest.mock('@/components/MachineContextMenu', () => ({
  MachineContextMenu: (props: { machineId: string }) => {
    mockMenuProps(props);
    return <div data-testid="machine-context-menu-stub" />;
  },
}));

const SITE_ID = 'site-A';

function machine(machineId: string): Machine {
  return {
    machineId,
    lastHeartbeat: Math.floor(Date.now() / 1000),
    online: true,
    rebootPending: { active: true, processName: 'show', reason: 'show crashed', timestamp: 1 },
    metrics: { cpu: { percent: 40 }, memory: { percent: 50 } },
    processes: [{ id: 'p1', name: 'show.exe', status: 'RUNNING', exe_path: 'C:/show.exe' }],
  } as unknown as Machine;
}

/** free on an owned site: kiosk-1 is live, everything else is locked. */
const FREE_SITE: SitePlan = {
  machineLimitFor: (id) => (id === 'kiosk-1' ? null : 1),
  controlLocked: true,
  swoopLocked: true,
};

function renderCards(sitePlan?: SitePlan, props: Partial<React.ComponentProps<typeof MachineCardView>> = {}) {
  return render(
    <MachineCardView
      machines={[machine('kiosk-1'), machine('kiosk-2')]}
      statsExpanded
      processesExpanded
      currentSiteId={SITE_ID}
      sitePlan={sitePlan}
      onToggleStats={jest.fn()}
      onToggleProcesses={jest.fn()}
      onEditProcess={jest.fn()}
      onCreateProcess={jest.fn()}
      onKillProcess={jest.fn()}
      onRestartProcess={jest.fn()}
      onSetLaunchMode={jest.fn()}
      onRemoveMachine={jest.fn()}
      onMetricClick={jest.fn()}
      {...props}
    />,
  );
}

const card = (machineId: string) =>
  within(screen.getAllByTestId('machine-card').find((el) => el.textContent?.includes(machineId))!);

const menuPropsFor = (machineId: string) =>
  mockMenuProps.mock.calls.map(([props]) => props).filter((props) => props.machineId === machineId).at(-1);

beforeEach(() => {
  mockMenuProps.mockClear();
  mockSparkline.mockClear();
  mockAccess = { role: 'admin', machineScope: null };
});

describe('machine card outside the plan', () => {
  it('shows the notice instead of everything below the header, with an upgrade link', () => {
    renderCards(FREE_SITE);
    const locked = card('kiosk-2');

    expect(locked.getByTestId('machine-plan-notice')).toHaveTextContent(
      'your plan covers 1 machine. upgrade to see this one.',
    );
    expect(locked.getByRole('link', { name: 'upgrade' })).toHaveAttribute('href', '/settings/plan');
    expect(locked.getByTestId('machine-plan-lock')).toHaveAttribute('href', '/settings/plan');
    expect(locked.queryByTestId('open-display-panel')).toBeNull();
    expect(locked.queryByTestId('reboot-pending-banner')).toBeNull();
    expect(locked.queryByText('show.exe')).toBeNull();
    expect(locked.queryByText(/no display data/)).toBeNull();
    expect(locked.getByText('kiosk-2')).toBeInTheDocument();
    expect(mockSparkline).toHaveBeenCalledWith(SITE_ID, null);
    expect(menuPropsFor('kiosk-2')).toMatchObject({ planLocked: true, controlLocked: true, swoopLocked: true });
  });

  it('leaves the live machine whole, with control and swoop still following the plan', () => {
    renderCards(FREE_SITE);
    const live = card('kiosk-1');

    expect(live.queryByTestId('machine-plan-notice')).toBeNull();
    expect(live.getByTestId('open-display-panel')).toBeInTheDocument();
    expect(live.getByTestId('reboot-pending-banner')).toBeInTheDocument();
    expect(live.getByText('show.exe')).toBeInTheDocument();
    expect(mockSparkline).toHaveBeenCalledWith(SITE_ID, 'kiosk-1');
    expect(menuPropsFor('kiosk-1')).toMatchObject({ planLocked: false, controlLocked: true, swoopLocked: true });
  });

  it('without control, keeps process configuration but trades restart, kill and approval for a part-of-core link', () => {
    renderCards(FREE_SITE);
    const live = card('kiosk-1');

    const link = live.getByTestId('control-upgrade');
    expect(link).toHaveAttribute('href', '/settings/plan');
    expect(link).toHaveAccessibleName('restart and kill are part of core');
    expect(link).toHaveTextContent('part of core');
    expect(live.queryByRole('button', { name: 'restart show.exe' })).toBeNull();
    expect(live.queryByRole('button', { name: 'kill show.exe' })).toBeNull();
    expect(live.getByRole('button', { name: 'edit show.exe' })).toBeInTheDocument();
    expect(live.getByRole('group', { name: 'launch mode for show.exe' })).toBeInTheDocument();
    expect(live.getByRole('button', { name: /add process/ })).toBeInTheDocument();
    expect(live.queryByTestId('reboot-pending-approve')).toBeNull();
    expect(live.getByTestId('reboot-pending-dismiss')).toBeInTheDocument();
  });

  it('renders every card as before with no plan', () => {
    renderCards();

    expect(screen.queryByTestId('machine-plan-notice')).toBeNull();
    expect(screen.queryByTestId('machine-plan-lock')).toBeNull();
    expect(screen.queryByTestId('control-upgrade')).toBeNull();
    expect(card('kiosk-1').getByRole('button', { name: 'restart show.exe' })).toBeInTheDocument();
    expect(card('kiosk-1').getByRole('button', { name: 'kill show.exe' })).toBeInTheDocument();
    expect(card('kiosk-1').getByTestId('reboot-pending-approve')).toBeInTheDocument();
    expect(screen.getAllByTestId('open-display-panel')).toHaveLength(2);
    expect(menuPropsFor('kiosk-2')).toMatchObject({ planLocked: false });
    expect(menuPropsFor('kiosk-2').controlLocked).toBeFalsy();
    expect(menuPropsFor('kiosk-2').swoopLocked).toBeFalsy();
  });

  it('counts machines in the copy past one', () => {
    renderCards({ ...FREE_SITE, machineLimitFor: (id) => (id === 'kiosk-1' ? null : 3) });

    expect(card('kiosk-2').getByTestId('machine-plan-notice')).toHaveTextContent('your plan covers 3 machines.');
  });
});

/** a list row as the dashboard renders it, which passes the site-wide flag from useAuth. */
function renderRow(props: Partial<React.ComponentProps<typeof MachineRow>> = {}) {
  const onToggleExpanded = jest.fn();
  render(
    <table>
      <tbody>
        <MachineRow
          machine={machine('kiosk-2')}
          isExpanded
          currentSiteId={SITE_ID}
          siteTimezone="UTC"
          siteTimeFormat="24h"
          userPreferences={{ temperatureUnit: 'C' }}
          isSiteAdmin={mockIsSiteAdmin()}
          onToggleExpanded={onToggleExpanded}
          onEditProcess={jest.fn()}
          onCreateProcess={jest.fn()}
          onKillProcess={jest.fn()}
          onRestartProcess={jest.fn()}
          onSetLaunchMode={jest.fn()}
          onRemoveMachine={jest.fn()}
          {...props}
        />
      </tbody>
    </table>,
  );
  return onToggleExpanded;
}

describe('machine row outside the plan', () => {
  it('spans the metric columns with the notice and drops the disclosure and processes', () => {
    const onToggleExpanded = renderRow({ planLimit: 1 });

    const notice = screen.getByTestId('machine-plan-notice');
    expect(notice.closest('td')).toHaveAttribute('colspan', '5');
    expect(screen.queryByRole('button', { name: 'processes for kiosk-2' })).toBeNull();
    expect(screen.queryByRole('button', { name: /open cpu history/ })).toBeNull();
    expect(screen.queryByText('show.exe')).toBeNull();
    expect(screen.getByTestId('machine-plan-lock')).toBeInTheDocument();

    screen.getByTestId('machine-row').click();
    expect(onToggleExpanded).not.toHaveBeenCalled();
    expect(menuPropsFor('kiosk-2')).toMatchObject({ planLocked: true });
  });

  it('without control, trades restart and kill for the part-of-core link in both layouts, keeping edit', () => {
    renderRow({ controlLocked: true });

    // the wide and the compact rail are both in the dom; css shows one.
    expect(screen.getAllByTestId('control-upgrade')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^restart/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^kill/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'more options for show.exe' })).toBeInTheDocument();
  });

  it('renders as before with no plan', () => {
    renderRow();

    expect(screen.queryByTestId('machine-plan-notice')).toBeNull();
    expect(screen.queryByTestId('control-upgrade')).toBeNull();
    expect(screen.getByRole('button', { name: 'processes for kiosk-2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open cpu history/ })).toBeInTheDocument();
    expect(screen.getByText('show.exe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'restart show.exe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'kill show.exe' })).toBeInTheDocument();
  });
});

describe('machine scope on both views', () => {
  /** a restart under way, which the status pill offers to cancel. */
  const counting = (machineId: string) =>
    ({ ...machine(machineId), rebooting: true, rebootScheduledAt: Math.floor(Date.now() / 1000) + 120 }) as Machine;

  type Access = typeof mockAccess;
  const SCOPED_ADMIN: Access = { role: 'admin', machineScope: ['kiosk-1'] };
  const MEMBER: Access = { role: 'member', machineScope: null };

  it('gives an admin limited to kiosk-1 its commands and process editing there, and the menu no site-wide items', () => {
    mockAccess = SCOPED_ADMIN;
    renderCards(undefined, { machines: [counting('kiosk-1'), counting('kiosk-2')], onCancelRestart: jest.fn() });

    const mine = card('kiosk-1');
    expect(mine.getByTestId('machine-status-cancel-pill')).toBeInTheDocument();
    expect(mine.getByTestId('reboot-pending-approve')).toBeInTheDocument();
    expect(mine.getByTestId('reboot-pending-dismiss')).toBeInTheDocument();
    expect(mine.getByRole('group', { name: 'launch mode for show.exe' })).toBeInTheDocument();
    expect(mine.getByRole('button', { name: 'edit show.exe' })).toBeInTheDocument();
    expect(mine.getByRole('button', { name: 'restart show.exe' })).toBeInTheDocument();
    expect(mine.getByRole('button', { name: /add process/ })).toBeInTheDocument();
    expect(menuPropsFor('kiosk-1')).toMatchObject({ isSiteAdmin: false, isMachineAdmin: true });

    // the dashboard never lists a machine outside the machine scope; were one there, it offers nothing
    const other = card('kiosk-2');
    expect(other.queryByTestId('machine-status-cancel-pill')).toBeNull();
    expect(other.queryByTestId('reboot-pending-approve')).toBeNull();
    expect(other.queryByRole('button', { name: 'edit show.exe' })).toBeNull();
    expect(menuPropsFor('kiosk-2')).toMatchObject({ isSiteAdmin: false, isMachineAdmin: false });
  });

  it('gives a member none of them', () => {
    mockAccess = MEMBER;
    renderCards(undefined, { machines: [counting('kiosk-1')], onCancelRestart: jest.fn() });

    const theirs = card('kiosk-1');
    expect(theirs.getByRole('img', { name: /^restarting, \d{2}:\d{2} remaining$/ })).toBeInTheDocument();
    expect(theirs.queryByTestId('machine-status-cancel-pill')).toBeNull();
    expect(theirs.getByTestId('reboot-pending-banner')).toBeInTheDocument();
    expect(theirs.queryByTestId('reboot-pending-approve')).toBeNull();
    expect(theirs.queryByTestId('reboot-pending-dismiss')).toBeNull();
    expect(theirs.queryByRole('group', { name: 'launch mode for show.exe' })).toBeNull();
    expect(theirs.queryByRole('button', { name: 'edit show.exe' })).toBeNull();
    expect(theirs.queryByRole('button', { name: 'restart show.exe' })).toBeNull();
    expect(theirs.queryByRole('button', { name: /add process/ })).toBeNull();
    expect(menuPropsFor('kiosk-1')).toMatchObject({ isSiteAdmin: false, isMachineAdmin: false });
  });

  it.each<[string, Access, boolean]>([
    ['an admin limited to it', { role: 'admin', machineScope: ['kiosk-2'] }, true],
    ['an admin limited to another machine', SCOPED_ADMIN, false],
    ['a member', MEMBER, false],
  ])('gives %s the same on a list row', (_label, access, acts) => {
    mockAccess = access;
    renderRow({ machine: counting('kiosk-2'), onCancelRestart: jest.fn() });

    for (const found of [
      screen.queryByTestId('machine-status-cancel-pill'),
      screen.queryByRole('group', { name: 'launch mode for show.exe' }),
      screen.queryByRole('button', { name: 'edit' }),
      screen.queryByRole('button', { name: 'more options for show.exe' }),
      screen.queryByRole('button', { name: 'restart show.exe' }),
      screen.queryByRole('button', { name: /add process/ }),
    ]) {
      if (acts) expect(found).toBeInTheDocument();
      else expect(found).toBeNull();
    }
    expect(menuPropsFor('kiosk-2')).toMatchObject({ isSiteAdmin: false, isMachineAdmin: acts });
  });
});
