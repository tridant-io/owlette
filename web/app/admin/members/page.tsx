'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites } from '@/hooks/useFirestore';
import {
  useSiteMembers,
  SiteMemberApiError,
  type AddableSiteMemberRole,
  type SiteMember,
} from '@/hooks/useSiteMembers';
import { useTalonReassign, type SiteAuthoredTalons } from '@/hooks/useTalonReassign';
import { eligibleTalonSuccessors } from '@/lib/talonSuccessors';
import { NO_SUCCESSOR, TalonSuccessorPicker } from '@/components/TalonSuccessorPicker';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Crown,
  Loader2,
  MoreVertical,
  Plus,
  Shield,
  ShieldAlert,
  UserCog,
  UserMinus,
  Users,
} from 'lucide-react';
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
import { toast } from '@/lib/toast';
import { AdminPageHeader } from '@/components/admin/AdminPageHeader';
import { CompactButton } from '@/components/admin/CompactButton';
import { StatChip } from '@/components/admin/StatChip';
import { displayRole } from './displayRole';

/**
 * Site membership: who can reach ONE site, managed by that site's admins.
 *
 * Deliberately not /admin/users: this page never lists accounts outside the
 * selected site, and every role word it renders goes through `displayRole` so a
 * customer never learns the platform tier exists.
 *
 * Promotion member↔admin is a global role change, so it is offered to
 * superadmins only — granting admin here would grant it on every site the
 * target belongs to, including other organizations.
 */

/** Short summary of what each account-level role can do, for the role dialog. */
const ROLE_HELP: Record<AddableSiteMemberRole, string> = {
  member:
    'read-only access to the sites they belong to — view machines, capture screenshots, open live view. no commands, no config edits.',
  admin:
    'elevated access on every site they belong to — dispatch commands and restarts, edit machine and process settings, author talons, and manage members.',
};

/** How a member is addressed in dialogs and toasts. Never their uid. */
function memberLabel(member: Pick<SiteMember, 'email' | 'displayName'>): string {
  return member.email || member.displayName || 'this member';
}

