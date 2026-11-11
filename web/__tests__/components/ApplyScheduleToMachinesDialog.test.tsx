/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the bulk-apply list reads machines only while open, and only the ones in the
 * person's machine scope, so a scoped admin is offered only machines they may
 * configure.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ApplyScheduleToMachinesDialog from '@/components/ApplyScheduleToMachinesDialog';

const SITE = 'site-A';
const SCOPE = ['IN', 'IN2'];

const mockUseMachines = jest.fn((..._args: unknown[]) => ({
  machines: [
    { machineId: 'IN', online: true },
    { machineId: 'IN2', online: false },
  ],
  updateRestartSchedule: jest.fn(),
}));
const mockMachineScope = jest.fn((_siteId: string) => SCOPE);

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: (...args: unknown[]) => mockUseMachines(...args),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ machineScope: (siteId: string) => mockMachineScope(siteId) }),
}));

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

function renderDialog(open: boolean) {
  return render(
    <ApplyScheduleToMachinesDialog
      open={open}
      onOpenChange={jest.fn()}
      siteId={SITE}
      currentMachineId="IN"
      schedule={{ enabled: true, entries: [] }}
    />,
  );
}

describe('ApplyScheduleToMachinesDialog — machines in scope', () => {
  beforeEach(() => {
    mockUseMachines.mockClear();
    mockMachineScope.mockClear();
  });

  it('reads no machines while closed', () => {
    renderDialog(false);

    expect(mockUseMachines).not.toHaveBeenCalled();
  });

  it('reads the site on the person\'s machine scope', () => {
    renderDialog(true);

    expect(mockMachineScope).toHaveBeenCalledWith(SITE);
    expect(mockUseMachines).toHaveBeenCalledWith(SITE, SCOPE);
  });

  it('offers every machine but the current one, and select all counts one', async () => {
    const user = userEvent.setup();
    renderDialog(true);

    const offered = screen.getAllByRole('checkbox').filter((box) => !box.hasAttribute('disabled'));
    expect(offered).toHaveLength(1);
    expect(offered[0]).toHaveAccessibleName(/^IN2/);
    expect(screen.getByRole('checkbox', { name: /^IN \(current\)/ })).toBeDisabled();
    expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'select all' }));

    expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'apply to 1' })).toBeEnabled();
  });
});
