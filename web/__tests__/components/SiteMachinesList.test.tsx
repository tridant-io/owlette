/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The machines section of a site's settings restarts through the same
 * confirm as the dashboard, so inside a guarded machine's active hours it
 * asks first and sends the choice with the first request.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SiteMachinesList } from '@/components/SiteMachinesList';
import { toast } from '@/lib/toast';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

const mockRemoveMachineFromSite = jest.fn();

jest.mock('@/hooks/useMachineOperations', () => ({
  useMachineOperations: () => ({ removeMachineFromSite: mockRemoveMachineFromSite, removing: false }),
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

async function openConfirm(button: string) {
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <SiteMachinesList siteId="site-A" />
    </TooltipProvider>,
  );
  await user.click(await screen.findByRole('button', { name: button }));
  return user;
}

beforeEach(() => {
  fetchMock.mockReset();
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
    render(
      <TooltipProvider>
        <SiteMachinesList siteId="site-A" />
      </TooltipProvider>,
    );

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
