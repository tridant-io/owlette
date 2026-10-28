/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The list row hands its machine menu the active hours the agent enforces, and
 * none for a machine rolled back below 4.1.21: that agent never clears the
 * capability its newer self wrote, and restarts at once.
 */

import React from 'react';
import { render } from '@testing-library/react';
import { MachineRow } from '@/app/dashboard/components/MachineListView';
import type { Machine } from '@/hooks/useFirestore';

const mockMenuProps = jest.fn();

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
  }),
}));

jest.mock('@/hooks/useMinuteTick', () => ({ useMinuteTick: () => undefined }));
jest.mock('@/hooks/useDevicePrefs', () => ({
  useDevicePrefs: () => ({ prefs: { cardView: {}, listView: {} }, setCardPref: jest.fn() }),
}));
jest.mock('@/hooks/useSparklineData', () => ({
  useAllSparklineData: () => ({ cpu: [], memory: [], disk: [], gpu: [], loading: false }),
}));
jest.mock('@/hooks/useDisplayState', () => ({ useDisplayState: () => ({ profile: null }) }));
jest.mock('@/components/charts', () => ({ SparklineChart: () => null }));
jest.mock('@/components/charts/DisplayCanvas', () => ({ DisplayCanvas: () => null }));
jest.mock('@/components/MachineStatusPill', () => ({ MachineStatusPill: () => null }));
jest.mock('@/components/MachineContextMenu', () => ({
  MachineContextMenu: (props: Record<string, unknown>) => {
    mockMenuProps(props);
    return null;
  },
}));

const hour = new Date().getUTCHours();
const WINDOW = { start: hour, end: (hour + 2) % 24, source: 'policy' as const };

function guardedMachine(agentVersion: string): Machine {
  return {
    machineId: 'kiosk-01',
    lastHeartbeat: Math.floor(Date.now() / 1000),
    online: true,
    agent_version: agentVersion,
    osFamily: 'windows',
    machineTimezone: 'UTC',
    capabilities: { activeHoursGuard: 1 },
    activeHours: WINDOW,
    processes: [],
  };
}

function menuGuardFor(machine: Machine): unknown {
  mockMenuProps.mockClear();
  render(
    <table>
      <tbody>
        <MachineRow
          machine={machine}
          isExpanded={false}
          currentSiteId="site-A"
          siteTimezone="UTC"
          siteTimeFormat="24h"
          userPreferences={{ temperatureUnit: 'C' }}
          isSiteAdmin
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
  return mockMenuProps.mock.calls.at(-1)?.[0]?.activeHoursGuard;
}

describe('MachineRow — the active hours its menu offers', () => {
  it('passes the window for a guarded 4.1.21 agent', () => {
    expect(menuGuardFor(guardedMachine('4.1.21'))).toEqual({ window: WINDOW, timezone: 'UTC' });
  });

  it('passes none for a machine rolled back to 3.3.7 that still carries the capability', () => {
    expect(menuGuardFor(guardedMachine('3.3.7'))).toBeNull();
  });
});
