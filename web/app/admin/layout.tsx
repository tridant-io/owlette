'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import RequireAdminAccess from '@/components/RequireAdminAccess';
import { ArrowLeft, Menu, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/contexts/AuthContext';
import { useDevicePrefFlag, useDevicePrefNumber } from '@/hooks/useDevicePrefFlag';
import { useScrollFade } from '@/hooks/useScrollFade';
import { requiredRoleForPath, visibleNavItems } from './navItems';

/** Resizable sidebar bounds (lg+ expanded state only; the icon rail is fixed). */
const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 480;
const SIDEBAR_DEFAULT_W = 256;
/** Dragging well past the minimum reads as "get rid of it" — collapse instead. */
const SIDEBAR_COLLAPSE_AT_W = 150;
/** Below this width the nav descriptions vanish so names keep their room. */
const SIDEBAR_COMPACT_BELOW_W = 232;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { role, administersAnySite } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenuButtonRef = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);

  // the drawer takes focus when it opens, escape closes it, and focus goes back
  // to the menu button on close (it remounts, so this runs after the commit)
  useEffect(() => {
    if (mobileMenuOpen) {
      closeMenuButtonRef.current?.focus();
    } else if (menuWasOpen.current) {
      menuButtonRef.current?.focus();
    }
    menuWasOpen.current = mobileMenuOpen;
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  // Explicit user control, not the old viewport-driven auto-collapse, so width is
  // predictable at any window size. lg+ only; <lg always uses the drawer.
  const { value: collapsed, setValue: setCollapsed } = useDevicePrefFlag('adminSidebarCollapsed', false);

  // The pref's 400ms debounce means a drag writes to Firestore once at rest.
  const { value: sidebarWidth, setValue: setSidebarWidth } = useDevicePrefNumber(
    'adminSidebarWidth',
    SIDEBAR_DEFAULT_W,
    SIDEBAR_MIN_W,
    SIDEBAR_MAX_W,
  );
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // on mobile the pane runs under the fixed top bar (pt-16), so it fades instead of cutting
  const mainRef = useScrollFade<HTMLElement>();

  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    setResizing(true);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const raw = resizeRef.current.startWidth + (e.clientX - resizeRef.current.startX);
    // yanking past the minimum collapses; the width pref keeps its last value
    if (raw < SIDEBAR_COLLAPSE_AT_W) {
      resizeRef.current = null;
      setResizing(false);
      setCollapsed(true);
      return;
    }
    setSidebarWidth(raw);
  };
  const onResizeEnd = () => {
    resizeRef.current = null;
    setResizing(false);
  };
  // narrow-but-expanded drops descriptions so names keep their room (lg+ only)
  const compactNav = !collapsed && sidebarWidth < SIDEBAR_COMPACT_BELOW_W;

  const navItems = visibleNavItems(role, administersAnySite);
  const requiredRole = requiredRoleForPath(pathname);

  // Lazy initializer, not an effect: the first render needs the right back-target
  // and a post-mount setState trips react-hooks/set-state-in-effect.
  const [{ backLabel, backPath }] = useState(() => {
    if (typeof window === 'undefined') return { backLabel: 'go back', backPath: '/dashboard' };
    const prev = sessionStorage.getItem('owlette_pre_admin_path');
    if (!prev) return { backLabel: 'go back', backPath: '/dashboard' };
    const name = prev.replace(/^\//, '').split('/')[0] || 'dashboard';
    return { backLabel: `back to ${name}`, backPath: prev };
  });

  // not router.back(): skip over any admin -> admin navigation taken on the way in
  const handleBack = () => {
    router.push(backPath);
  };

  // Only ever collapses — the owl-eye logo is the expand control when collapsed.
  const renderCollapseButton = () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setCollapsed(true)}
          aria-label="collapse sidebar"
          className="shrink-0 text-muted-foreground hover:text-foreground! hover:bg-accent! cursor-pointer"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>collapse sidebar</p>
      </TooltipContent>
    </Tooltip>
  );

  return (
    <RequireAdminAccess minRole={requiredRole}>
      <TooltipProvider delayDuration={100}>
        <div className="flex min-h-screen">
        {/* Mobile Menu Button */}
        {!mobileMenuOpen && (
          <div className="lg:hidden fixed top-4 left-4 z-50">
            <Button
              ref={menuButtonRef}
              variant="outline"
              size="sm"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="open admin menu"
              aria-expanded={false}
              aria-controls="admin-sidebar"
              className="border-border bg-muted/95 backdrop-blur-sm text-foreground hover:bg-muted! cursor-pointer shadow-lg"
            >
              <Menu className="h-5 w-5 stroke-[2.5]" />
            </Button>
          </div>
        )}

        {/* Mobile Overlay */}
        {mobileMenuOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}

        {/* Sidebar Navigation */}
        <aside
          id="admin-sidebar"
          // Width var is lg+ expanded only (mobile w-64, collapsed rail lg:w-20).
          // Transitions off mid-drag so width tracks the pointer 1:1.
          style={{ '--admin-sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
          className={`
          w-64 ${collapsed ? 'lg:w-20' : 'lg:w-[var(--admin-sidebar-w)]'} bg-card border-r border-border flex flex-col
          fixed lg:relative inset-y-0 left-0 z-40
          transform ${resizing ? 'transition-none' : 'duration-200 ease-in-out'}
          ${mobileMenuOpen
            // visibility transitions on close only: on open the drawer must be
            // focusable at once, or the focus() in the effect above lands nowhere
            ? `translate-x-0 ${resizing ? '' : 'transition-[translate,width]'}`
            : `-translate-x-full invisible lg:visible lg:translate-x-0 ${resizing ? '' : 'transition-[translate,width,visibility]'}`}
        `}>
          {/* Resize handle, lg+ expanded only. Arrows nudge 16px, double-click resets.
              Keep the aria-value* attrs: a focusable separator is a window-splitter
              widget, and axe `aria-required-attr` (critical) failed the a11y route
              smoke without aria-valuenow. */}
          {!collapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="resize sidebar"
              aria-valuenow={sidebarWidth}
              aria-valuemin={SIDEBAR_MIN_W}
              aria-valuemax={SIDEBAR_MAX_W}
              tabIndex={0}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_W)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setSidebarWidth(sidebarWidth - 16);
                if (e.key === 'ArrowRight') setSidebarWidth(sidebarWidth + 16);
              }}
              className="hidden lg:block absolute inset-y-0 -right-px w-1.5 z-50 cursor-col-resize outline-none transition-colors hover:bg-accent-cyan/40 active:bg-accent-cyan/60 focus-visible:bg-accent-cyan/50"
            />
          )}
          {/* Vertical padding is constant across states so the logo can't shift as the rail folds. */}
          <div className={`p-6 ${collapsed ? 'lg:px-3 lg:py-6' : 'lg:p-6'} border-b border-border`}>
            {/* Mobile Header */}
            <div className="lg:hidden mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xl font-bold text-foreground">admin panel</p>
                <button
                  ref={closeMenuButtonRef}
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="p-2 hover:bg-muted! rounded-lg transition-colors cursor-pointer"
                  aria-label="close admin menu"
                >
                  <X className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </button>
              </div>
            </div>

            {/* Fixed row height + constant logo size, so the owl eye lands at the same y in both states. */}
            <div className={`hidden lg:flex items-center h-11 mb-4 ${collapsed ? 'justify-center' : 'relative gap-2'}`}>
              {collapsed ? (
                /* Collapsed: the logo doubles as the expand control (swaps to an icon on
                   hover/focus), saving a row on the rail. Desktop only. */
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setCollapsed(false)}
                      aria-label="expand sidebar"
                      className="group relative flex items-center justify-center h-10 w-10 rounded-lg transition-colors hover:bg-accent! focus-visible:bg-accent! outline-none cursor-pointer"
                    >
                      <Image
                        src="/owlette-icon.png"
                        alt="Owlette"
                        width={36}
                        height={36}
                        className="transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <PanelLeftOpen className="absolute h-5 w-5 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <p>expand sidebar</p>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <>
                  <div className="flex-shrink-0">
                    <Image src="/owlette-icon.png" alt="Owlette" width={36} height={36} />
                  </div>
                  <div className="block pr-8">
                    <p className="text-xl font-bold text-foreground">admin panel</p>
                  </div>
                  {/* Floated right, centered on the logo; the title's pr-8 keeps text clear. */}
                  <div className="absolute right-0 top-1/2 -translate-y-1/2">
                    {renderCollapseButton()}
                  </div>
                </>
              )}
            </div>

            {/* Back Button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBack}
                  aria-label={collapsed ? backLabel : undefined}
                  className={`w-full border-border bg-background text-foreground hover:bg-accent! hover:text-foreground! cursor-pointer ${collapsed ? 'lg:px-2' : 'lg:px-3'}`}
                >
                  <ArrowLeft className={`h-4 w-4 ${collapsed ? 'lg:mr-0' : 'lg:mr-2'}`} />
                  <span className={collapsed ? 'inline lg:hidden' : 'inline'}>{backLabel}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" className={collapsed ? 'hidden lg:block' : 'hidden'}>
                <p>{backLabel}</p>
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Navigation Links */}
          <nav className={`flex-1 p-4 ${collapsed ? 'lg:p-2' : 'lg:p-4'}`}>
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              const Icon = item.icon;

              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>
                    <Link
                      href={item.href}
                      onClick={() => setMobileMenuOpen(false)}
                      // the collapsed rail hides the text, and the icon is aria-hidden
                      aria-label={collapsed ? item.name : undefined}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <div
                        className={`
                          flex items-start gap-3 p-3 ${collapsed ? 'lg:p-2 lg:justify-center' : 'lg:p-3 lg:justify-start'} rounded-lg cursor-pointer transition-colors mb-2
                          ${
                            isActive
                              ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30'
                              : 'text-foreground hover:bg-accent! hover:text-foreground!'
                          }
                        `}
                      >
                        <Icon className="h-5 w-5 mt-0.5 flex-shrink-0" />
                        <div className={`block ${collapsed ? 'lg:hidden' : 'lg:block'}`}>
                          <p className="font-medium text-sm">{item.name}</p>
                          <p
                            className={`text-xs mt-0.5 ${compactNav ? 'lg:hidden' : ''} ${
                              isActive ? 'text-accent-cyan' : 'text-muted-foreground'
                            }`}
                          >
                            {item.description}
                          </p>
                        </div>
                      </div>
                    </Link>
                  </TooltipTrigger>
                  <TooltipContent side="right" className={collapsed ? 'hidden lg:block' : 'hidden'}>
                    <p className="font-medium">{item.name}</p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </nav>

        </aside>

        {/* Main Content */}
        <main ref={mainRef} className="flex-1 overflow-auto pt-16 lg:pt-0">
          {children}
        </main>
      </div>
      </TooltipProvider>
    </RequireAdminAccess>
  );
}
