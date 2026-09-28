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
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';

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

  it('no longer says anything about keyboard lock or esc in the bar', () => {
    renderBar('connected');
    expect(screen.queryByText(/keyboard lock/i)).toBeNull();
    expect(screen.queryByText(/hold esc/i)).toBeNull();
  });

  it('shows the hostname alone while connected: no state word, no badge, icon-only buttons', () => {
    renderBar('connected');
    expect(screen.getByText('TEC-B4A')).toBeInTheDocument();
    expect(screen.queryByText(/^connected$/i)).toBeNull();
    expect(screen.queryByTestId('session-badge')).toBeNull();
    for (const name of [/end session/i, /fullscreen/i, /latency stats/i]) {
      expect(screen.getByRole('button', { name })).toHaveTextContent('');
    }
  });

  it('badges a lost connection, with the countdown while a retry is scheduled', () => {
    const { unmount } = render(
      <TooltipProvider>
        <SwoopToolbar
          session={null}
          machineId="TEC-B4A"
          state="ended"
          error="the connection to this machine failed."
          retryIn={7}
          onEnd={() => {}}
          onReconnect={() => {}}
          statsOpen={false}
          onToggleStats={() => {}}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('session-badge')).toHaveTextContent('reconnecting in 7 s');
    unmount();
    renderBar('error');
    expect(screen.getByTestId('session-badge')).toHaveTextContent('disconnected');
  });

  it('badges a poor connection from the measured round trip, and only then', () => {
    const stats = (rttUs: number): SwoopStats => ({
      signal: 'open',
      presenter: null,
      receiver: null,
      frame: null,
      feedback: {
        reports: 1,
        fbSent: 1,
        statsSent: 1,
        pingsSent: 1,
        pongsMatched: 1,
        pongsUnmatched: 0,
        pingsAbandoned: 0,
        silences: 0,
        framesObserved: 0,
        framesDropped: 0,
        arrivalFallbacks: 0,
        statsSuppressed: 0,
        clockOffsetUs: 0,
        rttUs,
        delayRiseUs: 0,
        referenceMinUs: null,
        referenceSamples: 0,
      },
    });
    const bar = (rttUs: number) => (
      <TooltipProvider>
        <SwoopToolbar
          session={null}
          machineId="TEC-B4A"
          state="connected"
          error={null}
          stats={stats(rttUs)}
          onEnd={() => {}}
          onReconnect={() => {}}
          statsOpen={false}
          onToggleStats={() => {}}
        />
      </TooltipProvider>
    );
    const { rerender } = render(bar(20_000));
    expect(screen.queryByTestId('session-badge')).toBeNull();
    rerender(bar(400_000));
    expect(screen.getByTestId('session-badge')).toHaveTextContent('poor connection');
  });
});
