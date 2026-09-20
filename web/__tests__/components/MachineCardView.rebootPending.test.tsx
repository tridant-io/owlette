/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The card's "restart pending" banner.
 *
 * Two live bugs this pins down. (1) The banner rendered on
 * `rebootPending.active` alone, so a flag the agent wrote days ago kept claiming
 * a restart was pending on a machine that had been offline ever since — nothing
 * could act on it. (2) Dismiss was gated on `rebootPending.processName`, which
 * is `string | null`; a null one skipped the handler entirely and the empty
 * `catch {}` swallowed every failure, so clicking it did nothing, silently.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { toast } from '@/lib/toast';
import type { Machine } from '@/hooks/useFirestore';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/contexts/DemoContext', () => ({ useDemoContext: () => null }));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: {
      temperatureUnit: 'C',
      mutedMachines: [],
      timeDisplayMode: 'machine',
      timezone: 'UTC',
    },
    isSiteAdmin: () => true,
  }),
}));

jest.mock('@/hooks/useSparklineData', () => ({
  useAllSparklineData: () => ({ cpu: [], memory: [], disk: [], gpu: [], loading: false }),
}));

jest.mock('@/hooks/useDisplayState', () => ({
  useDisplayState: () => ({ profile: null }),
}));

jest.mock('@/hooks/useDevicePrefs', () => ({
  useDevicePrefs: () => ({ prefs: { cardView: {} }, setCardPref: jest.fn() }),
}));

// Recharts/canvas children the banner assertions never touch.
jest.mock('@/components/charts', () => ({ SparklineChart: () => null }));
jest.mock('@/components/charts/DisplayCanvas', () => ({ DisplayCanvas: () => null }));
jest.mock('@/components/MachineContextMenu', () => ({ MachineContextMenu: () => null }));

const NOW_SEC = Math.floor(Date.now() / 1000);
const TWO_DAYS_SEC = 2 * 24 * 60 * 60;

/** The operator's screenshot: pending flag set, machine gone for two days. */
function machine(overrides: Partial<Machine> = {}): Machine {
  return {
    machineId: 'kiosk-01',
    lastHeartbeat: NOW_SEC - TWO_DAYS_SEC,
    online: false,
    rebootPending: {
      active: true,
      processName: 'lab-sleep',
      reason: 'lab-sleep crashed 9 times',
      timestamp: NOW_SEC - TWO_DAYS_SEC,
    },
    ...overrides,
  } as Machine;
}

function renderCard(m: Machine, handlers: { onDismiss?: jest.Mock; onRestart?: jest.Mock } = {}) {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <MachineCardView
        machines={[m]}
        statsExpanded={false}
        processesExpanded={false}
        onToggleStats={jest.fn()}
        onToggleProcesses={jest.fn()}
        currentSiteId="site-A"
        onEditProcess={jest.fn()}
        onCreateProcess={jest.fn()}
        onKillProcess={jest.fn()}
        onRestartProcess={jest.fn()}
        onSetLaunchMode={jest.fn()}
        onRemoveMachine={jest.fn()}
        onRestart={handlers.onRestart}
        onDismissRestartPending={handlers.onDismiss}
      />
    </TooltipProvider>,
  );
  return user;
}

describe('MachineCardView — restart pending banner', () => {
  it('an offline machine keeps the banner but drops approve and says why', () => {
    renderCard(machine(), { onDismiss: jest.fn(), onRestart: jest.fn() });

    const banner = screen.getByTestId('reboot-pending-banner');
    expect(banner).toHaveTextContent('restart pending: lab-sleep crashed 9 times');
    expect(banner).toHaveTextContent('machine offline, cannot restart');
    // Muted, not the amber alarm — nothing is pending that anything can act on.
    expect(banner.className).not.toContain('amber');
    expect(screen.queryByTestId('reboot-pending-approve')).not.toBeInTheDocument();
    expect(screen.getByTestId('reboot-pending-dismiss')).toBeInTheDocument();
  });

  it('an online machine keeps the amber banner and both actions', () => {
    renderCard(machine({ online: true, lastHeartbeat: NOW_SEC }), {
      onDismiss: jest.fn(),
      onRestart: jest.fn(),
    });

    const banner = screen.getByTestId('reboot-pending-banner');
    expect(banner.className).toContain('amber');
    expect(banner).not.toHaveTextContent('machine offline');
    expect(screen.getByTestId('reboot-pending-approve')).toBeInTheDocument();
    expect(screen.getByTestId('reboot-pending-dismiss')).toBeInTheDocument();
  });

  it('dismisses with a null processName, on a machine that is offline', async () => {
    const onDismiss = jest.fn().mockResolvedValue(undefined);
    const user = renderCard(
      machine({
        rebootPending: { active: true, processName: null, reason: null, timestamp: null },
      }),
      { onDismiss },
    );

    await user.click(screen.getByTestId('reboot-pending-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('restart pending dismissed');
  });

  it('surfaces a failed dismiss instead of swallowing it', async () => {
    const onDismiss = jest.fn().mockRejectedValue(new Error('machine not found'));
    const user = renderCard(machine(), { onDismiss });

    await user.click(screen.getByTestId('reboot-pending-dismiss'));

    expect(toast.error).toHaveBeenCalledWith(
      'could not dismiss the pending restart',
      { description: 'machine not found' },
    );
  });

  it('renders no banner when the flag is not active', () => {
    renderCard(
      machine({
        rebootPending: { active: false, processName: null, reason: null, timestamp: null },
      }),
    );

    expect(screen.queryByTestId('reboot-pending-banner')).not.toBeInTheDocument();
  });
});
