'use client';

import { useRef, useState } from 'react';
import { Crown, Loader2, MoreVertical, Plus, ShieldAlert, UserCog, UserMinus, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSiteMachines, type SiteMachine } from '@/hooks/useSiteMachines';
import { SiteMemberApiError, useSiteMembers, type SiteMember } from '@/hooks/useSiteMembers';
import { useSwoopSettings } from '@/hooks/useSwoopSettings';
import { useTalonReassign, type SiteAuthoredTalons } from '@/hooks/useTalonReassign';
import { SWOOP_MODE_LABELS, effectiveSwoopMode } from '@/lib/swoopMode';
import { siteTalonSuccessors } from '@/lib/talonSuccessors';
import { toast } from '@/lib/toast';
import { CompactButton } from '@/components/admin/CompactButton';
import { Panel } from '@/components/admin/Panel';
import { AddMemberDialog } from '@/components/admin/sites/AddMemberDialog';
import { ChangeAccessDialog, memberLabel } from '@/components/admin/sites/ChangeAccessDialog';
import { accessLabel } from '@/components/admin/sites/MachineAccessField';
import { displayRole, type DisplayedRole } from '@/components/admin/sites/displayRole';
import { NO_SUCCESSOR, TalonSuccessorPicker } from '@/components/TalonSuccessorPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function RoleBadge({ role }: { role: DisplayedRole }) {
  if (role === 'owner') {
    return (
      <Badge className="flex items-center gap-1 w-fit">
        <Crown className="h-3 w-3" />
        owner
      </Badge>
    );
  }
  if (role === 'admin') {
    return (
      <Badge className="bg-success-solid text-success-solid-foreground flex items-center gap-1 w-fit">
        <ShieldAlert className="h-3 w-3" />
        admin
      </Badge>
    );
  }
  return (
    <Badge className="bg-secondary border border-border text-muted-foreground flex items-center gap-1 w-fit">
      <Users className="h-3 w-3" />
      member
    </Badge>
  );
}

const NO_MACHINES: SiteMachine[] = [];

