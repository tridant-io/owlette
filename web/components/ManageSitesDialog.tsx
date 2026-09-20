'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Pencil, Trash2, Check, X, Plus, User, Search, ChevronDown } from 'lucide-react';
import { toast } from '@/lib/toast';
import { TimezoneSelect } from '@/components/TimezoneSelect';
import { SiteMachinesList } from '@/components/SiteMachinesList';
import { useUserManagement } from '@/hooks/useUserManagement';
import { useAuth } from '@/contexts/AuthContext';
import { useScrollFade } from '@/hooks/useScrollFade';
import { useSwoopSettings } from '@/hooks/useSwoopSettings';
import { Switch } from '@/components/ui/switch';

interface Site {
  id: string;
  name: string;
  timezone?: string;
  owner?: string;
}

// Highlight matches so filtered rows show WHY they matched.
function highlightMatch(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const idx = lower.indexOf(lowerQ, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="rounded-[2px] bg-accent-cyan/25 font-semibold text-accent-cyan">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts;
}

/**
 * Site-wide swoop switch. Off is the safe state and the default, and turning it
 * off reaches machines that are already connected — the api tells every online
 * machine to re-dial, and their next doorbell request is refused.
 */
function SwoopSiteToggle({ siteId }: { siteId: string }) {
  const { settings, loading } = useSwoopSettings(siteId);
  const [busy, setBusy] = useState(false);

  const setEnabled = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/swoop-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'failed to update swoop');
      }
      // The switch itself follows the snapshot, so only the failure needs saying.
    } catch (err) {
      console.error('Failed to update swoop settings:', err);
      toast.error(err instanceof Error ? err.message : 'failed to update swoop');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
      <div className="space-y-0.5">
        <Label htmlFor={`swoop-${siteId}`} className="text-white">
          swoop
        </Label>
        <p className="text-xs text-muted-foreground">
          let admins watch and control this site&apos;s machines remotely
        </p>
      </div>
      <Switch
        id={`swoop-${siteId}`}
        checked={settings.enabled}
        onCheckedChange={(next) => void setEnabled(next)}
        disabled={busy || loading}
      />
    </div>
  );
}

interface ManageSitesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: Site[];
  currentSiteId: string;
  /** Count for the CURRENT site only. Present => the "machines" column shows,
   * with other sites' cells blank until expanded. Omit to hide the column. */
  machineCount?: number;
  currentUserId?: string;
  isSuperadmin?: boolean;
  onUpdateSite: (siteId: string, updates: { name?: string; timezone?: string }) => Promise<void>;
  onDeleteSite: (siteId: string) => Promise<void>;
  onCreateSite: () => void;
}

