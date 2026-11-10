'use client';

/**
 * the session bar: the way back to the dashboard, the machine's name, who is
 * in the session, a badge only when something is wrong, the one gesture that
 * takes fullscreen and keyboard lock together (and pointer lock, when the
 * mouse-capture toggle beside it is on), and whatever menus the page hands it
 * as children. every control is an icon with a tooltip; the bar stays clean.
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
 * paint, see `lib/swoop/barPosition.ts`) the bar is a narrow column: the name,
 * the viewers and the badges run vertically, and the buttons stack at the
 * bottom. the name reads toward the picture: up a left bar, down a right one.
 *
 * a notice is a warning icon that says its sentence on hover, on every layout,
 * since a sentence beside the pills took the bar's room (owner, 2026-11-05).
 *
 * below `md` (a phone, a narrow window) the buttons don't fit one row, and a
 * touch screen of any width has no hover to ask a tooltip with, so there one
 * button opens them all in a menu, each with its label under it, and the
 * viewers are one button with their count; the row never wraps. fullscreen is
 * left out where the browser has none for a page (an iphone), rather than
 * refusing every tap.
 *
 * inside owlette swoop the bar is also the window's title bar: it drags the
 * window, and on top it ends in the window's controls (on macos it starts
 * after the traffic lights instead). on a side, the controls move to a slim
 * strip across the top of the window that holds nothing else, at half height,
 * so they cover as little of the picture as they can and the picture keeps
 * the window's full height. while a session holds a seat, their close asks
 * first.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Ellipsis,
  Eye,
  Gauge,
  Maximize,
  Minimize,
  Mouse,
  MousePointer2,
  PowerOff,
  RotateCcw,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SwoopBarMenuPlacement, menuPlacementFor, useBarMenuPlacement } from '@/components/swoop/barMenuPlacement';
import { BarTooltip, SwoopBarInMenu } from '@/components/swoop/BarTooltip';
import { tintOf } from '@/components/swoop/SwoopPresence';
import {
  SwoopWindowControls,
  SwoopWindowStrip,
  TRAFFIC_LIGHTS_INSET_PX,
  dragRegion,
} from '@/components/swoop/SwoopWindowControls';
import type { SwoopViewerActivity } from '@/lib/swoop/activity';
import type { SwoopBarPosition } from '@/lib/swoop/barPosition';
import { swoopClipboard } from '@/lib/swoop/clipboard';
import { cn } from '@/lib/utils';
import { swoopInputCapture, type SwoopSession } from '@/lib/swoop/features';
import { kickSwoopViewer } from '@/lib/swoop/kick';
import { hasKeyboardLock, keyboardLock } from '@/lib/swoop/keyboardLock';
import { readMouseCapture, setMouseCapture, subscribeMouseCapture } from '@/lib/swoop/mouseCapture';
import type { SwoopSessionState, SwoopStats } from '@/hooks/useSwoopSession';
import { useViewerAppNativeKeys, useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import { useSwoopCompactBar } from '@/hooks/useSwoopCompactBar';
import { useSwoopViewerNames, type SwoopNamedViewer } from '@/hooks/useSwoopViewerNames';
import { useSwoopViewerActivity } from '@/hooks/useSwoopViewerActivity';
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
  // a failed start on a path that may come back is `error` with a retry, like a lost session
  if (state === 'ended' || state === 'error') {
    return retryIn === null || retryIn === undefined
      ? { label: 'disconnected', tone: 'destructive' }
      : { label: `reconnecting in ${retryIn} s`, tone: 'secondary' };
  }
  if (state !== 'connected' || !stats) return null;
  // the round trip below is the last one measured, so this comes first.
  if (!stats.linkUp) return { label: 'connection lost', tone: 'destructive' };
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

/**
 * a pill's icon on a side bar: the pill's text is turned to read toward the
 * picture, but an arrow has a direction of its own. writing-mode leaves an svg
 * upright, so only a left bar's half turn is undone.
 */
const UPRIGHT = 'md:bar-left:rotate-180';

/** behind a viewer while they click: a pill's fill, or a row's in the phone's list. */
const CLICK_FILL = 'bg-accent-cyan/20';

/**
 * a warning the bar has for you: one icon on every layout, its sentence on
 * hover, and in a popover on a click or a tap, since a touch screen has no
 * hover to ask with (the pills work the same way). a sentence on the bar
 * beside the pills took the bar's room. the tooltip and the popover are
 * portaled, so they read across even from a side bar whose text runs down.
 */
