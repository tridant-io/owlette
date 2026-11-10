/**
 * @jest-environment jsdom
 */

/**
 * the session bar's way on from an ended or failed session is another one:
 * "reconnect" replaces "end session" there. the way back to the dashboard is
 * on the bar in every state.
 */

import React from 'react';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BADGE_EXIT_MS, SwoopToolbar } from '@/components/swoop/SwoopToolbar';
import { tintOf } from '@/components/swoop/SwoopPresence';
import { ACTIVITY_CLICK_MS, ACTIVITY_MOVE_MS, attach as attachActivity } from '@/lib/swoop/activity';
import type { SwoopBarPosition } from '@/lib/swoop/barPosition';
import { swoopClipboard } from '@/lib/swoop/clipboard';
import type { SwoopSession } from '@/lib/swoop/features';
import { attach as attachPresence } from '@/lib/swoop/presence';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';

// the bar reads the clipboard store off a live session, which these tests do
// not have: null is what it gets before attach, and one test hands it a store.
jest.mock('@/lib/swoop/clipboard', () => ({ swoopClipboard: jest.fn(() => null) }));

// the bar asks a live session's input capture for pointer lock; null is a session with none.
let mockInputCapture: { requestPointerLock: () => Promise<boolean>; exitPointerLock: () => void } | null = null;
jest.mock('@/lib/swoop/features', () => ({
  ...jest.requireActual('@/lib/swoop/features'),
  swoopInputCapture: () => mockInputCapture,
}));

// jsdom has no fullscreen api, and the bar offers fullscreen only where the
// browser has one: these tests are a desktop browser's, which does.
const elementFullscreen = (present: boolean) => {
  if (present) {
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      value: () => Promise.resolve(),
      configurable: true,
      writable: true,
    });
  } else {
    delete (Element.prototype as Partial<Element>).requestFullscreen;
  }
};
beforeEach(() => elementFullscreen(true));

// a window under `md`: the media query for the wide bar does not match.
const narrowWindow = () => {
  window.matchMedia = jest.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
};

afterEach(() => {
  cleanup();
  jest.mocked(swoopClipboard).mockReturnValue(null);
  mockInputCapture = null;
  localStorage.clear();
  elementFullscreen(false);
  delete (window as Partial<Window>).matchMedia;
});

function renderBar(state: SwoopSessionState, stats?: SwoopStats) {
  const onEnd = jest.fn();
  const onReconnect = jest.fn();
  const onToggleStats = jest.fn();
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
        onToggleStats={onToggleStats}
        stats={stats}
      />
    </TooltipProvider>,
  );
  return { onEnd, onReconnect, onToggleStats };
}

