/// <reference types="@testing-library/jest-dom" />
/**
 * @jest-environment jsdom
 *
 * owlette swoop's windows have no native frame, so the page draws the window's
 * controls (dev/active/swoop-viewer, task 2.9): windows and linux get three
 * buttons that drive the window through the app's bridge, macos keeps its
 * traffic lights and gets only their room, and a browser gets nothing.
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  SwoopWindowControls,
  SwoopWindowStrip,
  TRAFFIC_LIGHTS_INSET_PX,
} from '@/components/swoop/SwoopWindowControls';

const TOKEN = 'owlette-swoop-viewer/4.1.8';
const WINDOWS_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0 ${TOKEN}`;
const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ${TOKEN}`;
const LINUX_APP = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15 ${TOKEN}`;
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

type TauriHolder = { __TAURI__?: unknown };

/** a stand-in for the app's `window.__TAURI__`, recording what the page asks of its window. */
function fakeBridge(initiallyMaximized = false) {
  let maximized = initiallyMaximized;
  let onResized: (() => void) | null = null;
  const unlisten = jest.fn();
  const appWindow = {
    minimize: jest.fn(() => Promise.resolve()),
    toggleMaximize: jest.fn(() => Promise.resolve()),
    close: jest.fn(() => Promise.resolve()),
    isMaximized: jest.fn(() => Promise.resolve(maximized)),
    onResized: jest.fn((handler: () => void) => {
      onResized = handler;
      return Promise.resolve(unlisten);
    }),
  };
  (window as TauriHolder).__TAURI__ = { window: { getCurrentWindow: () => appWindow } };
  return {
    appWindow,
    unlisten,
    /** the os maximized or restored the window, as tauri reports it. */
    resize(nowMaximized: boolean) {
      maximized = nowMaximized;
      onResized?.();
    },
  };
}

const as = (ua: string) => jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  delete (window as TauriHolder).__TAURI__;
});