function Notice({ text, testId }: { text: string; testId?: string }) {
  const placement = useBarMenuPlacement();
  return (
    <Popover>
      <BarTooltip label={<p className="max-w-xs">{text}</p>}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={text} data-testid={testId} className="shrink-0">
            {/* on the glyph, where the ghost variant's hover ink does not reach */}
            <TriangleAlert aria-hidden className="text-warning" />
          </Button>
        </PopoverTrigger>
      </BarTooltip>
      <PopoverContent {...placement} className="w-auto max-w-xs p-3 text-sm">
        {text}
      </PopoverContent>
    </Popover>
  );
}

/**
 * a pointer for one in control, an eye for one who only watches, in the tint
 * their pointer has on the picture; cyan while they move it, and in the
 * pill's own ink on its fill while they click.
 */
function ViewerIcon({
  viewer,
  activity,
  className,
}: {
  viewer: SwoopNamedViewer;
  activity: SwoopViewerActivity;
  className?: string;
}) {
  // our own pointer is the real one, drawn in no tint
  const resting = viewer.you ? 'text-foreground' : tintOf(viewer.id);
  const tint = cn(
    activity === 'moving' ? 'text-accent-cyan' : activity === 'clicking' ? 'text-foreground' : resting,
    className,
  );
  if (!viewer.ctl) return <Eye role="img" aria-label="view only" className={tint} />;
  // the phone's list names no row, so there a lit pointer says it to a screen reader
  return activity === 'idle' ? (
    <MousePointer2 aria-hidden className={tint} />
  ) : (
    <MousePointer2 role="img" aria-label={activity} className={tint} />
  );
}

/** a viewer in full: the name, the email where the session route sent one, and kick where it is offered. */
function ViewerLines({ viewer, muted, onKick }: { viewer: SwoopNamedViewer; muted: string; onKick?: () => void }) {
  return (
    <span className="flex min-w-0 flex-col wrap-anywhere">
      <span>
        {viewer.full}
        {viewer.you && ' (you)'}
      </span>
      {viewer.email && viewer.email !== viewer.full && <span className={cn('text-xs', muted)}>{viewer.email}</span>}
      {onKick && (
        <Button type="button" variant="ghost-destructive" size="sm" className="self-start" onClick={onKick}>
          kick
        </Button>
      )}
    </span>
  );
}

/**
 * who is in the session, beside the machine's name: a pill per viewer, this
 * tab's own marked "(you)", hovering one names them in full. the session route
 * sends an email to a site owner or admin only, and the pill shows what it was
 * sent. a pill's edge turns cyan while its viewer moves the pointer, and it
 * fills in while they click: only this tab's own clicks, as nothing the host
 * sends says when anyone else's button is down.
 *
 * clicking a pill opens its menu: the same lines, and kick where the session
 * route says this caller may. a kick asks first, then ends the session for
 * everyone in it: the one it was for stops, and everyone else, this tab
 * included, comes back on their own, so their pill goes when the roster does.
 *
 * a compact bar has no room for a row of them and a touch screen no hover, so
 * there one button with the count opens the same list, kick and all. a pill is
 * a button so that pressing it never drags owlette swoop's window, whose title
 * bar this is.
 */