export function ManageSitesDialog({
  open,
  onOpenChange,
  sites,
  currentSiteId,
  machineCount,
  currentUserId,
  isSuperadmin = false,
  onUpdateSite,
  onDeleteSite,
  onCreateSite,
}: ManageSitesDialogProps) {
  // The list dissolves under the dialog header rather than being cut by it.
  const listRef = useScrollFade<HTMLDivElement>();

  // Owner-only controls resolve from the role map, not `sites/{id}.owner`:
  // wave 6.1 strips that field, and a control gated on it would silently vanish.
  const { isSiteOwner, isSiteAdmin } = useAuth();

  // Superadmin only: resolve owner UIDs to emails for foreign sites.
  const { users: allUsers } = useUserManagement(Boolean(isSuperadmin));
  const ownerEmailByUid = useMemo(() => {
    if (!isSuperadmin) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const u of allUsers) {
      if (u.uid && u.email) map.set(u.uid, u.email);
    }
    return map;
  }, [allUsers, isSuperadmin]);
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingTimezone, setEditingTimezone] = useState('UTC');
  const [deletingDialogOpen, setDeletingDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [filter, setFilter] = useState('');
  const filterInputRef = useRef<HTMLInputElement>(null);
  // One expanded machines panel at a time, accordion-style like editing.
  const [expandedSiteId, setExpandedSiteId] = useState<string | null>(null);
  // Reported by expanded panels, so non-current sites gain a count once fetched.
  const [machineCounts, setMachineCounts] = useState<Record<string, number>>({});
  const handleMachineCountLoaded = useCallback((siteId: string, count: number) => {
    setMachineCounts((prev) => (prev[siteId] === count ? prev : { ...prev, [siteId]: count }));
  }, []);

  useEffect(() => {
    if (!open) {
      setEditingSiteId(null);
      setEditingName('');
      setEditingTimezone('UTC');
      setFilter('');
      setExpandedSiteId(null);
      setMachineCounts({});
    }
  }, [open]);

  // name / id / timezone / owner email, case-insensitive.
  const filteredSites = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = !q
      ? sites
      : sites.filter((s) => {
          const ownerEmail = s.owner ? ownerEmailByUid.get(s.owner) ?? s.owner : '';
          return (
            s.name.toLowerCase().includes(q) ||
            s.id.toLowerCase().includes(q) ||
            (s.timezone || 'UTC').toLowerCase().includes(q) ||
            ownerEmail.toLowerCase().includes(q)
          );
        });
    // Current site pinned to the top, rest alphabetical.
    return [...matched].sort((a, b) => {
      if (a.id === currentSiteId) return -1;
      if (b.id === currentSiteId) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }, [sites, filter, ownerEmailByUid, currentSiteId]);

  const startEditingSite = (site: Site) => {
    setEditingSiteId(site.id);
    setEditingName(site.name);
    setEditingTimezone(site.timezone || 'UTC');
  };

  const cancelEditingSite = () => {
    setEditingSiteId(null);
    setEditingName('');
    setEditingTimezone('UTC');
  };

  const handleSaveSite = async (siteId: string) => {
    if (!editingName.trim()) {
      toast.error('Site name cannot be empty');
      return;
    }

    const site = sites.find(s => s.id === siteId);
    if (!site) return;

    const nameChanged = editingName.trim() !== site.name;
    const timezoneChanged = editingTimezone !== (site.timezone || 'UTC');

    if (!nameChanged && !timezoneChanged) {
      cancelEditingSite();
      return;
    }

    setIsSaving(true);
    try {
      const updates: { name?: string; timezone?: string } = {};
      if (nameChanged) updates.name = editingName.trim();
      if (timezoneChanged) updates.timezone = editingTimezone;

      await onUpdateSite(siteId, updates);
      toast.success('Site updated successfully!');
      cancelEditingSite();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to update site');
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDeleteSite = (siteId: string) => {
    setSiteToDelete(siteId);
    setDeletingDialogOpen(true);
  };

  const handleDeleteSite = async () => {
    if (!siteToDelete) return;

    // No "cannot delete the last site" guard. It existed only here, in the
    // browser, so the API, the CLI and any script ignored it — a guard that reads
    // as enforced and is not. Having zero sites is a supported state: the
    // dashboard has a first-run empty state and every self-serve user starts
    // there. Decided 2026-09-04; see dev/active/per-site-roles/.
    try {
      await onDeleteSite(siteToDelete);
      toast.success('Site deleted successfully!');
      setDeletingDialogOpen(false);
      setSiteToDelete(null);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message || 'Failed to delete site');
    }
  };

  // One template shared by header and rows so they align. Actions is a fixed
  // 96px so the fr columns resolve identically in both. Order:
  // name | id | timezone | machines? | owner? | actions — machines only when
  // the caller supplies a count, owner only for superadmins.
  const showMachines = machineCount !== undefined;
  const columns = ['minmax(0,2.2fr)', 'minmax(0,1.6fr)', 'minmax(0,1.2fr)']; // name, id, timezone
  if (showMachines) columns.push('minmax(0,0.9fr)'); // machines
  if (isSuperadmin) columns.push('minmax(0,1.6fr)'); // owner
  columns.push('96px'); // actions
  const gridTemplate = columns.join(' ');

  // Current site's count comes from the prop; others appear once expanded.
  const machineCountLabel = (siteId: string): string => {
    const count = siteId === currentSiteId ? machineCount ?? 0 : machineCounts[siteId];
    if (count === undefined) return '';
    return `${count} machine${count === 1 ? '' : 's'}`;
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="border-border bg-secondary text-white sm:max-w-5xl"
          onOpenAutoFocus={(e) => {
            // Search-first: focus the filter, not the first button.
            if (filterInputRef.current) {
              e.preventDefault();
              filterInputRef.current.focus();
            }
          }}
          onEscapeKeyDown={(e) => {
            // Esc steps back: cancel edit, else clear filter, else close.
            if (editingSiteId) {
              e.preventDefault();
              cancelEditingSite();
            } else if (filter.trim()) {
              e.preventDefault();
              setFilter('');
            }
          }}
        >
          <DialogHeader>
            {/* Wraps below sm: the search cluster takes its own line instead of
                inflating the dialog's min-content — which used to push every
                row's actions column off-screen on phones. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <DialogTitle className="text-white">manage sites</DialogTitle>
              {/* Search, "new site", and close share one centered flex row with
                  the title so all four header controls sit on one axis. gap-6
                  keeps the close ✕ equidistant from its neighbor and the
                  panel edge (the p-6 gutter is also 24px). */}
              <div className="flex min-w-0 grow items-center justify-end gap-6">
                {sites.length > 1 && (
                  <div className="relative min-w-0 w-full max-w-64">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={filterInputRef}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="filter sites…"
                      aria-label="filter sites"
                      autoComplete="off"
                      className="border-border bg-accent pl-9 pr-8 text-white"
                    />
                    {filter && (
                      <button
                        type="button"
                        onClick={() => {
                          setFilter('');
                          filterInputRef.current?.focus();
                        }}
                        aria-label="clear filter"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-white cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    onCreateSite();
                  }}
                  className="shrink-0 cursor-pointer text-gray-900"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  new site
                </Button>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="close"
                  className="shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:text-white hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <DialogDescription className="text-muted-foreground">
                edit site names, timezones, or delete sites
              </DialogDescription>
              {filter.trim() && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  showing {filteredSites.length} of {sites.length} sites
                </span>
              )}
            </div>
          </DialogHeader>

          <div ref={listRef} className="mt-3 max-h-[60vh] space-y-1.5 overflow-y-auto">
            {filteredSites.length === 0 ? (
              <p className="rounded-lg border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
                no sites match “{filter.trim()}”
              </p>
            ) : (
              <>
                {/* Column header — sticky so it stays put while the list scrolls;
                    same grid template as the rows so the columns line up. */}
                <div
                  className="sticky top-0 z-10 grid items-center gap-3 border-b border-border/60 bg-secondary px-3 pb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <span className="min-w-0 truncate">site</span>
                  <span className="min-w-0 truncate">id</span>
                  <span className="min-w-0 truncate">timezone</span>
                  {showMachines && <span className="min-w-0 truncate">machines</span>}
                  {isSuperadmin && <span className="min-w-0 truncate">owner</span>}
                  <span aria-hidden="true" />
                </div>

                {filteredSites.map((site) => (
                  <div
                    key={site.id}
                    className={`site-row-cv overflow-hidden rounded-lg border transition-colors ${
                      site.id === currentSiteId
                        ? 'border-accent-cyan/60 bg-accent-cyan/10'
                        : 'border-border bg-card hover:bg-muted'
                    }`}
                  >
                    {/* View row — aligned column grid. Stays visible while
                        editing so the panel below is unambiguously attached
                        to the site being edited. */}
                      <div className="grid items-center gap-3 px-3 py-2" style={{ gridTemplateColumns: gridTemplate }}>
                        {/* name */}
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-white">{highlightMatch(site.name, filter)}</span>
                          {site.id === currentSiteId && (
                            <span className="shrink-0 rounded bg-accent-cyan/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-cyan">
                              current
                            </span>
                          )}
                        </div>

                        {/* id — click to copy */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await navigator.clipboard.writeText(site.id);
                                  toast.success('Site ID copied!');
                                } catch {
                                  toast.error('Failed to copy Site ID');
                                }
                              }}
                              className="min-w-0 cursor-pointer truncate text-left font-mono text-[11px] text-muted-foreground hover:text-accent-cyan"
                            >
                              {highlightMatch(site.id, filter)}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>copy site id</p>
                          </TooltipContent>
                        </Tooltip>

                        {/* timezone */}
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                          {highlightMatch(site.timezone || 'UTC', filter)}
                        </span>

                        {/* machines — count only for the current site (the only
                            one whose machines are loaded); blank for the rest */}
                        {showMachines && (
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                            {machineCountLabel(site.id)}
                          </span>
                        )}

                        {/* owner — superadmin only */}
                        {isSuperadmin && (
                          site.owner && currentUserId && site.owner !== currentUserId ? (
                            <span
                              className="flex min-w-0 items-center gap-1 text-[11px] text-amber-400/80"
                              title={ownerEmailByUid.get(site.owner) || site.owner}
                            >
                              <User className="h-3 w-3 shrink-0" />
                              <span className="truncate">{highlightMatch(ownerEmailByUid.get(site.owner) || site.owner, filter)}</span>
                            </span>
                          ) : site.owner && currentUserId && site.owner === currentUserId ? (
                            <span className="text-[11px] text-muted-foreground">you</span>
                          ) : (
                            <span className="text-[11px] text-muted-foreground/40" title="no owner recorded">
                              —
                            </span>
                          )
                        )}

                        {/* actions */}
                        <div className="flex items-center justify-end gap-0.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setExpandedSiteId(expandedSiteId === site.id ? null : site.id)}
                                aria-label={`machines on ${site.name}`}
                                aria-expanded={expandedSiteId === site.id}
                                className={`h-7 w-7 p-0 hover:bg-muted hover:text-accent-cyan cursor-pointer ${
                                  expandedSiteId === site.id ? 'text-accent-cyan' : 'text-muted-foreground'
                                }`}
                              >
                                <ChevronDown
                                  className={`h-4 w-4 transition-transform duration-150 ease-out motion-reduce:transition-none ${
                                    expandedSiteId === site.id ? '-rotate-180' : 'rotate-0'
                                  }`}
                                />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{expandedSiteId === site.id ? 'hide machines' : 'view machines'}</p>
                            </TooltipContent>
                          </Tooltip>
                          {/* Site-admin only: renaming a site is a PATCH gated on
                              SITE_MEMBER_MANAGE, which the matrix grants to admin
                              and owner but not member. Same reason as delete —
                              offering an action the server will refuse reads as a
                              fault rather than a boundary. */}
                          {isSiteAdmin(site.id) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    editingSiteId === site.id ? cancelEditingSite() : startEditingSite(site)
                                  }
                                  aria-label={`edit ${site.name}`}
                                  aria-expanded={editingSiteId === site.id}
                                  className={`h-7 w-7 p-0 hover:bg-muted hover:text-accent-cyan cursor-pointer ${
                                    editingSiteId === site.id ? 'text-accent-cyan' : 'text-muted-foreground'
                                  }`}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{editingSiteId === site.id ? 'close editor' : 'edit site'}</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {/* Owner-only, matching the server: SITE_DELETE sits on
                              the owner row of the capability matrix and nowhere
                              else. It used to render for everyone and answer with
                              a raw "capability not granted" toast — an action
                              offered and then refused, which reads as a fault
                              rather than a boundary. */}
                          {isSiteOwner(site.id) && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => confirmDeleteSite(site.id)}
                                  aria-label={`delete ${site.name}`}
                                  className="h-7 w-7 p-0 text-muted-foreground hover:bg-muted hover:text-red-400 cursor-pointer"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>delete site</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>

                    {/* Edit panel — attached beneath the row inside the same
                        card so the site being edited stays visible above its
                        own form. Name + timezone share one line (wrapping on
                        narrow screens) to keep the panel short. */}
                    {editingSiteId === site.id && (
                      <div className="animate-in slide-in-from-top-2 fade-in duration-200 border-t border-border/60 p-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="min-w-40 grow space-y-1.5">
                            <Label htmlFor={`name-${site.id}`} className="text-muted-foreground text-sm">
                              site name
                            </Label>
                            <Input
                              id={`name-${site.id}`}
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveSite(site.id);
                              }}
                              className="border-border bg-accent text-white"
                              autoFocus
                            />
                          </div>
                          <div className="min-w-40 grow space-y-1.5">
                            <Label htmlFor={`timezone-${site.id}`} className="text-muted-foreground text-sm">
                              timezone
                            </Label>
                            <TimezoneSelect
                              id={`timezone-${site.id}`}
                              value={editingTimezone}
                              onValueChange={setEditingTimezone}
                              className="border-border bg-accent text-white"
                            />
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={cancelEditingSite}
                              disabled={isSaving}
                              className="bg-secondary border border-border cursor-pointer"
                            >
                              <X className="h-4 w-4 mr-1" />
                              cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => handleSaveSite(site.id)}
                              disabled={isSaving}
                              className="text-gray-900 cursor-pointer"
                            >
                              <Check className="h-4 w-4 mr-1" />
                              {isSaving ? 'saving...' : 'save'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Machines panel — expanded via the row chevron; lists
                        this site's machines with support actions so an admin
                        can act when things go wrong for a customer. */}
                    {expandedSiteId === site.id && (
                      <div className="animate-in slide-in-from-top-2 fade-in duration-200 border-t border-border/60">
                        {isSiteAdmin(site.id) && <SwoopSiteToggle siteId={site.id} />}
                        <SiteMachinesList siteId={site.id} onCountLoaded={handleMachineCountLoaded} />
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deletingDialogOpen} onOpenChange={setDeletingDialogOpen}>
        <DialogContent className="border-border bg-secondary text-white">
          <DialogHeader>
            <DialogTitle className="text-white">delete site</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              are you sure you want to delete this site? this action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {siteToDelete && (
            <div className="py-4">
              <p className="text-white">
                site: <span className="font-semibold">{sites.find(s => s.id === siteToDelete)?.name}</span>
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                note: the site document will be deleted, but machine data may remain in Firestore.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setDeletingDialogOpen(false);
                setSiteToDelete(null);
              }}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleDeleteSite}
              className="bg-red-600 hover:bg-red-700 text-white cursor-pointer"
            >
              delete site
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
