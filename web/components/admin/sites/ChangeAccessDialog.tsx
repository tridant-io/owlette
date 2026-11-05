'use client';

import { useState } from 'react';
import { UserCog } from 'lucide-react';
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
import { SWOOP_MODE_LABELS, effectiveSwoopMode, grantedSwoopMode } from '@/lib/swoopMode';
import { toast } from '@/lib/toast';

/** how a member is addressed in dialogs and toasts. never their uid. */
export function memberLabel(member: Pick<SiteMember, 'email' | 'displayName'>): string {
  return member.email || member.displayName || 'this member';
}

export function ChangeAccessDialog({
  member,
  membersMayWatch,
  onOpenChange,
  updateMember,
}: {
  member: SiteMember;
  membersMayWatch: boolean;
  onOpenChange: (open: boolean) => void;
  updateMember: UseSiteMembersResult['updateMember'];
}) {
  // the members section never offers this on the owner's row, which the server refuses anyway
  const seededRole: AddableSiteMemberRole = displayRole(member.role) === 'admin' ? 'admin' : 'member';
  const seededSwoop = toSwoopChoice(member.swoop);
  const [role, setRole] = useState(seededRole);
  const [swoop, setSwoop] = useState<SwoopChoice>(seededSwoop);
  const [saving, setSaving] = useState(false);
  const label = memberLabel(member);

  const roleChanged = role !== seededRole;
  const swoopChanged = swoop !== seededSwoop;
  const changed = roleChanged || swoopChanged;

  // the granted mode before and after, as the server's revocation reads it
  const before = grantedSwoopMode(seededRole, fromSwoopChoice(seededSwoop));
  const after = grantedSwoopMode(role, fromSwoopChoice(swoop));
  const ends =
    before !== 'none' && after === 'none'
      ? ' any swoop session they are in here ends.'
      : before === 'control' && after !== 'control'
        ? ' any swoop session they control here ends; watching carries on.'
        : '';

  const save = async () => {
    if (!changed || saving) return;
    setSaving(true);
    const patch: UpdateSiteMemberInput = {};
    if (roleChanged) patch.role = role;
    if (swoopChanged) patch.swoop = fromSwoopChoice(swoop);
    try {
      // the toast reads the row as written, not this dialog's seed: a field not sent keeps the row's own value
      const updated = await updateMember(member.uid, patch);
      const effective = effectiveSwoopMode(updated.role, updated.swoop, membersMayWatch);
      toast.success('access updated', {
        description: `${label} is now ${updated.role === 'admin' ? 'an admin' : 'a member'} on this site. swoop: ${SWOOP_MODE_LABELS[effective]}${updated.swoop === null ? ' (by role)' : ''}.`,
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-accent-cyan" />
            change access
          </DialogTitle>
          {/* an email can be one unbroken word wider than a phone */}
          <DialogDescription className="wrap-anywhere">
            {`choose ${label}'s role and swoop on this site.`}
          </DialogDescription>
        </DialogHeader>
        <MemberAccessFields
          idPrefix="change-access"
          role={role}
          swoop={swoop}
          onRoleChange={setRole}
          onSwoopChange={setSwoop}
          membersMayWatch={membersMayWatch}
          disabled={saving}
        />
        <p className="text-xs text-muted-foreground">{`this changes their access to this site only.${ends}`}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            cancel
          </Button>
          <Button onClick={() => void save()} disabled={!changed || saving}>
            {saving ? 'saving…' : 'save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