describe('SwoopToolbar on a phone', () => {
  it('puts every control behind one button, each labelled under it', async () => {
    narrowWindow();
    renderBar('connected');
    expect(screen.queryByRole('button', { name: 'latency stats' })).toBeNull();
    expect(screen.getByRole('link', { name: 'back to dashboard' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'session controls' }));
    const menu = screen.getByRole('dialog');
    expect(menu).toContainElement(screen.getByRole('button', { name: 'latency stats' }));
    expect(menu).toContainElement(screen.getByRole('button', { name: 'end session' }));
    expect(menu).toHaveTextContent('stats');
    // the short label, not the tooltip's sentence
    expect(menu).toHaveTextContent('fullscreen');
    expect(menu).not.toHaveTextContent('shortcuts like alt+tab');
  });

  it('closes its menu when stats opens, which shows where the menu was', async () => {
    narrowWindow();
    const { onToggleStats } = renderBar('connected');
    await userEvent.click(screen.getByRole('button', { name: 'session controls' }));
    await userEvent.click(screen.getByRole('button', { name: 'latency stats' }));
    expect(onToggleStats).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves fullscreen out where the browser has none for a page, as on an iphone', () => {
    elementFullscreen(false);
    renderBar('connected');
    expect(screen.queryByRole('button', { name: /^fullscreen with/ })).toBeNull();
    // the mouse is captured only in fullscreen, so its toggle goes with it
    expect(screen.queryByRole('button', { name: 'capture the mouse in fullscreen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'end session' })).toBeInTheDocument();
  });
});

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
    for (const name of [/end session/i, /^fullscreen with keyboard capture$/, /^capture the mouse in fullscreen$/, /latency stats/i]) {
      expect(screen.getByRole('button', { name })).toHaveTextContent('');
    }
  });

  it('shows the stats button pressed while the stats are open, under one name', () => {
    const bar = (statsOpen: boolean) => (
      <TooltipProvider>
        <SwoopToolbar
          session={null}
          machineId="TEC-B4A"
          state="connected"
          error={null}
          onEnd={() => {}}
          onReconnect={() => {}}
          statsOpen={statsOpen}
          onToggleStats={() => {}}
        />
      </TooltipProvider>
    );
    const { rerender } = render(bar(false));
    expect(screen.getByRole('button', { name: 'latency stats' })).toHaveAttribute('aria-pressed', 'false');
    rerender(bar(true));
    expect(screen.getByRole('button', { name: 'latency stats' })).toHaveAttribute('aria-pressed', 'true');
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
    expect(screen.getByRole('button', { name: /allow clipboard access for this site/ })).toBe(
      screen.getByTestId('clipboard-held-notice'),
    );
    // the icon's name and its tooltip say it, never text on the bar
    expect(screen.queryByText(/this browser will not take it yet/)).toBeNull();
    expect(screen.queryByTestId('clipboard-notice')).toBeNull();
  });

  /** the bar with the held copy's notice up, along the top or down `position`'s side: the notice, checked as an icon. */
  const renderHeldNotice = (position: SwoopBarPosition = 'top') => {
    jest.mocked(swoopClipboard).mockReturnValue({ subscribe: () => () => {}, get: () => true, held: () => true });
    render(
      <TooltipProvider delayDuration={0}>
        <SwoopToolbar
          session={null}
          machineId="TEC-B4A"
          state="connected"
          error={null}
          onEnd={() => {}}
          onReconnect={() => {}}
          statsOpen={false}
          onToggleStats={() => {}}
          position={position}
        />
      </TooltipProvider>,
    );
    const notice = screen.getByRole('button', { name: /allow clipboard access for this site/ });
    expect(notice).toHaveAttribute('data-testid', 'clipboard-held-notice');
    expect(notice).toHaveTextContent('');
    expect(notice.querySelector('svg')).toHaveClass('lucide-triangle-alert', 'text-warning');
    // the same one element on every layout: nothing for css to swap for a sentence
    for (const element of [notice, notice.parentElement!]) {
      expect([...element.classList].filter((name) => name === 'hidden' || name.startsWith('md:'))).toEqual([]);
    }
    return notice;
  };

  /** the tooltip a hover raises on the notice, which says the sentence the icon is named. */
  const hoverNotice = async (notice: HTMLElement) => {
    await userEvent.hover(notice);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe(notice.getAttribute('aria-label'));
    return tip;
  };

  it('a notice is a warning icon that says its sentence on hover, on every layout', async () => {
    await hoverNotice(renderHeldNotice());
  });

  it('a notice on a side bar is the same icon, and its tooltip reads across, not down the bar', async () => {
    // the page sets it before first paint, and the bar-side variants key on it
    document.documentElement.dataset.swoopBar = 'left';
    try {
      const tip = await hoverNotice(renderHeldNotice('left'));
      expect(screen.getByTestId('session-bar')).toHaveClass('md:bar-side:flex-col');
      // portaled under the same <html>, where a vertical class would turn the tooltip too
      expect(tip.className).not.toContain('[writing-mode');
      expect(tip.querySelector('[class*="[writing-mode"]')).toBeNull();
    } finally {
      delete document.documentElement.dataset.swoopBar;
    }
  });

  it('a tap on a notice opens its sentence in a popover, for a touch screen with no hover', async () => {
    const notice = renderHeldNotice();
    await userEvent.click(notice);
    const popover = await screen.findByRole('dialog');
    expect(popover).toHaveTextContent(notice.getAttribute('aria-label')!);
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
      linkUp: true,
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

  it('a path that is gone reads as lost, whatever the last round trip measured', () => {
    render(
      <TooltipProvider>
        <SwoopToolbar
          session={null}
          machineId="TEC-B4A"
          state="connected"
          error={null}
          stats={
            {
              signal: 'open',
              feedback: { rttUs: 400_000 },
              linkUp: false,
              stall: { recovery: 'none', episodes: 0, kind: null },
            } as unknown as SwoopStats
          }
          onEnd={() => {}}
          onReconnect={() => {}}
          statsOpen={false}
          onToggleStats={() => {}}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId('session-badge')).toHaveTextContent('connection lost');
  });
});

/**
 * the badge fades up and in when it comes and back out when it goes, quick
 * but never a pop (owner, 2026-11-10): it stays on the bar through its fade
 * out, saying what it said, and a new word while it shows is only new text.
 */
describe('SwoopToolbar badge coming and going', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const bar = (rttUs: number, linkUp = true) => (
    <TooltipProvider>
      <SwoopToolbar
        session={null}
        machineId="TEC-B4A"
        state="connected"
        error={null}
        stats={
          {
            signal: 'open',
            feedback: { rttUs },
            linkUp,
            stall: { recovery: 'none', episodes: 0, kind: null },
          } as unknown as SwoopStats
        }
        onEnd={() => {}}
        onReconnect={() => {}}
        statsOpen={false}
        onToggleStats={() => {}}
      />
    </TooltipProvider>
  );

  it('fades the pill in when it comes, and moves it only where motion is welcome', () => {
    const { rerender } = render(bar(20_000));
    expect(screen.queryByTestId('session-badge')).toBeNull();
    rerender(bar(400_000));
    const pill = screen.getByTestId('session-badge');
    expect(pill).toHaveAttribute('data-state', 'open');
    // with reduced motion it never moves: its settle is motion-safe
    const slides = [...pill.classList].filter((name) => name.includes('slide-'));
    expect(slides.length).toBeGreaterThan(0);
    expect(slides.every((name) => name.includes('motion-safe:'))).toBe(true);
  });

  it('keeps the pill through its fade out, saying what it said, then lets it go', () => {
    const { rerender } = render(bar(400_000));
    rerender(bar(20_000));
    const pill = screen.getByTestId('session-badge');
    expect(pill).toHaveAttribute('data-state', 'closed');
    expect(pill).toHaveTextContent('poor connection');

    act(() => jest.advanceTimersByTime(BADGE_EXIT_MS - 1));
    expect(pill).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByTestId('session-badge')).toBeNull();
  });

  it('changes only its words when it has something else to say', () => {
    const { rerender } = render(bar(400_000));
    const pill = screen.getByTestId('session-badge');
    rerender(bar(400_000, false));
    expect(screen.getByTestId('session-badge')).toBe(pill);
    expect(pill).toHaveTextContent('connection lost');
    expect(pill).toHaveAttribute('data-state', 'open');
  });
});

