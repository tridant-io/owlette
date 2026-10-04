'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, X, Loader2, Search } from 'lucide-react';
import { toast } from '@/lib/toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { NO_SUCCESSOR, TalonSuccessorPicker } from '@/components/TalonSuccessorPicker';
import { useSites } from '@/hooks/useFirestore';
import { useAuth } from '@/contexts/AuthContext';
import { useTalonReassign, type AuthoredTalon } from '@/hooks/useTalonReassign';
import { eligibleTalonSuccessors, type TalonSuccessorUser } from '@/lib/talonSuccessors';
import type { UserRole } from '@/hooks/useUserManagement';

interface ManageUserSitesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userEmail: string;
  userRole: UserRole;
  userSites: string[];
  /**
   * Everyone on the platform, so removal can offer a successor for this user's
   * talons. Passed down from the users page to avoid a second listener on a
   * superadmin-only collection.
   */
  allUsers?: readonly TalonSuccessorUser[];
  onAssignSite: (userId: string, siteId: string) => Promise<void>;
  onRemoveSite: (userId: string, siteId: string) => Promise<void>;
}

/** A pending site removal, held open while the operator answers for the talons. */
interface PendingRemoval {
  siteId: string;
  siteName: string;
  talons: AuthoredTalon[];
}

export function ManageUserSitesDialog({
  open,
  onOpenChange,
  userId,
  userEmail,
  userRole,
  userSites,
  allUsers,
  onAssignSite,
  onRemoveSite,
}: ManageUserSitesDialogProps) {
  const { user, isSuperadmin, userSites: adminSites } = useAuth();
  const { sites, loading: sitesLoading } = useSites(user?.uid, adminSites, isSuperadmin);
  const [assigningTo, setAssigningTo] = useState<string | null>(null);
  const [removingFrom, setRemovingFrom] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { fetchSiteAuthored, reassignSiteTalons } = useTalonReassign();
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [successorUid, setSuccessorUid] = useState<string>(NO_SUCCESSOR);

  const [localUserSites, setLocalUserSites] = useState<string[]>(userSites);

  // Re-sync when the dialog reopens with fresh data.
  useEffect(() => {
    setLocalUserSites(userSites);
  }, [userSites]);

  // Reset search when the dialog closes.
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
    }
  }, [open]);

  // Admins who could take over the talons on the site being given up. Scoped
  // to that site, so the picker can't offer someone the API will refuse.
  const successorCandidates = useMemo(
    () =>
      eligibleTalonSuccessors(allUsers ?? [], {
        siteId: pendingRemoval?.siteId,
        excludeUid: userId,
      }),
    [allUsers, pendingRemoval?.siteId, userId],
  );

  const handleAssignSite = async (siteId: string) => {
    setAssigningTo(siteId);

    setLocalUserSites(prev => [...prev, siteId]);

    try {
      await onAssignSite(userId, siteId);
      toast.success('Site Assigned', {
        description: `${userEmail} now has access to this site.`,
      });
    } catch (err: unknown) {
      // Revert optimistic update on error
      setLocalUserSites(prev => prev.filter(id => id !== siteId));
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Assignment Failed', {
        description: message || 'Failed to assign site to user.',
      });
    } finally {
      setAssigningTo(null);
    }
  };

  /**
   * Ask about the talons first: a talon run re-resolves its AUTHOR's site access,
   * so removing access silently breaks any automation they wrote. Look the damage
   * up before acting, and go straight through only when there is none.
   */
  const handleRemoveSiteClick = async (siteId: string, siteName: string) => {
    setRemovingFrom(siteId);
    try {
      const authored = await fetchSiteAuthored(siteId, userId);
      if (authored.count === 0) {
        await removeSite(siteId);
        return;
      }
      setSuccessorUid(NO_SUCCESSOR);
      setPendingRemoval({ siteId, siteName, talons: authored.talons });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Removal Failed', {
        description: message || 'Failed to check this user’s talons.',
      });
    } finally {
      setRemovingFrom(null);
    }
  };

  const removeSite = async (siteId: string) => {
    setRemovingFrom(siteId);

    setLocalUserSites(prev => prev.filter(id => id !== siteId));

    try {
      await onRemoveSite(userId, siteId);
      toast.success('Site Removed', {
        description: `${userEmail} no longer has access to this site.`,
      });
    } catch (err: unknown) {
      // Revert optimistic update on error
      setLocalUserSites(prev => [...prev, siteId]);
      const message = err instanceof Error ? err.message : String(err);
      toast.error('Removal Failed', {
        description: message || 'Failed to remove site from user.',
      });
    } finally {
      setRemovingFrom(null);
    }
  };

  /**
   * Reassign before removing — never after. If the reassignment fails the
   * member keeps their access, which is recoverable; the reverse order would
   * leave automations pointing at someone who has already lost it.
   */
  const handleConfirmRemoval = async () => {
    if (!pendingRemoval) return;
    const { siteId } = pendingRemoval;
    setPendingRemoval(null);

    if (successorUid !== NO_SUCCESSOR) {
      setRemovingFrom(siteId);
      try {
        const { reassignedTalonIds } = await reassignSiteTalons(siteId, userId, successorUid);
        toast.success('Talons Reassigned', {
          description: `${reassignedTalonIds.length} talon${
            reassignedTalonIds.length === 1 ? '' : 's'
          } moved to a new owner.`,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error('Reassignment Failed', {
          description: message || 'Site access was left unchanged.',
        });
        setRemovingFrom(null);
        return;
      }
      setRemovingFrom(null);
    }

    await removeSite(siteId);
  };

  const filterSites = (siteList: typeof sites) => {
    if (!searchQuery.trim()) return siteList;
    const query = searchQuery.toLowerCase();
    return siteList.filter(site =>
      site.name.toLowerCase().includes(query) ||
      site.id.toLowerCase().includes(query)
    );
  };

  const assignedSites = filterSites(sites.filter((site) => localUserSites.includes(site.id)));
  const availableSites = filterSites(sites.filter((site) => !localUserSites.includes(site.id)));

  // Find orphaned site IDs (in user's array but don't exist in sites collection)
  const validSiteIds = sites.map(s => s.id);
  const orphanedSiteIds = localUserSites.filter((siteId) => !validSiteIds.includes(siteId));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="border-border text-foreground sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-foreground">manage site access</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              control which sites {userEmail} can access
            </DialogDescription>
          </DialogHeader>

          {/* Superadmins reach every site by global role. A global `admin` does
              NOT — since the per-site-roles migration it grants nothing on a site
              it holds no membership row for, and this callout previously told
              operators the opposite. */}
          {userRole === 'superadmin' && (
            <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-3 mt-4">
              <p className="text-accent-cyan text-sm">
                <strong className="font-semibold">superadmin:</strong> this user reaches <strong>every site</strong> by their platform role, regardless of the assignments below.
              </p>
            </div>
          )}
          {userRole === 'admin' && (
            <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-3 mt-4">
              <p className="text-accent-cyan text-sm">
                <strong className="font-semibold">note:</strong> the account-level admin role grants nothing on a site on its own. access comes from the site assignments below, and a per-site role is set from that site&apos;s members page.
              </p>
            </div>
          )}

          {/* Search Filter */}
          {!sitesLoading && sites.length > 0 && (
            <div className="relative mt-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="search sites by name or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 border-border bg-background text-foreground placeholder:text-muted-foreground"
              />
            </div>
          )}

          {sitesLoading ? (
            <div className="flex justify-center items-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-accent-cyan" />
              <span className="ml-2 text-muted-foreground">loading sites...</span>
            </div>
          ) : (
            <div className="space-y-6 py-4 max-h-[60vh] overflow-y-auto pr-2">
              {/* Assigned Sites */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  assigned sites ({assignedSites.length})
                </h3>
                {assignedSites.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground bg-background rounded-lg border border-border">
                    {searchQuery ? 'no assigned sites match your search' : 'no sites assigned yet'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {assignedSites.map((site) => (
                      <div
                        key={site.id}
                        className="flex items-center justify-between p-3 bg-background rounded-lg border border-border"
                      >
                        <div className="flex-1">
                          <p className="text-foreground font-medium">{site.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{site.id}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost-destructive"
                          onClick={() => handleRemoveSiteClick(site.id, site.name)}
                          disabled={removingFrom === site.id}
                          className="cursor-pointer"
                        >
                          {removingFrom === site.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Orphaned/Invalid Site References */}
              {orphanedSiteIds.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-danger mb-3">
                    invalid site references ({orphanedSiteIds.length})
                  </h3>
                  <div className="space-y-2">
                    <div className="text-xs text-muted-foreground mb-2 p-2 bg-danger-surface border border-danger-border rounded">
                      these site IDs are in the user&apos;s access list but the sites no longer exist or are inaccessible. remove them to fix the site count.
                    </div>
                    {orphanedSiteIds.map((siteId) => (
                      <div
                        key={siteId}
                        className="flex items-center justify-between p-3 bg-danger-surface rounded-lg border border-danger-border"
                      >
                        <div className="flex-1">
                          <p className="text-danger font-medium">invalid/orphaned site</p>
                          <p className="text-xs text-danger font-mono">{siteId}</p>
                        </div>
                        {/* Straight to the removal: the site document is gone, so
                            there is nothing to look talons up on. */}
                        <Button
                          size="sm"
                          variant="ghost-destructive"
                          onClick={() => removeSite(siteId)}
                          disabled={removingFrom === siteId}
                          className="cursor-pointer"
                        >
                          {removingFrom === siteId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <X className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Available Sites */}
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  available sites ({availableSites.length})
                </h3>
                {availableSites.length === 0 && searchQuery ? (
                  <div className="text-center py-6 text-muted-foreground bg-background rounded-lg border border-border">
                    no available sites match your search
                  </div>
                ) : availableSites.length > 0 ? (
                  <div className="space-y-2">
                    {availableSites.map((site) => (
                      <div
                        key={site.id}
                        className="flex items-center justify-between p-3 bg-background rounded-lg border border-border hover:border-accent-cyan/30 transition-colors"
                      >
                        <div className="flex-1">
                          <p className="text-foreground font-medium">{site.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">{site.id}</p>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleAssignSite(site.id)}
                          disabled={assigningTo === site.id}
                          className="border border-accent-cyan/50 text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan cursor-pointer"
                        >
                          {assigningTo === site.id ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              assigning...
                            </>
                          ) : (
                            <>
                              <Plus className="h-4 w-4 mr-2" />
                              assign
                            </>
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )}

          {!sitesLoading && sites.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <p>no sites available yet.</p>
              <p className="text-sm mt-2">create a site first from the dashboard.</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Sibling of the sites dialog, not a child of it — same shape as the
          delete confirmation in ManageSitesDialog. Only reached when this user
          actually authored talons on the site being taken away; the zero case
          removes access with no extra click. */}
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(next) => {
          if (!next) setPendingRemoval(null);
        }}
        title="remove site access"
        description={`${userEmail} still owns automations on ${pendingRemoval?.siteName ?? 'this site'}.`}
        confirmText={successorUid === NO_SUCCESSOR ? 'remove anyway' : 'reassign and remove'}
        cancelText="cancel"
        variant="destructive"
        onConfirm={handleConfirmRemoval}
      >
        <TalonSuccessorPicker
          count={pendingRemoval?.talons.length ?? 0}
          talonNames={(pendingRemoval?.talons ?? []).map((talon) => talon.name)}
          consequence="they lose access to this site"
          candidates={successorCandidates}
          value={successorUid}
          onChange={setSuccessorUid}
          idPrefix="member-removal"
        />
      </ConfirmDialog>
    </>
  );
}
