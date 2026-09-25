'use client';

/**
 * the session bar: the machine's name, a badge only when something is wrong,
 * the one gesture that takes fullscreen, keyboard lock and pointer lock
 * together, and whatever menus the page hands it as children. every button is
 * an icon with a tooltip; the bar stays clean.
 *
 * **all three locks ride one click, and the order is fixed.** keyboard lock is
 * only granted in js-initiated fullscreen, so fullscreen must be awaited first;
 * pointer lock and fullscreen both need the same transient activation, so they
 * cannot be split across two clicks without the second one being refused.
 *
 * keyboard lock is chromium-only. firefox and safari have no `navigator.keyboard`
 * at all, and there is nothing to fall back to — so the tooltip says so plainly
 * rather than letting alt+tab and ctrl+w quietly stay with the browser. escape
 * held for two seconds leaves fullscreen in every browser, keyboard lock or not,
 * and that is the exit that always works.
 *
 * the fullscreen target is the STAGE, not the page: input capture binds there
 * and the picture should be every pixel. the bar is off screen while fullscreen
 * holds, which is why the stage carries its own click-to-recapture hint.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Eye, Gauge, Maximize, Minimize, PowerOff, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { hasKeyboardLock, keyboardLock } from '@/lib/swoop/keyboardLock';
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';
const subscribeNever = (): (() => void) => () => {};

/** an app-level round trip above this, or a delay rise above it, is a poor connection. */
const POOR_RTT_US = 150_000;
const POOR_DELAY_RISE_US = 100_000;

/**
 * what is worth a badge: nothing while things are fine. "connected" is a
 * given, the picture says it.
 */
function badgeFor(
  state: SwoopSessionState,
  stats: SwoopStats | null | undefined,
  retryIn: number | null | undefined,
): { label: string; tone: 'destructive' | 'secondary' } | null {
  if (state === 'error') return { label: 'disconnected', tone: 'destructive' };
  if (state === 'ended') {
    return retryIn === null || retryIn === undefined
      ? { label: 'disconnected', tone: 'destructive' }
      : { label: `reconnecting in ${retryIn} s`, tone: 'secondary' };
  }
  if (state !== 'connected' || !stats) return null;
  if (stats.signal === 'reconnecting') return { label: 'poor connection', tone: 'secondary' };
  const feedback = stats.feedback;
  if (feedback && ((feedback.rttUs ?? 0) > POOR_RTT_US || (feedback.delayRiseUs ?? 0) > POOR_DELAY_RISE_US)) {
    return { label: 'poor connection', tone: 'secondary' };
  }
  return null;
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
  /** the session's numbers, read for the poor-connection badge. */
  stats?: SwoopStats | null;
  /** seconds until the next reconnect attempt, while one is scheduled. */
  retryIn?: number | null;
  onEnd: () => void;
  /** a fresh session to the same machine, offered in the ended and failed states. */
  onReconnect: () => void;
  /** whether the latency overlay is showing; the page owns the flag. */
  statsOpen: boolean;
  onToggleStats: () => void;
  children?: React.ReactNode;
}

export function SwoopToolbar({
  session,
  machineId,
  state,
  stats,
  retryIn,
  onEnd,
  onReconnect,
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
  const badge = badgeFor(state, stats, retryIn);

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
      <span className="truncate text-sm font-medium text-foreground" title={machineId}>
        {machineId}
      </span>

      {badge && (
        <Badge variant={badge.tone} data-testid="session-badge">
          {badge.label}
        </Badge>
      )}

      {session && !session.ctl && (
        <Badge variant="outline">
          <Eye aria-hidden />
          view only
        </Badge>
      )}

      {notice && <span className="text-xs text-muted-foreground">{notice}</span>}

      <div className="ml-auto flex items-center gap-1">
        {children}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={statsOpen ? 'hide latency stats' : 'show latency stats'}
              aria-pressed={statsOpen}
              onClick={onToggleStats}
            >
              <Gauge aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>latency stats</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!live}
              aria-label={fullscreen ? 'exit fullscreen' : 'fullscreen with keyboard and mouse capture'}
              onClick={() => void engage()}
            >
              {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
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

        {/* swoop runs in its own tab, so the only way on from an ended or failed
            session is another one; "end" has nothing left to end there. */}
        {state === 'ended' || state === 'error' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="reconnect" onClick={onReconnect}>
                <RotateCcw aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>reconnect</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-destructive" size="icon-sm" aria-label="end session" onClick={onEnd}>
                <PowerOff aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>end session</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
