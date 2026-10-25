/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * The one restart and shutdown confirm the context menu, the card's approve
 * button and the manage-sites machine list share.
 *
 * Inside a guarded machine's active hours the agent refuses a restart or a
 * shutdown that carries no override, and a refused restart still counts
 * against its 5 s rate limit — so the confirm has to offer the choice up front
 * and send the override on the first request, never refuse-then-retry.
 * Machines whose agent guards nothing keep the plain confirm.
 */

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MachinePowerConfirm, usePowerCommand } from '@/components/MachinePowerConfirm';
import { toast } from '@/lib/toast';
import { useCommandOutcome, type CommandOutcome } from '@/hooks/useCommandResult';
import type { ActiveHoursGuard, PowerAction, PowerCommandOptions, PowerCommandSent } from '@/lib/activeHours';

jest.mock('@/lib/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn(), warning: jest.fn() },
}));

jest.mock('@/hooks/useCommandResult', () => ({ useCommandOutcome: jest.fn(() => null) }));
const mockedOutcome = jest.mocked(useCommandOutcome);

// seeded on UTC, so these hold whatever hour the suite runs at
const hour = new Date().getUTCHours();
const INSIDE: ActiveHoursGuard = {
  window: { start: hour, end: (hour + 2) % 24, source: 'policy' },
  timezone: 'UTC',
};
const OUTSIDE: ActiveHoursGuard = {
  window: { start: (hour + 2) % 24, end: (hour + 4) % 24, source: 'policy' },
  timezone: 'UTC',
};
const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
const INSIDE_SPAN = `${pad(hour)}–${pad((hour + 2) % 24)}`;

function renderConfirm(props: {
  action?: PowerAction;
  guard?: ActiveHoursGuard | null;
  onConfirm?: (options: PowerCommandOptions) => void;
  sending?: boolean;
}) {
  const user = userEvent.setup();
  const onConfirm = props.onConfirm ?? jest.fn();
  render(
    <MachinePowerConfirm
      action={props.action ?? 'restart'}
      open
      onOpenChange={jest.fn()}
      machineName="kiosk-1"
      guard={props.guard}
      sending={props.sending ?? false}
      onConfirm={onConfirm}
    />,
  );
  return { user, onConfirm };
}

