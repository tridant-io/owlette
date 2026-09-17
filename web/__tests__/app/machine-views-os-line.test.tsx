/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The OS line on both machine views.
 *
 * `osVersion` is written by agents that report their platform; every agent in
 * the field before that reports nothing. So the contract has two halves and
 * both are asserted here:
 *
 *   - present: the card's subtitle under the hostname becomes the OS string and
 *     the "<timezone>, <clock> local" line it replaces is gone — that clock is
 *     already beside the online pill, whose tooltip now names the timezone so
 *     the city is not lost. The list view grows a second muted line under the
 *     hostname.
 *   - absent: both views render exactly what they rendered before — the clock
 *     line on the card, and nothing at all in the list row (no empty element,
 *     which would change every row's height on a fleet of older agents).
 *
 * Radix renders tooltip content into a portal only while open, and jsdom has no
 * pointer model to open it with, so the tooltip primitives are swapped for
 * inline passthroughs: the assertions here are about copy, not about hover.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { MachineRow } from '@/app/dashboard/components/MachineListView';
import type { Machine } from '@/hooks/useFirestore';

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: {
      temperatureUnit: 'C',
      timeDisplayMode: 'machine',
      timezone: undefined,
      mutedMachines: [],
    },
    isSiteAdmin: () => true,
  }),
}));

jest.mock('@/hooks/useMinuteTick', () => ({ useMinuteTick: () => undefined }));

jest.mock('@/hooks/useDevicePrefs', () => ({
  useDevicePrefs: () => ({ prefs: { cardView: {}, listView: {} }, setCardPref: jest.fn() }),
}));

jest.mock('@/hooks/useSparklineData', () => ({
  useAllSparklineData: () => ({ cpu: [], memory: [], disk: [], gpu: [], loading: false }),
}));

jest.mock('@/hooks/useDisplayState', () => ({
  useDisplayState: () => ({ profile: null }),
}));

// Canvas, portals and dropdowns — none of them is what this file is about.
jest.mock('@/components/charts', () => ({
  SparklineChart: () => <div data-testid="sparkline-stub" />,
}));
jest.mock('@/components/charts/DisplayCanvas', () => ({
  DisplayCanvas: () => <div data-testid="display-canvas-stub" />,
}));
jest.mock('@/components/MachineContextMenu', () => ({
  MachineContextMenu: () => <div data-testid="machine-context-menu-stub" />,
}));
jest.mock('@/components/MachineStatusPill', () => ({
  MachineStatusPill: () => <div data-testid="machine-status-pill-stub" />,
}));

const SITE_ID = 'site-A';

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    machineId: 'lobby-pc',
    lastHeartbeat: Math.floor(Date.now() / 1000),
    online: true,
    agent_version: '3.3.5',
    machineTimezone: 'America/Los_Angeles',
    processes: [],
    ...overrides,
  };
}

/** A second machine in another zone: the card view only draws the clock line
 *  when the site spans more than one timezone. */
function siblingMachine(): Machine {
  return machine({ machineId: 'back-office', machineTimezone: 'America/New_York' });
}

function renderCards(
  machines: Machine[],
  props: Partial<React.ComponentProps<typeof MachineCardView>> = {},
) {
  return render(
    <MachineCardView
      machines={machines}
      statsExpanded={false}
      processesExpanded={false}
      currentSiteId={SITE_ID}
      siteTimezone="America/Los_Angeles"
      siteTimeFormat="24h"
      {...props}
      onToggleStats={jest.fn()}
      onToggleProcesses={jest.fn()}
      onEditProcess={jest.fn()}
      onCreateProcess={jest.fn()}
      onKillProcess={jest.fn()}
      onRestartProcess={jest.fn()}
      onSetLaunchMode={jest.fn()}
      onRemoveMachine={jest.fn()}
    />,
  );
}

