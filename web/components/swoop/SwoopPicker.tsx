'use client';

/**
 * the swoop picker (`/swoop`): a site's machines, and whether each one can be
 * watched from here. it is owlette swoop's home — the app opens on it — and a
 * plain page in a browser, beside the dashboard's machine menu.
 *
 * in a browser a card opens exactly what the dashboard's swoop entry opens: the
 * viewer in a tab of its own; a ready card also has a button in its corner that
 * opens the machine in owlette swoop, signed in as this browser is. inside the
 * app a card opens the session in this window, and a right-click or shift+enter
 * opens it in a new one, which the app turns into a swoop window.
 */

import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppWindow, ArrowLeft, Monitor } from 'lucide-react';
import { SwoopLockup } from '@/components/swoop/SwoopLockup';
import { useAuth } from '@/contexts/AuthContext';
import { useMachines, useSites, type Machine } from '@/hooks/useFirestore';
import { useSwoopSettings } from '@/hooks/useSwoopSettings';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { LoadingWord } from '@/components/LoadingWord';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SwoopWindowControls, TRAFFIC_LIGHTS_INSET_PX, dragRegion } from '@/components/swoop/SwoopWindowControls';
import { useViewerAppPlatform } from '@/hooks/useViewerAppPlatform';
import { openInViewerApp } from '@/lib/swoop/openViewerApp';
import { isThisMachine, subscribeThisMachine } from '@/lib/swoop/thisMachine';
import { cn } from '@/lib/utils';

// past this many machines the grid grows a filter, as the metrics panel's machine switcher does.
const FILTER_MIN = 8;

type CardState ='ready' | 'offline' | 'incapable' | 'site-off' | 'this-machine';

