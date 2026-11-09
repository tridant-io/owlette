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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import { cn } from '@/lib/utils';
import { closeViewerWindow, currentViewerWindow } from '@/lib/swoop/viewerWindow';

/**
 * room for the traffic lights at the top left of a macos window with an overlay
 * title bar: 16 px in, where `TRAFFIC_LIGHTS` in desktop/viewer/src/windows.rs
 * lands them, three 16 px lights 23 px apart, then 8 px of air.
 */
export const TRAFFIC_LIGHTS_INSET_PX = 86;

/**
 * spread on a bar to make it the window's drag surface. `deep`: a press on
 * anything inside it that is not a button, link, input or other control drags
 * the window, and a double press maximizes it (tauri's drag script). an
 * attribute the browser ignores, so callers add it in the app only.
 */
export const dragRegion = { 'data-tauri-drag-region': 'deep' } as const;

const BUTTON =
  'inline-flex h-6 w-[46px] cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none';

/**
 * minimize, maximize or restore, and close, on windows and linux; nothing on
 * macos or in a browser. the buttons are half the bar's height and sit at its
 * top edge: the lower half of the bar is a band with nothing to hit, so they
 * stay clear of a remote fullscreen app's own buttons at the top of the
 * picture (owner, 2026-11-09). the band is plain bar, so it drags the window.
 *
 * `leaving` is the machine's name while this page holds a seat in a session:
 * close then asks first. alt+f4, the taskbar and the app's own close do not.
 */
export function SwoopWindowControls({ className, leaving }: { className?: string; leaving?: string | null }) {
  const platform = useViewerAppPlatform();
  const drawn = platform === 'windows' || platform === 'linux';
  const [maximized, setMaximized] = useState(false);
  // the name as it was when close was pressed: the dialog keeps it if the session ends meanwhile
  const [confirming, setConfirming] = useState<string | null>(null);

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
    <div data-testid="window-controls" className={cn('flex shrink-0 items-start', className)}>
      <button
        type="button"
        aria-label="minimize"
        data-testid="window-minimize"
        className={cn(BUTTON, 'hover:bg-accent focus-visible:bg-accent')}
        onClick={minimize}
      >
        <Minus aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'restore' : 'maximize'}
        data-testid="window-maximize"
        data-maximized={maximized || undefined}
        className={cn(BUTTON, 'hover:bg-accent focus-visible:bg-accent')}
        onClick={toggle}
      >
        {maximized ? <Copy aria-hidden className="size-3 -scale-x-100" /> : <Square aria-hidden className="size-3" />}
      </button>
      <button
        type="button"
        aria-label="close"
        data-testid="window-close"
        className={cn(
          BUTTON,
          'hover:bg-danger-solid hover:text-danger-solid-foreground focus-visible:bg-danger-solid focus-visible:text-danger-solid-foreground',
        )}
        onClick={leaving ? () => setConfirming(leaving) : close}
      >
        <X aria-hidden className="size-3.5" />
      </button>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        {confirming !== null && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>leave {confirming} and close the window?</DialogTitle>
              <DialogDescription>you leave the session. anyone else in it stays connected.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                cancel
              </Button>
              <Button
                variant="destructive"
                data-testid="window-close-confirm"
                onClick={() => {
                  setConfirming(null);
                  close();
                }}
              >
                close
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/**
 * the window's controls where no bar runs along the top. as a `titleRow` (the
 * session page with its bar on a side, on windows and linux) it is a slim
 * title row in the bar's tone across the top of the window, the controls at
 * its right end and every other press dragging the window; the page starts
 * below it, so none of the picture is under it. otherwise (the login page) it
 * holds only the controls and a short drag handle beside them, and lets every
 * other press through to what is under it. on macos the traffic lights are the
 * system's, so the strip is only their room. nothing in a browser.
 */
export function SwoopWindowStrip({
  className,
  titleRow = false,
  leaving,
}: {
  className?: string;
  titleRow?: boolean;
  leaving?: string | null;
}) {
  const platform = useViewerAppPlatform();
  if (!platform) return null;
  const row = titleRow && platform !== 'mac';
  return (
    <div
      data-testid="swoop-window-strip"
      {...(row ? dragRegion : {})}
      className={cn(
        'fixed inset-x-0 top-0 z-40 flex h-8',
        row ? 'pointer-events-auto bg-card shadow-[inset_0_-1px_0_0_var(--border)]' : 'pointer-events-none',
        platform === 'mac' ? 'justify-start' : 'justify-end',
        className,
      )}
    >
      {platform === 'mac' ? (
        <div {...dragRegion} className="pointer-events-auto" style={{ width: TRAFFIC_LIGHTS_INSET_PX }} />
      ) : row ? (
        <SwoopWindowControls leaving={leaving} />
      ) : (
        <>
          <div {...dragRegion} data-testid="swoop-window-drag" className="pointer-events-auto w-40" />
          <SwoopWindowControls leaving={leaving} className="pointer-events-auto bg-background/60 backdrop-blur-sm" />
        </>
      )}
    </div>
  );
}
