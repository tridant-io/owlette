/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * every machine card and row mounts RestartScheduleDialog, so it opens machine
 * listeners only while it is open, and only on the person's machine scope.
 * presets are site-wide (PRESET_MANAGE), so a scoped admin applies them but
 * never writes one.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RestartScheduleDialog from '@/components/RestartScheduleDialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { RestartPreset } from '@/hooks/useRestartPresets';
import type { RestartScheduleEntry } from '@/hooks/useFirestore';

const SITE = 'site-A';
const SCOPE = ['IN'];

const mockUpdateRestartSchedule = jest.fn(async (..._args: unknown[]) => {});
const mockUseMachines = jest.fn((..._args: unknown[]) => ({ machines: [], updateRestartSchedule: mockUpdateRestartSchedule }));
const mockMachineScope = jest.fn((_siteId: string) => SCOPE);
const mockIsSiteAdmin = jest.fn((_siteId: string) => true);

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: (...args: unknown[]) => mockUseMachines(...args),
}));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    userPreferences: { timeFormat: '12h' },
    machineScope: (siteId: string) => mockMachineScope(siteId),
    isSiteAdmin: (siteId: string) => mockIsSiteAdmin(siteId),
  }),
}));

let mockPresets: RestartPreset[] = [];
const mockUpdatePreset = jest.fn(async (..._args: unknown[]) => {});
jest.mock('@/hooks/useRestartPresets', () => ({
  useRestartPresets: () => ({
    presets: mockPresets,
    createPreset: jest.fn(),
    updatePreset: mockUpdatePreset,
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

describe('RestartScheduleDialog — presets', () => {
  const ENTRIES: RestartScheduleEntry[] = [{ id: 'e1', days: ['mon'], time: '03:00' }];
  const originalMatchMedia = window.matchMedia;

  // DayPillSelector asks for a fine pointer, which jsdom does not answer
  beforeAll(() => {
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as unknown as typeof window.matchMedia;
  });

  afterAll(() => {
    window.matchMedia = originalMatchMedia;
  });

  beforeEach(() => {
    mockUpdatePreset.mockClear();
    mockUpdateRestartSchedule.mockClear();
    // the schedule matches it, so the dialog opens with this custom preset selected
    mockPresets = [{
      id: 'nightly',
      name: 'nightly',
      enabled: true,
      entries: ENTRIES,
      isBuiltIn: false,
      order: 100,
      createdBy: 'someone',
      createdAt: null,
    }];
  });

  function renderWithSchedule() {
    return render(
      <TooltipProvider>
        <RestartScheduleDialog
          siteId={SITE}
          machineId="IN"
          machineName="IN"
          open
          onOpenChange={jest.fn()}
          currentSchedule={{ enabled: true, entries: ENTRIES }}
        />
      </TooltipProvider>,
    );
  }

  it('a whole-site admin can save, rename and delete presets', () => {
    mockIsSiteAdmin.mockReturnValue(true);
    renderWithSchedule();

    expect(screen.getByRole('button', { name: 'nightly' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'new preset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rename' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete' })).toBeInTheDocument();
  });

  it('a scoped admin applies presets but is offered none to save, rename or delete', () => {
    mockIsSiteAdmin.mockReturnValue(false);
    renderWithSchedule();

    expect(mockIsSiteAdmin).toHaveBeenCalledWith(SITE);
    expect(screen.getByRole('button', { name: 'nightly' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'new preset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'delete' })).not.toBeInTheDocument();
  });

  it("a scoped admin's save writes the schedule and leaves the preset it drifted from alone", async () => {
    mockIsSiteAdmin.mockReturnValue(false);
    renderWithSchedule();

    fireEvent.click(screen.getByRole('button', { name: 'add restart' }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(mockUpdateRestartSchedule).toHaveBeenCalledTimes(1));
    expect(mockUpdatePreset).not.toHaveBeenCalled();
  });

  it("a whole-site admin's save still carries the drift back to the selected preset", async () => {
    mockIsSiteAdmin.mockReturnValue(true);
    renderWithSchedule();

    fireEvent.click(screen.getByRole('button', { name: 'add restart' }));
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(mockUpdateRestartSchedule).toHaveBeenCalledTimes(1));
    expect(mockUpdatePreset).toHaveBeenCalledWith('nightly', expect.objectContaining({ enabled: true }));
  });
});