function ViewerPills({ session, compact }: { session: SwoopSession | null; compact: boolean }) {
  const viewers = useSwoopViewerNames(session);
  const activities = useSwoopViewerActivity(session);
  const placement = useBarMenuPlacement();
  const [kicking, setKicking] = useState<SwoopNamedViewer | null>(null);
  const [busy, setBusy] = useState(false);
  const [kickError, setKickError] = useState<string | null>(null);
  if (viewers.length === 0) return null;
  const activityOf = (viewer: SwoopNamedViewer): SwoopViewerActivity => activities.get(viewer.id) ?? 'idle';
  const kickOf = (viewer: SwoopNamedViewer) =>
    viewer.kickable
      ? () => {
          setKickError(null);
          setKicking(viewer);
        }
      : undefined;

  const kick = async (viewer: SwoopNamedViewer) => {
    if (!session) return;
    setBusy(true);
    try {
      await kickSwoopViewer(session, viewer.id);
      setKicking(null);
    } catch (err) {
      setKickError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // no toast once it lands: this tab's own page sees the bye and comes back, and fullscreen would hide one
  const confirm = (
    <Dialog
      open={kicking !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setKicking(null);
      }}
    >
      {kicking && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>kick {kicking.full}?</DialogTitle>
            <DialogDescription>
              they leave the session now and can rejoin. to keep someone out, change their swoop mode in the
              site&apos;s members section.
            </DialogDescription>
            {kickError && (
              <p role="alert" className="text-sm text-destructive">
                {kickError}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKicking(null)} disabled={busy}>
              cancel
            </Button>
            <Button variant="destructive" onClick={() => void kick(kicking)} disabled={busy}>
              {busy ? 'kicking...' : 'kick'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );

  if (compact) {
    return (
      <>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`${viewers.length} in this session`} className="gap-0.5">
              <Users aria-hidden />
              <span className="text-xs tabular-nums">{viewers.length}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent {...placement} align="start" className="w-auto max-w-[calc(100vw-1rem)] p-3">
            <ul aria-label="in this session" className="space-y-2 text-sm">
              {viewers.map((viewer) => (
                <li
                  key={viewer.id}
                  // the fill reaches into the popover's padding, so it clears the text and the row stays put
                  className={cn('-mx-1 flex items-start gap-2 rounded-sm px-1', activityOf(viewer) === 'clicking' && CLICK_FILL)}
                >
                  <ViewerIcon viewer={viewer} activity={activityOf(viewer)} className="mt-0.5 size-4 shrink-0" />
                  <ViewerLines viewer={viewer} muted="text-muted-foreground" onKick={kickOf(viewer)} />
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        {confirm}
      </>
    );
  }

  return (
    <>
      <ul aria-label="in this session" className="flex shrink-0 items-center gap-1 md:bar-side:flex-col">
        {viewers.map((viewer) => {
          const activity = activityOf(viewer);
          return (
            <li key={viewer.id} className="flex">
              {/* every pill opens its menu, kickable or not: a laptop's touch screen gets this
                  bar, and a tap there has no hover to read the full name with. kick is in the
                  menu, never the tooltip, which takes no clicks. */}
              <Popover>
                <BarTooltip
                  // the light tooltip is inverse ink, so its muted line comes from the tooltip's own ink
                  label={<ViewerLines viewer={viewer} muted="text-tooltip-foreground/70 dark:text-muted-foreground" />}
                >
                  <PopoverTrigger asChild>
                    <Badge
                      asChild
                      variant="outline"
                      className={cn(
                        'cursor-pointer',
                        VERTICAL,
                        activity !== 'idle' && 'border-accent-cyan',
                        activity === 'clicking' && CLICK_FILL,
                      )}
                    >
                      <button
                        type="button"
                        // what it shows, and what its eye and its light say on screen
                        aria-label={`${viewer.short}${viewer.you ? ' (you)' : ''}${viewer.ctl ? '' : ', view only'}${activity === 'idle' ? '' : `, ${activity}`}`}
                      >
                        <ViewerIcon viewer={viewer} activity={activity} className={UPRIGHT} />
                        {viewer.short}
                        {viewer.you && ' (you)'}
                      </button>
                    </Badge>
                  </PopoverTrigger>
                </BarTooltip>
                <PopoverContent
                  {...placement}
                  align="start"
                  data-testid="viewer-menu"
                  className="w-auto max-w-[calc(100vw-1rem)] p-3 text-sm"
                >
                  <ViewerLines viewer={viewer} muted="text-muted-foreground" onKick={kickOf(viewer)} />
                </PopoverContent>
              </Popover>
            </li>
          );
        })}
      </ul>
      {confirm}
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
      setNotice('fullscreen was refused, so shortcuts like alt+tab still go to your browser.');
      return;
    }

    const kb = keyboardLock();
    if (kb) {
      // every capturable key: a remote desktop wants alt+tab and ctrl+w too.
      await kb.lock().catch(() => setNotice('the keyboard could not be captured: shortcuts like alt+tab still go to your browser.'));
    }
    stage.focus();

    const capture = swoopInputCapture(session);
    if (!capture || !readMouseCapture()) return;
    if (!(await capture.requestPointerLock())) {
      setNotice('the mouse could not be captured: the pointer is not locked to the picture.');
    }
  }, [session]);

  const live = state === 'connected' && session !== null;
  // a seat is held from the grant (connecting) until the session is over; a countdown to a reconnect is not over
  const leaving = state === 'connecting' || state === 'connected' || typeof retryIn === 'number' ? machineId : null;
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
          (platform === 'windows' || platform === 'linux') && 'md:bar-right:pt-9',
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

        {/* keyed to this tab's seat: a kick asked about one session's viewer is not carried into the next */}
        <ViewerPills key={session?.viewerId} session={session} compact={compact} />

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
            text="the machine cannot share its clipboard. on a mac, allow owlette under system settings, privacy & security, paste from other apps."
            testId="clipboard-notice"
          />
        )}
        {clipboardHeld && (
          <Notice
            text="the machine copied something, but this browser will not take it yet: click the picture to paste it into your clipboard, or allow clipboard access for this site."
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

        <SwoopWindowControls leaving={leaving} className="-my-2 -mr-3 self-stretch md:bar-side:hidden" />
        {/* fixed to the window, so it takes no room in the bar */}
        <SwoopWindowStrip half leaving={leaving} className="hidden md:bar-side:flex" />
      </div>
    </SwoopBarMenuPlacement.Provider>
  );
}
