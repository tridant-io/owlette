'use client';

/**
 * the window's own controls inside owlette swoop, whose windows have no native
 * frame (`desktop/viewer/src/windows.rs`): the page's top bar is the title bar.
 * on windows and linux three buttons sit at its right end, drawn the way
 * windows draws them; on macos the system's traffic lights float over the
 * page's top left and the page only leaves them room.
 *
 * the buttons reach the window through `window.__TAURI__` (the app's global
 * api), which the app grants owlette.app for exactly these calls
 * (`desktop/viewer/capabilities/owlette-pages.json`). in a browser there is no
 * app and nothing here renders; with the app but no bridge the buttons are inert.
 */

import { useCallback, useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import { cn } from '@/lib/utils';
import { closeViewerWindow, currentViewerWindow } from '@/lib/swoop/viewerWindow';

/** room for the traffic lights at the top left of a macos window with an overlay title bar. */
export const TRAFFIC_LIGHTS_INSET_PX = 78;

/**
 * spread on a bar to make it the window's drag surface. `deep`: a press on
 * anything inside it that is not a button, link, input or other control drags
 * the window, and a double press maximizes it (tauri's drag script). an
 * attribute the browser ignores, so callers add it in the app only.
 */
export const dragRegion = { 'data-tauri-drag-region': 'deep' } as const;

const BUTTON =
  'inline-flex w-[46px] cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none';

/** minimize, maximize or restore, and close, on windows and linux; nothing on macos or in a browser. */
export function SwoopWindowControls({ className }: { className?: string }) {
  const platform = useViewerAppPlatform();
  const drawn = platform === 'windows' || platform === 'linux';
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!drawn) return;
    const appWindow = currentViewerWindow();
    if (!appWindow) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      appWindow.isMaximized().then(
        (value) => {
          if (!disposed) setMaximized(value);
        },
        () => {},
      );
    };
    sync();
    // maximize, restore, snap and a double press on the bar all arrive as a resize
    appWindow.onResized(sync).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      () => {},
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [drawn]);

  const minimize = useCallback(() => void currentViewerWindow()?.minimize().catch(() => {}), []);
  const toggle = useCallback(() => void currentViewerWindow()?.toggleMaximize().catch(() => {}), []);
  const close = useCallback(() => void closeViewerWindow(), []);

  if (!drawn) return null;
  return (
    <div data-testid="window-controls" className={cn('flex shrink-0 items-stretch', className)}>
      <button
        type="button"
        aria-label="minimize"
        data-testid="window-minimize"
        className={cn(BUTTON, 'hover:bg-accent focus-visible:bg-accent')}
        onClick={minimize}
      >
        <Minus aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'restore' : 'maximize'}
        data-testid="window-maximize"
        data-maximized={maximized || undefined}
        className={cn(BUTTON, 'hover:bg-accent focus-visible:bg-accent')}
        onClick={toggle}
      >
        {maximized ? <Copy aria-hidden className="size-3.5 -scale-x-100" /> : <Square aria-hidden className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="close"
        data-testid="window-close"
        className={cn(
          BUTTON,
          'hover:bg-danger-solid hover:text-danger-solid-foreground focus-visible:bg-danger-solid focus-visible:text-danger-solid-foreground',
        )}
        onClick={close}
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/**
 * the window's controls where no bar runs along the top: a slim strip across
 * the top of the window holding only the controls, with a short drag handle
 * beside them. the strip lets every other press through to what is under it,
 * so a picture there stays the machine's. on macos the traffic lights are the
 * system's, so the strip is only their room. nothing in a browser.
 */
export function SwoopWindowStrip({ className }: { className?: string }) {
  const platform = useViewerAppPlatform();
  if (!platform) return null;
  return (
    <div
      data-testid="swoop-window-strip"
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-40 flex h-8',
        platform === 'mac' ? 'justify-start' : 'justify-end',
        className,
      )}
    >
      {platform === 'mac' ? (
        <div {...dragRegion} className="pointer-events-auto" style={{ width: TRAFFIC_LIGHTS_INSET_PX }} />
      ) : (
        <>
          <div {...dragRegion} data-testid="swoop-window-drag" className="pointer-events-auto w-40" />
          <SwoopWindowControls className="pointer-events-auto bg-background/60 backdrop-blur-sm" />
        </>
      )}
    </div>
  );
}