function renderRow(m: Machine) {
  return render(
    <table>
      <tbody>
        <MachineRow
          machine={m}
          isExpanded={false}
          currentSiteId={SITE_ID}
          siteTimezone="America/Los_Angeles"
          siteTimeFormat="24h"
          userPreferences={{ temperatureUnit: 'C' }}
          showLocalClock
          onToggleExpanded={jest.fn()}
          onEditProcess={jest.fn()}
          onCreateProcess={jest.fn()}
          onKillProcess={jest.fn()}
          onRestartProcess={jest.fn()}
          onSetLaunchMode={jest.fn()}
          onRemoveMachine={jest.fn()}
        />
      </tbody>
    </table>,
  );
}

/** The first card, which is always the machine under test. */
const firstCard = () => within(screen.getAllByTestId('machine-card')[0]);

describe('the card subtitle under the hostname', () => {
  it('is the OS string when the agent reports one, and the clock line is gone', () => {
    renderCards([machine({ osVersion: 'Windows 11 Pro 24H2' }), siblingMachine()]);

    const card = firstCard();
    expect(card.getByTestId('machine-os-version')).toHaveTextContent('Windows 11 Pro 24H2');
    expect(card.queryByText(/Los Angeles, \d{2}:\d{2} local/)).toBeNull();
  });

  it('stays the clock line for an agent that reports no OS', () => {
    renderCards([machine(), siblingMachine()]);

    const card = firstCard();
    expect(card.queryByTestId('machine-os-version')).toBeNull();
    expect(card.getByText(/Los Angeles, \d{2}:\d{2} local/)).toBeInTheDocument();
  });

  it('renders the OS even on a single-timezone site, which never drew a clock line', () => {
    renderCards([machine({ osVersion: 'Ubuntu 24.04.5 LTS' })]);

    expect(firstCard().getByTestId('machine-os-version')).toHaveTextContent('Ubuntu 24.04.5 LTS');
  });

  it('keeps the clock tooltip whichever string it shows', () => {
    // The subtitle's tooltip is the only place a card says that launch windows
    // follow the site rather than the machine, so swapping the visible string
    // for the OS must not take the copy with it.
    const siteTime = { schedulesFollowSiteTime: true, siteTimezone: 'America/New_York' };
    const scheduleLine = "process launch windows run on the site's clock (America/New_York).";

    const withOs = renderCards([machine({ osVersion: 'Windows 11 Pro 24H2' }), siblingMachine()], siteTime);
    expect(firstCard().getByText(scheduleLine)).toBeInTheDocument();
    withOs.unmount();

    // The control: the clock line carried that copy before the OS took the line.
    renderCards([machine(), siblingMachine()], siteTime);
    expect(firstCard().getByText(scheduleLine)).toBeInTheDocument();
  });
});

describe('the heartbeat tooltip beside the online pill', () => {
  it('names the machine timezone, so the city survives the subtitle swap', () => {
    renderCards([machine({ osVersion: 'Windows 11 Pro 24H2' }), siblingMachine()]);

    expect(firstCard().getByText('machine timezone: Los Angeles')).toBeInTheDocument();
  });

  it('says nothing about a timezone for a machine that reports none', () => {
    renderCards([machine({ machineTimezone: undefined, osVersion: 'Windows 11 Pro 24H2' })]);

    expect(firstCard().queryByText(/machine timezone:/)).toBeNull();
  });
});

describe('the list row hostname cell', () => {
  it('carries the OS on a second muted line', () => {
    renderRow(machine({ osVersion: 'Ubuntu 24.04.5 LTS' }));

    const osLine = screen.getByTestId('machine-os-version');
    expect(osLine).toHaveTextContent('Ubuntu 24.04.5 LTS');
    // The muted figure style the ram/disk columns use and nothing else: an
    // indent here costs 20px of a 130px column, which truncates both of the
    // strings the fleet actually reports.
    expect(osLine.className).toBe('text-muted-foreground text-xs truncate');
  });

  it('renders nothing when the agent reports no OS, keeping the row height', () => {
    renderRow(machine());

    expect(screen.queryByTestId('machine-os-version')).toBeNull();
    // The clock line is still the only thing under the hostname.
    expect(screen.getByText(/Los Angeles, \d{2}:\d{2}/)).toBeInTheDocument();
  });
});
