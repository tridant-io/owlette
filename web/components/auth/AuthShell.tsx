/**
 * AuthShell — the canonical chrome for every standalone auth surface.
 *
 * Extracted from app/login/page.tsx, which /register already mirrored by hand.
 * Every full-page auth panel now renders through this component so the nine
 * routes cannot drift apart again.
 *
 * DESIGN CONTRACTS — read before changing anything here:
 *
 * 1. STATELESS AND REMOUNT-SAFE. No hooks, no state, no Suspense boundary, no
 *    auth guard. Children sit at a fixed position in the tree so a parent
 *    re-render never unmounts them. Three things in the consuming pages die on
 *    a remount: the Turnstile token (TurnstileWidget's cleanup calls
 *    turnstile.remove(), and the submit button is gated on that token),
 *    /register's `authInFlight` ref, and /add's `autoSelectedRef`. The one
 *    exception is `loading`, which swaps the content column — use it only for a
 *    pre-mount gate (auth resolving, Suspense fallback), never for an in-page
 *    state change on a page carrying Turnstile.
 *
 * 2. THE BRAND PANEL SHARES THE FORM COLUMN'S FILL. Two near-identical flat
 *    greys sharing a hard edge read as a mistake — tried twice on these pages,
 *    rejected twice. The panel is differentiated by TEXTURE (dot-grid + radial
 *    vignette) and the single column border, not by tone. Do not reintroduce a
 *    tonal panel fill.
 *
 * 3. NO ANIMATION. e2e/helpers/mobile.ts:stabilize() and the a11y stabilizer
 *    hardcode the five `hero-enter*` class names plus a blanket animation:none.
 *    A new entrance animation here would not be neutralised by name and can
 *    make the mobile overflow gate flap.
 *
 * 4. THE BRAND TITLE IS THE PAGE'S h1. An auth page has no other heading, so
 *    a <div> title left screen-reader users with no heading to land on (the
 *    a11y audit). `brandTitleAs` overrides the level (/add's success state
 *    passes h2). Text queries are unaffected by the tag; heading queries that
 *    expect a single match must stay anchored to the title text.
 *
 * 5. min-w-0 ON BOTH COLUMNS. Grid items default to min-width:auto, so one long
 *    unbreakable string (an email, a machine id, a base32 secret) sets the
 *    column's floor and pushes the card past its max-w-*. The Card is
 *    overflow-hidden, so that CLIPS rather than scrolls — the mobile overflow
 *    gate stays green while the content is cut in half. min-w-0 lets
 *    break-all/break-words on the child actually do its job.
 *
 * 6. @container/auth-form ON THE FORM COLUMN. The column's width comes from the
 *    card's md: split, not from the viewport, so a viewport-keyed
 *    `sm:grid-cols-2` inside it measures the wrong box — it made /register's
 *    name fields SHRINK as the viewport crossed 768px. Use `@sm/auth-form:` /
 *    `@lg/auth-form:` instead. card.tsx already uses @container/card-header, so
 *    there is in-repo precedent.
 */

