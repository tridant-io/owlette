'use client';

/**
 * the session bar: connection state, the one gesture that takes fullscreen,
 * keyboard lock and pointer lock together, and whatever menus the page hands it
 * as children.
 *
 * **all three locks ride one click, and the order is fixed.** keyboard lock is
 * only granted in js-initiated fullscreen, so fullscreen must be awaited first;
 * pointer lock and fullscreen both need the same transient activation, so they
 * cannot be split across two clicks without the second one being refused.
 *
 * keyboard lock is chromium-only. firefox and safari have no `navigator.keyboard`
 * at all, and there is nothing to fall back to — so the bar says so plainly
 * rather than letting alt+tab and ctrl+w quietly stay with the browser. escape
 * held for two seconds leaves fullscreen in every browser, keyboard lock or not,
 * and that is the exit that always works.
 *
 * the fullscreen target is the STAGE, not the page: input capture binds there
 * and the picture should be every pixel. the bar is off screen while fullscreen
 * holds, which is why the stage carries its own click-to-recapture hint.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Eye,
  Gauge,
  Loader2,
  Maximize,
  Minimize,
  PowerOff,
  TriangleAlert,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import type { SwoopSessionState } from '@/hooks/useSwoopSession';

/** `navigator.keyboard` is not in the dom lib; this is the half we use. */
interface KeyboardLock {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

const keyboardLock = (): KeyboardLock | null => {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
  return typeof api?.lock === 'function' ? api : null;
};

const hasKeyboardLock = (): boolean => keyboardLock() !== null;
const subscribeNever = (): (() => void) => () => {};

const STATE_LABEL: Record<SwoopSessionState, string> = {
  idle: 'idle',
  authorizing: 'authorizing',
  connecting: 'connecting',
  connected: 'connected',
  ended: 'ended',
  error: 'failed',
};

function StateIcon({ state }: { state: SwoopSessionState }) {
  if (state === 'connected') return <Wifi className="size-4 text-primary" aria-hidden />;
  if (state === 'error') return <TriangleAlert className="size-4 text-destructive" aria-hidden />;
  if (state === 'ended') return <WifiOff className="size-4 text-muted-foreground" aria-hidden />;
  return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />;
}

export interface SwoopToolbarProps {
  session: SwoopSession | null;
  /**
   * the machine this window is pointed at. passed rather than read off
   * `session`, which is null until the peer connects -- "connecting" is
   * precisely when you want to know which machine you are waiting on.
   */
  machineId: string;
  state: SwoopSessionState;
  error: string | null;
  onEnd: () => void;
  /** whether the latency overlay is showing; the page owns the flag. */
  statsOpen: boolean;
  onToggleStats: () => void;
  children?: React.ReactNode;
}

export function SwoopToolbar({
  session,
  machineId,
  state,
  onEnd,
  statsOpen,
  onToggleStats,
  children,
}: SwoopToolbarProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // a capability probe, not state: the server has no `navigator`, so it renders
  // the supported case and hydration corrects it once, without a second render
  // pass on every browser that does support it.
  const lockSupported = useSyncExternalStore(subscribeNever, hasKeyboardLock, () => true);

  useEffect(() => {
    const sync = () => {
      const on = document.fullscreenElement !== null;
      setFullscreen(on);
      // leaving fullscreen by any route — the escape hold included — must give
      // the browser its own shortcuts back.
      if (!on) keyboardLock()?.unlock();
    };
    document.addEventListener('fullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      keyboardLock()?.unlock();
    };
  }, []);

  const engage = useCallback(async () => {
    const stage = session?.stage;
    if (!stage) return;
    setNotice(null);

    if (document.fullscreenElement) {
      keyboardLock()?.unlock();
      swoopInputCapture(session)?.exitPointerLock();
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    try {
      await stage.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      setNotice('this browser refused fullscreen, so the keyboard stays with it.');
      return;
    }

    const kb = keyboardLock();
    if (kb) {
      // every capturable key: a remote desktop wants alt+tab and ctrl+w too.
      await kb.lock().catch(() => setNotice('the keyboard could not be captured.'));
    }
    stage.focus();

    const capture = swoopInputCapture(session);
    if (!capture) return;
    if (!(await capture.requestPointerLock())) {
      setNotice('the mouse could not be captured; pointer positions stay absolute.');
    }
  }, [session]);

  const live = state === 'connected' && session !== null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
      <span className="flex items-center gap-2 text-sm text-foreground">
        <StateIcon state={state} />
        {STATE_LABEL[state]}
      </span>

      <span className="truncate text-sm font-medium text-foreground" title={machineId}>
        {machineId}
      </span>

      {session && !session.ctl && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Eye className="size-3.5" aria-hidden />
          view only
        </span>
      )}

      {notice && <span className="text-xs text-muted-foreground">{notice}</span>}

      {/* the bar is off screen once fullscreen holds, so the way out is said here first. */}
      {live && (
        <span className="text-xs text-muted-foreground">hold esc for two seconds to exit</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {children}

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={statsOpen ? 'hide latency stats' : 'show latency stats'}
          aria-pressed={statsOpen}
          onClick={onToggleStats}
        >
          <Gauge aria-hidden />
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={!live}
              aria-label={fullscreen ? 'exit fullscreen' : 'fullscreen with keyboard and mouse capture'}
              onClick={() => void engage()}
            >
              {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
              {fullscreen ? 'exit fullscreen' : 'fullscreen'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {/* keyboard lock is chromium-only and brave ships with it off: the
                tooltip says which case this browser is, and the keyboard menu
                covers the rest either way. */}
            <p className="max-w-xs">
              {lockSupported
                ? 'fullscreen captures the keyboard and mouse: shortcuts like alt+tab go to the machine.'
                : 'fullscreen captures the mouse; this browser keeps its own shortcuts (alt+tab, ctrl+w). the keyboard menu sends those.'}
            </p>
          </TooltipContent>
        </Tooltip>

        <Button variant="destructive" size="sm" onClick={onEnd}>
          <PowerOff aria-hidden />
          end session
        </Button>
      </div>
    </div>
  );
}
