/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * the viewer page inside owlette swoop when the session is over (task 2.11b):
 * a moment after "session ended" the main window goes back to the picker and a
 * session's own window closes. a session counting down to a reconnect, a
 * refusal or a failure stays where it is, and so does the page in a browser.
 * the session hook is a stand-in, so each state is set directly.
 */

import { createRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';
import SwoopPage from '@/app/swoop/[siteId]/[machineId]/page';

const APP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 owlette-swoop-viewer/4.1.8';
const ENDED_RETURN_MS = 800;

// stable, as the app router's is: a new router each render would restart the wait.
const mockRouter = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() };
jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mfaFactors: { totp: true, passkeys: 0 }, isSiteAdmin: () => false }),
}));

jest.mock('@/hooks/useFirestore', () => ({
  useMachines: () => ({ machines: [], loading: false, error: null }),
}));

const mockView: { state: SwoopSessionState; retryIn: number | null; error: string | null } = {
  state: 'connected',
  retryIn: null,
  error: null,
};
const mockStats = {
  signal: 'open',
  feedback: null,
  frame: null,
  leaseExpiresAt: 0,
  stall: { recovery: 'none', episodes: 0, kind: null },
} as unknown as SwoopStats;
const mockVideoRef = createRef<HTMLVideoElement>();
const mockStageRef = createRef<HTMLDivElement>();
const mockStepUp = { required: false, enrolled: true, submitProof: jest.fn(), cancel: jest.fn() };
jest.mock('@/hooks/useSwoopSession', () => ({
  useSwoopSession: () => ({
    ...mockView,
    refusal: null,
    stats: mockStats,
    session: null,
    videoRef: mockVideoRef,
    stageRef: mockStageRef,
    stepUp: mockStepUp,
    end: jest.fn(),
    reconnect: jest.fn(),
    noPath: null,
  }),
}));

type TauriHolder = { __TAURI__?: unknown };

/** the app's `window.__TAURI__` on a window with this label, as far as the page uses it. */
function fakeBridge(label: string) {
  const close = jest.fn(() => Promise.resolve());
  const appWindow = {
    label,
    close,
    minimize: jest.fn(() => Promise.resolve()),
    toggleMaximize: jest.fn(() => Promise.resolve()),
    isMaximized: jest.fn(() => Promise.resolve(false)),
    onResized: jest.fn(() => Promise.resolve(() => {})),
  };
  (window as TauriHolder).__TAURI__ = { window: { getCurrentWindow: () => appWindow } };
  return close;
}

let params: Promise<{ siteId: string; machineId: string }>;
const page = () => (
  <TooltipProvider>
    <SwoopPage params={params} />
  </TooltipProvider>
);

/** the viewer, connected, with fake timers from here on. */
async function openViewer() {
  params = Promise.resolve({ siteId: 'site-1', machineId: 'machine-1' });
  const view = await act(async () => render(page()));
  jest.useFakeTimers();
  return view;
}

function moveTo(view: ReturnType<typeof render>, next: Partial<typeof mockView>) {
  Object.assign(mockView, next);
  act(() => view.rerender(page()));
}

const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));

beforeEach(() => {
  Object.assign(mockView, { state: 'connected', retryIn: null, error: null });
  mockRouter.replace.mockClear();
  jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete (window as TauriHolder).__TAURI__;
});

it('inside owlette swoop, the main window goes back to the picker a moment after the session ends', async () => {
  const close = fakeBridge('main');
  const view = await openViewer();
  moveTo(view, { state: 'ended' });
  // "session ended" is seen first
  expect(screen.getByRole('alert')).toHaveTextContent('session ended');
  wait(ENDED_RETURN_MS - 1);
  expect(mockRouter.replace).not.toHaveBeenCalled();
  wait(1);
  expect(mockRouter.replace).toHaveBeenCalledWith('/swoop');
  expect(mockRouter.replace).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
});

