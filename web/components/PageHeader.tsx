'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { ArrowRight, ChevronDown, Settings, LogOut, Shield, Check, Crown, LayoutDashboard, Zap, Rocket, FolderSync, ScrollText, CircleHelp, Bug, BookOpen, Menu, X, SlidersHorizontal } from 'lucide-react';
import { getUserShortName } from '@/lib/userUtils';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { ReportBugDialog } from '@/components/ReportBugDialog';
import { HootIcon } from '@/components/icons/HootIcon';

const MENU_SURFACE = 'border-border bg-raised dark:bg-raised/85 backdrop-blur-sm shadow-2xl shadow-elevation-shadow ring-1 ring-elevation-ring';

/** between the breadcrumb's parts: a straight rule, not a slash glyph. */
const CRUMB_DIVIDER = <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-muted-foreground/60" />;

const FEEDBACK_LABELS = [
  'report a bug',
  'share feedback',
  'tell us how terrible we\'re doing',
  'yell into the void',
  'file a complaint',
  'it\'s not you, it\'s us',
  'we can take it',
];

/**
 * Primary page navigation. Rendered twice — by the desktop page-switcher
 * dropdown and by the mobile drawer — so the two can never drift apart.
 */
const NAV_ITEMS = [
  {
    name: 'dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    description: 'monitor machines and manage processes',
  },
  {
    name: 'hoot',
    href: '/hoot',
    icon: HootIcon,
    description: 'ask hoot about your machines',
  },
  {
    name: 'talons',
    href: '/talons',
    icon: Zap,
    description: 'watch schedules, events, and screens — then act',
  },
  {
    name: 'roost',
    href: '/roosts',
    icon: FolderSync,
    description: 'sync project files to your machines',
  },
  {
    name: 'deploy',
    href: '/deployments',
    icon: Rocket,
    description: 'install software across machines',
  },
  {
    name: 'logs',
    href: '/logs',
    icon: ScrollText,
    description: 'monitor events and system activities',
  },
] as const;

/** Icon shown beside the current page name, keyed by the lowercased page label. */
const PAGE_ICONS: Record<string, React.ElementType> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.name, item.icon]),
);

interface Site {
  id: string;
  name: string;
}

interface PageHeaderProps {
  currentPage: 'Dashboard' | 'Deploy' | 'Roost' | 'Logs' | 'Hoot' | 'Talons' | 'API Keys' | 'Webhooks' | 'dashboard' | 'deploy' | 'roost' | 'logs' | 'hoot' | 'talons' | 'api keys' | 'webhooks';
  sites?: Site[];
  currentSiteId?: string;
  onSiteChange?: (siteId: string) => void;
  onManageSites?: () => void;
  /** Opens the current site's editor. Shown to that site's admins only. */
  onSiteSettings?: () => void;
  actionButton?: React.ReactNode;
  onAccountSettings?: () => void;
  disableNav?: boolean;
}