describe('SwoopWindowControls', () => {
  it('draws nothing in a browser', () => {
    as(BROWSER);
    fakeBridge();
    render(
      <>
        <SwoopWindowControls />
        <SwoopWindowStrip />
      </>,
    );
    expect(screen.queryByTestId('window-controls')).toBeNull();
    expect(screen.queryByTestId('swoop-window-strip')).toBeNull();
  });

  it.each([
    ['windows', WINDOWS_APP],
    ['linux', LINUX_APP],
  ])('on %s, minimizes, maximizes and closes the window through the bridge', async (_os, ua) => {
    as(ua);
    const { appWindow } = fakeBridge();
    const user = userEvent.setup();
    render(<SwoopWindowControls />);

    await user.click(screen.getByRole('button', { name: 'minimize' }));
    await user.click(screen.getByRole('button', { name: 'maximize' }));
    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(appWindow.minimize).toHaveBeenCalledTimes(1);
    expect(appWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(appWindow.close).toHaveBeenCalledTimes(1);
    // outside a session close asks nothing
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fills its row by default, and with half takes 24 px at the top of it', () => {
    as(WINDOWS_APP);
    fakeBridge();
    render(<SwoopWindowControls className="self-stretch" />);
    expect(screen.getByTestId('window-controls')).toHaveClass('items-stretch', 'self-stretch');
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('w-[46px]');
      expect(button).not.toHaveClass('h-6');
    }
    cleanup();

    render(<SwoopWindowControls half />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('h-6', 'w-[46px]');
    }
  });

  it('asks before it closes while the page holds a seat in a session, and cancel keeps the window', async () => {
    as(WINDOWS_APP);
    const { appWindow } = fakeBridge();
    const user = userEvent.setup();
    render(<SwoopWindowControls leaving="TEC-B4A" />);

    await user.click(screen.getByRole('button', { name: 'close' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('leave TEC-B4A and close the window?');
    expect(dialog).toHaveTextContent('you leave the session. anyone else in it stays connected.');
    await user.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // escape is a cancel too
    await user.click(screen.getByRole('button', { name: 'close' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(appWindow.close).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'close' }));
    await user.click(screen.getByTestId('window-close-confirm'));
    expect(appWindow.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('swaps maximize for restore as the window reports its size, and stops listening when gone', async () => {
    as(WINDOWS_APP);
    const bridge = fakeBridge();
    const { unmount } = render(<SwoopWindowControls />);
    expect(await screen.findByRole('button', { name: 'maximize' })).toBeInTheDocument();

    await act(async () => bridge.resize(true));
    expect(screen.getByRole('button', { name: 'restore' })).toHaveAttribute('data-maximized', 'true');
    await act(async () => bridge.resize(false));
    expect(screen.getByRole('button', { name: 'maximize' })).not.toHaveAttribute('data-maximized');

    unmount();
    expect(bridge.unlisten).toHaveBeenCalledTimes(1);
  });

  it('opens on restore when the window is already maximized', async () => {
    as(WINDOWS_APP);
    fakeBridge(true);
    render(<SwoopWindowControls />);
    expect(await screen.findByRole('button', { name: 'restore' })).toBeInTheDocument();
  });

  it('stays inert without the bridge, or when the bridge throws', async () => {
    as(WINDOWS_APP);
    const user = userEvent.setup();
    render(<SwoopWindowControls />);
    for (const name of ['minimize', 'maximize', 'close']) {
      await user.click(screen.getByRole('button', { name }));
    }
    cleanup();

    (window as TauriHolder).__TAURI__ = {
      window: {
        getCurrentWindow: () => {
          throw new Error('no tauri internals');
        },
      },
    };
    render(<SwoopWindowControls />);
    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.getByRole('button', { name: 'maximize' })).toBeInTheDocument();
  });

  it('on macos draws no buttons and leaves the traffic lights their room', () => {
    as(MAC_APP);
    fakeBridge();
    render(
      <>
        <SwoopWindowControls />
        <SwoopWindowStrip />
      </>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    const strip = screen.getByTestId('swoop-window-strip');
    const inset = strip.firstElementChild as HTMLElement;
    expect(inset).toHaveStyle({ width: `${TRAFFIC_LIGHTS_INSET_PX}px` });
    expect(inset).toHaveAttribute('data-tauri-drag-region', 'deep');
  });

  it('on macos keeps the strip only the traffic lights’ room, half or not', () => {
    as(MAC_APP);
    fakeBridge();
    render(<SwoopWindowStrip half />);
    const strip = screen.getByTestId('swoop-window-strip');
    expect(strip).toHaveClass('pointer-events-none', 'h-8');
    expect(strip).not.toHaveClass('h-6');
    expect(strip.children).toHaveLength(1);
  });
});

describe('SwoopWindowStrip', () => {
  it('lets presses through everywhere but the controls and a short drag handle beside them', () => {
    as(WINDOWS_APP);
    fakeBridge();
    render(<SwoopWindowStrip />);

    const strip = screen.getByTestId('swoop-window-strip');
    expect(strip).toHaveClass('pointer-events-none', 'fixed', 'top-0', 'justify-end');
    const handle = screen.getByTestId('swoop-window-drag');
    expect(handle).toHaveClass('pointer-events-auto', 'w-40');
    expect(handle).toHaveAttribute('data-tauri-drag-region', 'deep');
    expect(screen.getByTestId('window-controls')).toHaveClass('pointer-events-auto');
    // the strip holds nothing else
    expect(strip.children).toHaveLength(2);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'minimize',
      'maximize',
      'close',
    ]);
  });

  it.each([
    ['windows', WINDOWS_APP],
    ['linux', LINUX_APP],
  ])('at half height on %s, is 24 px with its controls, and still lets presses through', (_os, ua) => {
    as(ua);
    fakeBridge();
    render(<SwoopWindowStrip half />);

    const strip = screen.getByTestId('swoop-window-strip');
    expect(strip).toHaveClass('pointer-events-none', 'fixed', 'inset-x-0', 'top-0', 'h-6', 'justify-end');
    expect(strip).not.toHaveClass('h-8');
    expect(strip).not.toHaveAttribute('data-tauri-drag-region');
    expect(screen.getByTestId('swoop-window-drag')).toHaveClass('pointer-events-auto', 'w-40');
    for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('h-6');
  });

  it('passes the session it holds a seat in to its close', async () => {
    as(WINDOWS_APP);
    const { appWindow } = fakeBridge();
    const user = userEvent.setup();
    render(<SwoopWindowStrip half leaving="TEC-B4A" />);
    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('leave TEC-B4A and close the window?');
    expect(appWindow.close).not.toHaveBeenCalled();
  });
});
