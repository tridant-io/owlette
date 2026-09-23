/**
 * @jest-environment jsdom
 */

/**
 * the session bar's one way on from an ended or failed session is another
 * one: "reconnect" replaces "end session" there, and nothing else. swoop runs
 * in its own tab, so there is no dashboard to go back to.
 */

import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopToolbar } from '@/components/swoop/SwoopToolbar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SwoopSessionState } from '@/hooks/useSwoopSession';

afterEach(cleanup);

function renderBar(state: SwoopSessionState) {
  const onEnd = jest.fn();
  const onReconnect = jest.fn();
  // the app's root layout provides this; the fullscreen tooltip needs it.
  render(
    <TooltipProvider>
      <SwoopToolbar
        session={null}
        machineId="TEC-B4A"
        state={state}
        error={state === 'error' ? 'the connection to this machine failed.' : null}
        onEnd={onEnd}
        onReconnect={onReconnect}
        statsOpen={false}
        onToggleStats={() => {}}
      />
    </TooltipProvider>,
  );
  return { onEnd, onReconnect };
}

describe('SwoopToolbar', () => {
  it('offers reconnect, not end, once the session has failed', async () => {
    const { onEnd, onReconnect } = renderBar('error');
    expect(screen.queryByRole('button', { name: /end session/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('offers reconnect after the session ended', () => {
    renderBar('ended');
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /end session/i })).toBeNull();
  });

  it('keeps end session while connecting or connected', async () => {
    const { onEnd } = renderBar('connecting');
    expect(screen.queryByRole('button', { name: /reconnect/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /end session/i }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('no longer says anything about keyboard lock in the bar', () => {
    renderBar('connected');
    expect(screen.queryByText(/keyboard lock/i)).toBeNull();
  });
});
