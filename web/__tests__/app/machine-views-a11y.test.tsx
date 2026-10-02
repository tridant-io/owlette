/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * Machine cards and list rows — keyboard reach, exposed state, and memoization.
 *
 * Rows expanded and metric tiles opened the detail panel only from a mouse
 * click on a <tr>/<td>/<div>, the launch-mode toggle said which mode was on by
 * colour alone, and every heartbeat re-rendered every card and row.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { MachineRow } from '@/app/dashboard/components/MachineListView';
import type { Machine } from '@/hooks/useFirestore';

const useAllSparklineData = jest.fn((siteId: string, machineId: string) => {
  void siteId;
  void machineId;
  return { cpu: [], memory: [], disk: [], gpu: [], loading: false };
});

jest.mock('@/hooks/useSparklineData', () => ({
  useAllSparklineData: (siteId: string, machineId: string) => useAllSparklineData(siteId, machineId),
}));

jest.mock('@/contexts/AuthContext', () => {
  // one object, as the real provider memoizes its value
  const auth = {
    userPreferences: { temperatureUnit: 'C', timeDisplayMode: 'machine', timezone: 'UTC', mutedMachines: [] },
    isSiteAdmin: () => true,
  };
  return { useAuth: () => auth };
});

jest.mock('@/hooks/useMinuteTick', () => ({ useMinuteTick: () => undefined }));

jest.mock('@/hooks/useDevicePrefs', () => {
  const prefs = { prefs: { cardView: {}, listView: {} }, setCardPref: () => undefined };
  return { useDevicePrefs: () => prefs };
});

jest.mock('@/hooks/useDisplayState', () => ({ useDisplayState: () => ({ profile: null }) }));
jest.mock('@/components/charts', () => ({ SparklineChart: () => null }));
jest.mock('@/components/charts/DisplayCanvas', () => ({ DisplayCanvas: () => null }));
jest.mock('@/components/MachineContextMenu', () => ({ MachineContextMenu: () => null }));
jest.mock('@/components/MachineStatusPill', () => ({ MachineStatusPill: () => null }));

const SITE_ID = 'site-A';

function machine(machineId: string, overrides: Partial<Machine> = {}): Machine {
  return {
    machineId,
    lastHeartbeat: Math.floor(Date.now() / 1000),
    online: true,
    metrics: { schemaVersion: 2, cpus: { CPU0: { percent: 30 } }, memory: { percent: 40, usedGb: 8 } },
    devices: {
      cpus: [{ id: 'CPU0', percent: 30, isMissing: false, isOrphan: false }],
      disks: [],
      gpus: [],
      nics: [],
    },
    processes: [{
      id: 'proc-1', name: 'TouchDesigner.exe', status: 'RUNNING', pid: 1, autolaunch: true, launch_mode: 'always',
      exe_path: 'C:/td.exe', file_path: '', cwd: '', priority: 'Normal', visibility: 'Normal', time_delay: '0',
      time_to_init: '10', relaunch_attempts: '3', responsive: true, last_updated: 0, index: 0,
    }],
    ...overrides,
  };
}

// stable across renders, as the dashboard's are
const cardHandlers = {
  onToggleStats: jest.fn(),
  onToggleProcesses: jest.fn(),
  onEditProcess: jest.fn(),
  onCreateProcess: jest.fn(),
  onKillProcess: jest.fn(),
  onRestartProcess: jest.fn(),
  onSetLaunchMode: jest.fn(),
  onRemoveMachine: jest.fn(),
  onMetricClick: jest.fn(),
};

function cardView(machines: Machine[]) {
  return (
    <TooltipProvider>
      <MachineCardView
        machines={machines}
        statsExpanded
        processesExpanded
        currentSiteId={SITE_ID}
        {...cardHandlers}
      />
    </TooltipProvider>
  );
}

