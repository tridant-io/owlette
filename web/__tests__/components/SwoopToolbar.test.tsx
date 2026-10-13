/**
 * @jest-environment jsdom
 */

/**
 * the session bar's way on from an ended or failed session is another one:
 * "reconnect" replaces "end session" there. the way back to the dashboard is
 * on the bar in every state.
 */

import React from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SwoopToolbar } from '@/components/swoop/SwoopToolbar';
import { swoopClipboard } from '@/lib/swoop/clipboard';
import type { SwoopSession } from '@/lib/swoop/features';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';

// the bar reads the clipboard store off a live session, which these tests do
// not have: null is what it gets before attach, and one test hands it a store.
jest.mock('@/lib/swoop/clipboard', () => ({ swoopClipboard: jest.fn(() => null) }));

afterEach(() => {
  cleanup();
  jest.mocked(swoopClipboard).mockReturnValue(null);
});

function renderBar(state: SwoopSessionState, stats?: SwoopStats) {
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
        stats={stats}
      />
    </TooltipProvider>,
  );
  return { onEnd, onReconnect };
}

describe('SwoopToolbar', () => {
  it.each(['idle', 'authorizing', 'connecting', 'connected', 'ended', 'error'] as const)(
    'carries the way back to the dashboard while %s',
    (state) => {
      renderBar(state);
      expect(screen.getByRole('link', { name: 'back to dashboard' })).toHaveAttribute('href', '/dashboard');
    },
  );

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

  it('offers reconnect beside end while a picture that kept freezing stays up', async () => {
    const { onEnd, onReconnect } = renderBar('connected', { stall: { recovery: 'frozen' } } as SwoopStats);
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
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

  it('says so when the browser held back a copy from the machine, and only then', () => {
    renderBar('connected');
    expect(screen.queryByTestId('clipboard-held-notice')).toBeNull();
    cleanup();

    jest.mocked(swoopClipboard).mockReturnValue({ subscribe: () => () => {}, get: () => true, held: () => true });
    renderBar('connected');
    expect(screen.getByTestId('clipboard-held-notice')).toHaveTextContent(/allow the clipboard for this site/);
    expect(screen.queryByTestId('clipboard-notice')).toBeNull();
  });

  it('a notice is a sentence on a top bar and an icon that says it on a side one', () => {
    jest.mocked(swoopClipboard).mockReturnValue({ subscribe: () => () => {}, get: () => true, held: () => true });
    renderBar('connected');
    // both are rendered and css picks one from `data-swoop-bar`, which is set
    // before first paint; react state would put the sentence up for a frame
    expect(screen.getByTestId('clipboard-held-notice')).toHaveClass('md:bar-side:hidden');
    expect(screen.getByRole('button', { name: /allow the clipboard for this site/ })).toHaveClass(
      'hidden',
      'md:bar-side:inline-flex',
    );
    expect(screen.getByTestId('session-bar')).toHaveClass('md:bar-side:flex-col');
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
      stall: { recovery: 'none', episodes: 0, kind: null },
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

/**
 * owlette swoop's windows have no native frame, so there the bar is the
 * window's title bar too (task 2.9). where the bar sits is css, read from
 * `data-swoop-bar`, so these check the classes that pick a layout.
 */
describe('SwoopToolbar inside owlette swoop', () => {
  const app = (os: string) => `Mozilla/5.0 (${os}) AppleWebKit/537.36 owlette-swoop-viewer/4.1.8`;
  let ua: jest.SpyInstance | undefined;
  const as = (agent: string) => {
    ua = jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent);
  };
  afterEach(() => ua?.mockRestore());

  it('leads back to the picker, not the dashboard', () => {
    as(app('Windows NT 10.0; Win64; x64'));
    renderBar('connected');
    expect(screen.getByRole('link', { name: 'back to machines' })).toHaveAttribute('href', '/swoop');
    expect(screen.queryByRole('link', { name: 'back to dashboard' })).toBeNull();
  });

  it('is only the session bar in a browser', () => {
    renderBar('connected');
    expect(screen.getByTestId('session-bar')).not.toHaveAttribute('data-tauri-drag-region');
    expect(screen.queryByTestId('window-controls')).toBeNull();
    expect(screen.queryByTestId('swoop-window-strip')).toBeNull();
  });

  it('drags the window and ends in its controls on top; on a side they move to a strip of their own', () => {
    as(app('Windows NT 10.0; Win64; x64'));
    renderBar('connected');
    const bar = screen.getByTestId('session-bar');
    expect(bar).toHaveAttribute('data-tauri-drag-region', 'deep');
    // what is on the bar fades in; the bar's own background, the picker header's tone, stays put
    expect(bar).toHaveClass('[&>*]:motion-safe:animate-in', '[&>*]:fade-in-0');
    expect(bar).not.toHaveClass('fade-in-0');
    expect(bar).not.toHaveClass('motion-safe:animate-in');

    const strip = screen.getByTestId('swoop-window-strip');
    const [onTop, onSide] = screen.getAllByTestId('window-controls');
    // on top: the bar's last control, gone when the bar is on a side
    expect(onTop.parentElement).toBe(bar);
    expect(onTop).toHaveClass('md:bar-side:hidden');
    // on a side: the strip across the top, and only then
    expect(strip).toContainElement(onSide);
    expect(strip).toHaveClass('hidden', 'md:bar-side:flex');
    // a right bar starts below the strip's controls, which share its edge
    expect(bar).toHaveClass('md:bar-right:pt-11');
    expect(bar).not.toHaveClass('md:bar-left:pt-11');
    // the session's own buttons are still all there
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
  });

  it('on macos starts after the traffic lights and draws no window buttons', () => {
    as(app('Macintosh; Intel Mac OS X 10_15_7'));
    renderBar('connected');
    const bar = screen.getByTestId('session-bar');
    expect(bar).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(screen.getByTestId('traffic-lights-inset')).toHaveClass('md:bar-side:hidden');
    expect(screen.queryByTestId('window-controls')).toBeNull();
    expect(screen.queryByRole('button', { name: 'close' })).toBeNull();
    // the lights are on the left, so a left bar starts below them
    expect(bar).toHaveClass('md:bar-left:pt-11');
    expect(screen.getByTestId('swoop-window-strip')).toHaveClass('hidden', 'md:bar-side:flex');
  });

  /** the bar on a live session whose stage goes fullscreen at once. */
  const renderLive = (requestFullscreen = jest.fn(() => Promise.resolve())) => {
    const stage = document.createElement('div');
    stage.requestFullscreen = requestFullscreen;
    render(
      <TooltipProvider delayDuration={0}>
        <SwoopToolbar
          session={{ ctl: true, stage } as unknown as SwoopSession}
          machineId="TEC-B4A"
          state="connected"
          error={null}
          onEnd={() => {}}
          onReconnect={() => {}}
          statsOpen={false}
          onToggleStats={() => {}}
        />
      </TooltipProvider>,
    );
    return { fullscreen: screen.getByRole('button', { name: 'fullscreen with keyboard and mouse capture' }), requestFullscreen };
  };

  it.each([
    ['on a mac it says cmd+tab stays', 'Macintosh; Intel Mac OS X 10_15_7', ' cmd+tab stays on this mac.'],
    ['elsewhere it does not', 'Windows NT 10.0; Win64; x64', ''],
  ])('with native keys the fullscreen tooltip says the app hands shortcuts over; %s', async (_case, os, tail) => {
    as(`${app(os)} (keys)`);
    const { fullscreen } = renderLive();
    await userEvent.hover(fullscreen);
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      `fullscreen: the app hands every shortcut it can to the machine; hold esc to come back.${tail}`,
    );
  });

  it('takes no keyboard lock with fullscreen, which a browser with the api does take', async () => {
    const lock = jest.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'keyboard', { value: { lock, unlock: jest.fn() }, configurable: true });
    const engage = async () => {
      const { fullscreen, requestFullscreen } = renderLive();
      await userEvent.click(fullscreen);
      await act(async () => {});
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      cleanup();
    };
    try {
      as(`${app('Macintosh; Intel Mac OS X 10_15_7')} (keys)`);
      await engage();
      expect(lock).not.toHaveBeenCalled();

      ua?.mockRestore();
      await engage();
      expect(lock).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, 'keyboard');
    }
  });
});
