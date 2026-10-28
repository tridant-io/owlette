'use client';

/**
 * the session bar: the way back to the dashboard, the machine's name, a badge
 * only when something is wrong, the one gesture that takes fullscreen and
 * keyboard lock together (and pointer lock, when the mouse-capture toggle beside
 * it is on), and whatever menus the page hands it as children. every button is
 * an icon with a tooltip; the bar stays clean.
 *
 * **the locks ride one click, and the order is fixed.** keyboard lock is only
 * granted in js-initiated fullscreen, so fullscreen must be awaited first;
 * pointer lock and fullscreen both need the same transient activation, so they
 * cannot be split across two clicks without the second one being refused. the
 * mouse is left free unless the toggle says otherwise (`lib/swoop/mouseCapture.ts`):
 * captured, the pointer is the machine's, a round trip behind every move.
 *
 * keyboard lock is chromium-only. firefox and safari have no `navigator.keyboard`
 * at all, and there is nothing to fall back to — so the tooltip says so plainly
 * rather than letting alt+tab and ctrl+w quietly stay with the browser. escape
 * held for two seconds leaves fullscreen in every browser, keyboard lock or not,
 * and that is the exit that always works.
 *
 * the fullscreen target is the STAGE, not the page: input capture binds there
 * and the picture should be every pixel. the bar is off screen while fullscreen
 * holds, which is why the stage carries its own click-to-recapture hint, and
 * why the toggle is set before going fullscreen.
 *
 * on a side (from md up, marked as `data-swoop-bar` on <html> before first
 * paint, see `lib/swoop/barPosition.ts`) the bar is a narrow column: the name and
 * the badges run vertically, the buttons stack at the bottom, and a notice
 * that is a sentence becomes an icon that says it on hover. the name reads
 * toward the picture: up a left bar, down a right one.
 *
 * below `md` (a phone, a narrow window) the buttons don't fit one row, and a
 * touch screen of any width has no hover to ask a tooltip with, so there one
 * button opens them all in a menu, each with its label under it, and a notice
 * is an icon; the row never wraps. fullscreen is left out where the browser
 * has none for a page (an iphone), rather than refusing every tap.
 *
 * inside owlette swoop the bar is also the window's title bar: it drags the
 * window, and on top it ends in the window's controls (on macos it starts
 * after the traffic lights instead). on a side, the controls move to a slim
 * strip across the top of the window that holds nothing else, so they cover as
 * little of the picture as they can.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ArrowLeft, Ellipsis, Eye, Gauge, Info, Maximize, Minimize, Mouse, PowerOff, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SwoopBarMenuPlacement, menuPlacementFor } from '@/components/swoop/barMenuPlacement';
import { BarTooltip, SwoopBarInMenu } from '@/components/swoop/BarTooltip';
import {
  SwoopWindowControls,
  SwoopWindowStrip,
  TRAFFIC_LIGHTS_INSET_PX,
  dragRegion,
} from '@/components/swoop/SwoopWindowControls';
import type { SwoopBarPosition } from '@/lib/swoop/barPosition';
import { swoopClipboard } from '@/lib/swoop/clipboard';
import { cn } from '@/lib/utils';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { hasKeyboardLock, keyboardLock } from '@/lib/swoop/keyboardLock';
import { readMouseCapture, setMouseCapture, subscribeMouseCapture } from '@/lib/swoop/mouseCapture';
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';
import { useViewerAppNativeKeys, useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import { useSwoopCompactBar } from '@/hooks/useSwoopCompactBar';
const subscribeNever = (): (() => void) => () => {};
const mouseFree = (): boolean => false;

// an iphone has no element fullscreen at all, only a video's own player
const canFullscreen = (): boolean => typeof Element.prototype.requestFullscreen === 'function';
const fullscreenOnServer = (): boolean => true;

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

/** before attach, and on the server: nothing to say. */
const hostReadsUnknown = (): boolean => true;
const nothingHeld = (): boolean => false;

/** vertical text on a side bar, turned so it reads toward the picture. */
const VERTICAL = 'md:bar-side:[writing-mode:vertical-rl] md:bar-left:rotate-180';

