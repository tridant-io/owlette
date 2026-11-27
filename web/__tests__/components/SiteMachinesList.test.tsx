/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The machines section of a site's settings restarts through the same
 * confirm as the dashboard, so inside a guarded machine's active hours it
 * asks first and sends the choice with the first request.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buttonVariants } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SiteMachinesList } from '@/components/SiteMachinesList';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const mockRemoveMachineFromSite = jest.fn();

jest.mock('@/hooks/useMachineOperations', () => ({
  useMachineOperations: () => ({ removeMachineFromSite: mockRemoveMachineFromSite, removing: false }),
}));

const mockCancelMove = jest.fn();
jest.mock('@/hooks/useMachineMove', () => ({
  useMachineMove: () => ({ requestMove: jest.fn(), cancelMove: mockCancelMove, busy: false }),
}));

interface MoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine: { id: string; name: string };
  sourceSite: { id: string; name: string };
  targetSites: { id: string; name: string }[];
  onMoved: () => void;
}
// the dialog has its own test; this stands in for it, and a request ends as the real one's does
let mockMoveDialog: MoveDialogProps | undefined;
jest.mock('@/components/admin/sites/MoveMachineDialog', () => ({
  MoveMachineDialog: (props: MoveDialogProps) => {
    mockMoveDialog = props;
    return props.open ? <div role="dialog" aria-label={`move ${props.machine.name}`} /> : null;
  },
}));

const hour = new Date().getUTCHours();

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

function listResponds(machines: Array<Record<string, unknown>>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ ok: true, data: { commandId: 'cmd_1', status: 'pending' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ machines }) };
  });
}

const base = {
  online: true,
  lastHeartbeat: new Date().toISOString(),
  agentVersion: '4.1.21',
  osFamily: 'windows',
  machineTimezone: 'UTC',
};

function postedParams(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  if (!call) throw new Error('no restart was posted');
  expect(call[0]).toBe('/api/sites/site-A/machines/kiosk-1/commands');
  const body = JSON.parse((call[1] as RequestInit).body as string);
  expect(body.type).toBe('reboot_machine');
  return body.params;
}

const BRAVO = { id: 'site-B', name: 'bravo' };

function renderList(targetSites: { id: string; name: string }[] = [BRAVO]) {
  render(
    <TooltipProvider delayDuration={0}>
      <SiteMachinesList siteId="site-A" siteName="alpha" targetSites={targetSites} />
    </TooltipProvider>,
  );
}

async function openConfirm(button: string) {
  const user = userEvent.setup();
  renderList();
  await user.click(await screen.findByRole('button', { name: button }));
  return user;
}

const listLoads = () => fetchMock.mock.calls.filter(([url]) => url === '/api/sites/site-A/machines').length;

beforeEach(() => {
  fetchMock.mockReset();
  mockMoveDialog = undefined;
});

describe('SiteMachinesList — restart', () => {
  it('asks inside a guarded machine\'s active hours and can wait for them to end', async () => {
    listResponds([{
      ...base,
      id: 'kiosk-1',
      name: 'kiosk-1',
      capabilities: { activeHoursGuard: 1 },
      activeHours: { start: hour, end: (hour + 2) % 24, source: 'policy' },
    }]);
    const user = await openConfirm('restart kiosk-1');

    expect(await screen.findByTestId('active-hours-notice')).toHaveTextContent('inside active hours');
    await user.click(screen.getByRole('button', { name: 'restart when active hours end' }));

    expect(postedParams()).toEqual({ delay_seconds: 60, when: 'after_active_hours' });
  });

  it('sends the reason with a restart now', async () => {
    listResponds([{
      ...base,
      id: 'kiosk-1',
      name: 'kiosk-1',
      capabilities: { activeHoursGuard: 1 },
      activeHours: { start: hour, end: (hour + 2) % 24, source: 'policy' },
    }]);
    const user = await openConfirm('restart kiosk-1');

    await user.type(await screen.findByLabelText('reason'), 'support call, venue closed');
    await user.click(screen.getByRole('button', { name: 'restart now' }));

    expect(postedParams()).toEqual({
      delay_seconds: 60,
      active_hours_override: { reason: 'support call, venue closed' },
    });
  });

  it('keeps the plain confirm for an agent that guards nothing', async () => {
    listResponds([{ ...base, id: 'kiosk-1', name: 'kiosk-1', capabilities: null, activeHours: null }]);
    const user = await openConfirm('restart kiosk-1');

    expect(await screen.findByRole('dialog', { name: 'restart kiosk-1?' })).toHaveTextContent('60 seconds');
    expect(screen.queryByTestId('active-hours-notice')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'restart' }));

    expect(postedParams()).toEqual({ delay_seconds: 60 });
  });

  it('keeps the plain confirm for a machine rolled back below 4.1.21 that still carries the capability', async () => {
    listResponds([{
      ...base,
      id: 'kiosk-1',
      name: 'kiosk-1',
      agentVersion: '3.3.7',
      capabilities: { activeHoursGuard: 1 },
      activeHours: { start: hour, end: (hour + 2) % 24, source: 'policy' },
    }]);
    const user = await openConfirm('restart kiosk-1');

    expect(await screen.findByRole('dialog', { name: 'restart kiosk-1?' })).toHaveTextContent('60 seconds');
    expect(screen.queryByTestId('active-hours-notice')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'restart when active hours end' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'restart' }));

    expect(postedParams()).toEqual({ delay_seconds: 60 });
  });
});

