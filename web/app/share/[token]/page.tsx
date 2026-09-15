/**
 * The public page a share link resolves to — `/share/{token}`.
 *
 * No session, no auth context, no client data hooks: the whole page is the
 * server read `getPublicChatShare(token)` plus the same renderer the owner's
 * share dialog previews with, so what was previewed is exactly what a reader
 * sees. The token in the URL is the only access control this page has.
 *
 * NO ORACLE. `getPublicChatShare` returns null for missing, expired AND revoked
 * alike, and every one of those lands on the identical `notFound()` — so a URL
 * can never tell a holder which of the three it is. Keep it that way: do not add
 * an "expired" state, a revoked message, or a differently-worded 404.
 *
 * CACHING. `force-dynamic` is the whole caching story, and it is load-bearing:
 * revocation has to take effect on the next request, so nothing here may be
 * prerendered or revalidated. It also gives us the response header we want for
 * free — force-dynamic renders with `revalidate: 0`, and Next's
 * `getCacheControlHeader` (node_modules/next/dist/server/lib/cache-control.js)
 * maps `revalidate === 0` to `private, no-cache, no-store, max-age=0,
 * must-revalidate`. Next 16 exposes no page-level API for setting response
 * headers by hand (that lives in next.config's `headers()` or the proxy), so
 * there is nothing further to add.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { SharedConversation } from '@/components/hoot/SharedConversation';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { getPublicChatShare } from '@/lib/hoot/shareStore.server';
import {
  SITE_WIDE_TARGET_LABEL,
  type ChatShareView,
  type SharedMessage,
} from '@/lib/hoot/shareTypes';

export const dynamic = 'force-dynamic';

/**
 * `generateMetadata` and the page both need the share, and Next runs them as two
 * passes over the same request — without this every view would cost two Firestore
 * reads. `cache` dedupes them for the life of one request only, so revocation is
 * unaffected. (The store is not a `fetch`, so Next's fetch memoization can't do it.)
 */
const loadShare = cache((token: string) => getPublicChatShare(token));

const OWLETTE_URL = 'https://owlette.app';

// A site-wide chat's label is normalized by the snapshot builder; the fallback
// to SITE_WIDE_TARGET_LABEL below only covers a chat that carries no machine
// name at all, so a reader is never shown a share with no scope.

const NOT_AVAILABLE_TITLE = 'shared conversation not available';
const NOT_AVAILABLE_DESCRIPTION =
  'this link may have expired, or the person who shared it removed it.';

const FALLBACK_DESCRIPTION = 'a hoot conversation shared from owlette';

/** Meta descriptions are cut off past this by every consumer; do it ourselves. */
const MAX_DESCRIPTION_CHARS = 160;

/**
 * A share is unlisted, not public: the token is unguessable and must never be
 * indexed, cached by a crawler, or followed onward into the dashboard.
 */
const SHARE_ROBOTS = { index: false, follow: false, nocache: true } as const;

/**
 * Fixed locale AND fixed time zone. A share is rendered on the server only, so
 * anything reading the deployment's locale or clock would render one string in
 * the HTML and (once React hydrates the tree) risk another in the client — the
 * classic hydration mismatch. UTC is the one zone both sides agree on.
 */
const SHARE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
};

function formatShareDate(ms: number): string {
  // Lowercased to match the house voice — the month abbreviation is the only
  // capital `toLocaleDateString` produces.
  return new Date(ms).toLocaleDateString('en-US', SHARE_DATE_FORMAT).toLowerCase();
}

/** `<target> · shared <date> · expires <date>` — one line, in the reader's order of interest. */
function shareMetaLine(share: ChatShareView): string {
  return [
    share.targetLabel ?? SITE_WIDE_TARGET_LABEL,
    `shared ${formatShareDate(share.createdAt)}`,
    share.expiresAt === null ? 'never expires' : `expires ${formatShareDate(share.expiresAt)}`,
  ].join(' · ');
}

/** The opening question, which is what a reader actually wants in an unfurl. */
function firstUserText(messages: SharedMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const part of message.parts) {
      if (part.type !== 'text') continue;
      // Collapse newlines: a meta description is a single line.
      const text = part.text.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function shareDescription(share: ChatShareView): string {
  const opening = firstUserText(share.messages);
  return opening ? truncate(opening, MAX_DESCRIPTION_CHARS) : FALLBACK_DESCRIPTION;
}

interface SharePageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { token } = await params;
  const share = await loadShare(token);

  if (!share) {
    return {
      // `absolute` throughout this file: the root layout templates app titles
      // as "owlette - %s", and these are public pages whose titles already
      // carry their own branding.
      title: { absolute: NOT_AVAILABLE_TITLE },
      description: NOT_AVAILABLE_DESCRIPTION,
      robots: SHARE_ROBOTS,
      // Stated rather than inherited: without these the root layout's marketing
      // openGraph would unfurl a dead link as the product homepage.
      openGraph: {
        title: NOT_AVAILABLE_TITLE,
        description: NOT_AVAILABLE_DESCRIPTION,
        type: 'article',
      },
      twitter: {
        card: 'summary_large_image',
        title: NOT_AVAILABLE_TITLE,
        description: NOT_AVAILABLE_DESCRIPTION,
      },
    };
  }

  const title = `${share.title} — shared from owlette hoot`;
  const description = shareDescription(share);

  return {
    title: { absolute: title },
    description,
    robots: SHARE_ROBOTS,
    // `images` is deliberately ABSENT from both blocks. Next fills og:image and
    // twitter:image from the colocated opengraph-image.tsx, but only while this
    // level declares no `images` key of its own — `mergeStaticMetadata` in
    // next/dist/lib/metadata/resolve-metadata.js gates on
    // `source.openGraph.hasOwnProperty('images')`. Writing the URL by hand here
    // would replace the generated card, not add to it.
    openGraph: { title, description, type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function SharePage({ params }: SharePageProps) {
  const { token } = await params;
  const share = await loadShare(token);

  if (!share) notFound();

  return (
    <div className="min-h-[100dvh]">
      {/* Mark and wordmark as PageHeader draws them. The wordmark inherits the
          link's color rather than setting its own, so the hover still reaches it. */}
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-6">
          <Link
            href={OWLETTE_URL}
            className="inline-flex items-center gap-1.5 text-foreground transition-colors hover:text-accent-cyan"
          >
            <OwletteEyeIcon size={24} className="translate-y-[1px]" />
            <span className="text-base font-semibold translate-y-[1px]">owlette hoot</span>
          </Link>
        </div>
      </header>

      {/* pb-32 clears the app-wide fixed Footer, which renders on this route. */}
      <main className="mx-auto w-full max-w-3xl px-6 pt-10 pb-32">
        <h1 className="text-2xl font-bold text-pretty text-foreground">{share.title}</h1>
        <p className="mt-2 text-xs text-muted-foreground">{shareMetaLine(share)}</p>

        {/* The hoot chat panel's surface (HootChatView's <main>), so the snapshot
            reads as the conversation it was, not loose text on the page. It scrolls
            sideways as ChatWindow's scroller does, so a wide table or an unbroken
            path stays inside the border instead of running off a viewport that
            body's overflow-x: hidden clips. */}
        <div
          data-testid="shared-conversation-panel"
          className="mt-8 overflow-x-auto rounded-lg border border-border bg-card p-4 md:p-6"
        >
          <SharedConversation messages={share.messages} />
        </div>

        <p className="mt-12 border-t border-border pt-6 text-xs text-muted-foreground">
          shared from owlette hoot — a read-only snapshot. later messages are not included.
        </p>
      </main>
    </div>
  );
}
