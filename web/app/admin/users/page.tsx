'use client';

import { useState, useEffect, useMemo } from 'react';
import { useUserManagement, type UserRole } from '@/hooks/useUserManagement';
import { useDevicePrefFlag } from '@/hooks/useDevicePrefFlag';
import type { FirestoreTs } from '@/hooks/useFirestore';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Users, Shield, ShieldAlert, ShieldOff, Crown, Loader2, Settings, MoreVertical, UserCog, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { useAuth } from '@/contexts/AuthContext';
import { ManageUserSitesDialog } from '@/components/ManageUserSitesDialog';
import { NO_SUCCESSOR, TalonSuccessorPicker } from '@/components/TalonSuccessorPicker';
import { useTalonReassign, type UserAuthoredTalons } from '@/hooks/useTalonReassign';
import { eligibleTalonSuccessors } from '@/lib/talonSuccessors';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * User-facing summary of `RoleCapabilityMatrix` in `@/lib/capabilities`. Keep in
 * sync with it: any change to MEMBER_CAPABILITIES / SITE_ADMIN_CAPABILITIES must
 * be reflected here. Shown on the role cards and inside the change-role dialog.
 */
const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  member: 'read-only access to assigned sites — view machines, capture screenshots, open live view, and set their own alert preferences. no commands, no config edits.',
  admin: 'site-scoped elevated tier — everything a member can do, plus dispatch commands and restarts, edit machine and process settings, remove machines, author talons, run deployments, and manage presets, webhooks, and members on assigned sites.',
  superadmin: 'platform-wide god-mode — every admin power on every site, plus manage users and roles, revoke agent tokens, upload installers, and configure alerts and global settings. reserve for platform operators.',
};

const ROLE_LABELS: Record<UserRole, string> = {
  member: 'member',
  admin: 'admin',
  superadmin: 'superadmin',
};

interface DeletionCounts {
  sites?: number;
  machines?: number;
  [key: string]: number | undefined;
}

interface DeletionView {
  id: string;
  uid: string | null;
  actorUid: string | null;
  capability: string;
  outcome: string;
  timestamp: string | null;
  denyReason: string | null;
  counts: DeletionCounts | null;
}

interface UserActivity {
  lastSignInTime: string | null;
  lastRefreshTime: string | null;
  disabled: boolean;
}

/**
 * Audit target id for platform-level actions with no addressable resource.
 * Admin-delete rows predating `targetIdParam` carry this instead of the deleted
 * uid, so the feed shows "user not recorded" for them.
 */
const PLATFORM_TARGET_ID = '__platform__';

/** Per-device pref field on `users/{uid}/devicePrefs/global`. */
const SHOW_DELETED_USERS_PREF = 'adminShowDeletedUsers';

