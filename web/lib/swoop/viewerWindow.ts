/**
 * the owlette swoop window this page is in. the main window holds the picker
 * and takes a session in place; a session the app opens beside it (the
 * picker's "open in new window", or one the main window was busy for) gets a
 * window of its own labelled `swoop-*` (`desktop/viewer/src/windows.rs`).
 *
 * read through the app's bridge, `window.__TAURI__`, as the title bar does
 * (`SwoopWindowControls`): in a browser, on the server, or with the bridge
 * missing, there is no window, and nothing here throws.
 */

const SESSION_WINDOW_PREFIX = 'swoop-';

/** the slice of tauri's `Window` the pages call; every method is in the app's grant to owlette.app. */
export interface ViewerWindow {
  label: string;
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

type TauriGlobal = { window?: { getCurrentWindow?: () => ViewerWindow } };

/** this window, or null with no bridge; `getCurrentWindow` throws when the app's internals are missing. */
export function currentViewerWindow(): ViewerWindow | null {
  try {
    return (window as { __TAURI__?: TauriGlobal }).__TAURI__?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
}

/** this window's label in the app (`main`, `swoop-<site>/<machine>`); null outside it. */
export function currentViewerWindowLabel(): string | null {
  const label = currentViewerWindow()?.label;
  return typeof label === 'string' ? label : null;
}

/** a session's own window, which has no picker to go back to. */
export function isSessionWindow(): boolean {
  return currentViewerWindowLabel()?.startsWith(SESSION_WINDOW_PREFIX) ?? false;
}

/**
 * asks the app to close this window; the app's close handshake still runs.
 * false when there is no window to close.
 */
export function closeViewerWindow(): boolean {
  const appWindow = currentViewerWindow();
  if (!appWindow) return false;
  appWindow.close().catch(() => {});
  return true;
}