export function PageHeader({
  currentPage,
  sites = [],
  currentSiteId,
  onSiteChange,
  onManageSites,
  onSiteSettings,
  actionButton,
  onAccountSettings,
  disableNav,
}: PageHeaderProps) {
  const router = useRouter();
  const { user, signOut, isSuperadmin, administersAnySite, isSiteAdmin } = useAuth();
  const [reportBugOpen, setReportBugOpen] = useState(false);
  const [feedbackLabel, setFeedbackLabel] = useState('report a bug');
  const [feedbackFading, setFeedbackFading] = useState(false);
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const [openMenuCount, setOpenMenuCount] = useState(0);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const feedbackIndex = useRef(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);

  const handleMenuOpenChange = (open: boolean) => {
    setOpenMenuCount((n) => Math.max(0, open ? n + 1 : n - 1));
  };

  // The rotating feedback label runs whenever a surface showing it is open —
  // the desktop help dropdown or the mobile drawer's help section.
  const feedbackRotating = helpMenuOpen || navDrawerOpen;

  // Drawer dismissal: Escape, plus crossing up into the `md` breakpoint. The
  // drawer is `md:hidden`, so without the media listener a drawer left open on
  // a resized-wide window would silently reappear on the way back down.
  useEffect(() => {
    if (!navDrawerOpen) return;
    const drawer = drawerRef.current;
    const trigger = drawerTriggerRef.current;
    const focusables = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
    // a modal drawer: focus starts inside it and tab wraps there.
    focusables()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // claimed, so a panel underneath that closes on escape stays open.
        e.preventDefault();
        setNavDrawerOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!drawer?.contains(active) || active === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      }
    };
    const mq = window.matchMedia('(min-width: 768px)');
    const onBreakpointChange = (e: MediaQueryListEvent) => {
      if (e.matches) setNavDrawerOpen(false);
    };
    // capture: window bubble listeners registered before the drawer opened
    // would otherwise see the escape before it is claimed.
    window.addEventListener('keydown', onKeyDown, true);
    mq.addEventListener('change', onBreakpointChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      mq.removeEventListener('change', onBreakpointChange);
      // back where the drawer was opened from. a dialog opened from inside the
      // drawer takes focus after this, in its own mount effect.
      trigger?.focus();
    };
  }, [navDrawerOpen]);

  useEffect(() => {
    if (!feedbackRotating) return;
    feedbackIndex.current = Math.floor(Math.random() * FEEDBACK_LABELS.length);
    setFeedbackLabel(FEEDBACK_LABELS[feedbackIndex.current]);

    const interval = setInterval(() => {
      setFeedbackFading(true);
      setTimeout(() => {
        feedbackIndex.current = (feedbackIndex.current + 1) % FEEDBACK_LABELS.length;
        setFeedbackLabel(FEEDBACK_LABELS[feedbackIndex.current]);
        setFeedbackFading(false);
      }, 300);
    }, 4000);

    return () => clearInterval(interval);
  }, [feedbackRotating]);

  const currentSiteName = sites.find(s => s.id === currentSiteId)?.name ?? 'select site';
  // Non-null only when there is actually a site to switch to. Holds the narrowed
  // callback so bar and drawer can call it without re-testing the same conditions.
  const selectSite = sites.length > 0 && currentSiteId && onSiteChange ? onSiteChange : null;
  // the same narrowing for the current site's editor, which only its admins can use.
  const openSiteSettings = currentSiteId && onSiteSettings && isSiteAdmin(currentSiteId) ? onSiteSettings : null;
  const PageIcon = PAGE_ICONS[currentPage.toLowerCase()];

  // the scrim mounts with the first open menu and goes once its fade-out ends:
  // a full-viewport backdrop blur costs a compositing pass while it exists,
  // even at opacity 0.
  const menuOpen = openMenuCount > 0;
  const [scrimMounted, setScrimMounted] = useState(false);
  if (menuOpen && !scrimMounted) setScrimMounted(true);

  return (
    <>
    <header className="border-b border-border bg-background">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between px-2 md:px-3">
        <nav className="flex items-center gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 flex-shrink-0 mr-1">
            <OwletteEyeIcon size={24} className="translate-y-[1px]" />
            <span className="text-base font-semibold text-foreground hidden md:block translate-y-[1px]">owlette</span>
          </div>

          {/* Below `md` the breadcrumb switchers can't fit beside the avatar and
              action buttons, so they collapse into the drawer this opens. */}
          {!disableNav && (
            <button
              ref={drawerTriggerRef}
              type="button"
              aria-label="menu"
              aria-expanded={navDrawerOpen}
              onClick={() => setNavDrawerOpen(true)}
              className="md:hidden inline-flex items-center justify-center h-8 w-8 flex-shrink-0 rounded-md hover:bg-secondary transition-colors cursor-pointer"
            >
              <Menu className="h-5 w-5 text-muted-foreground" />
            </button>
          )}

          {/* the site stays in view below `md`, where its switcher lives in the
              drawer: which fleet the page shows should never be a guess. */}
          {!disableNav && selectSite && (
            <span data-testid="mobile-current-site" className="md:hidden min-w-0 truncate text-sm text-muted-foreground">
              {currentSiteName}
            </span>
          )}

          {/* Breadcrumb: Site > Page — desktop only (mobile uses the drawer) */}
          <div className="hidden md:flex items-center gap-1.5 min-w-0">
            {selectSite && (
              <>
                {CRUMB_DIVIDER}
                <DropdownMenu onOpenChange={handleMenuOpenChange}>
                  <DropdownMenuTrigger asChild>
                    <button
                      data-testid="site-switcher-trigger"
                      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-secondary cursor-pointer truncate max-w-[200px] md:max-w-[320px]"
                    >
                      <span className="truncate">{currentSiteName}</span>
                      <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className={`${MENU_SURFACE} w-64`}>
                    {sites.map((site) => (
                      <DropdownMenuItem
                        key={site.id}
                        onClick={() => selectSite(site.id)}
                        className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer flex items-center justify-between"
                      >
                        <span className="truncate">{site.name}</span>
                        {site.id === currentSiteId && <Check className="h-4 w-4 text-accent-cyan flex-shrink-0" />}
                      </DropdownMenuItem>
                    ))}
                    {(openSiteSettings || onManageSites) && <DropdownMenuSeparator className="bg-border" />}
                    {openSiteSettings && (
                      <DropdownMenuItem
                        onClick={openSiteSettings}
                        className="text-muted-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                      >
                        <SlidersHorizontal className="mr-2 h-4 w-4" />
                        site settings
                      </DropdownMenuItem>
                    )}
                    {onManageSites && (
                      <DropdownMenuItem
                        onClick={onManageSites}
                        className="text-muted-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                      >
                        <Settings className="mr-2 h-4 w-4" />
                        manage sites
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}

            {CRUMB_DIVIDER}

            {disableNav ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground px-1.5 py-1">
                {PageIcon ? <PageIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground translate-y-[0.5px]" /> : null}
                <span className="lowercase">{currentPage}</span>
              </span>
            ) : (
            <DropdownMenu onOpenChange={handleMenuOpenChange}>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-secondary cursor-pointer">
                  {PageIcon ? <PageIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground translate-y-[0.5px]" /> : null}
                  <span className="lowercase">{currentPage}</span>
                  <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={`${MENU_SURFACE} w-72`}>
                {NAV_ITEMS.map((item) => {
                  const ItemIcon = item.icon;
                  return (
                    <DropdownMenuItem
                      key={item.href}
                      onClick={() => router.push(item.href)}
                      className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer py-3 px-3 flex items-start gap-3"
                    >
                      <ItemIcon className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{item.name}</span>
                        <span className="text-xs text-muted-foreground font-normal">
                          {item.description}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </div>
        </nav>

        <div className="flex items-center gap-1 md:gap-2 flex-shrink-0">
          {actionButton}

          {!disableNav && (
            <DropdownMenu onOpenChange={(open) => { setHelpMenuOpen(open); handleMenuOpenChange(open); }}>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label="help"
                  className="hidden md:inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-secondary transition-colors cursor-pointer"
                >
                  <CircleHelp className="h-4 w-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className={`w-56 ${MENU_SURFACE}`}>
                <DropdownMenuItem asChild className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer">
                  <Link href="/docs">
                    <BookOpen className="mr-2 h-4 w-4" />
                    docs
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setReportBugOpen(true)}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Bug className="mr-2 h-4 w-4 flex-shrink-0" />
                  <span className="transition-opacity duration-300" style={{ opacity: feedbackFading ? 0 : 1 }}>
                    {feedbackLabel}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {disableNav ? (
            /* Demo mode: show sign in + get started instead of user menu,
               styled as the landing header's pair */
            <div className="flex items-center gap-1.5">
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground px-2">
                <Link href="/login">sign in</Link>
              </Button>
              <Button asChild size="sm" className="group text-background font-medium">
                <Link href="/register">
                  get started
                  <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" />
                </Link>
              </Button>
            </div>
          ) : (
          <DropdownMenu onOpenChange={handleMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button
                data-testid="user-menu-trigger"
                className="inline-flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-secondary transition-colors cursor-pointer"
              >
                <UserAvatar user={user} size="sm" />
                {user?.displayName && (
                  <span className="text-sm text-foreground hidden lg:block">{getUserShortName(user)}</span>
                )}
                {/* Visible reminder when the signed-in user has platform god-mode,
                    so destructive cross-site actions don't catch them off guard. */}
                {isSuperadmin && (
                  <span
                    className="hidden sm:inline-flex items-center rounded-full bg-danger-solid/15 border border-danger-solid/40 text-danger text-[10px] font-medium tracking-wide px-1.5 py-0.5 leading-none overflow-hidden group/superadmin"
                    aria-label="signed in as superadmin"
                  >
                    <Crown className="h-2.5 w-2.5 shrink-0" />
                    <span className="max-w-0 group-hover/superadmin:max-w-20 group-hover/superadmin:ml-1 overflow-hidden whitespace-nowrap transition-all duration-200 ease-out">
                      superadmin
                    </span>
                  </span>
                )}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground hidden sm:block" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={`w-56 ${MENU_SURFACE}`}>
              <div className="px-3 py-2.5">
                {user?.displayName && (
                  <p className="text-sm font-medium text-foreground">{user.displayName}</p>
                )}
                <p className="text-xs text-muted-foreground truncate mt-0.5">{user?.email}</p>
              </div>
              <DropdownMenuSeparator className="bg-border" />
              {/* Site admins get the panel too, landing on the one section they
                  can reach; superadmins keep the installers entry point. The test
                  is site standing, not the global role, which grants nothing.
                  The back button's `owlette_pre_admin_path` is written by
                  LazyAuthProvider on every non-admin route, so it is already
                  correct for both roles without anything set here. */}
              {(isSuperadmin || administersAnySite) && (
                <DropdownMenuItem
                  onClick={() => router.push(isSuperadmin ? '/admin/installers' : '/admin/members')}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Shield className="mr-2 h-4 w-4" />
                  admin panel
                </DropdownMenuItem>
              )}
              {onAccountSettings && (
                <DropdownMenuItem
                  onClick={onAccountSettings}
                  className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  account settings
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  router.push('/');
                }}
                className="text-foreground focus:bg-accent focus:text-foreground cursor-pointer"
              >
                <LogOut className="mr-2 h-4 w-4" />
                sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          )}
        </div>
      </div>
    </header>

    {/* Mobile nav drawer — carries the site + page switchers (and the help
        items) that the `md` bar shows inline. Plain fixed positioning rather
        than a Radix sheet: a portalled surface escapes `md:hidden` and would
        need JS breakpoint gating to stay off the desktop viewport. Rendered
        only while open, and force-closed on the way up past `md` (see the
        effect above), so at >=768px this subtree does not exist. */}
    {navDrawerOpen && (
      <div ref={drawerRef} role="dialog" aria-modal="true" aria-label="menu" className="fixed inset-0 z-50 md:hidden">
        <div
          aria-hidden
          className="absolute inset-0 bg-black/50"
          onClick={() => setNavDrawerOpen(false)}
        />
        <nav
          aria-label="site and page navigation"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r ${MENU_SURFACE} animate-in slide-in-from-left duration-200`}
        >
          <div className="flex h-14 flex-shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-1.5">
              <OwletteEyeIcon size={24} className="translate-y-[1px]" />
              <span className="text-base font-semibold text-foreground translate-y-[1px]">owlette</span>
            </div>
            <button
              type="button"
              aria-label="close menu"
              onClick={() => setNavDrawerOpen(false)}
              className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent transition-colors cursor-pointer"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {selectSite && (
            <div className="border-b border-border py-2">
              <p className="px-4 py-1.5 text-xs text-muted-foreground">site</p>
              {sites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => {
                    selectSite(site.id);
                    setNavDrawerOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent transition-colors cursor-pointer"
                >
                  <span className="truncate">{site.name}</span>
                  {site.id === currentSiteId && <Check className="h-4 w-4 flex-shrink-0 text-accent-cyan" />}
                </button>
              ))}
              {openSiteSettings && (
                <button
                  type="button"
                  onClick={() => {
                    openSiteSettings();
                    setNavDrawerOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
                >
                  <SlidersHorizontal className="h-4 w-4 flex-shrink-0" />
                  site settings
                </button>
              )}
              {onManageSites && (
                <button
                  type="button"
                  onClick={() => {
                    onManageSites();
                    setNavDrawerOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
                >
                  <Settings className="h-4 w-4 flex-shrink-0" />
                  manage sites
                </button>
              )}
            </div>
          )}

          <div className="py-2">
            <p className="px-4 py-1.5 text-xs text-muted-foreground">go to</p>
            {NAV_ITEMS.map((item) => {
              const ItemIcon = item.icon;
              const isCurrent = item.name === currentPage.toLowerCase();
              return (
                <button
                  key={item.href}
                  type="button"
                  aria-current={isCurrent ? 'page' : undefined}
                  onClick={() => {
                    router.push(item.href);
                    setNavDrawerOpen(false);
                  }}
                  className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${
                    isCurrent ? 'bg-accent-cyan/10 text-accent-cyan' : 'text-foreground hover:bg-accent'
                  }`}
                >
                  <ItemIcon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isCurrent ? 'text-accent-cyan' : 'text-muted-foreground'}`} />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{item.name}</span>
                    <span className="text-xs text-muted-foreground font-normal">{item.description}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-auto border-t border-border py-2">
            <Link
              href="/docs"
              onClick={() => setNavDrawerOpen(false)}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-foreground hover:bg-accent transition-colors"
            >
              <BookOpen className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              docs
            </Link>
            <button
              type="button"
              onClick={() => {
                setReportBugOpen(true);
                setNavDrawerOpen(false);
              }}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              <Bug className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <span className="transition-opacity duration-300" style={{ opacity: feedbackFading ? 0 : 1 }}>
                {feedbackLabel}
              </span>
            </button>
          </div>
        </nav>
      </div>
    )}

    {/* the light under the header: a cool lift at night, a desk lamp's warm pool by day */}
    <div className="pointer-events-none absolute inset-x-0 top-14 h-48 z-0" style={{ background: 'var(--header-glow)' }} />
    {/* Scrim: subtle blur + dim of page content when a nav dropdown is open */}
    {scrimMounted && (
      <div
        aria-hidden
        onTransitionEnd={() => {
          if (!menuOpen) setScrimMounted(false);
        }}
        className={`pointer-events-none fixed inset-x-0 top-14 bottom-0 z-40 backdrop-blur-[2px] bg-black/10 transition-opacity duration-150 ${menuOpen ? 'opacity-100 animate-in fade-in-0' : 'opacity-0'}`}
      />
    )}
    <ReportBugDialog open={reportBugOpen} onOpenChange={setReportBugOpen} />
    </>
  );
}