/**
 * who is in the session sits beside the machine's name: a pill per viewer, as
 * the session route names them. the route sends an email only to a site owner
 * or admin (its own tests hold that line); the bar shows what it was sent.
 */
describe('SwoopToolbar with others in the session', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });
  afterEach(() => {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
    fetchMock.mockReset();
  });

  /**
   * a live session the streamer has sent a roster on, the caller's own line in
   * control as an admin's is or watching as a member's is, with the names the
   * session route answers that caller: an admin may kick anyone but their own seat.
   */
  function renderShared({ admin, alone = false }: { admin: boolean; alone?: boolean }) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          viewers: [
            {
              viewerId: 'viewer-ada',
              uid: 'uid_ada',
              displayName: 'Ada Lovelace',
              ...(admin ? { email: 'ada@example.test' } : {}),
              kickable: admin,
            },
            {
              viewerId: 'viewer-me',
              uid: 'uid_me',
              displayName: 'Bob Watcher',
              ...(admin ? { email: 'bob@example.test' } : {}),
              kickable: false,
            },
          ],
        },
      }),
    });
    const handlers = new Map<string, (data: unknown) => void>();
    const session = {
      siteId: 'site-a',
      machineId: 'TEC-B4A',
      sid: 'sid-1',
      viewerId: 'viewer-me',
      ctl: admin,
      stage: document.createElement('div'),
      onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
        handlers.set(label, incoming);
        return () => handlers.delete(label);
      },
    } as unknown as SwoopSession;
    attachPresence(session);
    render(
      <TooltipProvider delayDuration={0}>
        <SwoopToolbar
          session={session}
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
    const me = { id: 'viewer-me', name: 'uid_me', ctl: admin };
    const ada = { id: 'viewer-ada', name: 'uid_ada', ctl: !admin };
    act(() =>
      handlers.get('swoop-control')?.(JSON.stringify({ t: 'roster', viewers: alone ? [me] : [ada, me], tsUs: 1 })),
    );
  }

  it('shows a pill per viewer right after the machine name, this tab marked', async () => {
    renderShared({ admin: true });

    const ada = await screen.findByRole('button', { name: /^Ada L\./ });
    expect(screen.getByRole('button', { name: /^Bob W\. \(you\)/ })).toBeInTheDocument();
    const pills = screen.getByRole('list', { name: 'in this session' });
    expect(pills).toContainElement(ada);
    expect(screen.getByText('TEC-B4A').nextElementSibling).toBe(pills);
    // a watcher's pill says so, to a screen reader as its eye does on screen
    expect(ada).toHaveAccessibleName('Ada L., view only');
    // the one people button is a compact bar's
    expect(screen.queryByRole('button', { name: /in this session$/ })).toBeNull();
  });

  it('shows your own pill while you are alone in the session', async () => {
    renderShared({ admin: true, alone: true });

    const pills = await screen.findByRole('list', { name: 'in this session' });
    await waitFor(() => expect(pills).toHaveTextContent(/^Bob W\. \(you\)$/));
  });

  it('on a phone folds the pills into one button with the count, whose list names each in full', async () => {
    narrowWindow();
    renderShared({ admin: false });

    const people = await screen.findByRole('button', { name: '2 in this session' });
    expect(people).toHaveTextContent('2');
    expect(screen.queryByRole('list', { name: 'in this session' })).toBeNull();

    await userEvent.click(people);
    const list = await screen.findByRole('list', { name: 'in this session' });
    expect(screen.getByRole('dialog')).toContainElement(list);
    await screen.findByText('Ada Lovelace');
    expect(list).toHaveTextContent('Bob Watcher (you)');
    // a watcher's eye says so to a screen reader
    expect(within(list).getByRole('img', { name: 'view only' })).toBeInTheDocument();
  });

  it('shows a member the full name on hover, and nothing else', async () => {
    renderShared({ admin: false });

    await userEvent.hover(await screen.findByRole('button', { name: /^Ada L\./ }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(/^Ada Lovelace$/);
  });

  it('shows an admin the email beside the full name on hover', async () => {
    renderShared({ admin: true });

    await userEvent.hover(await screen.findByRole('button', { name: /^Ada L\./ }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Ada Lovelace');
    expect(tip).toHaveTextContent('ada@example.test');
    // a tooltip takes no clicks: kick is in the pill's menu
    expect(tip).not.toHaveTextContent('kick');
  });

  /** the admin clicks Ada's pill, then kick in its menu; the confirm is open. */
  async function askToKickAda(): Promise<HTMLElement> {
    renderShared({ admin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Ada L., view only' }));
    await userEvent.click(within(await screen.findByTestId('viewer-menu')).getByRole('button', { name: 'kick' }));
    return screen.findByRole('dialog', { name: 'kick Ada Lovelace?' });
  }

  it("opens a pill's menu on a click: the full name, the email and, to an admin, kick for someone else", async () => {
    renderShared({ admin: true });

    await userEvent.click(await screen.findByRole('button', { name: 'Ada L., view only' }));
    const menu = await screen.findByTestId('viewer-menu');
    expect(menu).toHaveTextContent('Ada Lovelace');
    expect(menu).toHaveTextContent('ada@example.test');
    // under the email
    expect(within(menu).getByText('ada@example.test').nextElementSibling).toBe(
      within(menu).getByRole('button', { name: 'kick' }),
    );
  });

  it('opens your own pill’s menu too, with no kick in it', async () => {
    renderShared({ admin: true });

    await userEvent.click(await screen.findByRole('button', { name: 'Bob W. (you)' }));
    const menu = await screen.findByTestId('viewer-menu');
    expect(menu).toHaveTextContent('Bob Watcher (you)');
    expect(menu).toHaveTextContent('bob@example.test');
    expect(within(menu).queryByRole('button', { name: 'kick' })).toBeNull();
  });

  it("gives a member the full name in a pill's menu, and no kick", async () => {
    renderShared({ admin: false });

    await userEvent.click(await screen.findByRole('button', { name: 'Ada L.' }));
    const menu = await screen.findByTestId('viewer-menu');
    expect(menu).toHaveTextContent(/^Ada Lovelace$/);
    expect(within(menu).queryByRole('button', { name: 'kick' })).toBeNull();
  });

  it('asks before it kicks, then posts the seat to the kick route and closes', async () => {
    const dialog = await askToKickAda();
    expect(dialog).toHaveTextContent(
      "they leave the session now and can rejoin. to keep someone out, change their swoop mode in the site's members section.",
    );
    // the names read only: nothing is kicked before the confirm
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/kick$/), expect.anything());

    await userEvent.click(within(dialog).getByRole('button', { name: 'kick' }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/sites/site-a/machines/TEC-B4A/swoop/sessions/sid-1/kick',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ viewerId: 'viewer-ada' }) }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'kick Ada Lovelace?' })).toBeNull());
  });

  it("keeps the question open with the api's sentence when the kick is refused", async () => {
    const dialog = await askToKickAda();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'session_ended', detail: 'this session has already ended' }),
    });

    await userEvent.click(within(dialog).getByRole('button', { name: 'kick' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('this session has already ended');
    expect(screen.getByRole('dialog', { name: 'kick Ada Lovelace?' })).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'kick' })).toBeEnabled();
  });

  it('cancel closes the question and kicks nobody', async () => {
    const dialog = await askToKickAda();

    await userEvent.click(within(dialog).getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('dialog', { name: 'kick Ada Lovelace?' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringMatching(/\/kick$/), expect.anything());
  });

  it("puts kick under the email in a phone's list, where the route says this caller may", async () => {
    narrowWindow();
    renderShared({ admin: true });

    await userEvent.click(await screen.findByRole('button', { name: '2 in this session' }));
    const list = await screen.findByRole('list', { name: 'in this session' });
    const [ada, me] = within(list).getAllByRole('listitem');
    expect(await within(ada).findByText('ada@example.test')).toBeInTheDocument();
    expect(within(ada).getByText('ada@example.test').nextElementSibling).toBe(
      within(ada).getByRole('button', { name: 'kick' }),
    );
    expect(within(me).queryByRole('button', { name: 'kick' })).toBeNull();

    await userEvent.click(within(ada).getByRole('button', { name: 'kick' }));
    expect(await screen.findByRole('dialog', { name: 'kick Ada Lovelace?' })).toBeInTheDocument();
  });

  it('keeps the pointer and the eye in a pill upright on a side bar, where the pill turns', async () => {
    renderShared({ admin: true });

    // this tab controls, so its pill has the pointer; ada watches, so hers has the eye
    const pointer = (await screen.findByRole('button', { name: 'Bob W. (you)' })).querySelector('svg');
    const eye = screen.getByRole('button', { name: 'Ada L., view only' }).querySelector('svg');
    expect(pointer).toHaveClass('lucide-mouse-pointer-2');
    expect(eye).toHaveClass('lucide-eye');
    for (const icon of [pointer!, eye!]) {
      // the pill's text runs down a right bar and, turned half round, up a left one
      expect(icon.parentElement).toHaveClass('md:bar-side:[writing-mode:vertical-rl]', 'md:bar-left:rotate-180');
      // writing-mode leaves an svg upright, so a right bar needs nothing and a left bar's half turn is undone
      expect([...icon.classList].filter((name) => /rotate|writing-mode/.test(name))).toEqual(['md:bar-left:rotate-180']);
    }
  });

  it('leaves the icons in the compact list unturned, as the list itself is', async () => {
    narrowWindow();
    renderShared({ admin: true });

    await userEvent.click(await screen.findByRole('button', { name: '2 in this session' }));
    const icons = (await screen.findByRole('list', { name: 'in this session' })).querySelectorAll('svg');
    expect(icons).toHaveLength(2);
    // the list opens in a portal under the same <html>, where a left bar's variant would still turn them
    for (const icon of icons) expect(icon).not.toHaveClass('md:bar-left:rotate-180');
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

  it('drags the window and ends in its controls on top; on a side they move to a half-height strip of their own', () => {
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
    // on a side: the strip across the top, and only then; it lets presses through to the picture
    expect(strip).toContainElement(onSide);
    expect(strip).toHaveClass('hidden', 'md:bar-side:flex', 'pointer-events-none', 'h-6');
    expect(strip).not.toHaveAttribute('data-tauri-drag-region');
    // half height on a side only: the top bar's buttons fill the bar
    for (const button of within(onSide).getAllByRole('button')) expect(button).toHaveClass('h-6');
    for (const button of within(onTop).getAllByRole('button')) expect(button).not.toHaveClass('h-6');
    // a right bar starts below the strip's controls, which share its edge; a left bar is clear of them
    expect(bar).toHaveClass('md:bar-right:pt-9');
    expect(bar).not.toHaveClass('md:bar-left:pt-11');
    // the session's own buttons are still all there
    expect(screen.getByRole('button', { name: /end session/i })).toBeInTheDocument();
  });

  describe('closing the window', () => {
    let close: jest.Mock;
    beforeEach(() => {
      close = jest.fn(() => Promise.resolve());
      const appWindow = { close, isMaximized: () => Promise.resolve(false), onResized: () => Promise.resolve(() => {}) };
      (window as { __TAURI__?: unknown }).__TAURI__ = { window: { getCurrentWindow: () => appWindow } };
    });
    afterEach(() => {
      delete (window as { __TAURI__?: unknown }).__TAURI__;
    });

    const renderAt = (state: SwoopSessionState, retryIn: number | null) =>
      render(
        <TooltipProvider>
          <SwoopToolbar
            session={null}
            machineId="TEC-B4A"
            state={state}
            error={null}
            retryIn={retryIn}
            onEnd={() => {}}
            onReconnect={() => {}}
            statsOpen={false}
            onToggleStats={() => {}}
          />
        </TooltipProvider>,
      );

    it.each([
      ['connecting', 'connecting', null],
      ['connected', 'connected', null],
      ['counting down to a reconnect after an end', 'ended', 7],
      ['counting down to a reconnect after a failure', 'error', 3],
    ] as const)('asks first while the session holds a seat: %s', async (_case, state, retryIn) => {
      as(app('Windows NT 10.0; Win64; x64'));
      const user = userEvent.setup();
      renderAt(state, retryIn);
      // the bar's own controls and the side bar's strip both ask
      for (const controls of screen.getAllByTestId('window-controls')) {
        await user.click(within(controls).getByRole('button', { name: 'close' }));
        expect(screen.getByRole('dialog')).toHaveTextContent('leave TEC-B4A and close the window?');
        await user.click(screen.getByRole('button', { name: 'cancel' }));
      }
      expect(close).not.toHaveBeenCalled();
    });

    it.each([
      ['idle', null],
      ['authorizing', null],
      ['ended', null],
      ['error', null],
    ] as const)('closes at once with no seat held: %s', async (state, retryIn) => {
      as(app('Windows NT 10.0; Win64; x64'));
      const user = userEvent.setup();
      renderAt(state, retryIn);
      const [onTop] = screen.getAllByTestId('window-controls');
      await user.click(within(onTop).getByRole('button', { name: 'close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(close).toHaveBeenCalledTimes(1);
    });
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
    return { fullscreen: screen.getByRole('button', { name: 'fullscreen with keyboard capture' }), requestFullscreen };
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

  describe('the mouse in fullscreen', () => {
    const lockable = () => {
      const requestPointerLock = jest.fn(() => Promise.resolve(true));
      mockInputCapture = { requestPointerLock, exitPointerLock: jest.fn() };
      return requestPointerLock;
    };

    it('leaves the mouse free unless capture is on, so the pointer follows it as in a window', async () => {
      const requestPointerLock = lockable();
      const { fullscreen, requestFullscreen } = renderLive();
      await userEvent.click(fullscreen);
      await act(async () => {});
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(requestPointerLock).not.toHaveBeenCalled();
    });

    it('with the toggle on, captures it too, and keeps the choice', async () => {
      const requestPointerLock = lockable();
      const { fullscreen } = renderLive();
      const toggle = screen.getByRole('button', { name: 'capture the mouse in fullscreen' });
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await userEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      expect(localStorage.getItem('owlette.swoop.mouseCapture')).toBe('on');
      await userEvent.click(fullscreen);
      await act(async () => {});
      expect(requestPointerLock).toHaveBeenCalledTimes(1);
    });

    it('offers no toggle in the mac app, which never captures the mouse', () => {
      as(app('Macintosh; Intel Mac OS X 10_15_7'));
      renderLive();
      expect(screen.queryByRole('button', { name: 'capture the mouse in fullscreen' })).toBeNull();
    });

    it('offers the toggle in the windows app, where pointer lock exists', () => {
      as(app('Windows NT 10.0; Win64; x64'));
      renderLive();
      expect(screen.getByRole('button', { name: 'capture the mouse in fullscreen' })).toBeInTheDocument();
    });

    it('says the mouse is captured too, on the fullscreen button, once the toggle is on', async () => {
      renderLive();
      await userEvent.click(screen.getByRole('button', { name: 'capture the mouse in fullscreen' }));
      expect(screen.getByRole('button', { name: 'fullscreen with keyboard and mouse capture' })).toBeInTheDocument();
    });

    it('offers no toggle to a view-only session, which sends no mouse to capture', () => {
      const stage = document.createElement('div');
      render(
        <TooltipProvider delayDuration={0}>
          <SwoopToolbar
            session={{ ctl: false, stage } as unknown as SwoopSession}
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
      expect(screen.queryByRole('button', { name: 'capture the mouse in fullscreen' })).toBeNull();
    });
  });
});

/**
 * a pill lights while its viewer moves the pointer, its edge and its pointer
 * cyan: from the host's `vpos` for anyone else, and from this tab's own capture
 * for its own. it fills in while this tab clicks; nothing the host sends says
 * when anyone else's button is down.
 */
describe('SwoopToolbar while people move the pointer', () => {
  const fetchMock = jest.fn();
  let channels: Map<string, (data: unknown) => void>;
  let ownInput: ((kind: 'move' | 'press') => void) | null = null;
  let detachers: Array<() => void> = [];

  beforeEach(() => {
    jest.useFakeTimers();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          viewers: [
            { viewerId: 'viewer-ada', uid: 'uid_ada', displayName: 'Ada Lovelace' },
            { viewerId: 'viewer-me', uid: 'uid_me', displayName: 'Bob Watcher' },
          ],
        },
      }),
    });
  });
  afterEach(() => {
    for (const detach of detachers) detach();
    detachers = [];
    ownInput = null;
    jest.useRealTimers();
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
    fetchMock.mockReset();
  });

  /** a live session with ada in control beside this tab, which controls too; its own moves are the test's to send. */
  function renderLive() {
    channels = new Map();
    const session = {
      siteId: 'site-a',
      machineId: 'TEC-B4A',
      sid: 'sid-lit',
      viewerId: 'viewer-me',
      ctl: true,
      stage: document.createElement('div'),
      onChannelMessage: (label: string, incoming: (data: unknown) => void) => {
        channels.set(label, incoming);
        return () => channels.delete(label);
      },
    } as unknown as SwoopSession;
    const capture = {
      onPointerInput: (listener: (kind: 'move' | 'press') => void) => {
        ownInput = listener;
        return () => {
          ownInput = null;
        };
      },
    };
    detachers.push(attachActivity(session, capture), attachPresence(session));
    render(
      <TooltipProvider delayDuration={0}>
        <SwoopToolbar
          session={session}
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
    const roster = [
      { id: 'viewer-ada', name: 'uid_ada', ctl: true },
      { id: 'viewer-me', name: 'uid_me', ctl: true },
    ];
    act(() => channels.get('swoop-control')?.(JSON.stringify({ t: 'roster', viewers: roster, tsUs: 1 })));
  }

  const adaMoves = () =>
    act(() => channels.get('swoop-cursor')?.(JSON.stringify({ t: 'vpos', viewer: 'viewer-ada', x: 0.5, y: 0.5, tsUs: 1 })));

  it("lights the pill of someone else moving the pointer, on a side bar's turned pill too, and says so", async () => {
    renderLive();
    // the names land first: waiting runs the clock that puts a light out
    await screen.findByRole('button', { name: 'Ada L.' });

    adaMoves();
    const ada = screen.getByRole('button', { name: 'Ada L., moving' });
    expect(ada).toHaveClass('border-accent-cyan', 'md:bar-side:[writing-mode:vertical-rl]');
    expect(ada).not.toHaveClass('bg-accent-cyan/20');
    expect(ada.querySelector('svg')).toHaveClass('text-accent-cyan');
    expect(screen.getByRole('button', { name: 'Bob W. (you)' })).not.toHaveClass('border-accent-cyan');

    act(() => jest.advanceTimersByTime(ACTIVITY_MOVE_MS));
    const resting = screen.getByRole('button', { name: 'Ada L.' });
    expect(resting).not.toHaveClass('border-accent-cyan');
    // back in the tint her pointer has on the picture
    expect(resting.querySelector('svg')).toHaveClass(tintOf('viewer-ada'));
    expect(resting.querySelector('svg')).not.toHaveClass('text-accent-cyan');
  });

  it("fills your own pill while you click, its pointer in the pill's ink, and lights it while you move", async () => {
    renderLive();
    await screen.findByRole('button', { name: 'Bob W. (you)' });

    act(() => ownInput?.('move'));
    expect(screen.getByRole('button', { name: 'Bob W. (you), moving' })).toHaveClass('border-accent-cyan');

    act(() => ownInput?.('press'));
    const clicking = screen.getByRole('button', { name: 'Bob W. (you), clicking' });
    expect(clicking).toHaveClass('border-accent-cyan', 'bg-accent-cyan/20');
    expect(clicking.querySelector('svg')).toHaveClass('text-foreground');
    expect(clicking.querySelector('svg')).not.toHaveClass('text-accent-cyan');

    // the click goes out first, and the move it came with after it
    act(() => jest.advanceTimersByTime(ACTIVITY_CLICK_MS));
    expect(screen.getByRole('button', { name: 'Bob W. (you), moving' })).not.toHaveClass('bg-accent-cyan/20');
    act(() => jest.advanceTimersByTime(ACTIVITY_MOVE_MS - ACTIVITY_CLICK_MS));
    expect(screen.getByRole('button', { name: 'Bob W. (you)' })).not.toHaveClass('border-accent-cyan');
  });

  it("lights the rows in a phone's list the same way, and says so to a screen reader there", async () => {
    narrowWindow();
    renderLive();
    // opened at once, so the first wait is the one for the names, which then land inside it
    fireEvent.click(screen.getByRole('button', { name: '2 in this session' }));
    const list = screen.getByRole('list', { name: 'in this session' });
    await within(list).findByText('Ada Lovelace');
    expect(within(list).queryByRole('img')).toBeNull();

    adaMoves();
    act(() => ownInput?.('press'));
    const moving = within(list).getByRole('img', { name: 'moving' });
    expect(moving).toHaveClass('text-accent-cyan');
    expect(moving.closest('li')).not.toHaveClass('bg-accent-cyan/20');
    const clicking = within(list).getByRole('img', { name: 'clicking' });
    expect(clicking).toHaveClass('text-foreground');
    expect(clicking.closest('li')).toHaveClass('bg-accent-cyan/20');

    act(() => jest.advanceTimersByTime(ACTIVITY_MOVE_MS));
    expect(within(list).queryByRole('img')).toBeNull();
  });
});