/** Tally chip. In the header, not a card row, so the table keeps the height. */
function StatChip({
  icon: Icon,
  iconTone,
  count,
  label,
}: {
  icon: typeof Users;
  /** the tile's fill and the ink that sits on it */
  iconTone: string;
  count: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className={`p-1.5 rounded-md ${iconTone}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="leading-tight">
        <p className="text-lg font-bold text-foreground">{count}</p>
        <p className="text-xs text-muted-foreground whitespace-nowrap">{label}</p>
      </div>
    </div>
  );
}

/** Admin-only page for viewing users and changing their roles. */
export default function UserManagementPage() {
  const { user: currentUser, isSuperadmin } = useAuth();
  const { users, loading, error, updateUserRole, getUserCounts, assignSiteToUser, removeSiteFromUser, deleteUser } = useUserManagement(isSuperadmin);
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [manageSitesDialogOpen, setManageSitesDialogOpen] = useState(false);
  const [deleteConfirmDialogOpen, setDeleteConfirmDialogOpen] = useState(false);
  const [roleChangeDialogOpen, setRoleChangeDialogOpen] = useState(false);
  const [mfaResetDialogOpen, setMfaResetDialogOpen] = useState(false);
  const [resettingMfaUser, setResettingMfaUser] = useState<string | null>(null);
  const [userToResetMfa, setUserToResetMfa] = useState<{ uid: string; email: string } | null>(null);
  const [selectedUser, setSelectedUser] = useState<{ uid: string; email: string; role: UserRole; sites: string[] } | null>(null);
  const [userToDelete, setUserToDelete] = useState<{ uid: string; email: string } | null>(null);
  const [authoredTalons, setAuthoredTalons] = useState<UserAuthoredTalons | null>(null);
  const [successorUid, setSuccessorUid] = useState<string>(NO_SUCCESSOR);
  const [userToChangeRole, setUserToChangeRole] = useState<{ uid: string; email: string; currentRole: UserRole; newRole: UserRole } | null>(null);
  const [deletions, setDeletions] = useState<DeletionView[]>([]);
  const [deletionsLoading, setDeletionsLoading] = useState(false);
  const [activity, setActivity] = useState<Record<string, UserActivity>>({});
  const { fetchUserAuthored } = useTalonReassign();

  // The site-ownership successor also inherits the talons, so ask once. No
  // siteId — the API re-checks eligibility per site and reports refusals.
  const successorCandidates = useMemo(
    () => eligibleTalonSuccessors(users, { excludeUid: userToDelete?.uid }),
    [users, userToDelete?.uid],
  );

  // Persisted per device. Defaults to shown: silently dropping rows would
  // surprise anyone who never finds the toggle.
  const { value: showDeletedUsers, setValue: setShowDeletedUsers } = useDevicePrefFlag(
    SHOW_DELETED_USERS_PREF,
    true,
  );

  const counts = getUserCounts();

  // The chips count active accounts only, so hiding deleted rows keeps table
  // and chips consistent.
  const visibleUsers = useMemo(
    () => (showDeletedUsers ? users : users.filter((u) => u.deletedAt == null)),
    [users, showDeletedUsers],
  );

  // uid -> display label for audit rows. Soft-deleted users stay in `users`,
  // so deleted accounts still resolve.
  const userLabels = useMemo(() => {
    const map: Record<string, string> = {};
    for (const u of users) {
      map[u.uid] = u.email || u.displayName || u.uid;
    }
    return map;
  }, [users]);

  // Non-fatal: on error the panel just renders its empty state.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setDeletionsLoading(true);
      try {
        const response = await fetch('/api/users/deletions');
        if (!response.ok) {
          console.error('Error fetching account deletions:', response.status);
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setDeletions(Array.isArray(body.deletions) ? body.deletions : []);
      } catch (err) {
        console.error('Error fetching account deletions:', err);
      } finally {
        if (!cancelled) setDeletionsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Page-level, not in useUserManagement: that hook also runs in
  // ManageSitesDialog on non-superadmin pages, where this endpoint 403s.
  // Non-fatal — the column renders "never" if it fails.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch('/api/users/activity');
        if (!response.ok) {
          console.error('Error fetching user activity:', response.status);
          return;
        }
        const body = await response.json();
        if (cancelled) return;
        setActivity(body.activity ?? {});
      } catch (err) {
        console.error('Error fetching user activity:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenManageSites = (userId: string, email: string, role: UserRole, sites: string[]) => {
    setSelectedUser({ uid: userId, email, role, sites });
    setManageSitesDialogOpen(true);
  };

  const handleOpenRoleChangeDialog = (userId: string, email: string, currentRole: UserRole) => {
    // A lone superadmin must not be able to lock themselves out of this page.
    if (userId === currentUser?.uid && currentRole === 'superadmin') {
      toast.error('cannot demote yourself', {
        description: 'promote another superadmin first, then they can demote you.',
      });
      return;
    }

    // Starts equal to currentRole; the dialog supplies the new value.
    setUserToChangeRole({ uid: userId, email, currentRole, newRole: currentRole });
    setRoleChangeDialogOpen(true);
  };

  const handleSelectNewRole = (role: UserRole) => {
    setUserToChangeRole((prev) => (prev ? { ...prev, newRole: role } : prev));
  };

  const handleConfirmRoleChange = async () => {
    if (!userToChangeRole) return;
    if (userToChangeRole.newRole === userToChangeRole.currentRole) {
      // The dialog shouldn't allow this, but guard anyway.
      setRoleChangeDialogOpen(false);
      setUserToChangeRole(null);
      return;
    }

    setUpdatingUser(userToChangeRole.uid);
    setRoleChangeDialogOpen(false);

    try {
      await updateUserRole(userToChangeRole.uid, userToChangeRole.newRole);
      toast.success('role updated', {
        description: `${userToChangeRole.email} is now a ${ROLE_LABELS[userToChangeRole.newRole]}.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('update failed', {
        description: message || 'failed to update user role.',
      });
    } finally {
      setUpdatingUser(null);
      setUserToChangeRole(null);
    }
  };

  const handleOpenMfaResetDialog = (userId: string, email: string) => {
    // The API refuses this too; catching it here saves a round-trip to a 403.
    if (userId === currentUser?.uid) {
      toast.error('cannot reset your own 2FA', {
        description: 'remove your own factors from account settings, or ask another superadmin.',
      });
      return;
    }

    setUserToResetMfa({ uid: userId, email });
    setMfaResetDialogOpen(true);
  };

  const handleConfirmMfaReset = async () => {
    if (!userToResetMfa) return;

    setResettingMfaUser(userToResetMfa.uid);
    setMfaResetDialogOpen(false);

    try {
      const response = await fetch(
        `/api/users/${encodeURIComponent(userToResetMfa.uid)}/mfa-reset`,
        { method: 'POST' },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `reset failed (${response.status})`);
      }
      const result = await response.json();
      const factorsCleared =
        (result.clearedTotp ? 1 : 0) + (result.deletedPasskeys ?? 0);
      toast.success('2FA reset', {
        // Resetting an account that held nothing is legitimate — it's what a
        // retry after a partial failure looks like, not "lost 0 factors".
        description: factorsCleared === 0
          ? `${userToResetMfa.email} had no factors to remove, and will be asked to set up 2FA at next sign-in.`
          : `${userToResetMfa.email} lost ${factorsCleared} factor${
              factorsCleared === 1 ? '' : 's'
            }, and will be asked to set up 2FA at next sign-in.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('reset failed', {
        description: message || 'failed to reset 2FA for this user.',
      });
    } finally {
      setResettingMfaUser(null);
      setUserToResetMfa(null);
    }
  };

  const handleOpenDeleteDialog = (userId: string, email: string) => {
    if (userId === currentUser?.uid) {
      toast.error('cannot delete yourself', {
        description: 'you cannot delete your own account.',
      });
      return;
    }

    setUserToDelete({ uid: userId, email });
    setSuccessorUid(NO_SUCCESSOR);
    setAuthoredTalons(null);
    setDeleteConfirmDialogOpen(true);

    // Fired as the dialog opens: the operator must see what the deletion breaks
    // before confirming. Non-fatal — without it the dialog just can't warn.
    void (async () => {
      try {
        setAuthoredTalons(await fetchUserAuthored(userId));
      } catch (err) {
        console.error('Error fetching authored talons:', err);
      }
    })();
  };

  const handleConfirmDelete = async () => {
    if (!userToDelete) return;

    const successor = successorUid === NO_SUCCESSOR ? undefined : successorUid;
    setDeletingUser(userToDelete.uid);
    setDeleteConfirmDialogOpen(false);

    try {
      const result = await deleteUser(userToDelete.uid, {
        successorUid: successor,
        // Only with a chosen successor: the API refuses the bare flag, and no
        // successor means "let them lapse".
        reassignTalons: Boolean(successor) && (authoredTalons?.count ?? 0) > 0,
      });
      toast.success('user deleted', {
        description: `${userToDelete.email} has been permanently deleted.`,
      });

      const reassignedCount = result.reassignedTalonIds?.length ?? 0;
      if (reassignedCount > 0) {
        toast.success('talons reassigned', {
          description: `${reassignedCount} talon${
            reassignedCount === 1 ? '' : 's'
          } moved to a new owner.`,
        });
      }
      // Surface per-site refusals: those talons are now authored by a deleted
      // account and will not run.
      const failures = result.talonReassignFailures ?? [];
      if (failures.length > 0) {
        toast.error('some talons could not be reassigned', {
          description: `${failures.length} site${
            failures.length === 1 ? '' : 's'
          } refused the successor — those talons will stop running.`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('deletion failed', {
        description: message || 'failed to delete user.',
      });
    } finally {
      setDeletingUser(null);
      setUserToDelete(null);
      setAuthoredTalons(null);
    }
  };

  const formatDate = (timestamp: FirestoreTs) => {
    if (!timestamp) return 'N/A';
    const t = timestamp as { toDate?: () => Date } | null | undefined;
    const date = t && typeof t.toDate === 'function'
      ? t.toDate()
      : new Date(timestamp as number | string | Date);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* Header — tally chips sit beside the title (not in a full-width card
            row) so the users table keeps the vertical space. Chips are ordered
            by ascending privilege, so the platform tier sits last. */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">user management</h1>
            <p className="text-muted-foreground">manage user roles and permissions</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatChip icon={Users} iconTone="bg-accent-cyan text-primary-foreground" count={counts.total} label="total users" />
            <StatChip icon={Users} iconTone="bg-muted text-foreground" count={counts.members} label="members" />
            <StatChip icon={Shield} iconTone="bg-success-solid text-success-solid-foreground" count={counts.admins} label="site admins" />
            <StatChip icon={Crown} iconTone="bg-danger-solid text-danger-solid-foreground" count={counts.superadmins} label="superadmins" />
          </div>
        </div>

      {/* Error State */}
      {error && (
        <div className="bg-danger-surface border border-danger-border rounded-lg p-4 mb-6">
          <p className="text-danger">{error}</p>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center items-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
          <span className="ml-3 text-muted-foreground">loading users...</span>
        </div>
      )}

      {/* Users Table */}
      {!loading && !error && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          {/* Table toolbar — deleted accounts are soft-deleted and stay listed
              for auditability, so they're filterable rather than dropped. */}
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-4 py-3 border-b border-border">
            {!showDeletedUsers && counts.deleted > 0 && (
              <span className="text-xs text-muted-foreground mr-auto">
                {counts.deleted} deleted account{counts.deleted === 1 ? '' : 's'} hidden
              </span>
            )}
            <Label htmlFor="show-deleted-users" className="text-sm text-muted-foreground cursor-pointer">
              show deleted accounts
            </Label>
            <Switch
              id="show-deleted-users"
              checked={showDeletedUsers}
              onCheckedChange={setShowDeletedUsers}
              aria-label="show deleted accounts"
            />
          </div>
          {/* scrolls sideways on phones so the actions column stays reachable */}
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-background/50">
                <th className="text-left p-4 text-sm font-medium text-foreground">user</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">role</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">sites</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">joined</th>
                <th className="text-left p-4 text-sm font-medium text-foreground">last seen</th>
                <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-muted-foreground">
                    {users.length === 0 ? 'no users found' : 'no active users — every account here is deleted'}
                  </td>
                </tr>
              ) : (
                visibleUsers.map((user) => {
                  const isDeleted = user.deletedAt != null;
                  return (
                  <tr
                    key={user.uid}
                    className={`border-b border-border hover:bg-muted/50 transition-colors${isDeleted ? ' opacity-80' : ''}`}
                  >
                    {/* User Info */}
                    <td className="p-4">
                      <div>
                        {user.displayName && (
                          <p className="text-foreground font-medium">{user.displayName}</p>
                        )}
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                        {user.uid === currentUser?.uid && (
                          <Badge className="mt-1 text-xs">you</Badge>
                        )}
                        {isDeleted && (
                          <div className="mt-1">
                            <Badge className="bg-secondary border border-border text-muted-foreground text-xs">
                              deleted
                            </Badge>
                            <p className="text-xs text-muted-foreground mt-1">
                              deleted by {user.deletedBy ?? 'admin'} · {formatDate(user.deletedAt)}
                            </p>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Role Badge */}
                    <td className="p-4">
                      {user.role === 'superadmin' ? (
                        <Badge className="bg-danger-solid text-danger-solid-foreground flex items-center gap-1 w-fit">
                          <Crown className="h-3 w-3" />
                          superadmin
                        </Badge>
                      ) : user.role === 'admin' ? (
                        <Badge className="bg-success-solid text-success-solid-foreground flex items-center gap-1 w-fit">
                          <ShieldAlert className="h-3 w-3" />
                          admin
                        </Badge>
                      ) : (
                        <Badge className="bg-secondary border border-border text-muted-foreground flex items-center gap-1 w-fit">
                          <Users className="h-3 w-3" />
                          member
                        </Badge>
                      )}
                    </td>

                    {/* Sites */}
                    <td className="p-4">
                      {user.role === 'admin' ? (
                        // Admins are site-scoped; name the sites so a superadmin
                        // can see who is responsible for what.
                        user.sites && user.sites.length > 0 ? (
                          <div className="flex flex-wrap gap-1 max-w-sm">
                            {user.sites.map((siteId) => (
                              <span
                                key={siteId}
                                className="rounded bg-success-surface border border-success-border text-success text-xs font-mono px-1.5 py-0.5"
                                title={`admin of ${siteId}`}
                              >
                                {siteId}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm italic">
                            no sites assigned
                          </span>
                        )
                      ) : user.role === 'superadmin' ? (
                        <span className="text-muted-foreground text-sm italic">
                          all sites
                        </span>
                      ) : (
                        <>
                          <span className="text-foreground">{user.sites?.length || 0}</span>
                          <span className="text-muted-foreground text-sm ml-1">
                            site{user.sites?.length !== 1 ? 's' : ''}
                          </span>
                        </>
                      )}
                    </td>

                    {/* Join Date */}
                    <td className="p-4 text-muted-foreground text-sm">
                      {formatDate(user.createdAt)}
                    </td>

                    {/* Last Seen — last refresh, falling back to last sign-in. */}
                    <td className="p-4 text-muted-foreground text-sm">
                      {(() => {
                        const lastSeen = activity[user.uid]?.lastRefreshTime ?? activity[user.uid]?.lastSignInTime;
                        if (!lastSeen) {
                          return <span className="italic text-muted-foreground">never</span>;
                        }
                        return (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{formatDate(lastSeen)}</span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{lastSeen}</p>
                            </TooltipContent>
                          </Tooltip>
                        );
                      })()}
                    </td>

                    {/* Actions — deleted accounts have no actionable operations. */}
                    <td className="p-4">
                      {isDeleted ? (
                        <div className="flex items-center justify-end text-muted-foreground">—</div>
                      ) : (
                      <div className="flex items-center justify-end">
                        <DropdownMenu>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  aria-label={`options for ${user.email}`}
                                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground! hover:bg-accent! cursor-pointer"
                                >
                                  <MoreVertical className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>user options</p>
                            </TooltipContent>
                          </Tooltip>
                          <DropdownMenuContent align="end" className="bg-card border-border">
                            <DropdownMenuItem
                              onClick={() => handleOpenManageSites(user.uid, user.email, user.role, user.sites || [])}
                              className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                            >
                              <Settings className="h-4 w-4 mr-2" />
                              manage sites
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleOpenRoleChangeDialog(user.uid, user.email, user.role)}
                              disabled={updatingUser === user.uid || (user.uid === currentUser?.uid && user.role === 'superadmin')}
                              className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                            >
                              {updatingUser === user.uid ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  updating...
                                </>
                              ) : (
                                <>
                                  <UserCog className="h-4 w-4 mr-2" />
                                  change role...
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator className="bg-border" />
                            <DropdownMenuItem
                              onClick={() => handleOpenMfaResetDialog(user.uid, user.email)}
                              disabled={resettingMfaUser === user.uid || user.uid === currentUser?.uid}
                              className="text-danger cursor-pointer focus:bg-danger-surface focus:text-danger"
                            >
                              {resettingMfaUser === user.uid ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  resetting...
                                </>
                              ) : (
                                <>
                                  <ShieldOff className="h-4 w-4 mr-2" />
                                  reset 2FA...
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleOpenDeleteDialog(user.uid, user.email)}
                              disabled={deletingUser === user.uid || user.uid === currentUser?.uid}
                              className="text-danger cursor-pointer focus:bg-danger-surface focus:text-danger"
                            >
                              {deletingUser === user.uid ? (
                                <>
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                  deleting...
                                </>
                              ) : (
                                <>
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  delete user
                                </>
                              )}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      )}
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Account-deletions audit feed — self-deletes + admin-deletes, newest-first. */}
      {!loading && !error && (
        <div className="mt-6 bg-card border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground">account deletions</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            a record of accounts that were removed — anyone can delete their own account from
            settings, and superadmins can delete others from this page. each entry shows who was
            removed, who removed them, and what the cascade cleaned up.
          </p>

          {deletionsLoading && deletions.length === 0 ? (
            <div className="flex items-center gap-2 mt-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              loading deletions...
            </div>
          ) : deletions.length === 0 ? (
            <p className="text-sm text-muted-foreground italic mt-4">no accounts have been deleted</p>
          ) : (
            <ul className="divide-y divide-border mt-4">
              {deletions.map((d) => {
                const selfDelete = d.capability === 'USER_SELF_DELETE';
                // Legacy rows recorded the platform sentinel, not the uid.
                const targetUid = d.uid && d.uid !== PLATFORM_TARGET_ID ? d.uid : null;
                const targetLabel = targetUid ? userLabels[targetUid] ?? targetUid : null;
                const actorLabel = d.actorUid ? userLabels[d.actorUid] ?? d.actorUid : 'an unknown actor';
                const blocked = d.outcome !== 'allow';

                const detail = [
                  blocked
                    ? selfDelete
                      ? 'requested their own deletion'
                      : `requested by ${actorLabel}`
                    : selfDelete
                      ? 'deleted their own account'
                      : `deleted by ${actorLabel}`,
                  formatDate(d.timestamp),
                  ...(d.counts && !blocked
                    ? [`removed ${d.counts.sites ?? 0} site${d.counts.sites === 1 ? '' : 's'}, ${d.counts.machines ?? 0} machine${d.counts.machines === 1 ? '' : 's'}`]
                    : []),
                ].join(' · ');

                return (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-3 text-sm">
                    <Badge className="bg-secondary border border-border text-muted-foreground text-xs">
                      {selfDelete ? 'self-delete' : 'admin-delete'}
                    </Badge>
                    {targetLabel ? (
                      <span className="text-foreground font-medium">{targetLabel}</span>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground italic">account not recorded</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-xs">
                            this entry predates the fix that records which account was deleted; only
                            the actor and timestamp were logged.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {blocked && (
                      <Badge className="bg-danger-surface border border-danger-border text-danger text-xs">
                        {d.outcome === 'deny'
                          ? `blocked${d.denyReason ? ` · ${d.denyReason.replace(/_/g, ' ')}` : ''}`
                          : 'failed'}
                      </Badge>
                    )}
                    <span className="text-muted-foreground">{detail}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Role-description cards — ascending privilege order, matches the stats cards above. */}
      {!loading && !error && users.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <span className="text-sm font-semibold text-foreground">member</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ROLE_DESCRIPTIONS.member}
            </p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <ShieldAlert className="h-4 w-4 text-success flex-shrink-0" />
              <span className="text-sm font-semibold text-foreground">admin</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ROLE_DESCRIPTIONS.admin}
            </p>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Crown className="h-4 w-4 text-danger flex-shrink-0" />
              <span className="text-sm font-semibold text-foreground">superadmin</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {ROLE_DESCRIPTIONS.superadmin}
            </p>
          </div>
        </div>
      )}

      {/* Manage Sites Dialog */}
      {selectedUser && (
        <ManageUserSitesDialog
          open={manageSitesDialogOpen}
          onOpenChange={setManageSitesDialogOpen}
          userId={selectedUser.uid}
          userEmail={selectedUser.email}
          userRole={selectedUser.role}
          userSites={selectedUser.sites}
          onAssignSite={assignSiteToUser}
          onRemoveSite={removeSiteFromUser}
          allUsers={users}
        />
      )}

      {/* Role Change Confirmation Dialog */}
      <Dialog open={roleChangeDialogOpen} onOpenChange={setRoleChangeDialogOpen}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <UserCog className="h-5 w-5 text-accent-cyan" />
              change role
            </DialogTitle>
            <DialogDescription className="text-foreground">
              choose a new role for <strong className="text-foreground">{userToChangeRole?.email}</strong>. current role: <strong className="text-foreground">{userToChangeRole ? ROLE_LABELS[userToChangeRole.currentRole] : ''}</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <Select
              value={userToChangeRole?.newRole}
              onValueChange={(v) => handleSelectNewRole(v as UserRole)}
            >
              <SelectTrigger aria-label="new role" className="w-full bg-secondary border-border text-foreground">
                <SelectValue placeholder="select a role" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value="member" className="text-foreground focus:bg-accent focus:text-foreground">
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    member
                  </div>
                </SelectItem>
                <SelectItem value="admin" className="text-foreground focus:bg-accent focus:text-foreground">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-success" />
                    admin
                  </div>
                </SelectItem>
                <SelectItem value="superadmin" className="text-foreground focus:bg-accent focus:text-foreground">
                  <div className="flex items-center gap-2">
                    <Crown className="h-4 w-4 text-danger" />
                    superadmin
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            {userToChangeRole && (
              <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
                <p className="text-accent-cyan text-sm">
                  {ROLE_DESCRIPTIONS[userToChangeRole.newRole]}
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setRoleChangeDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleConfirmRoleChange}
              disabled={!userToChangeRole || userToChangeRole.newRole === userToChangeRole.currentRole}
              className="cursor-pointer"
            >
              <UserCog className="h-4 w-4 mr-2" />
              save role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmDialogOpen} onOpenChange={setDeleteConfirmDialogOpen}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-danger" />
              delete user
            </DialogTitle>
            <DialogDescription className="text-foreground">
              are you sure you want to delete <strong className="text-foreground">{userToDelete?.email}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <div className="bg-danger-surface border border-danger-border rounded-lg p-4">
              <p className="text-danger text-sm">
                this action cannot be undone. all user data will be permanently removed.
              </p>
            </div>
            {/* Renders itself away when the count is zero, so the common case
                keeps the dialog it always had. */}
            <TalonSuccessorPicker
              count={authoredTalons?.count ?? 0}
              talonNames={(authoredTalons?.talons ?? []).map((talon) => talon.name)}
              consequence="the account is deleted"
              candidates={successorCandidates}
              value={successorUid}
              onChange={setSuccessorUid}
              idPrefix="user-delete"
            />
            {(authoredTalons?.count ?? 0) > 0 && successorUid !== NO_SUCCESSOR && (
              <p className="text-xs text-muted-foreground">
                this admin also inherits any sites this user owns.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setDeleteConfirmDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              className="cursor-pointer"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              delete user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 2FA Reset Confirmation Dialog — the supported recovery path for a user
          who has lost their last factor AND their backup codes. Destructive:
          it strips every factor, so the consequences are spelled out rather
          than left to be discovered at the target's next sign-in. */}
      <Dialog open={mfaResetDialogOpen} onOpenChange={setMfaResetDialogOpen}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <ShieldOff className="h-5 w-5 text-danger" />
              reset 2FA
            </DialogTitle>
            <DialogDescription className="text-foreground">
              remove every second factor from <strong className="text-foreground">{userToResetMfa?.email}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 space-y-3">
            <div className="bg-danger-surface border border-danger-border rounded-lg p-4">
              <p className="text-danger text-sm">
                their authenticator app, passkeys and backup codes all stop working. they will be
                signed out of every trusted device, and asked to set up 2FA again the next time they
                sign in.
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              only do this once you have confirmed who you are talking to — a reset hands the
              account to whoever signs in next.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setMfaResetDialogOpen(false)}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmMfaReset}
              className="cursor-pointer"
            >
              <ShieldOff className="h-4 w-4 mr-2" />
              reset 2FA
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </div>
  );
}