export function SwoopPicker() {
  const { user, loading, isSuperadmin, isSiteAdmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, userSites, isSuperadmin);
  // the dashboard's restore, so both open on the same site: the saved site from
  // firestore or this browser, else the first — derived rather than set from an
  // effect, and only once `useSites` has settled. a pick made here wins after that.
  const [chosenSiteId, setChosenSiteId] = useState<string | null>(null);
  const savedSiteId = useMemo(() => {
    if (sitesLoading || sites.length === 0) return '';
    const savedSite = lastSiteId || localStorage.getItem('owlette_current_site');
    return savedSite && sites.some((s) => s.id === savedSite) ? savedSite : sites[0].id;
  }, [sites, sitesLoading, lastSiteId]);
  const siteId = chosenSiteId && sites.some((s) => s.id === chosenSiteId) ? chosenSiteId : savedSiteId;
  const [filter, setFilter] = useState('');
  const { machines, loading: machinesLoading } = useMachines(siteId);
  const { settings: swoop, loading: swoopLoading } = useSwoopSettings(siteId);
  // the server renders the browser's page; the app's home has no dashboard to go back to,
  // and its header is the window's title bar.
  const platform = useViewerAppPlatform();
  const inApp = platform !== null;
  const router = useRouter();

  const handleSiteChange = (next: string) => {
    setChosenSiteId(next);
    setFilter('');
    updateLastSite(next);
  };

  const sorted = useMemo(
    () => [...machines].sort((a, b) =>
      Number(b.online) - Number(a.online)
      || a.machineId.localeCompare(b.machineId, undefined, { sensitivity: 'base' }),
    ),
    [machines],
  );
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? sorted.filter((m) => m.machineId.toLowerCase().includes(q)) : sorted;
  }, [sorted, filter]);

  const sessionPath = (machineId: string) =>
    `/swoop/${encodeURIComponent(siteId)}/${encodeURIComponent(machineId)}`;

  // identical to the dashboard's openSwoop: its own window, no token in the url.
  const openSwoopWindow = (machineId: string) => {
    window.open(sessionPath(machineId), '_blank', 'noopener');
  };

  // the app's window is the session's until it ends, then the picker's again.
  const openSwoopHere = (machineId: string) => {
    router.push(sessionPath(machineId));
  };

  const openInApp = (machineId: string) => openInViewerApp(siteId, machineId);

  let body: React.ReactNode;
  if (loading || (user && sitesLoading)) {
    body = <Notice><LoadingWord /></Notice>;
  } else if (!user) {
    body = null;
  } else if (sites.length === 0) {
    body = <Notice>you&apos;re not a member of any site yet</Notice>;
  } else if (machinesLoading || swoopLoading) {
    body = <Notice><LoadingWord /></Notice>;
  } else if (machines.length === 0) {
    body = <Notice>no machines in this site yet</Notice>;
  } else if (filtered.length === 0) {
    body = <Notice>no machines match</Notice>;
  } else {
    const canEnable = isSiteAdmin(siteId);
    body = (
      <ul data-testid="swoop-picker-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {filtered.map((machine) => (
          <PickerCard
            key={machine.machineId}
            siteId={siteId}
            machine={machine}
            siteSwoopOn={swoop.enabled}
            canEnable={canEnable}
            onOpen={inApp ? openSwoopHere : openSwoopWindow}
            onOpenInApp={inApp ? undefined : openInApp}
            onOpenNewWindow={inApp ? openSwoopWindow : undefined}
          />
        ))}
      </ul>
    );
  }

  return (
    <div data-testid="swoop-picker" className="min-h-screen bg-background">
      <header
        {...(inApp ? dragRegion : {})}
        // a title bar stays put while a long list scrolls
        // in the app the header wears the session bar's tone, so moving between the two is a
        // change of content, not a jump of colour
        className={cn('relative bg-background shadow-[inset_0_-1px_0_0_var(--border)]', inApp && 'sticky top-0 z-30 bg-card')}
        style={platform === 'mac' ? { paddingLeft: TRAFFIC_LIGHTS_INSET_PX } : undefined}
      >
        {/* a title bar keeps its mark in the corner, like the desktop app's; a web page centres it */}
        <div
          data-testid="swoop-picker-header-row"
          className={cn('flex h-12 items-center justify-between gap-3 px-4', !inApp && 'mx-auto max-w-6xl')}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <OwletteEyeIcon size={24} className="translate-y-[1px]" />
            <SwoopLockup className="translate-y-[1px]" />
          </div>
          {!inApp && (
            <Button asChild variant="ghost" size="sm">
              <Link href="/dashboard" data-testid="swoop-picker-dashboard-link">
                <ArrowLeft />
                dashboard
              </Link>
            </Button>
          )}
        </div>
        <SwoopWindowControls className="absolute inset-y-0 right-0" />
      </header>

      <main
        className={cn(
          'mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 md:py-6',
          // coming back from a session, the grid fades in rather than snapping
          inApp && 'motion-safe:animate-in fade-in-0 duration-300',
        )}
      >
        {sites.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={siteId} onValueChange={handleSiteChange}>
              <SelectTrigger data-testid="swoop-picker-site" aria-label="site" className="min-w-0 max-w-full">
                <SelectValue placeholder="choose a site" />
              </SelectTrigger>
              <SelectContent>
                {sites.map((site) => (
                  <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {machines.length > FILTER_MIN && (
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter machines…"
                aria-label="filter machines"
                className="h-9 min-w-0 flex-1 basis-40"
              />
            )}
          </div>
        )}
        {body}
      </main>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

function PickerCard({
  siteId,
  machine,
  siteSwoopOn,
  canEnable,
  onOpen,
  onOpenInApp,
  onOpenNewWindow,
}: {
  siteId: string;
  machine: Machine;
  siteSwoopOn: boolean;
  /** an owner or admin of the site, who can turn swoop on for it */
  canEnable: boolean;
  onOpen: (machineId: string) => void;
  /** a browser's way into owlette swoop; inside the app the card itself opens the session */
  onOpenInApp?: (machineId: string) => void;
  /** inside the app, the session in a swoop window of its own instead of this one */
  onOpenNewWindow?: (machineId: string) => void;
}) {
  const { machineId, online } = machine;
  const cardRef = useRef<HTMLButtonElement>(null);
  // where the right-click was, while its menu is open
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // the machine this browser runs on, once its streamer has said so
  const onThisMachine = useSyncExternalStore(
    subscribeThisMachine,
    () => isThisMachine(siteId, machineId),
    () => false,
  );
  const capable = machine.capabilities?.swoop === 1;
  const state: CardState = !online
    ? 'offline'
    : !capable
      ? 'incapable'
      : !siteSwoopOn
        ? 'site-off'
        : onThisMachine
          ? 'this-machine'
          : 'ready';
  const ready = state === 'ready';
  // as on the machine menu: a stale mirror never badges a machine that cannot stream.
  const watching = online && capable ? (machine.swoopViewers ?? 0) : 0;
  const reasonId = `swoop-picker-reason-${machineId}`;
  const openNewWindow = ready ? onOpenNewWindow : undefined;
  // a card that stops being ready drops its menu, so the menu cannot come back on its own
  if (!openNewWindow && menuAt) setMenuAt(null);

  return (
    // the card is a frame, not the button: a ready card's button fills it and the
    // app button in its corner is a sibling, so no button sits inside another.
    // focus shows as the app-wide outline, as on the dashboard's cards.
    <li className="relative flex flex-col rounded-lg border border-border bg-card">
      <button
        ref={cardRef}
        type="button"
        data-testid={`swoop-picker-machine-${machineId}`}
        disabled={!ready}
        aria-describedby={ready ? undefined : reasonId}
        title={openNewWindow ? 'right-click or shift+enter for a new window' : undefined}
        onClick={() => onOpen(machineId)}
        onContextMenu={
          openNewWindow
            ? (e) => {
                e.preventDefault();
                setMenuAt({ x: e.clientX, y: e.clientY });
              }
            : undefined
        }
        onKeyDown={
          openNewWindow
            ? (e) => {
                if (e.key !== 'Enter' || !e.shiftKey) return;
                // enter would also click the card, which opens it here
                e.preventDefault();
                openNewWindow(machineId);
              }
            : undefined
        }
        className={cn(
          'flex min-w-0 flex-col gap-0.5 rounded-[inherit] px-4 text-left transition-colors',
          ready ? 'flex-1 cursor-pointer py-3 hover:bg-accent' : 'cursor-not-allowed pt-3 pb-1',
          ready && onOpenInApp && 'pr-12',
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn('h-2 w-2 shrink-0 rounded-full', online ? 'bg-success' : 'bg-muted-foreground/40')}
          />
          <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', ready ? 'text-foreground' : 'text-muted-foreground')}>
            {machineId}
          </span>
          {watching > 0 && (
            <Badge className="tabular-nums">
              {watching}
              <span className="sr-only"> watching</span>
            </Badge>
          )}
        </span>
        <span className="block pl-4 text-xs text-muted-foreground">{machine.osFamily ?? 'windows'}</span>
      </button>
      {ready && onOpenInApp && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="open in the owlette swoop desktop app"
              data-testid={`swoop-picker-app-${machineId}`}
              onClick={() => onOpenInApp(machineId)}
              className="absolute right-1.5 top-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Monitor aria-hidden className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>open in the owlette swoop desktop app</p>
          </TooltipContent>
        </Tooltip>
      )}
      {openNewWindow && (
        <DropdownMenu open={menuAt !== null} onOpenChange={(open) => !open && setMenuAt(null)}>
          {/* the menu hangs from where the pointer was, not from a button of its own */}
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              className="pointer-events-none fixed size-0"
              style={{ left: menuAt?.x ?? 0, top: menuAt?.y ?? 0 }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={0}
            className="border-border bg-raised"
            // back to the card, not to the empty anchor
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              cardRef.current?.focus();
            }}
          >
            <DropdownMenuItem
              data-testid={`swoop-picker-new-window-${machineId}`}
              onSelect={() => openNewWindow(machineId)}
              className="cursor-pointer"
            >
              <AppWindow />
              open in new window
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!ready && (
        <p id={reasonId} data-testid={reasonId} className="pb-3 pl-8 pr-4 text-xs text-muted-foreground">
          <Reason state={state} siteId={siteId} canEnable={canEnable} />
        </p>
      )}
    </li>
  );
}

function Reason({ state, siteId, canEnable }: { state: CardState; siteId: string; canEnable: boolean }) {
  switch (state) {
    case 'offline':
      return <>offline</>;
    case 'incapable':
      return <>agent can&apos;t stream yet</>;
    case 'this-machine':
      return <>you&apos;re on this machine</>;
    case 'site-off':
      return (
        <>
          swoop is off for this site ·{' '}
          {canEnable ? (
            <Link href={`/dashboard?settings=${encodeURIComponent(siteId)}`} className="hl-link text-accent-cyan">
              open site settings
            </Link>
          ) : (
            'ask a site owner or admin to turn it on'
          )}
        </>
      );
    default:
      return null;
  }
}
