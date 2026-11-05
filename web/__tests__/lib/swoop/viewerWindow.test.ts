/**
 * the owlette swoop window a page is in (dev/active/swoop-viewer, task 2.11b):
 * its label, whether it is a session's own window, and closing it, all through
 * the app's bridge, and nothing in a browser.
 */

import { closeViewerWindow, currentViewerWindowLabel, isSessionWindow } from '@/lib/swoop/viewerWindow';

type TauriHolder = { __TAURI__?: unknown };

/** a stand-in for the app's `window.__TAURI__` on a window with this label. */
function fakeBridge(label: string, close = jest.fn(() => Promise.resolve())) {
  (window as TauriHolder).__TAURI__ = { window: { getCurrentWindow: () => ({ label, close }) } };
  return close;
}

afterEach(() => {
  delete (window as TauriHolder).__TAURI__;
});

describe('viewerWindow', () => {
  it('names the main window and a session window, and tells them apart', () => {
    fakeBridge('main');
    expect(currentViewerWindowLabel()).toBe('main');
    expect(isSessionWindow()).toBe(false);

    fakeBridge('swoop-site-1/B4A');
    expect(currentViewerWindowLabel()).toBe('swoop-site-1/B4A');
    expect(isSessionWindow()).toBe(true);
  });

  it('closes its own window through the bridge', () => {
    const close = fakeBridge('swoop-site-1/B4A');
    expect(closeViewerWindow()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('swallows a refused close', async () => {
    const close = fakeBridge('main', jest.fn(() => Promise.reject(new Error('not allowed'))));
    expect(closeViewerWindow()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    // node reports an unhandled rejection once the microtasks have drained, and
    // jest fails the running test on it (it takes the process's listeners for
    // the test's duration, so a listener here would hear nothing)
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('has no window in a browser', () => {
    expect(currentViewerWindowLabel()).toBeNull();
    expect(isSessionWindow()).toBe(false);
    expect(closeViewerWindow()).toBe(false);
  });

  it('has no window when the bridge is missing its internals', () => {
    (window as TauriHolder).__TAURI__ = {
      window: {
        getCurrentWindow: () => {
          throw new Error('window.__TAURI_INTERNALS__ is undefined');
        },
      },
    };
    expect(currentViewerWindowLabel()).toBeNull();
    expect(isSessionWindow()).toBe(false);
    expect(closeViewerWindow()).toBe(false);

    (window as TauriHolder).__TAURI__ = {};
    expect(currentViewerWindowLabel()).toBeNull();
    expect(closeViewerWindow()).toBe(false);
  });
});
