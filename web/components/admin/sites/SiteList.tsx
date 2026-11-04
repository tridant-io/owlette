'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Building2, Plus, Search, Settings, User, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useCurrentSite } from '@/hooks/useCurrentSite';
import { createSite, type Site } from '@/hooks/useFirestore';
import { useUserManagement } from '@/hooks/useUserManagement';
import { siteSettingsPath } from '@/lib/siteSettingsPath';
import { toast } from '@/lib/toast';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { CompactButton } from '@/components/admin/CompactButton';
import { StatChip } from '@/components/admin/StatChip';
import { CreateSiteDialog } from '@/components/CreateSiteDialog';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { highlightMatch } from './highlightMatch';

function SkeletonRows() {
  return (
    <ul aria-hidden="true" className="divide-y divide-border">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex items-center gap-4 px-3 py-3.5 sm:px-4">
          <span className="flex-1 space-y-2">
            <span className="block h-3.5 w-1/3 rounded bg-muted motion-safe:animate-pulse" />
            <span className="block h-3 w-1/2 rounded bg-muted motion-safe:animate-pulse" />
          </span>
          <span className="h-3 w-10 rounded bg-muted motion-safe:animate-pulse" />
        </li>
      ))}
    </ul>
  );
}

async function copySiteId(siteId: string) {
  try {
    await navigator.clipboard.writeText(siteId);
    toast.success('site ID copied');
  } catch {
    toast.error('could not copy the site ID');
  }
}

// one grid, two shapes, as the issue list. a phone: the name and the gear on the
// first line, then id · timezone · role. md up: one row of columns, where the
// second line's box drops out (display: contents) so each of its cells takes a column
function SiteRow({
  site,
  current,
  query,
  access,
  administered,
}: {
  site: Site;
  current: boolean;
  query: string;
  /** the caller's role on the site, or for a superadmin its owner */
  access: ReactNode;
  administered: boolean;
}) {
  return (
    <li className="site-row-cv grid grid-cols-[minmax(0,1fr)_2rem] items-center gap-x-3 gap-y-1 px-3 py-2 sm:px-4 md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_2rem] md:gap-x-4">
      <div className="col-[1] row-[1] flex min-w-0 items-center gap-2">
        <span className="min-w-0 text-sm font-medium text-foreground max-md:wrap-anywhere md:truncate">
          {highlightMatch(site.name, query)}
        </span>
        {/* ink by day: cyan glyphs on a cyan tint miss aa, as with the match highlight */}
        {current && (
          <span className="shrink-0 rounded bg-accent-cyan/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground dark:text-accent-cyan">
            current
          </span>
        )}
      </div>
      <div className="col-[1/3] row-[2] flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground md:contents">
        <button
          type="button"
          onClick={() => void copySiteId(site.id)}
          aria-label={`copy site ID ${site.id}`}
          className="min-w-0 max-w-full cursor-pointer truncate text-left font-mono hover:text-accent-cyan md:col-[2] md:row-[1] md:justify-self-start"
        >
          {highlightMatch(site.id, query)}
        </button>
        <span aria-hidden="true" className="md:hidden">·</span>
        <span className="min-w-0 truncate md:col-[3] md:row-[1]">{highlightMatch(site.timezone || 'UTC', query)}</span>
        <span aria-hidden="true" className="md:hidden">·</span>
        <span className="min-w-0 md:col-[4] md:row-[1]">{access}</span>
      </div>
      {/* a row without a gear keeps the cell, so the columns line up */}
      <div className="col-[2] row-[1] flex justify-end md:col-[5]">
        {administered ? (
          <IconButton asChild label={`settings for ${site.name}`} variant="ghost" size="icon-sm">
            <Link href={siteSettingsPath(site.id)}>
              <Settings className="h-4 w-4" />
            </Link>
          </IconButton>
        ) : (
          <span aria-hidden="true" className="size-8" />
        )}
      </div>
    </li>
  );
}

