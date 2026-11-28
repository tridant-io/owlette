/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * a card's open displays section while its layout is still on its way.
 *
 * each card subscribes to its own `hardware/display` doc, which lands after the
 * card has rendered. the section used to say "no display data reported" until
 * then and grew by the canvas when the layout arrived, so every card with its
 * displays open jumped once on load, carrying a menu opened from a card below it
 * out of the window. only windows agents report a layout, so a windows card
 * keeps the panes' room while it waits; a mac or linux card, which never gets
 * one, says so at once.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import type { Machine } from '@/hooks/useFirestore';

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: { temperatureUnit: 'C', timeDisplayMode: 'machine', timezone: undefined, mutedMachines: [] },
    isSiteAdmin: () => true,
    isMachineAdmin: () => true,
    machineScope: () => null,
    siteRole: () => 'admin',
  }),
}));

jest.mock('@/hooks/useMinuteTick', () => ({ useMinuteTick: () => undefined }));

jest.mock('@/hooks/useDevicePrefs', () => ({
  useDevicePrefs: () => ({ prefs: { cardView: {}, listView: {} }, setCardPref: jest.fn() }),
}));

jest.mock('@/hooks/useSparklineData', () => ({
  useAllSparklineData: () => ({ cpu: [], memory: [], disk: [], gpu: [], loading: false }),
}));

const mockDisplayState = jest.fn();
jest.mock('@/hooks/useDisplayState', () => ({
  useDisplayState: () => mockDisplayState(),
}));

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

const NO_DATA = 'no display data reported';

const MONITOR = {
  id: 'MONITOR\\TEST0',
  edidHash: 'hash-0',
  manufacturerId: 'TST',
  productCode: '0000',
  serialNumber: 'SN0',
  friendlyName: 'Test Monitor 1',
  position: { x: 0, y: 0 },
  resolution: { width: 1920, height: 1080 },
  refreshHz: 60,
  rotation: 0,
  scalePct: 100,
  primary: true,
  connectionType: 'dp',
  adapterLuid: '0:0',
  targetId: 0,
};

function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    machineId: 'lobby-pc',
    lastHeartbeat: Math.floor(Date.now() / 1000),
    online: true,
    agent_version: '4.2.7',
    machineTimezone: 'UTC',
    processes: [],
    ...overrides,
  };
}

function renderCard(m: Machine) {
  render(
    <MachineCardView
      machines={[m]}
      statsExpanded={false}
      processesExpanded={false}
      displaysExpanded
      currentSiteId="site-A"
      onToggleStats={jest.fn()}
      onToggleProcesses={jest.fn()}
      onToggleDisplays={jest.fn()}
      onEditProcess={jest.fn()}
      onCreateProcess={jest.fn()}
      onKillProcess={jest.fn()}
      onRestartProcess={jest.fn()}
      onSetLaunchMode={jest.fn()}
      onRemoveMachine={jest.fn()}
    />,
  );
  return within(screen.getByTestId('machine-card'));
}

describe("a card's open displays section", () => {
  beforeEach(() => mockDisplayState.mockReset());

  it('keeps the panes on a windows machine while its layout loads, and claims no missing data', () => {
    mockDisplayState.mockReturnValue({ profile: null, loading: true });
    const card = renderCard(machine());

    expect(card.queryByText(NO_DATA)).toBeNull();
    expect(card.getByTestId('display-panes')).toHaveAttribute('aria-busy', 'true');
    expect(card.queryByTestId('display-canvas-stub')).toBeNull();
  });

  it('fills the panes once the layout lands', () => {
    mockDisplayState.mockReturnValue({ profile: { monitors: [MONITOR] }, loading: false });
    const card = renderCard(machine());

    expect(card.getByTestId('display-panes')).toHaveAttribute('aria-busy', 'false');
    expect(card.getByTestId('display-canvas-stub')).toBeInTheDocument();
    expect(card.getByText('Test Monitor 1')).toBeInTheDocument();
  });

  it('says there is no data once a windows machine has none', () => {
    mockDisplayState.mockReturnValue({ profile: null, loading: false });
    const card = renderCard(machine());

    expect(card.getByText(NO_DATA)).toBeInTheDocument();
    expect(card.queryByTestId('display-panes')).toBeNull();
  });

  it.each(['macos', 'linux'] as const)('says so at once on %s, whose agent reports no layout', (osFamily) => {
    mockDisplayState.mockReturnValue({ profile: null, loading: true });
    const card = renderCard(machine({ osFamily }));

    expect(card.getByText(NO_DATA)).toBeInTheDocument();
    expect(card.queryByTestId('display-panes')).toBeNull();
  });
});
