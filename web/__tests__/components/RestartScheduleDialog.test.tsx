/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * every machine card and row mounts RestartScheduleDialog, so it opens machine
 * listeners only while it is open, and only on the person's machine scope.
 */

import React from 'react';
import { render } from '@testing-library/react';
import RestartScheduleDialog from '@/components/RestartScheduleDialog';

const SITE = 'site-A';
const SCOPE = ['IN'];

const mockUseMachines = jest.fn((..._args: unknown[]) => ({ machines: [], updateRestartSchedule: jest.fn() }));
const mockMachineScope = jest.fn((_siteId: string) => SCOPE);

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: (...args: unknown[]) => mockUseMachines(...args),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: { timeFormat: '12h' },
    machineScope: (siteId: string) => mockMachineScope(siteId),
  }),
}));

const mockNoPresets: never[] = [];
jest.mock('@/hooks/useRestartPresets', () => ({
  useRestartPresets: () => ({
    presets: mockNoPresets,
    createPreset: jest.fn(),
    updatePreset: jest.fn(),
    deletePreset: jest.fn(),
  }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderDialog(open: boolean) {
  return render(
    <RestartScheduleDialog
      siteId={SITE}
      machineId="IN"
      machineName="IN"
      open={open}
      onOpenChange={jest.fn()}
    />,
  );
}

describe('RestartScheduleDialog — machine reads', () => {
  beforeEach(() => {
    mockUseMachines.mockClear();
    mockMachineScope.mockClear();
  });

  it('reads no machines while closed', () => {
    renderDialog(false);

    expect(mockUseMachines).toHaveBeenCalled();
    for (const [siteId] of mockUseMachines.mock.calls) expect(siteId).toBe('');
  });

  it('reads the site, on the person\'s machine scope, once open', () => {
    const { rerender } = renderDialog(false);
    rerender(
      <RestartScheduleDialog
        siteId={SITE}
        machineId="IN"
        machineName="IN"
        open
        onOpenChange={jest.fn()}
      />,
    );

    expect(mockUseMachines).toHaveBeenLastCalledWith(SITE, SCOPE);
    expect(mockMachineScope).toHaveBeenCalledWith(SITE);
  });
});