import type { ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { LoadingWord } from '@/components/LoadingWord';
import { cn } from '@/lib/utils';

export type AuthShellWidth = 'default' | 'wide';

/**
 * `wide` pins the brand panel at 20rem and gives the remainder to the form,
 * rather than splitting 50/50: the brand column holds an 80px icon and two
 * short lines, so an even split at 1024px would waste 190px on the left to
 * starve the column that has to hold a QR code, its explainer, and a ten-row
 * backup-code sheet.
 */
const CARD_WIDTH: Record<AuthShellWidth, string> = {
  default: 'max-w-md md:max-w-4xl',
  wide: 'max-w-md md:max-w-5xl',
};

const CARD_COLUMNS: Record<AuthShellWidth, string> = {
  default: 'md:grid-cols-2',
  wide: 'md:grid-cols-[20rem_minmax(0,1fr)]',
};

/**
 * `leading-tight`, not CardTitle's default `leading-none`: several page titles
 * wrap to two or three lines in the brand column ("set up two-factor
 * authentication" at the `wide` variant's 256px of content box), and a 1.0 line
 * height sets those lines solid.
 *
 * `text-pretty`, NOT `text-balance`: balancing "set up two-factor
 * authentication" made it break at the hyphen — "set up two-" / "factor
 * authentication" — which reads as a typo. Pretty only suppresses orphans, so
 * the line fills naturally and the compound word survives.
 */
const BRAND_TITLE_CLASS = 'text-2xl leading-tight font-bold text-pretty text-foreground';

/** The shared treatment for links in the footer band. */
export const authFooterLinkClass =
  'whitespace-nowrap font-medium hl-link text-accent-cyan';

export interface AuthShellProps {
  /** Brand panel headline — the page's own title. */
  brandTitle?: ReactNode;
  /** The brand title's element: the page's h1 by default. See contract 4. */
  brandTitleAs?: 'div' | 'h1' | 'h2';
  /** Brand panel supporting line, under the title. */
  brandDescription?: ReactNode;
  /** Optional third brand line for machine-scoped context (e.g. "authorizing on {host}"). */
  brandMeta?: ReactNode;
  /** `wide` for content that genuinely needs the room (QR code + backup codes). */
  width?: AuthShellWidth;
  /**
   * Pre-mount gate only. Replaces the form column with a centered LoadingWord
   * inside the identical card, so the shell does not change shape on resolve.
   */
  loading?: boolean;
  /**
   * owlette swoop's login: one narrow column with the brand above the form and
   * a smaller mark, and no room kept for the site footer, which the app does
   * not show (Footer.tsx). overrides `width`.
   */
  minimal?: boolean;
  /** Full-bleed band pinned to the bottom of the form column. Omit for no band. */
  footer?: ReactNode;
  /** Extra classes on the form column (e.g. a min-height to damp a resolve-time jump). */
  contentClassName?: string;
  /** Extra classes on the Card. Escape hatch; prefer `width`. */
  className?: string;
  children?: ReactNode;
}

export function AuthShell({
  brandTitle = 'owlette',
  brandTitleAs = 'h1',
  brandDescription = 'keep your installation running',
  brandMeta,
  width = 'default',
  loading = false,
  minimal = false,
  footer,
  contentClassName,
  className,
  children,
}: AuthShellProps) {
  const BrandTitleTag = brandTitleAs;

  return (
    /* pb-32 clears the app-wide fixed Footer, whose inner container is
       pointer-events-auto and otherwise swallows taps on the card's bottom
       controls at short viewport heights. */
    <main className={cn('relative flex min-h-screen items-center justify-center p-4', !minimal && 'pb-32')}>
      <div className="absolute inset-0 dot-grid opacity-30" aria-hidden="true" />
      <div className="absolute inset-0 blueprint-grid opacity-15" aria-hidden="true" />

      {/* p-0 zeroes the Card primitive's py-6/gap-6 so each column owns its own
          p-8. overflow-hidden is what makes the -mx-8 bleeds (the divider, the
          footer band) safe — without it they open a horizontal scrollbar. */}
      <Card
        className={cn(
          'relative z-10 w-full overflow-hidden border-border bg-card p-0',
          minimal ? 'max-w-sm' : CARD_WIDTH[width],
          className,
        )}
      >
        <div className={cn('grid', !minimal && CARD_COLUMNS[width])}>
          <CardHeader
            className={cn(
              'relative flex min-w-0 flex-col items-center justify-center space-y-4 p-8 text-center',
              minimal ? 'pb-0' : 'md:h-full md:border-r md:border-border',
            )}
          >
            {/* minimal has no panel to set apart, and the texture's edge would
                cut under the title */}
            {minimal ? null : (
              <>
                <div className="dot-grid absolute inset-0 -z-10 opacity-25" aria-hidden="true" />
                <div
                  className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(120%_120%_at_50%_50%,transparent_35%,var(--card-recessed)_100%)]"
                  aria-hidden="true"
                />
              </>
            )}
            <OwletteEyeIcon size={minimal ? 56 : 80} />
            <div className="min-w-0 space-y-1">
              {brandTitleAs === 'div' ? (
                <CardTitle className={BRAND_TITLE_CLASS}>{brandTitle}</CardTitle>
              ) : (
                <BrandTitleTag data-slot="card-title" className={BRAND_TITLE_CLASS}>
                  {brandTitle}
                </BrandTitleTag>
              )}
              {brandDescription ? (
                <CardDescription className="text-pretty text-muted-foreground">
                  {brandDescription}
                </CardDescription>
              ) : null}
              {brandMeta ? (
                <p className="pt-1 font-mono text-xs break-all text-muted-foreground">
                  {brandMeta}
                </p>
              ) : null}
            </div>
          </CardHeader>

          {loading ? (
            <CardContent
              className={cn(
                'flex min-w-0 items-center justify-center bg-card p-8',
                contentClassName,
              )}
            >
              <div className="text-center text-muted-foreground">
                <LoadingWord />
              </div>
            </CardContent>
          ) : (
            <CardContent
              className={cn(
                '@container/auth-form min-w-0 space-y-6 bg-card p-8',
                contentClassName,
              )}
            >
              {children}
              {footer ? (
                /* Full-bleed band: -mx-8/-mb-8 cancel the column's p-8 on three
                   sides so the band owns its own spacing, then symmetric py-6
                   centers the text within it. Relying on the card's bottom
                   padding instead left 24px above the text and 32px below it,
                   which read as visually low. Hairline only — the fill
                   experiment is retired: one signal per boundary. */
                <div className="-mx-8 -mb-8 text-balance border-t border-border px-8 py-6 text-center text-sm text-muted-foreground">
                  {footer}
                </div>
              ) : null}
            </CardContent>
          )}
        </div>
      </Card>
    </main>
  );
}

/**
 * Full-bleed "or" rule between two auth methods. -mx-8 cancels the column
 * padding; safe only because the Card is overflow-hidden.
 */
export function AuthDivider({ label = 'or' }: { label?: string }) {
  return (
    <div className="relative -mx-8">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-card px-2 text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

/** Separator between two links in the footer band. */
export function AuthFooterDot() {
  return (
    <span className="px-2 text-border" aria-hidden="true">
      ·
    </span>
  );
}

/**
 * footer band content: who is signed in, over the way out for the wrong account.
 * the email stays on one line (a break-all stranded its last letter on a line
 * of its own); too long for the band, it loses its middle, keeping the start
 * and the domain's tail, which together still say whose account it is.
 */
export function AuthSignedInAs({ email, onSwitch }: { email: string; onSwitch: () => void }) {
  const cut = Math.max(0, email.indexOf('@'), email.length - 10);
  return (
    <>
      <span className="flex justify-center">
        <span className="shrink-0 whitespace-pre">signed in as </span>
        <span className="flex min-w-0" title={email} data-testid="signed-in-email">
          <span className="truncate">{email.slice(0, cut)}</span>
          <span className="shrink-0">{email.slice(cut)}</span>
        </span>
      </span>
      <button
        type="button"
        onClick={onSwitch}
        className="mt-1 underline-offset-2 hover:underline"
        data-testid="sign-in-as-someone-else"
      >
        not you? sign in as someone else
      </button>
    </>
  );
}