const rowHandlers = {
  onToggleExpanded: jest.fn(),
  onEditProcess: jest.fn(),
  onCreateProcess: jest.fn(),
  onKillProcess: jest.fn(),
  onRestartProcess: jest.fn(),
  onSetLaunchMode: jest.fn(),
  onRemoveMachine: jest.fn(),
  onMetricClick: jest.fn(),
};
const temperaturePrefs = { temperatureUnit: 'C' as const };

function listRow(m: Machine) {
  return (
    <TooltipProvider>
      <table>
        <tbody>
          <MachineRow
            machine={m}
            isExpanded={false}
            currentSiteId={SITE_ID}
            siteTimezone="UTC"
            siteTimeFormat="24h"
            userPreferences={temperaturePrefs}
            isSiteAdmin
            {...rowHandlers}
          />
        </tbody>
      </table>
    </TooltipProvider>
  );
}

const rendersOf = (machineId: string) =>
  useAllSparklineData.mock.calls.filter(([, id]) => id === machineId).length;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('card view', () => {
  it('re-renders only the card whose machine changed', () => {
    const steady = machine('kiosk-a');
    const { rerender } = render(cardView([steady, machine('kiosk-b')]));
    const steadyRenders = rendersOf('kiosk-a');
    const changedRenders = rendersOf('kiosk-b');

    rerender(cardView([steady, machine('kiosk-b', { lastHeartbeat: 1 })]));

    expect(rendersOf('kiosk-a')).toBe(steadyRenders);
    expect(rendersOf('kiosk-b')).toBeGreaterThan(changedRenders);
  });

  it('opens a metric from a named, focusable tile button', async () => {
    const user = userEvent.setup();
    render(cardView([machine('kiosk-a')]));

    const tile = screen.getByRole('button', { name: 'open cpu history for kiosk-a' });
    tile.focus();
    await user.keyboard('{Enter}');

    expect(cardHandlers.onMetricClick).toHaveBeenCalledTimes(1);
    expect(cardHandlers.onMetricClick).toHaveBeenCalledWith('kiosk-a', 'cpu');
  });

  it('names the section collapse handles', () => {
    render(cardView([machine('kiosk-a')]));
    expect(screen.getByRole('button', { name: 'collapse metrics' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'collapse processes' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('says which launch mode is on without relying on colour', () => {
    render(cardView([machine('kiosk-a')]));

    const group = screen.getByRole('group', { name: 'launch mode for TouchDesigner.exe' });
    expect(within(group).getByRole('button', { name: 'always on' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'off' })).toHaveAttribute('aria-pressed', 'false');
    // the compact control that replaces the group below md
    expect(screen.getByRole('button', { name: 'launch mode for TouchDesigner.exe: always on' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'configure schedule for TouchDesigner.exe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edit TouchDesigner.exe' })).toBeInTheDocument();
  });
});

describe('list row', () => {
  it('does not re-render when its props have not changed', () => {
    const m = machine('kiosk-a');
    const { rerender } = render(listRow(m));
    const renders = rendersOf('kiosk-a');

    rerender(listRow(m));

    expect(rendersOf('kiosk-a')).toBe(renders);
  });

  it('expands from a disclosure button that reports its state', async () => {
    const user = userEvent.setup();
    render(listRow(machine('kiosk-a')));

    const disclosure = screen.getByRole('button', { name: 'processes for kiosk-a' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    disclosure.focus();
    await user.keyboard('{Enter}');

    expect(rowHandlers.onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it('opens a metric from a named button in its cell', async () => {
    const user = userEvent.setup();
    render(listRow(machine('kiosk-a')));

    screen.getByRole('button', { name: 'open cpu history for kiosk-a' }).focus();
    await user.keyboard('{Enter}');

    expect(rowHandlers.onMetricClick).toHaveBeenCalledWith('cpu');
    expect(rowHandlers.onToggleExpanded).not.toHaveBeenCalled();
  });
});