/** admin panel → sites: the caller's sites (every site, for a superadmin), with a gear on each one they administer. */
export function SiteList() {
  const router = useRouter();
  const { user, isSuperadmin, isSiteAdmin, isSiteOwner } = useAuth();
  const { sites, sitesLoading, sitesError, currentSiteId } = useCurrentSite();
  const [filter, setFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // the owner comes from the legacy `sites/{id}.owner` field: a member-row read for
  // every row would cost more than the column is worth
  const { users } = useUserManagement(isSuperadmin);
  const ownerEmailByUid = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users) {
      if (u.uid && u.email) map.set(u.uid, u.email);
    }
    return map;
  }, [users]);

  // the filter shows only with two or more sites, so a hidden one never narrows the list
  const query = sites.length > 1 ? filter.trim() : '';

  const shownSites = useMemo(() => {
    const q = query.toLowerCase();
    const matched = !q
      ? sites
      : sites.filter((s) => {
          const ownerEmail = isSuperadmin && s.owner ? ownerEmailByUid.get(s.owner) || s.owner : '';
          return (
            s.name.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (s.timezone || 'UTC').toLowerCase().includes(q) ||
            ownerEmail.toLowerCase().includes(q)
          );
        });
    return [...matched].sort((a, b) => {
      if (a.id === currentSiteId) return -1;
      if (b.id === currentSiteId) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [sites, query, isSuperadmin, ownerEmailByUid, currentSiteId]);

  const accessFor = (site: Site): ReactNode => {
    if (!isSuperadmin) return isSiteOwner(site.id) ? 'owner' : isSiteAdmin(site.id) ? 'admin' : 'member';
    if (!site.owner) {
      return (
        <span className="text-muted-foreground/80" title="no owner recorded">
          <span aria-hidden="true">—</span>
          <span className="sr-only">no owner recorded</span>
        </span>
      );
    }
    if (site.owner === user?.uid) return 'you';
    const email = ownerEmailByUid.get(site.owner) || site.owner;
    return (
      // full-strength amber by day: at 80% it misses aa on a light row
      <span className="flex min-w-0 items-center gap-1 text-warning dark:text-warning/80" title={email}>
        <User className="h-3 w-3 shrink-0" />
        <span className="truncate">{highlightMatch(email, query)}</span>
      </span>
    );
  };

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        <AdminPageHeader
          className="mb-4 md:mb-6 md:flex-wrap md:gap-x-6 md:gap-y-4"
          title="sites"
          description="the sites you belong to. a site's gear opens its settings."
          actions={<CompactButton icon={Plus} label="new site" onClick={() => setCreateOpen(true)} />}
          toolbar={
            <>
              {/* no autofocus: on a phone it would raise the keyboard */}
              {sites.length > 1 && (
                <div className="relative min-w-0 flex-1 md:w-64 md:flex-none">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={filterInputRef}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setFilter('');
                    }}
                    placeholder="filter sites…"
                    aria-label="filter sites"
                    autoComplete="off"
                    className="border-border bg-card pl-9 pr-8 text-foreground"
                  />
                  {filter && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilter('');
                        filterInputRef.current?.focus();
                      }}
                      aria-label="clear filter"
                      className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              <StatChip icon={Building2} iconTone="bg-accent-cyan text-primary-foreground" count={sites.length} label="sites" />
            </>
          }
        />

        {sitesError && (
          <div role="alert" className="mb-4 bg-danger-surface border border-danger-border rounded-lg p-4 text-danger">
            {sitesError}
          </div>
        )}

        {query && (
          <p className="mb-2 text-xs text-muted-foreground">
            showing {shownSites.length} of {sites.length} sites
          </p>
        )}

        {/* an error with no sites is not "no sites yet": that would read as an empty account */}
        {(sitesLoading || sites.length > 0 || !sitesError) && (
          <div className="overflow-hidden rounded-xl border border-border bg-card" aria-busy={sitesLoading}>
            {sitesLoading ? (
              <>
                <span className="sr-only">loading sites</span>
                <SkeletonRows />
              </>
            ) : sites.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-12 text-center">
                <Building2 className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">no sites yet</p>
                <p className="mt-1 text-sm text-muted-foreground">create one with new site.</p>
              </div>
            ) : shownSites.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-12 text-center">
                <Search className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">no sites match “{query}”</p>
              </div>
            ) : (
              <ul aria-label="sites" className="divide-y divide-border">
                {shownSites.map((site) => (
                  <SiteRow
                    key={site.id}
                    site={site}
                    current={site.id === currentSiteId}
                    query={query}
                    access={accessFor(site)}
                    administered={isSiteAdmin(site.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}

        <CreateSiteDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreateSite={createSite}
          onSiteCreated={(id) => router.push(siteSettingsPath(id))}
        />
      </div>
    </div>
  );
}
