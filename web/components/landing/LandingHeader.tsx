'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/UserAvatar';
import { useAuth } from '@/contexts/AuthContext';
import { INSTALLER_PLATFORMS, PLATFORM_LABEL } from '@/lib/installerPlatform';
import { OwletteEyeIcon } from './OwletteEye';

type NavLinkDef = { label: string; href: string; external?: boolean };

// Section anchors, in page order.
const SECTION_LINKS: NavLinkDef[] = [
  { label: 'capabilities', href: '#capabilities' },
  { label: 'pricing', href: '#pricing' },
  { label: 'faq', href: '#faq' },
];

// External / product links, shown to everyone.
const UTIL_LINKS: NavLinkDef[] = [{ label: 'docs', href: '/docs' }];

// one installer per platform. /download?os= redirects to the latest build, so
// these are plain links that need no sign-in. `short` is the label's first
// word, for the phone menu's single row.
const DOWNLOAD_LINKS = INSTALLER_PLATFORMS.map((platform) => ({
  label: PLATFORM_LABEL[platform],
  short: PLATFORM_LABEL[platform].split(' ')[0],
  href: `/download?os=${platform.split('_')[0]}`,
}));

// Appended only while signed out — offering "sign in" to a signed-in visitor is
// the thing this header used to get wrong.
const SIGN_IN_LINK: NavLinkDef = { label: 'sign in', href: '/login' };