/** a sentence in a wide top bar; on a side or a phone, an icon that says it on hover or tap. */
function Notice({ text, testId }: { text: string; testId?: string }) {
  return (
    <>
      <span className="hidden text-xs text-muted-foreground md:inline md:bar-side:hidden" data-testid={testId}>
        {text}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={text} className="shrink-0 md:hidden md:bar-side:inline-flex">
            <Info aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-xs">{text}</p>
        </TooltipContent>
      </Tooltip>
    </>
  );
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
  /** where the bar is, for which way its menus and tooltips open. the layout
   *  itself follows `data-swoop-bar`, which is right from first paint. */
  position?: SwoopBarPosition;
  /** the bar itself, where the page sends keyboard focus off the stage. */
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

export function SwoopToolbar({
  ref,
  session,
  machineId,
  state,
  stats,
  retryIn,
  onEnd,
  onReconnect,
  statsOpen,
  onToggleStats,
  position = 'top',
  children,
}: SwoopToolbarProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const clipboard = swoopClipboard(session);
  const hostReads = useSyncExternalStore(
    clipboard ? clipboard.subscribe : subscribeNever,
    clipboard ? clipboard.get : hostReadsUnknown,
    hostReadsUnknown,
  );
  const clipboardHeld = useSyncExternalStore(
    clipboard ? clipboard.subscribe : subscribeNever,
    clipboard ? clipboard.held : nothingHeld,
    nothingHeld,
  );
  // a capability probe, not state: the server has no `navigator`, so it renders
  // the supported case and hydration corrects it once, without a second render
  // pass on every browser that does support it.
  const lockSupported = useSyncExternalStore(subscribeNever, hasKeyboardLock, () => true);
  const nativeKeys = useViewerAppNativeKeys();
  // null in a browser, where the bar is only the session's
  const platform = useViewerAppPlatform();
  const mouseCapture = useSyncExternalStore(subscribeMouseCapture, readMouseCapture, mouseFree);
  const compact = useSwoopCompactBar();
  // the menu closes when stats opens, which sits where the menu was
  const [menuOpen, setMenuOpen] = useState(false);
  const fullscreenAvailable = useSyncExternalStore(subscribeNever, canFullscreen, fullscreenOnServer);
  const viewOnly = session !== null && !session.ctl;

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
    if (!capture || !readMouseCapture()) return;
    if (!(await capture.requestPointerLock())) {
      setNotice('the mouse could not be captured; pointer positions stay absolute.');
    }
  }, [session]);

  const live = state === 'connected' && session !== null;
  const badge = badgeFor(state, stats, retryIn);
  // a picture that kept freezing leaves its session up, and a new one is the operator's call.
  const frozen = stats?.stall.recovery === 'frozen';
  const reconnectButton = (
    <BarTooltip label="reconnect">
      <Button variant="ghost" size="icon-sm" aria-label="reconnect" onClick={onReconnect}>
        <RotateCcw aria-hidden />
      </Button>
    </BarTooltip>
  );

  // one set of controls, mounted once: in the bar from `md` up with a mouse, in its menu otherwise
  const controls = (
    <>
      {children}

      <BarTooltip label="stats">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="latency stats"
          aria-pressed={statsOpen}
          onClick={() => {
            onToggleStats();
            setMenuOpen(false);
          }}
        >
          <Gauge aria-hidden />
        </Button>
      </BarTooltip>

      {/* set before going fullscreen, where the bar is off screen. a mac's
          owlette swoop has no pointer lock at all (adr 0012), a view-only
          session sends no mouse to capture, a touch screen has none, and
          without fullscreen there is nothing for it to apply to. */}
      {fullscreenAvailable && platform !== 'mac' && !viewOnly && (
        <BarTooltip
          short="mouse"
          className="pointer-coarse:hidden"
          label={
            <p className="max-w-xs">
              {mouseCapture
                ? 'fullscreen captures the mouse, for games and 3D views that turn with it. click to leave it free.'
                : 'capture the mouse in fullscreen, for games and 3D views that turn with it. left free, your pointer moves the moment you do.'}
            </p>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="capture the mouse in fullscreen"
            aria-pressed={mouseCapture}
            onClick={() => setMouseCapture(!mouseCapture)}
          >
            <Mouse aria-hidden />
          </Button>
        </BarTooltip>
      )}

      {/* keyboard lock is chromium-only and brave ships with it off: the
          tooltip says which case this browser is, and the keyboard menu
          covers the rest either way. owlette swoop captures keys itself. */}
      {fullscreenAvailable && (
        <BarTooltip
          short={fullscreen ? 'exit fullscreen' : 'fullscreen'}
          label={
            <p className="max-w-xs">
              {fullscreen
                ? 'exit fullscreen'
                : nativeKeys
                  ? `fullscreen: the app hands every shortcut it can to the machine; hold esc to come back.${platform === 'mac' ? ' cmd+tab stays on this mac.' : ''}`
                  : lockSupported
                    ? `fullscreen captures the keyboard${mouseCapture ? ' and mouse' : ''}: shortcuts like alt+tab go to the machine.`
                    : `${mouseCapture ? 'fullscreen captures the mouse; ' : 'in fullscreen '}this browser keeps its own shortcuts (alt+tab, ctrl+w). the keyboard menu sends those.`}
            </p>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!live}
            aria-label={fullscreen ? 'exit fullscreen' : `fullscreen with keyboard${mouseCapture ? ' and mouse' : ''} capture`}
            onClick={() => void engage()}
          >
            {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
          </Button>
        </BarTooltip>
      )}

      {/* an ended or failed session has nothing left to end: the way on is
          another one, or the way back. */}
      {state === 'ended' || state === 'error' ? (
        reconnectButton
      ) : (
        <>
          {frozen && reconnectButton}
          <BarTooltip label="end session">
            <Button variant="ghost-destructive" size="icon-sm" aria-label="end session" onClick={onEnd}>
              <PowerOff aria-hidden />
            </Button>
          </BarTooltip>
        </>
      )}
    </>
  );

  return (
    <SwoopBarMenuPlacement.Provider value={menuPlacementFor(position)}>
      <div
        ref={ref}
        data-testid="session-bar"
        {...(platform ? dragRegion : {})}
        className={cn(
          // the same 48 px as the picker's header, so the two bars line up window to window
          // the bottom rule is an inset shadow, not a border: the box stays exactly 48 px, so
          // every icon's centre is the bar's centre (a border would add its own pixel below)
          'flex min-h-12 flex-wrap items-center gap-2 max-md:flex-nowrap bg-card px-3 py-2 shadow-[inset_0_-1px_0_0_var(--border)] md:bar-side:min-h-0 md:bar-side:shadow-none',
          // in the app a session opens in the picker's window, whose header (on windows and
          // linux; a mac's picker has none) has the bar's height and tone: the bar stays put
          // and only what is on it fades in
          platform && '[&>*]:motion-safe:animate-in [&>*]:fade-in-0 [&>*]:animation-duration-300',
          'md:bar-side:w-11 md:bar-side:shrink-0 md:bar-side:flex-col md:bar-side:flex-nowrap md:bar-side:border-b-0',
          'md:bar-side:px-0 md:bar-side:py-3 md:bar-left:border-r md:bar-right:border-l',
          // a side bar starts below the strip's controls on the edge they share
          platform === 'mac' && 'md:bar-left:pt-11',
          (platform === 'windows' || platform === 'linux') && 'md:bar-right:pt-11',
        )}
      >
        {platform === 'mac' && (
          <span
            aria-hidden
            data-testid="traffic-lights-inset"
            className="-ml-3 shrink-0 self-stretch md:bar-side:hidden"
            style={{ width: TRAFFIC_LIGHTS_INSET_PX }}
          />
        )}
        {/* the way out in every state, a refused or failed session included.
            leaving unmounts the page, which ends a live session properly.
            inside the owlette swoop desktop app the way back is its picker. */}
        <BarTooltip label={platform ? 'back to machines' : 'back to dashboard'}>
          <Button asChild variant="ghost" size="icon-sm">
            <Link
              href={platform ? '/swoop' : '/dashboard'}
              aria-label={platform ? 'back to machines' : 'back to dashboard'}
            >
              <ArrowLeft aria-hidden />
            </Link>
          </Button>
        </BarTooltip>

        <span
          className={cn('min-w-0 truncate text-sm font-medium text-foreground md:bar-side:min-h-0', VERTICAL)}
          title={machineId}
        >
          {machineId}
        </span>

        {badge && (
          <Badge variant={badge.tone} data-testid="session-badge" className={cn('shrink-0', VERTICAL)}>
            {badge.label}
          </Badge>
        )}

        {session && !session.ctl && (
          <Badge variant="outline" className={cn('shrink-0', VERTICAL)}>
            <Eye aria-hidden />
            view only
          </Badge>
        )}

        {notice && <Notice text={notice} />}
        {!hostReads && (
          <Notice
            text="the machine's clipboard is not shared: on a mac, allow owlette under paste from other apps in system settings"
            testId="clipboard-notice"
          />
        )}
        {clipboardHeld && (
          <Notice
            text="your browser held back the machine's copy: click the picture to take it, or allow the clipboard for this site"
            testId="clipboard-held-notice"
          />
        )}

        {!compact ? (
          <div className="ml-auto flex items-center gap-1 md:bar-side:ml-0 md:bar-side:mt-auto md:bar-side:flex-col">
            {controls}
          </div>
        ) : (
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            {/* no tooltip: a tap focuses the button, and the tooltip it raised sat over the menu it opened */}
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="session controls"
                className="ml-auto md:bar-side:ml-0 md:bar-side:mt-auto"
              >
                <Ellipsis aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              {...menuPlacementFor(position)}
              align="end"
              className="w-auto max-w-[calc(100vw-1rem)] p-2"
              // the phone keyboard took focus from the menu, and handing it back would close the keyboard
              onCloseAutoFocus={(event) => {
                if (session?.stage.contains(document.activeElement)) event.preventDefault();
              }}
            >
              <SwoopBarInMenu.Provider value>
                <div className="grid grid-cols-4 gap-1">{controls}</div>
              </SwoopBarInMenu.Provider>
            </PopoverContent>
          </Popover>
        )}

        <SwoopWindowControls className="-my-2 -mr-3 self-stretch md:bar-side:hidden" />
        {/* fixed to the window, so it takes no room in the bar */}
        <SwoopWindowStrip className="hidden md:bar-side:flex" />
      </div>
    </SwoopBarMenuPlacement.Provider>
  );
}