it("a session's own window closes instead, since it has no picker to go back to", async () => {
  const close = fakeBridge('swoop-site-1/machine-1');
  const view = await openViewer();
  moveTo(view, { state: 'ended', error: 'this session was ended from elsewhere.' });
  wait(ENDED_RETURN_MS);
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('a refusal before any picture keeps its notice: no picture ran, nothing is over', async () => {
  Object.assign(mockView, { state: 'connecting' });
  const close = fakeBridge('main');
  const view = await openViewer();
  moveTo(view, { state: 'ended', error: "you're on this machine." });
  expect(screen.getByRole('alert')).toHaveTextContent("you're on this machine.");
  wait(5000);
  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeInTheDocument();
});

it('stays while the session counts down to a reconnect', async () => {
  fakeBridge('main');
  const view = await openViewer();
  moveTo(view, { state: 'ended', retryIn: 3 });
  wait(5000);
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('a refusal or failure keeps its notice and the way back', async () => {
  const close = fakeBridge('swoop-site-1/machine-1');
  const view = await openViewer();
  moveTo(view, { state: 'error', error: 'this machine did not answer.' });
  wait(5000);
  expect(screen.getByRole('alert')).toHaveTextContent('this machine did not answer.');
  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it('a reconnect inside the moment, or leaving the page, calls the return off', async () => {
  fakeBridge('main');
  const view = await openViewer();
  moveTo(view, { state: 'ended' });
  wait(ENDED_RETURN_MS / 2);
  moveTo(view, { state: 'connecting' });
  wait(ENDED_RETURN_MS);
  expect(mockRouter.replace).not.toHaveBeenCalled();

  moveTo(view, { state: 'ended' });
  view.unmount();
  wait(ENDED_RETURN_MS);
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('in a browser an ended session stays on the page', async () => {
  jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA.replace(' owlette-swoop-viewer/4.1.8', ''));
  const view = await openViewer();
  moveTo(view, { state: 'ended' });
  wait(5000);
  expect(screen.getByRole('alert')).toHaveTextContent('session ended');
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

/**
 * a disconnected session gives fullscreen back, in a browser and in the app
 * alike, and lets the pointer go: the notice and the way on are on the page,
 * not over the picture. jsdom has no fullscreen api, so the stage's fullscreen
 * and the two exits are stand-ins.
 */
describe('leaving fullscreen on a disconnect', () => {
  let exitFullscreen: jest.Mock;
  let exitPointerLock: jest.Mock;

  /** the page with its stage in fullscreen and the pointer locked to it. */
  async function openFullscreen() {
    const view = await openViewer();
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => mockStageRef.current });
    return view;
  }

  beforeEach(() => {
    exitFullscreen = jest.fn(() => Promise.resolve());
    exitPointerLock = jest.fn();
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
    Object.defineProperty(document, 'exitPointerLock', { configurable: true, value: exitPointerLock });
  });

  afterEach(() => {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    delete (document as { exitPointerLock?: unknown }).exitPointerLock;
  });

  it('inside owlette swoop, an ended session leaves fullscreen at once, before the return', async () => {
    fakeBridge('main');
    const view = await openFullscreen();
    moveTo(view, { state: 'ended' });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(exitPointerLock).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    wait(ENDED_RETURN_MS);
    expect(mockRouter.replace).toHaveBeenCalledWith('/swoop');
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('in a browser, a failure leaves fullscreen too', async () => {
    jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA.replace(' owlette-swoop-viewer/4.1.8', ''));
    const view = await openFullscreen();
    moveTo(view, { state: 'error', error: 'this machine did not answer.' });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(exitPointerLock).toHaveBeenCalledTimes(1);
  });

  it('a refused exit is ignored', async () => {
    exitFullscreen.mockImplementation(() => Promise.reject(new TypeError('not in fullscreen')));
    const view = await openFullscreen();
    moveTo(view, { state: 'ended' });
    await act(async () => {});
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('keeps fullscreen while the session counts down to a reconnect, ended or failed', async () => {
    const view = await openFullscreen();
    moveTo(view, { state: 'ended', retryIn: 3 });
    moveTo(view, { state: 'error', retryIn: 2 });
    moveTo(view, { state: 'connecting', retryIn: null });
    moveTo(view, { state: 'connected' });
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(exitPointerLock).not.toHaveBeenCalled();
  });

  it('does nothing when the stage is not in fullscreen', async () => {
    const view = await openViewer();
    moveTo(view, { state: 'ended' });
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(exitPointerLock).not.toHaveBeenCalled();
  });
});