function linkEl(link: NavLinkDef, className?: string, onClick?: () => void) {
  if (link.external) {
    return (
      <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className={className} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  if (link.href.startsWith('#')) {
    return (
      <a key={link.label} href={link.href} className={className} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  return (
    <Link key={link.label} href={link.href} className={className} onClick={onClick}>
      {link.label}
    </Link>
  );
}

export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  const { user, loading } = useAuth();

  /**
   * Nothing auth-dependent renders until auth resolves. An earlier version let
   * the signed-out markup stand while `loading`, which made a returning visitor
   * watch "sign in" repaint into "go to dashboard" — the wrong state first, then
   * the right one. The slot still occupies its signed-out width so the header
   * does not reflow when the answer arrives; it is only invisible, not absent.
   */
  const authReady = !loading;
  const signedIn = authReady && !!user;

  const scrollToTop = (e: React.MouseEvent) => {
    e.preventDefault();
    close();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const ghostClass = 'text-muted-foreground hover:text-foreground px-2';

  return (
    <header className="fixed top-0 inset-x-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-md hero-enter-nav">
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="#" onClick={scrollToTop} className="flex items-center gap-1.5 group cursor-pointer">
          <OwletteEyeIcon size={28} className="group-hover:scale-105 transition-transform translate-y-[1px]" />
          <span className="text-lg sm:text-xl font-semibold tracking-tight translate-y-[1px]">owlette</span>
        </a>

        {/* Desktop nav */}
        <div className="hidden lg:flex items-center gap-0.5">
          {SECTION_LINKS.map((link) => (
            <Button key={link.label} asChild variant="ghost" size="sm" className={ghostClass}>
              {linkEl(link)}
            </Button>
          ))}
          <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
          {UTIL_LINKS.map((link) => (
            <Button key={link.label} asChild variant="ghost" size="sm" className={ghostClass}>
              {linkEl(link)}
            </Button>
          ))}
          {/* not modal: a modal menu locks the page's scroll, and dropping the
              scrollbar shifts the whole page sideways */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className={`${ghostClass} gap-1`}>
                download
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {DOWNLOAD_LINKS.map((link) => (
                <DropdownMenuItem key={link.href} asChild className="cursor-pointer">
                  <a href={link.href}>{link.label}</a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Both states occupy the SAME grid cell, so the column is always as
              wide as the wider of the two and nothing to the left of it can move
              when auth resolves. Only opacity changes — a width swap here would
              shift the whole nav, since the row is right-aligned. */}
          <div className="grid items-center">
            <div
              aria-hidden={!signedIn}
              className={`col-start-1 row-start-1 flex items-center transition-opacity duration-300 motion-reduce:transition-none ${
                signedIn ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <Button asChild size="sm" className="ml-1.5 text-background font-medium">
                <Link href="/dashboard" tabIndex={signedIn ? undefined : -1}>go to dashboard</Link>
              </Button>
              <span className="ml-2 flex items-center" title={user?.email ?? undefined}>
                <UserAvatar user={user} size="sm" />
              </span>
            </div>
            <div
              aria-hidden={signedIn || !authReady}
              className={`col-start-1 row-start-1 flex items-center transition-opacity duration-300 motion-reduce:transition-none ${
                authReady && !signedIn ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <Button asChild variant="ghost" size="sm" className={ghostClass}>
                {linkEl(SIGN_IN_LINK)}
              </Button>
              <Button asChild size="sm" className="ml-1.5 text-background font-medium">
                <Link href="/register" tabIndex={authReady && !signedIn ? undefined : -1}>get started</Link>
              </Button>
            </div>
          </div>
        </div>

        {/* Mobile / tablet: get started + hamburger */}
        <div className="flex lg:hidden items-center gap-2">
          {/* Stacked for the same reason as the desktop slot: "dashboard" and
              "get started" are different widths, and a swap would shove the
              hamburger sideways. Shorter labels here — the row is narrow. */}
          <div className="grid items-center">
            <Button
              asChild
              size="sm"
              className={`col-start-1 row-start-1 text-background font-medium transition-opacity duration-300 motion-reduce:transition-none ${
                signedIn ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <Link href="/dashboard" aria-hidden={!signedIn} tabIndex={signedIn ? undefined : -1}>
                dashboard
              </Link>
            </Button>
            <Button
              asChild
              size="sm"
              className={`col-start-1 row-start-1 text-background font-medium transition-opacity duration-300 motion-reduce:transition-none ${
                authReady && !signedIn ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <Link
                href="/register"
                aria-hidden={signedIn || !authReady}
                tabIndex={authReady && !signedIn ? undefined : -1}
              >
                get started
              </Link>
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? 'close menu' : 'open menu'}
            aria-expanded={menuOpen}
            className="inline-flex items-center justify-center h-9 w-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>

      {/* Mobile menu panel — slides open/closed via a grid-rows transition.
          inert, not just aria-hidden, while closed: its links stay in the dom
          for the transition and would otherwise still take tab. */}
      <div
        inert={!menuOpen}
        className={`lg:hidden grid overflow-hidden bg-background/95 backdrop-blur-md transition-[grid-template-rows] duration-200 ease-out ${
          menuOpen ? 'grid-rows-[1fr] border-t border-border/50' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <nav className="w-full max-w-5xl mx-auto px-4 sm:px-6 py-2 flex flex-col">
            {SECTION_LINKS.map((link) =>
              linkEl(link, 'py-3 text-base text-muted-foreground hover:text-foreground transition-colors', close),
            )}
            <span aria-hidden className="my-1 h-px w-full bg-border/50" />
            {UTIL_LINKS.map((link) =>
              linkEl(link, 'py-3 text-base text-muted-foreground hover:text-foreground transition-colors', close),
            )}
            <div className="py-3 flex flex-wrap items-baseline gap-x-5 gap-y-2 text-base">
              <span className="text-muted-foreground">download</span>
              {DOWNLOAD_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  aria-label={`download for ${link.label}`}
                  className="text-foreground/80 hover:text-foreground transition-colors"
                  onClick={close}
                >
                  {link.short}
                </a>
              ))}
            </div>
            {authReady &&
              !signedIn &&
              linkEl(SIGN_IN_LINK, 'py-3 text-base text-muted-foreground hover:text-foreground transition-colors', close)}
            {signedIn && user && (
              <div className="flex items-center gap-2.5 py-3 text-base text-muted-foreground">
                <UserAvatar user={user} size="sm" />
                <span className="truncate">{user.displayName || user.email}</span>
              </div>
            )}
          </nav>
        </div>
      </div>
    </header>
  );
}
