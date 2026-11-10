'use client';

import { useRef, useState } from 'react';
import { UserCog, Zap } from 'lucide-react';
import { accessLabel, isAccessValid, liveMachineIds } from '@/components/admin/sites/MachineAccessField';
import {
  MemberAccessFields,
  fromSwoopChoice,
  toSwoopChoice,
  type SwoopChoice,
} from '@/components/admin/sites/MemberAccessFields';
import { displayRole } from '@/components/admin/sites/displayRole';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  AddableSiteMemberRole,
  SiteMember,
  UpdateSiteMemberInput,
  UseSiteMembersResult,
} from '@/hooks/useSiteMembers';
import { useTalonReassign } from '@/hooks/useTalonReassign';
import { narrowsMachineScope } from '@/lib/machineAccess';
import { SWOOP_MODE_LABELS, effectiveSwoopMode, grantedSwoopMode } from '@/lib/swoopMode';
import { toast } from '@/lib/toast';

/** how a member is addressed in dialogs and toasts. never their uid. */
export function memberLabel(member: Pick<SiteMember, 'email' | 'displayName'>): string {
  return member.email || member.displayName || 'this member';
}

function sameMachineIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

function talonWarning(count: number): string {
  return count === 1
    ? 'they wrote 1 talon, which stops at its next run once their access is limited. reassign it to keep it.'
    : `they wrote ${count} talons, which stop at their next run once their access is limited. reassign them to keep them.`;
}

export function ChangeAccessDialog({
  siteId,
  member,
  membersMayWatch,
  machines,
  onOpenChange,
  updateMember,
}: {
  siteId: string;
  member: SiteMember;
  membersMayWatch: boolean;
  machines: { id: string; name: string }[];
  onOpenChange: (open: boolean) => void;
  updateMember: UseSiteMembersResult['updateMember'];
}) {
  const { fetchSiteAuthored } = useTalonReassign();
  // the members section never offers this on the owner's row, which the server refuses anyway
  const seededRole: AddableSiteMemberRole = displayRole(member.role) === 'admin' ? 'admin' : 'member';
  const seededSwoop = toSwoopChoice(member.swoop);
  const seededMachineIds = member.machineIds;
  const [role, setRole] = useState(seededRole);
  const [swoop, setSwoop] = useState<SwoopChoice>(seededSwoop);
  const [machineIds, setMachineIds] = useState<string[] | null>(seededMachineIds);
  const [authoredTalons, setAuthoredTalons] = useState(0);
  const talonLookup = useRef(false);
  const [saving, setSaving] = useState(false);
  const label = memberLabel(member);

  const roleChanged = role !== seededRole;
  const swoopChanged = swoop !== seededSwoop;
  const machinesChanged = !sameMachineIds(machineIds, seededMachineIds);
  const changed = roleChanged || swoopChanged || machinesChanged;
  // a picked machine that has left the site meanwhile is dropped, or the api refuses the save
  const sentMachineIds = machineIds === null ? null : liveMachineIds(machineIds, machines);
  // judged on what a save would send, so a list left holding only gone machines never goes out as []
  const valid = isAccessValid(machinesChanged ? sentMachineIds : machineIds);

  // from the whole site to some machines: their talons stop at the next run (a scoped author holds no talon)
  const limiting = seededMachineIds === null && machineIds !== null;
  const narrowed = machineIds !== null && narrowsMachineScope(seededMachineIds, machineIds);

  // the granted mode before and after, as the server's revocation reads it
  const before = grantedSwoopMode(seededRole, fromSwoopChoice(seededSwoop));
  const after = grantedSwoopMode(role, fromSwoopChoice(swoop));
  const ends =
    before !== 'none' && after === 'none'
      ? ' any swoop session they are in here ends.'
      : before === 'control' && after !== 'control'
        ? ' any swoop session they control here ends; watching carries on.'
        : '';
  const machineEnds = narrowed ? ' a swoop session they are in on a machine you take away ends.' : '';

  const changeMachineIds = (next: string[] | null) => {
    setMachineIds(next);
    if (seededMachineIds !== null || next === null || talonLookup.current) return;
    // asked once, the first time the choice leaves the whole site. non-fatal: without it the dialog just cannot warn
    talonLookup.current = true;
    fetchSiteAuthored(siteId, member.uid).then(
      (found) => setAuthoredTalons(found.count),
      (err: unknown) => {
        talonLookup.current = false;
        console.error('Error fetching authored talons:', err);
      },
    );
  };

  const save = async () => {
    if (!changed || !valid || saving) return;
    setSaving(true);
    const patch: UpdateSiteMemberInput = {};
    if (roleChanged) patch.role = role;
    if (swoopChanged) patch.swoop = fromSwoopChoice(swoop);
    if (machinesChanged) patch.machineIds = sentMachineIds;
    try {
      // the toast reads the row as written, not this dialog's seed: a field not sent keeps the row's own value
      const updated = await updateMember(member.uid, patch);
      const effective = effectiveSwoopMode(updated.role, updated.swoop, membersMayWatch);
      toast.success('access updated', {
        description: `${label} is now ${updated.role === 'admin' ? 'an admin' : 'a member'} on this site. swoop: ${SWOOP_MODE_LABELS[effective]}${updated.swoop === null ? ' (by role)' : ''}. access: ${accessLabel(updated.machineIds)}.`,
      });
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error('could not change their access', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    // the members section mounts this only while open, so each open seeds from the row afresh
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-accent-cyan" />
            change access
          </DialogTitle>
          {/* an email can be one unbroken word wider than a phone */}
          <DialogDescription className="wrap-anywhere">
            {`choose ${label}'s role, swoop and access on this site.`}
          </DialogDescription>
        </DialogHeader>
        <MemberAccessFields
          idPrefix="change-access"
          role={role}
          swoop={swoop}
          onRoleChange={setRole}
          onSwoopChange={setSwoop}
          membersMayWatch={membersMayWatch}
          machines={machines}
          machineIds={machineIds}
          onMachineIdsChange={changeMachineIds}
          disabled={saving}
        />
        {limiting && authoredTalons > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface p-3">
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <p className="text-sm text-foreground">{talonWarning(authoredTalons)}</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{`this changes their access to this site only.${ends}${machineEnds}`}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            cancel
          </Button>
          <Button onClick={() => void save()} disabled={!changed || !valid || saving}>
            {saving ? 'saving…' : 'save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
