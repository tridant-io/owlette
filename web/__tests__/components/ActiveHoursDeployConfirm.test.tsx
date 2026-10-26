/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The confirm a deployment or a retry asks for when some of its machines are
 * inside active hours. A guarded windows agent refuses an install there,
 * before it closes any process, unless a person overrode it, so the dashboard
 * has to name those machines and take a reason up front. Agents that guard
 * nothing, and machines outside their window, never reach the confirm.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ActiveHoursDeployConfirm,
  machinesInActiveHours,
  type DeployConfirmAction,
  type MachineInActiveHours,
} from '@/components/ActiveHoursDeployConfirm';

// seeded on UTC, so these hold whatever hour the suite runs at
const hour = new Date().getUTCHours();
const INSIDE = { start: hour, end: (hour + 2) % 24, source: 'policy' as const };
const OUTSIDE = { start: (hour + 2) % 24, end: (hour + 4) % 24, source: 'policy' as const };
const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
const INSIDE_SPAN = `${pad(INSIDE.start)}–${pad(INSIDE.end)}`;

function machine(machineId: string, extra: Record<string, unknown> = {}) {
  return {
    machineId,
    osFamily: 'windows',
    capabilities: { activeHoursGuard: 1 },
    agent_version: '4.1.21',
    activeHours: INSIDE,
    machineTimezone: 'UTC',
    ...extra,
  };
}

describe('machinesInActiveHours', () => {
  it('names only the chosen guarded windows machines inside their window', () => {
    const machines = [
      machine('inside'),
      machine('outside', { activeHours: OUTSIDE }),
      machine('not-chosen'),
      machine('old-agent', { capabilities: {} }),
      // rolled back below 4.1.21: the old agent keeps the capability and installs at once
      machine('rolled-back', { agent_version: '3.3.7' }),
      machine('mac', { osFamily: 'macos' }),
      machine('no-window', { activeHours: undefined }),
    ];

    expect(machinesInActiveHours(machines, ['inside', 'outside', 'old-agent', 'rolled-back', 'mac', 'no-window'])).toEqual([
      { machineId: 'inside', window: INSIDE, inside: true },
    ]);
  });

  it('keeps a machine whose clock is unknown here, since its agent may refuse', () => {
    const machines = [machine('no-zone', { machineTimezone: undefined })];
    expect(machinesInActiveHours(machines, new Set(['no-zone']))).toEqual([
      { machineId: 'no-zone', window: INSIDE, inside: null },
    ]);
  });

  it('reads an absent os family as windows, like every pre-3.4 agent', () => {
    const machines = [machine('legacy', { osFamily: undefined })];
    expect(machinesInActiveHours(machines, ['legacy'])).toHaveLength(1);
  });
});

function renderConfirm(props: {
  action?: DeployConfirmAction;
  machines?: MachineInActiveHours[];
  sending?: boolean;
} = {}) {
  const user = userEvent.setup();
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  render(
    <ActiveHoursDeployConfirm
      action={props.action ?? 'deploy'}
      open
      machines={props.machines ?? [{ machineId: 'kiosk-1', window: INSIDE, inside: true }]}
      onCancel={onCancel}
      sending={props.sending ?? false}
      onConfirm={onConfirm}
    />,
  );
  return { user, onConfirm, onCancel };
}

describe('ActiveHoursDeployConfirm', () => {
  it('lists each machine with its window on the machine clock', () => {
    renderConfirm({
      machines: [
        { machineId: 'kiosk-1', window: INSIDE, inside: true },
        { machineId: 'kiosk-2', window: INSIDE, inside: null },
      ],
    });

    expect(screen.getByRole('dialog', { name: 'deploy inside active hours?' })).toHaveTextContent('machine time');
    const items = within(screen.getByRole('list', { name: 'machines inside active hours' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(`kiosk-1${INSIDE_SPAN}`);
    expect(items[1]).toHaveTextContent(`kiosk-2may be inside ${INSIDE_SPAN}`);
  });

  it('deploys anyway only with a reason, which it sends trimmed', async () => {
    const { user, onConfirm } = renderConfirm();

    const anyway = screen.getByRole('button', { name: 'deploy anyway' });
    expect(anyway).toBeDisabled();
    await user.type(screen.getByLabelText('reason'), '   ');
    expect(anyway).toBeDisabled();

    await user.clear(screen.getByLabelText('reason'));
    await user.type(screen.getByLabelText('reason'), '  venue closed today ');
    await user.click(anyway);
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'venue closed today' });
  });

  it('caps the reason at the 500 characters the server takes', () => {
    renderConfirm();
    expect(screen.getByLabelText('reason')).toHaveAttribute('maxLength', '500');
  });

  it('cancels without sending', async () => {
    const { user, onConfirm, onCancel } = renderConfirm();

    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('words a retry as a retry', async () => {
    const { user, onConfirm } = renderConfirm({ action: 'retry' });

    expect(screen.getByRole('dialog', { name: 'retry inside active hours?' })).toHaveTextContent(
      'every machine in this retry',
    );
    await user.type(screen.getByLabelText('reason'), 'patch before doors open');
    await user.click(screen.getByRole('button', { name: 'retry anyway' }));
    expect(onConfirm).toHaveBeenCalledWith({ reason: 'patch before doors open' });
  });

  it('holds the override while a send is in flight', async () => {
    const { user } = renderConfirm({ sending: true });

    await user.type(screen.getByLabelText('reason'), 'venue closed');
    expect(screen.getByRole('button', { name: 'deploy anyway' })).toBeDisabled();
  });
});