describe('MachinePowerConfirm — no active hours to respect', () => {
  it('keeps the plain restart confirm, with the agent\'s 60 seconds', async () => {
    const { user, onConfirm } = renderConfirm({ guard: null });

    const dialog = screen.getByRole('dialog', { name: 'restart kiosk-1?' });
    expect(dialog).toHaveTextContent('restart the machine in 60 seconds');
    expect(dialog).not.toHaveTextContent('30 seconds');
    expect(dialog).not.toHaveTextContent('active hours');

    await user.click(screen.getByRole('button', { name: 'restart' }));
    expect(onConfirm).toHaveBeenCalledWith({});
  });

  it('keeps the plain confirm outside the window', () => {
    renderConfirm({ guard: OUTSIDE });

    expect(screen.queryByTestId('active-hours-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'restart' })).toBeInTheDocument();
  });

  it('keeps the plain shutdown confirm', async () => {
    const { user, onConfirm } = renderConfirm({ action: 'shutdown', guard: null });

    expect(screen.getByRole('dialog', { name: 'shutdown kiosk-1?' })).toHaveTextContent(
      'shut down the machine in 60 seconds',
    );
    await user.click(screen.getByRole('button', { name: 'shutdown' }));
    expect(onConfirm).toHaveBeenCalledWith({});
  });
});

describe('MachinePowerConfirm — inside active hours', () => {
  it('names the window on the machine clock and offers three ways out', () => {
    renderConfirm({ guard: INSIDE });

    expect(screen.getByTestId('active-hours-notice')).toHaveTextContent(
      `inside active hours (${INSIDE_SPAN}, machine time)`,
    );
    expect(screen.getByRole('button', { name: 'cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'restart when active hours end' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'restart now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'restart' })).not.toBeInTheDocument();
  });

  it('defers without an override', async () => {
    const { user, onConfirm } = renderConfirm({ guard: INSIDE });

    await user.click(screen.getByRole('button', { name: 'restart when active hours end' }));
    expect(onConfirm).toHaveBeenCalledWith({ when: 'after_active_hours' });
  });

  it('restarts now only with a reason, which it sends as the override', async () => {
    const { user, onConfirm } = renderConfirm({ guard: INSIDE });

    const now = screen.getByRole('button', { name: 'restart now' });
    expect(now).toBeDisabled();
    await user.type(screen.getByLabelText('reason'), '   ');
    expect(now).toBeDisabled();

    await user.clear(screen.getByLabelText('reason'));
    await user.type(screen.getByLabelText('reason'), '  venue closed today ');
    expect(now).toBeEnabled();
    await user.click(now);
    expect(onConfirm).toHaveBeenCalledWith({ override: { reason: 'venue closed today' } });
  });

  it('caps the reason at the 500 characters the server takes', () => {
    renderConfirm({ guard: INSIDE });
    expect(screen.getByLabelText('reason')).toHaveAttribute('maxLength', '500');
  });

  it('offers no deferral for a shutdown', async () => {
    const { user, onConfirm } = renderConfirm({ action: 'shutdown', guard: INSIDE });

    expect(screen.queryByRole('button', { name: /when active hours end/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('reason'), 'power work');
    await user.click(screen.getByRole('button', { name: 'shut down now' }));
    expect(onConfirm).toHaveBeenCalledWith({ override: { reason: 'power work' } });
  });

  it('says "may be" when the machine clock is unknown, and still offers the choice', () => {
    renderConfirm({ guard: { ...INSIDE, timezone: undefined } });

    expect(screen.getByTestId('active-hours-notice')).toHaveTextContent(
      `may be inside active hours (${INSIDE_SPAN}, machine time)`,
    );
    expect(screen.getByRole('button', { name: 'restart when active hours end' })).toBeInTheDocument();
  });

  it('holds every action while a send is in flight', () => {
    renderConfirm({ guard: INSIDE, sending: true });

    expect(screen.getByRole('button', { name: 'restart when active hours end' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'restart now' })).toBeDisabled();
  });
});

function Harness({
  action = 'restart',
  options = {},
  run,
}: {
  action?: PowerAction;
  options?: PowerCommandOptions;
  run: (options: PowerCommandOptions) => Promise<PowerCommandSent | void>;
}) {
  const power = usePowerCommand('site-A');
  return (
    <button
      type="button"
      onClick={() => void power.send({ machineId: 'kiosk-1', machineName: 'kiosk-1', action, options, run })}
    >
      send
    </button>
  );
}

describe('usePowerCommand — what the agent did with it', () => {
  beforeEach(() => {
    mockedOutcome.mockReset();
    mockedOutcome.mockReturnValue(null);
  });

  async function sendWith(
    run: (options: PowerCommandOptions) => Promise<PowerCommandSent | void>,
    props: { action?: PowerAction; options?: PowerCommandOptions } = {},
  ) {
    const user = userEvent.setup();
    const view = render(<Harness run={run} {...props} />);
    await user.click(screen.getByRole('button', { name: 'send' }));
    return view;
  }

  function agentAnswers(outcome: CommandOutcome, view: ReturnType<typeof render>, run: Parameters<typeof sendWith>[0]) {
    mockedOutcome.mockImplementation((_site, _machine, commandId) => (commandId === 'cmd_1' ? outcome : null));
    act(() => {
      view.rerender(<Harness run={run} />);
    });
  }

  it('watches the command it sent and says it was sent', async () => {
    const run = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    await sendWith(run, { options: { override: { reason: 'venue closed' } } });

    expect(run).toHaveBeenCalledWith({ override: { reason: 'venue closed' } });
    expect(mockedOutcome).toHaveBeenLastCalledWith('site-A', 'kiosk-1', 'cmd_1');
    expect(toast.success).toHaveBeenCalledWith('restart command sent to kiosk-1', expect.anything());
  });

  it('says a deferred restart waits for active hours to end', async () => {
    const run = jest.fn().mockResolvedValue({ commandId: 'cmd_1' });
    await sendWith(run, { options: { when: 'after_active_hours' } });

    expect(toast.success).toHaveBeenCalledWith('kiosk-1 will restart when active hours end', expect.anything());
  });

  it('takes the countdown back and names the window when the agent refuses', async () => {
    const revertCountdown = jest.fn();
    const run = jest.fn().mockResolvedValue({ commandId: 'cmd_1', revertCountdown });
    const view = await sendWith(run);

    agentAnswers(
      {
        status: 'failed',
        error: 'Error: active_hours: inside active hours 08:00–17:00 (machine time); they end at 17:00',
      },
      view,
      run,
    );

    expect(revertCountdown).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      'restart refused: inside active hours 08:00–17:00',
      expect.objectContaining({ description: expect.stringContaining('17:00') }),
    );
  });

  it('takes the countdown back on any other failure too, with what the agent said', async () => {
    const revertCountdown = jest.fn();
    const run = jest.fn().mockResolvedValue({ commandId: 'cmd_1', revertCountdown });
    const view = await sendWith(run);

    agentAnswers({ status: 'failed', error: 'Error: reboot failed: access denied' }, view, run);

    expect(revertCountdown).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('restart failed on kiosk-1', { description: 'reboot failed: access denied' });
  });

  it('leaves the countdown when the agent took the command', async () => {
    const revertCountdown = jest.fn();
    const run = jest.fn().mockResolvedValue({ commandId: 'cmd_1', revertCountdown });
    const view = await sendWith(run);

    agentAnswers({ status: 'completed', result: 'Reboot scheduled in 60 seconds' }, view, run);

    expect(revertCountdown).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports a send the server rejected', async () => {
    const run = jest.fn().mockRejectedValue(new Error('machine is offline'));
    await sendWith(run, { action: 'shutdown' });

    expect(toast.error).toHaveBeenCalledWith('failed to send shutdown command', { description: 'machine is offline' });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