export default function SiteMembersPage() {
  const { user: currentUser, isSuperadmin, userSites, lastSiteId, updateLastSite } = useAuth();
  const { sites, loading: sitesLoading } = useSites(currentUser?.uid, userSites, isSuperadmin);

  // User-chosen site (empty until the user picks). The effective selection is
  // derived below so we don't need a post-mount setState when sites resolve.
  const [userSelectedSiteId, setUserSelectedSiteId] = useState<string>('');

  // Derive the effective site: user's explicit choice if any, otherwise the
  // saved site (from auth context or localStorage) if it still exists in the
  // list, otherwise the first site.
  const selectedSiteId = useMemo(() => {
    if (userSelectedSiteId) return userSelectedSiteId;
    if (sites.length === 0) return '';
    const savedSite =
      lastSiteId ||
      (typeof window !== 'undefined' ? localStorage.getItem('owlette_current_site') : null);
    if (savedSite && sites.find((s) => s.id === savedSite)) return savedSite;
    return sites[0].id;
  }, [userSelectedSiteId, sites, lastSiteId]);

  const { members, loading, error, refresh, addMember, removeMember } =
    useSiteMembers(selectedSiteId);
  const { fetchSiteAuthored } = useTalonReassign();

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState<AddableSiteMemberRole>('member');
  const [adding, setAdding] = useState(false);

  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<SiteMember | null>(null);
  const [authoredTalons, setAuthoredTalons] = useState<SiteAuthoredTalons | null>(null);
  const [successorUid, setSuccessorUid] = useState<string>(NO_SUCCESSOR);
  const [removingUid, setRemovingUid] = useState<string | null>(null);

  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [memberToChangeRole, setMemberToChangeRole] = useState<{
    uid: string;
    label: string;
    currentRole: AddableSiteMemberRole;
    newRole: AddableSiteMemberRole;
  } | null>(null);
  const [updatingUid, setUpdatingUid] = useState<string | null>(null);

  const adminCount = useMemo(
    () => members.filter((member) => displayRole(member.role) === 'admin').length,
    [members],
  );

  // Client mirror of the server's TALON_MANAGE check, fed from this site's own
  // members — the only accounts this page is allowed to know about. Every member
  // listed belongs to the selected site, so `sites` is that site by construction.
  const successorCandidates = useMemo(
    () =>
      eligibleTalonSuccessors(
        members.map((member) => ({
          uid: member.uid,
          email: member.email ?? undefined,
          displayName: member.displayName ?? undefined,
          role: member.globalRole,
          sites: selectedSiteId ? [selectedSiteId] : [],
        })),
        { siteId: selectedSiteId || undefined, excludeUid: memberToRemove?.uid },
      ),
    [members, selectedSiteId, memberToRemove?.uid],
  );

  const handleSiteChange = (siteId: string) => {
    setUserSelectedSiteId(siteId);
    updateLastSite(siteId);
  };

  const handleAddMember = async () => {
    const email = addEmail.trim();
    if (!email || adding) return;

    setAdding(true);
    try {
      await addMember({ email, role: addRole });
      setAddDialogOpen(false);
      setAddEmail('');
      setAddRole('member');
      // No roleHonored branch: the requested role is written into the membership
      // row, so it is always honoured. The old second arm told the operator their
      // admin grant had been downgraded to member while a real site-admin row was
      // being written.
      toast.success('member added', {
        description: `${email} now has ${addRole} access to this site.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // The route's only 404 on this path is "user <email> not found", so the
      // status alone identifies it — no prose sniffing.
      if (err instanceof SiteMemberApiError && err.status === 404) {
        toast.error('no account found for that email', {
          description: 'they need an owlette account before they can be added to a site.',
        });
      } else {
        toast.error('could not add member', {
          description: message || 'failed to add member.',
        });
      }
    } finally {
      setAdding(false);
    }
  };

  const handleOpenRemoveDialog = (member: SiteMember) => {
    // Matches the pre-flight guard on /admin/users: refuse with a reason rather
    // than hiding the action, so the rule is discoverable.
    if (member.uid === currentUser?.uid) {
      toast.error('cannot remove yourself', {
        description: 'ask another admin on this site to remove your access.',
      });
      return;
    }

    setMemberToRemove(member);
    setSuccessorUid(NO_SUCCESSOR);
    setAuthoredTalons(null);
    setRemoveDialogOpen(true);

    // Fired as the dialog opens: the admin must see what the removal breaks
    // before confirming. Non-fatal — without it the dialog just cannot warn.
    void (async () => {
      try {
        setAuthoredTalons(await fetchSiteAuthored(selectedSiteId, member.uid));
      } catch (err) {
        console.error('Error fetching authored talons:', err);
      }
    })();
  };

  const handleConfirmRemove = async () => {
    if (!memberToRemove) return;

    const label = memberLabel(memberToRemove);
    const successor = successorUid === NO_SUCCESSOR ? undefined : successorUid;
    setRemovingUid(memberToRemove.uid);
    setRemoveDialogOpen(false);

    try {
      const result = await removeMember(memberToRemove.uid, successor);
      toast.success('member removed', {
        description: `${label} no longer has access to this site.`,
      });

      const reassigned = result.reassignedTalonIds.length;
      if (reassigned > 0) {
        toast.success('talons reassigned', {
          description: `${reassigned} talon${reassigned === 1 ? '' : 's'} moved to a new author.`,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // The owner row offers no remove action, so this only surfaces if
      // ownership changed under an open page.
      if (/owner/i.test(message)) {
        toast.error('cannot remove the site owner', {
          description: 'transfer site ownership first, then remove them.',
        });
      } else {
        toast.error('could not remove member', {
          description: message || 'failed to remove member.',
        });
      }
    } finally {
      setRemovingUid(null);
      setMemberToRemove(null);
      setAuthoredTalons(null);
    }
  };

  const handleOpenRoleDialog = (member: SiteMember, currentRole: AddableSiteMemberRole) => {
    setMemberToChangeRole({
      uid: member.uid,
      label: memberLabel(member),
      currentRole,
      newRole: currentRole,
    });
    setRoleDialogOpen(true);
  };

  const handleConfirmRoleChange = async () => {
    if (!memberToChangeRole) return;
    if (memberToChangeRole.newRole === memberToChangeRole.currentRole) {
      setRoleDialogOpen(false);
      setMemberToChangeRole(null);
      return;
    }

    const { uid, label, newRole } = memberToChangeRole;
    setUpdatingUid(uid);
    setRoleDialogOpen(false);

    try {
      // PATCH the MEMBERSHIP, not the account. This page is site-scoped — it has a
      // site selector and lists one site's members — and since the per-site-roles
      // migration a global role grants nothing on a site, so the global
      // promote/demote endpoints it used to call changed the wrong thing: they
      // are superadmin-only, and succeeding conferred no site access at all.
      // `PATCH /api/sites/{siteId}/members/{uid}` is the endpoint that shipped
      // for this and had no caller.
      const response = await fetch(
        `/api/sites/${encodeURIComponent(selectedSiteId)}/members/${encodeURIComponent(uid)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? body.title ?? `role change failed (${response.status})`);
      }
      // The row's role comes from the membership document, which this page reads
      // only through the members route — refetch or the badge stays stale.
      await refresh();
      toast.success('role updated', {
        description: `${label} is now ${newRole === 'admin' ? 'an admin' : 'a member'} on this site.`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('update failed', {
        description: message || 'failed to update role.',
      });
    } finally {
      setUpdatingUid(null);
      setMemberToChangeRole(null);
    }
  };

  const showEmptySites = !sitesLoading && sites.length === 0;

  return (
    <div className="p-4 sm:p-6 md:p-8">
      <div className="max-w-screen-2xl mx-auto">
        {/* tally chips sit beside the title (not in a full-width card row) so the
            members table keeps the vertical space */}
        <AdminPageHeader
          className="mb-6 md:mb-8 md:flex-wrap md:gap-x-6 md:gap-y-4"
          controlsClassName="md:flex-wrap md:gap-2"
          title="members"
          description="manage who can access this site"
          actions={
            <CompactButton
              icon={Plus}
              label="add member"
              onClick={() => setAddDialogOpen(true)}
              disabled={!selectedSiteId}
            />
          }
          toolbar={
            <>
              <StatChip
                icon={Users}
                iconTone="bg-accent-cyan text-primary-foreground"
                count={members.length}
                label="total members"
              />
              <StatChip icon={Shield} iconTone="bg-success-solid text-success-solid-foreground" count={adminCount} label="admins" />
              {sites.length > 1 && (
                <Select value={selectedSiteId} onValueChange={handleSiteChange}>
                  <SelectTrigger aria-label="site" className="min-w-32 flex-1 sm:w-[180px] sm:flex-none bg-card border-border text-foreground">
                    <SelectValue placeholder="select site" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    {sites.map((site) => (
                      <SelectItem
                        key={site.id}
                        value={site.id}
                        className="text-foreground hover:bg-muted"
                      >
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          }
        />

        {error && (
          <div className="bg-danger-surface border border-danger-border rounded-lg p-4 mb-6">
            <p className="text-danger">{error}</p>
          </div>
        )}

        {(sitesLoading || loading) && (
          <div className="flex justify-center items-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
            <span className="ml-3 text-muted-foreground">loading members...</span>
          </div>
        )}

        {showEmptySites && (
          <div className="bg-card border border-border rounded-lg p-6 md:p-8 text-center">
            <p className="text-sm text-foreground">no sites available</p>
            <p className="text-xs text-muted-foreground mt-1">
              you need site access to manage members. ask a site admin to add you.
            </p>
          </div>
        )}

        {!sitesLoading && !loading && !error && selectedSiteId && (
          <div className="bg-card border border-border rounded-lg overflow-x-auto">
            {/* below md each member stacks into a block: name and options, then the
                email, then the role */}
            <table className="block w-full md:table">
              <thead className="hidden md:table-header-group">
                <tr className="border-b border-border bg-background/50">
                  <th className="text-left p-4 text-sm font-medium text-foreground">member</th>
                  <th className="text-left p-4 text-sm font-medium text-foreground">role</th>
                  <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {members.length === 0 ? (
                  <tr className="block md:table-row">
                    <td colSpan={3} className="block md:table-cell p-6 md:p-8 text-center text-muted-foreground">
                      no members found
                    </td>
                  </tr>
                ) : (
                  members.map((member) => {
                    const shown = displayRole(member.role);
                    // The owner is refused by the API; ownership transfer is an
                    // account-level operation, not a membership one.
                    const canRemove = member.role !== 'owner';
                    // A global role change reaches every site the target belongs
                    // to, so it stays superadmin-only. Restricted to accounts
                    // that actually hold member/admin, which also excludes the
                    // signed-in superadmin's own row.
                    const canChangeRole =
                      isSuperadmin &&
                      (member.globalRole === 'member' || member.globalRole === 'admin');
                    const busy = removingUid === member.uid || updatingUid === member.uid;

                    return (
                      <tr
                        key={member.uid}
                        className="flex flex-wrap items-start md:table-row border-b border-border hover:bg-muted/50 transition-colors"
                      >
                        <td className="order-1 basis-[calc(100%_-_3rem)] min-w-0 px-3 pt-3 pb-1 md:p-4">
                          {/* below md the "you" pill rides the first line instead of its own */}
                          <div className="flex flex-wrap items-center gap-x-2 md:block">
                            {member.displayName && (
                              <p className="order-1 min-w-0 text-foreground font-medium max-md:text-sm max-md:wrap-anywhere">
                                {member.displayName}
                              </p>
                            )}
                            {member.email ? (
                              <p
                                className={`text-sm text-muted-foreground max-md:wrap-anywhere ${
                                  member.displayName ? 'order-3 basis-full' : 'order-1 min-w-0'
                                }`}
                              >
                                {member.email}
                              </p>
                            ) : (
                              !member.displayName && (
                                <p className="order-1 text-sm text-muted-foreground italic">
                                  no email on file
                                </p>
                              )
                            )}
                            {member.uid === currentUser?.uid && (
                              <Badge className="order-2 md:mt-1 text-xs">
                                you
                              </Badge>
                            )}
                          </div>
                        </td>

                        <td className="order-3 px-3 pt-1 pb-3 md:p-4">
                          {shown === 'owner' ? (
                            <Badge className="flex items-center gap-1 w-fit">
                              <Crown className="h-3 w-3" />
                              owner
                            </Badge>
                          ) : shown === 'admin' ? (
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

                        <td className="order-2 w-12 pr-3 pt-2 pb-1 md:w-auto md:p-4">
                          {!canRemove && !canChangeRole ? (
                            <div className="flex items-center justify-end text-muted-foreground">
                              —
                            </div>
                          ) : (
                            <div className="flex items-center justify-end">
                              <DropdownMenu>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        aria-label={`options for ${member.email || member.displayName || member.uid}`}
                                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground! hover:bg-accent! cursor-pointer"
                                      >
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>member options</p>
                                  </TooltipContent>
                                </Tooltip>
                                <DropdownMenuContent align="end" className="bg-card border-border">
                                  {canChangeRole && (
                                    <DropdownMenuItem
                                      onClick={() =>
                                        handleOpenRoleDialog(
                                          member,
                                          member.globalRole === 'admin' ? 'admin' : 'member',
                                        )
                                      }
                                      disabled={busy}
                                      className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                                    >
                                      {updatingUid === member.uid ? (
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
                                  )}
                                  {canChangeRole && canRemove && (
                                    <DropdownMenuSeparator className="bg-border" />
                                  )}
                                  {canRemove && (
                                    <DropdownMenuItem
                                      onClick={() => handleOpenRemoveDialog(member)}
                                      disabled={busy}
                                      className="text-danger cursor-pointer focus:bg-danger-surface focus:text-danger"
                                    >
                                      {removingUid === member.uid ? (
                                        <>
                                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                          removing...
                                        </>
                                      ) : (
                                        <>
                                          <UserMinus className="h-4 w-4 mr-2" />
                                          remove...
                                        </>
                                      )}
                                    </DropdownMenuItem>
                                  )}
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
        )}

        {/* Add Member Dialog */}
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogContent className="border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <Plus className="h-5 w-5 text-accent-cyan" />
                add member
              </DialogTitle>
              <DialogDescription className="text-foreground">
                give an existing owlette account access to this site.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="add-member-email" className="text-foreground">
                  email
                </Label>
                <Input
                  id="add-member-email"
                  type="email"
                  placeholder="colleague@example.com"
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleAddMember();
                    }
                  }}
                  disabled={adding}
                  className="bg-secondary border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-member-role" className="text-foreground">
                  role
                </Label>
                <Select
                  value={addRole}
                  onValueChange={(v) => setAddRole(v as AddableSiteMemberRole)}
                  disabled={adding}
                >
                  <SelectTrigger
                    id="add-member-role"
                    className="w-full bg-secondary border-border text-foreground"
                  >
                    <SelectValue placeholder="select a role" />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem
                      value="member"
                      className="text-foreground focus:bg-accent focus:text-foreground"
                    >
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        member
                      </div>
                    </SelectItem>
                    <SelectItem
                      value="admin"
                      className="text-foreground focus:bg-accent focus:text-foreground"
                    >
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-success" />
                        admin
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {addRole === 'admin' && (
                <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
                  <p className="text-accent-cyan text-sm">
                    admin is an account-level role. someone who is not already an admin joins as a
                    member, and keeps that access until their account is upgraded.
                  </p>
                </div>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setAddDialogOpen(false)}
                disabled={adding}
                className="bg-secondary border border-border cursor-pointer"
              >
                cancel
              </Button>
              <Button
                onClick={handleAddMember}
                disabled={adding || addEmail.trim().length === 0}
                className="cursor-pointer"
              >
                {adding ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    adding...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4 mr-2" />
                    add member
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Remove Member Confirmation Dialog */}
        <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
          <DialogContent className="border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <UserMinus className="h-5 w-5 text-danger" />
                remove member
              </DialogTitle>
              <DialogDescription className="text-foreground">
                remove{' '}
                <strong className="text-foreground">
                  {memberToRemove ? memberLabel(memberToRemove) : ''}
                </strong>{' '}
                from this site?
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-3">
              <div className="bg-danger-surface border border-danger-border rounded-lg p-4">
                <p className="text-danger text-sm">
                  they lose access to this site and everything on it. their account and any other
                  sites they belong to are untouched.
                </p>
              </div>
              {/* Renders itself away when the count is zero, so the common case
                  keeps the dialog it always had. */}
              <TalonSuccessorPicker
                count={authoredTalons?.count ?? 0}
                talonNames={(authoredTalons?.talons ?? []).map((talon) => talon.name)}
                consequence="they lose access to this site"
                candidates={successorCandidates}
                value={successorUid}
                onChange={setSuccessorUid}
                idPrefix="member-remove"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setRemoveDialogOpen(false)}
                className="bg-secondary border border-border cursor-pointer"
              >
                cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmRemove}
                className="cursor-pointer"
              >
                <UserMinus className="h-4 w-4 mr-2" />
                remove member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Role Change Dialog — superadmin only; the trigger is not rendered
            otherwise. The role is global, so the copy says so. */}
        <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
          <DialogContent className="border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-foreground flex items-center gap-2">
                <UserCog className="h-5 w-5 text-accent-cyan" />
                change role
              </DialogTitle>
              <DialogDescription className="text-foreground">
                choose a new role for{' '}
                <strong className="text-foreground">{memberToChangeRole?.label}</strong>. current
                role: <strong className="text-foreground">{memberToChangeRole?.currentRole}</strong>
                .
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-3">
              <Select
                value={memberToChangeRole?.newRole}
                onValueChange={(v) =>
                  setMemberToChangeRole((prev) =>
                    prev ? { ...prev, newRole: v as AddableSiteMemberRole } : prev,
                  )
                }
              >
                <SelectTrigger aria-label="new role" className="w-full bg-secondary border-border text-foreground">
                  <SelectValue placeholder="select a role" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem
                    value="member"
                    className="text-foreground focus:bg-accent focus:text-foreground"
                  >
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4 text-muted-foreground" />
                      member
                    </div>
                  </SelectItem>
                  <SelectItem
                    value="admin"
                    className="text-foreground focus:bg-accent focus:text-foreground"
                  >
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-success" />
                      admin
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              {memberToChangeRole && (
                <div className="bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4">
                  <p className="text-accent-cyan text-sm">
                    {ROLE_HELP[memberToChangeRole.newRole]}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                this changes the account, not just this site — it applies everywhere they have
                access.
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setRoleDialogOpen(false)}
                className="bg-secondary border border-border cursor-pointer"
              >
                cancel
              </Button>
              <Button
                onClick={handleConfirmRoleChange}
                disabled={
                  !memberToChangeRole ||
                  memberToChangeRole.newRole === memberToChangeRole.currentRole
                }
                className="cursor-pointer"
              >
                <UserCog className="h-4 w-4 mr-2" />
                save role
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