/** the machines a scope names, by name, where an id the site no longer has shows as itself */
function AccessCell({ machineIds, machines }: { machineIds: string[] | null; machines: SiteMachine[] }) {
  const label = accessLabel(machineIds);
  if (!machineIds?.length) return <span className="text-foreground">{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="text-foreground cursor-help">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <ul className="max-w-xs space-y-0.5">
          {machineIds.map((id) => (
            <li key={id}>{machines.find((m) => m.id === id)?.name ?? id}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * a site's members: who can reach it, their site role, their swoop mode and their
 * machine scope. every role word goes through `displayRole`, so `superadmin` never
 * reaches the screen.
 */
export function SiteMembersSection({ siteId }: { siteId: string }) {
  const { user } = useAuth();
  const { members, loading, error, refresh, addMember, removeMember, updateMember } = useSiteMembers(siteId);
  const { fetchSiteAuthored } = useTalonReassign();
  const { membersMayWatch } = useSwoopSettings(siteId).settings;
  const machines = useSiteMachines(siteId).machines ?? NO_MACHINES;

  const [addOpen, setAddOpen] = useState(false);
  const [accessTarget, setAccessTarget] = useState<SiteMember | null>(null);

  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SiteMember | null>(null);
  const [authoredTalons, setAuthoredTalons] = useState<SiteAuthoredTalons | null>(null);
  const [successorUid, setSuccessorUid] = useState<string>(NO_SUCCESSOR);
  const [removingUid, setRemovingUid] = useState<string | null>(null);
  const talonLookup = useRef(0);

  const openRemove = (member: SiteMember) => {
    // refuse with a reason rather than hide the action, so the rule is discoverable
    if (member.uid === user?.uid) {
      toast.error('cannot remove yourself', {
        description: 'ask another admin on this site to remove your access.',
      });
      return;
    }

    setRemoveTarget(member);
    setSuccessorUid(NO_SUCCESSOR);
    setAuthoredTalons(null);
    setRemoveOpen(true);

    // fired as the dialog opens: the admin must see what the removal breaks before
    // confirming. non-fatal, since without it the dialog just cannot warn. only the
    // latest lookup lands, so a slow answer never warns about someone opened earlier
    const lookup = ++talonLookup.current;
    void (async () => {
      try {
        const found = await fetchSiteAuthored(siteId, member.uid);
        if (lookup === talonLookup.current) setAuthoredTalons(found);
      } catch (err) {
        console.error('Error fetching authored talons:', err);
      }
    })();
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const label = memberLabel(removeTarget);
    const successor = successorUid === NO_SUCCESSOR ? undefined : successorUid;
    setRemovingUid(removeTarget.uid);
    setRemoveOpen(false);

    try {
      const result = await removeMember(removeTarget.uid, successor);
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
      // the owner's row offers no remove, so this surfaces only if ownership changed under an open page
      if (err instanceof SiteMemberApiError && err.code === 'cannot_remove_owner') {
        toast.error('cannot remove the site owner', {
          description: 'transfer site ownership first, then remove them.',
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        toast.error('could not remove member', {
          description: message || 'failed to remove member.',
        });
      }
    } finally {
      setRemovingUid(null);
    }
  };

  return (
    <>
      <Panel
        id="site-section-members"
        title="members"
        description="the people who can reach this site, their role, their swoop and their access."
        actions={<CompactButton icon={Plus} label="add member" onClick={() => setAddOpen(true)} />}
      >
        {error && (
          <div className="flex items-center justify-between gap-3 bg-danger-surface border border-danger-border rounded-lg p-4">
            <p className="text-danger">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              retry
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex justify-center items-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-accent-cyan" />
            <span className="ml-3 text-muted-foreground">loading members...</span>
          </div>
        )}

        {!loading && !error && (
          <div className="border border-border rounded-lg overflow-x-auto">
            {/* below md each member stacks into a block: name and options, then the
                email, then the role with the swoop and the access beside it */}
            <table className="block w-full md:table">
              <thead className="hidden md:table-header-group">
                <tr className="border-b border-border bg-background/50">
                  <th className="text-left p-4 text-sm font-medium text-foreground">member</th>
                  <th className="text-left p-4 text-sm font-medium text-foreground">role</th>
                  <th className="text-left p-4 text-sm font-medium text-foreground">swoop</th>
                  <th className="text-left p-4 text-sm font-medium text-foreground">access</th>
                  <th className="text-right p-4 text-sm font-medium text-foreground">actions</th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {members.length === 0 ? (
                  <tr className="block md:table-row">
                    <td colSpan={5} className="block md:table-cell p-6 md:p-8 text-center text-muted-foreground">
                      no members found
                    </td>
                  </tr>
                ) : (
                  members.map((member) => {
                    const shown = displayRole(member.role);
                    // the server refuses both rows anyway: cannot_change_owner_role, cannot_modify_own_membership
                    const canChangeAccess = member.role !== 'owner' && member.uid !== user?.uid;
                    // ownership moves by transfer, never by removal
                    const canRemove = member.role !== 'owner';
                    const busy = removingUid === member.uid;
                    const swoop = SWOOP_MODE_LABELS[effectiveSwoopMode(shown, member.swoop, membersMayWatch)];

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
                                <p className="order-1 text-sm text-muted-foreground italic">no email on file</p>
                              )
                            )}
                            {member.uid === user?.uid && <Badge className="order-2 md:mt-1 text-xs">you</Badge>}
                          </div>
                        </td>

                        <td className="order-3 px-3 pt-1 pb-3 md:p-4">
                          <RoleBadge role={shown} />
                        </td>

                        {/* centred on the role line below md, so the label lines up with the badge's text. it
                            takes what the badge leaves and wraps there, so a long access never drops a line */}
                        <td className="order-4 min-w-0 flex-1 self-center pr-3 pt-1 pb-3 text-xs md:p-4 md:text-sm">
                          <span className="text-foreground">{swoop}</span>
                          {shown !== 'owner' && member.swoop === null && (
                            <span className="text-muted-foreground"> · by role</span>
                          )}
                          <span className="text-muted-foreground md:hidden"> · {accessLabel(member.machineIds)}</span>
                        </td>

                        <td className="hidden p-4 text-sm md:table-cell">
                          <AccessCell machineIds={member.machineIds} machines={machines} />
                        </td>

                        <td className="order-2 w-12 pr-3 pt-2 pb-1 md:w-auto md:p-4">
                          {!canChangeAccess && !canRemove ? (
                            <div className="flex items-center justify-end text-muted-foreground">—</div>
                          ) : (
                            <div className="flex items-center justify-end">
                              <DropdownMenu>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={`options for ${member.email || member.displayName || member.uid}`}
                                        className="text-muted-foreground"
                                      >
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                  </TooltipTrigger>
                                  <TooltipContent>member options</TooltipContent>
                                </Tooltip>
                                <DropdownMenuContent align="end" className="bg-card border-border">
                                  {canChangeAccess && (
                                    <DropdownMenuItem
                                      onClick={() => setAccessTarget(member)}
                                      disabled={busy}
                                      className="text-foreground hover:bg-accent cursor-pointer focus:bg-accent focus:text-foreground"
                                    >
                                      <UserCog className="h-4 w-4 mr-2" />
                                      change access...
                                    </DropdownMenuItem>
                                  )}
                                  {canChangeAccess && canRemove && <DropdownMenuSeparator className="bg-border" />}
                                  {canRemove && (
                                    <DropdownMenuItem
                                      onClick={() => openRemove(member)}
                                      disabled={busy}
                                      className="text-danger cursor-pointer focus:bg-danger-surface focus:text-danger"
                                    >
                                      {busy ? (
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
      </Panel>

      {addOpen && (
        <AddMemberDialog
          siteId={siteId}
          membersMayWatch={membersMayWatch}
          machines={machines}
          addMember={addMember}
          onOpenChange={setAddOpen}
        />
      )}

      {accessTarget && (
        <ChangeAccessDialog
          siteId={siteId}
          member={accessTarget}
          membersMayWatch={membersMayWatch}
          machines={machines}
          updateMember={updateMember}
          onOpenChange={(open) => {
            if (!open) setAccessTarget(null);
          }}
        />
      )}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserMinus className="h-5 w-5 text-danger" />
              remove member
            </DialogTitle>
            {/* an email can be one unbroken word wider than a phone */}
            <DialogDescription className="wrap-anywhere">
              remove <strong className="text-foreground">{removeTarget ? memberLabel(removeTarget) : ''}</strong>{' '}
              from this site?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="bg-danger-surface border border-danger-border rounded-lg p-4">
              <p className="text-danger text-sm">
                they lose access to this site and everything on it. their account and any other sites they belong
                to are untouched.
              </p>
            </div>
            {/* renders itself away when the count is zero, so the common case keeps a plain dialog */}
            <TalonSuccessorPicker
              count={authoredTalons?.count ?? 0}
              talonNames={(authoredTalons?.talons ?? []).map((talon) => talon.name)}
              consequence="they lose access to this site"
              candidates={siteTalonSuccessors(members, removeTarget?.uid)}
              value={successorUid}
              onChange={setSuccessorUid}
              idPrefix="member-remove"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemove()}>
              <UserMinus />
              remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