describe('SiteMachinesList — loading', () => {
  it('lists the site machines, and says a failed load with a retry that loads again', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const user = userEvent.setup();
    renderList();

    expect(await screen.findByText('failed to load machines (503)')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/sites/site-A/machines');

    listResponds([{ ...base, id: 'kiosk-1', name: 'lobby screen' }]);
    await user.click(screen.getByRole('button', { name: 'retry' }));

    expect(await screen.findByText('lobby screen')).toBeInTheDocument();
    expect(screen.queryByText('failed to load machines (503)')).not.toBeInTheDocument();
  });
});

describe('SiteMachinesList — remove', () => {
  const lobby = { ...base, id: 'kiosk-1', name: 'lobby screen' };

  it('says which machine left the site', async () => {
    listResponds([lobby]);
    mockRemoveMachineFromSite.mockResolvedValueOnce(undefined);
    const user = await openConfirm('remove lobby screen');

    await user.click(await screen.findByRole('button', { name: 'remove machine' }));

    expect(mockRemoveMachineFromSite).toHaveBeenCalledWith('kiosk-1');
    expect(toast.success).toHaveBeenCalledWith('machine removed', {
      description: 'lobby screen is no longer on this site.',
    });
  });

  it('says it could not remove the machine, with the reason', async () => {
    listResponds([lobby]);
    mockRemoveMachineFromSite.mockRejectedValueOnce(new Error('capability not granted'));
    const user = await openConfirm('remove lobby screen');

    await user.click(await screen.findByRole('button', { name: 'remove machine' }));

    expect(toast.error).toHaveBeenCalledWith('could not remove the machine', {
      description: 'capability not granted',
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('SiteMachinesList — move', () => {
  const lobby = { ...base, id: 'kiosk-1', name: 'lobby screen', pendingMove: null };
  const moving = (status: 'pending' | 'switching') => ({
    ...lobby,
    pendingMove: { targetSiteId: 'site-B', targetSiteName: 'bravo', status, expiresAt: Date.now() + 86_400_000 },
  });

  it('offers no move when the caller administers no other site', async () => {
    listResponds([lobby]);
    renderList([]);

    expect(await screen.findByRole('button', { name: 'remove lobby screen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'move lobby screen' })).toBeNull();
  });

  it('still lets an admin of only this site cancel a pending move', async () => {
    listResponds([moving('pending')]);
    renderList([]);

    expect(await screen.findByRole('button', { name: 'cancel move of lobby screen' })).toBeEnabled();
  });

  it('sits between restart and remove, and opens the move dialog with the sites to pick from', async () => {
    listResponds([lobby]);
    const user = userEvent.setup();
    renderList();

    const move = await screen.findByRole('button', { name: 'move lobby screen' });
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['restart lobby screen', 'move lobby screen', 'remove lobby screen']);
    // the row's look is the button variants', with nothing added per button
    const row = cn(buttonVariants({ variant: 'row', size: 'icon-xs' }));
    expect(move.className).toBe(row);
    expect(screen.getByRole('button', { name: 'restart lobby screen' }).className).toBe(row);
    expect(screen.getByRole('button', { name: 'remove lobby screen' }).className).toBe(
      cn(buttonVariants({ variant: 'row-destructive', size: 'icon-xs' })),
    );
    expect(screen.queryByRole('dialog', { name: 'move lobby screen' })).toBeNull();

    await user.hover(move);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('move to another site');

    await user.click(move);

    expect(screen.getByRole('dialog', { name: 'move lobby screen' })).toBeInTheDocument();
    expect(mockMoveDialog?.machine).toMatchObject({ id: 'kiosk-1', name: 'lobby screen' });
    expect(mockMoveDialog?.sourceSite).toEqual({ id: 'site-A', name: 'alpha' });
    expect(mockMoveDialog?.targetSites).toEqual([BRAVO]);
    expect(mockCancelMove).not.toHaveBeenCalled();
  });

  it('closes the dialog and loads the list again once the move is requested', async () => {
    listResponds([lobby]);
    const user = userEvent.setup();
    renderList();
    await user.click(await screen.findByRole('button', { name: 'move lobby screen' }));
    expect(listLoads()).toBe(1);

    listResponds([moving('pending')]);
    await act(async () => {
      mockMoveDialog!.onMoved();
      mockMoveDialog!.onOpenChange(false);
    });

    expect(screen.queryByRole('dialog', { name: 'move lobby screen' })).toBeNull();
    expect(await screen.findByText('moving to bravo')).toBeInTheDocument();
    expect(listLoads()).toBe(2);
  });

  it('tags a pending move beside the name from sm up, and on a phone one word after the status', async () => {
    listResponds([moving('pending')]);
    renderList();

    const wide = await screen.findByText('moving to bravo');
    expect(wide).toHaveClass('hidden', 'sm:inline', 'truncate', 'text-xs', 'text-muted-foreground');
    expect(wide.parentElement).toHaveTextContent('lobby screen');
    const phone = screen.getByTitle('moving to bravo');
    expect(phone).toHaveTextContent(/^moving$/);
    // the phone line reads "online · moving", so the name keeps the first line
    expect(phone.parentElement).toHaveClass('sm:hidden', 'text-muted-foreground');
    expect(phone.parentElement?.parentElement).toHaveTextContent(/^online · moving$/);
  });

  it("says an offline machine's move waits until it is online", async () => {
    listResponds([{ ...moving('pending'), online: false }]);
    renderList();

    expect(await screen.findByText('waiting to move to bravo')).toBeInTheDocument();
    expect(screen.getByTitle('waiting to move to bravo')).toHaveTextContent(/^waiting$/);
    expect(screen.queryByText('moving to bravo')).toBeNull();
  });

  it('asks for the list again while a move is open, and stops once the machine has left', async () => {
    jest.useFakeTimers();
    try {
      listResponds([moving('pending')]);
      renderList();
      expect(await screen.findByText('moving to bravo')).toBeInTheDocument();

      // the machine arrived on bravo, and this site no longer lists it
      listResponds([]);
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });
      expect(await screen.findByText('no machines on this site')).toBeInTheDocument();

      const loads = listLoads();
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(listLoads()).toBe(loads);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the list and an open dialog when a poll fails', async () => {
    jest.useFakeTimers();
    try {
      listResponds([moving('pending')]);
      renderList();
      fireEvent.click(await screen.findByRole('button', { name: 'remove lobby screen' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
      await act(async () => {
        jest.advanceTimersByTime(5_000);
      });

      expect(listLoads()).toBe(2);
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('moving to bravo')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks for nothing more while no move is open', async () => {
    jest.useFakeTimers();
    try {
      listResponds([lobby]);
      renderList();
      expect(await screen.findByRole('button', { name: 'move lobby screen' })).toBeInTheDocument();

      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(listLoads()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels a pending move from the same button, then loads the list again', async () => {
    listResponds([moving('pending')]);
    mockCancelMove.mockResolvedValueOnce({ moveId: 'site-A:kiosk-1', status: 'cancelled', targetSiteId: 'site-B' });
    const user = userEvent.setup();
    renderList();

    const cancel = await screen.findByRole('button', { name: 'cancel move of lobby screen' });
    expect(screen.queryByRole('button', { name: 'move lobby screen' })).toBeNull();
    await user.hover(cancel);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('cancel the move');
    listResponds([lobby]);
    await user.click(cancel);

    expect(mockCancelMove).toHaveBeenCalledWith('kiosk-1');
    expect(toast.success).toHaveBeenCalledWith('move cancelled');
    expect(mockMoveDialog).toBeUndefined();
    expect(await screen.findByRole('button', { name: 'move lobby screen' })).toBeInTheDocument();
    expect(screen.queryByText('moving to bravo')).toBeNull();
    expect(listLoads()).toBe(2);
  });

  it('says it could not cancel the move, with the reason, and loads the list again', async () => {
    listResponds([moving('pending')]);
    mockCancelMove.mockRejectedValueOnce(new Error('lobby screen is switching sites now.'));
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'cancel move of lobby screen' }));

    expect(toast.error).toHaveBeenCalledWith('could not cancel the move', {
      description: 'lobby screen is switching sites now.',
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(listLoads()).toBe(2);
  });

  it('can not cancel while the machine is switching sites', async () => {
    listResponds([moving('switching')]);
    const user = userEvent.setup();
    renderList();

    const button = await screen.findByRole('button', { name: 'cancel move of lobby screen' });
    expect(button).toBeDisabled();
    expect(screen.getByText('moving to bravo')).toBeInTheDocument();

    await user.click(button);
    expect(mockCancelMove).not.toHaveBeenCalled();
  });
});
